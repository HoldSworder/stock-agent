import { createHash } from 'node:crypto';
import type {
  KlineBar,
  KlinePeriod,
  PlanCondition,
  PlanConditionState,
  SymbolPlanEvaluation,
  SymbolPlanEvent,
  SymbolTradePlan,
} from '@stock-agent/shared';
import { cadenceOf, semanticsOf } from '@stock-agent/shared';
import { getKline } from '../market/eastmoney';
import { buildSeries, evalRule, type Series } from '../playbook/rules';
import * as repo from './repo';
import { invalidatePlanMarks } from './markSync';
import { isBarUnclosed } from './sessionClock';
import { sqlite } from '../db/client';
import { nowIso } from '../util';

// 条件求值（计划 Phase 5 的 R19 分频要求）。
// 纪律：
// - 纯价格条件（priceLevel 的 crossUp/crossDown/touch）可按 tick 做 O(1) 比较，不调 buildSeries；
// - 技术条件（均线/MACD/量价/收盘位置等）只在新的完整 bar 收出时求值一次；
// - bar 级去重键 code+period+barTime+planVersion，引擎重启首轮只预热已收 bar 不回放旧触发；
// - 指标序列按 code+period+lastBarTime 缓存，同一新 bar 只构建一次，多个计划复用。

// cadenceOf 已下沉到 shared（前端要按同一判据逐条件显示触发口径），此处仅转出
export { cadenceOf };

// ===== 指标序列缓存 =====

interface CacheEntry {
  series: Series;
  lastBarTime: string;
  builtAt: number;
}

/** key = code|period|lastBarTime */
const SERIES_CACHE = new Map<string, CacheEntry>();
const SERIES_TTL_MS = 6 * 60 * 60 * 1000;
const SERIES_MAX = 200;

/**
 * 序列缓存键必须含规则指纹：buildSeries 只预计算规则用到的指标，
 * 若两份计划规则不同却共享缓存，后者会拿到缺指标的序列，evalRule 静默判 false（永不触发）。
 */
function rulesFingerprint(conditions: PlanCondition[]): string {
  const parts = conditions
    .map((c) => JSON.stringify(c.rule))
    .sort()
    .join('|');
  return createHash('sha1').update(parts).digest('hex').slice(0, 10);
}

/**
 * 键必须含 bars.length：调用方用 `bars.length - 1` 索引缓存里的序列，
 * 而「最后一根未收完就切掉」会造出「同一个 lastBarTime、两种数组长度」的场景，
 * 只按 lastBarTime 命中会让整条规则算在前一根 bar 上。
 */
function cacheKey(
  code: string,
  period: KlinePeriod,
  lastBarTime: string,
  barCount: number,
  fp: string,
): string {
  return `${code}|${period}|${lastBarTime}|${barCount}|${fp}`;
}

function pruneSeriesCache(): void {
  const now = Date.now();
  for (const [k, v] of SERIES_CACHE) if (now - v.builtAt > SERIES_TTL_MS) SERIES_CACHE.delete(k);
  while (SERIES_CACHE.size > SERIES_MAX) {
    const oldest = SERIES_CACHE.keys().next().value;
    if (oldest == null) break;
    SERIES_CACHE.delete(oldest);
  }
}

/** 供自检与监控：本进程构建过多少次序列（用于断言 buildSeries 与新 bar 数同阶） */
export const seriesBuildCounter = { count: 0 };

/**
 * 取指标序列。同一 (code, period, 最后一根 bar 时间) 只构建一次，多个活跃计划复用。
 * 换日/数据回补会让 lastBarTime 变化，自然产生新 key，无需手工失效。
 */
