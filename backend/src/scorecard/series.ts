import { sqlite } from '../db/client';

// 判分要用的收盘价序列。从本地日线表读，不联网——判分是反复跑的事，
// 每次联网既慢又会因为源不同导致同一批信号跑出不同分数。

/** 某标的的日线。成交从信号日的下一交易日开盘起。 */
export interface Series {
  dates: string[];
  opens: number[];
  closes: number[];
  idx: Map<string, number>;
}

/**
 * 顺延上限（自然日）。停牌或尚未上市时只允许往后挪这么久。
 *
 * 没有上限会出实质错误：池里晚上市的标的，在它上市之前的每一天都会被顺延到
 * 首个交易日，于是同一段收益被重复计进每一天的池均值，用的还是当时不存在的行情。
 */
export const MAX_ROLL_FORWARD_DAYS = 7;

/** 两个 YYYY-MM-DD 之间相差几个自然日 */
export function rollForwardDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.round((b - a) / 86400_000);
}

/**
 * 收盘确认的信号，成交从下一交易日开盘起，再持有 n 个交易日，看到那天的收盘。
 * 信号当天的涨跌不计入。开盘取不到、或持有窗口不够，返回 null。
 */
export function forwardReturnOn(s: Series | undefined, date: string, n: number): number | null {
  if (!s || !(n > 0)) return null;
  let i = s.idx.get(date);
  if (i == null) {
    i = s.dates.findIndex((d) => d >= date);
    if (i < 0) return null;
    if (rollForwardDays(date, s.dates[i]) > MAX_ROLL_FORWARD_DAYS) return null;
  }
  const entry = i + 1;
  const exit = i + n;
  if (entry >= s.opens.length || exit >= s.closes.length) return null;
  const a = s.opens[entry];
  const b = s.closes[exit];
  if (!(a > 0) || !(b > 0)) return null;
  return b / a - 1;
}

/**
 * 读指定标的的日线收盘序列。
 *
 * 主键是 (code, secid, trade_date)，同一 code 同一天可能有两个 secid（指数与场内基金撞码）。
 * 裸 group by 会让 SQLite 任选一行、收盘价不确定；min(secid) 让它明确取那一行，结果可复现。
 * provisional=1 是盘中用实时报价合成的临时 bar，收盘后会被真实日线覆盖，判分一律不取。
 */
export function loadSeries(codes: readonly string[]): Map<string, Series> {
  const out = new Map<string, Series>();
  if (codes.length === 0) return out;
  const holes = codes.map(() => '?').join(',');
  const rows = sqlite
    .prepare(
      `select code, trade_date, min(secid) as secid, open, close from kline_daily
       where provisional = 0 and code in (${holes})
       group by code, trade_date order by code, trade_date`,
    )
    .all(...codes) as Array<{ code: string; trade_date: string; open: number; close: number }>;
  for (const r of rows) {
    let s = out.get(r.code);
    if (!s) {
      s = { dates: [], opens: [], closes: [], idx: new Map() };
      out.set(r.code, s);
    }
    s.idx.set(r.trade_date, s.dates.length);
    s.dates.push(r.trade_date);
    s.opens.push(r.open);
    s.closes.push(r.close);
  }
  return out;
}
