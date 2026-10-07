import type { ExecutionCostOptions } from 'tradelab';
import type { BacktestCosts } from '@stock-agent/shared';

// A 股交易成本模型：佣金（双边）+ 印花税（卖出单边）+ 过户费（双边）+ 滑点。
// 默认值取常见档位：佣金万 2.5 最低 5 元、印花税 0.05%、沪市过户费 0.001%、滑点万 2。

export const DEFAULT_A_SHARE_COSTS: BacktestCosts = {
  commissionBps: 2.5,
  minCommission: 5,
  stampDutyBps: 5,
  transferFeeBps: 0.1,
  slippageBps: 2,
};

/**
 * ETF 档：场内基金**免征印花税、免过户费**，直接套股票默认档会凭空多扣 5bps 卖出成本，
 * 在高换手模式上足以把收益压掉一大截，故单独一档。
 */
export const DEFAULT_ETF_COSTS: BacktestCosts = {
  commissionBps: 2.5,
  minCommission: 5,
  stampDutyBps: 0,
  transferFeeBps: 0,
  slippageBps: 2,
};

export function resolveCosts(input?: Partial<BacktestCosts>): BacktestCosts {
  return { ...DEFAULT_A_SHARE_COSTS, ...(input ?? {}) };
}

export function resolveEtfCosts(input?: Partial<BacktestCosts>): BacktestCosts {
  return { ...DEFAULT_ETF_COSTS, ...(input ?? {}) };
}

/** 单边成本率（bps）：买入不含印花税，卖出含。不含最低佣金（需知名义本金才能折算） */
export function sideCostBps(c: BacktestCosts, side: 'buy' | 'sell'): number {
  return (
    c.commissionBps + c.transferFeeBps + c.slippageBps + (side === 'sell' ? c.stampDutyBps : 0)
  );
}

/**
 * 映射到 tradelab。它的 commissionBps 买卖同一费率，不能表达卖出单边税。
 * 所以这里不把印花税摊进两腿：买入不含印花税，未平仓也不会提前扣半笔税。
 * 卖出整笔印花税由调用方按 sellStampBps 在平仓时另计。
 */
export function toTradelabCosts(c: BacktestCosts): ExecutionCostOptions {
  return {
    commissionBps: c.commissionBps + c.transferFeeBps,
    minCommission: c.minCommission,
    slippageBps: c.slippageBps,
  };
}

/** 费用怎么算的说明（写入回测结果 notes，前端透明展示） */
export function costNote(c: BacktestCosts): string {
  return (
    `费用怎么算：佣金双边 ${c.commissionBps}bps（最低 ${c.minCommission} 元）` +
    ` + 过户费双边 ${c.transferFeeBps}bps + 印花税只在卖出按当日税率整笔计（买入不含，未平仓不提前扣）` +
    ` + 滑点 ${c.slippageBps}bps`
  );
}