export function getSeries(
  code: string,
  period: KlinePeriod,
  bars: KlineBar[],
  conditions: PlanCondition[],
): Series {
  const lastBarTime = bars[bars.length - 1]?.time ?? '';
  const key = cacheKey(code, period, lastBarTime, bars.length, rulesFingerprint(conditions));
  const hit = SERIES_CACHE.get(key);
  // 必须在命中处判过期：TTL 只在 miss 时的 pruneSeriesCache 里生效的话，
  // 隔夜/跨周末的旧条目照样会被命中返回
  if (hit && Date.now() - hit.builtAt <= SERIES_TTL_MS) return hit.series;
  const groups = [{ mode: 'all' as const, rules: conditions.map((c) => c.rule) }];
  const series = buildSeries(code, bars, groups);
  seriesBuildCounter.count += 1;
  pruneSeriesCache();
  SERIES_CACHE.set(key, { series, lastBarTime, builtAt: Date.now() });
  return series;
}

// ===== bar 级去重 =====

/**
 * 已求值过的 (bar, 条件)：值为写入时间，用于按 TTL 回收。
 * 键必须含 conditionId——否则同一根 bar 上只有第一个条件能报 justHit，
 * 排在后面的失效条件永远拿不到「刚命中」，事件流会整体丢失。
 */
const SEEN_BARS = new Map<string, number>();
/** 去重键保留 3 天：跨周末足够，再久没有意义，避免长期运行时无界增长 */
const SEEN_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** 引擎是否已预热。未预热时首轮只登记不触发，避免重启回放旧信号 */
let primed = false;
/**
 * 已预热过的 `planId|version|period`，供定时入口只给未预热的补预热。
 *
 * 粒度必须到周期。按计划整体记的话，某个周期取数失败也会把整份计划标成已预热，
 * 该周期下一轮就会把计划生成前就已收出的那根 bar 报成「刚命中」，回放旧信号。
 */
const PRIMED_PLANS = new Set<string>();

function primedKey(plan: SymbolTradePlan, period: KlinePeriod): string {
  return `${plan.id}|${plan.version}|${period}`;
}

/**
 * 键必须含 planId。只用 (code, period, barTime, version, conditionId) 的话，
 * 同标的的新旧计划恰好版本号相同、条件 id 又都来自同一份候选目录时会撞键，
 * 先求值的那份把后一份的 justHit 吞掉；接上持久锁存后会退化成永久漏锁存。
 */
export function seenKey(
  planId: string,
  code: string,
  period: KlinePeriod,
  barTime: string,
  planVersion: number,
  conditionId: string,
): string {
  return `${planId}|${code}|${period}|${barTime}|${planVersion}|${conditionId}`;
}

/** 去重键上限。到顶后按插入序淘汰最旧的，避免 TTL 内条目全部有效时删不掉、每次提交都全表扫描 */
const SEEN_MAX = 5000;

function pruneSeenBars(now: number): void {
  if (SEEN_BARS.size < SEEN_MAX) return;
  for (const [k, at] of SEEN_BARS) if (now - at > SEEN_TTL_MS) SEEN_BARS.delete(k);
  while (SEEN_BARS.size > SEEN_MAX) {
    const oldest = SEEN_BARS.keys().next().value;
    if (oldest == null) break;
    SEEN_BARS.delete(oldest);
  }
}

/** 引擎启动时调用：登记当前已收 bar，之后才开始真正触发 */
export function primeEvaluator(plans: SymbolTradePlan[], barTimeOf: (code: string, period: KlinePeriod) => string | null): void {
  const now = Date.now();
  for (const p of plans) {
    for (const cond of allConditions(p)) {
      const t = barTimeOf(p.code, cond.timeframe);
      if (t) SEEN_BARS.set(seenKey(p.id, p.code, cond.timeframe, t, p.version, cond.id), now);
    }
  }
  primed = true;
}

export function isPrimed(): boolean {
  return primed;
}

/** 仅供自检：重置去重与预热状态 */
export function resetEvaluatorState(): void {
  SEEN_BARS.clear();
  SERIES_CACHE.clear();
  PRIMED_PLANS.clear();
  seriesBuildCounter.count = 0;
  primed = false;
}

