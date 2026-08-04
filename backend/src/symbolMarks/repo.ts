import { and, desc, eq } from 'drizzle-orm';
import type { SymbolMark, SymbolMarkInput, SymbolMarkKind, SymbolMarkPoint } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso } from '../util';

/**
 * 各形态允许的点数：point 一个点，range/trend_line 两个点。
 * price_line 允许 1 或 2 个：一个点是水平线，两个点是价格带（下沿 + 上沿），
 * 计划里的区间型价位就走后者，前端据点数分派成线或带。
 */
const POINT_COUNTS: Record<SymbolMarkKind, number[]> = {
  price_line: [1, 2],
  point: [1],
  range: [2],
  trend_line: [2],
};

/** 校验失败抛此错，路由与工具层据此回 400 / 错误文案 */
export class SymbolMarkError extends Error {}

/** 标注入参校验：kind 合法、点数匹配、各形态必需字段齐全。返回规整后的点位数组。 */
function normalizePoints(kind: SymbolMarkKind, points: unknown): SymbolMarkPoint[] {
  const need = POINT_COUNTS[kind];
  if (need === undefined) throw new SymbolMarkError(`未知标注形态 ${String(kind)}`);
  if (!Array.isArray(points) || !need.includes(points.length)) {
    throw new SymbolMarkError(
      `${kind} 需要 ${need.join(' 或 ')} 个点位，实际 ${Array.isArray(points) ? points.length : 0} 个`,
    );
  }
  return points.map((raw, i) => {
    const p = (raw ?? {}) as SymbolMarkPoint;
    const price = typeof p.price === 'number' && Number.isFinite(p.price) ? p.price : null;
    const time = typeof p.time === 'string' && p.time.trim() ? p.time.trim() : null;
    if (price === null) throw new SymbolMarkError(`第 ${i + 1} 个点位缺少有效 price`);
    // 价位线是全时段水平线，不需要时间；其余形态必须落到具体 K 线上
    if (kind !== 'price_line' && time === null) {
      throw new SymbolMarkError(`${kind} 的第 ${i + 1} 个点位缺少 time（YYYY-MM-DD 或 YYYY-MM-DD HH:mm）`);
    }
    return { time, price };
  });
}

/** DB 行 → DTO，points 反序列化失败时降级为空数组（不让脏数据打断整个列表） */
function toDto(row: typeof schema.symbolMarks.$inferSelect): SymbolMark {
  let points: SymbolMarkPoint[] = [];
  try {
    const parsed: unknown = JSON.parse(row.points);
    if (Array.isArray(parsed)) points = parsed as SymbolMarkPoint[];
  } catch {
    /* 脏数据按空点位处理 */
  }
  return {
    id: row.id,
    code: row.code,
    kind: row.kind as SymbolMarkKind,
    label: row.label,
    note: row.note,
    points,
    color: row.color,
    sessionId: row.sessionId,
    runId: row.runId,
    createdAt: row.createdAt,
    semanticKey: row.semanticKey,
    timeframe: row.timeframe as SymbolMark['timeframe'],
    role: row.role,
    planId: row.planId,
    planVersion: row.planVersion,
    // 老数据 status 为空视为 active
    status: (row.status as SymbolMark['status']) ?? 'active',
    invalidatedAt: row.invalidatedAt,
  };
}

/**
 * 列出标注，默认只返回 status='active'。
 * 计划标注按版本 historize 而不删（status='historical'），若把历史版本一起返回，
 * 模型/图表会把作废的支撑压力位当成现有标注继续引用。
 * @param includeHistorical 仅版本溯源等确实需要看历史的场景才置 true
 */
export function listMarks(code: string, includeHistorical = false): SymbolMark[] {
  const rows = db
    .select()
    .from(schema.symbolMarks)
    .where(eq(schema.symbolMarks.code, code))
    .orderBy(desc(schema.symbolMarks.createdAt))
    .all();
  // 老数据 status 为空视为 active
  return rows.filter((r) => includeHistorical || (r.status ?? 'active') === 'active').map(toDto);
}

export function addMark(input: SymbolMarkInput): SymbolMark {
  const code = input.code?.trim();
  const label = input.label?.trim();
  if (!code) throw new SymbolMarkError('缺少 code');
  if (!label) throw new SymbolMarkError('缺少 label');
  const points = normalizePoints(input.kind, input.points);
  // 计划相关字段留空：手工标注不属于任何计划版本，status 为 active 表示当前有效
  const row: typeof schema.symbolMarks.$inferSelect = {
    id: newId(),
    code,
    kind: input.kind,
    label,
    note: input.note?.trim() || null,
    points: JSON.stringify(points),
    color: input.color?.trim() || null,
    sessionId: input.sessionId || null,
    runId: input.runId || null,
    createdAt: nowIso(),
    semanticKey: null,
    timeframe: null,
    role: null,
    planId: null,
    planVersion: null,
    status: 'active',
    invalidatedAt: null,
  };
  db.insert(schema.symbolMarks).values(row).run();
  return toDto(row);
}

/**
 * 删除标注。
 * plan_id 非空的计划标注一律拒删（与 removeMarkByLabel 的保护口径一致）：
 * 计划版本必须可追溯，只能随新版本 historize，不能被按 id 逐条抹掉。
 * @returns ok=已删 / not_found=本就不存在 / plan_protected=计划标注受保护
 */
export function removeMark(id: string): 'ok' | 'not_found' | 'plan_protected' {
  const hit = db.select().from(schema.symbolMarks).where(eq(schema.symbolMarks.id, id)).get();
  if (!hit) return 'not_found';
  if (hit.planId != null) return 'plan_protected';
  db.delete(schema.symbolMarks).where(eq(schema.symbolMarks.id, id)).run();
  return 'ok';
}

/**
 * 按 code + label 精确删除：agent 结论更新时先撤旧同名标注，避免图上同义线堆积。
 * 只作用于手工标注（plan_id 为空）——计划标注必须按版本 historize，不能被同名覆盖删掉历史。
 */
export function removeMarkByLabel(code: string, label: string): number {
  const hits = db
    .select()
    .from(schema.symbolMarks)
    .where(and(eq(schema.symbolMarks.code, code), eq(schema.symbolMarks.label, label)))
    .all()
    .filter((h) => h.planId == null);
  for (const h of hits) {
    db.delete(schema.symbolMarks).where(eq(schema.symbolMarks.id, h.id)).run();
  }
  return hits.length;
}
