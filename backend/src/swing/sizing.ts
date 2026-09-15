import type { KlineBar, RiskBudgetTier, SwingSizingExplain } from '@stock-agent/shared';
import { computeSizing } from '../positions/riskBudget';

// 仓位与额度：这个模块决定「给多少钱去赌」。
//
// 整套设计的前提是一句必须反复讲清的话：
// **仓位上限只能限制亏多少，不能让一个没有优势的信号变成赚钱的信号。**
// 如果这套规则期望是负的，每次小亏叠起来仍然是稳定亏损。
// 所以上限压得低不是保守，是在这套规则通过前向验收之前唯一诚实的做法。
//
// 三道上限同时生效，取最小：
//  1) 单标的不超过总资产 10%
//  2) 所有未验证建议合计不超过 20%
//  3) 单次止损最多亏总资产 0.25%
// 第三条会让止损越远、仓位自动越小，这是三条里唯一与标的波动挂钩的。

/** 单标的仓位上限（占总资产 %）。未验证阶段 10% 已足够检验能否照着执行 */
export const SINGLE_CAP_PCT = 10;

/** 所有未验证建议的合计上限（占总资产 %） */
export const TOTAL_UNVERIFIED_CAP_PCT = 20;

/**
 * 单次止损最多亏掉总资产的比例 %。
 *
 * 这是**完整两层合计**的风险，不是每层各算一次——
 * 每层各算等于实际承担了两倍，那就不是 0.25% 了。
 */
export const SINGLE_TRADE_RISK_PCT = 0.25;

/**
 * 给 computeSizing 用的自造风险档。
 *
 * 不能调 riskBudget.budgetForPhase()：它按市场阶段给 0.5%~2.5% 的单次风险，
 * 是为常规持仓标定的，远超试探仓的 0.25%。
 * singleMaxStockPct / singleMaxEtfPct 必须 >= SINGLE_CAP_PCT，
 * 否则 computeSizing 内部 min() 会取它们、让 10% 名不副实（真正的单标的上限由 fixedCapPct 传）。
 */
const PROBE_BUDGET: RiskBudgetTier = {
  singleTradeRiskPct: SINGLE_TRADE_RISK_PCT,
  totalMaxPositionPct: TOTAL_UNVERIFIED_CAP_PCT,
  singleMaxStockPct: SINGLE_CAP_PCT,
  singleMaxEtfPct: SINGLE_CAP_PCT,
  boardMaxExposurePct: TOTAL_UNVERIFIED_CAP_PCT,
};

export interface SizingInput {
  assetType: 'stock' | 'etf';
  /** 按区间上沿算，也就是最不利的那个入场价 */
  entryPrice: number;
  /** 存档的初始止损 */
  initialStop: number;
  /** 账户总资产 */
  totalEquity: number;
  bars: KlineBar[];
  /** 该标的真实持仓占总资产 % */
  realPct: number;
  /**
   * 该标的在 ETF 盯盘那边已经建了几层（0~3）。
   *
   * **这里刻意不收「盯盘目标仓位 %」**，因为那个百分比换不成本函数要的基数：
   * 盯盘的 40/40/20 是「给这个赛道的钱」的分层，三层建满是 100%；
   * 本函数的一切百分比是「占账户总资产」。把 100 当成占总资产 100% 填进来，
   * 会把可执行增量永久扣成 0；反过来当成 0 填，两套系统就各自占一次仓。
   * 而「这个赛道该占账户多少」是系统里不存在的数，所以无法换算。
   *
   * 于是只收层数这个能确知的事实，有层就不给增量（见下），不猜那个百分比。
   */
  etfWatchHeldLayers: number;
  /** 其他仍在跟踪的未验证建议已占用的额度合计 %（不含本标的） */
  usedByOthersPct: number;
}

/**
 * 算出可执行增量。**全系统只有这一处计算它**，别处一律引用本函数的结果。
 *
 * 唯一合并公式：
 *   可执行增量 = max(0, min(本次建议目标, 单标的上限) − 真实持仓)
 *
 * 只在真实持仓之上补差，不重复占仓。
 *
 * ETF 盯盘那边已经建了层的标的，本函数**一律不给增量**（返回 null）。
 * 原因不是谦让，是算不出来：盯盘的层百分比以「赛道配置」为基数，本函数以
 * 「账户总资产」为基数，而两者之间的换算率（这个赛道该占账户多少）系统里没有。
 * 硬填一个数就是在两套不同的尺子之间做加减——不论填大填小都错。
 *
 * 为什么是 swing 让路：ETF 盯盘是已经在用的功能，swing 作为未验证方理应自己受限。
 *
 * 返回 null 表示给不出建议（缺总资产、缺止损、盯盘已建层等），
 * 调用方必须区别于「增量为 0」，并按 conflictNote 给出各自的说法。
 */