function allConditions(plan: SymbolTradePlan): PlanCondition[] {
  return plan.scenarios.flatMap((s) => [...s.conditions, ...s.invalidConditions]);
}

/** 状态 → 生命周期事件 kind */
const EVENT_KIND_BY_STATUS: Partial<Record<SymbolTradePlan['status'], SymbolPlanEvent['kind']>> = {
  invalid: 'invalidated',
  expired: 'expired',
  triggered: 'triggered',
};

/**
 * 待提交的去重键，applyEvaluation 提交成功后才真正写入 SEEN_BARS。
 * 必须挂在「这一次求值结果」上而不是按 planId 索引：按 plan 索引的话，
 * 一次事务失败留下的待提交键会被后续任意一次求值（包括只读复核）顺手提交，
 * 那次从未落库的 condition_hit 就被永久标记已见——正是本机制要防的。
 * 用 WeakMap 还能让「求值了但没 apply」的条目随结果对象一起回收，不会泄漏。
 */
const PENDING_SEEN = new WeakMap<SymbolPlanEvaluation, string[]>();

/**
 * 本轮首次命中、待落库的事件类条件锁存。与 PENDING_SEEN 同理挂在求值结果上，
 * 由 applyEvaluation 在事务内消费——只读复核不产 justHit，自然也不会锁存。
 */
const PENDING_LATCH = new WeakMap<SymbolPlanEvaluation, Array<{ conditionId: string; barTime: string | null }>>();

/**
 * 终态：进入后不再因后续求值而回退。
 * 失效条件多是状态类（如收盘跌破 MA20），价格回升后它会重新变 false；
 * 若此时触发条件恰好成立，一份已判失效的计划就会被「复活」成 triggered。
 */
const TERMINAL_STATUSES: ReadonlySet<SymbolTradePlan['status']> = new Set([
  'invalid',
  'expired',
  'superseded',
]);

/** 状态与文案判定。拆成函数避免多层嵌套三元，也让「失效优先于触发」这条优先级只写一处 */
function resolveOutcome(input: {
  invalidated: boolean;
  expired: boolean;
  triggered: boolean;
  current: SymbolTradePlan['status'];
}): { status: SymbolTradePlan['status']; summary: string } {
  if (TERMINAL_STATUSES.has(input.current)) {
    return { status: input.current, summary: '计划已是终态，不再因后续行情改变状态' };
  }
  if (input.invalidated) return { status: 'invalid', summary: '失效条件已命中，计划进入防守' };
  if (input.expired) return { status: 'expired', summary: '计划已过有效期，需重新评估' };
  if (input.triggered) return { status: 'triggered', summary: '触发条件已全部满足' };
  return { status: input.current, summary: '条件尚未满足，继续等待' };
}

// ===== 求值 =====

/** tick 级「触及」判定的相对容差（0.1%）：无前一笔价时只能按接近程度判 */
const TOUCH_TOLERANCE = 0.001;

export interface TickInput {
  /** 最新价，用于 tick 级价格条件 */
  price: number;
  /** 上一笔价格，用于判断穿越方向 */
  prevPrice: number | null;
}

/** tick 级价格条件：O(1) 比较，不碰 buildSeries */
export function evalTickCondition(cond: PlanCondition, tick: TickInput): boolean {
  if (cond.rule.kind !== 'priceLevel') return false;
  const { level, relation } = cond.rule;
  if (!(level > 0)) return false;
  if (relation === 'touch') {
    // 单点 tick 无高低区间，用「跨越或等于」近似触及；无前值时退化为按容差比价
    return tick.prevPrice == null
      ? Math.abs(tick.price - level) / level < TOUCH_TOLERANCE
      : (tick.prevPrice - level) * (tick.price - level) <= 0;
  }
  if (tick.prevPrice == null) return false;
  if (relation === 'crossUp') return tick.prevPrice <= level && tick.price > level;
  if (relation === 'crossDown') return tick.prevPrice >= level && tick.price < level;
  return false;
}

