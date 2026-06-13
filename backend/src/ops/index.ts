import type { FastifyInstance } from 'fastify';
import type { RetentionConfig } from '@stock-agent/shared';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import {
  OPS_RETENTION_JOB_ID,
  cleanupByRetention,
  cleanupTable,
  getDbStats,
  getRetention,
  runRetentionJob,
  setRetention,
  vacuum,
} from './service';

// 挂载运维模块：注册 /api/ops/*（库体积统计、保留策略、手动清理、VACUUM）+ ops.retention 自动清理定时。
// server.ts 仅需 registerOpsModule(app) 一行接入，删除即整模块下线。

export function registerOpsModule(app: FastifyInstance): void {
  // 数据库总览：各表行数 / 库体积 / 保留天数 / 自动清理开关
  app.get('/api/ops/stats', () => ({ ok: true, data: getDbStats() }));

  // 保留策略（表名 -> 天数；0=不自动清理）
  app.get('/api/ops/retention', () => ({ ok: true, data: getRetention() }));
  app.put<{ Body: RetentionConfig }>('/api/ops/retention', (req) => ({
    ok: true,
    data: setRetention(req.body ?? {}),
  }));

  // 清理：传 { table, days } 清单表；否则按保留策略全量清理
  app.post<{ Body: { table?: string; days?: number } }>('/api/ops/cleanup', (req, reply) => {
    try {
      const { table, days } = req.body ?? {};
      const data =
        table && days != null ? cleanupTable(table, Number(days)) : cleanupByRetention();
      return { ok: true, data };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // VACUUM 回收空间
  app.post('/api/ops/vacuum', () => ({ ok: true, data: { dbSizeBytes: vacuum() } }));

  // 自动清理定时（默认每日 03:30，默认关闭）：注册 /api/ops/schedules*，前端通过模块定时端点开关/改 cron
  defineModuleSchedules({
    app,
    module: 'ops',
    jobs: [
      {
        id: OPS_RETENTION_JOB_ID,
        label: '按保留策略自动清理 + VACUUM',
        defaultCron: '30 3 * * *',
        defaultEnabled: false,
        skipHoliday: false,
        run: runRetentionJob,
      },
    ],
  });
}
