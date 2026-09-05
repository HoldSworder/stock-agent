import {
  SHARES_PER_LOT,
  type KlineBar,
  type KlinePeriod,
  type OrderBookLevel,
  type StockQuote,
} from '@stock-agent/shared';
import { callAstock } from './client';
import { mapLimit } from '../datasource/klineCache';

// a-stock-data sidecar 的行情适配：把 mootdx 返回映射为系统统一的 KlineBar / StockQuote，
// 接入 datasource/providers 的 K线/报价多源调度。mootdx 走通达信 TCP（不封 IP），作 K线首选源。
// 注：provider 路径单次尝试不重试；超时按周期分档（日线短、分钟线宽，见 getKlineAstock 内注释），
// sidecar 不可用时日线快速失败转下一源，不拖慢整体调度。

// KlinePeriod → mootdx 频率码（即 Quotes.bars 的 frequency）。
// 实测 mootdx 频率码：0=5分 1=15分 2=30分 3=60分 4=日 5=周 6=月 7/8=1分 9=日 10=季 11=年。
// （上游 SKILL.md 注释写的 7/8/9/10/11=1/5/15/30/60 分是错的，会全返回日线。）
const CATEGORY: Partial<Record<KlinePeriod, number>> = {
  day: 4,
  week: 5,
  month: 6,
  '5m': 0,
  '15m': 1,
  '30m': 2,
  '60m': 3,
};

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * mootdx 的 vol 单位自校准，返回把它换算成「手」需要除的系数（1 或 100）。
 *
 * 不能写死系数：sidecar 背后轮换多个通达信节点，实测同一只标的同一天内
 * 相隔几分钟的两次请求，一次给「手」、一次给「股」（2026-08-04 用 159516 复现）。
 * 好在每根都带 amount，故用「amount ÷ 均价 ÷ vol」的中位数反推：≈1 是股、≈100 是手。
 *
 * 只用已结算的历史行判定：当日未收盘那根的口径与结算后不一致，拿它判会翻。
 * 判不出来（无 amount / 样本不足 / 比值落在两档之间）时按「手」处理并不做换算——
 * 与东财 f56、腾讯口径一致，是本项目的默认约定。但这是**猜**：若本源那次实际给的是「股」，
 * 100 倍错误量会静默写进缓存，且缓存格式版本号机制察觉不到。故传 label 时会打 warn 留痕。
 *
 * @param label 调用点标识（如 "mootdx day 600519"）；传了则在判不出单位时 console.warn
 */
export function volumeUnitDivisor(bars: KlineBar[], label?: string): number {
  const ratios: number[] = [];
  for (const b of bars.slice(0, -1)) {
    const avg = (b.high + b.low + b.close) / 3;
    if (avg > 0 && b.volume > 0 && b.amount > 0) ratios.push(b.amount / avg / b.volume);
  }
  const undetermined = (reason: string): number => {
    if (label) {
      console.warn(`[volumeUnit] ${label}: ${reason}，按「手」放行未换算（若本源实为「股」将差 100 倍）`);
    }
    return 1;
  };
  if (ratios.length < 3) return undetermined(`可判定样本仅 ${ratios.length} 根（需 ≥3，本源可能不返回 amount）`);
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  // 两档之间留足间隔，落在中间地带宁可不换算，也不猜
  if (median > 0.3 && median < 3) return SHARES_PER_LOT; // vol 是股
  if (median > 30 && median < 300) return 1; // vol 已是手
  return undetermined(`反推比值中位数 ${median.toFixed(3)} 落在「股」「手」两档之外`);
}

/**
 * mootdx 响应行 → KlineBar[]（升序、截尾 limit、vol 按自校准结果归一为「手」）。
 *
 * K 线端点（mootdx_kline）与指数端点（mootdx_index）共用：两处各写一套映射正是上一次单位分叉的入口。
 * @param intraday 分钟线须保留 "yyyy-MM-dd HH:mm"（与东财一致），否则同日多根 bar 时间相同会被去重折叠
 * @param calibrate 是否做 vol 单位自校准，默认 true。指数序列须传 false：
 *   自校准靠「amount ÷ 均价 ÷ vol」反推，而指数的 close 是点位不是每股价格，这个比值没有物理含义，
 *   当前恰好落在「手」档只是巧合，点位涨到约 2 倍以上就会跌出区间并每次合成都打一条无意义的 warn
 */
