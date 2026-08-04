import type {
  CandidateCatalog,
  CandidateLevel,
  KlineBar,
  MarketRegimePhase,
  SymbolPlanHorizon,
  SymbolTechnicalContext,
  SymbolTradePlan,
} from '@stock-agent/shared';
import { budgetForPhase, computeSizing } from '../positions/riskBudget';

const REGIME_PHASES: MarketRegimePhase[] = ['主升', '退潮', '反弹', '震荡'];

// 风险与执行装配（计划 9.x）。全部复用 positions/riskBudget.ts 的口径：
// 结构止损 vs 2×ATR 取大、个股跳空 P95 缓冲、费用缓冲、按大盘阶段分层的单票上限。
// 本文件只负责「从候选价位取结构止损」和「拼装 risk / execution」，不重算风险公式。

/** 时间止损：次日计划 1 根，波段 10 根 */
const TIME_STOP_BARS: Record<SymbolPlanHorizon, number> = { next_session: 1, swing: 10 };

/** 追涨保护：次日高开超过该 ATR 倍数不追（计划 9.5） */
const CHASE_GUARD_ATR = 1.5;

/** ETF 折溢价闸门（%），超过则市场条件满足也不给可执行动作 */
const MAX_PREMIUM_PCT = 1;

export interface RiskInput {
  context: SymbolTechnicalContext;
  catalog: CandidateCatalog;
  dayBars: KlineBar[];
  horizon: SymbolPlanHorizon;
  /** 账户总权益；未接入时传 0，此时只给风险距离不给建议仓位 */
  totalEquity: number;
  currentShares: number;
}

/**
 * 结构止损取值：优先用保底的最近确认摆动低点，其次用最近的支撑类候选。
 * 找不到就返回 null——宁可不给仓位建议，也不用近似值凑。
 *
 * 一律取候选的区间**下沿**而非中点：候选是价格带（low~high），把止损放在带的中点，
 * 价格只要在带内正常震荡就会被扫掉，止损失去「证明逻辑错误」的意义。
 */
export function pickStructuralStop(levels: CandidateLevel[], price: number): number | null {
  const supports = levels
    .filter((l) => l.low < price && l.compatibleRoles.some((r) => r === 'support' || r === 'invalidation' || r === 'stop'))
    .sort((a, b) => b.low - a.low); // 距现价最近的支撑在前
  // 保底候选（最近确认摆动低点）优先
  const guaranteed = supports.find((l) => l.guaranteed);
  return (guaranteed ?? supports[0])?.low ?? null;
}

export interface AssembledRisk {
  risk: SymbolTradePlan['risk'];
  execution: SymbolTradePlan['execution'];
}

export function assembleRisk(input: RiskInput): AssembledRisk {
  const { context, dayBars, horizon } = input;
  const lastBar = dayBars[dayBars.length - 1];
  // 无行情时回落成全 null 的风险读数：这条路径本该降级成观察计划，
  // 直接解引用会把「准备上下文」整个打挂。
  if (!lastBar || !(lastBar.close > 0)) {
    return {
      risk: {
        structuralStop: null,
        volatilityStop: null,
        executionStop: null,
        atrPct: null,
        maxAccountRiskPct: budgetForPhase(null).singleTradeRiskPct,
        suggestedPositionPct: null,
        timeStopBars: TIME_STOP_BARS[horizon],
        gapRiskNote: '无有效行情，未计算风险距离',
      },
      execution: {
        triggerMode: 'close_confirmed',
        chaseGuardAtr: null,
        maxPremiumPct: null,
        maxSpreadPct: null,
        nextReviewAt: nextReviewAt(horizon),
      },
    };
  }
  const price = lastBar.close;
  const atrPct = context.periods.find((p) => p.meta.period === 'day')?.atrPct ?? null;
  const structuralStop = pickStructuralStop(input.catalog.levels, price);
  // 未知或非法阶段一律回落震荡档（riskBudget 的既有纪律：阶段未知取紧）
  const regime = REGIME_PHASES.includes(context.marketRegimePhase as MarketRegimePhase)
    ? (context.marketRegimePhase as MarketRegimePhase)
    : null;
  const budget = budgetForPhase(regime);

  const stopDistancePct =
    structuralStop != null && price > 0 ? ((price - structuralStop) / price) * 100 : null;

  const assetType = context.assetType === 'etf' ? 'etf' : 'stock';
  const sizing =
    stopDistancePct != null && stopDistancePct > 0 && input.totalEquity > 0
      ? computeSizing(
          {
            assetType,
            price,
            stopDistancePct,
            totalEquity: input.totalEquity,
            currentShares: input.currentShares,
            bars: dayBars,
          },
          budget,
        )
      : null;

  // 波动止损：2×ATR（与 riskBudget 的 ATR_MULT 口径一致，由 sizing 回吐）
  const volatilityStop =
    sizing?.atrDistancePct != null ? price * (1 - sizing.atrDistancePct / 100) : null;

  // 执行止损：结构位与波动位取更远者，再叠加跳空与费用缓冲，即 sizing 的有效损失距离。
  // 算不出 sizing 时返回 null 而非回落成裸结构位——该字段的定义是「已含缓冲」，
  // 回落会让消费方分不清拿到的是含缓冲值还是裸值。
  const executionStop =
    sizing?.effectiveLossPct != null ? price * (1 - sizing.effectiveLossPct / 100) : null;

  const gapNote =
    sizing?.gapBufferPct && sizing.gapBufferPct > 0
      ? `已计入近 60 日向下跳空 P95 缓冲 ${sizing.gapBufferPct}%`
      : assetType === 'etf'
        ? 'ETF 由一篮子成分平滑，未额外计跳空缓冲'
        : null;

  return {
    risk: {
      structuralStop: structuralStop == null ? null : Math.round(structuralStop * 1000) / 1000,
      volatilityStop: volatilityStop == null ? null : Math.round(volatilityStop * 1000) / 1000,
      executionStop: executionStop == null ? null : Math.round(executionStop * 1000) / 1000,
      atrPct,
      maxAccountRiskPct: budget.singleTradeRiskPct,
      suggestedPositionPct: sizing?.allowedWeightPct ?? null,
      timeStopBars: TIME_STOP_BARS[horizon],
      gapRiskNote: gapNote,
    },
    execution: {
      // 波段买点原则上收盘确认；次日计划允许盘中预警
      triggerMode: horizon === 'swing' ? 'close_confirmed' : 'intraday_alert',
      chaseGuardAtr: CHASE_GUARD_ATR,
      maxPremiumPct: context.assetType === 'etf' ? MAX_PREMIUM_PCT : null,
      // 五档不可用，价差闸门保持 null 并由 executionQuality 显式标缺失
      maxSpreadPct: null,
      nextReviewAt: nextReviewAt(horizon),
    },
  };
}

/** 下次复核时间：次日计划在下一交易日收盘后，波段在一周后 */
function nextReviewAt(horizon: SymbolPlanHorizon): string {
  const days = horizon === 'next_session' ? 1 : 7;
  return new Date(Date.now() + days * 86_400_000).toISOString();
}
