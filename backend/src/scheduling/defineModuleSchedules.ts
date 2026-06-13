import type { FastifyInstance } from 'fastify';
import { Cron } from 'croner';
import { eq } from 'drizzle-orm';
import type { ModuleScheduleJob } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { nowIso } from '../util';
import {
  registerModuleJob,
  getNextRun,
  getLastSuccessAt,
  triggerModuleJob,
} from './moduleScheduler';

// 把「配置持久化覆盖 + croner 注册 + REST 端点」收敛为一次调用，使各模块接入约 10 行。
// 配置以单 JSON 键 sched_<module> 存 settings 表（仅存被用户改过的 cron/enabled，其余回退默认），
// 参照 market/modules.ts 的 overrides 存法，不污染强类型 AppSettings。

const TZ = 'Asia/Shanghai';

export interface ModuleJobDef {
  /** 全局唯一 id，形如 'intel.daily' */
  id: string;
  label: string;
  defaultCron: string;
  defaultEnabled?: boolean;
  /** 工作日命中节假日跳过，默认 true */
  skipHoliday?: boolean;
  run: () => Promise<void>;
}

interface JobOverride {
  cronExpr?: string;
  enabled?: boolean;
}

function settingKey(module: string): string {
  return `sched_${module}`;
}

function readOverrides(module: string): Record<string, JobOverride> {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, settingKey(module)))
    .get();
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value) as Record<string, JobOverride>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeOverrides(module: string, data: Record<string, JobOverride>): void {
  const now = nowIso();
  const value = JSON.stringify(data);
  db.insert(schema.settings)
    .values({ key: settingKey(module), value, updatedAt: now })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: now } })
    .run();
}

/** 校验 cron 表达式是否合法（构造一次即抛错） */
function isValidCron(expr: string): boolean {
  try {
    new Cron(expr, { timezone: TZ }).stop();
    return true;
  } catch {
    return false;
  }
}

export function defineModuleSchedules(opts: {
  app: FastifyInstance;
  module: string;
  jobs: ModuleJobDef[];
}): void {
  const { app, module, jobs } = opts;
  const defMap = new Map(jobs.map((j) => [j.id, j]));

  const effective = (
    def: ModuleJobDef,
  ): { cronExpr: string; enabled: boolean; skipHoliday: boolean } => {
    const ov = readOverrides(module)[def.id] ?? {};
    return {
      cronExpr: ov.cronExpr ?? def.defaultCron,
      enabled: ov.enabled ?? def.defaultEnabled ?? false,
      skipHoliday: def.skipHoliday ?? true,
    };
  };

  const apply = (def: ModuleJobDef): void => {
    const e = effective(def);
    registerModuleJob({
      id: def.id,
      module,
      label: def.label,
      tz: TZ,
      cronExpr: e.cronExpr,
      enabled: e.enabled,
      skipHoliday: e.skipHoliday,
      run: def.run,
    });
  };

  const toDto = (def: ModuleJobDef): ModuleScheduleJob => {
    const e = effective(def);
    return {
      id: def.id,
      label: def.label,
      cronExpr: e.cronExpr,
      enabled: e.enabled,
      skipHoliday: e.skipHoliday,
      nextRunAt: getNextRun(def.id),
      lastSuccessAt: getLastSuccessAt(def.id),
    };
  };

  // 启动即注册全部 job（据持久化覆盖决定 cron/enabled）
  for (const def of jobs) apply(def);

  app.get(`/api/${module}/schedules`, () => ({ ok: true, data: jobs.map(toDto) }));

  app.put<{ Params: { id: string }; Body: { cronExpr?: string; enabled?: boolean } }>(
    `/api/${module}/schedules/:id`,
    (req, reply) => {
      const def = defMap.get(req.params.id);
      if (!def) return reply.code(404).send({ ok: false, error: '定时项不存在' });
      const cronExpr = req.body?.cronExpr?.trim();
      if (cronExpr && !isValidCron(cronExpr)) {
        return reply.code(400).send({ ok: false, error: 'cron 表达式不合法' });
      }
      const all = readOverrides(module);
      const ov = all[def.id] ?? {};
      if (cronExpr) ov.cronExpr = cronExpr;
      if (typeof req.body?.enabled === 'boolean') ov.enabled = req.body.enabled;
      all[def.id] = ov;
      writeOverrides(module, all);
      apply(def);
      return { ok: true, data: toDto(def) };
    },
  );

  app.post<{ Params: { id: string } }>(
    `/api/${module}/schedules/:id/trigger`,
    async (req, reply) => {
      const def = defMap.get(req.params.id);
      if (!def) return reply.code(404).send({ ok: false, error: '定时项不存在' });
      await triggerModuleJob(def.id);
      return { ok: true };
    },
  );
}
