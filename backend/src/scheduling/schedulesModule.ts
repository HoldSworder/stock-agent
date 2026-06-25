import type { FastifyInstance } from 'fastify';
import type { ScheduleOverviewItem } from '@stock-agent/shared';
import { listTasks } from '../tasks';
import { getNextRun } from '../scheduler';
import { listModuleJobs } from './moduleScheduler';

// 调度总览：把两套解耦的调度（中央 scheduled_tasks/任务 + 各模块自管的模块定时）聚合为只读总览。
// 写操作仍走各自原端点（中央 /api/tasks/*，模块 /api/<module>/schedules/*），本端点仅做统一读视图。
// server.ts 仅需 registerSchedulesModule(app) 一行接入。

// 去重归属标注（G2 不静默失联）：对「已停用」的任务，标注其职能现在的承担方，
// 让调度总览不再出现「一排灰任务但说不清为什么关」的静默失联。右侧启用开关即「一键恢复」。
// 两类来源：
//   1) 中央任务（按名称前缀）：旺财/总裁/妙想系列均为外部 OpenClaw 定时编排的本地禁用副本，研报机会已被 research.dailyAnalysis 取代。
//   2) 模块定时（按 job id）：卖点去重主链收敛——盘中确定性实时卖点由 etfwatch(ETF)/watch(个股) 唯一承担，
//      重决策辩论由 decision 承担，故 etf 模块的盘中 LLM 卖点定时已并入，默认停用。
// 编排调整时在此一处维护即可。
const MODULE_SUPERSEDED: Record<string, string> = {
  'etf.sellCheck':
    '已并入 etfwatch 实时确定性卖点 + decision「持仓ETF卖点复核」辩论（盘中卖点去重，默认停用，开关可恢复）',
  'decision.sellcheck.intraday':
    '盘中个股卖点由 watch 实时确定性承担；如需多 agent 辩论可按需开启此定时',
};

function supersededNote(item: ScheduleOverviewItem): string | null {
  if (item.enabled) return null;
  if (item.type === 'central') {
    const n = item.name;
    if (n.startsWith('旺财')) return '已迁至外部 OpenClaw · 旺财 ETF 编排（停用本地副本，开关可恢复）';
    if (n.startsWith('总裁ETF') || n.startsWith('总裁 ETF'))
      return '已迁至外部 OpenClaw · 总裁 ETF 编排（停用本地副本，开关可恢复）';
    if (n.startsWith('妙想')) return '已迁至外部 OpenClaw · 妙想个股编排（停用本地副本，开关可恢复）';
    if (n.startsWith('研报')) return '已并入「每日研报分析」模块定时 research.dailyAnalysis';
    return null;
  }
  // 模块定时按 job id 标注
  return MODULE_SUPERSEDED[item.id] ?? null;
}

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
    // 去重归属标注：已停用任务标注职能承担方（G2 不静默失联）
    for (const it of items) it.supersededBy = supersededNote(it);
    return { ok: true, data: items };
  });
}
