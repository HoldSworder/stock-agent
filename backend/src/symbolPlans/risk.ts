import type {
  CandidateCatalog,
  CandidateLevel,
  KlineBar,
  KlinePeriod,
  MarketRegimePhase,
  SymbolTechnicalContext,
  SymbolTradePlan,
} from '@stock-agent/shared';
import { planPeriodRank } from '@stock-agent/shared';
import { budgetForPhase, computeSizing } from '../positions/riskBudget';

const REGIME_PHASES: MarketRegimePhase[] = ['主升', '退潮', '反弹', '震荡'];

// 风险与执行装配（计划 9.x）。全部复用 positions/riskBudget.ts 的口径：
// 结构止损 vs 2×ATR 取大、个股跳空 P95 缓冲、费用缓冲、按大盘阶段分层的单票上限。
// 本文件只负责「从候选价位取结构止损」和「拼装 risk / execution」，不重算风险公式。

/**
 * 时间止损根数，口径固定为**日线**。
 * 候选目录的时间窗条件必须复用这份常量——两边各写一套的话，
 * risk 字段说 10 根、候选却把 20 根标成「时间止损」，用户看到的是两个互相打架的数。
 *
 * 合并期限车道前这是 {next_session:1, swing:10}。次日车道的 1 根本身就有问题：
 * 计划生效满 1 根日线就判时间止损，等于当天不触发就作废，
 * 而 60 分钟级的触发条件根本没机会在一根日线内走完。
 * 现在统一按日线 10 根，短周期条件靠自己的 timeframe 表达急迫程度。
 */
export const TIME_STOP_BARS = 10;

/** 追涨保护：次日高开超过该 ATR 倍数不追（计划 9.5） */
const CHASE_GUARD_ATR = 1.5;

/** ETF 折溢价闸门（%），超过则市场条件满足也不给可执行动作 */
const MAX_PREMIUM_PCT = 1;

export interface RiskInput {
  context: SymbolTechnicalContext;
  catalog: CandidateCatalog;
  dayBars: KlineBar[];
  /** 账户总权益；未接入时传 0，此时只给风险距离不给建议仓位 */
  totalEquity: number;
  currentShares: number;
}

/**
 * 结构止损的最细锚定周期。**只认日线及更大周期的支撑**。
 *
 * 候选目录改为 week/day/60m 三层出货后，离现价最近的支撑几乎总是 60 分钟级的。
 * 而止损距离是反推仓位的分母：60 分钟级支撑常常只离现价 0.5%，
 * 据此算出的仓位会比按日线支撑算的放大好几倍，一根日内长阴就能同时打穿止损和仓位上限。
 * 60 分钟级的位子适合当盘中触发点，不能当「证明这笔交易逻辑错了」的证据。
 */
const STOP_ANCHOR_PERIOD: KlinePeriod = 'day';

/**
 * 结构止损取值：优先用保底的最近确认摆动低点，其次用最近的支撑类候选。
 * 找不到就返回 null——宁可不给仓位建议，也不用近似值凑。
 *
 * 一律取候选的区间**下沿**而非中点：候选是价格带（low~high），把止损放在带的中点，
 * 价格只要在带内正常震荡就会被扫掉，止损失去「证明逻辑错误」的意义。
 */
export function pickStructuralStop(levels: CandidateLevel[], price: number): number | null {
  const supports = levels
    .filter(
      (l) =>
        l.low < price &&
        planPeriodRank(l.timeframe) <= planPeriodRank(STOP_ANCHOR_PERIOD) &&
        l.compatibleRoles.some((r) => r === 'support' || r === 'invalidation' || r === 'stop'),
    )
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
  const { context, dayBars } = input;
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
        timeStopBars: TIME_STOP_BARS,
        gapRiskNote: '无有效行情，未计算风险距离',
        allowedShares: null,
        reduceShares: null,
        effectiveLossPct: null,
        sizingBasisPrice: null,
      },
      execution: {
        chaseGuardAtr: null,
        maxPremiumPct: null,
        maxSpreadPct: null,
        nextReviewAt: nextReviewAt(),
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
      timeStopBars: TIME_STOP_BARS,
      gapRiskNote: gapNote,
      // 股数是 computeSizing 早就算好的，此前只取了权重百分比就把它丢了，
      // 于是界面只能给「占 8%」，用户还得自己拿总资产去乘、再除股价、再凑整手
      allowedShares: sizing?.allowedShares ?? null,
      reduceShares: sizing?.reduceShares ?? null,
      effectiveLossPct: sizing?.effectiveLossPct ?? null,
      // 记下算股数用的是哪个价：实际挂单价（触发价）通常高于现价，界面必须据此等比缩减
      sizingBasisPrice: sizing ? Math.round(price * 1000) / 1000 : null,
    },
    execution: {
      // 触发口径不再是计划级的一个值：同一份计划里 tick 级上穿与周线收盘确认并存，
      // 由每条条件的 cadenceOf(cond) 逐条决定，前端也照此逐条显示
      chaseGuardAtr: CHASE_GUARD_ATR,
      maxPremiumPct: context.assetType === 'etf' ? MAX_PREMIUM_PCT : null,
      // 五档不可用，价差闸门保持 null 并由 executionQuality 显式标缺失
      maxSpreadPct: null,
      nextReviewAt: nextReviewAt(),
    },
  };
}

/**
 * 下次复核时间：下一交易日收盘后。
 * 合并车道后不再按期限拉长到一周——计划里既有 60 分钟级条件，
 * 一周才复核一次意味着短周期那部分整周处于无人看管状态。
 * 真正的长期有效性由 expiresAt 与时间止损负责。
 */
function nextReviewAt(): string {
  return new Date(Date.now() + 86_400_000).toISOString();
}
