import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type {
  PlanOutcomeStat,
  SymbolPlanEvent,
  SymbolPlanEventKind,
  SymbolPlanOutcome,
  SymbolPlanStatus,
  SymbolTradePlan,
} from '@stock-agent/shared';
import { PLAN_LIVE_STATUSES, SYMBOL_PLAN_OUTCOMES } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso } from '../util';

// 计划仓储：只做读写与版本管理，不含业务编译逻辑（那在 service.ts）。
// 纪律：每次重新生成新增版本，旧版本置 superseded，绝不覆盖删除历史。

/**
 * horizon 列的固定写入值。期限车道已合并，DTO 上不再有这个字段。
 * 保留列而不做表重建：唯一索引 (code, horizon, version) 在 horizon 恒定时
 * 等价于 (code, version)，而历史行的 next_session / swing 值原样留着可供复盘。
 */
const MERGED_HORIZON = 'unified';

type PlanRow = typeof schema.symbolTradePlans.$inferSelect;

/** JSON 列解析，失败回落到给定默认值而不是抛错打断整个列表 */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toDto(row: PlanRow): SymbolTradePlan {
  return {
    id: row.id,
    version: row.version,
    code: row.code,
    name: row.name,
    assetType: row.assetType as SymbolTradePlan['assetType'],
    secid: row.secid,
    status: row.status as SymbolPlanStatus,
    asOf: row.asOf,
    validFrom: row.validFrom,
    expiresAt: row.expiresAt,
    dataStatus: row.dataStatus as SymbolTradePlan['dataStatus'],
    marketPhase: row.marketPhase as SymbolTradePlan['marketPhase'],
    trendState: row.trendState as SymbolTradePlan['trendState'],
    chanSetup: row.chanSetup as SymbolTradePlan['chanSetup'],
    marketAction: row.marketAction as SymbolTradePlan['marketAction'],
    primaryAction: row.primaryAction as SymbolTradePlan['primaryAction'],
    summary: row.summary,
    changes: parseJson<string[]>(row.changes, []),
    levels: parseJson<SymbolTradePlan['levels']>(row.levels, []),
    scenarios: parseJson<SymbolTradePlan['scenarios']>(row.scenarios, []),
    positionContext: parseJson<SymbolTradePlan['positionContext']>(row.positionContext, null),
    risk: parseJson<SymbolTradePlan['risk']>(row.risk, {
      structuralStop: null,
      volatilityStop: null,
      executionStop: null,
      atrPct: null,
      maxAccountRiskPct: 0,
      suggestedPositionPct: null,
      timeStopBars: null,
      gapRiskNote: null,
      allowedShares: null,
      reduceShares: null,
      effectiveLossPct: null,
      sizingBasisPrice: null,
    }),
    exitPlan: parseJson<SymbolTradePlan['exitPlan']>(row.exitPlan, {
      firstTakeProfitLevelId: null,
      secondTakeProfitLevelId: null,
      trailingRule: null,
      reduceFractions: [],
      profitProtectionRule: null,
    }),
    execution: parseJson<SymbolTradePlan['execution']>(row.execution, {
      chaseGuardAtr: null,
      maxPremiumPct: null,
      maxSpreadPct: null,
      nextReviewAt: row.asOf,
    }),
    benchmarks: parseJson<SymbolTradePlan['benchmarks']>(row.benchmarks, []),
    assetSpecificRisks: parseJson<string[]>(row.assetSpecificRisks, []),
    evidenceSnapshot: parseJson<unknown>(row.evidenceSnapshot, null),
    evidenceVersion: row.evidenceVersion,
    phaseModelVersion: row.phaseModelVersion,
    candidateModelVersion: row.candidateModelVersion,
    contextId: row.contextId,
    sessionId: row.sessionId,
    runId: row.runId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRow(plan: SymbolTradePlan): PlanRow {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    assetType: plan.assetType,
    // 落 secid：求值与预测结算都要按它取 K 线，只有 code 会让指数撞到同码个股
    secid: plan.secid ?? null,
    version: plan.version,
    // 期限车道已合并，列保留只为不动老数据；新计划一律写常量
    horizon: MERGED_HORIZON,
    status: plan.status,
    asOf: plan.asOf,
    validFrom: plan.validFrom,
    expiresAt: plan.expiresAt,
    dataStatus: plan.dataStatus,
    summary: plan.summary,
    marketPhase: plan.marketPhase,
    trendState: plan.trendState,
    chanSetup: plan.chanSetup,
    marketAction: plan.marketAction,
    primaryAction: plan.primaryAction,
    changes: JSON.stringify(plan.changes),
    levels: JSON.stringify(plan.levels),
    scenarios: JSON.stringify(plan.scenarios),
    positionContext: plan.positionContext ? JSON.stringify(plan.positionContext) : null,
    risk: JSON.stringify(plan.risk),
    exitPlan: JSON.stringify(plan.exitPlan),
    execution: JSON.stringify(plan.execution),
    benchmarks: JSON.stringify(plan.benchmarks),
    assetSpecificRisks: JSON.stringify(plan.assetSpecificRisks),
    evidenceSnapshot: plan.evidenceSnapshot ? JSON.stringify(plan.evidenceSnapshot) : null,
    evidenceVersion: plan.evidenceVersion,
    phaseModelVersion: plan.phaseModelVersion,
    candidateModelVersion: plan.candidateModelVersion,
    contextId: plan.contextId,
    sessionId: plan.sessionId,
    runId: plan.runId,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

/**
 * 仍在生效的状态（可被新版本 supersede、可被求值）。口径与前端共用，见 shared 的 isPlanLive。
 * 拷一份而非直接引用：源头是 readonly，inArray 要可变数组，且本地副本不会被误改回传染到前端。
 */
const LIVE_STATUSES: SymbolPlanStatus[] = [...PLAN_LIVE_STATUSES];

export function getPlan(id: string): SymbolTradePlan | null {
  const row = db.select().from(schema.symbolTradePlans).where(eq(schema.symbolTradePlans.id, id)).get();
  return row ? toDto(row) : null;
}

/** 取某标的当前生效的计划（最新版本优先） */
export function getActivePlan(code: string): SymbolTradePlan | null {
  const row = db
    .select()
    .from(schema.symbolTradePlans)
    .where(
      and(
        eq(schema.symbolTradePlans.code, code),
        inArray(schema.symbolTradePlans.status, LIVE_STATUSES),
      ),
    )
    .orderBy(desc(schema.symbolTradePlans.version))
    .get();
  return row ? toDto(row) : null;
}

/**
 * 取某标的最新一版计划，**不限状态**（含失效 / 过期 / 被替代）。
 *
 * 只给展示用。业务判定一律用 getActivePlan——尤其 regenerate 靠「是否出现更高版本的生效计划」
 * 判断重算成功，若那里换成本函数，一份原地失效的旧计划会被当成新产出，失败被记成成功。
 *
 * 存在的理由：计划失效后 getActivePlan 返回 null，界面若照此显示「尚无交易计划」，
 * 用户看到的是计划凭空消失，既看不到失效原因，也看不到那份计划究竟写了什么。
 */
export function getLatestPlan(code: string): SymbolTradePlan | null {
  const row = db
    .select()
    .from(schema.symbolTradePlans)
    .where(eq(schema.symbolTradePlans.code, code))
    .orderBy(desc(schema.symbolTradePlans.version))
    .get();
  return row ? toDto(row) : null;
}

/** 全部生效计划（供盘中求值遍历） */
export function listLivePlans(): SymbolTradePlan[] {
  return db
    .select()
    .from(schema.symbolTradePlans)
    .where(inArray(schema.symbolTradePlans.status, LIVE_STATUSES))
    .all()
    .map(toDto);
}

/**
 * 生效计划的最新变更时间戳，用于调用方做缓存失效判定。
 * 比全量读便宜得多——计划只在 agent 生成或复核时才变，不该每个 tick 重新反序列化一遍。
 */
export function livePlansRevision(): string {
  const row = db
    .select({ updatedAt: schema.symbolTradePlans.updatedAt })
    .from(schema.symbolTradePlans)
    .where(inArray(schema.symbolTradePlans.status, LIVE_STATUSES))
    .orderBy(desc(schema.symbolTradePlans.updatedAt))
    .get();
  // 计数一并进指纹：只看最大 updatedAt 无法察觉「删/改状态导致条数变化」。
  // 必须走聚合而非 select().all().length——后者会把全部生效计划的 9 个大 JSON 列
  // 反序列化出来只为取长度，缓存省下的开销又原样还回去了。
  const count =
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.symbolTradePlans)
      .where(inArray(schema.symbolTradePlans.status, LIVE_STATUSES))
      .get()?.n ?? 0;
  return `${row?.updatedAt ?? '-'}|${count}`;
}

export function listPlanHistory(code: string, limit = 20): SymbolTradePlan[] {
  return db
    .select()
    .from(schema.symbolTradePlans)
    .where(eq(schema.symbolTradePlans.code, code))
    .orderBy(desc(schema.symbolTradePlans.createdAt))
    .limit(limit)
    .all()
    .map(toDto);
}

/**
 * 下一个版本号：按 code 递增。
 * 唯一索引仍是 (code, horizon, version)，但 horizon 现在恒为常量，等价于 (code, version)。
 * 这里**不能**再按 horizon 过滤：合并车道前遗留的 next_session/swing 老行也在同一张表里，
 * 过滤掉它们会让新计划从 1 号重新开始，撞上老行的版本号。
 */
export function nextVersion(code: string): number {
  const row = db
    .select()
    .from(schema.symbolTradePlans)
    .where(eq(schema.symbolTradePlans.code, code))
    .orderBy(desc(schema.symbolTradePlans.version))
    .get();
  return (row?.version ?? 0) + 1;
}

export function insertPlan(plan: SymbolTradePlan): void {
  db.insert(schema.symbolTradePlans).values(toRow(plan)).run();
}

/**
 * 把到期时间提前到 `at`（只提前、不推迟；原值为空视为无限远，一律收紧）。
 *
 * 给「风险路径已启动」用：那份计划的多头情景已被行情否掉，但状态停在 triggered（仍是 live），
 * 直接改状态会让最该给出减仓指令的时刻变成一份灰掉的作废计划。收紧有效期既保住当下的
 * 减仓显示，又能让它在收盘时进入重算队列，而不是挂满 28 天。
 *
 * @returns 是否真的收紧了
 */
export function shortenExpiry(id: string, at: string): boolean {
  const row = db
    .select({ expiresAt: schema.symbolTradePlans.expiresAt })
    .from(schema.symbolTradePlans)
    .where(eq(schema.symbolTradePlans.id, id))
    .get();
  if (!row) return false;
  if (row.expiresAt != null && row.expiresAt <= at) return false;
  db.update(schema.symbolTradePlans)
    .set({ expiresAt: at, updatedAt: nowIso() })
    .where(eq(schema.symbolTradePlans.id, id))
    .run();
  return true;
}

export function updateStatus(id: string, status: SymbolPlanStatus): void {
  db.update(schema.symbolTradePlans)
    .set({ status, updatedAt: nowIso() })
    .where(eq(schema.symbolTradePlans.id, id))
    .run();
}

/**
 * 把同标的的其他生效版本置为 superseded（不删除）。
 * 返回带版本号，供事件记录定位「是哪一版被替代」——只回 id 的话事件里只能写 0。
 *
 * 不再按 horizon 分车道，这正是合并要的效果：遗留的 next_session / swing 生效计划
 * 会在下一次生成时被这份合并计划一起顶掉，不会两条老车道各自留一份僵尸计划在盯盘。
 */
export function supersedeOthers(
  code: string,
  keepId: string,
): Array<{ id: string; version: number }> {
  const rows = db
    .select()
    .from(schema.symbolTradePlans)
    .where(
      and(
        eq(schema.symbolTradePlans.code, code),
        inArray(schema.symbolTradePlans.status, LIVE_STATUSES),
      ),
    )
    .all()
    .filter((r) => r.id !== keepId);
  for (const r of rows) updateStatus(r.id, 'superseded');
  return rows.map((r) => ({ id: r.id, version: r.version }));
}

/**
 * 需要重算的计划：该标的**最新版本**已失效或过期，且没有更新的生效版本顶上。
 *
 * 「已过有效期但状态还没被求值改写」的生效计划同样收：状态是求值引擎写的，
 * 而求值只在有行情时跑，一份过了期却没人求值的计划会永远停在 active 挂着旧价位。
 * 风险路径已启动的计划也是靠这条进队列的——它的有效期被收紧到当日收盘（见 shortenExpiry），
 * 状态则保持 triggered 以便盘中继续显示减仓指令。
 *
 * 必须限定「最新版本」。只按状态筛的话，同一标的历史上每一版失效计划都会被选中，
 * 一个标的一次收盘就会重算十几遍。
 *
 * 按 asOf 倒序返回：调用方每轮只吃前 N 只。不排序的话返回的是表内插入序，
 * 某只早已退市/长期取不到数的标的会永远排在最前、每天霸占同样几个名额，
 * 今天新失效的计划则永远轮不上。倒序让最新失效的先重算，陈年老账排到队尾。
 *
 * 结果**按 code 去重**：唯一索引是 (code, horizon, version)，同一 code 的
 * (code,'next_session',1) 与 (code,'swing',1) 都满足 version = max(version)，
 * 两条一起入选会让同一标的一轮里被重算两次——白烧一次 agent 调用、占掉一个名额、统计虚高。
 */
export function listStalePlans(): SymbolTradePlan[] {
  const seen = new Set<string>();
  const now = nowIso();
  return db
    .select()
    .from(schema.symbolTradePlans)
    .where(
      and(
        or(
          inArray(schema.symbolTradePlans.status, ['invalid', 'expired'] as SymbolPlanStatus[]),
          and(
            inArray(schema.symbolTradePlans.status, LIVE_STATUSES),
            sql`${schema.symbolTradePlans.expiresAt} is not null and ${schema.symbolTradePlans.expiresAt} < ${now}`,
          ),
        ),
        sql`${schema.symbolTradePlans.version} = (
          select max(version) from symbol_trade_plans x where x.code = ${schema.symbolTradePlans.code}
        )`,
      ),
    )
    .orderBy(desc(schema.symbolTradePlans.asOf), desc(schema.symbolTradePlans.updatedAt))
    .all()
    .filter((r) => {
      if (seen.has(r.code)) return false;
      seen.add(r.code);
      return true;
    })
    .map(toDto);
}

/**
 * 把候选模型版本已过期的生效计划置为 expired，使其进入收盘重算队列。
 *
 * 候选口径变了（聚类容差、白名单极性、枢轴基准根等）意味着旧计划引用的价位与条件
 * 已经不是当前口径算出来的东西，继续拿它盯盘等于用一把旧尺子量新行情。
 * 但**不删历史、不回退为可执行**：置 expired 后计划仍可见可复盘，只是停止执行，
 * 由 closeRegenerate 派生新版本；新版本落库失败时它就停在「已过期但可复盘」，这是安全侧。
 *
 * **必须分批**：升版本那一轮库里所有生效计划都不是当前口径，一次性全置 expired
 * 会让它们同时从 getActivePlan / listLivePlans 里消失，而重算侧一轮只吃 MAX_PER_RUN 只，
 * 跟踪 N 只标的就要 ceil(N/8) 个交易日才恢复，期间用户看到的是「尚无交易计划」。
 * 只置本轮吃得下的那几只，其余保持生效，等轮到自己再换口径——旧口径多挂一两天，
 * 远好过整片计划集体消失。
 *
 * @param currentVersion 当前 CANDIDATE_MODEL_VERSION，由调用方传入以免仓储层反向依赖候选目录
 * @param limit 本轮最多置过期多少只；不传表示不限（只给自检与一次性维护脚本用）
 * @returns 被置为过期的计划
 */
export function expireOutdatedCandidateModelPlans(
  currentVersion: string,
  limit?: number,
): Array<{ id: string; code: string; version: number; from: string }> {
  if (limit != null && limit <= 0) return [];
  const q = db
    .select()
    .from(schema.symbolTradePlans)
    .where(
      and(
        inArray(schema.symbolTradePlans.status, LIVE_STATUSES),
        sql`${schema.symbolTradePlans.candidateModelVersion} <> ${currentVersion}`,
      ),
    )
    // 与 listStalePlans 同序：最近的计划先换口径，陈年老账排队尾
    .orderBy(desc(schema.symbolTradePlans.asOf), desc(schema.symbolTradePlans.updatedAt));
  const rows = limit != null ? q.limit(limit).all() : q.all();
  for (const r of rows) {
    updateStatus(r.id, 'expired');
    appendEvent({
      planId: r.id,
      planVersion: r.version,
      kind: 'expired',
      note: `候选模型版本已从 ${r.candidateModelVersion || '(空)'} 升到 ${currentVersion}，价位算法变了，标为过期待重算`,
    });
  }
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    version: r.version,
    from: r.candidateModelVersion,
  }));
}

