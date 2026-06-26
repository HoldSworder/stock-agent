import type { FastifyInstance } from 'fastify';
import type { ConceptWindow } from '@stock-agent/shared';
import { buildConceptStocks, buildHotConcepts } from './service';
import { cached } from '../lib/ttlCache';

const ALLOWED_WINDOWS: readonly ConceptWindow[] = ['3日', '5日', '10日', '20日'];
/** 解析 window 查询参数，非法回退 5日 */
function parseWindow(raw: unknown): ConceptWindow {
  const w = String(raw ?? '').trim() as ConceptWindow;
  return ALLOWED_WINDOWS.includes(w) ? w : '5日';
}

// 热门细分概念模块：同花顺概念资金流热度（涨幅 + 资金净额）+ 主线主题归纳，纯只读，不下单/不调 LLM。
// 覆盖六氟化钨等东财没有的细分概念；点击概念经问财展开板块全部成分股（龙头/今日领涨标注）。
// server.ts 仅需 registerConceptsModule(app) 一行接入，删除即整模块下线。

export function registerConceptsModule(app: FastifyInstance): void {
  // 热门细分概念总览（近 N 日，默认 5日；window=3日|5日|10日|20日）。响应级 90s 缓存（按 window 分键，底层取数另有 90s 缓存）。
  app.get<{ Querystring: { window?: string } }>('/api/concepts/hot', async (req, reply) => {
    const window = parseWindow(req.query?.window);
    try {
      return {
        ok: true,
        data: await cached(`concepts:hot:${window}`, 90_000, () => buildHotConcepts(window)),
      };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 概念成分股展开（点击概念时按需加载，经问财；底层取数缓存 5min）。
  app.get<{ Querystring: { name?: string } }>('/api/concepts/stocks', async (req, reply) => {
    const name = (req.query?.name ?? '').trim();
    if (!name) return reply.code(400).send({ ok: false, error: '缺少概念名 name' });
    try {
      return {
        ok: true,
        data: await cached(`concepts:stocks:${name}`, 5 * 60_000, () => buildConceptStocks(name)),
      };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
