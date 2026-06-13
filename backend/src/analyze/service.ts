import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AiAnalysisHistoryItem } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso } from '../util';

// 公共 AI 分析历史读写（ai_analyses 表），按 (kind, refKey) 划分作用域。

export function saveAnalysis(input: {
  kind: string;
  refKey: string | null;
  title: string | null;
  runId: string | null;
  content: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
}): void {
  db.insert(schema.aiAnalyses)
    .values({
      id: newId(),
      kind: input.kind,
      refKey: input.refKey,
      title: input.title,
      runId: input.runId,
      content: input.content,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      createdAt: nowIso(),
    })
    .run();
}

/**
 * 取某 kind 的历史，按时间倒序。
 * - opts.allRefKeys=true：忽略 refKey，列出该 kind 全部记录（跨标的全局历史）。
 * - 否则 refKey 非空按精确作用域匹配，refKey 为空查无作用域（isNull）记录。
 */
export function listAnalyses(
  kind: string,
  refKey: string | null,
  limit = 30,
  opts?: { allRefKeys?: boolean },
): AiAnalysisHistoryItem[] {
  const scope = opts?.allRefKeys
    ? eq(schema.aiAnalyses.kind, kind)
    : refKey
      ? and(eq(schema.aiAnalyses.kind, kind), eq(schema.aiAnalyses.refKey, refKey))
      : and(eq(schema.aiAnalyses.kind, kind), isNull(schema.aiAnalyses.refKey));
  const rows = db
    .select({
      id: schema.aiAnalyses.id,
      kind: schema.aiAnalyses.kind,
      refKey: schema.aiAnalyses.refKey,
      title: schema.aiAnalyses.title,
      content: schema.aiAnalyses.content,
      createdAt: schema.aiAnalyses.createdAt,
    })
    .from(schema.aiAnalyses)
    .where(scope)
    .orderBy(desc(schema.aiAnalyses.createdAt))
    .limit(limit)
    .all();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    refKey: r.refKey ?? null,
    title: r.title ?? null,
    content: r.content,
    createdAt: r.createdAt,
  }));
}
