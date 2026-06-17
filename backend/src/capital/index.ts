import type { FastifyInstance } from 'fastify';
import { getStockCapital } from './service';
import { cached } from '../lib/ttlCache';

// S7 资金面模块：注册 /api/capital/stock/:code，作为 KlineDialog「资金面」Tab 的确定性数据源。
// server.ts 仅需 registerCapitalModule(app) 一行接入，删除即整模块下线。
// 纯确定性只读（东财龙虎榜净额趋势 + akshare 席位拆分）；不下单、不落库、不跑 LLM。

export function registerCapitalModule(app: FastifyInstance): void {
  // 个股龙虎榜资金面深挖（净额趋势 + 最近一次席位拆分）
  app.get<{ Params: { code: string } }>('/api/capital/stock/:code', async (req, reply) => {
    const code = String(req.params.code || '').trim();
    if (!/^\d{6}$/.test(code)) return reply.code(400).send({ ok: false, error: '请提供 6 位个股代码' });
    try {
      // 响应级 5min 缓存：龙虎榜/席位收盘后才更新，盘中无需频繁重拉
      return { ok: true, data: await cached(`capital:${code}`, 300_000, () => getStockCapital(code)) };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