export interface EvaluateInput {
  plan: SymbolTradePlan;
  /** 按周期提供的 K 线；缺哪个周期该周期条件按未满足处理并写说明 */
  barsByPeriod: Map<KlinePeriod, KlineBar[]>;
  tick?: TickInput;
  /** 计划生效以来的完整 bar 数，供 barsSincePlan 求值 */
  planBars?: number;
  /**
   * 只读求值：跳过 bar 级去重判定，也不写去重键、不产生 justHit。
   * 供手动复核用——否则每次点「复核条件」都会往事件表重复写 condition_hit。
   */
  force?: boolean;
  /**
   * 全局覆盖「最后一根 bar 是否已收完」。不传时**按每个条件自己的 timeframe** 判，
   * 这才是对的：周线在周中恒未收完，日线在 15:00 后已收完，两者同时存在于一份计划里。
   * 早先这里是一个跨周期取「或」的布尔量，一根未收完的周 K 会连带把日线最后一根也切掉。
   * 仅自检需要固定行为时才显式传。
   */
  lastBarClosed?: boolean;
  /** 当前时刻，仅供自检固定收完判定；生产不传 */
  now?: Date;
}

/**
 * 求值一份计划的全部条件。
 * bar 级条件遇到已求值过的 bar 直接沿用「未刚触发」，避免 10 秒轮询里重复算。
 */
