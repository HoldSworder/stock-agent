import { Cron } from 'croner';
import { shouldSkipForHoliday, shanghaiDateStr, shanghaiTimeStr } from '../market/calendar';
// shanghaiDateStr 同时供 catchUpModuleMissedRuns 与健康判定的日历日差使用
import { getMeta, setMeta } from '../settings';
import { sendTelegram } from '../notify/telegram';
import { nowIso } from '../util';
import { withJobLock } from './locks';
import { lastExpectedSlot, previousScheduledSlot } from './cronSlots';

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
const LAST_ERROR_PREFIX = 'modsched_err_';
const CATCHUP_META_KEY = 'modsched_last_catchup_at';

function lastSuccessKey(id: string): string {
  return LAST_SUCCESS_PREFIX + id;
}

function lastErrorKey(id: string): string {
  return LAST_ERROR_PREFIX + id;
}

/** 最近一次成功执行时间（ISO），无则 null */
export function getLastSuccessAt(id: string): string | null {
  return getMeta(lastSuccessKey(id)) ?? null;
}

/**
 * 最近一次失败的原因与时刻。
 *
 * 原来失败只进控制台和一条推送：控制台会滚掉、推送会被划走，
 * 于是界面上只剩「没数据」。实测两个任务分别因为券商 Cookie 过期、
 * 取数服务 502 停了三天到三个月，全程没人知道为什么。
 * 落库之后，「该跑没跑」旁边才能写出它到底卡在哪。
 * 成功一次即清除，不留陈年旧账。
 */
export interface ModuleJobError {
  at: string;
  message: string;
}

