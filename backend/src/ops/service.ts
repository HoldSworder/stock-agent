import type {
  OpsCleanupResult,
  OpsDbStats,
  OpsTableStat,
  RetentionConfig,
} from '@stock-agent/shared';
import { sqlite } from '../db/client';
import { getMeta, setMeta } from '../settings';
import { listModuleJobs } from '../scheduling/moduleScheduler';

// 运维·SQLite 体积治理：日志/历史表行数与库体积统计、按保留天数清理、VACUUM 回收。
// 仅清理「日志/历史」白名单表；配置/账本/学习闭环表（settings/strategies/sim_*/decision_memory 等）永久保留，不暴露清理。

const RETENTION_KEY = 'maint_retention';
/** 自动清理定时任务 id（与 ops 模块定时绑定） */
export const OPS_RETENTION_JOB_ID = 'ops.retention';

interface TableDef {
  table: string;
  label: string;
  /** 按时间清理依据的列（ISO 文本，字典序可比）；null=不按时间独立清理 */
  timeColumn: string | null;
  /** 是否可清理（日志/历史白名单） */
  cleanable: boolean;
  /** 级联子表：父表清理时一并删除（按 childKey IN 父表命中行的 parentKey） */
  cascade?: { table: string; childKey: string; parentKey: string };
}

/** 可治理的日志/历史表（白名单）+ 仅统计的级联子表 */
const TABLES: TableDef[] = [
  {
    table: 'task_runs',
    label: '运行记录',
    timeColumn: 'started_at',
    cleanable: true,
    cascade: { table: 'run_messages', childKey: 'run_id', parentKey: 'id' },
  },
  { table: 'run_messages', label: '运行轨迹（随运行记录级联）', timeColumn: null, cleanable: false },
  { table: 'llm_calls', label: 'LLM 调用记录', timeColumn: 'created_at', cleanable: true },
  { table: 'watch_alerts', label: '盯盘告警', timeColumn: 'created_at', cleanable: true },
  { table: 'positions', label: '持仓快照', timeColumn: 'snapshot_at', cleanable: true },
  { table: 'chat_messages', label: '聊天消息', timeColumn: 'created_at', cleanable: true },
  { table: 'trend_summaries', label: '热点研判历史', timeColumn: 'created_at', cleanable: true },
  { table: 'ai_analyses', label: 'AI 分析历史', timeColumn: 'created_at', cleanable: true },
  { table: 'daily_plan_events', label: '计划事件', timeColumn: 'ts', cleanable: true },
];

const CLEANABLE = TABLES.filter((t) => t.cleanable);

/** 读取保留策略（表名 -> 天数）；解析失败按空处理 */
export function getRetention(): RetentionConfig {
  const raw = getMeta(RETENTION_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: RetentionConfig = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const n = Number(v);
      if (CLEANABLE.some((t) => t.table === k) && Number.isFinite(n) && n >= 0) out[k] = Math.floor(n);
    }
    return out;
  } catch {
    return {};
  }
}

/** 写入保留策略（仅接受白名单表、非负整数；0=不自动清理） */
export function setRetention(patch: RetentionConfig): RetentionConfig {
  const cur = getRetention();
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!CLEANABLE.some((t) => t.table === k)) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    cur[k] = Math.floor(n);
  }
  setMeta(RETENTION_KEY, JSON.stringify(cur));
  return cur;
}

function rowCount(table: string): number {
  try {
    const row = sqlite.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number };
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/** 数据库文件体积（字节）：page_count * page_size */
export function getDbSizeBytes(): number {
  const pageCount = (sqlite.pragma('page_count', { simple: true }) as number) ?? 0;
  const pageSize = (sqlite.pragma('page_size', { simple: true }) as number) ?? 0;
  return pageCount * pageSize;
}

/** 自动清理定时是否启用（以 ops.retention 模块定时为准） */
function isAutoEnabled(): boolean {
  return listModuleJobs().find((j) => j.id === OPS_RETENTION_JOB_ID)?.enabled ?? false;
}

/** 数据库总览统计 */
export function getDbStats(): OpsDbStats {
  const retention = getRetention();
  const tables: OpsTableStat[] = TABLES.map((t) => ({
    table: t.table,
    label: t.label,
    rows: rowCount(t.table),
    cleanable: t.cleanable,
    timeColumn: t.timeColumn,
    retentionDays: retention[t.table] ?? 0,
  }));
  return {
    dbSizeBytes: getDbSizeBytes(),
    totalRows: tables.reduce((s, t) => s + t.rows, 0),
    tables,
    autoEnabled: isAutoEnabled(),
  };
}

/** 删除某表早于 cutoff（ISO）的行，含级联子表；返回删除行数 */
function cleanupOne(def: TableDef, cutoffIso: string): number {
  if (!def.cleanable || !def.timeColumn) return 0;
  if (def.cascade) {
    const c = def.cascade;
    sqlite
      .prepare(
        `DELETE FROM ${c.table} WHERE ${c.childKey} IN (SELECT ${c.parentKey} FROM ${def.table} WHERE ${def.timeColumn} < ?)`,
      )
      .run(cutoffIso);
  }
  const res = sqlite
    .prepare(`DELETE FROM ${def.table} WHERE ${def.timeColumn} < ?`)
    .run(cutoffIso);
  return res.changes ?? 0;
}

function cutoffFor(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

/** 按保留策略清理：对每张设置了保留天数>0 的表删除超期行 */
export function cleanupByRetention(): OpsCleanupResult {
  const retention = getRetention();
  const deleted: Record<string, number> = {};
  let total = 0;
  for (const def of CLEANABLE) {
    const days = retention[def.table] ?? 0;
    if (days <= 0) continue;
    const n = cleanupOne(def, cutoffFor(days));
    if (n > 0) {
      deleted[def.table] = n;
      total += n;
    }
  }
  return { deleted, total, dbSizeBytes: getDbSizeBytes() };
}

/** 清理单张表早于 days 天的行（手动清理用） */
export function cleanupTable(table: string, days: number): OpsCleanupResult {
  const def = CLEANABLE.find((t) => t.table === table);
  if (!def) throw new Error(`表 ${table} 不可清理`);
  if (!Number.isFinite(days) || days < 0) throw new Error('保留天数非法');
  const n = cleanupOne(def, cutoffFor(days));
  return { deleted: n > 0 ? { [table]: n } : {}, total: n, dbSizeBytes: getDbSizeBytes() };
}

/** VACUUM 回收已删除空间（WAL 模式下需 checkpoint 后整理，better-sqlite3 直接执行即可） */
export function vacuum(): number {
  sqlite.exec('VACUUM');
  return getDbSizeBytes();
}

/** 自动清理 job：按保留策略清理 + VACUUM（定时调用） */
export async function runRetentionJob(): Promise<void> {
  const res = cleanupByRetention();
  if (res.total > 0) {
    vacuum();
    console.log(`[ops] 自动清理删除 ${res.total} 行，库体积 ${(getDbSizeBytes() / 1048576).toFixed(1)}MB`);
  }
}
