import type { FastifyInstance } from 'fastify';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { buildBreadthOverview } from './service';
import { buildMainlineConsensus } from './consensus';
import { listHistoryByBoard } from './repo';
import { cached } from '../lib/ttlCache';

// 板块新高宽度模块：确定性统计各板块创新高个股数并横向排名，"最多且持续多日稳居榜首"判主线。
// server.ts 仅需 registerBreadthModule(app) 一行接入，删除即整模块下线。
// 收盘后定时落一条当日各板块快照（按交易日 upsert），供持续性/退潮判定与历史趋势。

export function registerBreadthModule(app: FastifyInstance): void {
  // 板块新高宽度总览（实时合成，只读不落库）。计算较重（逐板块取成分），响应级缓存 30min。
  // 快照落库只由收盘任务负责：GET 可能发生在盘中或周末，落下去就是半天计数 / 非交易日行。
  app.get('/api/breadth/overview', async (_req, reply) => {
    try {
      return {
        ok: true,
        data: await cached('breadth:overview', 30 * 60_000, () => buildBreadthOverview(false)),
      };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 主线共识（决策层聚合：breadth 锚 ⋈ themes ⋈ radar）。复用各源缓存，响应级 120s 缓存。
  app.get('/api/breadth/consensus', async (_req, reply) => {
    try {
      return { ok: true, data: await cached('breadth:consensus', 120_000, buildMainlineConsensus) };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 单板块新高数历史趋势（倒序最近 N 条，持续性展示）
  app.get<{ Querystring: { code?: string; limit?: string } }>('/api/breadth/history', (req, reply) => {
    const code = (req.query?.code ?? '').trim();
    if (!code) return reply.code(400).send({ ok: false, error: '缺少板块代码 code' });
    return { ok: true, data: listHistoryByBoard(code, req.query?.limit ? Number(req.query.limit) : 30) };
  });

  // 收盘后定时：落当日各板块新高宽度快照（只读统计，不涉及交易，节假日自动跳过）。
  // 默认禁用，配好 AKShare 数据源后到调度页启用。
  defineModuleSchedules({
    app,
    module: 'breadth',
    jobs: [
      {
        id: 'breadth.snapshot',
        label: '板块新高宽度收盘快照（15:20）',
        defaultCron: '20 15 * * 1-5',
        run: async () => {
          await buildBreadthOverview(true);
        },
      },
    ],
  });
}
