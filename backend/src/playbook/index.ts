import type { FastifyInstance } from 'fastify';
import type {
  PlaybookBacktestImport,
  PlaybookSpec,
  PlaybookUpsert,
} from '@stock-agent/shared';
import * as repo from './repo';
import { PlaybookBacktestError, runPlaybookBacktest } from './backtest';
import { PlaybookSpecError, validatePlaybookSpec } from './validate';

// 战法库模块：手工收录外部收集的战法（来源 / 适用环境 / 选股·买点·卖点·风控），
// 并按战法自身规则严格回测（站内引擎）或导入外部回测结果。
// 不接 LLM、不接定时、不接 Agent 工具。
// 一行 registerPlaybookModule(app) 接入，删除即整模块下线。
export function registerPlaybookModule(app: FastifyInstance): void {
  app.get('/api/playbooks', () => ({ ok: true, data: repo.listPlaybooks() }));

  app.get<{ Params: { id: string } }>('/api/playbooks/:id', (req, reply) => {
    const item = repo.getPlaybook(req.params.id);
    if (!item) return reply.code(404).send({ ok: false, error: '战法不存在' });
    return { ok: true, data: item };
  });

  app.post<{ Body: PlaybookUpsert }>('/api/playbooks', (req, reply) => {
    if (!req.body?.name?.trim()) return reply.code(400).send({ ok: false, error: '缺少 name' });
    return { ok: true, data: repo.createPlaybook(req.body) };
  });

  app.put<{ Params: { id: string }; Body: PlaybookUpsert }>(
    '/api/playbooks/:id',
    (req, reply) => {
      if (!req.body?.name?.trim()) return reply.code(400).send({ ok: false, error: '缺少 name' });
      const item = repo.updatePlaybook(req.params.id, req.body);
      if (!item) return reply.code(404).send({ ok: false, error: '战法不存在' });
      return { ok: true, data: item };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/playbooks/:id', (req) => {
    repo.removePlaybook(req.params.id);
    return { ok: true };
  });

  // ---- 回测规则 ----

  app.put<{ Params: { id: string }; Body: { spec: PlaybookSpec | null } }>(
    '/api/playbooks/:id/spec',
    (req, reply) => {
      // 存库前必须校验：spec 直接来自 body，`days: 0` 这类值会让回测每根 bar 都判「创新高」
      const raw = req.body?.spec ?? null;
      let spec: PlaybookSpec | null = null;
      try {
        spec = raw === null ? null : validatePlaybookSpec(raw);
      } catch (e) {
        if (e instanceof PlaybookSpecError) return reply.code(400).send({ ok: false, error: e.message });
        throw e;
      }
      const item = repo.setSpec(req.params.id, spec);
      if (!item) return reply.code(404).send({ ok: false, error: '战法不存在' });
      return { ok: true, data: item };
    },
  );

  // ---- 回测记录 ----

  app.get<{ Params: { id: string } }>('/api/playbooks/:id/backtests', (req, reply) => {
    if (!repo.getPlaybook(req.params.id)) {
      return reply.code(404).send({ ok: false, error: '战法不存在' });
    }
    return { ok: true, data: repo.listBacktests(req.params.id) };
  });

  app.get<{ Params: { id: string; bid: string } }>(
    '/api/playbooks/:id/backtests/:bid',
    (req, reply) => {
      const bt = repo.getBacktest(req.params.bid);
      if (!bt || bt.playbookId !== req.params.id) {
        return reply.code(404).send({ ok: false, error: '回测记录不存在' });
      }
      return { ok: true, data: bt };
    },
  );

  /**
   * 站内跑一次回测：默认用战法已存规则，body.spec 可临时覆盖（覆盖时同时存为战法规则，
   * 免得用户调完参数还要单独点保存）。跑完自动落一条记录。
   */
  app.post<{ Params: { id: string }; Body: { spec?: PlaybookSpec; label?: string } | undefined }>(
    '/api/playbooks/:id/backtest',
    async (req, reply) => {
      const pb = repo.getPlaybook(req.params.id);
      if (!pb) return reply.code(404).send({ ok: false, error: '战法不存在' });
      const spec = req.body?.spec ?? pb.spec ?? null;
      try {
        const r = await runPlaybookBacktest(spec as PlaybookSpec);
        if (req.body?.spec) repo.setSpec(req.params.id, req.body.spec);
        const label = req.body?.label?.trim() || `站内回测 ${r.range || nowLabel()}`;
        return {
          ok: true,
          data: repo.addBacktest(req.params.id, {
            label,
            source: 'system',
            range: r.range,
            poolSize: r.poolSize,
            metrics: r.metrics,
            trades: r.trades,
            equity: r.equity,
            notes: r.notes,
            spec: spec as PlaybookSpec,
          }),
        };
      } catch (e) {
        // 规则不完整/标的池为空属参数问题，取数失败属上游问题，分开给码
        const msg = e instanceof Error ? e.message : String(e);
        const badRequest = e instanceof PlaybookBacktestError || e instanceof PlaybookSpecError;
        return reply.code(badRequest ? 400 : 502).send({ ok: false, error: msg });
      }
    },
  );

  /** 外部导入回测结果（codex / python 推送，或前端手工填） */
  app.post<{ Params: { id: string }; Body: PlaybookBacktestImport }>(
    '/api/playbooks/:id/backtests',
    (req, reply) => {
      if (!repo.getPlaybook(req.params.id)) {
        return reply.code(404).send({ ok: false, error: '战法不存在' });
      }
      const body = req.body;
      if (!body?.label?.trim()) return reply.code(400).send({ ok: false, error: '缺少 label' });
      if (!body.metrics || typeof body.metrics !== 'object') {
        return reply.code(400).send({ ok: false, error: '缺少 metrics' });
      }
      return {
        ok: true,
        data: repo.addBacktest(req.params.id, {
          label: body.label.trim(),
          source: 'external',
          range: body.range ?? null,
          poolSize: body.poolSize ?? null,
          metrics: body.metrics,
          trades: body.trades ?? [],
          equity: body.equity ?? [],
          notes: body.notes ?? [],
          spec: null,
        }),
      };
    },
  );

  app.delete<{ Params: { id: string; bid: string } }>(
    '/api/playbooks/:id/backtests/:bid',
    (req) => {
      repo.removeBacktest(req.params.bid);
      return { ok: true };
    },
  );
}

/** 未取到区间时的回测标签兜底 */
function nowLabel(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}