export function mapMootdxBars(
  rows: Array<Record<string, unknown>>,
  opts: { intraday: boolean; limit: number; label?: string; calibrate?: boolean },
): KlineBar[] {
  const bars = rows.map((r) => {
    const dt = String(r.datetime ?? r.date ?? '').trim();
    return {
      time: opts.intraday ? dt.slice(0, 16) : dt.slice(0, 10),
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      close: num(r.close),
      volume: num(r.vol ?? r.volume),
      amount: num(r.amount),
    } satisfies KlineBar;
  });
  const sorted = bars.sort((a, b) => a.time.localeCompare(b.time)).slice(-opts.limit);
  if (opts.calibrate === false) return sorted;
  // 除数必须在 map 外算一次：它内含全序列 slice + sort，写进 map 回调会对每根 bar 重算一遍
  const divisor = volumeUnitDivisor(sorted, opts.label);
  return divisor === 1 ? sorted : sorted.map((b) => ({ ...b, volume: b.volume / divisor }));
}

/** mootdx K 线 → KlineBar[]（按时间升序）。不支持的周期（如 120m）抛错以跳过本源。 */
export async function getKlineAstock(
  code: string,
  period: KlinePeriod = 'day',
  limit = 250,
  _secid?: string,
): Promise<KlineBar[]> {
  const category = CATEGORY[period];
  if (category === undefined) throw new Error(`a-stock-data(mootdx) 不支持周期 ${period}`);
  // 日/周/月线 time 取日期；分钟线须保留 "yyyy-MM-dd HH:mm"（与东财一致），
  // 否则同日多根分钟 bar 时间相同会被去重/折叠，破坏 30 分钟 MACD 等多周期判定。
  const intraday = period === '5m' || period === '15m' || period === '30m' || period === '60m';
  // 超时按周期分档，不重试：
  //  - 日线：本源在日线链里排第三（前两位是腾讯/东财），sidecar 不可用时每只标的都要先撞它一次
  //    才落到新浪。预热并发 4、近 500 只标的，超时给到 12s 会把一次预热拖到二十多分钟，故 4s。
  //  - 分钟线：本源是分钟链的**首选源**，盯盘主路径（30 分钟 MACD 等）走的正是它，
  //    实测 sidecar 常在 4-8s 量级返回；砍到 4s 会频繁失败转腾讯，而腾讯分钟不复权、
  //    还要额外跑一次日线锚点取数。故留 12s。
  const rows = (await callAstock(
    'mootdx_kline',
    { symbol: code, category, offset: Math.min(Math.max(limit, 1), 800) },
    undefined,
    'astockdata',
    intraday ? 12_000 : 4_000,
    1,
  )) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('a-stock-data(mootdx) K线为空');
  return mapMootdxBars(rows, { intraday, limit, label: `mootdx ${period} ${code}` });
}

/**
 * mootdx 盘口一侧（买或卖）的档位数组。
 *
 * 字段形如 bid1..bid5 / bid_vol1..bid_vol5。遇到价为 0 的档就截断：停牌或冷门标的
 * 常常只有前一两档有真实挂单，把 0 价当成一档会让价差算成 100%。
 */
function mapOrderBookSide(row: Record<string, unknown>, side: 'bid' | 'ask'): OrderBookLevel[] {
  const out: OrderBookLevel[] = [];
  for (let i = 1; i <= 5; i += 1) {
    const price = num(row[`${side}${i}`]);
    if (!(price > 0)) break;
    out.push({ price, volume: num(row[`${side}_vol${i}`]) });
  }
  return out;
}

