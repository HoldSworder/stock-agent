import { getJson } from '../market/eastmoney';
import { num, numOrNull } from '../datasource/codes';
import { getMeta, setMeta } from '../settings';

// 选股引擎唯一净新增取数：东方财富 clist/get 分页拉全市场沪深 A 股快照。
// 复用 market/eastmoney 的 getJson（重试 + 缓存 + push2delay 兜底 + 调用统计归 eastmoney）。
// 字段在现有量价基础上扩展估值（f9 PE / f23 PB）与规模（f20 总市值）+ 所属行业（f100）。

const PUSH2 = 'https://push2.eastmoney.com/api/qt';
// 沪深京 A 股 fs 过滤（与 market/eastmoney 的 STOCK_FS 一致；硬筛层再剔北交所/科创/ST）
const STOCK_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
// f12 代码 / f14 名称 / f2 现价 / f3 涨跌幅% / f6 成交额(元) / f8 换手率% / f9 市盈率(动) /
// f10 量比 / f20 总市值(元) / f23 市净率 / f100 所属行业
const FIELDS = 'f2,f3,f6,f8,f9,f10,f12,f14,f20,f23,f100';
// 东财 clist 单页实际上限为 100（请求 pz>100 仍只返回 100），故页大小取 100，
// 否则「rows.length < PAGE_SIZE」末页判定会在首页即误触发，导致只扫到前 100 只（按涨幅排序的涨幅榜）。
const PAGE_SIZE = 100;
// 全市场约 5000+ 只，留足页数上限防异常死循环（100*80=8000）
const MAX_PAGES = 80;

/** 单只个股的横截面快照（选股打分输入） */
export interface SnapshotRow {
  code: string;
  name: string;
  /** 现价 */
  price: number;
  /** 涨跌幅 % */
  pct: number;
  /** 成交额（亿元） */
  amount: number;
  /** 换手率 %（缺失为 null） */
  turnoverRate: number | null;
  /** 量比（缺失为 null） */
  volumeRatio: number | null;
  /** 市盈率（动态，亏损为负；缺失为 null） */
  pe: number | null;
  /** 市净率（缺失为 null） */
  pb: number | null;
  /** 总市值（亿元；缺失为 null） */
  marketCap: number | null;
  /** 所属行业（缺失为空串） */
  industry: string;
}

/** clist 的 data.diff 兼容对象/数组，统一成数组 */
function toRows(json: Record<string, unknown>): Array<Record<string, unknown>> {
  const data = json.data as { diff?: unknown } | null;
  if (!data || data.diff == null) return [];
  const diff = data.diff;
  if (Array.isArray(diff)) return diff as Array<Record<string, unknown>>;
  return Object.values(diff as Record<string, Record<string, unknown>>);
}

function mapRow(r: Record<string, unknown>): SnapshotRow | null {
  const code = String(r.f12 ?? '');
  if (!/^\d{6}$/.test(code)) return null;
  const price = num(r.f2);
  // 停牌/无报价（f2='-'→0）剔除：无现价无法打分与复盘
  if (price <= 0) return null;
  const industry = typeof r.f100 === 'string' ? r.f100.trim() : '';
  return {
    code,
    name: String(r.f14 ?? ''),
    price,
    pct: num(r.f3),
    amount: num(r.f6) / 1e8,
    turnoverRate: numOrNull(r.f8),
    volumeRatio: numOrNull(r.f10),
    pe: numOrNull(r.f9),
    pb: numOrNull(r.f23),
    marketCap: (() => {
      const v = numOrNull(r.f20);
      return v != null ? v / 1e8 : null;
    })(),
    industry: industry && industry !== '-' ? industry : '',
  };
}

/**
 * 拉取全市场沪深 A 股快照（分页直到取完或达上限）。
 * 单页失败即终止分页并返回已取部分（best-effort，不让单页 5xx 拖垮整次选股）。
 */
export async function fetchMarketSnapshot(signal?: AbortSignal): Promise<SnapshotRow[]> {
  const out: SnapshotRow[] = [];
  const seen = new Set<string>();
  for (let pn = 1; pn <= MAX_PAGES; pn += 1) {
    if (signal?.aborted) break;
    const url =
      `${PUSH2}/clist/get?pn=${pn}&pz=${PAGE_SIZE}&po=1&np=1&fltt=2&invt=2` +
      `&fid=f3&fs=${STOCK_FS}&fields=${FIELDS}`;
    let rows: Array<Record<string, unknown>>;
    try {
      rows = toRows(await getJson(url, { label: '东财全市场快照' }));
    } catch {
      // 单页失败：已取部分够用则返回，否则抛由调用方降级
      if (out.length > 0) break;
      throw new Error('全市场快照拉取失败（首页即失败）');
    }
    if (rows.length === 0) break;
    for (const r of rows) {
      const row = mapRow(r);
      if (row && !seen.has(row.code)) {
        seen.add(row.code);
        out.push(row);
      }
    }
    if (rows.length < PAGE_SIZE) break; // 末页
  }
  return out;
}

// ===== 盘前退化检测 + 收盘快照缓存 =====
// 盘前（新交易日开盘前）东财 clist 把成交额(f6)/换手(f8)/涨跌幅(f3) 置 0/'-'，价=昨收仍 >0。
// 此时按当日量价硬筛会剔空全市场，故检测退化后改用「最近一次有效行情」缓存（通常即上一交易日收盘）。

/** 收盘快照缓存的本地 kv 键（仅本模块读写，不在 SettingKey 枚举内） */
const META_LAST_CLOSE_SNAPSHOT = 'screener_last_close_snapshot';
/** 量价退化判定阈值：amount===0 行占比超过此值视为盘前退化 */
const DEGENERATE_AMOUNT_ZERO_RATIO = 0.9;

/** 缓存载体：capturedAt 标记抓取时刻，rows 为当次有效全市场快照 */
interface CachedSnapshot {
  capturedAt: string;
  rows: SnapshotRow[];
}

/**
 * 快照是否盘前退化：非空且 amount===0 的行占比超阈值。
 * 真实交易/收盘后几乎无 amount=0 个股，仅「新交易日开盘前」窗口会整体退化。
 */
export function isDegenerateSnapshot(rows: SnapshotRow[]): boolean {
  if (rows.length === 0) return false;
  const zero = rows.reduce((n, r) => (r.amount === 0 ? n + 1 : n), 0);
  return zero / rows.length > DEGENERATE_AMOUNT_ZERO_RATIO;
}

/**
 * 写入收盘快照缓存（仅应在快照非退化时调用，即一次有效行情，
 * 语义为「最近一次有效行情」，盘前作为上一交易日量价基准）。
 * best-effort：序列化/落库失败不抛错，不阻断选股主流程。
 */
export function saveLastCloseSnapshot(rows: SnapshotRow[]): void {
  if (rows.length === 0) return;
  try {
    const payload: CachedSnapshot = { capturedAt: new Date().toISOString(), rows };
    setMeta(META_LAST_CLOSE_SNAPSHOT, JSON.stringify(payload));
  } catch {
    /* 缓存写入失败：忽略，下次再写 */
  }
}

/** 读取收盘快照缓存；无缓存/解析失败返回 null */
export function loadLastCloseSnapshot(): SnapshotRow[] | null {
  const raw = getMeta(META_LAST_CLOSE_SNAPSHOT);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedSnapshot;
    const rows = parsed?.rows;
    return Array.isArray(rows) && rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}
