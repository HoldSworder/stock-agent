import type { FastifyInstance } from 'fastify';
import type { ScheduleOverviewItem } from '@stock-agent/shared';
import { listTasks } from '../tasks';
import { getNextRun } from '../scheduler';
import { listModuleJobs } from './moduleScheduler';

// 调度总览：把两套解耦的调度（中央 scheduled_tasks/任务 + 各模块自管的模块定时）聚合为只读总览。
// 写操作仍走各自原端点（中央 /api/tasks/*，模块 /api/<module>/schedules/*），本端点仅做统一读视图。
// server.ts 仅需 registerSchedulesModule(app) 一行接入。

export function registerSchedulesModule(app: FastifyInstance): void {
  app.get('/api/schedules', () => {
    const central: ScheduleOverviewItem[] = listTasks().map((t) => ({
      id: t.id,
      type: 'central',
      module: null,
      name: t.name,
      cronExpr: t.cronExpr ?? null,
      enabled: t.enabled,
      nextRunAt: getNextRun(t.id),
      lastSuccessAt: null,
      prompt: t.prompt,
      strategyId: t.strategyId ?? null,
      modelConfig: t.modelConfig,
      timeoutSec: t.timeoutSec,
    }));
    const modules: ScheduleOverviewItem[] = listModuleJobs().map((j) => ({
      id: j.id,
      type: 'module',
      module: j.module,
      name: j.label,
      cronExpr: j.cronExpr,
      enabled: j.enabled,
      nextRunAt: j.nextRunAt,
      lastSuccessAt: j.lastSuccessAt,
      prompt: null,
      strategyId: null,
      modelConfig: null,
      timeoutSec: null,
    }));
    return { ok: true, data: [...central, ...modules] };
  });
}
