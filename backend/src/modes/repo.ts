import { and, asc, desc, eq } from 'drizzle-orm';
import type {
  ModeBacktestMetrics,
  ModeCostRow,
  ModeHolding,
  ModeProtocolMark,
  ModeSegmentRow,
  ModeSignalAction,
  ModeSpec,
  ModeUniversePolicy,
  ResearchMode,
  ResearchModeBacktestInput,
  ResearchModeBacktestListItem,
  ResearchModeDaily,
  ResearchModeDailyInput,
  ResearchModeEvent,
  ResearchModeListItem,
  ResearchModeUpsert,
  TrackingMode,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso } from '../util';

// 量化研究模式库持久层：JSON 字段统一在出入口 (de)serialize，调用方拿到的都是结构化对象。

function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

type ModeRow = typeof schema.researchModes.$inferSelect;
type BacktestRow = typeof schema.researchModeBacktests.$inferSelect;
type DailyRow = typeof schema.researchModeDaily.$inferSelect;

function modeToApi(row: ModeRow): ResearchMode {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    tags: row.tags,
    status: row.status as ResearchMode['status'],
    summary: row.summary,
    buySellMd: row.buySellMd,
    recommendedConfig: row.recommendedConfig,
    analysisMd: row.analysisMd,
    universeNote: row.universeNote,
    risksMd: row.risksMd,
    followed: row.followed,
    trackingMode: row.trackingMode as TrackingMode,
    spec: parse<ModeSpec | null>(row.spec, null),
    source: row.source,
    variantCount: row.variantCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function backtestToApi(row: BacktestRow): ResearchModeBacktestListItem {
  return {
    id: row.id,
    modeId: row.modeId,
    label: row.label,
    range: row.range,
    poolSize: row.poolSize,
    metrics: parse<ModeBacktestMetrics>(row.metrics, {}),
    costSensitivity: parse<ModeCostRow[]>(row.costSensitivity, []),
    segments: parse<ModeSegmentRow[]>(row.segments, []),
    concentrationMd: row.concentrationMd,
    isRecommended: row.isRecommended,
    protocol: row.protocol,
    engineVersion: row.engineVersion,
    createdAt: row.createdAt,
  };
}

/**
 * 协议列 → ModeProtocolMark。protocolVersion 为空即视为「加列之前的历史行」，
 * 返回 null 让消费方按 v1-legacy 处理，而不是拼出一条半截的假口径。
 */
function protocolOf(row: DailyRow): ModeProtocolMark | null {
  if (!row.protocolVersion) return null;
  return {
    protocolVersion: row.protocolVersion,
    engineVersion: row.engineVersion ?? '',
    universePolicy: (row.universePolicy ?? 'custom') as ModeUniversePolicy,
    universeHash: row.universeHash ?? '',
    poolSize: row.poolSize ?? 0,
    costBps: { buyBps: row.costBuyBps ?? 0, sellBps: row.costSellBps ?? 0 },
    sameAsResearchPool: row.sameAsResearchPool ?? null,
  };
}

function dailyToApi(row: DailyRow): ResearchModeDaily {
  return {
    modeId: row.modeId,
    date: row.date,
    holdings: parse<ModeHolding[]>(row.holdings, []),
    signal: parse<ModeSignalAction[] | null>(row.signal, null),
    dayReturn: row.dayReturn,
    cumReturn: row.cumReturn,
    drawdown: row.drawdown,
    source: row.source as TrackingMode,
    protocol: protocolOf(row),
    createdAt: row.createdAt,
  };
}

// ---- 模式主体 ----

export function getMode(id: string): ResearchMode | null {
  const row = db.select().from(schema.researchModes).where(eq(schema.researchModes.id, id)).get();
  return row ? modeToApi(row) : null;
}

export function listModes(): ResearchModeListItem[] {
  const modes = db
    .select()
    .from(schema.researchModes)
    .orderBy(desc(schema.researchModes.updatedAt))
    .all();
  const bts = db.select().from(schema.researchModeBacktests).all();
  const byMode = new Map<string, BacktestRow[]>();
  for (const b of bts) {
    const arr = byMode.get(b.modeId) ?? [];
    arr.push(b);
    byMode.set(b.modeId, arr);
  }
  return modes.map((m) => {
    const list = byMode.get(m.id) ?? [];
    // 头条取推荐版，否则取收益最高版
    const headline =
      list.find((b) => b.isRecommended) ??
      list
        .slice()
        .sort(
          (a, b) =>
            (parse<ModeBacktestMetrics>(b.metrics, {}).return ?? -Infinity) -
            (parse<ModeBacktestMetrics>(a.metrics, {}).return ?? -Infinity),
        )[0];
    const hm = headline ? parse<ModeBacktestMetrics>(headline.metrics, {}) : {};
    return {
      id: m.id,
      name: m.name,
      category: m.category,
      tags: m.tags,
      status: m.status as ResearchModeListItem['status'],
      summary: m.summary,
      recommendedConfig: m.recommendedConfig,
      followed: m.followed,
      trackingMode: m.trackingMode as TrackingMode,
      headlineReturn: hm.return ?? null,
      headlineFlatReturn: hm.flatReturn ?? null,
      headlineDrawdown: hm.maxDrawdown ?? null,
      backtestCount: list.length,
      variantCount: m.variantCount,
      updatedAt: m.updatedAt,
    };
  });
}

export function upsertMode(input: ResearchModeUpsert): ResearchMode {
  const at = nowIso();
  const existing = getMode(input.id);
  const values = {
    id: input.id,
    name: input.name,
    category: input.category ?? null,
    tags: input.tags ?? null,
    status: input.status ?? 'experiment',
    summary: input.summary ?? null,
    buySellMd: input.buySellMd ?? null,
    recommendedConfig: input.recommendedConfig ?? null,
    analysisMd: input.analysisMd ?? null,
    universeNote: input.universeNote ?? null,
    risksMd: input.risksMd ?? null,
    trackingMode: input.trackingMode ?? 'external',
    spec: input.spec === undefined ? null : JSON.stringify(input.spec),
    source: input.source ?? null,
    variantCount: input.variantCount ?? existing?.variantCount ?? 0,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  };
  db.insert(schema.researchModes)
    .values(values)
    .onConflictDoUpdate({
      target: schema.researchModes.id,
      // followed 不在 upsert 范围内（关注开关单独维护），createdAt 保留
      set: {
        name: values.name,
        category: values.category,
        tags: values.tags,
        status: values.status,
        summary: values.summary,
        buySellMd: values.buySellMd,
        recommendedConfig: values.recommendedConfig,
        analysisMd: values.analysisMd,
        universeNote: values.universeNote,
        risksMd: values.risksMd,
        trackingMode: values.trackingMode,
        spec: values.spec,
        source: values.source,
        variantCount: values.variantCount,
        updatedAt: values.updatedAt,
      },
    })
    .run();
  return getMode(input.id) as ResearchMode;
}

export function setFollowed(id: string, followed: boolean): void {
  db.update(schema.researchModes)
    .set({ followed, updatedAt: nowIso() })
    .where(eq(schema.researchModes.id, id))
    .run();
}

export function deleteMode(id: string): void {
  db.delete(schema.researchModeBacktests).where(eq(schema.researchModeBacktests.modeId, id)).run();
  db.delete(schema.researchModeDaily).where(eq(schema.researchModeDaily.modeId, id)).run();
  db.delete(schema.researchModeEvents).where(eq(schema.researchModeEvents.modeId, id)).run();
  db.delete(schema.researchModes).where(eq(schema.researchModes.id, id)).run();
}

/** 已关注、且 system 跟踪的模式（供站内每日引擎遍历） */
export function listFollowedSystemModes(): ResearchMode[] {
  return db
    .select()
    .from(schema.researchModes)
    .where(and(eq(schema.researchModes.followed, true), eq(schema.researchModes.trackingMode, 'system')))
    .all()
    .map(modeToApi);
}

// ---- 回测结果 ----

export function listBacktests(modeId: string): ResearchModeBacktestListItem[] {
  return db
    .select()
    .from(schema.researchModeBacktests)
    .where(eq(schema.researchModeBacktests.modeId, modeId))
    .orderBy(desc(schema.researchModeBacktests.isRecommended), desc(schema.researchModeBacktests.createdAt))
    .all()
    .map(backtestToApi);
}

/** 仅删除某模式的回测版本（不动模式主体 / 每日跟踪 / 事件），供从种子刷新回测用 */
export function deleteBacktests(modeId: string): void {
  db.delete(schema.researchModeBacktests).where(eq(schema.researchModeBacktests.modeId, modeId)).run();
}

export function getBacktestTrades(id: string): string | null {
  const row = db
    .select({ tradesMd: schema.researchModeBacktests.tradesMd })
    .from(schema.researchModeBacktests)
    .where(eq(schema.researchModeBacktests.id, id))
    .get();
  return row?.tradesMd ?? null;
}

export function addBacktest(modeId: string, input: ResearchModeBacktestInput): ResearchModeBacktestListItem {
  const id = newId();
  db.insert(schema.researchModeBacktests)
    .values({
      id,
      modeId,
      label: input.label,
      range: input.range ?? null,
      poolSize: input.poolSize ?? null,
      metrics: JSON.stringify(input.metrics ?? {}),
      costSensitivity: JSON.stringify(input.costSensitivity ?? []),
      segments: JSON.stringify(input.segments ?? []),
      concentrationMd: input.concentrationMd ?? null,
      tradesMd: input.tradesMd ?? null,
      isRecommended: input.isRecommended ?? false,
      protocol: input.protocol ?? '',
      engineVersion: input.engineVersion ?? null,
      createdAt: nowIso(),
    })
    .run();
  return db
    .select()
    .from(schema.researchModeBacktests)
    .where(eq(schema.researchModeBacktests.id, id))
    .all()
    .map(backtestToApi)[0];
}

// ---- 每日跟踪 ----

export function recentDaily(modeId: string, limit = 120): ResearchModeDaily[] {
  return db
    .select()
    .from(schema.researchModeDaily)
    .where(eq(schema.researchModeDaily.modeId, modeId))
    .orderBy(desc(schema.researchModeDaily.date))
    .limit(limit)
    .all()
    .map(dailyToApi)
    .reverse();
}

export function latestDaily(modeId: string): ResearchModeDaily | null {
  const row = db
    .select()
    .from(schema.researchModeDaily)
    .where(eq(schema.researchModeDaily.modeId, modeId))
    .orderBy(desc(schema.researchModeDaily.date))
    .limit(1)
    .get();
  return row ? dailyToApi(row) : null;
}

export function upsertDaily(
  modeId: string,
  source: TrackingMode,
  input: ResearchModeDailyInput,
): void {
  const existing = db
    .select({ id: schema.researchModeDaily.id })
    .from(schema.researchModeDaily)
    .where(and(eq(schema.researchModeDaily.modeId, modeId), eq(schema.researchModeDaily.date, input.date)))
    .get();
  // 协议列随 upsert 一并更新：同日重跑若只刷收益不刷协议，这行会挂着上一版引擎的口径，
  // 晋级门按协议分段时就会把新引擎的样本算进旧区段
  const p = input.protocol;
  const values = {
    id: existing?.id ?? newId(),
    modeId,
    date: input.date,
    holdings: JSON.stringify(input.holdings ?? []),
    signal: input.signal ? JSON.stringify(input.signal) : null,
    dayReturn: input.dayReturn ?? null,
    cumReturn: input.cumReturn ?? null,
    drawdown: input.drawdown ?? null,
    source,
    protocolVersion: p?.protocolVersion ?? null,
    engineVersion: p?.engineVersion ?? null,
    universePolicy: p?.universePolicy ?? null,
    universeHash: p?.universeHash ?? null,
    poolSize: p?.poolSize ?? null,
    costBuyBps: p?.costBps.buyBps ?? null,
    costSellBps: p?.costBps.sellBps ?? null,
    sameAsResearchPool: p?.sameAsResearchPool ?? null,
    createdAt: nowIso(),
  };
  db.insert(schema.researchModeDaily)
    .values(values)
    .onConflictDoUpdate({ target: schema.researchModeDaily.id, set: values })
    .run();
}

// ---- 事件 ----

export function listEvents(modeId: string, limit = 60): ResearchModeEvent[] {
  return db
    .select()
    .from(schema.researchModeEvents)
    .where(eq(schema.researchModeEvents.modeId, modeId))
    .orderBy(desc(schema.researchModeEvents.date), desc(schema.researchModeEvents.createdAt))
    .limit(limit)
    .all()
    .map((r) => ({
      id: r.id,
      modeId: r.modeId,
      date: r.date,
      kind: r.kind as ResearchModeEvent['kind'],
      detail: r.detail,
      createdAt: r.createdAt,
    }));
}

export function addEvents(
  modeId: string,
  date: string,
  events: Array<{ kind: ResearchModeEvent['kind']; detail?: string }>,
): void {
  if (!events.length) return;
  const at = nowIso();
  for (const e of events) {
    db.insert(schema.researchModeEvents)
      .values({ id: newId(), modeId, date, kind: e.kind, detail: e.detail ?? null, createdAt: at })
      .run();
  }
}

/** 清除某模式某日已有事件（重跑当日跟踪前去重） */
export function clearEventsOn(modeId: string, date: string): void {
  db.delete(schema.researchModeEvents)
    .where(and(eq(schema.researchModeEvents.modeId, modeId), eq(schema.researchModeEvents.date, date)))
    .run();
}

/**
 * 一次取出所有模式的全部日跟踪并按 modeId 分组。
 * 列表页要对每个模式算晋级门，逐个 orderedDaily 是 N+1 全表读；这里一趟查完在内存分组。
 */
export function allOrderedDaily(): Map<string, ResearchModeDaily[]> {
  const rows = db
    .select()
    .from(schema.researchModeDaily)
    .orderBy(asc(schema.researchModeDaily.date))
    .all();
  const byMode = new Map<string, ResearchModeDaily[]>();
  for (const r of rows) {
    const arr = byMode.get(r.modeId) ?? [];
    arr.push(dailyToApi(r));
    byMode.set(r.modeId, arr);
  }
  return byMode;
}

export function orderedDaily(modeId: string): ResearchModeDaily[] {
  return db
    .select()
    .from(schema.researchModeDaily)
    .where(eq(schema.researchModeDaily.modeId, modeId))
    .orderBy(asc(schema.researchModeDaily.date))
    .all()
    .map(dailyToApi);
}
