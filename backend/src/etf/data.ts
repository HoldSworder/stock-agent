import type { EtfListItem, EtfMarketStat, EtfThemeCategory, KlineBar } from '@stock-agent/shared';
import { getJson, getKline } from '../market/eastmoney';
import { numOrNull as num, toSecid, PUSH2_QT as PUSH2 } from '../datasource/codes';
import { isSourceEnabled } from '../datasource/registry';
import { getEtfPremiumJisilu } from '../market/jisilu';

// ETF 确定性指标层：复用东方财富公开行情（getJson / getKline，已带缓存/重试/多源回退）。
// 仅做只读取数与本地数值计算，不引入额外数据源，输出供 service 综合成买卖建议。

export interface EtfQuoteRaw {
  code: string;
  name: string;
  /** 现价 */
  price: number | null;
  /** 昨收 */
  prevClose: number | null;
  /** 当日涨跌幅 % */
  pct: number | null;
  /** IOPV 参考净值（取不到或字段异常为 null） */
  iopv: number | null;
  /** 折溢价率 %（正=溢价）。优先取集思录权威 discount_rt，缺失则为 null 交上层用 IOPV 兜底计算 */
  premiumPct: number | null;
}

/**
 * ETF 实时行情 + IOPV。
 * stock/get：f43 现价 / f58 名称 / f60 昨收 / f170 涨跌幅 / f400·f402 候选 IOPV 字段。
 * 东财 ETF IOPV 字段在不同接口并不稳定，取到后做合理性校验（与现价偏离<20% 才采信），
 * 否则置 null，由上层标注「折溢价数据缺失」并交 LLM 用 mx_finance_data 补。
 */
export async function fetchEtfQuote(code: string): Promise<EtfQuoteRaw> {
  const url = `${PUSH2}/stock/get?fltt=2&fields=f43,f58,f60,f170,f400,f402&secid=${toSecid(code)}`;
  const json = await getJson(url, { label: 'ETF行情' });
  const d = (json.data ?? {}) as Record<string, unknown>;
  const price = num(d.f43);
  let iopv = num(d.f400) ?? num(d.f402);
  if (iopv != null && price != null && price > 0) {
    if (Math.abs(iopv - price) / price > 0.2) iopv = null; // 偏离过大视为非 IOPV 字段，丢弃
  } else {
    iopv = null;
  }
  // 集思录已启用 → best-effort 补充：优先采用其权威折溢价率 discount_rt，并补全东财缺失的 IOPV（失败静默回退 null）
  let premiumPct: number | null = null;
  if (isSourceEnabled('jisilu')) {
    const p = await getEtfPremiumJisilu(code);
    if (p?.premiumRate != null) premiumPct = p.premiumRate;
    if (iopv == null && p?.iopv != null) iopv = p.iopv;
  }
  return {
    code,
    name: String(d.f58 ?? ''),
    price,
    prevClose: num(d.f60),
    pct: num(d.f170),
    iopv,
    premiumPct,
  };
}

export interface EtfMetrics {
  /** 用于计算的基准价（优先实时现价，回退最新收盘） */
  price: number | null;
  ma20: number | null;
  ma60: number | null;
  ma250: number | null;
  /** 年线（MA250）偏离度 % */
  maDeviation: number | null;
  /** 现价在窗口收盘区间的百分位 0-100 */
  pricePercentile: number | null;
  /** 20 日收益 % */
  ret20: number | null;
  /** 60 日收益 % */
  ret60: number | null;
  /** 120 日收益 %（中线轮动用） */
  ret120: number | null;
  /** 动量打分（0.4*ret20 + 0.6*ret60） */
  momentum: number | null;
  /** 绝对动量为正（ret60>0） */
  absMomentumPositive: boolean;
  /** 近 60 日年化波动率 % */
  volatility: number | null;
  /** 近一年最低（区间下沿） */
  yearLow: number | null;
  /** 近一年最高（区间上沿） */
  yearHigh: number | null;
  /** 有效日 K 数 */
  barCount: number;
}

