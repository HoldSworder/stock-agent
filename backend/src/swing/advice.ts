import type {
  KlineBar,
  SwingAdviceEventKind,
  SwingAdviceLayer,
  SwingGrade,
} from '@stock-agent/shared';

// 建议持仓的状态推进：什么时候建、什么时候减、什么时候退。
//
// 这是纯函数：给它当前状态和新的一根 K 线，它算出该做什么动作。
// 不读 DB、不发请求，为的是能把各种时序组合都用自检钉住——
// 状态机的错误往往只在某个特定顺序下暴露，靠跑真实数据碰不到。
//
// 处置顺序是写死的，且顺序本身就是规则的一部分：
//  1) 数据不完整 → 不改状态，如实说无法检查（绝不假装完成了减仓）
//  2) 触发保护线 → 全部退出
//  3) 首次达到 1R → 减一半，并取消尚未建立的第二层
//  4) 第一层建立后第 10 个完整交易日、且从未达到 1R → 按时间退出
//  5) 最后才考虑加第二层
//
// 同一根日 K 同时触及保护线与 1R：无法知道盘中先后，按保护线全退（宁可少赚）。
// 第 10 日恰好首次达到 1R：1R 优先，因为走势已经走出预期，时间退出的前提不再成立。
//
// 只做多：顶部信号只用来减已有持仓，空仓时只提示风险。
// 这套规则不产生任何负持仓——A 股散户账户也做不了。

/** 时间退出：第一层建立后这么多个交易日仍未走出预期，就撤掉试探仓 */
export const TIME_STOP_TRADE_DAYS = 10;

/** 达到 1 倍风险回报时减掉的比例 */
export const FIRST_R_REDUCE_RATIO = 0.5;

/** 顶部一级信号减掉已有持仓的比例；二级则清光 */
export const TOP_TIER1_REDUCE_RATIO = 0.4;

export interface AdviceState {
  /** 已建立的层 */
  layers: SwingAdviceLayer[];
  /** 当前建议目标仓位 % */
  targetPct: number;
  /** 建议成本均价 */
  avgCost: number;
  /** 存档的初始止损，1R 始终按它算，永不修改 */
  initialStop: number;
  /** 当前保护线，只上移不下调 */
  currentStop: number;
  /** 建仓以来最高价 */
  peakPrice: number;
  /** 是否已触发过 1R 减半 */
  firstRHit: boolean;
  /** 第一层建立的交易日 */
  firstLayerTradeDate: string | null;
  /** 建议区间 */
  zone: { low: number; high: number };
  /** 追高线：价格高于此值不再加仓 */
  chaseGuard: number;
}

export interface AdviceAction {
  kind: SwingAdviceEventKind;
  /** 动作后的目标仓位 % */
  pctAfter: number;
  /** 触发价 */
  price: number;
  /** 人话说明 */
  reason: string;
}

export interface AdviceDecision {
  actions: AdviceAction[];
  /** 动作执行后的状态；无动作时原样返回 */
  next: AdviceState;
  /** 数据不完整等原因导致无法检查时的说明；正常时为 null */
  blockedReason: string | null;
}

