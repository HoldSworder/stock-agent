import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  DailyPlan,
  DailyPlanEvent,
  DailyPlanItem,
  DailyPlanSummary,
  IntradayGuide,
  MarketStance,
  PlanAssetType,
  PlanEventKind,
  PlanFocusSector,
  PlanItemStatus,
  PlanStatus,
  PlanTrigger,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso } from '../util';

// 今日计划表 CRUD。结构化字段（marketStance / focusSectors / 各触发价）以 JSON 文本落库，
// 读出时解析为 DTO，供盘中盯盘做廉价数值比较与前端模块化渲染。

type PlanRow = typeof schema.dailyPlans.$inferSelect;
type ItemRow = typeof schema.dailyPlanItems.$inferSelect;
type EventRow = typeof schema.dailyPlanEvents.$inferSelect;

function parse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function parseTrigger(s: string | null): PlanTrigger | null {
  const v = parse<PlanTrigger | null>(s, null);
  if (!v || typeof v.value !== 'number' || !Number.isFinite(v.value)) return null;
  return { type: v.type ?? 'price', value: v.value, note: v.note };
}

/** 解析 string[] JSON（条件清单），非数组/解析失败回退空数组，并过滤空串 */
function parseStrArray(s: string | null): string[] {
  const v = parse<unknown>(s, []);
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

/**
 * 按代码前缀判定资产类型：A 股 ETF/基金/LOF 代码以 1 或 5 开头（深市 15/16/18、沪市 5xx），
 * 个股为 0/3/6 开头。与 realPositions 的 ETF=15/5 开头口径一致。
 */
export function classifyAsset(code: string): PlanAssetType {
  return /^[15]/.test(code) ? 'etf' : 'stock';
}

function rowToPlan(row: PlanRow): DailyPlan {
  return {
    id: row.id,
    planDate: row.planDate,
    status: row.status as PlanStatus,
    marketStance: parse<MarketStance | null>(row.marketStance, null),
    focusSectors: parse<PlanFocusSector[]>(row.focusSectors, []),
    externalContext: row.externalContext ?? '',
    narrative: row.narrative ?? '',
    keyRisks: parseStrArray(row.keyRisks),
    intradayGuide: parse<IntradayGuide | null>(row.intradayGuide, null),
    runId: row.runId ?? null,
    reviewSummary: row.reviewSummary ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToItem(row: ItemRow): DailyPlanItem {
  return {
    id: row.id,
    planId: row.planId,
    code: row.code,
    name: row.name,
    assetType: (row.assetType as PlanAssetType) ?? 'stock',
    direction: row.direction as DailyPlanItem['direction'],
    thesis: row.thesis ?? '',
    buyTrigger: parseTrigger(row.buyTrigger),
    sellTrigger: parseTrigger(row.sellTrigger),
    stopLoss: parseTrigger(row.stopLoss),
    takeProfit: parseTrigger(row.takeProfit),
    positionHint: row.positionHint ?? '',
    confirmConditions: parseStrArray(row.confirmConditions),
    invalidConditions: parseStrArray(row.invalidConditions),
    source: row.source as DailyPlanItem['source'],
    confidence: row.confidence ?? null,
    priority: row.priority,
    status: row.status as PlanItemStatus,
    lastNote: row.lastNote ?? null,
    debateVerdict: row.debateVerdict ?? null,
    debateConfidence: row.debateConfidence ?? null,
    debateNote: row.debateNote ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToEvent(row: EventRow): DailyPlanEvent {
  return {
    id: row.id,
    planId: row.planId,
    itemId: row.itemId ?? null,
    ts: row.ts,
    kind: row.kind as PlanEventKind,
    payload: row.payload ?? null,
    runId: row.runId ?? null,
  };
}

// ===== 计划主记录 =====

export function getPlanByDate(date: string): DailyPlan | null {
  const row = db
    .select()
    .from(schema.dailyPlans)
    .where(eq(schema.dailyPlans.planDate, date))
    .get();
  return row ? rowToPlan(row) : null;
}

/**
 * 取「上一份已收盘且有复盘总结」的计划（planDate < beforeDate、status=closed、reviewSummary 非空）。
 * 供今日计划生成时闭环反哺：把上一交易日计划的复盘结论与次日预案草稿注入基准上下文。
 */
export function getPreviousReviewedPlan(beforeDate: string): DailyPlan | null {
  const row = db
    .select()
    .from(schema.dailyPlans)
    .where(
      and(
        sql`${schema.dailyPlans.planDate} < ${beforeDate}`,
        eq(schema.dailyPlans.status, 'closed'),
        sql`${schema.dailyPlans.reviewSummary} is not null and ${schema.dailyPlans.reviewSummary} != ''`,
      ),
    )
    .orderBy(desc(schema.dailyPlans.planDate))
    .limit(1)
    .get();
  return row ? rowToPlan(row) : null;
}

/** 历史计划摘要：按 planDate 倒序取近 N 条，含每个计划的标的数（group count 合并，避免 N+1） */
export function listPlanSummaries(limit = 60): DailyPlanSummary[] {
  const rows = db
    .select()
    .from(schema.dailyPlans)
    .orderBy(desc(schema.dailyPlans.planDate))
    .limit(limit)
    .all();
  if (!rows.length) return [];
  const counts = db
    .select({
      planId: schema.dailyPlanItems.planId,
      c: sql<number>`count(*)`,
    })
    .from(schema.dailyPlanItems)
    .where(inArray(schema.dailyPlanItems.planId, rows.map((r) => r.id)))
    .groupBy(schema.dailyPlanItems.planId)
    .all();
  const countMap = new Map(counts.map((c) => [c.planId, Number(c.c)]));
  return rows.map((row) => {
    const stance = parse<MarketStance | null>(row.marketStance, null);
    return {
      planDate: row.planDate,
      status: row.status as PlanStatus,
      bias: stance?.bias ?? null,
      summary: stance?.summary ?? '',
      itemCount: countMap.get(row.id) ?? 0,
      updatedAt: row.updatedAt,
    };
  });
}

export interface UpsertPlanInput {
  planDate: string;
  status?: PlanStatus;
  marketStance?: MarketStance | null;
  focusSectors?: PlanFocusSector[];
  externalContext?: string;
  narrative?: string;
  keyRisks?: string[];
  intradayGuide?: IntradayGuide | null;
  runId?: string | null;
}

/** 按日期 upsert 计划主记录（不动 items），返回 planId */
export function upsertPlan(input: UpsertPlanInput): string {
  const now = nowIso();
  const existing = db
    .select()
    .from(schema.dailyPlans)
    .where(eq(schema.dailyPlans.planDate, input.planDate))
    .get();
  if (existing) {
    db.update(schema.dailyPlans)
      .set({
        status: input.status ?? existing.status,
        marketStance:
          input.marketStance !== undefined
            ? JSON.stringify(input.marketStance)
            : existing.marketStance,
        focusSectors:
          input.focusSectors !== undefined
            ? JSON.stringify(input.focusSectors)
            : existing.focusSectors,
        externalContext:
          input.externalContext !== undefined ? input.externalContext : existing.externalContext,
        narrative: input.narrative !== undefined ? input.narrative : existing.narrative,
        keyRisks:
          input.keyRisks !== undefined ? JSON.stringify(input.keyRisks) : existing.keyRisks,
        intradayGuide:
          input.intradayGuide !== undefined
            ? JSON.stringify(input.intradayGuide)
            : existing.intradayGuide,
        runId: input.runId !== undefined ? input.runId : existing.runId,
        updatedAt: now,
      })
      .where(eq(schema.dailyPlans.id, existing.id))
      .run();
    return existing.id;
  }
  const id = newId();
  db.insert(schema.dailyPlans)
    .values({
      id,
      planDate: input.planDate,
      status: input.status ?? 'active',
      marketStance: input.marketStance != null ? JSON.stringify(input.marketStance) : null,
      focusSectors: JSON.stringify(input.focusSectors ?? []),
      externalContext: input.externalContext ?? null,
      narrative: input.narrative ?? null,
      keyRisks: JSON.stringify(input.keyRisks ?? []),
      intradayGuide: input.intradayGuide != null ? JSON.stringify(input.intradayGuide) : null,
      runId: input.runId ?? null,
      reviewSummary: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

/** 收盘复盘回填：写 reviewSummary 并置 closed */
export function closePlan(planId: string, reviewSummary: string): void {
  db.update(schema.dailyPlans)
    .set({ status: 'closed', reviewSummary, updatedAt: nowIso() })
    .where(eq(schema.dailyPlans.id, planId))
    .run();
}

// ===== 标的项 =====

export interface ItemInput {
  code: string;
  name: string;
  assetType?: PlanAssetType;
  direction?: DailyPlanItem['direction'];
  thesis?: string;
  buyTrigger?: PlanTrigger | null;
  sellTrigger?: PlanTrigger | null;
  stopLoss?: PlanTrigger | null;
  takeProfit?: PlanTrigger | null;
  positionHint?: string;
  confirmConditions?: string[];
  invalidConditions?: string[];
  source?: DailyPlanItem['source'];
  confidence?: number | null;
  priority?: number;
}

const trig = (t: PlanTrigger | null | undefined): string | null =>
  t && typeof t.value === 'number' ? JSON.stringify(t) : null;

/** 条件清单序列化：过滤空串后存 JSON，恒为合法数组字符串 */
const condList = (arr: string[] | undefined): string =>
  JSON.stringify((arr ?? []).filter((x) => typeof x === 'string' && x.trim().length > 0));

/** 全量替换某计划的标的项（重新生成时用） */
export function replaceItems(planId: string, items: ItemInput[]): void {
  const now = nowIso();
  db.transaction((tx) => {
    tx.delete(schema.dailyPlanItems).where(eq(schema.dailyPlanItems.planId, planId)).run();
    for (const it of items) {
      tx.insert(schema.dailyPlanItems)
        .values({
          id: newId(),
          planId,
          code: it.code,
          name: it.name,
          assetType: it.assetType ?? classifyAsset(it.code),
          direction: it.direction ?? 'watch',
          thesis: it.thesis ?? null,
          buyTrigger: trig(it.buyTrigger),
          sellTrigger: trig(it.sellTrigger),
          stopLoss: trig(it.stopLoss),
          takeProfit: trig(it.takeProfit),
          positionHint: it.positionHint ?? null,
          confirmConditions: condList(it.confirmConditions),
          invalidConditions: condList(it.invalidConditions),
          source: it.source ?? 'other',
          confidence: typeof it.confidence === 'number' ? it.confidence : null,
          priority: it.priority ?? 0,
          status: 'pending',
          lastNote: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  });
}

/**
 * 仅追加计划中尚不存在的标的项（按 code 去重，不动已有项）。
 * 供「持仓 ETF 全覆盖」确定性兜底：AI 漏写的持仓 ETF 由代码补齐，不覆盖 AI 已给的标的。
 * 返回实际新增的 code 列表。
 */
export function addItemsIfAbsent(planId: string, items: ItemInput[]): string[] {
  const existing = new Set(
    db
      .select({ code: schema.dailyPlanItems.code })
      .from(schema.dailyPlanItems)
      .where(eq(schema.dailyPlanItems.planId, planId))
      .all()
      .map((r) => r.code),
  );
  const toAdd = items.filter((it) => it.code && !existing.has(it.code));
  if (!toAdd.length) return [];
  const now = nowIso();
  db.transaction((tx) => {
    for (const it of toAdd) {
      existing.add(it.code);
      tx.insert(schema.dailyPlanItems)
        .values({
          id: newId(),
          planId,
          code: it.code,
          name: it.name,
          assetType: it.assetType ?? classifyAsset(it.code),
          direction: it.direction ?? 'watch',
          thesis: it.thesis ?? null,
          buyTrigger: trig(it.buyTrigger),
          sellTrigger: trig(it.sellTrigger),
          stopLoss: trig(it.stopLoss),
          takeProfit: trig(it.takeProfit),
          positionHint: it.positionHint ?? null,
          confirmConditions: condList(it.confirmConditions),
          invalidConditions: condList(it.invalidConditions),
          source: it.source ?? 'other',
          confidence: typeof it.confidence === 'number' ? it.confidence : null,
          priority: it.priority ?? 0,
          status: 'pending',
          lastNote: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  });
  return toAdd.map((it) => it.code);
}

export function listItems(planId: string): DailyPlanItem[] {
  return db
    .select()
    .from(schema.dailyPlanItems)
    .where(eq(schema.dailyPlanItems.planId, planId))
    .orderBy(desc(schema.dailyPlanItems.priority), asc(schema.dailyPlanItems.createdAt))
    .all()
    .map(rowToItem);
}

/** 按代码更新某计划下标的项的状态/备注，返回是否命中 */
export function updateItemByCode(
  planId: string,
  code: string,
  patch: { status?: PlanItemStatus; note?: string | null },
): DailyPlanItem | null {
  const row = db
    .select()
    .from(schema.dailyPlanItems)
    .where(eq(schema.dailyPlanItems.planId, planId))
    .all()
    .find((r) => r.code === code);
  if (!row) return null;
  db.update(schema.dailyPlanItems)
    .set({
      status: patch.status ?? row.status,
      lastNote: patch.note !== undefined ? patch.note : row.lastNote,
      updatedAt: nowIso(),
    })
    .where(eq(schema.dailyPlanItems.id, row.id))
    .run();
  return rowToItem({ ...row, status: patch.status ?? row.status, lastNote: patch.note ?? row.lastNote });
}

/** 按代码回写某计划下标的项的多 agent 辩论结论，返回是否命中 */
export function updateItemDebate(
  planId: string,
  code: string,
  patch: { verdict: string | null; confidence: number | null; note: string | null },
): boolean {
  const row = db
    .select()
    .from(schema.dailyPlanItems)
    .where(eq(schema.dailyPlanItems.planId, planId))
    .all()
    .find((r) => r.code === code);
  if (!row) return false;
  db.update(schema.dailyPlanItems)
    .set({
      debateVerdict: patch.verdict,
      debateConfidence: patch.confidence,
      debateNote: patch.note,
      updatedAt: nowIso(),
    })
    .where(eq(schema.dailyPlanItems.id, row.id))
    .run();
  return true;
}

// ===== 事件 =====

export function appendEvent(input: {
  planId: string;
  itemId?: string | null;
  kind: PlanEventKind;
  payload?: unknown;
  runId?: string | null;
}): void {
  db.insert(schema.dailyPlanEvents)
    .values({
      id: newId(),
      planId: input.planId,
      itemId: input.itemId ?? null,
      ts: nowIso(),
      kind: input.kind,
      payload: input.payload != null ? JSON.stringify(input.payload) : null,
      runId: input.runId ?? null,
    })
    .run();
}

export function listEvents(planId: string, limit = 100): DailyPlanEvent[] {
  return db
    .select()
    .from(schema.dailyPlanEvents)
    .where(eq(schema.dailyPlanEvents.planId, planId))
    .orderBy(desc(schema.dailyPlanEvents.ts))
    .limit(limit)
    .all()
    .map(rowToEvent);
}
