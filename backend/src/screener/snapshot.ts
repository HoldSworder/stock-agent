import { getJson } from '../market/eastmoney';
import { num, numOrNull } from '../datasource/codes';

// 选股引擎唯一净新增取数：东方财富 clist/get 分页拉全市场沪深 A 股快照。
// 复用 market/eastmoney 的 getJson（重试 + 缓存 + push2delay 兜底 + 调用统计归 eastmoney）。
// 字段在现有量价基础上扩展估值（f9 PE / f23 PB）与规模（f20 总市值）+ 所属行业（f100）。

const PUSH2 = 'https://push2.eastmoney.com/api/qt';
// 沪深京 A 股 fs 过滤（与 market/eastmoney 的 STOCK_FS 一致；硬筛层再剔北交所/科创/ST）
const STOCK_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
// f12 代码 / f14 名称 / f2 现价 / f3 涨跌幅% / f6 成交额(元) / f8 换手率% / f9 市盈率(动) /
// f10 量比 / f20 总市值(元) / f23 市净率 / f100 所属行业
const FIELDS = 'f2,f3,f6,f8,f9,f10,f12,f14,f20,f23,f100';
const PAGE_SIZE = 200;
// 全市场约 5000+ 只，留足页数上限防异常死循环（200*40=8000）
const MAX_PAGES = 40;

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
