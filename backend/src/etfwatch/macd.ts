import type { KlineBar, KlinePeriod, MacdReadout } from '@stock-agent/shared';
import { getKline } from '../market/eastmoney';
import { calcMacd } from '../market/indicators';

// 多周期 MACD 读数：收盘确认（剔除盘中未走完的当根 K，防重绘）+ 金叉/死叉/多头/空头状态。
// 复用 market/indicators.ts 的 calcMacd（CN 口径 DIF/DEA/柱），不重写算法。

/** 单周期 MACD 读数（含方向过滤与去重所需的 barTime） */
export interface TfMacdReadout {
  state: MacdReadout['state'];
  dif: number;
  dea: number;
  /** DIF ≥ DEA（多头排列，用于大周期方向过滤） */
  bullish: boolean;
  /** DIF > 0（零轴上方，用于金叉质量过滤） */
  aboveZero: boolean;
  /** 最新已收盘 bar 的时间（按 bar 去重的键，保证每根收盘 K 仅触发一次） */
  barTime: string;
  /** 最新收盘价 */
  close: number;
  /** 近 N 根最低价（30m 移动止损用） */
  recentLow: number;
}

/** 计算 MACD/方向所需的最少 K 线根数（与 indicators.MIN_BARS 同口径） */
const MIN_BARS = 35;

/** 末根视为盘中未走完（形成中），剔除以「收盘确认」防重绘 */
function closedBars(bars: KlineBar[]): KlineBar[] {
  return bars.length > 1 ? bars.slice(0, -1) : bars.slice();
}

/** 读取某只标的某周期的 MACD 读数（基于已收盘 K；数据不足/取数失败返回 null） */
export async function readTfMacd(
  code: string,
  period: KlinePeriod,
  trailLookback = 3,
): Promise<TfMacdReadout | null> {
  let bars: KlineBar[];
  try {
    bars = await getKline(code, period, 260);
  } catch {
    return null;
  }
  const closed = closedBars(bars);
  if (closed.length < MIN_BARS) return null;
  const closes = closed.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0);
  const macd = calcMacd(closes);
  if (!macd) return null;
  const last = closed[closed.length - 1];
  const lows = closed.slice(-Math.max(1, trailLookback)).map((b) => b.low);
  return {
    state: macd.state,
    dif: macd.dif,
    dea: macd.dea,
    bullish: macd.dif >= macd.dea,
    aboveZero: macd.dif > 0,
    barTime: last.time,
    close: last.close,
    recentLow: Math.min(...lows),
  };
}

/** 日线综合读数：一次取日线即得 MACD + MA20 + MA60（省一次取数） */
export interface DayContext {
  macd: TfMacdReadout;
  /** 20 日均线（不足则 null，硬止损 MA20 用） */
  ma20: number | null;
  /** 60 日均线（不足则 null，风险总闸 / L3 多头替代判据用） */
  ma60: number | null;
}

function maOf(closed: KlineBar[], period: number): number | null {
  if (closed.length < period) return null;
  const slice = closed.slice(-period).map((b) => b.close);
  return slice.reduce((s, x) => s + x, 0) / period;
}

/** 读取日线综合读数（基于已收盘日线；数据不足/失败返回 null） */
export async function readDayContext(
  code: string,
  trailLookback = 3,
): Promise<DayContext | null> {
  let bars: KlineBar[];
  try {
    bars = await getKline(code, 'day', 260);
  } catch {
    return null;
  }
  const closed = closedBars(bars);
  if (closed.length < MIN_BARS) return null;
  const closes = closed.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0);
  const macd = calcMacd(closes);
  if (!macd) return null;
  const last = closed[closed.length - 1];
  const lows = closed.slice(-Math.max(1, trailLookback)).map((b) => b.low);
  return {
    macd: {
      state: macd.state,
      dif: macd.dif,
      dea: macd.dea,
      bullish: macd.dif >= macd.dea,
      aboveZero: macd.dif > 0,
      barTime: last.time,
      close: last.close,
      recentLow: Math.min(...lows),
    },
    ma20: maOf(closed, 20),
    ma60: maOf(closed, 60),
  };
}
