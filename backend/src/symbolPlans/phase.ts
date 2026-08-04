import type {
  DowStructure,
  KlineBar,
  MaStructure,
  SymbolMarketPhase,
  SymbolPhaseReading,
  SymbolPlanAction,
  VolumePriceReading,
} from '@stock-agent/shared';

// 统一标的阶段状态机（计划 4.6）。
// 本系统已有板块阶段（breadth）与大盘阶段（regime），但两者都只有「准滞回」；
// 标的级阶段是新增能力，这里实现真正的滞回：候选阶段需连续满足 N 根才迁移，
// 或关键结构被一次有效突破/跌破时立即迁移（破位不等待）。

export const PHASE_MODEL_VERSION = 'phase-v1';

export const PHASE_LABEL: Record<SymbolMarketPhase, string> = {
  decline: '下跌防守',
  bottoming: '筑底观察',
  recovery: '右侧修复',
  uptrend: '上升持有',
  acceleration: '加速谨慎',
  distribution: '高位分歧',
  uncertain: '不确定',
};

/**
 * 阶段 → 标的默认动作（不含账户状态）。
 * 与 breadth 的 stageAction 同纪律：只收紧不放大。
 */
export const PHASE_DEFAULT_ACTION: Record<SymbolMarketPhase, SymbolPlanAction> = {
  decline: 'exit',
  bottoming: 'wait',
  recovery: 'probe',
  uptrend: 'hold',
  acceleration: 'hold',
  distribution: 'reduce',
  uncertain: 'wait',
};

/** 迁移所需的连续满足根数。破位类迁移（→decline/distribution）允许一次到位 */
const REQUIRED_BARS: Record<SymbolMarketPhase, number> = {
  decline: 1,
  bottoming: 2,
  recovery: 2,
  uptrend: 2,
  acceleration: 2,
  distribution: 1,
  uncertain: 1,
};

/** 加速判定：收盘距 MA20 的乖离率超过该 ATR 倍数视为过热 */
const ACCELERATION_ATR_MULT = 3;

/** 上一次落库的滞回状态。必须整体持久化，只回传 phase 会让滞回永远停在第 1 根 */
export interface PhaseCarryOver {
  phase: SymbolMarketPhase;
  pendingPhase: SymbolMarketPhase | null;
  pendingBars: number;
  /** 上次累计到哪一根 bar。同一根 bar 内重复生成计划不得重复累计 */
  lastBarTime: string | null;
  /**
   * 该阶段是否只是盘中拿半根 bar 猜出来的暂定值。
   * 暂定值不应获得与确认阶段同等的黏性——否则收盘后第一根 K 推翻不了它，
   * 还要再等一根才纠正，与「收盘后重新确认」的承诺不符。
   */
  tentative?: boolean;
}

export interface PhaseInput {
  bars: KlineBar[];
  /** 最后一根是否已收完。未收完时只更新 intradayAlert，不迁移阶段 */
  completeBar: boolean;
  dow: DowStructure | null;
  volumePrice: VolumePriceReading | null;
  ma: MaStructure | null;
  atr: number | null;
  /** 上一次落库的阶段状态，用于滞回累计。首次生成传 null */
  prev: PhaseCarryOver | null;
}

/**
 * 计算「本 bar 的原始候选阶段」——不含滞回，纯按证据判。
 * 顺序即优先级：破位优先，其次高位分歧，再到趋势与修复。
 */
