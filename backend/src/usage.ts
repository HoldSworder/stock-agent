import type OpenAI from 'openai';
import type {
  LlmCallRecord,
  UsageDailyPoint,
  UsageModelStat,
  UsagePurpose,
  UsagePurposeStat,
  UsageSummary,
} from '@stock-agent/shared';
import { db, schema, sqlite } from './db/client';
import { newId, nowIso } from './util';
import { withLlmRetry } from './agent/retry';

// LLM 调用统一计量层：每一次 chat.completions 请求落一行 llm_calls，
// 按用途（purpose）区分，供「调用记录」分析页聚合。落库 best-effort，绝不阻断主流程。

export interface RecordLlmCallInput {
  purpose: UsagePurpose | string;
  model: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  latencyMs?: number;
  success?: boolean;
  error?: string | null;
  runId?: string | null;
  taskName?: string | null;
}

/** 写入一条调用记录（异常仅告警，不抛出） */
export function recordLlmCall(input: RecordLlmCallInput): void {
  try {
    const prompt = Math.max(0, Math.round(input.promptTokens ?? 0));
    const completion = Math.max(0, Math.round(input.completionTokens ?? 0));
    db.insert(schema.llmCalls)
      .values({
        id: newId(),
        purpose: input.purpose,
        model: input.model || 'unknown',
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
        latencyMs: Math.max(0, Math.round(input.latencyMs ?? 0)),
        success: input.success ?? true,
        error: input.error ?? null,
        runId: input.runId ?? null,
        taskName: input.taskName ?? null,
        createdAt: nowIso(),
      })
      .run();
  } catch (e) {
    console.warn('[usage] 记录 LLM 调用失败:', e instanceof Error ? e.message : e);
  }
}

export interface TrackedChatCtx {
  purpose: UsagePurpose | string;
  runId?: string | null;
  taskName?: string | null;
}

/**
 * 非流式 chat.completions 包装：测耗时 → 调用 → 按 res.usage 落库 → 返回。
 * 异常时落败并 rethrow，保证记录覆盖所有非流式调用点。
 */
export async function trackedChat(
  client: OpenAI,
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ctx: TrackedChatCtx,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const startedAt = Date.now();
  try {
    // 与 agent 流式路径一致的瞬时错误退避重试（含 429 Retry-After），提升 oneshot 韧性
    const res = await withLlmRetry(() => client.chat.completions.create(params));
    recordLlmCall({
      purpose: ctx.purpose,
      model: res.model || String(params.model),
      promptTokens: res.usage?.prompt_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - startedAt,
      success: true,
      runId: ctx.runId,
      taskName: ctx.taskName,
    });
    return res;
  } catch (e) {
    recordLlmCall({
      purpose: ctx.purpose,
      model: String(params.model),
      latencyMs: Date.now() - startedAt,
      success: false,
      error: e instanceof Error ? e.message : String(e),
      runId: ctx.runId,
      taskName: ctx.taskName,
    });
    throw e;
  }
}

// ===================== 聚合查询 =====================

/** 把 days 限定到合理范围，返回窗口起始 ISO（UTC） */
function windowStartIso(days: number): string {
  const d = Math.min(Math.max(Math.round(days) || 30, 1), 365);
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
}

interface SumRow {
  calls: number;
  prompt: number;
  completion: number;
  total: number;
  ok: number;
}

/** 调用记录总览：总计 + 按用途 + 按模型 + 每日趋势（Asia/Shanghai 自然日） */
export function getUsageSummary(days = 30): UsageSummary {
  const d = Math.min(Math.max(Math.round(days) || 30, 1), 365);
  const since = windowStartIso(d);

  const totalsRow = sqlite
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens),0) AS prompt,
              COALESCE(SUM(completion_tokens),0) AS completion,
              COALESCE(SUM(total_tokens),0) AS total,
              COALESCE(SUM(success),0) AS ok
       FROM llm_calls WHERE created_at >= ?`,
    )
    .get(since) as SumRow;

  const totals = {
    calls: totalsRow.calls,
    promptTokens: totalsRow.prompt,
    completionTokens: totalsRow.completion,
    totalTokens: totalsRow.total,
    successRate:
      totalsRow.calls > 0 ? Math.round((totalsRow.ok / totalsRow.calls) * 1000) / 10 : null,
  };

  const byPurpose = sqlite
    .prepare(
      `SELECT purpose,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens),0) AS promptTokens,
              COALESCE(SUM(completion_tokens),0) AS completionTokens,
              COALESCE(SUM(total_tokens),0) AS totalTokens
       FROM llm_calls WHERE created_at >= ?
       GROUP BY purpose ORDER BY totalTokens DESC`,
    )
    .all(since) as UsagePurposeStat[];

  const byModel = sqlite
    .prepare(
      `SELECT model,
              COUNT(*) AS calls,
              COALESCE(SUM(total_tokens),0) AS totalTokens
       FROM llm_calls WHERE created_at >= ?
       GROUP BY model ORDER BY totalTokens DESC`,
    )
    .all(since) as UsageModelStat[];

  const daily = sqlite
    .prepare(
      `SELECT date(created_at, '+8 hours') AS date,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens),0) AS promptTokens,
              COALESCE(SUM(completion_tokens),0) AS completionTokens,
              COALESCE(SUM(total_tokens),0) AS totalTokens
       FROM llm_calls WHERE created_at >= ?
       GROUP BY date ORDER BY date ASC`,
    )
    .all(since) as UsageDailyPoint[];

  return { days: d, totals, byPurpose, byModel, daily };
}

/** 最近调用明细（可按用途过滤） */
export function listLlmCalls(limit = 100, purpose?: string): LlmCallRecord[] {
  const lim = Math.min(Math.max(Math.round(limit) || 100, 1), 1000);
  const base =
    `SELECT id, purpose, model,
            prompt_tokens AS promptTokens,
            completion_tokens AS completionTokens,
            total_tokens AS totalTokens,
            latency_ms AS latencyMs,
            success, error, run_id AS runId, task_name AS taskName,
            created_at AS createdAt
     FROM llm_calls`;
  if (purpose) {
    const rows = sqlite
      .prepare(`${base} WHERE purpose = ? ORDER BY created_at DESC LIMIT ?`)
      .all(purpose, lim) as (Omit<LlmCallRecord, 'success'> & { success: number })[];
    return rows.map((r) => ({ ...r, success: !!r.success }));
  }
  const rows = sqlite
    .prepare(`${base} ORDER BY created_at DESC LIMIT ?`)
    .all(lim) as (Omit<LlmCallRecord, 'success'> & { success: number })[];
  return rows.map((r) => ({ ...r, success: !!r.success }));
}
