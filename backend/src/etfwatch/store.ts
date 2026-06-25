import { and, desc, eq, gte } from 'drizzle-orm';
import type {
  EtfConfirm,
  EtfExecInstruction,
  EtfTrendStage,
  EtfWatchAlert,
  EtfWatchLayer,
  EtfWatchLayerState,
  EtfWatchSignalType,
  EtfWatchTimeframe,
  EtfWatchVerdict,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso, shanghaiToday } from '../util';

// ETF 盯盘告警与层状态 DB 读写：自管，不进 repo.ts，保持模块独立。

type AlertRow = typeof schema.etfWatchSignals.$inferSelect;

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function rowToAlert(r: AlertRow): EtfWatchAlert {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    signalType: r.signalType as EtfWatchSignalType,
    layer: r.layer,
    timeframe: r.timeframe as EtfWatchTimeframe,
    positionPct: r.positionPct,
    detail: r.detail,
    triggerPrice: r.triggerPrice ?? 0,
    dif: r.dif ?? 0,
    dea: r.dea ?? 0,
    confidence: r.confidence ?? null,
    verdict: (r.verdict as EtfWatchVerdict | null) ?? null,
    advice: r.advice ?? null,
    confirm: parseJson<EtfConfirm>(r.confirmJson),
    instruction: parseJson<EtfExecInstruction>(r.instructionJson),
    trendStage: (r.trendStage as EtfTrendStage | null) ?? null,
    barTime: r.barTime ?? null,
    runId: r.runId ?? null,
    delivered: r.delivered,
    createdAt: r.createdAt,
  };
}

export function insertEtfAlert(input: {
  code: string;
  name: string;
  signalType: EtfWatchSignalType;
  layer: number;
  timeframe: EtfWatchTimeframe;
  positionPct: number;
  detail: string;
  triggerPrice: number;
  dif: number;
  dea: number;
  confidence: number | null;
  verdict: EtfWatchVerdict | null;
  advice: string | null;
  confirm: EtfConfirm | null;
  instruction: EtfExecInstruction | null;
  trendStage: EtfTrendStage | null;
  barTime: string | null;
  runId: string | null;
  delivered: boolean;
}): EtfWatchAlert {
  const id = newId();
  const createdAt = nowIso();
  const { confirm, instruction, trendStage, ...rest } = input;
  db.insert(schema.etfWatchSignals)
    .values({
      id,
      createdAt,
      ...rest,
      confirmJson: confirm ? JSON.stringify(confirm) : null,
      instructionJson: instruction ? JSON.stringify(instruction) : null,
      trendStage: trendStage ?? null,
    })
    .run();
  return rowToAlert(
    db.select().from(schema.etfWatchSignals).where(eq(schema.etfWatchSignals.id, id)).get()!,
  );
}

export function listEtfAlerts(limit = 100, todayOnly = false): EtfWatchAlert[] {
  if (!todayOnly) {
    return db
      .select()
      .from(schema.etfWatchSignals)
      .orderBy(desc(schema.etfWatchSignals.createdAt))
      .limit(limit)
      .all()
      .map(rowToAlert);
  }
  // 仅当日：按上海交易日过滤（createdAt 为 UTC ISO，逐条换算成上海日期比对，避免时区误差），
  // 取足够多再过滤截断，保证当日数据不被历史挤出 limit。
  const today = shanghaiToday();
  return db
    .select()
    .from(schema.etfWatchSignals)
    .orderBy(desc(schema.etfWatchSignals.createdAt))
    .limit(Math.max(limit * 4, 200))
    .all()
    .map(rowToAlert)
    .filter((a) => shanghaiToday(new Date(a.createdAt)) === today)
    .slice(0, limit);
}

export function countEtfAlertsToday(): number {
  const todayPrefix = nowIso().slice(0, 10);
  return db
    .select()
    .from(schema.etfWatchSignals)
    .where(gte(schema.etfWatchSignals.createdAt, todayPrefix))
    .all().length;
}

export function listEtfUndelivered(limit = 20): EtfWatchAlert[] {
  return db
    .select()
    .from(schema.etfWatchSignals)
    .where(
      and(eq(schema.etfWatchSignals.delivered, false), gte(schema.etfWatchSignals.positionPct, 0)),
    )
    .orderBy(desc(schema.etfWatchSignals.createdAt))
    .limit(limit)
    .all()
    .map(rowToAlert);
}