const YEAR_DAYS = 244;
/** 估值位置代理窗口：约 2 年 */
const PERCENTILE_WINDOW = YEAR_DAYS * 2;

function mean(arr: number[]): number {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

/** 最近 k 个收盘均值（不足返回 null） */
function maOf(closes: number[], k: number): number | null {
  const n = closes.length;
  if (n < k) return null;
  return mean(closes.slice(n - k));
}

/**
 * 基于日 K（前复权）计算确定性指标：均线/年线偏离、价格分位、动量、波动率、年内区间。
 * 取数失败或数据不足时按 null 优雅降级，不抛错。
 */
export async function computeMetrics(
  code: string,
  currentPrice: number | null,
): Promise<EtfMetrics> {
  let bars: KlineBar[] = [];
  try {
    bars = await getKline(code, 'day', 500);
  } catch {
    bars = [];
  }
  const closes = bars.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0);
  const n = closes.length;
  const price = currentPrice ?? (n > 0 ? closes[n - 1] : null);

  const ma20 = maOf(closes, 20);
  const ma60 = maOf(closes, 60);
  const ma250 = maOf(closes, 250);
  const maDeviation =
    price != null && ma250 != null && ma250 > 0 ? ((price - ma250) / ma250) * 100 : null;

  // 价格分位（近 2 年收盘区间）
  let pricePercentile: number | null = null;
  if (price != null && n >= 20) {
    const win = closes.slice(Math.max(0, n - PERCENTILE_WINDOW));
    const lo = Math.min(...win);
    const hi = Math.max(...win);
    if (hi > lo) pricePercentile = ((price - lo) / (hi - lo)) * 100;
  }

  // 动量：20/60 日收益
  const refAgo = (k: number): number | null =>
    price != null && n > k && closes[n - 1 - k] > 0 ? (price / closes[n - 1 - k] - 1) * 100 : null;
  const ret20 = refAgo(20);
  const ret60 = refAgo(60);
  const ret120 = refAgo(120);
  const momentum =
    ret20 != null && ret60 != null ? 0.4 * ret20 + 0.6 * ret60 : (ret60 ?? ret20);
  const absMomentumPositive = ret60 != null ? ret60 > 0 : false;

  // 年化波动率（近 60 日对数收益标准差 × sqrt(244)）
  let volatility: number | null = null;
  if (n >= 30) {
    const seg = closes.slice(Math.max(1, n - 60));
    const prev = closes.slice(Math.max(0, n - 60 - 1), n - 1);
    const rets: number[] = [];
    for (let i = 0; i < seg.length && i < prev.length; i++) {
      if (prev[i] > 0) rets.push(Math.log(seg[i] / prev[i]));
    }
    if (rets.length >= 10) {
      const m = mean(rets);
      const variance = mean(rets.map((r) => (r - m) ** 2));
      volatility = Math.sqrt(variance) * Math.sqrt(YEAR_DAYS) * 100;
    }
  }

  // 年内区间（用 high/low，近一年）
  let yearLow: number | null = null;
  let yearHigh: number | null = null;
  if (bars.length > 0) {
    const yb = bars.slice(Math.max(0, bars.length - YEAR_DAYS));
    const lows = yb.map((b) => b.low).filter((x) => Number.isFinite(x) && x > 0);
    const highs = yb.map((b) => b.high).filter((x) => Number.isFinite(x) && x > 0);
    if (lows.length) yearLow = Math.min(...lows);
    if (highs.length) yearHigh = Math.max(...highs);
  }

  return {
    price,
    ma20,
    ma60,
    ma250,
    maDeviation,
    pricePercentile,
    ret20,
    ret60,
    ret120,
    momentum,
    absMomentumPositive,
    volatility,
    yearLow,
    yearHigh,
    barCount: n,
  };
}

// ===== ETF 市场总览取数（复用东财 clist，fs=b:MK0021 全市场 ETF） =====

