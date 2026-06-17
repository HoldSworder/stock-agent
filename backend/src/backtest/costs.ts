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

export function resolveCosts(input?: Partial<BacktestCosts>): BacktestCosts {
  return { ...DEFAULT_A_SHARE_COSTS, ...(input ?? {}) };
}

/**
 * 映射到 tradelab 成本模型。
 * 近似口径：tradelab 的 commissionBps 双边对称计费，而 A 股印花税仅卖出单边收取，
 * 这里把印花税折半（stampDutyBps/2）摊到买卖两腿。单笔绝对成本与真实略有出入，
 * 长区间统计层面接近；佣金、过户费本就双边，按原值并入 commissionBps。
 */
export function toTradelabCosts(c: BacktestCosts): ExecutionCostOptions {
  return {
    commissionBps: c.commissionBps + c.transferFeeBps + c.stampDutyBps / 2,
    minCommission: c.minCommission,
    slippageBps: c.slippageBps,
  };
}

/** 成本口径说明（写入回测结果 notes，前端透明展示） */
export function costNote(c: BacktestCosts): string {
  return (
    `成本口径：佣金双边 ${c.commissionBps}bps（最低 ${c.minCommission} 元）` +
    ` + 过户费双边 ${c.transferFeeBps}bps + 印花税卖出 ${c.stampDutyBps}bps（折半摊双边近似）` +
    ` + 滑点 ${c.slippageBps}bps`
  );
}
