import type { FastifyInstance } from 'fastify';
import { buildCockpitOverview, buildTimeline } from './service';

// 驾驶舱模块：一屏概览 + 事件时间线（纯只读聚合）。急停沿用 /api/safety/*，此处不重复。
// server.ts 仅需 registerCockpitModule(app) 一行接入，删除此行整模块下线。

export function registerCockpitModule(app: FastifyInstance): void {
  app.get('/api/cockpit/overview', () => ({ ok: true, data: buildCockpitOverview() }));

  app.get<{ Querystring: { limit?: string } }>('/api/cockpit/timeline', (req) => {
    const limit = Number.parseInt(req.query.limit ?? '', 10);
    return { ok: true, data: buildTimeline(Number.isFinite(limit) ? limit : 40) };
  });
}
