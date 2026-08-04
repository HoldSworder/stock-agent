import type { FastifyInstance } from 'fastify';
import type {
  ModeSignalAction,
  ResearchModeBacktestInput,
  ResearchModeDailyInput,
  ResearchModeUpsert,
  ResearchUniverseInput,
} from '@stock-agent/shared';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { reseedResearchModes } from '../seeds/researchModes';
import * as repo from './repo';
import * as uni from './universeRepo';
import { getModeDetail, listModesWithGate, runAllFollowedTracking } from './service';
import { runModeBacktest, runModeTracking } from './tracker';

// 量化研究模式库模块：读供 WebUI，写供 codex/cursor 登记模式/回测/外部跟踪快照；
// system 跟踪由站内引擎按调度自算。一行 registerModesModule(app) 接入，删除即整模块下线。
// 不下单、不调 LLM；回测/发掘仍在外部 python，系统只存储/展示 + 声明式自跟踪。
export function registerModesModule(app: FastifyInstance): void {
  // ---- 读 ----
  app.get('/api/modes', () => ({ ok: true, data: listModesWithGate() }));

  app.get<{ Params: { id: string } }>('/api/modes/:id', (req, reply) => {
    const d = getModeDetail(req.params.id);
    if (!d) return reply.code(404).send({ ok: false, error: '模式不存在' });
    return { ok: true, data: d };
  });

  app.get<{ Params: { id: string; bid: string } }>(
    '/api/modes/:id/backtests/:bid/trades',
    (req) => ({ ok: true, data: { tradesMd: repo.getBacktestTrades(req.params.bid) } }),
  );

  // 供外部/站内取已关注的 system 模式（含 spec）
  app.get('/api/modes/followed/system', () => ({ ok: true, data: repo.listFollowedSystemModes() }));

  app.get('/api/research-universe', () => ({ ok: true, data: uni.listUniverse() }));

  // ---- 写（codex/cursor，走全局 x-app-token 鉴权）----
  app.put<{ Params: { id: string }; Body: Omit<ResearchModeUpsert, 'id'> }>(
    '/api/modes/:id',
    (req, reply) => {
      const body = req.body;
      if (!body?.name) return reply.code(400).send({ ok: false, error: '缺少 name' });
      return { ok: true, data: repo.upsertMode({ ...body, id: req.params.id }) };
    },
  );

  app.post<{ Params: { id: string }; Body: ResearchModeBacktestInput }>(
    '/api/modes/:id/backtests',
    (req, reply) => {
      if (!repo.getMode(req.params.id)) return reply.code(404).send({ ok: false, error: '模式不存在' });
      if (!req.body?.label) return reply.code(400).send({ ok: false, error: '缺少 label' });
      return { ok: true, data: repo.addBacktest(req.params.id, req.body) };
    },
  );

  app.post<{ Params: { id: string }; Body: ResearchModeDailyInput }>(
    '/api/modes/:id/tracking',
    (req, reply) => {
      if (!repo.getMode(req.params.id)) return reply.code(404).send({ ok: false, error: '模式不存在' });
      if (!req.body?.date) return reply.code(400).send({ ok: false, error: '缺少 date' });
      repo.upsertDaily(req.params.id, 'external', req.body);
      repo.clearEventsOn(req.params.id, req.body.date);
      const sig: ModeSignalAction[] = req.body.signal ?? [];
      repo.addEvents(
        req.params.id,
        req.body.date,
        sig.map((s) => ({ kind: s.kind, detail: s.note ?? `${s.kind} ${s.name ?? s.code}` })),
      );
      return { ok: true };
    },
  );

  app.put<{ Params: { id: string }; Body: { followed: boolean } }>(
    '/api/modes/:id/follow',
    (req, reply) => {
      if (!repo.getMode(req.params.id)) return reply.code(404).send({ ok: false, error: '模式不存在' });
      repo.setFollowed(req.params.id, !!req.body?.followed);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/modes/:id', (req) => {
    repo.deleteMode(req.params.id);
    return { ok: true };
  });

  // ---- 站内自跟踪（system）手动触发 ----
  app.post<{ Params: { id: string } }>('/api/modes/:id/track-now', async (req, reply) => {
    try {
      return { ok: true, data: await runModeTracking(req.params.id) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 从最新种子刷新模式库回测指标（复利/非复利收益等），保留关注与每日跟踪。
  app.post('/api/modes/reseed', () => ({ ok: true, data: reseedResearchModes() }));

  app.post<{ Params: { id: string } }>('/api/modes/:id/rebacktest', async (req, reply) => {
    try {
      const bt = await runModeBacktest(req.params.id);
      return { ok: true, data: repo.addBacktest(req.params.id, bt) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ---- 研究标的库 CRUD ----
  app.post<{ Body: ResearchUniverseInput }>('/api/research-universe', (req, reply) => {
    if (!req.body?.code || !req.body?.name) {
      return reply.code(400).send({ ok: false, error: '缺少 code/name' });
    }
    uni.addUniverse(req.body);
    return { ok: true };
  });

  app.put<{ Params: { code: string }; Body: { tags?: string | null; note?: string | null } }>(
    '/api/research-universe/:code',
    (req) => {
      uni.updateUniverse(req.params.code, req.body ?? {});
      return { ok: true };
    },
  );

  app.delete<{ Params: { code: string } }>('/api/research-universe/:code', (req) => {
    uni.removeUniverse(req.params.code);
    return { ok: true };
  });

  // ---- 关注模式每日跟踪定时（默认禁用，到调度页启用）----
  defineModuleSchedules({
    app,
    module: 'modes',
    jobs: [
      {
        id: 'modes.dailyTrack',
        label: '关注模式收盘跟踪（15:10）',
        defaultCron: '10 15 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          await runAllFollowedTracking();
        },
      },
    ],
  });
}
