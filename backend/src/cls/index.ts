import type { FastifyInstance, FastifyReply } from 'fastify';
import * as svc from './service';
import { cached } from '../lib/ttlCache';

/**
 * 挂载财联社电报模块：注册 /api/cls/*。
 * server.ts 仅需 registerClsModule(app) 一行接入，删除即整模块下线。
 * 数据源为 AKShare(aktools) 透传的 stock_info_global_cls（财联社-电报），免鉴权。
 */
export function registerClsModule(app: FastifyInstance): void {
  const fail = (reply: FastifyReply, e: unknown) =>
    reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });

  app.get<{ Querystring: { limit?: string } }>(
    '/api/cls/telegraph',
    async (req, reply) => {
      try {
        const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200);
        // 始终返回全量（含 important 标记），前端按 important 本地切换「全部/重点」。
        // 响应级 60s 缓存：直连失效时兜底链顺序降级每源超时 12s，重进场景免重复等待。
        const data = await cached(`cls:all:${limit}`, 60_000, () => svc.telegraph(limit));
        return { ok: true, data };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
}