export function getLastError(id: string): ModuleJobError | null {
  const raw = getMeta(lastErrorKey(id));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<ModuleJobError>;
    return p.at && p.message ? { at: p.at, message: p.message } : null;
  } catch {
    return null;
  }
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
    setMeta(lastErrorKey(def.id), ''); // 成功即清错，避免旧故障一直挂在界面上
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[modsched] ${def.label} 执行失败:`, msg);
    // 记错本身再抛就糟了：这个函数承诺不抛出（否则 cron 回调的 void execJob 会变成
    // 未处理拒绝，Node 默认直接退进程），而且会盖掉真正的失败原因与下面的告警。
    // 截断是因为个别失败会把整段响应体塞进 message，原样落库会撑大 settings 表。
    try {
      setMeta(lastErrorKey(def.id), JSON.stringify({ at: nowIso(), message: msg.slice(0, 300) }));
    } catch {
      /* 记错失败不影响告警，忽略 */
    }
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
  /** 最近一次失败原因；成功即清除。仅健康视图填充，调度总览不带 */
  lastError?: ModuleJobError | null;
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

/**
 * 逐项健康状态：这个任务上一次本该什么时候跑、跑了没、落后多久。
 *
 * 为什么要有这个：模块定时的失败只会写进服务端日志和一条 Telegram，
 * 界面上看不出任何异常。实测有任务连续四个交易日没跑、无人察觉；
 * 也有任务被显式关闭三个月，同样无人察觉。两者都会让后续攒的记录中间出现空洞，
 * 而空洞是事后发现的——那时整段记录已经作废。
 *
 * 三种「没在跑」必须分开，混成一个「没数据」就等于没说：
 *   disabled 被关掉（预期内）/ overdue 该跑没跑（故障）/ idle 还没到点（正常）。
 */
export type ModuleJobHealthStatus = 'ok' | 'overdue' | 'disabled' | 'idle';

export interface ModuleJobHealth {
  status: ModuleJobHealthStatus;
  /** 上一次本该触发的时刻（ISO），已跳过节假日；算不出则 null */
  expectedAt: string | null;
  /** overdue 时落后的自然天数，四舍五入到天；其余为 0 */
  staleDays: number;
}

/**
 * 宽限期：过了应触发时刻多久才算「该跑没跑」。
 *
 * 不留宽限会误报：任务本身要跑一会儿、服务重启会错过一两拍、互斥锁会让本次跳过，
 * 每十分钟一次的任务只要晚几分钟就变红。红得太容易，人就不看了——
 * 而这块的全部价值就在于「它一红你就信」。
 *
 * 十分钟对每日任务也够灵敏：14:40 的任务 14:50 就会报出来。
 */
const OVERDUE_GRACE_MS = 10 * 60 * 1000;

/**
 * 低频任务（月度、季度）的判废线：回溯窗口内算不出应触发时刻时，
 * 上次成功距今超过这么久就算它该跑没跑，而不是一直显示「还没到点」。
 * 取值与 cronSlots 的回溯上限同量级。
 */
const LOW_FREQ_STALE_MS = 15 * 86400_000;

/** 两个时刻相差几个上海日历日。不用毫秒除法，避免过点半天以上被舍成「今天」 */
function calendarDaysBetween(from: Date, to: Date): number {
  const d = (x: Date): number => Date.parse(`${shanghaiDateStr(x)}T00:00:00Z`);
  return Math.max(0, Math.round((d(to) - d(from)) / 86400_000));
}

export function jobHealth(def: ModuleJob, now: Date = new Date()): ModuleJobHealth {
  if (!def.enabled) return { status: 'disabled', expectedAt: null, staleDays: 0 };

  const expected = lastExpectedSlot(def.cronExpr, def.tz, now, (at) =>
    def.skipHoliday ? shouldSkipForHoliday(at) : false,
  );
  const last = getLastSuccessAt(def.id);

  // 回溯窗口内算不出应触发时刻：可能是表达式太密（秒级，槽位打满判为不可判），
  // 也可能是月度/季度这种低频任务。后者不能一律放过——那正是这块要防的静默失效：
  // 一个季度任务停掉，界面上永远显示「还没到点」，等到发现已经过去半年。
  // 所以低频任务改看「上次成功距今有多久」：超过回溯窗口就算它该跑没跑。
  if (!expected) {
    const staleMs = last ? now.getTime() - new Date(last).getTime() : Number.POSITIVE_INFINITY;
    if (staleMs > LOW_FREQ_STALE_MS) {
      return {
        status: 'overdue',
        expectedAt: null,
        staleDays: Number.isFinite(staleMs) ? Math.round(staleMs / 86400000) : 0,
      };
    }
    return { status: 'idle', expectedAt: null, staleDays: 0 };
  }

  const expectedAt = expected.toISOString();
  if (last && new Date(last).getTime() >= expected.getTime()) {
    return { status: 'ok', expectedAt, staleDays: 0 };
  }
  const lateBy = now.getTime() - expected.getTime();
  if (lateBy < OVERDUE_GRACE_MS) return { status: 'idle', expectedAt, staleDays: 0 };
  // 按上海日历日之差算，不用毫秒除法：过点 12~24 小时时槽位其实是昨天的，
  // 四舍五入会把它显示成「今天没跑」
  return { status: 'overdue', expectedAt, staleDays: calendarDaysBetween(expected, now) };
}

/** 全部模块定时的健康状态，按「越该管的排越前」：落后最久 → 落后较短 → 正常 → 被关掉 */
export function listModuleJobHealth(now: Date = new Date()): (ModuleJobInfo & ModuleJobHealth)[] {
  const order: Record<ModuleJobHealthStatus, number> = { overdue: 0, idle: 1, ok: 2, disabled: 3 };
  return [...jobs.values()]
    .map(({ def }) => ({
      id: def.id,
      module: def.module,
      label: def.label,
      cronExpr: def.cronExpr,
      enabled: def.enabled,
      nextRunAt: getNextRun(def.id),
      lastSuccessAt: getLastSuccessAt(def.id),
      lastError: getLastError(def.id),
      ...jobHealth(def, now),
    }))
    .sort((a, b) => order[a.status] - order[b.status] || b.staleDays - a.staleDays);
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
 * 「应触发时刻」由 previousScheduledSlot 从 cron 表达式推算——croner 的 previousRun() 只回
 * 该实例实际跑过的上一次，注册后立刻调用时恒为 null，整条判定会静默失效。
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
    const prev = previousScheduledSlot(def.cronExpr, def.tz, now);
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
