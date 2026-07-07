import type { StrategySellProfile, WeipanExitReason } from '@stock-agent/shared';

// 尾盘套利确定性卖点规则（纯函数、零 token、零外部依赖，可独立自检）。
// 卖点阈值口径来自 watch/strategyProfile 的尾盘档案（由 engine 注入 profile），此文件不直接读 DB。

/** 兜底档案：与 watch/strategyProfile.ts 的 WEIPAN_PROFILE 同口径（止盈5%/回撤3%/止损3%/14:50了结） */
export const WEIPAN_FALLBACK_PROFILE: StrategySellProfile = {
  takeProfitPct: 5,
  intradayDrawdownPct: 3,
  stopLossPct: 3,
  eodCutoffMin: 890,
};

export interface ExitInput {
  /** 建仓均价 */
  avgCost: number;
  /** 现价 */
  price: number;
  /** 盘中观测到的当日最高 */
  dayHigh: number;
  /** 当前上海时间分钟数（0-1439），用于尾盘了结判定 */
  minutes: number;
}

export interface ExitResult {
  reason: WeipanExitReason;
  detail: string;
  gainPct: number;
  drawdownPct: number;
}

/**
 * 确定性卖点判定：止损 > 止盈 > 移动止盈(冲高回落) > 尾盘了结；均不命中返回 null。
 * 纯函数、无副作用，供引擎调用与自检脚本断言。
 */
export function evalWeipanExit(input: ExitInput, profile: StrategySellProfile): ExitResult | null {
  const { avgCost, price, dayHigh, minutes } = input;
  if (avgCost <= 0 || price <= 0) return null;
  const gainPct = ((price - avgCost) / avgCost) * 100;
  const drawdownPct = dayHigh > 0 ? ((dayHigh - price) / dayHigh) * 100 : 0;

  // ① 止损：跌破成本达 stopLossPct（安全垫，最高优先）
  const stopLine = avgCost * (1 - profile.stopLossPct / 100);
  if (price <= stopLine) {
    return {
      reason: 'stop_loss',
      detail: `跌破止损线 ${stopLine.toFixed(2)}（成本 ${avgCost.toFixed(2)} 下方 ${profile.stopLossPct}%，现价 ${price.toFixed(2)}）`,
      gainPct,
      drawdownPct,
    };
  }

  // ② 止盈：浮盈达 takeProfitPct
  if (gainPct >= profile.takeProfitPct) {
    return {
      reason: 'take_profit',
      detail: `达止盈线：浮盈 +${gainPct.toFixed(2)}%（止盈线 +${profile.takeProfitPct}%，现价 ${price.toFixed(2)}）`,
      gainPct,
      drawdownPct,
    };
  }

  // ③ 移动止盈（冲高回落）：确有冲高（当日高点高于成本）且自当日高点回撤达 intradayDrawdownPct
  if (dayHigh > avgCost && drawdownPct >= profile.intradayDrawdownPct) {
    return {
      reason: 'trailing',
      detail: `冲高回落：自当日高点 ${dayHigh.toFixed(2)} 回撤 ${drawdownPct.toFixed(1)}%（阈值 ${profile.intradayDrawdownPct}%，现价 ${price.toFixed(2)}）`,
      gainPct,
      drawdownPct,
    };
  }

  // ④ 尾盘了结：到点强制不过夜（eodCutoffMin=0 表示不启用）
  if (profile.eodCutoffMin > 0 && minutes >= profile.eodCutoffMin) {
    return {
      reason: 'eod',
      detail: `尾盘了结：不过夜（现价 ${price.toFixed(2)}，浮盈 ${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(2)}%）`,
      gainPct,
      drawdownPct,
    };
  }

  return null;
}