function rawPhase(input: PhaseInput, evidence: string[]): SymbolMarketPhase {
  const { dow, volumePrice, ma, bars, atr } = input;
  const last = bars[bars.length - 1];
  if (!last || !dow) {
    evidence.push('缺少价格结构证据，进入不确定');
    return 'uncertain';
  }

  const close = last.close;
  const ma20 = ma?.values.find((v) => v.period === 20)?.value ?? null;
  const ma60 = ma?.values.find((v) => v.period === 60)?.value ?? null;
  const belowBoth = ma20 != null && ma60 != null && close < ma20 && close < ma60;
  const aboveBoth = ma20 != null && ma60 != null && close > ma20 && close > ma60;

  // 下跌防守：判据只有道氏的 downtrend（更低高点 + 更低低点）。
  // belowBoth（收在 MA20/MA60 下方）只作追加证据文案，不参与判定——
  // 单看均线位置会把普通回踩也判成下跌防守，那是比结构判据更松的口径。
  if (dow.state === 'downtrend') {
    evidence.push(...dow.rationale);
    if (belowBoth) evidence.push('收盘位于 MA20/MA60 下方');
    return 'decline';
  }

  // 量价形态读结构化标志位，不匹配中文文案——文案一改就会静默失配
  const stalling = volumePrice?.pattern === 'stall_on_volume';
  const heavyDown = volumePrice?.pattern === 'heavy_down';

  // 高位分歧：上升结构中出现放量滞涨或放量下跌
  if (dow.state === 'uptrend' && (stalling || heavyDown)) {
    evidence.push(...dow.rationale, `量价：${volumePrice?.verdict ?? ''}`);
    return 'distribution';
  }
  // 突破待确认过程中出现放量滞涨：突破未获量能支持，按分歧处理
  if (dow.state === 'transition' && dow.transitionKind === 'breakout_pending' && stalling) {
    evidence.push(...dow.rationale, `突破未获量能确认：${volumePrice?.verdict ?? ''}`);
    return 'distribution';
  }

  // 上升持有 / 加速谨慎
  if (dow.state === 'uptrend') {
    evidence.push(...dow.rationale);
    if (ma20 != null && atr && atr > 0 && close - ma20 > ACCELERATION_ATR_MULT * atr) {
      evidence.push(
        `收盘距 MA20 乖离 ${(close - ma20).toFixed(3)} 超过 ${ACCELERATION_ATR_MULT}×ATR(${atr.toFixed(3)})，属加速`,
      );
      return 'acceleration';
    }
    if (aboveBoth) evidence.push('收盘位于 MA20/MA60 上方');
    return 'uptrend';
  }

  // 右侧修复：低点抬高且已站上 MA20
  if (dow.state === 'transition') {
    const higherLow = dow.transitionKind === 'higher_low';
    if (higherLow && ma20 != null && close > ma20) {
      evidence.push(...dow.rationale, '已站上 MA20，属右侧修复');
      return 'recovery';
    }
    if (higherLow) {
      evidence.push(...dow.rationale, '低点抬高但未站上 MA20，仍属筑底观察');
      return 'bottoming';
    }
    evidence.push(...dow.rationale, '突破待回踩确认，先按筑底观察等待');
    return 'bottoming';
  }

  // 震荡：按筑底观察处理（等待，不猜方向）
  evidence.push(...dow.rationale, '高低点无一致方向，按筑底观察等待');
  return 'bottoming';
}

/**
 * 带滞回的阶段判定。
 * - 未收完的 bar 只产出 intradayAlert，阶段沿用上一次结果；
 * - 候选阶段需连续满足 REQUIRED_BARS 根才迁移；
 * - decline / distribution 这类破位迁移 requiredBars=1，不等待。
 */