export function evaluatePlan(input: EvaluateInput): SymbolPlanEvaluation {
  const { plan } = input;
  const states: PlanConditionState[] = [];
  const at = nowIso();
  // 去重键先攒着，等 applyEvaluation 的事务提交成功再落。
  // 若在求值阶段就写入，事务回滚后事件没落库但内存已标记已见，该触发信号会被永久吞掉。
  const pendingSeen: string[] = [];
  const pendingLatch: Array<{ conditionId: string; barTime: string | null }> = [];

  // 事件类条件的已锁存集合。事件只在发生的那一根为真，不锁存的话
  // 「周线金叉 + 日线站上压力位」这种组合只要不落在同一根 bar 上就永远凑不齐。
  const latched = repo.listLatchedConditionIds(plan.id);

  // 按「情景:条件」索引，供后面精确定位状态
  const byScenario = new Map<string, PlanConditionState>();

  for (const scenario of plan.scenarios) {
    const push = (st: PlanConditionState): void => {
      states.push(st);
      byScenario.set(`${scenario.id}:${st.conditionId}`, st);
    };
    const mark = (cond: PlanCondition, isInvalid: boolean): void => {
      const cadence = cadenceOf(cond);
      const isEvent = semanticsOf(cond.rule) === 'event';
      const wasLatched = isEvent && latched.has(cond.id);
      if (cadence === 'tick') {
        const ok = input.tick ? evalTickCondition(cond, input.tick) : false;
        const fresh = ok && !wasLatched && !input.force;
        if (fresh) pendingLatch.push({ conditionId: cond.id, barTime: null });
        push({
          conditionId: cond.id,
          // tick 条件全是事件类（穿越/触及），命中后必须沿用锁存值，
          // 否则下一笔行情一到就退回未满足，多条件情景永远凑不齐
          satisfied: ok || wasLatched,
          justHit: fresh,
          cadence,
          detail: wasLatched && !ok
            ? `${isInvalid ? '失效' : '触发'}条件（tick，已锁存）：${cond.description}`
            : `${isInvalid ? '失效' : '触发'}条件（tick）：${cond.description}`,
          evaluatedAt: at,
        });
        return;
      }
      const allBars = input.barsByPeriod.get(cond.timeframe);
      // 未收完的最后一根不参与 bar 级判定：用半根 bar 求值后还会把该 barTime 标记为已见，
      // 等它真收盘、指标值已变时就再也报不出触发了。
      // 切片条件不能再附加 length > 1：只有一根时那根同样是未收完的，
      // 留着它就退回「用半根 bar 求值并标记已见」的老问题。切完为空按数据不足处理。
      const unclosed =
        input.lastBarClosed === undefined
          ? isBarUnclosed(cond.timeframe, allBars?.[allBars.length - 1]?.time, input.now)
          : !input.lastBarClosed;
      const bars = unclosed && allBars ? allBars.slice(0, -1) : allBars;
      if (!bars || bars.length === 0) {
        push({
          conditionId: cond.id,
          // 已锁存的事件不因本轮取不到 K 线而回退
          satisfied: wasLatched,
          justHit: false,
          cadence,
          detail: allBars?.length
            ? `${cond.timeframe} 仅有未收完的当根 K 线，条件按未满足处理`
            : `${cond.timeframe} K 线缺失，条件按未满足处理`,
          evaluatedAt: at,
        });
        return;
      }
      const barTime = bars[bars.length - 1].time;
      const key = seenKey(plan.id, plan.code, cond.timeframe, barTime, plan.version, cond.id);
      const alreadySeen = SEEN_BARS.has(key);
      const series = getSeries(plan.code, cond.timeframe, bars, allConditions(plan));
      const i = bars.length - 1;
      const ok = evalRule(cond.rule, series, i, {
        entryPrice: 0,
        heldBars: 0,
        planBars: input.planBars,
      });
      if (!input.force) pendingSeen.push(key);
      // 未预热的首轮不锁存：那根 bar 是计划生成前就已收出的，锁了等于把旧信号当成命中
      const fresh = ok && !alreadySeen && primed && !input.force;
      if (fresh && isEvent && !wasLatched) pendingLatch.push({ conditionId: cond.id, barTime });
      push({
        conditionId: cond.id,
        satisfied: ok || wasLatched,
        // 同一根 bar 内不重复报「刚触发」；未预热的首轮与只读复核都不报；已锁存的事件不再重复报
        justHit: fresh && !wasLatched,
        cadence,
        detail: wasLatched && !ok
          ? `${isInvalid ? '失效' : '触发'}条件（${cond.timeframe}，已锁存）：${cond.description}`
          : `${isInvalid ? '失效' : '触发'}条件（${cond.timeframe} bar ${barTime}）：${cond.description}`,
        evaluatedAt: at,
      });
    };
    for (const c of scenario.conditions) mark(c, false);
    for (const c of scenario.invalidConditions) mark(c, true);
  }

  // 条件 id 可能被多个情景引用，按「情景+条件」定位，避免 find 只取到首条
  const stateOf = (scenarioId: string, id: string): PlanConditionState | undefined =>
    byScenario.get(`${scenarioId}:${id}`);

  // 任一情景的必选触发条件全满足 → 触发；任一失效条件满足 → 失效
  let triggered = false;
  let invalidated = false;
  for (const sc of plan.scenarios) {
    // 必须对过滤后的数组判空：若某情景条件全是 required=false，
    // every 对空数组恒真会直接误报触发
    const required = sc.conditions.filter((c) => c.required);
    if (required.length > 0 && required.every((c) => stateOf(sc.id, c.id)?.satisfied)) {
      triggered = true;
    }
    if (sc.invalidConditions.some((c) => stateOf(sc.id, c.id)?.satisfied)) invalidated = true;
  }

  const expired = plan.expiresAt != null && plan.expiresAt < at;
  const { status: nextStatus, summary } = resolveOutcome({
    invalidated,
    expired,
    triggered,
    current: plan.status,
  });

  const result: SymbolPlanEvaluation = {
    planId: plan.id,
    planVersion: plan.version,
    status: nextStatus,
    conditions: states,
    triggered,
    invalidated,
    expired,
    // 失效或过期后需要新版本；仅触发不需要
    needsNewVersion: invalidated || expired,
    summary,
    evaluatedAt: at,
  };
  if (pendingSeen.length > 0) PENDING_SEEN.set(result, pendingSeen);
  if (pendingLatch.length > 0) PENDING_LATCH.set(result, pendingLatch);
  return result;
}

