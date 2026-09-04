import type { FastifyInstance } from 'fastify';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { buildSentimentOverview } from './service';
import { listHistory } from './repo';
import { cached } from '../lib/ttlCache';

// S1 市场情绪周期模块：确定性合成 0-100 情绪指数 + 周期阶段，纯只读、不下单、不调 LLM。
// server.ts 仅需 registerSentimentModule(app) 一行接入，删除即整模块下线。
// 收盘后定时落一条当日定值快照（按交易日 upsert），供「恢复 vs 退潮」方向判定与历史趋势图。

export function registerSentimentModule(app: FastifyInstance): void {
  // 情绪周期总览（实时合成，只读不落库）
  app.get('/api/sentiment/overview', async (_req, reply) => {
    try {
      // 响应级 120s 缓存：情绪指数慢变，重进瞬显（收盘定值快照由 15:10 定时落库，不依赖此 GET）
      return {
        ok: true,
        data: await cached('sentiment:overview', 120_000, () => buildSentimentOverview(false)),
      };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 情绪指数历史趋势（倒序最近 N 条）
  app.get<{ Querystring: { limit?: string } }>('/api/sentiment/history', (req) => ({
    ok: true,
    data: listHistory(req.query?.limit ? Number(req.query.limit) : 60),
  }));

  // 收盘后定时：落当日情绪定值快照（只读统计，不涉及交易，节假日自动跳过）。
  // 默认禁用，配好 AKShare 数据源后到调度页启用。
  defineModuleSchedules({
    app,
    module: 'sentiment',
    jobs: [
      {
        id: 'sentiment.snapshot',
        // 15:15 而不是 15:10：要等 klinecache.close(15:10) 把当日真实收盘线回填完，
        // 否则算的是盘中合成的临时 bar。时刻与 SNAPSHOT_EARLIEST_SAVE 保持一致
        label: '情绪周期收盘快照（15:15）',
        defaultCron: '15 15 * * 1-5',
        // 纯计算不花钱，而驾驶舱的情绪读数全靠它。关着等于那一块永远停在旧数据
        defaultEnabled: true,
        run: async () => {
          await buildSentimentOverview(true);
        },
      },
    ],
  });
}
