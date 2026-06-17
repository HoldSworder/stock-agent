import {
  backtest,
  backtestPortfolio,
  walkForwardOptimize,
  type BacktestMetrics,
  type BacktestResult,
  type Candle,
  type ExecutionCostOptions,
  type PortfolioBacktestResult,
  type SignalFunction,
  type WalkForwardResult,
} from 'tradelab';

// tradelab 隔离层：全工程唯一直接依赖 tradelab 的文件。
// 上层只见此处的入参/出参，将来若换库或退回自研，仅需改这一处。
// 统一开启 strict（前视偏差防护）与 collectEqSeries（净值曲线）。

export type { BacktestResult, PortfolioBacktestResult, WalkForwardResult };

export interface SignalRunArgs {
  candles: Candle[];
  symbol: string;
  signal: SignalFunction;
  equity: number;
  /** 单笔风险占比（%） */
  riskPct: number;
  costs: ExecutionCostOptions;
  /** >0 时启用 ATR 跟踪止盈 */
  atrTrailMult?: number;
}

/** 单标的信号级回测 */
export function runSignalBacktest(a: SignalRunArgs): BacktestResult {
  return backtest({
    candles: a.candles,
    symbol: a.symbol,
    equity: a.equity,
    riskPct: a.riskPct,
    signal: a.signal,
    costs: a.costs,
    atrTrailMult: a.atrTrailMult && a.atrTrailMult > 0 ? a.atrTrailMult : undefined,
    collectEqSeries: true,
    strict: true,
  });
}

export interface PortfolioSystemArgs {
  symbol: string;
  candles: Candle[];
  signal: SignalFunction;
  /** 默认配置上限权重（缺省等权） */
  weight?: number;
  riskPct: number;
  costs: ExecutionCostOptions;
  atrTrailMult?: number;
}

/** 组合级回测（阶段二）：多标的共享资金，权重作为单系统配置上限 */
export function runPortfolioBacktest(
  equity: number,
  systems: PortfolioSystemArgs[],
): PortfolioBacktestResult {
  return backtestPortfolio({
    equity,
    collectEqSeries: true,
    systems: systems.map((s) => ({
      symbol: s.symbol,
      candles: s.candles,
      signal: s.signal,
      weight: s.weight,
      riskPct: s.riskPct,
      costs: s.costs,
      atrTrailMult: s.atrTrailMult && s.atrTrailMult > 0 ? s.atrTrailMult : undefined,
      strict: true,
    })),
  });
}

export interface WalkForwardArgs {
  candles: Candle[];
  /** 由参数集构造信号函数（绑定标的等闭包变量） */
  signalFactory: (params: Record<string, unknown>) => SignalFunction;
  parameterSets: Array<Record<string, unknown>>;
  trainBars: number;
  testBars: number;
  stepBars?: number;
  mode?: 'rolling' | 'anchored';
  /** 训练期择优指标，默认 profitFactor */
  scoreBy?: keyof BacktestMetrics;
}

/**
 * 滚动 / 锚定 walk-forward 参数稳健性检验（阶段二稳健性）。
 * 每个窗口在训练期择优、测试期盲跑，输出样本外稳定性。隔离层暴露，便于后续服务/UI 接入。
 */
export function runWalkForward(a: WalkForwardArgs): WalkForwardResult {
  return walkForwardOptimize({
    candles: a.candles,
    signalFactory: a.signalFactory,
    parameterSets: a.parameterSets,
    trainBars: a.trainBars,
    testBars: a.testBars,
    stepBars: a.stepBars,
    mode: a.mode ?? 'rolling',
    scoreBy: a.scoreBy ?? 'profitFactor',
  });
}