/**
 * 单次 mootdx 批量报价的最大标的数。
 *
 * 通达信协议一包最多 80 只，**超了不报错、直接只返回前 80 只**
 * （2026-09-05 用真实沪市代码实测：81 只请求回 80 行，90 只、100 只同样都是 80 行）。
 * 本源在报价链里排首位，而盯盘池、日K缓存盘中增量都是几十上百只一批，
 * 不分片就会静默漏掉后面的标的——漏掉的标的不产报价也不产信号，界面上看不出任何异常。
 */
const MOOTDX_QUOTE_BATCH = 80;

/** 取一批（≤80 只）的原始报价行 */
async function fetchQuoteRows(symbols: string[]): Promise<Array<Record<string, unknown>>> {
  const rows = (await callAstock(
    'mootdx_quote',
    { symbols },
    undefined,
    'astockdata',
    12_000,
    1,
  )) as Array<Record<string, unknown>>;
  return Array.isArray(rows) ? rows : [];
}

/**
 * mootdx 实时报价 → StockQuote[]。
 *
 * 这是唯一带**五档盘口与当日最高/最低**的报价源（mootdx_quote 共 46 字段），
 * 且走通达信 TCP 不封 IP，故在报价链里排首位。代价是不返回个股名称，
 * name 先回退为代码，由 scheduler 统一回填（见 datasource/scheduler.ts 的名称回填）。
 * pct 由 price/last_close 现算。
 *
 * 超过单包上限时分片并发取：各片之间互不依赖，串行会把盯盘一轮拖成 N 倍耗时。
 * 并发压到 3，避免几百只的池子一次性打爆 sidecar 背后的通达信节点。
 */
export async function getQuotesAstock(codes: string[]): Promise<StockQuote[]> {
  if (!codes.length) return [];
  const batches: string[][] = [];
  for (let i = 0; i < codes.length; i += MOOTDX_QUOTE_BATCH) {
    batches.push(codes.slice(i, i + MOOTDX_QUOTE_BATCH));
  }
  const collected: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  await mapLimit(batches, 3, async (batch) => {
    try {
      collected.push(...(await fetchQuoteRows(batch)));
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  });
  // 全军覆没才算本源失败转下一源；部分分片失败时先把拿到的给出去，
  // 但要留痕——静默的少数据比整源失败更难查
  if (collected.length === 0) {
    throw new Error(`a-stock-data(mootdx) 报价为空${failures.length ? `：${failures[0]}` : ''}`);
  }
  if (failures.length > 0) {
    console.warn(
      `[astock] 报价分片 ${failures.length}/${batches.length} 失败，本轮结果不完整：${failures[0]}`,
    );
  }
  // mootdx 会对同一代码返回重复行（2026-09-05 实测：请求 60 只回 60 行、只有 58 个唯一代码）。
  // 不去重的话盯盘循环会把同一只标的评估两遍，可能重复推同一条信号。
  // 保留有报价的那一行：重复行里常有一条是价格全 0 的占位。
  const byCode = new Map<string, Record<string, unknown>>();
  for (const r of collected) {
    const key = String(r.code ?? r.symbol ?? '').padStart(6, '0');
    const kept = byCode.get(key);
    if (!kept || (!(num(kept.price) > 0) && num(r.price) > 0)) byCode.set(key, r);
  }
  return [...byCode.values()].map((r) => {
    const code = String(r.code ?? r.symbol ?? '').padStart(6, '0');
    const price = num(r.price);
    const prevClose = num(r.last_close ?? r.last_close_price);
    const pct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
    const open = num(r.open);
    const high = num(r.high);
    const low = num(r.low);
    const bids = mapOrderBookSide(r, 'bid');
    const asks = mapOrderBookSide(r, 'ask');
    // 可选字段一律「有值才带」：给个 0 会被下游当成真实的开盘价/最高价用
    return {
      code,
      name: code,
      price,
      pct,
      prevClose,
      amount: num(r.amount) / 1e8,
      ...(open > 0 ? { open } : {}),
      ...(high > 0 ? { high } : {}),
      ...(low > 0 ? { low } : {}),
      ...(bids.length > 0 && asks.length > 0 ? { orderBook: { bids, asks } } : {}),
    } satisfies StockQuote;
  });
}
