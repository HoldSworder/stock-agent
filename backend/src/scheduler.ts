import { Cron } from 'croner';
import type { ScheduledTask } from '@stock-agent/shared';
import { listTasks, getTask, toRunnable } from './tasks';
import { runTask } from './runner';
import { broadcast } from './ws';

const jobs = new Map<string, Cron>();

function scheduleOne(task: ScheduledTask): void {
  if (!task.enabled || !task.cronExpr) return;
  try {
    const job = new Cron(
      task.cronExpr,
      { timezone: task.tz, name: task.id, protect: true },
      () => {
        void runTask(toRunnable(task), 'cron', broadcast);
      },
    );
    jobs.set(task.id, job);
  } catch (e) {
    console.error(`[scheduler] 任务 ${task.name} cron 解析失败:`, e);
  }
}

/** 全量重载所有任务（任务增删改后调用） */
export function reloadScheduler(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
  for (const task of listTasks()) scheduleOne(task);
  console.log(`[scheduler] 已装载 ${jobs.size} 个定时任务`);
}

/** 单任务重载 */
export function rescheduleTask(taskId: string): void {
  jobs.get(taskId)?.stop();
  jobs.delete(taskId);
  const task = getTask(taskId);
  if (task) scheduleOne(task);
}

export function getNextRun(taskId: string): string | null {
  const next = jobs.get(taskId)?.nextRun();
  return next ? next.toISOString() : null;
}

/** 手动触发一次任务 */
export async function triggerTask(taskId: string): Promise<{ runId: string } | null> {
  const task = getTask(taskId);
  if (!task) return null;
  const res = await runTask(toRunnable(task), 'manual', broadcast);
  return { runId: res.runId };
}
