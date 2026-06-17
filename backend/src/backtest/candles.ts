import type { Candle } from 'tradelab';
import type { KlinePeriod } from '@stock-agent/shared';
import { getKline } from '../market/eastmoney';

// 历史 K 线适配层：把系统统一的 getKline（多源兜底、前复权）映射成 tradelab 的 candle。
// 仅支持 day / week —— 日/周线下「下一根 bar 成交」天然满足 A 股 T+1，盘中级别会破坏该前提故不开放。

const SUPPORTED_PERIODS: KlinePeriod[] = ['day', 'week'];

export interface LoadedCandles {
  /** tradelab 入参（time 为毫秒时间戳） */
  candles: Candle[];
  /** 与 candles 等长同序的交易日 YYYY-MM-DD，便于把引擎返回的 ms 时间映射回交易日 */
  dates: string[];
}

/** 上海时区零点解析交易日为毫秒，避免运行环境本地时区导致跨日漂移 */
function dateToMs(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}

/** 毫秒时间戳 → 上海时区交易日 YYYY-MM-DD（引擎结果回填用） */
export function msToDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

export function assertSupportedPeriod(period: KlinePeriod): void {
  if (!SUPPORTED_PERIODS.includes(period)) {
    throw new Error(`回测仅支持日线/周线（day/week），收到 ${period}`);
  }
}

/** 拉取并映射单标的历史 K 线为 tradelab candle（已按时间升序、去除无效时间戳） */
export async function loadCandles(
  code: string,
  period: KlinePeriod,
  limit: number,
): Promise<LoadedCandles> {
  assertSupportedPeriod(period);
  const bars = await getKline(code, period, limit);
  const candles: Candle[] = [];
  const dates: string[] = [];
  for (const b of bars) {
    const t = dateToMs(b.time);
    if (!Number.isFinite(t)) continue;
    candles.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    dates.push(b.time);
  }
  if (candles.length === 0) throw new Error(`未取到 ${code} 的有效 K 线`);
  return { candles, dates };
}
