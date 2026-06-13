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
    const items = [...central, ...modules];

    // 疑似重复检测（只读提示）：把「已启用 + 同一 cron 表达式」的项聚成一组，组内 >1 即标记
    // time_conflict，便于发现中央任务与模块定时在同一时刻重复研判/推送，由用户决定停用哪一个。
    const byCron = new Map<string, ScheduleOverviewItem[]>();
    for (const it of items) {
      it.duplicateGroup = null;
      it.risk = 'none';
      if (!it.enabled || !it.cronExpr) continue;
      const arr = byCron.get(it.cronExpr) ?? [];
      arr.push(it);
      byCron.set(it.cronExpr, arr);
    }
    for (const [cronExpr, group] of byCron) {
      if (group.length < 2) continue;
      for (const it of group) {
        it.duplicateGroup = `time:${cronExpr}`;
        it.risk = 'time_conflict';
      }
    }
    return { ok: true, data: items };
  });
}