/** 沪深全市场 ETF 板块过滤 */
const ETF_FS = 'b:MK0021';

/** clist data.diff 兼容对象/数组，统一成数组 */
function toRows(json: Record<string, unknown>): Array<Record<string, unknown>> {
  const data = json.data as { diff?: unknown } | null;
  if (!data || data.diff == null) return [];
  const diff = data.diff;
  if (Array.isArray(diff)) return diff as Array<Record<string, unknown>>;
  return Object.values(diff as Record<string, Record<string, unknown>>);
}

/** num 但缺失归 0（榜单数值列用） */
function n0(v: unknown): number {
  return num(v) ?? 0;
}

/** clist/ulist 行 → EtfListItem（f2 现价 / f3 涨跌幅 / f6 成交额元 / f8 换手 / f12 码 / f14 名 / f21 规模元 / f62 主力净流入元） */
function toListItem(r: Record<string, unknown>, withFlow = false): EtfListItem {
  const code = String(r.f12 ?? '');
  const turnover = num(r.f8);
  const aumYuan = num(r.f21);
  const item: EtfListItem = {
    code,
    name: String(r.f14 ?? ''),
    price: n0(r.f2),
    pct: n0(r.f3),
    amount: n0(r.f6) / 1e8,
    secid: toSecid(code),
  };
  if (turnover != null && turnover > 0) item.turnoverRate = turnover;
  if (aumYuan != null && aumYuan > 0) item.aum = aumYuan / 1e8;
  if (withFlow) item.netInflow = n0(r.f62) / 1e8;
  return item;
}

export type EtfRankBy = 'gainers' | 'losers' | 'turnover' | 'aum' | 'inflow' | 'outflow';

/** ETF 榜单：涨幅(f3)/跌幅(f3)/成交额(f6)/规模(f21)/资金净流入·净流出(f62) */
export async function fetchEtfRank(by: EtfRankBy, n = 12): Promise<EtfListItem[]> {
  const fid = by === 'turnover' ? 'f6' : by === 'aum' ? 'f21' : by === 'inflow' || by === 'outflow' ? 'f62' : 'f3';
  const po = by === 'losers' || by === 'outflow' ? 0 : 1;
  const url = `${PUSH2}/clist/get?pn=1&pz=${n}&po=${po}&fid=${fid}&fltt=2&fs=${ETF_FS}&fields=f2,f3,f6,f8,f12,f14,f21,f62`;
  const json = await getJson(url, { label: 'ETF榜单' });
  const withFlow = by === 'inflow' || by === 'outflow';
  return toRows(json)
    .map((r) => toListItem(r, withFlow))
    .filter((it) => it.code);
}

/** clist 单页（push2 每页 diff 上限 100，无视更大的 pz），返回 {rows, total} */
async function fetchClistPage(
  pn: number,
  fields: string,
  fid = 'f3',
  po = 1,
): Promise<{ rows: Array<Record<string, unknown>>; total: number }> {
  const url = `${PUSH2}/clist/get?pn=${pn}&pz=100&po=${po}&fid=${fid}&fltt=2&fs=${ETF_FS}&fields=${fields}`;
  const json = await getJson(url, { label: 'ETF概览' });
  const total = num((json.data as { total?: unknown } | null)?.total) ?? 0;
  return { rows: toRows(json), total };
}

