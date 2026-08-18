import { and, desc, eq, gte, isNull, lt } from 'drizzle-orm';
import type {
  WatchAlert,
  WatchInstruction,
  WatchSource,
  WatchSignalType,
  WatchSeverity,
  WatchStats,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso, shanghaiDayStartIso } from '../util';

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
    instruction: parseInstruction(r.instructionJson),
    createdAt: r.createdAt,
  };
}

/** 反序列化执行指令 JSON（坏数据容错为 null，不阻断列表） */
function parseInstruction(raw: string | null): WatchInstruction | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WatchInstruction;
  } catch {
    return null;
  }
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
  instruction?: WatchInstruction | null;
}): WatchAlert {
  const id = newId();
  const createdAt = nowIso();
  const { instruction, ...rest } = input;
  db.insert(schema.watchAlerts)
    .values({
      id,
      createdAt,
      ...rest,
      instructionJson: instruction ? JSON.stringify(instruction) : null,
    })
    .run();
  return rowToDto(
    db.select().from(schema.watchAlerts).where(eq(schema.watchAlerts.id, id)).get()!,
  );
}

/**
 * limit 入参钳制。路由层传的是 `Number(req.query.limit)`，非数字会得到 NaN，
 * 直接绑进 SQL 会让接口 500（用户看到的是「告警列表打不开」而不是「参数错了」）。
 */
function clampLimit(limit: number | undefined, def: number, max = 500): number {
  return typeof limit === 'number' && Number.isFinite(limit)
    ? Math.min(Math.max(Math.floor(limit), 1), max)
    : def;
}

export function listAlerts(limit = 100): WatchAlert[] {
  return db
    .select()
    .from(schema.watchAlerts)
    .orderBy(desc(schema.watchAlerts.createdAt))
    .limit(clampLimit(limit, 100))
    .all()
    .map(rowToDto);
}

/** 今日告警计数（按 ISO 日期前缀粗匹配，本地工具够用） */
export function countAlertsToday(): number {
  return db
    .select()
    .from(schema.watchAlerts)
    .where(gte(schema.watchAlerts.createdAt, shanghaiDayStartIso()))
    .all().length;
}

/**
 * 查近期是否已对该 code 的「同类同级」信号出过研判（缓存复用判断），返回最近一条。
 *
 * 必须带上 signalType/severity 并排除 shouldAlert=false 的沉默/初筛留痕：
 * 只按 code 匹配时，一条 low 级 breakout 被初筛拦下所落的 `跳过(初筛)` 记录，
 * 会让同一只票随后的止损/炸板/计划止损在整个复用窗口内被整条丢弃（既不落库也不推送）。
 */
export function findRecentAlertByCode(
  code: string,
  withinMin: number,
  opts: { signalType?: WatchSignalType; severity?: WatchSeverity } = {},
): WatchAlert | null {
  const since = new Date(Date.now() - withinMin * 60_000).toISOString();
  const conds = [
    eq(schema.watchAlerts.code, code),
    gte(schema.watchAlerts.createdAt, since),
    eq(schema.watchAlerts.shouldAlert, true),
  ];
  if (opts.signalType) conds.push(eq(schema.watchAlerts.signalType, opts.signalType));
  if (opts.severity) conds.push(eq(schema.watchAlerts.severity, opts.severity));
  const row = db
    .select()
    .from(schema.watchAlerts)
    .where(and(...conds))
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

/**
 * 成本与命中率统计（成熟样本基于全量 outcome；token/拦截按当日）。
 * 当日窗口必须与 countAlertsToday 同口径走上海日切：用 UTC 日期前缀时，
 * 凌晨 0–8 点两个「今日告警数」（WatchStatus 与 WatchStats）会互相打架。
 */
export function getStats(): WatchStats {
  const todayRows = db
    .select()
    .from(schema.watchAlerts)
    .where(gte(schema.watchAlerts.createdAt, shanghaiDayStartIso()))
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

/**
 * 死信队列：待重投的告警（应推送但未投递成功）。
 *
 * 必须带时间下界：Telegram 配错期间会持续积累未投递记录，配好之后一次性成批补发，
 * 跨日的旧卖点补发只是有害噪声（当时的价位与结论都已失效）。
 */
export function listUndelivered(limit = 20, withinHours = 12): WatchAlert[] {
  const since = new Date(Date.now() - Math.max(1, withinHours) * 3_600_000).toISOString();
  return db
    .select()
    .from(schema.watchAlerts)
    .where(
      and(
        eq(schema.watchAlerts.shouldAlert, true),
        eq(schema.watchAlerts.delivered, false),
        gte(schema.watchAlerts.createdAt, since),
      ),
    )
    .orderBy(desc(schema.watchAlerts.createdAt))
    .limit(clampLimit(limit, 20, 100))
    .all()
    .map(rowToDto);
}

export function markDelivered(id: string): void {
  db.update(schema.watchAlerts)
    .set({ delivered: true })
    .where(eq(schema.watchAlerts.id, id))
    .run();
}