export function computePhase(input: PhaseInput): SymbolPhaseReading {
  const evidence: string[] = [];
  const candidate = rawPhase(input, evidence);
  const prev = input.prev;
  const barTime = input.bars[input.bars.length - 1]?.time ?? null;

  // 盘中：不改写已确认阶段，只给预警
  if (!input.completeBar) {
    // 无历史阶段可继承时（首次生成且在盘中），必须采纳当根候选作为暂定阶段。
    // 退化成 uncertain 会让盘中生成的计划恒为「不确定 → 等待」，永远给不出可执行动作。
    // lastBarTime 留空：这根未收完的 bar 不计入滞回累计，收盘后会重新走完整判定。
    if (!prev) {
      return {
        phase: candidate,
        pendingPhase: null,
        pendingBars: 0,
        lastBarTime: null,
        tentative: true,
        requiredBars: REQUIRED_BARS[candidate],
        intradayAlert: `盘中暂定为「${PHASE_LABEL[candidate]}」，待日 K 收盘确认`,
        evidence: [...evidence, '首次生成且当前 bar 未收完，阶段为盘中暂定，收盘后重新确认'],
        phaseModelVersion: PHASE_MODEL_VERSION,
      };
    }
    const held = prev.phase;
    const alert =
      candidate !== held
        ? `盘中证据指向「${PHASE_LABEL[candidate]}」，待日 K 收盘确认后才迁移（当前仍为${PHASE_LABEL[held]}）`
        : null;
    const pending = prev.pendingPhase;
    return {
      phase: held,
      pendingPhase: pending,
      pendingBars: prev.pendingBars,
      lastBarTime: prev.lastBarTime,
      // 盘中不会把暂定转成确认，原样带下去，等收盘那根来定论
      tentative: prev.tentative,
      // 分母要跟 pendingPhase 配对，否则前端会显示成两个阶段拼出来的 x/y
      requiredBars: REQUIRED_BARS[pending ?? held],
      intradayAlert: alert,
      evidence: [...evidence, '当前 bar 未收完，阶段不迁移'],
      phaseModelVersion: PHASE_MODEL_VERSION,
    };
  }

  // 首次生成、或上一个阶段只是盘中暂定值：直接采纳当根收盘候选。
  // 暂定值不能享受滞回保护，否则一个半根 bar 的猜测要两根收盘 K 才推得翻。
  if (!prev || prev.tentative) {
    return {
      phase: candidate,
      pendingPhase: null,
      pendingBars: 0,
      lastBarTime: barTime,
      tentative: false,
      requiredBars: REQUIRED_BARS[candidate],
      intradayAlert: null,
      evidence: [
        ...evidence,
        prev ? '上一阶段为盘中暂定，按当根收盘证据重新确认' : '首次生成，直接采纳当根阶段',
      ],
      phaseModelVersion: PHASE_MODEL_VERSION,
    };
  }

  // 候选与当前阶段一致：清空 pending
  if (candidate === prev.phase) {
    return {
      phase: prev.phase,
      pendingPhase: null,
      pendingBars: 0,
      lastBarTime: barTime,
      requiredBars: REQUIRED_BARS[candidate],
      intradayAlert: null,
      evidence: [...evidence, `阶段维持${PHASE_LABEL[prev.phase]}`],
      phaseModelVersion: PHASE_MODEL_VERSION,
    };
  }

  const required = REQUIRED_BARS[candidate];
  // 同一根 bar 内重复生成计划不得重复累计，否则一天就能跨过本应两根 K 线的门槛
  const sameBar = barTime != null && prev.lastBarTime === barTime;
  let streak: number;
  if (prev.pendingPhase !== candidate) {
    // 候选换了：无论是不是同一根 bar，之前那个候选攒的连击都不能借给它
    streak = 1;
  } else if (sameBar) {
    streak = Math.max(1, prev.pendingBars); // 同一根 bar 内重复生成，维持不累加
  } else {
    streak = prev.pendingBars + 1;
  }

  if (streak >= required) {
    // 从上升直接跳到下跌必须记录触发的结构破坏（计划 4.6 明确条款）
    const abrupt =
      (prev.phase === 'uptrend' || prev.phase === 'acceleration') && candidate === 'decline';
    if (abrupt) {
      evidence.push(
        `由${PHASE_LABEL[prev.phase]}直接迁移到下跌防守，触发的结构破坏见上述更低高点/更低低点依据`,
      );
    }
    return {
      phase: candidate,
      pendingPhase: null,
      pendingBars: 0,
      lastBarTime: barTime,
      requiredBars: required,
      intradayAlert: null,
      evidence: [...evidence, `连续 ${streak} 根满足，迁移到${PHASE_LABEL[candidate]}`],
      phaseModelVersion: PHASE_MODEL_VERSION,
    };
  }

  // 滞回未满：阶段不动，记录 pending
  return {
    phase: prev.phase,
    pendingPhase: candidate,
    pendingBars: streak,
    lastBarTime: barTime,
    requiredBars: required,
    intradayAlert: null,
    evidence: [
      ...evidence,
      `候选阶段${PHASE_LABEL[candidate]}已连续 ${streak}/${required} 根，未达迁移门槛，仍维持${PHASE_LABEL[prev.phase]}`,
    ],
    phaseModelVersion: PHASE_MODEL_VERSION,
  };
}

