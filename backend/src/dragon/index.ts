import type { FastifyInstance } from 'fastify';
import { buildDragonOverview } from './service';
import { cached } from '../lib/ttlCache';

// S6 龙头/连板梯队模块：注册 /api/dragon/overview，作为大盘页「连板梯队」Tab 的确定性数据源。
// server.ts 仅需 registerDragonModule(app) 一行接入，删除即整模块下线。
// 纯确定性只读视图（东财涨停池 + 规则化龙头辨识）；不下单、不落库、不跑 LLM。

export function registerDragonModule(app: FastifyInstance): void {
  // 龙头梯队总览（连板梯队 + 龙头分层）
  app.get('/api/dragon/overview', async (_req, reply) => {
    try {
      // 响应级 60s 缓存：盘中梯队快变，但 60s 内重进瞬显，避免频繁打东财涨停池
      return { ok: true, data: await cached('dragon:overview', 60_000, buildDragonOverview) };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
