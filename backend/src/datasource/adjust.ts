import type { KlineBar, KlinePeriod } from '@stock-agent/shared';

// 分钟 K 线前复权修正：腾讯/新浪的分钟接口（mkline/getKLineData）返回「不复权」价，
// 除权/分红/份额折算当日会出现假跳空 → 算出假死叉，并扰动随后约 26~35 根 K 的 EMA。
// 日线侧已是前复权（东财 fqt=1 或腾讯 fqkline qfq），故以日线复权收盘为锚反推每日复权因子套到分钟线。
// 已复权的分钟源（东财 fqt=1）factor≈1，幂等安全；故对所有分钟级一律修正，无需关心命中源。

const MINUTE_PERIODS: ReadonlySet<KlinePeriod> = new Set(['5m', '15m', '30m', '60m', '120m']);

export function isMinutePeriod(period: KlinePeriod): boolean {
  return MINUTE_PERIODS.has(period);
}

/** 取交易日（"YYYY-MM-DD HH:MM" → "YYYY-MM-DD"；日线本就 10 位） */
function dateOf(time: string): string {
  return time.slice(0, 10);
}

/**
 * 以日线前复权收盘为锚，对分钟 K 线做前复权。
 * 同一交易日 factor = 日线复权收盘 / 分钟当日最后一根（收盘）；
 * 日线缺失某交易日则沿用上一个因子（升序前向填充）。空输入/无锚点时原样返回（best-effort）。
 */
export function frontAdjustMinute(minute: KlineBar[], daily: KlineBar[]): KlineBar[] {
  if (minute.length === 0 || daily.length === 0) return minute;

  const adjClose = new Map<string, number>();
  for (const b of daily) adjClose.set(dateOf(b.time), b.close);

  // 分钟当日最后一根收盘（输入升序，后值覆盖即当日最后）
  const rawLast = new Map<string, number>();
  for (const b of minute) rawLast.set(dateOf(b.time), b.close);

  const dates = [...new Set(minute.map((b) => dateOf(b.time)))].sort();
  const factor = new Map<string, number>();
  let lastF = 1;
  for (const d of dates) {
    const ad = adjClose.get(d);
    const rl = rawLast.get(d);
    // 必须 ad>0：日线锚某日收盘为 0（部分源当日未定格的脏数据）会算出 factor=0，
    // 进而把当日所有分钟 bar 价格清零、污染 MACD。遇到非正收盘则沿用上一因子。
    if (ad != null && ad > 0 && rl != null && rl > 0) lastF = ad / rl;
    factor.set(d, lastF);
  }

  return minute.map((b) => {
    const f = factor.get(dateOf(b.time)) ?? 1;
    if (f === 1) return b;
    return {
      ...b,
      open: b.open * f,
      close: b.close * f,
      high: b.high * f,
      low: b.low * f,
    };
  });
}