/**
 * 阶段动作经外部闸门收紧（计划 4.6 冲突优先级）。
 * 顺序：执行硬阻断 > 大盘风险档 > 板块阶段 > 标的默认动作。
 * 只允许朝更保守方向降级，绝不放大。
 */
const ACTION_RANK: Record<SymbolPlanAction, number> = {
  exit: 0,
  reduce: 1,
  wait: 2,
  hold: 3,
  probe: 4,
  add: 5,
};

/** 取两个动作中更保守的一个 */
export function tighten(a: SymbolPlanAction, b: SymbolPlanAction): SymbolPlanAction {
  return ACTION_RANK[a] <= ACTION_RANK[b] ? a : b;
}

/** breadth 模块的 BoardStageAction 全集；出现表外值说明上游改了枚举，须收紧而非放行 */
const KNOWN_BOARD_ACTIONS = new Set(['none', 'probe', 'lead', 'hold_only', 'exit_only']);

export interface GateInput {
  phase: SymbolMarketPhase;
  /** 执行硬阻断（停牌、涨跌停不可成交、关键数据错乱）；非空即朝 wait 收紧，但不覆盖更保守的动作 */
  hardBlocks: string[];
  /** 大盘阶段：退潮时收紧 */
  marketRegimePhase: string | null;
  /** 板块阶段动作标签（breadth 的 stageAction） */
  boardStageAction: string | null;
}

/** 标的客观动作（不含账户状态），已过外部闸门 */
export function resolveMarketAction(input: GateInput): { action: SymbolPlanAction; reasons: string[] } {
  const reasons: string[] = [];
  let action = PHASE_DEFAULT_ACTION[input.phase];
  reasons.push(`阶段${PHASE_LABEL[input.phase]}默认动作：${action}`);

  if (input.hardBlocks.length > 0) {
    // 必须走 tighten：wait 比 exit/reduce 激进，直接锁 'wait' 会把「下跌防守+停牌」
    // 的退出指令放大成观望，复牌后该退的仓位就丢了。
    // 也不能在这里 return——跳过下面的退潮与板块闸门同样会放大动作
    // （上升默认 hold + 板块 exit_only 本应收成 exit，多一条停牌反而变 wait）。
    const next = tighten(action, 'wait');
    const blocks = input.hardBlocks.join('、');
    if (next !== action) reasons.push(`执行硬阻断（${blocks}），收紧为${next}`);
    else reasons.push(`执行硬阻断（${blocks}），当前动作${action}已更保守，维持`);
    action = next;
  }

  if (input.marketRegimePhase === '退潮') {
    const next = tighten(action, 'wait');
    if (next !== action) reasons.push('大盘处于退潮档，收紧为等待');
    action = next;
  }

  // 板块阶段只能收紧：exit_only → exit，hold_only → 不得加仓
  if (input.boardStageAction === 'exit_only') {
    const next = tighten(action, 'exit');
    if (next !== action) reasons.push('板块已退幕，收紧为退出');
    action = next;
  } else if (input.boardStageAction === 'hold_only') {
    const next = tighten(action, 'hold');
    if (next !== action) reasons.push('板块分歧，只减不加，收紧为持有');
    action = next;
  } else if (input.boardStageAction === 'none') {
    const next = tighten(action, 'wait');
    if (next !== action) reasons.push('板块未入场景，收紧为等待');
    action = next;
  } else if (input.boardStageAction != null && !KNOWN_BOARD_ACTIONS.has(input.boardStageAction)) {
    // 上游枚举改名时不能静默失去板块闸门：按未知处理并收紧，同时留痕便于排查
    action = tighten(action, 'wait');
    reasons.push(`板块阶段动作「${input.boardStageAction}」未识别，保守收紧为等待`);
  }

  return { action, reasons };
}
