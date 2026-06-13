import { desc, eq, and, inArray } from 'drizzle-orm';
import type { RunTrigger, RunStatus, MessageRole } from '@stock-agent/shared';
import { db, schema } from './db/client';
import { newId, nowIso } from './util';
import { broadcast } from './ws';

// ===== 运行记录 =====

export function createRun(input: {
  taskId: string | null;
  taskName: string | null;
  trigger: RunTrigger;
  inputPrompt: string;
}): string {
  const id = newId();
  db.insert(schema.taskRuns)
    .values({
      id,
      taskId: input.taskId,
      taskName: input.taskName,
      trigger: input.trigger,
      status: 'running',
      startedAt: nowIso(),
      finishedAt: null,
      inputPrompt: input.inputPrompt,
      outputText: null,
      promptTokens: null,
      completionTokens: null,
      error: null,
    })
    .run();
  // 全局广播：任何路径建立的 run 都进入「Agent 运行中」抽屉
  broadcast({ type: 'run_started', runId: id });
  return id;
}

export function finishRun(
  runId: string,
  patch: {
    status: RunStatus;
    outputText?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    error?: string | null;
  },
): void {
  db.update(schema.taskRuns)
    .set({
      status: patch.status,
      finishedAt: nowIso(),
      outputText: patch.outputText ?? null,
      promptTokens: patch.promptTokens ?? null,
      completionTokens: patch.completionTokens ?? null,
      error: patch.error ?? null,
    })
    .where(eq(schema.taskRuns.id, runId))
    .run();
  // 全局广播：run 结束（成功/失败/超时）即从「运行中」列表清除
  broadcast({ type: 'run_finished', runId, status: patch.status });
}

/**
 * 启动时回收孤儿运行：进程刚启动时不可能有正在执行的 run，
 * 任何残留的 status='running' 都是上一个进程异常退出（如 tsx watch 重启）遗留的，
 * 标记为 error 以免前端永远显示「运行中」。
 */
export function reconcileOrphanRuns(): number {
  const res = db
    .update(schema.taskRuns)
    .set({
      status: 'error',
      finishedAt: nowIso(),
      error: '运行中断（服务重启或异常退出）',
    })
    .where(eq(schema.taskRuns.status, 'running'))
    .run();
  return res.changes;
}

/** 取某任务最近一次运行的 startedAt（ISO），无运行记录返回 null。用于 missed-run 判定。 */
export function getLastRunStartedAt(taskId: string): string | null {
  const row = db
    .select({ startedAt: schema.taskRuns.startedAt })
    .from(schema.taskRuns)
    .where(eq(schema.taskRuns.taskId, taskId))
    .orderBy(desc(schema.taskRuns.startedAt))
    .limit(1)
    .get();
  return row?.startedAt ?? null;
}

let msgSeq = new Map<string, number>();

export function appendRunMessage(input: {
  runId: string;
  role: MessageRole;
  content?: string | null;
  toolCalls?: string | null;
  toolName?: string | null;
}): void {
  const seq = (msgSeq.get(input.runId) ?? 0) + 1;
  msgSeq.set(input.runId, seq);
  db.insert(schema.runMessages)
    .values({
      id: newId(),
      runId: input.runId,
      seq,
      role: input.role,
      content: input.content ?? null,
      toolCalls: input.toolCalls ?? null,
      toolName: input.toolName ?? null,
      createdAt: nowIso(),
    })
    .run();
}

export function listRuns(limit = 50) {
  return db
    .select()
    .from(schema.taskRuns)
    .orderBy(desc(schema.taskRuns.startedAt))
    .limit(limit)
    .all();
}

/** 按任务 id 集合倒序取运行记录（用于战法「每日产出」聚合）。空集合直接返回空数组。 */
export function listRunsByTaskIds(taskIds: string[], limit = 200) {
  if (taskIds.length === 0) return [];
  return db
    .select()
    .from(schema.taskRuns)
    .where(inArray(schema.taskRuns.taskId, taskIds))
    .orderBy(desc(schema.taskRuns.startedAt))
    .limit(limit)
    .all();
}

/** 复盘历史：筛选「一键复盘」成功运行，返回结构化 JSON 输出供前端重渲染 */
export function listReviews(limit = 50) {
  return db
    .select({
      id: schema.taskRuns.id,
      createdAt: schema.taskRuns.startedAt,
      finishedAt: schema.taskRuns.finishedAt,
      outputText: schema.taskRuns.outputText,
    })
    .from(schema.taskRuns)
    .where(
      and(eq(schema.taskRuns.taskName, '一键复盘'), eq(schema.taskRuns.status, 'success')),
    )
    .orderBy(desc(schema.taskRuns.startedAt))
    .limit(limit)
    .all();
}

/** 研报机会历史：筛选「研报机会」成功运行，返回结构化 JSON 输出供前端重渲染 */
export function listResearchReviews(limit = 50) {
  return db
    .select({
      id: schema.taskRuns.id,
      createdAt: schema.taskRuns.startedAt,
      finishedAt: schema.taskRuns.finishedAt,
      outputText: schema.taskRuns.outputText,
    })
    .from(schema.taskRuns)
    .where(
      and(eq(schema.taskRuns.taskName, '研报机会'), eq(schema.taskRuns.status, 'success')),
    )
    .orderBy(desc(schema.taskRuns.startedAt))
    .limit(limit)
    .all();
}

/** 大盘复盘点评历史：筛选「大盘复盘点评」成功运行，返回点评正文供今日计划引用 */
export function listMarketReviews(limit = 50) {
  return db
    .select({
      id: schema.taskRuns.id,
      createdAt: schema.taskRuns.startedAt,
      finishedAt: schema.taskRuns.finishedAt,
      outputText: schema.taskRuns.outputText,
    })
    .from(schema.taskRuns)
    .where(
      and(eq(schema.taskRuns.taskName, '大盘复盘点评'), eq(schema.taskRuns.status, 'success')),
    )
    .orderBy(desc(schema.taskRuns.startedAt))
    .limit(limit)
    .all();
}

// ===== 热点 AI 研判历史 =====

/** 落库一次热点 AI 研判，返回生成的记录 id 与时间 */
export function insertTrendSummary(input: {
  reportType: string;
  content: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
}): { id: string; createdAt: string } {
  const id = newId();
  const createdAt = nowIso();
  db.insert(schema.trendSummaries)
    .values({
      id,
      reportType: input.reportType,
      content: input.content,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      createdAt,
    })
    .run();
  return { id, createdAt };
}

/** 热点 AI 研判历史（按生成时间倒序） */
export function listTrendSummaries(limit = 30) {
  return db
    .select()
    .from(schema.trendSummaries)
    .orderBy(desc(schema.trendSummaries.createdAt))
    .limit(limit)
    .all();
}

export function getRun(runId: string) {
  const run = db
    .select()
    .from(schema.taskRuns)
    .where(eq(schema.taskRuns.id, runId))
    .get();
  const messages = db
    .select()
    .from(schema.runMessages)
    .where(eq(schema.runMessages.runId, runId))
    .orderBy(schema.runMessages.seq)
    .all();
  return { run, messages };
}
