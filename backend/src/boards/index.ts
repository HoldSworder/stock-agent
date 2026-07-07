import type { FastifyInstance } from 'fastify';
import { cached } from '../lib/ttlCache';
import { buildBoardWorkbench, buildBoardDetail } from './service';
import { computeBoardExposure } from './exposure';
import { generateBoardAiAction } from './aiAction';

// 板块主线作战台模块：唯一板块决策产物的 HTTP 出口（确定性只读，不下单）。
// server.ts 仅需 registerBoardsModule(app) 一行接入，删除即整模块下线。
// 数据源统一走 buildBoardWorkbench（投影自主线共识），不新造板块判断源。

export function registerBoardsModule(app: FastifyInstance): void {
  // 板块作战台列表（投影自主线共识 + 派生操盘标签）；120s SWR 缓存，复用共识内部 breadth/radar 缓存
  app.get('/api/boards/workbench', async (_req, reply) => {
    try {
      return { ok: true, data: await cached('boards:workbench', 120_000, buildBoardWorkbench) };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 持仓/自选板块暴露（主线锚板块成分 ∩ 我的持仓/自选，懒相交）；60s 缓存
  app.get('/api/boards/exposure', async (_req, reply) => {
    try {
      return { ok: true, data: await cached('boards:exposure', 60_000, () => computeBoardExposure()) };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 单板块详情（下钻）：workbench item + 龙头/补涨 + 暴露 + 失效条件；按 boardCode 缓存 120s
  app.get<{ Params: { code: string } }>('/api/boards/:code/detail', async (req, reply) => {
    try {
      const code = req.params.code;
      const detail = await cached(`boards:detail:${code}`, 120_000, () => buildBoardDetail(code));
      if (!detail) return reply.code(404).send({ ok: false, error: '该板块非当前主线锚，无详情' });
      return { ok: true, data: detail };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 按需生成板块 AI 行动建议（结构化行动结构，经统一网关 oneshot）；不缓存（用户显式触发）
  app.post<{ Params: { code: string } }>('/api/boards/:code/ai-action', async (req, reply) => {
    try {
      const verdict = await generateBoardAiAction(req.params.code);
      if (!verdict) return reply.code(502).send({ ok: false, error: 'AI 行动建议生成失败（网关/解析）' });
      return { ok: true, data: verdict };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