export function appendEvent(input: {
  planId: string;
  planVersion: number;
  kind: SymbolPlanEventKind;
  conditionId?: string | null;
  note: string;
  /** 复盘归因，仅 kind='reviewed' 时给；单开一列才聚合得出来 */
  outcome?: SymbolPlanOutcome | null;
}): SymbolPlanEvent {
  const row = {
    id: newId(),
    planId: input.planId,
    planVersion: input.planVersion,
    kind: input.kind,
    conditionId: input.conditionId ?? null,
    note: input.note,
    outcome: input.outcome ?? null,
    createdAt: nowIso(),
  };
  db.insert(schema.symbolTradePlanEvents).values(row).run();
  return row as SymbolPlanEvent;
}

/** 复盘归因分布。只数 reviewed 事件里带枚举的那些，历史上塞在 note 里的老记录不参与 */
export function planOutcomeStats(): PlanOutcomeStat[] {
  const rows = db
    .select({
      outcome: schema.symbolTradePlanEvents.outcome,
      count: sql<number>`count(*)`,
    })
    .from(schema.symbolTradePlanEvents)
    .where(
      and(
        eq(schema.symbolTradePlanEvents.kind, 'reviewed'),
        isNotNull(schema.symbolTradePlanEvents.outcome),
      ),
    )
    .groupBy(schema.symbolTradePlanEvents.outcome)
    .all();
  const labelOf = new Map(SYMBOL_PLAN_OUTCOMES.map((o) => [o.value, o.label]));
  return rows
    .map((r) => ({
      outcome: r.outcome as SymbolPlanOutcome,
      label: labelOf.get(r.outcome as SymbolPlanOutcome) ?? String(r.outcome),
      count: Number(r.count ?? 0),
    }))
    .sort((a, b) => b.count - a.count);
}

