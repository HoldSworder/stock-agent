import type { FastifyInstance, FastifyReply } from 'fastify';
import { runTask } from '../runner';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import * as svc from './service';
import { startOneClickPlan, getOneClickState } from './oneclick';

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
          // 定时：等待辩论增强完成，保证落库即完整
          await svc.runPlanGeneration({
            trigger: 'cron',
            channels: ['webui', 'telegram'],
            maxSteps: 22,
            awaitDebate: true,
          });
        },
      },
      {
        id: 'plan.reevaluate',
        label: '盘中计划重评估',
        // 上午 10:30 与下午 14:00 各一次：盘中据实时盘面把失效项标 invalid、确认项标 triggered
        defaultCron: '30 10,14 * * 1-5',
        run: async () => {
          await runTask(
            {
              id: null,
              name: svc.PLAN_REEVAL_TASK_NAME,
              prompt: svc.getPlanReevalPrompt(),
              modelConfig: { thinking: false, maxSteps: 16 },
              notifyChannels: ['webui'],
              timeoutSec: 600,
            },
            'cron',
          );
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
              prompt: svc.getPlanReviewPrompt(),
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

  // 手动生成/重新生成今日计划（跑 agent，落结构化计划）。辩论增强后台执行不阻塞响应。
  const generate = async (reply: FastifyReply) => {
    try {
      const result = await svc.runPlanGeneration({
        trigger: 'manual',
        channels: ['webui'],
        maxSteps: 20,
        awaitDebate: false,
      });
      return {
        ok: result.status === 'success',
        data: { runId: result.runId, status: result.status, text: result.outputText },
        error: result.status === 'success' ? undefined : `计划生成未成功（${result.status}）`,
      };
    } catch (e) {
      return fail(reply, e);
    }
  };

  // 手动触发盘中重评估（按实时盘面把失效项标 invalid、确认项标 triggered，不新增标的）
  app.post('/api/plan/reevaluate', async (_req, reply) => {
    try {
      const result = await runTask(
        {
          id: null,
          name: svc.PLAN_REEVAL_TASK_NAME,
          prompt: svc.getPlanReevalPrompt(),
          modelConfig: { thinking: false, maxSteps: 16 },
          notifyChannels: ['webui'],
          timeoutSec: 600,
        },
        'manual',
      );
      return {
        ok: result.status === 'success',
        data: { runId: result.runId, status: result.status, text: result.outputText },
        error: result.status === 'success' ? undefined : `盘中重评估未成功（${result.status}）`,
      };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/plan/generate', (_req, reply) => generate(reply));
  app.post<{ Params: { date: string } }>('/api/plan/:date/regenerate', (_req, reply) =>
    generate(reply),
  );

  // 一键计划：后台按依赖顺序串行刷新上游六源 + 生成今日计划，立即返回初始状态供前端轮询
  app.post('/api/plan/oneclick', (_req, reply) => {
    try {
      return { ok: true, data: startOneClickPlan() };
    } catch (e) {
      // 已在运行：返回 409 + 当前状态，前端据此续接轮询
      return reply
        .code(409)
        .send({ ok: false, error: e instanceof Error ? e.message : String(e), data: getOneClickState() });
    }
  });

  // 一键计划运行态（前端轮询渲染管线进度）
  app.get('/api/plan/oneclick', () => ({ ok: true, data: getOneClickState() }));
}
