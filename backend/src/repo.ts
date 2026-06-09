import { desc, eq, and, gte, lte } from 'drizzle-orm';
import type {
  RunTrigger,
  RunStatus,
  MessageRole,
  StockPickInput,
} from '@stock-agent/shared';
import { db, schema } from './db/client';
import { newId, nowIso } from './util';

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

// ===== 选股留痕 =====

export function saveStockPicks(
  runId: string | null,
  picks: StockPickInput[],
): number {
  const at = nowIso();
  for (const p of picks) {
    db.insert(schema.stockPicks)
      .values({
        id: newId(),
        runId,
        code: p.code,
        name: p.name,
        price: p.price ?? null,
        reason: p.reason ?? null,
        signals: p.signals ? JSON.stringify(p.signals) : null,
        tags: p.tags ? p.tags.join(',') : null,
        pickedAt: at,
      })
      .run();
  }
  return picks.length;
}

export function listPicks(opts: { from?: string; to?: string; limit?: number }) {
  const conds = [];
  if (opts.from) conds.push(gte(schema.stockPicks.pickedAt, opts.from));
  if (opts.to) conds.push(lte(schema.stockPicks.pickedAt, opts.to));
  const where = conds.length ? and(...conds) : undefined;
  return db
    .select()
    .from(schema.stockPicks)
    .where(where)
    .orderBy(desc(schema.stockPicks.pickedAt))
    .limit(opts.limit ?? 200)
    .all();
}
