import type { FastifyInstance } from 'fastify';
import { getFactorCatalog, getFactorSnapshot } from './service';

// 因子探索模块：只读暴露离线预计算的因子目录 + IC + 当前快照，供 WebUI「因子探索」页使用。
// server.ts 仅需 registerFactorModule(app) 一行接入，删除即整模块下线。
// 不下单、不调 LLM、不写库；因子值与 IC 全部来自离线脚本产物。
export function registerFactorModule(app: FastifyInstance): void {
  // 因子目录 + IC 统计 + 元信息（口径说明、分类介绍），不含快照
  app.get('/api/factors/catalog', async (_req, reply) => {
    try {
      return { ok: true, data: await getFactorCatalog() };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 最新交易日全因子快照（当前榜单 / 因子组合实验用）
  app.get('/api/factors/snapshot', async (_req, reply) => {
    try {
      return { ok: true, data: await getFactorSnapshot() };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
