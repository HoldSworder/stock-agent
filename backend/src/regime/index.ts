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
      // 响应级 120s 缓存：阶段慢变、涉及多指数取数，重进瞬显。
      // 显式传 false：页面只读，落库由 15:20 的收盘任务独占。
      // 早先这里走默认 persist=true，于是「打开大盘页」就会写当天行，与定时任务
      // 按日 upsert 同一行、后写覆盖先写——快照日期因此变成「谁最后打开过页面」，
      // 实测表里出现 8-28 / 8-20 / 8-18 / 8-07 这种断续序列，正是这么来的。
      return {
        ok: true,
        data: await cached('regime:overview', 120_000, () => buildRegimeOverview(false)),
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
        // 错峰到 15:20：它要读多个指数的当日收盘线，排在日线回填与情绪之后
        label: '大盘阶段收盘快照（15:20）',
        defaultCron: '20 15 * * 1-5',
        // 纯计算不花钱。风险预算档由大盘阶段决定，没有它整套仓位上限都在用旧档位
        defaultEnabled: true,
        run: async () => {
          await buildRegimeOverview(true);
        },
      },
    ],
  });
}
