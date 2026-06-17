import type { Candle, SignalContext, SignalFunction, SignalResult } from 'tradelab';
import type { BacktestParams, BacktestPreset } from '@stock-agent/shared';

// 预设交易信号（白话口径，不暴露因子/IC 等量化概念）：
//  - maTrend：均线多头趋势跟随，快线上穿慢线（金叉）建仓，跌破近 N 日低点止损 + 盈亏比目标 / ATR 跟踪止盈。
//  - momentum：动能突破，创近 N 日新高且区间涨幅达阈值建仓，止损/目标同上。
// 所有信号仅在空仓时给出建仓，离场由引擎按 stop / takeProfit(rr) / ATR 跟踪止盈统一管理。

const DEFAULTS = {
  fastPeriod: 10,
  slowPeriod: 30,
  lookback: 20,
  breakoutPct: 0,
  stopLookback: 10,
  rr: 2,
  atrTrailMult: 0,
} satisfies Required<BacktestParams>;

export function resolveParams(preset: BacktestPreset, params?: BacktestParams): Required<BacktestParams> {
  const p = { ...DEFAULTS, ...(params ?? {}) };
  if (preset === 'maTrend' && p.fastPeriod >= p.slowPeriod) {
    throw new Error(`maTrend 快线周期(${p.fastPeriod})需小于慢线周期(${p.slowPeriod})`);
  }
  return p;
}

/** 收盘价简单均线（取序列末尾 period 根；不足返回 null，避免前视/不足样本） */
function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
  return sum / period;
}

/** 按代码段判定涨跌停幅度（%）：创业板/科创板 20%，北交所 30%，其余主板 10%（ST 无法仅由代码识别，按主板兜底） */
function limitPct(code: string): number {
  if (/^(30|68)/.test(code)) return 20;
  if (/^(43|83|87|88|92)/.test(code)) return 30;
  return 10;
}

/** 近 stopLookback 根最低价作为止损位 */
function recentLow(history: Candle[], stopLookback: number): number {
  const slice = history.slice(Math.max(0, history.length - stopLookback));
  return slice.reduce((m, c) => Math.min(m, c.low), Number.POSITIVE_INFINITY);
}

/**
 * 涨停板近似过滤：当根涨幅逼近涨停（>= 幅度*0.99）则不建仓。
 * KlineBar 无涨跌停标志，按相对昨收涨幅近似识别（标注为近似口径）。
 */
function nearLimitUp(history: Candle[], code: string): boolean {
  const n = history.length;
  if (n < 2) return false;
  const prev = history[n - 2].close;
  if (!(prev > 0)) return false;
  const pct = ((history[n - 1].close - prev) / prev) * 100;
  return pct >= limitPct(code) * 0.99;
}

/** 组装做多建仓信号（含止损/盈亏比校验，风险非正则放弃） */
function buildLong(entry: number, stop: number, rr: number): SignalResult | null {
  if (!(entry > 0) || !(stop > 0) || stop >= entry) return null;
  return { side: 'long', entry, stop, rr };
}

function maTrendSignal(code: string, p: Required<BacktestParams>): SignalFunction {
  return (ctx: SignalContext): SignalResult | null => {
    if (ctx.openPosition) return null;
    const history = ctx.candles;
    const n = history.length;
    if (n <= p.slowPeriod) return null;
    if (nearLimitUp(history, code)) return null;
    const closes = history.map((c) => c.close);
    const prevCloses = closes.slice(0, n - 1);
    const fastNow = sma(closes, p.fastPeriod);
    const slowNow = sma(closes, p.slowPeriod);
    const fastPrev = sma(prevCloses, p.fastPeriod);
    const slowPrev = sma(prevCloses, p.slowPeriod);
    if (fastNow == null || slowNow == null || fastPrev == null || slowPrev == null) return null;
    // 金叉：上一根快线在慢线下方/相等，本根上穿
    if (!(fastPrev <= slowPrev && fastNow > slowNow)) return null;
    return buildLong(ctx.bar.close, recentLow(history, p.stopLookback), p.rr);
  };
}

function momentumSignal(code: string, p: Required<BacktestParams>): SignalFunction {
  return (ctx: SignalContext): SignalResult | null => {
    if (ctx.openPosition) return null;
    const history = ctx.candles;
    const n = history.length;
    if (n <= p.lookback) return null;
    if (nearLimitUp(history, code)) return null;
    const closes = history.map((c) => c.close);
    const cur = closes[n - 1];
    // 前 lookback 根（不含当根）收盘高点与区间起点
    const windowStart = n - 1 - p.lookback;
    const prevWindow = closes.slice(windowStart, n - 1);
    const priorHigh = prevWindow.reduce((m, v) => Math.max(m, v), Number.NEGATIVE_INFINITY);
    const base = closes[windowStart];
    if (!(base > 0)) return null;
    const ret = ((cur - base) / base) * 100;
    // 创近 lookback 新高且区间涨幅达阈值
    if (!(cur > priorHigh && ret >= p.breakoutPct)) return null;
    return buildLong(ctx.bar.close, recentLow(history, p.stopLookback), p.rr);
  };
}

/** 按预设构造信号函数（闭包内绑定代码用于涨停过滤） */
export function buildSignal(
  preset: BacktestPreset,
  code: string,
  p: Required<BacktestParams>,
): SignalFunction {
  switch (preset) {
    case 'maTrend':
      return maTrendSignal(code, p);
    case 'momentum':
      return momentumSignal(code, p);
    default:
      throw new Error(`未知回测预设：${preset as string}`);
  }
}
