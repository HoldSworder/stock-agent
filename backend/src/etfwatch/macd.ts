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

/** Asia/Shanghai 当前的 'YYYY-MM-DD' 与 'HH:MM' */
function shanghaiNow(now: Date): { day: string; time: string } {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  return { day, time };
}

/** 某个 'YYYY-MM-DD' 所在自然周的周一（同为 'YYYY-MM-DD'）。周日按 ISO 归入前一周。 */
function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // 周一=1 … 周日=7
  d.setUTCDate(d.getUTCDate() - (iso - 1));
  return d.toISOString().slice(0, 10);
}

/** 上海当前是否已过本周收盘（周五 15:00 及以后，含周六周日） */
function weekClosedNow(day: string, time: string): boolean {
  const iso = new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
  return iso > 5 || (iso === 5 && time >= '15:00');
}

/**
 * 末根 K 是否已收盘。
 * 盘中形成中的当根必须剔除（防重绘），但 triggerEtfWatchNow 明确「忽略交易时段」——
 * 收盘后手动触发时无条件砍掉末根，拿到的就是**上一根**，今天刚出现的死叉要到明天才被认。
 * - 日线：bar 日期早于今日必已收盘；今日那根等 15:00 收市后才算。
 * - 分钟线：东财以区间结束时刻打标，结束时刻 ≤ 当前即已走完。
 * - 周线：bar 落在更早的自然周即已收盘；同周则要求当前已过周五 15:00。
 *   一律剔末根会让周五收盘到下周一开盘之间拿到**上上周**的读数，
 *   而周线读数是 ETF 盯盘的大周期共振/趋势过滤，周末手动触发正好命中这个洞。
 * - 月线：一律视为未收盘（沿用旧行为，本月未走完就认多头/死叉噪声更大）。
 */
export function isLastBarClosed(time: string, period: KlinePeriod, now = new Date()): boolean {
  const cur = shanghaiNow(now);
  if (time.includes(':')) return time.slice(0, 16) <= `${cur.day} ${cur.time}`;
  const barDay = time.slice(0, 10);
  if (period === 'week') {
    // 东财周线以该周最后一个交易日打标，故同周与否按周一对齐后比较
    if (mondayOf(barDay) < mondayOf(cur.day)) return true;
    return mondayOf(barDay) === mondayOf(cur.day) && weekClosedNow(cur.day, cur.time);
  }
  if (period !== 'day') return false;
  if (barDay < cur.day) return true;
  return barDay === cur.day && cur.time >= '15:00';
}

/** 取已收盘 K 序列：末根未走完则剔除，已收盘则保留 */
function closedBars(bars: KlineBar[], period: KlinePeriod): KlineBar[] {
  if (bars.length <= 1) return bars.slice();
  return isLastBarClosed(bars[bars.length - 1].time, period) ? bars.slice() : bars.slice(0, -1);
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
  const closed = closedBars(bars, period);
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
  const closed = closedBars(bars, 'day');
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