export function computeSwingSizing(input: SizingInput): SwingSizingExplain | null {
  const {
    assetType,
    entryPrice,
    initialStop,
    totalEquity,
    bars,
    realPct,
    etfWatchHeldLayers,
    usedByOthersPct,
  } = input;

  // 盯盘已在管这只：两套系统的仓位基数不同且无法换算，给不出能相加的数
  if (etfWatchHeldLayers > 0) return null;

  // 总资产无效时禁止给建仓建议，且不得退化成固定百分比——
  // 退化等于在不知道本金多少的情况下算风险，那个百分比是假的
  if (!(totalEquity > 0)) return null;
  if (!(entryPrice > 0) || !(initialStop > 0)) return null;
  // 止损方向必须与入场价一致（底部信号止损在下方），否则算出的距离没有意义
  const stopDistancePct = ((entryPrice - initialStop) / entryPrice) * 100;
  if (!(stopDistancePct > 0)) return null;

  const sized = computeSizing(
    {
      assetType,
      price: entryPrice,
      stopDistancePct,
      totalEquity,
      currentShares: 0,
      bars,
      fixedCapPct: SINGLE_CAP_PCT,
    },
    PROBE_BUDGET,
  );
  if (!sized) return null;

  // 风险预算给出的上限（已含 ATR、跳空、费用缓冲）
  const riskCapPct = Math.min(sized.riskCapPct, SINGLE_CAP_PCT);
  // 合计额度还剩多少
  const remainingTotalPct = Math.max(0, TOTAL_UNVERIFIED_CAP_PCT - usedByOthersPct);
  // 本次目标 = 三道上限取最小
  const target = Math.min(SINGLE_CAP_PCT, riskCapPct, remainingTotalPct);
  // 已被占住的部分只看真实持仓。盯盘已建层的标的在函数开头就返回了，
  // 走到这里说明盯盘没在管这只，不存在要扣的第二份占仓
  const alreadyHeld = realPct;
  const allowedPct = Math.max(0, target - alreadyHeld);

  const binding: SwingSizingExplain['binding'] =
    allowedPct === 0 && alreadyHeld >= target
      ? 'already_held'
      : target === remainingTotalPct && remainingTotalPct < Math.min(SINGLE_CAP_PCT, riskCapPct)
        ? 'total'
        : riskCapPct < SINGLE_CAP_PCT
          ? 'risk'
          : 'single';

  const r1 = (n: number): number => Math.round(n * 10) / 10;
  return {
    allowedPct: r1(allowedPct),
    singleCapPct: SINGLE_CAP_PCT,
    totalCapPct: TOTAL_UNVERIFIED_CAP_PCT,
    usedPct: r1(usedByOthersPct),
    riskCapPct: r1(riskCapPct),
    realPct: r1(realPct),
    binding,
    note: explain(binding, r1(allowedPct), r1(alreadyHeld), r1(remainingTotalPct), r1(riskCapPct)),
  };
}

/** 把上限来由写成人话，让使用者知道为什么只能买这么多 */
function explain(
  binding: SwingSizingExplain['binding'],
  allowedPct: number,
  alreadyHeld: number,
  remainingTotalPct: number,
  riskCapPct: number,
): string {
  switch (binding) {
    case 'already_held':
      return `已经持有或已建议到 ${alreadyHeld}%，达到上限，不再加`;
    case 'total':
      return `未验证的建议合计上限 ${TOTAL_UNVERIFIED_CAP_PCT}%，还剩 ${remainingTotalPct}%，所以本次只到 ${allowedPct}%`;
    case 'risk':
      return `按「单次最多亏总资产 ${SINGLE_TRADE_RISK_PCT}%」倒推，止损这么远只能买 ${riskCapPct}%`;
    case 'single':
    default:
      return `单个标的最多 ${SINGLE_CAP_PCT}%，本次给 ${allowedPct}%`;
  }
}

/**
 * 把可执行增量拆成两层。
 *
 * 第一层 40%、第二层 60%。第二层**必须由独立的反转确认事实触发**，
 * 不是「又跌了一点就加」——那只是把接飞刀拆成两次。
 * 若确认迟迟不来而价格已经涨走，第二层就此失效，不补齐：
 * 第二层是确认后才承担的额外风险，不是欠着的仓位。
 */
export const LAYER_SPLIT = { layer1: 0.4, layer2: 0.6 } as const;

export function splitLayers(allowedPct: number): { layer1Pct: number; layer2Pct: number } {
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  return {
    layer1Pct: r1(allowedPct * LAYER_SPLIT.layer1),
    layer2Pct: r1(allowedPct * LAYER_SPLIT.layer2),
  };
}

/**
 * 同时最多跟踪几条建议。
 *
 * 放在这里而不是 runner，是为了让它进规则清单参与哈希——
 * 它改变「建哪几只、每只多少仓位」，属于会改变结果的参数。
 *
 * 实测不加上限的后果：一轮扫出 69 条信号、建了 20 条建议、合计 15.6%，
 * 平均每条 0.78%。这种仓位赚 10% 也只贡献 0.078%，摊薄到毫无意义，
 * 还要盯 20 只标的。取 3 能让每条拿到 5% 上下的实际仓位。
 */
export const MAX_CONCURRENT_ADVICES = 3;

/** 供规则存档引用，改动即须升规则版本 */
export const SIZING_PARAMS = {
  singleCapPct: SINGLE_CAP_PCT,
  totalUnverifiedCapPct: TOTAL_UNVERIFIED_CAP_PCT,
  singleTradeRiskPct: SINGLE_TRADE_RISK_PCT,
  layerSplit: LAYER_SPLIT,
  maxConcurrentAdvices: MAX_CONCURRENT_ADVICES,
} as const;
