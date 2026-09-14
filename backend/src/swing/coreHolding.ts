import type { KlineBar, SwingGrade, SwingWatchLevel } from '@stock-agent/shared';

// 底仓（中长线赛道轮动）的持有与出场规则。
//
// 为什么不能复用同目录的 advice.ts：
// advice.ts 是**试探仓**的规则——建仓后第 10 个完整交易日没走出预期就撤、
// 涨到 1 倍风险就减一半、分两层建仓。那套东西是用来控制小仓位试错的，
// 它做的两件事恰好是杀死主升浪的标准动作：
//  - 两周内没起色就走：赛道启动前的横盘经常比两周长得多；
//  - 刚赚到 1 倍风险就砍半：主升浪的钱全在那之后的那一段。
// 底仓是八成仓、按月计的持有，套上试探仓的规则等于把最赚钱的一段亲手切掉。
//
// 所以底仓只有三条规则，而且刻意地少：
//  1) 出场：顶部信号走到**二级确认**（价格自己走出转向），或收盘跌破存档的结构线。
//  2) 不做 1R 减半，不做时间退出。走势还在，就一直拿着。
//  3) 加仓只发生在换仓时，不因为价格波动让权重偏离目标就自动补。
//
// 一级顶部信号（力道衰减）在这里**只提示、不减仓**。
// 这是和试探仓最大的区别：力道衰减在一段主升浪里会反复出现，
// 按它减仓会在上涨途中被反复洗下车。试探仓减 40% 是因为它本来就是要快进快出的小仓。
//
// 同一只标的不能同时被这套规则和 advice.ts 管——谁管它由持仓归属决定，
// 两套规则对同一笔头寸给出的动作是冲突的（一个要减半，一个要拿住）。

/** 底仓出场的两类依据 */
export type CoreHoldingAction =
  /** 继续持有，不动 */
  | 'hold'
  /** 顶部二级确认：价格自己走出转向，退出 */
  | 'exit_turn_confirmed'
  /** 收盘跌破存档的结构线，退出 */
  | 'exit_structure_broken';

/**
 * 结构线：现价下方最近的那个摆动低点。
 *
 * 它替代「成本 -X%」那种固定比例止损，理由是固定比例与这只标的的走势结构无关——
 * 赛道 ETF 一波回踩 12% 很常见，那条线只会让人在回踩里被打掉，然后看着它继续涨。
 *
 * 关键约束是**只上移**：走出更高的低点才抬线，绝不因为价格下跌就把线放低。
 * 仓库里已经踩过这个坑——ETF 持仓止损曾引用按现价生成的新交易参考价
 * （`min(下一档买价*0.96, 现价*0.95)`），价格越跌线越低，实际亏损永远追不上它，
 * 于是止损永不触发（见 positions/discipline.ts 的 resolveRule）。
 */
export interface CoreHoldingState {
  /** 存档的结构线价格 */
  structureLine: number;
  /** 这条线取自哪一波的低点，用于页面说明「凭什么是这个价」 */
  structureBasis: string;
  /** 存档日期 YYYY-MM-DD */
  archivedAt: string;
}

export interface CoreHoldingDecision {
  action: CoreHoldingAction;
  /** 动作后的结构线（只上移；退出时原样返回，不清空以便留痕） */
  next: CoreHoldingState;
  /** 人话理由 */
  reason: string;
  /** 下一次会改变动作的条件。继续持有时这一条最重要——它回答「我要盯什么」 */
  nextTrigger: string;
  /** 数据不全导致这一轮没法判断时的说明；正常为 null */
  blockedReason: string | null;
}

/**
 * 从关注价位里挑出结构线：取现价下方**最近**的那个低点。
 *
 * 取最近而不是最低：最低那个往往在几个月前，跌到那里时这波趋势早就结束了，
 * 拿它当线等于没有线。
 *
 * @returns 下方没有任何摆动低点时返回 null（此时给不出结构线，调用方须如实说明）
 */
export function pickStructureLine(
  watchLevels: SwingWatchLevel[],
  close: number,
): SwingWatchLevel | null {
  const below = watchLevels.filter((l) => l.side === 'below' && l.price < close);
  if (below.length === 0) return null;
  return below.reduce((best, cur) => (cur.price > best.price ? cur : best));
}

/**
 * 首次把一只持仓纳入底仓管理时存档结构线。
 *
 * @param watchLevels judgeSwing 产出的关注价位
 * @param close 最新收盘价
 * @param tradeDate 交易日 YYYY-MM-DD
 */
export function archiveCoreHolding(
  watchLevels: SwingWatchLevel[],
  close: number,
  tradeDate: string,
): CoreHoldingState | null {
  const line = pickStructureLine(watchLevels, close);
  if (!line) return null;
  return { structureLine: line.price, structureBasis: line.basis, archivedAt: tradeDate };
}

