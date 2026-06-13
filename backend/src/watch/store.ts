import { and, desc, eq, gte, isNull, lt } from 'drizzle-orm';
import type {
  WatchAlert,
  WatchSource,
  WatchSignalType,
  WatchSeverity,
  WatchStats,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso } from '../util';

// 盯盘告警 DB 读写：自管，不进 repo.ts，保持模块独立。

type Row = typeof schema.watchAlerts.$inferSelect;

function rowToDto(r: Row): WatchAlert {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    source: r.source as WatchSource,
    signalType: r.signalType as WatchSignalType,
    severity: r.severity as WatchSeverity,
    detail: r.detail,
    runId: r.runId ?? null,
    adviceText: r.adviceText ?? null,
    verdict: r.verdict ?? null,
    shouldAlert: r.shouldAlert,
    delivered: r.delivered,
    triggerPrice: r.triggerPrice ?? 0,
    outcome: (r.outcome as WatchAlert['outcome']) ?? null,
    outcomePct: r.outcomePct ?? null,
    promptTokens: r.promptTokens ?? null,
    completionTokens: r.completionTokens ?? null,
    strategyId: r.strategyId ?? null,
    strategyName: r.strategyName ?? null,
    execStatus: (r.execStatus as WatchAlert['execStatus']) ?? null,
    execNote: r.execNote ?? null,
    createdAt: r.createdAt,
  };
}

export function insertAlert(input: {
  code: string;
  name: string;
  source: WatchSource;
  signalType: WatchSignalType;
  severity: WatchSeverity;
  detail: string;
  runId: string | null;
  adviceText: string | null;
  verdict: string | null;
  shouldAlert: boolean;
  delivered: boolean;
  triggerPrice?: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  strategyId?: string | null;
  strategyName?: string | null;
  execStatus?: 'executed' | 'skipped' | null;
  execNote?: string | null;
}): WatchAlert {
  const id = newId();
  const createdAt = nowIso();
  db.insert(schema.watchAlerts)
    .values({ id, createdAt, ...input })
    .run();
  return rowToDto(
    db.select().from(schema.watchAlerts).where(eq(schema.watchAlerts.id, id)).get()!,
  );
}

export function listAlerts(limit = 100): WatchAlert[] {
  return db
    .select()
    .from(schema.watchAlerts)
    .orderBy(desc(schema.watchAlerts.createdAt))
    .limit(limit)
    .all()
    .map(rowToDto);
}

/** 今日告警计数（按 ISO 日期前缀粗匹配，本地工具够用） */
export function countAlertsToday(): number {
  const todayPrefix = nowIso().slice(0, 10);
  return db
    .select()
    .from(schema.watchAlerts)
    .where(gte(schema.watchAlerts.createdAt, todayPrefix))
    .all().length;
}

/** 查近期是否已对该 code 出过研判（缓存复用判断），返回最近一条 */
export function findRecentAlertByCode(code: string, withinMin: number): WatchAlert | null {
  const since = new Date(Date.now() - withinMin * 60_000).toISOString();
  const row = db
    .select()
    .from(schema.watchAlerts)
    .where(and(eq(schema.watchAlerts.code, code), gte(schema.watchAlerts.createdAt, since)))
    .orderBy(desc(schema.watchAlerts.createdAt))
    .get();
  return row ? rowToDto(row) : null;
}

/** 取某标的近期告警（倒序），用于历史研判对比注入 */
export function listAlertsByCode(code: string, limit = 3): WatchAlert[] {
  return db
    .select()
    .from(schema.watchAlerts)
    .where(eq(schema.watchAlerts.code, code))
    .orderBy(desc(schema.watchAlerts.createdAt))
    .limit(limit)
    .all()
    .map(rowToDto);
}

/** 待回看告警：尚无 outcome 且创建于 beforeDay（YYYY-MM-DD）之前 */
export function listPendingOutcomes(beforeDay: string, limit = 200): WatchAlert[] {
  return db
    .select()
    .from(schema.watchAlerts)
    .where(and(isNull(schema.watchAlerts.outcome), lt(schema.watchAlerts.createdAt, beforeDay)))
    .orderBy(desc(schema.watchAlerts.createdAt))
    .limit(limit)
    .all()
    .map(rowToDto);
}

/** 回填应验结果 */
export function setOutcome(id: string, outcome: 'hit' | 'miss' | 'flat', pct: number): void {
  db.update(schema.watchAlerts)
    .set({ outcome, outcomePct: pct })
    .where(eq(schema.watchAlerts.id, id))
    .run();
}

/** 成本与命中率统计（成熟样本基于全量 outcome；token/拦截按当日） */
export function getStats(): WatchStats {
  const todayPrefix = nowIso().slice(0, 10);
  const todayRows = db
    .select()
    .from(schema.watchAlerts)
    .where(gte(schema.watchAlerts.createdAt, todayPrefix))
    .all();

  let screenedToday = 0;
  let tokensToday = 0;
  for (const r of todayRows) {
    if (r.verdict === '跳过(初筛)' || r.verdict === '跳过(打分门)') screenedToday += 1;
    tokensToday += (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
  }

  const matured = db
    .select()
    .from(schema.watchAlerts)
    .all()
    .filter((r) => r.outcome === 'hit' || r.outcome === 'miss');
  const hit = matured.filter((r) => r.outcome === 'hit').length;
  const maturedCount = matured.length;

  return {
    alertsToday: todayRows.length,
    screenedToday,
    tokensToday,
    hitRate: maturedCount > 0 ? (hit / maturedCount) * 100 : null,
    maturedCount,
  };
}

/** 死信队列：待重投的告警（应推送但未投递成功） */
export function listUndelivered(limit = 20): WatchAlert[] {
  return db
    .select()
    .from(schema.watchAlerts)
    .where(and(eq(schema.watchAlerts.shouldAlert, true), eq(schema.watchAlerts.delivered, false)))
    .orderBy(desc(schema.watchAlerts.createdAt))
    .limit(limit)
    .all()
    .map(rowToDto);
}

export function markDelivered(id: string): void {
  db.update(schema.watchAlerts)
    .set({ delivered: true })
    .where(eq(schema.watchAlerts.id, id))
    .run();
}