// ===== 事件类条件锁存 =====

/** 读取该计划已锁存的条件 id 集合 */
export function listLatchedConditionIds(planId: string): Set<string> {
  const rows = db
    .select({ conditionId: schema.symbolPlanConditionLatches.conditionId })
    .from(schema.symbolPlanConditionLatches)
    .where(eq(schema.symbolPlanConditionLatches.planId, planId))
    .all();
  return new Set(rows.map((r) => r.conditionId));
}

/**
 * 尝试锁存一个事件类条件。返回 true 表示本次真的插入了新锁存。
 *
 * 走 INSERT OR IGNORE 而不是「先查后插」：查与插之间存在竞态窗口，
 * 两个并发求值都会认为自己是首次命中，从而重复写 condition_hit 事件。
 * 唯一索引 + 返回值判定才是原子的。
 */
export function tryLatchCondition(input: {
  planId: string;
  conditionId: string;
  barTime: string | null;
}): boolean {
  const res = db
    .insert(schema.symbolPlanConditionLatches)
    .values({
      id: newId(),
      planId: input.planId,
      conditionId: input.conditionId,
      barTime: input.barTime,
      latchedAt: nowIso(),
    })
    .onConflictDoNothing()
    .run();
  return res.changes > 0;
}

export function listEvents(planId: string): SymbolPlanEvent[] {
  return db
    .select()
    .from(schema.symbolTradePlanEvents)
    .where(eq(schema.symbolTradePlanEvents.planId, planId))
    .orderBy(schema.symbolTradePlanEvents.createdAt)
    .all()
    .map((r) => ({ ...r, kind: r.kind as SymbolPlanEventKind }));
}
