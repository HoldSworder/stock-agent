import type { FastifyInstance } from 'fastify';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { cached } from '../lib/ttlCache';
import { buildMoneyEffectOverview, isStaleTradeDate } from './service';

// 首板赚钱效应模块（同花顺 883994）：自包含，server.ts 一行接入、删除即整模块下线。
// 纯只读、best-effort、不下单、不调 LLM；收盘后落一条 meta 快照供驾驶舱秒开。

export function registerMoneyEffectModule(app: FastifyInstance): void {
  // 首板赚钱效应总览（实时合成 + 落 meta 快照；120s 响应级缓存，重进瞬显）
  app.get('/api/moneyeffect/overview', async (_req, reply) => {
    try {
      const ov = await cached('moneyeffect:overview', 120_000, () => buildMoneyEffectOverview(true));
      // cached 的 serve-stale-on-error 会在上游失败时回退旧值，这里按当下交易日历重判，
      // 否则过期数据会带着落库当时的 stale:false 返回给前端
      return { ok: true, data: { ...ov, stale: ov.stale || isStaleTradeDate(ov.tradeDate) } };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 收盘后定时：落当日 883994 快照（meta），供驾驶舱秒开读取；节假日自动跳过。
  defineModuleSchedules({
    app,
    module: 'moneyeffect',
    jobs: [
      {
        id: 'moneyeffect.snapshot',
        label: '首板赚钱效应收盘快照（15:10）',
        defaultCron: '10 15 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          await buildMoneyEffectOverview(true);
        },
      },
    ],
  });
}