export interface CoreHoldingInput {
  state: CoreHoldingState;
  /** 今日已收盘的那根（调用方须先经 judge.ts 的 dropUnclosedBar 剔除未收盘那根） */
  bar: KlineBar;
  /** 当前定级 */
  grade: SwingGrade;
  /** 当前关注价位，用于判断结构线能否上移 */
  watchLevels: SwingWatchLevel[];
  /** 交易日 YYYY-MM-DD */
  tradeDate: string;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * 推进一步。纯函数：给它当前状态和新的一根 K 线，算出该做什么。
 *
 * 处置顺序是写死的，顺序本身就是规则的一部分：
 *  1) 数据不全 → 不改状态，如实说这一轮没法检查（绝不假装检查过了）
 *  2) 收盘跌破结构线 → 退出（结构坏了，不管有没有顶部信号）
 *  3) 顶部二级确认 → 退出
 *  4) 都没有 → 继续持有，并尝试上移结构线
 *
 * 跌破排在顶部信号之前：结构破坏是价格已经发生的事实，
 * 而顶部信号是对力道的判断。事实优先于判断。
 */
export function evaluateCoreHolding(input: CoreHoldingInput): CoreHoldingDecision {
  const { state, bar, grade, watchLevels, tradeDate } = input;

  // --- 第 1 步：数据不全就什么都不做 ---
  // 关键是不改状态。这里若假装判断过，页面就会显示「继续持有，没有风险」,
  // 而实际上今天根本没检查——那是最危险的一种误解
  if (!(bar.close > 0) || !(bar.low > 0)) {
    return {
      action: 'hold',
      next: state,
      reason: '今天的行情数据不全',
      nextTrigger: `结构线仍是 ${r3(state.structureLine)}（${state.structureBasis}）`,
      blockedReason: '今天这只没法检查，行情数据不全。上一次存档的结构线继续有效',
    };
  }

  // --- 第 2 步：收盘跌破结构线 ---
  // 用收盘价而不是最低价：盘中插一下又收回来的太多，那不算结构破坏。
  // 这与试探仓刻意相反——试探仓用最低价，因为小仓位宁可被打掉也不留敞口；
  // 底仓用收盘价，因为被一根插针洗出八成仓的代价远大于多拿一天
  if (bar.close < state.structureLine) {
    return {
      action: 'exit_structure_broken',
      next: state,
      reason: `收盘 ${r3(bar.close)} 跌破了 ${r3(state.structureLine)}（${state.structureBasis}），这波的结构坏了`,
      nextTrigger: '退出后重新等下一次底部信号，不在原地接回',
      blockedReason: null,
    };
  }

  // --- 第 3 步：顶部二级确认 ---
  if (grade === 'turn_confirmed_top') {
    return {
      action: 'exit_turn_confirmed',
      next: state,
      reason: '涨势的力道先衰减，之后价格自己走出了转向，这一段结束了',
      nextTrigger: '退出后重新等下一次底部信号',
      blockedReason: null,
    };
  }

  // --- 第 4 步：继续持有，尝试上移结构线 ---
  const candidate = pickStructureLine(watchLevels, bar.close);
  const canRaise = candidate != null && candidate.price > state.structureLine;
  const next: CoreHoldingState = canRaise
    ? {
        structureLine: candidate.price,
        structureBasis: candidate.basis,
        archivedAt: tradeDate,
      }
    : state;

  // 一级顶部信号只提示，不减仓。力道衰减在一段主升浪里会反复出现，
  // 按它减仓会在上涨途中被反复洗下车
  const reason =
    grade === 'risk_easing_top'
      ? '上涨力道在衰减，但价格还没走出转向，底仓继续拿着——力道衰减在一波大涨里会反复出现，按它减仓会被洗下车'
      : canRaise
        ? `走势还在，这波走出了更高的低点，保护价抬到 ${r3(next.structureLine)}`
        : '走势还在，没有该动的理由';

  return {
    action: 'hold',
    next,
    reason,
    nextTrigger:
      `收盘跌破 ${r3(next.structureLine)}（${next.structureBasis}），` +
      '或者涨势力道衰减之后价格自己走出转向——这两件事任一发生就该走',
    blockedReason: null,
  };
}

/**
 * 供规则存档引用，改动即须升规则版本。
 *
 * 这里刻意只有布尔与枚举、没有任何可调的数值阈值：
 * 底仓规则一旦引入「时间退出多少天」「回撤多少减仓」这类数字，
 * 就会有反复调它直到历史好看的冲动，而那个数字对将来没有意义。
 */
export const CORE_HOLDING_PARAMS = {
  /** 出场依据：顶部二级确认 + 收盘跌破结构线，仅此两条 */
  exitOn: ['turn_confirmed_top', 'close_below_structure_line'] as const,
  /** 结构线取现价下方最近的摆动低点 */
  structureLineSource: 'nearest_swing_low_below' as const,
  /** 结构线只上移 */
  structureLineRatchetOnly: true,
  /** 跌破用收盘价判定，不用最低价 */
  breakJudgedByClose: true,
  /** 一级顶部信号不减仓，只提示 */
  reduceOnTier1Top: false,
  /** 不做 1R 减半 */
  reduceAtFirstR: false,
  /** 不做时间退出 */
  timeStopTradeDays: null,
  /** 不因权重偏离目标自动补仓 */
  autoTopUpToTarget: false,
} as const;