export function markEtfDelivered(id: string): void {
  db.update(schema.etfWatchSignals)
    .set({ delivered: true })
    .where(eq(schema.etfWatchSignals.id, id))
    .run();
}

// ===== 逻辑层状态 =====

type StateRow = typeof schema.etfWatchState.$inferSelect;

function rowToState(r: StateRow): EtfWatchLayerState {
  let heldLayers: EtfWatchLayer[] = [];
  let layerEntryPrice: Record<string, number> = {};
  let layerEntryAt: Record<string, string> = {};
  try {
    const arr = JSON.parse(r.heldLayers) as number[];
    heldLayers = Array.isArray(arr) ? (arr.filter((n) => n >= 1 && n <= 3) as EtfWatchLayer[]) : [];
  } catch {
    heldLayers = [];
  }
  try {
    const obj = JSON.parse(r.layerEntryPrice) as Record<string, number>;
    layerEntryPrice = obj && typeof obj === 'object' ? obj : {};
  } catch {
    layerEntryPrice = {};
  }
  try {
    const obj = JSON.parse(r.layerEntryAt) as Record<string, string>;
    layerEntryAt = obj && typeof obj === 'object' ? obj : {};
  } catch {
    layerEntryAt = {};
  }
  return {
    code: r.code,
    name: r.name,
    heldLayers,
    layerEntryPrice,
    layerEntryAt,
    peakPrice: r.peakPrice ?? 0,
    trendStage: (r.trendStage as EtfTrendStage | null) ?? null,
    updatedAt: r.updatedAt,
  };
}

export function getLayerState(code: string): EtfWatchLayerState | null {
  const row = db
    .select()
    .from(schema.etfWatchState)
    .where(eq(schema.etfWatchState.code, code))
    .get();
  return row ? rowToState(row) : null;
}

export function listLayerStates(): EtfWatchLayerState[] {
  return db.select().from(schema.etfWatchState).all().map(rowToState);
}

export function upsertLayerState(s: EtfWatchLayerState): void {
  const updatedAt = nowIso();
  const values = {
    code: s.code,
    name: s.name,
    heldLayers: JSON.stringify([...s.heldLayers].sort((a, b) => a - b)),
    layerEntryPrice: JSON.stringify(s.layerEntryPrice),
    layerEntryAt: JSON.stringify(s.layerEntryAt ?? {}),
    peakPrice: s.peakPrice,
    trendStage: s.trendStage ?? null,
    updatedAt,
  };
  db.insert(schema.etfWatchState)
    .values(values)
    .onConflictDoUpdate({
      target: schema.etfWatchState.code,
      set: {
        name: values.name,
        heldLayers: values.heldLayers,
        layerEntryPrice: values.layerEntryPrice,
        layerEntryAt: values.layerEntryAt,
        peakPrice: values.peakPrice,
        trendStage: values.trendStage,
        updatedAt,
      },
    })
    .run();
}

export function deleteLayerState(code: string): void {
  db.delete(schema.etfWatchState).where(eq(schema.etfWatchState.code, code)).run();
}

// ===== ETF 份额日快照（按日累积，份额无历史接口） =====

export interface EtfShareDailyRow {
  date: string;
  shares: number;
  close: number;
  volume: number;
}

/** 写入/更新某 ETF 某交易日的份额快照（同日 upsert，幂等） */
export function upsertEtfShareDaily(input: {
  code: string;
  date: string;
  shares: number;
  close: number;
  volume: number;
}): void {
  const updatedAt = nowIso();
  db.insert(schema.etfShareDaily)
    .values({ ...input, updatedAt })
    .onConflictDoUpdate({
      target: [schema.etfShareDaily.code, schema.etfShareDaily.date],
      set: { shares: input.shares, close: input.close, volume: input.volume, updatedAt },
    })
    .run();
}

/** 读取某 ETF 最近 N 个交易日份额快照（升序：旧→新） */
export function listEtfShareDaily(code: string, days = 6): EtfShareDailyRow[] {
  return db
    .select()
    .from(schema.etfShareDaily)
    .where(eq(schema.etfShareDaily.code, code))
    .orderBy(desc(schema.etfShareDaily.date))
    .limit(days)
    .all()
    .map((r) => ({ date: r.date, shares: r.shares, close: r.close, volume: r.volume }))
    .reverse();
}

/** 清空全部建议持仓层（手动重置入口用） */
export function clearAllLayerStates(): void {
  db.delete(schema.etfWatchState).run();
}
