import { Cron } from 'croner';
import type { ScheduledTask } from '@stock-agent/shared';
import { listTasks, getTask, toRunnable } from './tasks';
import { runTask } from './runner';
import { shouldSkipForHoliday, shanghaiDateStr, shanghaiTimeStr } from './market/calendar';
import { getLastRunStartedAt } from './repo';
import { getMeta, setMeta } from './settings';
import { sendTelegram } from './notify/telegram';

const jobs = new Map<string, Cron>();

// missed-run 检查的幂等水位线（持久化），防止 dev watch 反复重启重复告警同一错过的任务
const CATCHUP_META_KEY = 'last_catchup_check_at';

function scheduleOne(task: ScheduledTask): void {
  if (!task.enabled || !task.cronExpr) return;
  try {
    const job = new Cron(
      task.cronExpr,
      { timezone: task.tz, name: task.id, protect: true },
      () => {
        // 节假日确定性 gate：工作日触发的任务若当天为法定节假日，直接跳过不唤醒 LLM
        // （省 token 且可靠，替代靠贵模型在 prompt 里自判休市）。周末触发的任务不受影响。
        if (shouldSkipForHoliday()) {
          console.log(`[scheduler] 任务 ${task.name} 命中法定节假日，跳过本次触发`);
          return;
        }
        // 事件流与生命周期已由 runAgent / createRun·finishRun 统一广播，无需再传 broadcast
        void runTask(toRunnable(task), 'cron');
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

/**
 * 启动时 missed-run 检查：对每个已启用任务，若其「今日最近一次应触发时刻」已过、当天非节假日、
 * 且该时刻之后没有任何运行记录，则判为「停机期间错过」。默认只 Telegram 提示不自动补跑
 * （尾盘类任务过点补跑反而有害，交由用户在 WebUI 决定）。用持久化水位线做幂等防重复告警。
 * 须在 reloadScheduler() 之后调用（依赖各任务的 Cron 实例计算 previousRun）。
 */
export async function catchUpMissedRuns(): Promise<void> {
  const now = new Date();
  const lastCheck = ((): number => {
    const raw = getMeta(CATCHUP_META_KEY);
    return raw ? new Date(raw).getTime() : 0;
  })();
  const todayStr = shanghaiDateStr(now);
  const missed: string[] = [];

  for (const task of listTasks()) {
    if (!task.enabled || !task.cronExpr) continue;
    const job = jobs.get(task.id);
    if (!job) continue;

    let prev: Date | null = null;
    try {
      prev = job.previousRun();
    } catch {
      prev = null;
    }
    if (!prev) continue;

    // 仅补当日错过；跨日的不追（避免重启时拉起过时任务）
    if (shanghaiDateStr(prev) !== todayStr) continue;
    // 该应触发日为法定节假日则本就该跳过，不算 missed
    if (shouldSkipForHoliday(prev)) continue;
    // 幂等：上次检查水位线之后才出现的应触发时刻才考虑，防重启重复告警
    if (prev.getTime() <= lastCheck) continue;
    // 应触发时刻之后已有运行记录 → 视为已执行
    const last = getLastRunStartedAt(task.id);
    if (last && new Date(last).getTime() >= prev.getTime()) continue;

    missed.push(`• ${task.name ?? task.id}（应于 ${shanghaiTimeStr(prev)} 触发）`);
  }

  // 无论是否有 missed 都推进水位线
  setMeta(CATCHUP_META_KEY, now.toISOString());

  if (missed.length === 0) return;
  const body =
    `⚠️ 检测到 ${missed.length} 个定时任务今日应触发但未执行（服务停机期间错过）：\n` +
    missed.join('\n') +
    '\n如需补跑请在 WebUI 手动触发。';
  console.warn('[scheduler] 错过的定时任务:\n' + body);
  await sendTelegram(body).catch(() => {});
}

export function getNextRun(taskId: string): string | null {
  const next = jobs.get(taskId)?.nextRun();
  return next ? next.toISOString() : null;
}

/** 手动触发一次任务（forceTrade=true 时本次运行 sim_trade 跳过交易时段校验） */
export async function triggerTask(
  taskId: string,
  opts: { forceTrade?: boolean } = {},
): Promise<{ runId: string } | null> {
  const task = getTask(taskId);
  if (!task) return null;
  const res = await runTask(
    { ...toRunnable(task), forceTrade: opts.forceTrade ?? false },
    'manual',
  );
  return { runId: res.runId };
}
