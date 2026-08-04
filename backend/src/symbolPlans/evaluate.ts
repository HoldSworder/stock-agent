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

export function cadenceOf(cond: PlanCondition): 'tick' | 'bar' {
  // 只有 priceLevel 能走 tick；其中 holdAbove/holdBelow 是收盘口径，仍须走 bar
  if (cond.rule.kind === 'priceLevel') {
    return cond.rule.relation === 'holdAbove' || cond.rule.relation === 'holdBelow' ? 'bar' : 'tick';
  }
  return 'bar';
}

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
/** 已预热过的计划版本 `planId|version`，供定时入口只给新计划补预热 */
const PRIMED_PLANS = new Set<string>();

export function seenKey(
  code: string,
  period: KlinePeriod,
  barTime: string,
  planVersion: number,
  conditionId: string,
): string {
  return `${code}|${period}|${barTime}|${planVersion}|${conditionId}`;
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
      if (t) SEEN_BARS.set(seenKey(p.code, cond.timeframe, t, p.version, cond.id), now);
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

/** 状态与文案判定。拆成函数避免多层嵌套三元，也让「失效优先于触发」这条优先级只写一处 */
function resolveOutcome(input: {
  invalidated: boolean;
  expired: boolean;
  triggered: boolean;
  current: SymbolTradePlan['status'];
}): { status: SymbolTradePlan['status']; summary: string } {
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
   * 最后一根 bar 是否已收完。false 时 bar 级条件用倒数第二根（最后一根已收的）求值，
   * 避免用半根 bar 的值做一次性判定后把该 barTime 标记为已见。
   */
  lastBarClosed?: boolean;
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

  // 按「情景:条件」索引，供后面精确定位状态
  const byScenario = new Map<string, PlanConditionState>();

  for (const scenario of plan.scenarios) {
    const push = (st: PlanConditionState): void => {
      states.push(st);
      byScenario.set(`${scenario.id}:${st.conditionId}`, st);
    };
    const mark = (cond: PlanCondition, isInvalid: boolean): void => {
      const cadence = cadenceOf(cond);
      if (cadence === 'tick') {
        const ok = input.tick ? evalTickCondition(cond, input.tick) : false;
        push({
          conditionId: cond.id,
          satisfied: ok,
          justHit: ok,
          cadence,
          detail: `${isInvalid ? '失效' : '触发'}条件（tick）：${cond.description}`,
          evaluatedAt: at,
        });
        return;
      }
      const allBars = input.barsByPeriod.get(cond.timeframe);
      // 未收完的最后一根不参与 bar 级判定：用半根 bar 求值后还会把该 barTime 标记为已见，
      // 等它真收盘、指标值已变时就再也报不出触发了。
      // 切片条件不能再附加 length > 1：只有一根时那根同样是未收完的，
      // 留着它就退回「用半根 bar 求值并标记已见」的老问题。切完为空按数据不足处理。
      const bars =
        input.lastBarClosed === false && allBars ? allBars.slice(0, -1) : allBars;
      if (!bars || bars.length === 0) {
        push({
          conditionId: cond.id,
          satisfied: false,
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
      const key = seenKey(plan.code, cond.timeframe, barTime, plan.version, cond.id);
      const alreadySeen = SEEN_BARS.has(key);
      const series = getSeries(plan.code, cond.timeframe, bars, allConditions(plan));
      const i = bars.length - 1;
      const ok = evalRule(cond.rule, series, i, {
        entryPrice: 0,
        heldBars: 0,
        planBars: input.planBars,
      });
      if (!input.force) pendingSeen.push(key);
      push({
        conditionId: cond.id,
        satisfied: ok,
        // 同一根 bar 内不重复报「刚触发」；未预热的首轮与只读复核都不报
        justHit: ok && !alreadySeen && primed && !input.force,
        cadence,
        detail: `${isInvalid ? '失效' : '触发'}条件（${cond.timeframe} bar ${barTime}）：${cond.description}`,
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
    return false;
  }
  const tx = sqlite.transaction(() => {
    for (const c of ev.conditions.filter((x) => x.justHit)) {
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
  return true;
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
  const ev = evaluatePlan({
    plan,
    barsByPeriod: map,
    force: opts.readOnly === true,
    lastBarClosed: !hasUnclosedBar(map),
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
  const wanted = new Set<string>();
  for (const p of plans) for (const period of periodsOf(p)) wanted.add(`${p.code}|${period}`);

  await Promise.all(
    Array.from(wanted).map(async (key) => {
      const [code, period] = key.split('|') as [string, KlinePeriod];
      try {
        const bars = await loadBars(code, period);
        const usable = isBarUnclosed(bars[bars.length - 1]?.time) ? bars.slice(0, -1) : bars;
        closedBarTime.set(key, usable[usable.length - 1]?.time ?? null);
      } catch (e) {
        // 取数失败时该周期不登记：宁可首轮多报一次 justHit，也不能把预热整体跳过导致永不触发
        console.warn(
          `[symbolPlans] 预热取数失败 ${key}，该周期首轮可能重放一次触发:`,
          e instanceof Error ? e.message : e,
        );
        closedBarTime.set(key, null);
      }
    }),
  );

  primeEvaluator(plans, (code, period) => closedBarTime.get(`${code}|${period}`) ?? null);
  for (const p of plans) PRIMED_PLANS.add(`${p.id}|${p.version}`);
}

/**
 * 遍历生效计划做 bar 级求值（定时任务入口）。逐个 catch，单只失败不影响其余。
 * 首次运行前必须先预热，否则 justHit 永远为 false。
 * 预热按「计划版本」而非全局一次：新生成的计划同样要先登记当前已收 bar，
 * 否则它第一次被求值时会把生成前就已收出的那根 bar 报成「刚命中」。
 */
export async function evaluateAllLivePlans(opts: { loadBars?: BarLoader } = {}): Promise<void> {
  const plans = repo.listLivePlans();
  const fresh = plans.filter((p) => !PRIMED_PLANS.has(`${p.id}|${p.version}`));
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

/**
 * 任一周期的最后一根 bar 是否还没收完。
 * 判据全部收敛到 sessionClock 的 isBarUnclosed（数据日期 + 时钟，覆盖午休），
 * 与证据层共用，避免 15:00 整点两层结论相反。
 */
function hasUnclosedBar(barsByPeriod: Map<KlinePeriod, KlineBar[]>, now = new Date()): boolean {
  for (const bars of barsByPeriod.values()) {
    if (isBarUnclosed(bars[bars.length - 1]?.time, now)) return true;
  }
  return false;
}
