import type { FastifyInstance } from 'fastify';
import type { CockpitFocusInput, CockpitFocusItem, StockQuote } from '@stock-agent/shared';
import { buildCockpitOverview, buildTimeline } from './service';
import { buildPanorama, buildPanoramaLive } from './panorama';
import { buildActionPlan } from './actions';
import { addFocus, listFocus, removeFocus, updateFocus } from './focus';
import { getQuotes } from '../market/eastmoney';

// 驾驶舱模块：一屏概览 + 事件时间线（纯只读聚合）。急停沿用 /api/safety/*，此处不重复。
// server.ts 仅需 registerCockpitModule(app) 一行接入，删除此行整模块下线。

export function registerCockpitModule(app: FastifyInstance): void {
  app.get('/api/cockpit/overview', () => ({ ok: true, data: buildCockpitOverview() }));

  // 今日全景·秒开层：纯本地读取，无网络调用，首屏立刻可见
  app.get('/api/cockpit/panorama', () => ({ ok: true, data: buildPanorama() }));

  // 今日全景·实时层：真实账户 / 纪律 / ETF 轮动 / 涨停梯队，需外部取数，前端并行请求后补位
  app.get('/api/cockpit/panorama/live', async () => ({ ok: true, data: await buildPanoramaLive() }));

  // 今日动作清单：把各模块结论合成「按顺序做这几件事」。需外部取数（持仓/纪律/板块/轮动），
  // 与实时层同级，前端并行请求；风险三源未就绪时清单里的买入类会自带 blocked 标记
  app.get('/api/cockpit/actions', async () => ({ ok: true, data: await buildActionPlan() }));

  // 关注标的：用户自维护的小清单，点击进标的详情弹窗。行情取数失败只降级 quote，不整块失败
  app.get('/api/cockpit/focus', async () => {
    const items = listFocus();
    let quoteMap = new Map<string, StockQuote>();
    if (items.length > 0) {
      try {
        const quotes = await getQuotes(items.map((i) => i.code));
        quoteMap = new Map(quotes.map((q) => [q.code, q]));
      } catch {
        /* 行情源异常：整列表退化为无报价，列表本身仍可用 */
      }
    }
    const data: CockpitFocusItem[] = items.map((i) => ({
      ...i,
      quote: quoteMap.get(i.code) ?? null,
    }));
    return { ok: true, data };
  });

  app.post<{ Body: CockpitFocusInput }>('/api/cockpit/focus', async (req, reply) => {
    const code = (req.body?.code ?? '').trim();
    if (!/^\d{6}$/.test(code)) {
      return reply.code(400).send({ ok: false, error: '请输入 6 位标的代码' });
    }
    try {
      const [quote] = await getQuotes([code]);
      if (!quote || !quote.name) {
        return reply.code(400).send({ ok: false, error: `未查到代码 ${code} 的行情，请确认代码` });
      }
      addFocus({ code, name: quote.name, note: req.body?.note?.trim() || null });
      return { ok: true };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.put<{ Params: { code: string }; Body: { note?: string } }>(
    '/api/cockpit/focus/:code',
    (req) => {
      // 未带 note 字段视为不改备注；带空串才是显式清空
      const note = req.body?.note;
      updateFocus(req.params.code, { note: note === undefined ? undefined : note.trim() || null });
      return { ok: true };
    },
  );

  app.delete<{ Params: { code: string } }>('/api/cockpit/focus/:code', (req) => {
    removeFocus(req.params.code);
    return { ok: true };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/cockpit/timeline', (req) => {
    const limit = Number.parseInt(req.query.limit ?? '', 10);
    return { ok: true, data: buildTimeline(Number.isFinite(limit) ? limit : 40) };
  });
}
