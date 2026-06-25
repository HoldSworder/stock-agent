import type { KlineBar, KlinePeriod, StockQuote } from '@stock-agent/shared';
import { callAstock } from './client';

// a-stock-data sidecar 的行情适配：把 mootdx 返回映射为系统统一的 KlineBar / StockQuote，
// 接入 datasource/providers 的 K线/报价多源调度。mootdx 走通达信 TCP（不封 IP），作 K线首选源。
// 注：provider 路径用短超时 + 单次尝试，sidecar 不可用时快速失败转下一源，不拖慢整体调度。

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
  const rows = (await callAstock(
    'mootdx_kline',
    { symbol: code, category, offset: Math.min(Math.max(limit, 1), 800) },
    undefined,
    'astockdata',
    12_000,
    1,
  )) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('a-stock-data(mootdx) K线为空');
  const bars = rows.map((r) => {
    const dt = String(r.datetime ?? r.date ?? '').trim();
    return {
      time: intraday ? dt.slice(0, 16) : dt.slice(0, 10),
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      close: num(r.close),
      volume: num(r.vol ?? r.volume),
      amount: num(r.amount),
    };
  });
  return bars.sort((a, b) => a.time.localeCompare(b.time)).slice(-limit);
}

/**
 * mootdx 实时报价 → StockQuote[]（末位兜底源：无名称/换手，仅价/涨跌，东财等全失败时用）。
 * mootdx quotes 无个股名称，name 回退为代码；pct 由 price/last_close 现算。
 */
export async function getQuotesAstock(codes: string[]): Promise<StockQuote[]> {
  if (!codes.length) return [];
  const rows = (await callAstock(
    'mootdx_quote',
    { symbols: codes },
    undefined,
    'astockdata',
    12_000,
    1,
  )) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('a-stock-data(mootdx) 报价为空');
  return rows.map((r) => {
    const code = String(r.code ?? r.symbol ?? '').padStart(6, '0');
    const price = num(r.price);
    const prevClose = num(r.last_close ?? r.last_close_price);
    const pct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
    return {
      code,
      name: code,
      price,
      pct,
      prevClose,
      amount: num(r.amount) / 1e8,
    } satisfies StockQuote;
  });
}
