import { and, desc, eq } from 'drizzle-orm';
import type { DecisionMemoryItem, DecisionResult } from '@stock-agent/shared';
import { db } from '../db/client';
import { decisionMemory } from '../db/schema';
import { shanghaiDate } from '../strategy/sim';
import { newId, nowIso } from '../util';

type MemoryRow = typeof decisionMemory.$inferSelect;

/** 行 → 领域对象（drizzle 数值字段已是 number|null，无需再解析） */
function rowToItem(row: MemoryRow): DecisionMemoryItem {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    decisionDate: row.decisionDate,
    action: row.action as DecisionMemoryItem['action'],
    confidence: row.confidence,
    entryPrice: row.entryPrice,
    targetPrice: row.targetPrice,
    stopLoss: row.stopLoss,
    positionPct: row.positionPct,
    thesis: row.thesis ?? '',
    status: row.status === 'reviewed' ? 'reviewed' : 'pending',
    reviewedAt: row.reviewedAt,
    reviewPrice: row.reviewPrice,
    stockReturn: row.stockReturn,
    csi300Return: row.csi300Return,
    alpha: row.alpha,
    verdict: (row.verdict as DecisionMemoryItem['verdict']) ?? null,
    lesson: row.lesson,
    createdAt: row.createdAt,
  };
}

/**
 * 决策成功后写入一条 pending 记忆（含入场价快照），供反思任务到期复盘。
 * entryPrice 优先取实时现价，缺省回退目标价；失败不抛（决策主流程不应被记忆写入拖垮）。
 */
export function recordDecision(result: DecisionResult, entryPrice: number | null): DecisionMemoryItem | null {
  try {
    const row = {
      id: newId(),
      code: result.code,
      name: result.name,
      decisionDate: shanghaiDate(),
      action: result.action,
      confidence: result.confidence,
      entryPrice: entryPrice ?? result.targetPrice ?? null,
      targetPrice: result.targetPrice ?? null,
      stopLoss: result.stopLoss ?? null,
      positionPct: result.positionPct ?? null,
      thesis: result.thesis,
      status: 'pending' as const,
      reviewedAt: null,
      reviewPrice: null,
      stockReturn: null,
      csi300Return: null,
      alpha: null,
      verdict: null,
      lesson: null,
      createdAt: nowIso(),
    };
    db.insert(decisionMemory).values(row).run();
    return rowToItem(row as MemoryRow);
  } catch {
    return null;
  }
}

/** 取某标的已复盘、含教训的历史记忆（按决策日倒序），供后续决策注入。 */
export function listLessons(code: string, limit = 3): DecisionMemoryItem[] {
  try {
    const rows = db
      .select()
      .from(decisionMemory)
      .where(and(eq(decisionMemory.code, code), eq(decisionMemory.status, 'reviewed')))
      .orderBy(desc(decisionMemory.decisionDate))
      .limit(limit)
      .all();
    return rows.filter((r) => r.lesson).map(rowToItem);
  } catch {
    return [];
  }
}

/** 取所有待复盘记忆（status=pending），供反思任务筛选到期项。 */
export function listPending(): DecisionMemoryItem[] {
  try {
    const rows = db
      .select()
      .from(decisionMemory)
      .where(eq(decisionMemory.status, 'pending'))
      .orderBy(desc(decisionMemory.decisionDate))
      .all();
    return rows.map(rowToItem);
  } catch {
    return [];
  }
}

/** 复盘回写：填入收益/Alpha/定性/教训并置 reviewed。 */
export function markReviewed(
  id: string,
  patch: {
    reviewPrice: number | null;
    stockReturn: number | null;
    csi300Return: number | null;
    alpha: number | null;
    verdict: DecisionMemoryItem['verdict'];
    lesson: string | null;
  },
): void {
  db.update(decisionMemory)
    .set({
      status: 'reviewed',
      reviewedAt: nowIso(),
      reviewPrice: patch.reviewPrice,
      stockReturn: patch.stockReturn,
      csi300Return: patch.csi300Return,
      alpha: patch.alpha,
      verdict: patch.verdict,
      lesson: patch.lesson,
    })
    .where(eq(decisionMemory.id, id))
    .run();
}
