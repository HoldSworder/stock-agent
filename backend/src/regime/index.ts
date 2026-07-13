import type { FastifyInstance } from 'fastify';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { buildRegimeOverview } from './service';
import { listHistory } from './repo';
import { cached } from '../lib/ttlCache';

// 大盘阶段研判模块：确定性合成大盘阶段（主升/反弹/退潮/震荡）+ 明日倾向 + 建议交易频率/仓位。
// 纯只读、不下单、不调 LLM。server.ts 仅需 registerRegimeModule(app) 一行接入，删除即整模块下线。
// 收盘后定时落一条当日定值快照（按交易日 upsert），供「较昨分数变动 / 阶段已持续天数」与历史趋势图。

export function registerRegimeModule(app: FastifyInstance): void {
  // 大盘阶段总览（实时合成，并按日 upsert 快照）
  app.get('/api/market/regime', async (_req, reply) => {
    try {
      // 响应级 120s 缓存：阶段慢变、涉及多指数取数，重进瞬显（收盘定值快照由 15:10 定时落库）
      return {
        ok: true,
        data: await cached('regime:overview', 120_000, () => buildRegimeOverview()),
      };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 大盘阶段历史趋势（倒序最近 N 条）
  app.get<{ Querystring: { limit?: string } }>('/api/market/regime/history', (req) => ({
    ok: true,
    data: listHistory(req.query?.limit ? Number(req.query.limit) : 60),
  }));

  // 收盘后定时：落当日大盘阶段定值快照（只读统计，不涉及交易，节假日自动跳过）。
  defineModuleSchedules({
    app,
    module: 'regime',
    jobs: [
      {
        id: 'regime.snapshot',
        label: '大盘阶段收盘快照（15:10）',
        defaultCron: '10 15 * * 1-5',
        run: async () => {
          await buildRegimeOverview(true);
        },
      },
    ],
  });
}
