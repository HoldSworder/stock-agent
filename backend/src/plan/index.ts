import type { FastifyInstance, FastifyReply } from 'fastify';
import { runTask } from '../runner';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import * as svc from './service';

// 挂载今日计划模块：注册 /api/plan/* 与 /api/plan/schedules（模块内定时）。
// server.ts 仅需 registerPlanModule(app) 一行接入，删除即整模块下线。
// 今日计划是串联研报/热点/板块/持仓/大盘的中央状态层：盘前生成、盘中对照、盘后复盘。
// 定时由本模块自管（不进「任务」页），盘前 08:30 生成、盘后 15:30 复盘闭环，仅研判不下单。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerPlanModule(app: FastifyInstance): void {
  defineModuleSchedules({
    app,
    module: 'plan',
    jobs: [
      {
        id: 'plan.generate',
        label: '盘前生成今日计划',
        defaultCron: '30 8 * * 1-5',
        run: async () => {
          const result = await runTask(
            {
              id: null,
              name: svc.PLAN_GEN_TASK_NAME,
              prompt: svc.PLAN_GEN_PROMPT,
              modelConfig: { thinking: false, maxSteps: 22 },
              notifyChannels: ['webui', 'telegram'],
              timeoutSec: 900,
            },
            'cron',
          );
          // 落库后增强：对计划内个股逐只跑多 agent 辩论并回写结论（始终自动）
          if (result.status === 'success') await svc.enrichTodayPlanWithDebate(result.runId);
        },
      },
      {
        id: 'plan.review',
        label: '收盘复盘闭环',
        defaultCron: '30 15 * * 1-5',
        run: async () => {
          await runTask(
            {
              id: null,
              name: svc.PLAN_REVIEW_TASK_NAME,
              prompt: svc.PLAN_REVIEW_PROMPT,
              modelConfig: { thinking: false, maxSteps: 18 },
              notifyChannels: ['webui', 'telegram'],
              timeoutSec: 700,
            },
            'cron',
          );
        },
      },
    ],
  });

  const fail = (reply: FastifyReply, e: unknown) =>
    reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });

  // 今日计划详情（无则 data=null）
  app.get('/api/plan/today', () => ({ ok: true, data: svc.getTodayDetail() }));

  // 今日计划兑现度（纯代码统计，无则 data=null）
  app.get('/api/plan/fulfillment', () => ({ ok: true, data: svc.computePlanFulfillment() }));

  // 历史计划摘要列表（静态路由须在 /:date 参数路由之前注册，避免被参数路由误匹配）
  app.get<{ Querystring: { limit?: string } }>('/api/plan/list', (req) => {
    const limit = req.query?.limit
      ? Math.min(Math.max(Number(req.query.limit) || 60, 1), 200)
      : undefined;
    return { ok: true, data: svc.listSummaries(limit) };
  });

  // 指定日期计划详情
  app.get<{ Params: { date: string } }>('/api/plan/:date', (req, reply) => {
    if (!DATE_RE.test(req.params.date)) {
      return reply.code(400).send({ ok: false, error: '日期格式应为 YYYY-MM-DD' });
    }
    return { ok: true, data: svc.getDetailByDate(req.params.date) };
  });

  // 指定日期计划事件流
  app.get<{ Params: { date: string } }>('/api/plan/:date/events', (req, reply) => {
    if (!DATE_RE.test(req.params.date)) {
      return reply.code(400).send({ ok: false, error: '日期格式应为 YYYY-MM-DD' });
    }
    const detail = svc.getDetailByDate(req.params.date);
    return { ok: true, data: detail?.events ?? [] };
  });

  // 手动生成/重新生成今日计划（跑 agent，落结构化计划）
  const generate = async (reply: FastifyReply) => {
    try {
      const result = await runTask(
        {
          id: null,
          name: svc.PLAN_GEN_TASK_NAME,
          prompt: svc.PLAN_GEN_PROMPT,
          modelConfig: { thinking: false, maxSteps: 20 },
          notifyChannels: ['webui'],
          timeoutSec: 900,
        },
        'manual',
      );
      // 落库后增强：个股逐只多 agent 辩论回写结论。后台执行不阻塞响应，前端稍后刷新可见。
      if (result.status === 'success') {
        void svc
          .enrichTodayPlanWithDebate(result.runId)
          .catch((e) => console.warn('[plan] 候选辩论增强失败:', e instanceof Error ? e.message : e));
      }
      return {
        ok: result.status === 'success',
        data: { runId: result.runId, status: result.status, text: result.outputText },
        error: result.status === 'success' ? undefined : `计划生成未成功（${result.status}）`,
      };
    } catch (e) {
      return fail(reply, e);
    }
  };

  app.post('/api/plan/generate', (_req, reply) => generate(reply));
  app.post<{ Params: { date: string } }>('/api/plan/:date/regenerate', (_req, reply) =>
    generate(reply),
  );
}
