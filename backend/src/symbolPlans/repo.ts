import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  SymbolPlanEvent,
  SymbolPlanEventKind,
  SymbolPlanHorizon,
  SymbolPlanStatus,
  SymbolTradePlan,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso } from '../util';

// 计划仓储：只做读写与版本管理，不含业务编译逻辑（那在 service.ts）。
// 纪律：每次重新生成新增版本，旧版本置 superseded，绝不覆盖删除历史。

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
    horizon: row.horizon as SymbolPlanHorizon,
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
    }),
    exitPlan: parseJson<SymbolTradePlan['exitPlan']>(row.exitPlan, {
      firstTakeProfitLevelId: null,
      secondTakeProfitLevelId: null,
      trailingRule: null,
      reduceFractions: [],
      profitProtectionRule: null,
    }),
    execution: parseJson<SymbolTradePlan['execution']>(row.execution, {
      triggerMode: 'close_confirmed',
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
    version: plan.version,
    horizon: plan.horizon,
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

/** 仍在生效的状态（可被新版本 supersede、可被求值） */
const LIVE_STATUSES: SymbolPlanStatus[] = ['draft', 'active', 'triggered'];

export function getPlan(id: string): SymbolTradePlan | null {
  const row = db.select().from(schema.symbolTradePlans).where(eq(schema.symbolTradePlans.id, id)).get();
  return row ? toDto(row) : null;
}

/** 取某标的某期限当前生效的计划（最新版本优先） */
export function getActivePlan(code: string, horizon: SymbolPlanHorizon): SymbolTradePlan | null {
  const row = db
    .select()
    .from(schema.symbolTradePlans)
    .where(
      and(
        eq(schema.symbolTradePlans.code, code),
        eq(schema.symbolTradePlans.horizon, horizon),
        inArray(schema.symbolTradePlans.status, LIVE_STATUSES),
      ),
    )
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

/** 下一个版本号：按 (code, horizon) 递增，与唯一索引对齐 */
export function nextVersion(code: string, horizon: SymbolPlanHorizon): number {
  const row = db
    .select()
    .from(schema.symbolTradePlans)
    .where(
      and(eq(schema.symbolTradePlans.code, code), eq(schema.symbolTradePlans.horizon, horizon)),
    )
    .orderBy(desc(schema.symbolTradePlans.version))
    .get();
  return (row?.version ?? 0) + 1;
}

export function insertPlan(plan: SymbolTradePlan): void {
  db.insert(schema.symbolTradePlans).values(toRow(plan)).run();
}

export function updateStatus(id: string, status: SymbolPlanStatus): void {
  db.update(schema.symbolTradePlans)
    .set({ status, updatedAt: nowIso() })
    .where(eq(schema.symbolTradePlans.id, id))
    .run();
}

/**
 * 把同标的同期限的其他生效版本置为 superseded（不删除）。
 * 返回带版本号，供事件记录定位「是哪一版被替代」——只回 id 的话事件里只能写 0。
 */
export function supersedeOthers(
  code: string,
  horizon: SymbolPlanHorizon,
  keepId: string,
): Array<{ id: string; version: number }> {
  const rows = db
    .select()
    .from(schema.symbolTradePlans)
    .where(
      and(
        eq(schema.symbolTradePlans.code, code),
        eq(schema.symbolTradePlans.horizon, horizon),
        inArray(schema.symbolTradePlans.status, LIVE_STATUSES),
      ),
    )
    .all()
    .filter((r) => r.id !== keepId);
  for (const r of rows) updateStatus(r.id, 'superseded');
  return rows.map((r) => ({ id: r.id, version: r.version }));
}

export function appendEvent(input: {
  planId: string;
  planVersion: number;
  kind: SymbolPlanEventKind;
  conditionId?: string | null;
  note: string;
}): SymbolPlanEvent {
  const row = {
    id: newId(),
    planId: input.planId,
    planVersion: input.planVersion,
    kind: input.kind,
    conditionId: input.conditionId ?? null,
    note: input.note,
    createdAt: nowIso(),
  };
  db.insert(schema.symbolTradePlanEvents).values(row).run();
  return row as SymbolPlanEvent;
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