/**
 * 求值并落库状态变化（事务）。只更新状态与事件，不改价格、不自动生成新版本。
 * 返回是否发生了状态迁移。
 */
export function applyEvaluation(plan: SymbolTradePlan, ev: SymbolPlanEvaluation): boolean {
  /** 事务成功后才标记「这些 bar 已求值过」，回滚时保留未标记状态以便下轮重试 */
  const commitSeen = (): void => {
    const keys = PENDING_SEEN.get(ev);
    if (!keys) return;
    const now = Date.now();
    for (const k of keys) SEEN_BARS.set(k, now);
    pruneSeenBars(now);
    PENDING_SEEN.delete(ev);
  };

  if (ev.status === plan.status && !ev.conditions.some((c) => c.justHit)) {
    commitSeen();
    PENDING_LATCH.delete(ev);
    return false;
  }
  const latchByCondition = new Map(
    (PENDING_LATCH.get(ev) ?? []).map((l) => [l.conditionId, l.barTime]),
  );
  const tx = sqlite.transaction(() => {
    for (const c of ev.conditions.filter((x) => x.justHit)) {
      // 事件类条件：锁存与事件写入必须同一事务且由唯一约束定胜负。
      // 插入失败说明另一个求值已抢先锁存，这条 condition_hit 就是重复的，不写。
      if (latchByCondition.has(c.conditionId)) {
        const won = repo.tryLatchCondition({
          planId: plan.id,
          conditionId: c.conditionId,
          barTime: latchByCondition.get(c.conditionId) ?? null,
        });
        if (!won) continue;
      }
      repo.appendEvent({
        planId: plan.id,
        planVersion: plan.version,
        kind: 'condition_hit',
        conditionId: c.conditionId,
        note: c.detail,
      });
    }
    if (ev.status !== plan.status) {
      repo.updateStatus(plan.id, ev.status);
      const kind = EVENT_KIND_BY_STATUS[ev.status] ?? 'activated';
      repo.appendEvent({
        planId: plan.id,
        planVersion: plan.version,
        kind,
        note: ev.summary,
      });
      // 失效时图上线变灰保留，不删除
      if (ev.status === 'invalid') invalidatePlanMarks(plan.id, plan.version);
    }
  });
  tx();
  commitSeen();
  PENDING_LATCH.delete(ev);
  return true;
}

/**
 * 把盘中 tick 命中回写进计划：锁存 + 写 condition_hit 事件。返回是否真的写入。
 *
 * 只写命中痕迹，**不改计划状态**。状态迁移仍归 bar 级求值：那里才有完整的多周期
 * K 线，能判全部条件；tick 这里只看得见价格穿越，据此翻状态会把「一条 tick 条件满足」
 * 误当成「整个情景成立」。锁存之后，下一轮 bar 级求值会把这条算作已满足并顺势迁移状态，
 * 盘中最多滞后一个 30 分钟档，而高危的失效命中在告警侧是实时的。
 *
 * 锁存同时解决了「穿了又跌回去」：crossUp 是事件语义，盘中确实发生过就该一直算数，
 * 而收盘那根 bar 看不出日内曾经上穿。
 *
 * 去重直接靠 (planId, conditionId) 唯一索引，不另建队列与内存去重表——
 * 轮询每 10 秒一轮，同一条件会反复命中，靠 INSERT OR IGNORE 的返回值定胜负是原子的。
 *
 * ponytail: 同步写 sqlite，不排队。命中稀疏（每条件每计划最多一次），better-sqlite3
 * 单次写在微秒级，异步队列的复杂度换不来什么。天花板是同一轮里几十只标的同时命中会
 * 串行写几十次；真到那量级再把它改成批量事务。
 */
