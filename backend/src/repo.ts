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

/**
 * 进程优雅关闭时调用：把仍在执行的 run 标为 canceled（而非 error）。
 * 与 reconcileOrphanRuns 区分语义——本进程主动正常退出（开发热更新 / 手动重启）导致的中断，
 * 不应在「失败」统计里污染，下次启动也无需再被当作崩溃孤儿回收。
 */
export function cancelRunningRunsOnShutdown(): number {
  const res = db
    .update(schema.taskRuns)
    .set({
      status: 'canceled',
      finishedAt: nowIso(),
      error: '服务正常重启（开发热更新）',
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

/**
 * 通用任务运行历史：按 taskName 筛选成功运行，倒序返回结构化输出。
 * 复盘/研报机会/板块主线/ETF 轮动/大盘点评等「taskRun 型 AI 分析」共用，
 * 既供前端历史重渲染，也供统一 AI 分析中心按 kind 路由历史。
 */
export function listTaskRunHistory(taskName: string, limit = 50) {
  return db
    .select({
      id: schema.taskRuns.id,
      createdAt: schema.taskRuns.startedAt,
      finishedAt: schema.taskRuns.finishedAt,
      outputText: schema.taskRuns.outputText,
    })
    .from(schema.taskRuns)
    .where(and(eq(schema.taskRuns.taskName, taskName), eq(schema.taskRuns.status, 'success')))
    .orderBy(desc(schema.taskRuns.startedAt))
    .limit(limit)
    .all();
}

/** 复盘历史：筛选「一键复盘」成功运行，返回结构化 JSON 输出供前端重渲染 */
export function listReviews(limit = 50) {
  return listTaskRunHistory('一键复盘', limit);
}

/** 研报机会历史：筛选「研报机会」成功运行，返回结构化 JSON 输出供前端重渲染 */
export function listResearchReviews(limit = 50) {
  return listTaskRunHistory('研报机会', limit);
}

/** 板块主线研判历史：筛选「板块主线研判」成功运行，返回研判正文供今日计划/大盘页引用 */
export function listBoardStrengthReviews(limit = 50) {
  return listTaskRunHistory('板块主线研判', limit);
}

/** ETF 行业轮动研判历史：筛选「ETF行业轮动研判」成功运行，供今日计划引用与 ETF 页展示 */
export function listEtfRotationReviews(limit = 50) {
  return listTaskRunHistory('ETF行业轮动研判', limit);
}

/** 大盘复盘点评历史：筛选「大盘复盘点评」成功运行，返回点评正文供今日计划引用 */
export function listMarketReviews(limit = 50) {
  return listTaskRunHistory('大盘复盘点评', limit);
}

/**
 * 通用：多 taskName 并集历史（合并 kind 的 loadHistory 用，union 旧 taskName 保历史不丢）。
 * 同 listTaskRunHistory，仅 taskName 由单值改为 inArray 多值。
 */
export function listTaskRunHistoryUnion(taskNames: string[], limit = 50) {
  if (taskNames.length === 0) return [];
  return db
    .select({
      id: schema.taskRuns.id,
      createdAt: schema.taskRuns.startedAt,
      finishedAt: schema.taskRuns.finishedAt,
      outputText: schema.taskRuns.outputText,
    })
    .from(schema.taskRuns)
    .where(and(inArray(schema.taskRuns.taskName, taskNames), eq(schema.taskRuns.status, 'success')))
    .orderBy(desc(schema.taskRuns.startedAt))
    .limit(limit)
    .all();
}

/** 大盘与板块研判（合并 kind）历史：新 taskName + 旧 大盘复盘点评/板块主线研判/期货+外盘复盘，保历史不丢 */
export function listMarketBoardReviews(limit = 50) {
  return listTaskRunHistoryUnion(['大盘与板块研判', '大盘复盘点评', '板块主线研判', '期货+外盘复盘'], limit);
}

/** ETF 综合研判（合并 kind）历史：ETF 综合研判 + 旧 ETF行业轮动研判/ETF 市场点评，保历史不丢 */
export function listEtfAnalyzeReviews(limit = 50) {
  return listTaskRunHistoryUnion(['ETF 综合研判', 'ETF行业轮动研判', 'ETF 市场点评'], limit);
}

/** 情报研判（合并 kind）历史：情报研判 + 旧 研报机会，保历史不丢（旧热点研判落 trend_summaries，不在此并） */
export function listIntelReviews(limit = 50) {
  return listTaskRunHistoryUnion(['情报研判', '研报机会'], limit);
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
