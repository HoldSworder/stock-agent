import type { BacktestResult, ExecutionCostOptions } from 'tradelab';
import type { BacktestCosts } from '@stock-agent/shared';
import { sellStampBps } from '../market/instrument';
import { msToDate } from './candles';

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
    ` + 过户费双边 ${c.transferFeeBps}bps + 印花税只在已平仓的卖出按卖出日税率整笔计（买入不含，期末仍持有不提前扣，权益曲线含这笔卖出印花税）` +
    ` + 滑点 ${c.slippageBps}bps`
  );
}

/** 一笔已平仓卖出的印花税。期末仍持有的不进这里。 */
function sellStampOf(code: string, exitTime: number, price: number, qty: number): number {
  const bps = sellStampBps(code, msToDate(exitTime).slice(0, 10));
  if (!(bps > 0) || !(qty > 0) || !(price > 0)) return 0;
  return (price * qty * bps) / 10000;
}

/**
 * 已平仓的卖出按卖出日税率整笔另扣，并从该时点起的权益曲线里减掉。
 * 期末仍持有的仓位不在 trades 里，不提前扣。
 * @param result tradelab 回测结果。买入腿已经不含印花税
 * @param fallbackSymbol 单标的回测时成交记录可能不带代码
 */
export function applyClosedSellStamp(result: BacktestResult, fallbackSymbol = ''): void {
  const cuts: Array<{ time: number; stamp: number }> = [];
  const stamped = new Set(result.trades);
  for (const trade of result.trades) {
    const stamp = sellStampOf(trade.symbol || fallbackSymbol, trade.exit.time, trade.exit.price, trade.size);
    if (!(stamp > 0)) continue;
    trade.exit.pnl -= stamp;
    cuts.push({ time: trade.exit.time, stamp });
  }
  // 组合结果里的 positions 是拷贝，不是 trades 里的同一对象。只改盈亏，不再扣一次曲线。
  for (const trade of result.positions) {
    if (stamped.has(trade)) continue;
    const stamp = sellStampOf(trade.symbol || fallbackSymbol, trade.exit.time, trade.exit.price, trade.size);
    if (stamp > 0) trade.exit.pnl -= stamp;
  }
  cuts.sort((a, b) => a.time - b.time);
  let cursor = 0;
  let deducted = 0;
  const series = result.eqSeries ?? [];
  for (let i = 0; i < series.length; i++) {
    const time = series[i].time;
    const next = series[i + 1]?.time;
    while (cursor < cuts.length && cuts[cursor].time < time) deducted += cuts[cursor++].stamp;
    // 同一时刻可能先记一根市值、再记平仓后的权益。印花税算进后一根。
    if (next !== time) {
      while (cursor < cuts.length && cuts[cursor].time === time) deducted += cuts[cursor++].stamp;
    }
    series[i].equity -= deducted;
  }
  if (cursor < cuts.length && series.length > 0) {
    let rest = 0;
    while (cursor < cuts.length) rest += cuts[cursor++].stamp;
    series[series.length - 1].equity -= rest;
  }
  const last = series[series.length - 1];
  if (last) {
    result.metrics.finalEquity = last.equity;
    result.metrics.totalPnL = last.equity - result.metrics.startEquity;
    result.metrics.returnPct =
      result.metrics.startEquity > 0 ? result.metrics.totalPnL / result.metrics.startEquity : 0;
  }
  const done = result.positions;
  if (done.length > 0) {
    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;
    for (const trade of done) {
      if (trade.exit.pnl > 0) {
        wins += 1;
        grossProfit += trade.exit.pnl;
      } else {
        grossLoss += -trade.exit.pnl;
      }
    }
    result.metrics.winRate = wins / done.length;
    result.metrics.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;
    result.metrics.expectancy = (grossProfit - grossLoss) / done.length;
  }
}