/** 全市场 ETF 概览统计：分页拉全量（每页 100，约 13 页）聚合涨跌家数/平均涨幅/总成交额 */
export async function fetchEtfMarketStat(): Promise<EtfMarketStat> {
  const FIELDS = 'f3,f6';
  const first = await fetchClistPage(1, FIELDS);
  const rows = [...first.rows];
  // push2 diff 每页固定 100，需翻页取全量；上限 20 页兜底防跑飞
  const pages = Math.min(Math.ceil(first.total / 100), 20);
  for (let pn = 2; pn <= pages; pn += 1) {
    const next = await fetchClistPage(pn, FIELDS);
    if (!next.rows.length) break;
    rows.push(...next.rows);
  }
  let up = 0;
  let down = 0;
  let flat = 0;
  let sumPct = 0;
  let totalAmount = 0;
  let counted = 0;
  for (const r of rows) {
    const pct = num(r.f3);
    if (pct == null) continue; // 停牌/无报价不计入涨跌统计
    counted += 1;
    sumPct += pct;
    if (pct > 0) up += 1;
    else if (pct < 0) down += 1;
    else flat += 1;
    totalAmount += n0(r.f6) / 1e8;
  }
  return {
    total: first.total || rows.length,
    up,
    down,
    flat,
    avgPct: counted > 0 ? sumPct / counted : 0,
    totalAmount,
  };
}

/** 批量取若干 ETF 实时报价（ulist.np，保留入参顺序） */
async function fetchEtfQuotes(codes: string[]): Promise<EtfListItem[]> {
  const valid = codes.filter((c) => /^\d{6}$/.test(c));
  if (!valid.length) return [];
  const secids = valid.map(toSecid).join(',');
  const url = `${PUSH2}/ulist.np/get?fltt=2&fields=f2,f3,f6,f8,f12,f14,f21&secids=${secids}`;
  const json = await getJson(url, { label: 'ETF行情' });
  const byCode = new Map(toRows(json).map((r) => [String(r.f12 ?? ''), r]));
  return valid
    .map((c) => byCode.get(c))
    .filter((r): r is Record<string, unknown> => r != null)
    .map((r) => toListItem(r));
}

/** 主流/宽基代表 ETF（行情条，点开 K 线）。顺序即展示顺序。 */
const BROAD_ETFS = [
  '510300', // 沪深300ETF
  '510500', // 中证500ETF
  '159915', // 创业板ETF
  '588000', // 科创50ETF
  '563360', // 中证A500ETF
  '510050', // 上证50ETF
  '159740', // 恒生科技ETF
  '518880', // 黄金ETF
];

export async function fetchBroadStrip(): Promise<EtfListItem[]> {
  return fetchEtfQuotes(BROAD_ETFS);
}

/** 主题赛道 → 代表 ETF 白名单（代码内常量，后续可加可改） */
const THEME_DEFS: ReadonlyArray<{ name: string; codes: string[] }> = [
  { name: '科技/半导体', codes: ['512760', '588200', '515880'] },
  { name: '新能源', codes: ['561910', '515030', '516160'] },
  { name: '医药', codes: ['512010', '159992'] },
  { name: '消费', codes: ['159928', '512690'] },
  { name: '红利', codes: ['510880', '515080'] },
  { name: '港股科技/互联', codes: ['159740', '513050'] },
  { name: '金融', codes: ['512880', '512800'] },
  { name: '军工', codes: ['512660'] },
  { name: '黄金/商品', codes: ['518880', '159980'] },
  { name: '债券', codes: ['511260', '511010'] },
];

/** 主题赛道分类涨幅：一次批量取所有代表 ETF，再按主题分组算平均涨幅 + 领涨代表 */
export async function fetchThemeCategories(): Promise<EtfThemeCategory[]> {
  const allCodes = Array.from(new Set(THEME_DEFS.flatMap((t) => t.codes)));
  const quotes = await fetchEtfQuotes(allCodes);
  const byCode = new Map(quotes.map((q) => [q.code, q]));
  return THEME_DEFS.map((t) => {
    const members = t.codes
      .map((c) => byCode.get(c))
      .filter((m): m is EtfListItem => m != null);
    const avgPct = members.length
      ? members.reduce((s, m) => s + m.pct, 0) / members.length
      : 0;
    const lead = members.length
      ? members.reduce((a, b) => (b.pct > a.pct ? b : a))
      : null;
    return {
      name: t.name,
      avgPct,
      lead: lead ? { code: lead.code, name: lead.name, pct: lead.pct } : null,
      members,
    };
  });
}
