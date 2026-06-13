import { eq } from 'drizzle-orm';
import type {
  ModelConfig,
  NotifyChannel,
  ScheduledTask,
  ScheduledTaskInput,
} from '@stock-agent/shared';
import { db, schema } from './db/client';
import { newId, nowIso } from './util';
import { getStrategy } from './strategy/sim';
import type { RunnableTask } from './runner';

type Row = typeof schema.scheduledTasks.$inferSelect;

function rowToDto(row: Row): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    cronExpr: row.cronExpr,
    tz: row.tz,
    prompt: row.prompt,
    modelConfig: safeParse<ModelConfig>(row.modelConfig, {}),
    notifyChannels: safeParse<NotifyChannel[]>(row.notifyChannels, ['webui']),
    timeoutSec: row.timeoutSec,
    enabled: row.enabled,
    strategyId: row.strategyId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function listTasks(): ScheduledTask[] {
  return db.select().from(schema.scheduledTasks).all().map(rowToDto);
}

export function getTask(id: string): ScheduledTask | undefined {
  const row = db
    .select()
    .from(schema.scheduledTasks)
    .where(eq(schema.scheduledTasks.id, id))
    .get();
  return row ? rowToDto(row) : undefined;
}

export function createTask(input: ScheduledTaskInput): ScheduledTask {
  const id = newId();
  const now = nowIso();
  db.insert(schema.scheduledTasks)
    .values({
      id,
      name: input.name,
      description: input.description ?? null,
      cronExpr: input.cronExpr ?? null,
      tz: input.tz,
      prompt: input.prompt,
      modelConfig: JSON.stringify(input.modelConfig ?? {}),
      notifyChannels: JSON.stringify(input.notifyChannels ?? ['webui']),
      timeoutSec: input.timeoutSec,
      enabled: input.enabled,
      strategyId: input.strategyId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getTask(id)!;
}

export function updateTask(
  id: string,
  patch: Partial<ScheduledTaskInput>,
): ScheduledTask | undefined {
  const existing = getTask(id);
  if (!existing) return undefined;
  db.update(schema.scheduledTasks)
    .set({
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description ?? null,
      cronExpr: patch.cronExpr !== undefined ? patch.cronExpr : existing.cronExpr,
      tz: patch.tz ?? existing.tz,
      prompt: patch.prompt ?? existing.prompt,
      modelConfig: JSON.stringify(patch.modelConfig ?? existing.modelConfig),
      notifyChannels: JSON.stringify(patch.notifyChannels ?? existing.notifyChannels),
      timeoutSec: patch.timeoutSec ?? existing.timeoutSec,
      enabled: patch.enabled ?? existing.enabled,
      strategyId:
        patch.strategyId !== undefined ? patch.strategyId : existing.strategyId ?? null,
      updatedAt: nowIso(),
    })
    .where(eq(schema.scheduledTasks.id, id))
    .run();
  return getTask(id);
}

export function deleteTask(id: string): void {
  db.delete(schema.scheduledTasks).where(eq(schema.scheduledTasks.id, id)).run();
}

export function toRunnable(task: ScheduledTask): RunnableTask {
  const strategy = task.strategyId ? getStrategy(task.strategyId) : undefined;
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    modelConfig: task.modelConfig,
    notifyChannels: task.notifyChannels,
    timeoutSec: task.timeoutSec,
    strategy: strategy ? { id: strategy.id, name: strategy.name } : null,
  };
}
