import type { FastifyInstance } from 'fastify';
import type { MarketThemeStatus } from '@stock-agent/shared';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { listThemes, refreshThemes, setThemeStatus } from './service';

// 结构化市场主线模块：把复盘/热点（研报预留）的板块判断统一沉淀为 market_themes。
// server.ts 仅需 registerThemesModule(app) 一行接入，删除即整模块下线。
// 纯结构化聚合不下单、不调 LLM；收盘后定时刷新（默认禁用，可在调度页启用）。

const VALID_STATUS: MarketThemeStatus[] = ['active', 'fading', 'archived'];

export function registerThemesModule(app: FastifyInstance): void {
  // 主线列表（默认不含已归档）
  app.get<{ Querystring: { includeArchived?: string } }>('/api/themes', (req) => ({
    ok: true,
    data: listThemes(req.query.includeArchived === '1'),
  }));

  // 手动触发一次多源聚合
  app.post('/api/themes/refresh', async (_req, reply) => {
    try {
      return { ok: true, data: await refreshThemes() };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 手动调整主线状态（如手动归档噪声主线）
  app.put<{ Params: { id: string }; Body: { status?: MarketThemeStatus } }>(
    '/api/themes/:id',
    (req, reply) => {
      const status = req.body?.status;
      if (!status || !VALID_STATUS.includes(status)) {
        return reply.code(400).send({ ok: false, error: 'status 不合法' });
      }
      const updated = setThemeStatus(req.params.id, status);
      if (!updated) return reply.code(404).send({ ok: false, error: '主线不存在' });
      return { ok: true, data: updated };
    },
  );

  // 收盘后聚合定时（默认禁用，配好热点源后到调度页启用）
  defineModuleSchedules({
    app,
    module: 'themes',
    jobs: [
      {
        id: 'themes.refresh',
        label: '市场主线聚合（收盘后 15:40）',
        defaultCron: '40 15 * * 1-5',
        run: async () => {
          await refreshThemes();
        },
      },
    ],
  });
}