export interface EvaluateInput {
  state: AdviceState;
  /** 今日已收盘的那根 */
  bar: KlineBar;
  /** 交易日（YYYY-MM-DD） */
  tradeDate: string;
  /** 距第一层建立已过去几个完整交易日 */
  tradeDaysSinceFirstLayer: number;
  /** 当前定级，决定能否加第二层 */
  grade: SwingGrade;
  /** 第二层的建议比例 % */
  layer2Pct: number;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const r1 = (n: number): number => Math.round(n * 10) / 10;

/** 1R = 建议成本到初始止损的距离。始终按初始止损算，不随保护线上移而缩水 */
export function oneRDistance(state: AdviceState): number {
  return state.avgCost - state.initialStop;
}

/** 达到 1R 的价格 */
export function firstRTarget(state: AdviceState): number {
  return r3(state.avgCost + oneRDistance(state));
}

/**
 * 推进一步。
 *
 * @param input 当日读数
 */
export function evaluateAdvice(input: EvaluateInput): AdviceDecision {
  const { state, bar, tradeDate, tradeDaysSinceFirstLayer, grade, layer2Pct } = input;
  const actions: AdviceAction[] = [];
  let next: AdviceState = { ...state, layers: [...state.layers] };

  // --- 第 1 步：数据不完整就什么都不做 ---
  // 关键是**不改状态**。若这里假装执行了减仓，账面仓位会与实际脱节，
  // 之后所有基于它的建议都是错的
  if (!(bar.close > 0) || !(bar.low > 0) || !(bar.high > 0)) {
    return { actions: [], next, blockedReason: '今天的行情数据不全，这一只暂时无法检查' };
  }
  if (!(state.avgCost > 0) || !(state.initialStop > 0)) {
    return { actions: [], next, blockedReason: '建议成本或止损缺失，无法判断该不该减仓' };
  }

  const held = state.targetPct > 0;

  // --- 第 2 步：保护线触发 → 全退 ---
  // 用当日最低价判断：盘中跌破就算跌破，只看收盘会漏掉插针打掉止损的情形
  const stopHit = held && bar.low <= state.currentStop;
  // --- 第 3 步：首次达到 1R ---
  const rTarget = firstRTarget(state);
  const rHit = held && !state.firstRHit && bar.high >= rTarget;

  if (stopHit) {
    // 同一根同时触及保护线与 1R：盘中先后不可知，按保护线处理。
    // 这是刻意选的保守方向——把「其实先到了 1R」误判成止损只是少赚，
    // 反过来把「其实先破了止损」误判成止盈会让亏损敞口继续留着
    const note = rHit
      ? `跌到保护线 ${r3(state.currentStop)}（当天也摸到过 ${rTarget}，但盘中先后无法确定，按保护线处理）`
      : `跌到保护线 ${r3(state.currentStop)}`;
    actions.push({
      kind: 'exit_stop',
      pctAfter: 0,
      price: r3(state.currentStop),
      reason: `${note}，全部退出`,
    });
    next = { ...next, targetPct: 0, layers: [] };
    return { actions, next, blockedReason: null };
  }

  if (rHit) {
    const after = r1(state.targetPct * (1 - FIRST_R_REDUCE_RATIO));
    actions.push({
      kind: 'reduce_half',
      pctAfter: after,
      price: rTarget,
      reason: `涨到 ${rTarget}，赚到的钱等于当初打算亏的钱，先减一半锁住`,
    });
    next = { ...next, targetPct: after, firstRHit: true };
    // 达到 1R 后取消尚未建立的第二层：这笔已经证明自己了，
    // 但加仓的时机已过——再加就是在高位补仓，与「确认后才承担额外风险」相悖
    if (!state.layers.some((l) => l.layer === 2)) {
      actions.push({
        kind: 'cancel_layer2',
        pctAfter: after,
        price: r3(bar.close),
        reason: '已经减过一半，第二层不再建立',
      });
    }
  }

  // --- 第 4 步：时间退出 ---
  // 只在从未达到 1R 时生效。第 10 日恰好首次达到 1R 的话，上面已经处理过，
  // firstRHit 已置真，此处不再触发——走势已经走出预期，时间退出的前提不成立
  const timeUp =
    next.targetPct > 0 &&
    !next.firstRHit &&
    state.firstLayerTradeDate != null &&
    tradeDaysSinceFirstLayer >= TIME_STOP_TRADE_DAYS;
  if (timeUp) {
    actions.push({
      kind: 'exit_time',
      pctAfter: 0,
      price: r3(bar.close),
      reason: `建仓已过 ${tradeDaysSinceFirstLayer} 个交易日仍没走出预期，撤掉这笔试探`,
    });
    next = { ...next, targetPct: 0, layers: [] };
    return { actions, next, blockedReason: null };
  }

  // --- 第 5 步：最后才考虑加第二层 ---
  const canAddLayer2 =
    next.targetPct > 0 &&
    !next.firstRHit &&
    !next.layers.some((l) => l.layer === 2) &&
    layer2Pct > 0 &&
    (grade === 'turn_confirmed_bottom' || grade === 'turn_confirmed_top');
  if (canAddLayer2) {
    if (bar.close > state.chaseGuard) {
      // 不追高：价格已经离区间太远，这时候加仓等于用最差的价格承担额外风险
      actions.push({
        kind: 'cancel_layer2',
        pctAfter: r1(next.targetPct),
        price: r3(bar.close),
        reason: `价格已涨过 ${r3(state.chaseGuard)}，不再追，第二层作废`,
      });
    } else {
      const after = r1(next.targetPct + layer2Pct);
      actions.push({
        kind: 'open_layer2',
        pctAfter: after,
        price: r3(bar.close),
        reason: `走势确认转向，加第二层到 ${after}%`,
      });
      next = {
        ...next,
        targetPct: after,
        layers: [
          ...next.layers,
          { layer: 2, pct: r1(layer2Pct), price: r3(bar.close), at: tradeDate },
        ],
      };
      // 加仓后重算成本均价，1R 目标随之变化（但初始止损不动）
      const total = next.layers.reduce((s, l) => s + l.pct, 0);
      if (total > 0) {
        next.avgCost = r3(
          next.layers.reduce((s, l) => s + l.price * l.pct, 0) / total,
        );
      }
    }
  }

  // 保护线上移与最高价更新。止损只能上移，绝不下调——
  // 下调等于在亏损时放宽容忍度，那是把小亏拖成大亏的标准路径
  if (next.targetPct > 0) {
    next.peakPrice = Math.max(next.peakPrice, bar.high);
    next.currentStop = Math.max(next.currentStop, state.currentStop);
  }

  return { actions, next, blockedReason: null };
}

/**
 * 顶部信号该怎么处理。只做多，所以顶部只用来减已有持仓。
 *
 * @param realPct 该标的真实持仓占总资产 %
 * @param grade 顶部定级
 */
export function topSignalAction(
  realPct: number,
  grade: SwingGrade,
): { reducePct: number; note: string } {
  if (!(realPct > 0)) {
    return {
      reducePct: 0,
      // 空仓时只提示，不生成任何动作。这里绝不能给「做空」之类的建议
      note: '你目前没有这只，只作风险提示，不用操作',
    };
  }
  if (grade === 'turn_confirmed_top') {
    return { reducePct: r1(realPct), note: '走势已确认转向，建议清掉这只' };
  }
  if (grade === 'risk_easing_top') {
    return {
      reducePct: r1(realPct * TOP_TIER1_REDUCE_RATIO),
      note: `上涨力道在衰减，建议先减 ${Math.round(TOP_TIER1_REDUCE_RATIO * 100)}%`,
    };
  }
  return { reducePct: 0, note: '当前没有顶部信号' };
}

/** 供规则存档引用，改动即须升规则版本 */
export const ADVICE_PARAMS = {
  timeStopTradeDays: TIME_STOP_TRADE_DAYS,
  firstRReduceRatio: FIRST_R_REDUCE_RATIO,
  topTier1ReduceRatio: TOP_TIER1_REDUCE_RATIO,
} as const;