export function recordTickHit(input: {
  planId: string;
  planVersion: number;
  conditionId: string;
  note: string;
}): boolean {
  // 与 applyEvaluation 同样的纪律：锁存与事件写入必须同一事务，
  // 否则锁存成功后进程挂掉会留下一条「已锁存但事件流里查不到」的幽灵命中
  return sqlite.transaction(() => {
    const won = repo.tryLatchCondition({
      planId: input.planId,
      conditionId: input.conditionId,
      barTime: null,
    });
    if (!won) return false;
    repo.appendEvent({
      planId: input.planId,
      planVersion: input.planVersion,
      kind: 'condition_hit',
      conditionId: input.conditionId,
      note: input.note,
    });
    return true;
  })();
}

/** 日 K 的实际收盘时刻（上海 15:00）。分钟级 bar 也按其所在日的收盘算 */
function barCloseMs(barTime: string): number {
  return Date.parse(`${barTime.slice(0, 10)}T15:00:00+08:00`);
}

/**
 * 计划生效以来走过的完整日线根数，供 barsSincePlan（时间止损/有效期）求值。
 *
 * 口径固定为**日线**：条件自身的 timeframe 各不相同，用它计数会让同一份计划里
 * 「周线满 10 根」和「日线满 10 根」指的是两个量级的时间。
 *
 * 必须按 bar 的**实际收盘时刻**比而不是只比日期：15:00 之后生成的计划，
 * 当天那根在生成前就已收完，按日期比会把它算成「生效后走过的第 1 根」，
 * 时间止损凭空提前一天。同理未收完的当根不计入。
 */
export function countPlanBars(validFrom: string, dayBars: KlineBar[], now: Date = new Date()): number {
  const from = Date.parse(validFrom);
  if (!Number.isFinite(from)) return 0;
  const usable = isBarUnclosed('day', dayBars[dayBars.length - 1]?.time, now)
    ? dayBars.slice(0, -1)
    : dayBars;
  return usable.filter((b) => barCloseMs(b.time) > from).length;
}

/** 取计划涉及的全部周期，供调用方按需取 K 线 */
export function periodsOf(plan: SymbolTradePlan): KlinePeriod[] {
  return Array.from(new Set(allConditions(plan).map((c) => c.timeframe)));
}

/** 按周期取 K 线。默认走东财；自检注入 fixture 以便驱动真实调用链而不联网 */
export type BarLoader = (code: string, period: KlinePeriod) => Promise<KlineBar[]>;

const defaultBarLoader: BarLoader = (code, period) =>
  getKline(code, period, period === 'day' ? 120 : 320);

/**
 * 便捷入口：自行按需取 K 线后求值。
 * `readOnly=true` 供 HTTP 手动复核（不写去重键、不产 justHit，避免每次点复核都重复写事件）；
 * 定时任务必须传 false，否则永远产不出 condition_hit。
 */
export async function evaluatePlanById(
  planId: string,
  opts: { readOnly?: boolean; loadBars?: BarLoader } = {},
): Promise<SymbolPlanEvaluation | null> {
  const plan = repo.getPlan(planId);
  if (!plan) return null;
  const load = opts.loadBars ?? defaultBarLoader;
  const map = new Map<KlinePeriod, KlineBar[]>();
  const failed: KlinePeriod[] = [];
  await Promise.all(
    periodsOf(plan).map(async (p) => {
      const bars = await load(plan.code, p).catch((e: unknown) => {
        // 取数失败与「确实没触发」必须可区分，否则排查时看不出是哪种
        failed.push(p);
        console.warn(
          `[symbolPlans] ${plan.code} ${p} K线取数失败，该周期条件按未满足处理:`,
          e instanceof Error ? e.message : e,
        );
        return [] as KlineBar[];
      });
      if (bars.length > 0) map.set(p, bars);
    }),
  );
  const dayBars = map.get('day');
  const ev = evaluatePlan({
    plan,
    barsByPeriod: map,
    // 不接这个的话 barsSincePlan 恒判 false，时间止损与有效期条件全是摆设
    planBars: dayBars ? countPlanBars(plan.validFrom, dayBars) : undefined,
    force: opts.readOnly === true,
    // 不传 lastBarClosed：由 evaluatePlan 按每个条件自己的 timeframe 判收完
  });
  if (failed.length > 0) {
    ev.summary = `${ev.summary}（${failed.join('/')} 取数失败，相关条件按未满足处理）`;
  }
  applyEvaluation(plan, ev);
  return ev;
}

