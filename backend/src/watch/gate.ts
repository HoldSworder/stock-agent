import type { WatchSignal, WatchSeverity, WatchSignalType, WatchSource } from '@stock-agent/shared';

// 迟滞 + 最小持续门（对标 Prometheus keep_firing_for / deadband 与告警「最小持续时长」）：
// 对每个 `code:type` 维护一个有状态机，把「持续成立期间每 tick 重复产生的信号」收敛为
// 「首次确认跨入 / severity 升级」两类事件，避免反复唤醒下游 LLM 研判。
// 规则层 rules.ts 保持纯函数零副作用，状态全部收口在本模块。

const SEV_RANK: Record<WatchSeverity, number> = { low: 1, medium: 2, high: 3 };

// 非高危信号需连续成立的最小 tick 数才首次放行（过滤瞬时尖峰/坏价）；high 立即放行。
const MIN_PERSIST_TICKS = 2;

// 最小持续门只对「水平型连续信号」生效——这类信号在条件持续成立期间每 tick 都会复现，
// 用连续 tick 数过滤瞬时尖峰才有意义。其余「边沿型/去重只发一次」信号（如 break_cost 跨越成本、
// new_limit_up 新晋涨停）一旦出现就立即放行，否则会被永久压制（永远凑不满 2 tick）。
const MIN_PERSIST_TYPES = new Set<WatchSignalType>([
  'drawdown_from_high',
  'take_profit',
  'near_limit_up',
  'fast_rise',
  'sector_inflow',
]);

interface GateState {
  phase: 'pending' | 'active';
  /** 连续成立计数（pending 阶段累加） */
  count: number;
  /** 已放行的最高 severity 档（active 阶段仅升级才再放行） */
  sevRank: number;
  /** 信号来源（用于「消失重置」时按本 tick 评估过的来源精确判定） */
  source: WatchSource;
}

const states = new Map<string, GateState>();

function key(s: WatchSignal): string {
  return `${s.code}:${s.type}`;
}

/** 跨交易日 / 引擎重启时清空所有迟滞状态 */
export function resetGate(): void {
  states.clear();
}

/** 迟滞门输出：passed=交 dispatcher 唤醒研判；suppressed=本 tick 评估到但被迟滞静默 */
export interface GateResult {
  passed: WatchSignal[];
  suppressed: WatchSignal[];
}

/**
 * 对本 tick 全部信号做迟滞 + 最小持续过滤，返回应交由 dispatcher 唤醒研判的信号子集。
 * - 首次出现：high 立即放行并置 active；非 high 进入 pending，连续达 MIN_PERSIST_TICKS tick 才放行。
 * - active 期间：仅当 severity 升级才再次放行，否则静默（防重复唤醒）。
 * - 消失重置：本 tick 评估过该来源、但该 `code:type` 未再出现 → 视为回落，清除状态（迟滞）。
 *   分频未评估的来源（如本 tick 未轮询自选/扫描）不重置，避免误清。
 * @param signals 本 tick 产生的全部信号
 * @param evaluatedSources 本 tick 实际评估过的来源集合
 */
export function gateSignals(
  signals: WatchSignal[],
  evaluatedSources: Set<WatchSource>,
): GateResult {
  const seen = new Set<string>();
  const passed: WatchSignal[] = [];
  const suppressed: WatchSignal[] = [];

  for (const s of signals) {
    const k = key(s);
    seen.add(k);
    const rank = SEV_RANK[s.severity];
    const st = states.get(k);

    if (!st) {
      // high 或「非水平型」信号首次出现即放行；仅水平型非高危信号进入最小持续待确认
      if (s.severity === 'high' || !MIN_PERSIST_TYPES.has(s.type)) {
        states.set(k, { phase: 'active', count: 1, sevRank: rank, source: s.source });
        passed.push(s);
      } else {
        states.set(k, { phase: 'pending', count: 1, sevRank: rank, source: s.source });
        suppressed.push(s);
      }
      continue;
    }

    if (st.phase === 'pending') {
      st.count += 1;
      st.sevRank = Math.max(st.sevRank, rank);
      if (s.severity === 'high' || st.count >= MIN_PERSIST_TICKS) {
        st.phase = 'active';
        passed.push(s);
      } else {
        suppressed.push(s);
      }
      continue;
    }

    // active：仅 severity 升级才再放行
    if (rank > st.sevRank) {
      st.sevRank = rank;
      passed.push(s);
    } else {
      suppressed.push(s);
    }
  }

  // 消失重置：仅清理本 tick 评估过、但已不再成立的来源状态
  for (const [k, st] of states) {
    if (seen.has(k)) continue;
    if (evaluatedSources.has(st.source)) states.delete(k);
  }

  return { passed, suppressed };
}
