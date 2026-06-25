import type { FastifyInstance, FastifyReply } from 'fastify';
import { buildRadarOverview, computePositionTrends } from './service';
import { cached } from '../lib/ttlCache';

// 中线雷达模块：注册 /api/radar/overview，作为大盘页「行业中线强弱」Tab 的确定性明细数据源。
// server.ts 仅需 registerRadarModule(app) 一行接入，删除即整模块下线。
// 纯确定性只读视图（复用 ETF 指标层）；不下单、不落库、不跑 LLM。
// 收盘后的研判/推送已统一收敛到「板块主线研判」agent 任务（themes 模块定时），此处不再单独定时，避免双跑。

export function registerRadarModule(app: FastifyInstance): void {
  const fail = (reply: FastifyReply, e: unknown) =>
    reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });

  // 中线雷达总览（行业强弱 + 持仓趋势 + 候选池）
  app.get('/api/radar/overview', async (_req, reply) => {
    try {
      // 响应级 120s 缓存：复用 ETF 指标层的行业强弱聚合较重，中线视图慢变
      return { ok: true, data: await cached('radar:overview', 120_000, buildRadarOverview) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 持仓趋势跟随（对真实持仓逐只算 MA60 趋势 + 跟随/减仓建议）。供「持仓与自选」页中线趋势体检消费。
  app.get('/api/radar/position-trends', async (_req, reply) => {
    try {
      return { ok: true, data: await cached('radar:positionTrends', 120_000, computePositionTrends) };
    } catch (e) {
      return fail(reply, e);
    }
  });
}