/**
 * 生产路径的预热：按各计划涉及的 (标的, 周期) 取一次 K 线，把「当前已收出的最后一根 bar」
 * 登记为已见，之后才开始真正报 justHit。
 * 不接线的话 primed 恒为 false，两个定时任务永远算不出 justHit，condition_hit 事件流整体失效。
 *
 * 登记的 barTime 必须与 evaluatePlan 实际求值的那根一致——未收完时求值用倒数第二根，
 * 这里也得登记倒数第二根，否则预热等于没登记（键错位）。
 */
export async function primeEvaluatorFromMarket(
  plans: SymbolTradePlan[],
  loadBars: BarLoader = defaultBarLoader,
): Promise<void> {
  /** key = code|period → 最后一根已收 bar 时间 */
  const closedBarTime = new Map<string, string | null>();
  /** 本轮真正取到数的 code|period。取数失败的不算预热过，下一轮继续重试 */
  const fetched = new Set<string>();
  const wanted = new Set<string>();
  for (const p of plans) {
    for (const period of periodsOf(p)) {
      if (!PRIMED_PLANS.has(primedKey(p, period))) wanted.add(`${p.code}|${period}`);
    }
  }

  await Promise.all(
    Array.from(wanted).map(async (key) => {
      const [code, period] = key.split('|') as [string, KlinePeriod];
      try {
        const bars = await loadBars(code, period);
        const usable = isBarUnclosed(period, bars[bars.length - 1]?.time)
          ? bars.slice(0, -1)
          : bars;
        closedBarTime.set(key, usable[usable.length - 1]?.time ?? null);
        fetched.add(key);
      } catch (e) {
        // 取数失败时该周期既不登记也不标记已预热，下一轮重新尝试。
        // 标记了的话，恢复那一轮就会把生成前已收出的 bar 报成刚命中。
        console.warn(
          `[symbolPlans] 预热取数失败 ${key}，该周期保持未预热，下轮重试:`,
          e instanceof Error ? e.message : e,
        );
        closedBarTime.set(key, null);
      }
    }),
  );

  primeEvaluator(plans, (code, period) => closedBarTime.get(`${code}|${period}`) ?? null);
  for (const p of plans) {
    for (const period of periodsOf(p)) {
      if (fetched.has(`${p.code}|${period}`)) PRIMED_PLANS.add(primedKey(p, period));
    }
  }
}

/**
 * 遍历生效计划做 bar 级求值（定时任务入口）。逐个 catch，单只失败不影响其余。
 * 首次运行前必须先预热，否则 justHit 永远为 false。
 * 预热按「计划版本」而非全局一次：新生成的计划同样要先登记当前已收 bar，
 * 否则它第一次被求值时会把生成前就已收出的那根 bar 报成「刚命中」。
 */
export async function evaluateAllLivePlans(opts: { loadBars?: BarLoader } = {}): Promise<void> {
  const plans = repo.listLivePlans();
  // 只要还有周期没预热成功就要补——上一轮取数失败的周期会一直留在这里重试，
  // 直到取到数的那一轮完成「只登记不触发」
  const fresh = plans.filter((p) => periodsOf(p).some((period) => !PRIMED_PLANS.has(primedKey(p, period))));
  if (fresh.length > 0) await primeEvaluatorFromMarket(fresh, opts.loadBars);
  for (const p of plans) {
    try {
      await evaluatePlanById(p.id, { readOnly: false, loadBars: opts.loadBars });
    } catch (e) {
      console.warn(
        `[symbolPlans] 计划 ${p.id}(${p.code}) 求值失败:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}