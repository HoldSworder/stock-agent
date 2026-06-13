import { Cron } from 'croner';
import { shouldSkipForHoliday, shanghaiDateStr, shanghaiTimeStr } from '../market/calendar';
import { getMeta, setMeta } from '../settings';
import { sendTelegram } from '../notify/telegram';
import { nowIso } from '../util';
import { withJobLock } from './locks';

/** 本进程锁持有者标识（区分 dev 双开 / 多进程） */
const LOCK_OWNER = `module-${process.pid}`;

// 共享轻量模块调度器：croner 薄封装 + 节假日 gate + lastSuccessAt 记录 + missed-run 提示。
// 与中央 scheduler.ts（scheduled_tasks/任务页）解耦——各模块在此注册「模块内定时」，
// 不写入 scheduled_tasks，配置与管理留在各模块自身。

export interface ModuleJob {
  /** 全局唯一 id，形如 'intel.daily' */
  id: string;
  /** 所属模块标识，形如 'trendradar'（决定挂载的 API 前缀） */
  module: string;
  label: string;
  cronExpr: string;
  tz: string;
  enabled: boolean;
  /** 工作日触发的任务命中法定节假日时跳过（周末触发任务不受影响） */
  skipHoliday: boolean;
  run: () => Promise<void>;
}

const jobs = new Map<string, { def: ModuleJob; cron: Cron | null }>();

const LAST_SUCCESS_PREFIX = 'modsched_last_';
const CATCHUP_META_KEY = 'modsched_last_catchup_at';

function lastSuccessKey(id: string): string {
  return LAST_SUCCESS_PREFIX + id;
}

/** 最近一次成功执行时间（ISO），无则 null */
export function getLastSuccessAt(id: string): string | null {
  return getMeta(lastSuccessKey(id)) ?? null;
}

/** 执行一个 job：cron 触发先过节假日 gate，成功落水位线，失败告警（不抛出，避免压垮定时器） */
async function execJob(def: ModuleJob, trigger: 'cron' | 'manual'): Promise<void> {
  if (trigger === 'cron' && def.skipHoliday && shouldSkipForHoliday()) {
    console.log(`[modsched] ${def.label} 命中法定节假日，跳过本次触发`);
    return;
  }
  try {
    // 互斥锁：同模块定时被多入口/多进程并发触发时仅一个执行，其余跳过（ttl 过期可抢占防死锁）
    const ran = await withJobLock(
      `module:${def.id}`,
      { owner: LOCK_OWNER, ttlSec: 1800 },
      async () => {
        await def.run();
        return true;
      },
    );
    if (ran === null) return; // 未抢到锁：同 job 正在运行，本次跳过，不记水位线
    setMeta(lastSuccessKey(def.id), nowIso());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[modsched] ${def.label} 执行失败:`, msg);
    // 仅 cron 触发失败时告警；手动触发用户已在 UI 看到错误
    if (trigger === 'cron') {
      await sendTelegram(`⚠️【${def.label}】定时执行失败\n${msg}`).catch(() => {});
    }
  }
}

function buildCron(def: ModuleJob): Cron | null {
  if (!def.enabled || !def.cronExpr) return null;
  try {
    return new Cron(def.cronExpr, { timezone: def.tz, name: def.id, protect: true }, () => {
      void execJob(def, 'cron');
    });
  } catch (e) {
    console.error(`[modsched] ${def.label} cron 解析失败:`, e);
    return null;
  }
}

/** 注册 / 重载一个模块 job（同 id 覆盖，先停旧再建新） */
export function registerModuleJob(def: ModuleJob): void {
  jobs.get(def.id)?.cron?.stop();
  jobs.set(def.id, { def, cron: buildCron(def) });
}

/** 下次运行时间（ISO），未启用或解析失败为 null */
export function getNextRun(id: string): string | null {
  const next = jobs.get(id)?.cron?.nextRun();
  return next ? next.toISOString() : null;
}

/** 模块定时项总览信息（供调度聚合页只读展示） */
export interface ModuleJobInfo {
  id: string;
  module: string;
  label: string;
  cronExpr: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastSuccessAt: string | null;
}

/** 列出全部已注册的模块定时项（跨模块聚合，供中枢·调度页） */
export function listModuleJobs(): ModuleJobInfo[] {
  return [...jobs.values()].map(({ def }) => ({
    id: def.id,
    module: def.module,
    label: def.label,
    cronExpr: def.cronExpr,
    enabled: def.enabled,
    nextRunAt: getNextRun(def.id),
    lastSuccessAt: getLastSuccessAt(def.id),
  }));
}

/** 手动触发一次（不过节假日 gate），job 存在返回 true */
export async function triggerModuleJob(id: string): Promise<boolean> {
  const entry = jobs.get(id);
  if (!entry) return false;
  // 后台异步执行，立即返回（与中央 triggerTask 一致）
  void execJob(entry.def, 'manual');
  return true;
}

/**
 * 启动时 missed-run 检查：对每个已启用 job，若其「今日最近一次应触发时刻」已过、当天非节假日、
 * 且其后无成功记录，则判为「停机期间错过」。默认只 Telegram 提示不自动补跑，用持久化水位线幂等防重复告警。
 * 须在各模块 register（注册 job）之后调用。
 */
export async function catchUpModuleMissedRuns(): Promise<void> {
  const now = new Date();
  const lastCheck = ((): number => {
    const raw = getMeta(CATCHUP_META_KEY);
    return raw ? new Date(raw).getTime() : 0;
  })();
  const todayStr = shanghaiDateStr(now);
  const missed: string[] = [];

  for (const { def, cron } of jobs.values()) {
    if (!def.enabled || !cron) continue;
    let prev: Date | null = null;
    try {
      prev = cron.previousRun();
    } catch {
      prev = null;
    }
    if (!prev) continue;
    if (shanghaiDateStr(prev) !== todayStr) continue;
    if (def.skipHoliday && shouldSkipForHoliday(prev)) continue;
    if (prev.getTime() <= lastCheck) continue;
    const last = getLastSuccessAt(def.id);
    if (last && new Date(last).getTime() >= prev.getTime()) continue;
    missed.push(`• ${def.label}（应于 ${shanghaiTimeStr(prev)} 触发）`);
  }

  setMeta(CATCHUP_META_KEY, now.toISOString());

  if (missed.length === 0) return;
  const body =
    `⚠️ 检测到 ${missed.length} 个模块定时今日应触发但未执行（服务停机期间错过）：\n` +
    missed.join('\n') +
    '\n如需补跑请到对应模块页手动触发。';
  console.warn('[modsched] 错过的模块定时:\n' + body);
  await sendTelegram(body).catch(() => {});
}
