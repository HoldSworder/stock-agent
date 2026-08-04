import type { FastifyInstance } from 'fastify';
import type { SymbolPlanHorizon } from '@stock-agent/shared';
import * as repo from './repo';
import { listPlanMarks } from './markSync';
import { evaluateAllLivePlans, evaluatePlanById } from './evaluate';
import { prepareContext } from './orchestrator';
import { CAPABILITIES, CAPABILITY_PROBED_AT } from './capability';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';

// 标的技术交易计划模块：证据层 + 候选目录 + 计划版本 + 条件求值。
// 计划生成由 agent 工具触发（走统一 gateway），本模块只提供只读与复核路由。
// 一行 registerSymbolPlansModule(app) 接入，删除即整模块下线。
/** horizon 白名单：非法值不得静默按 3 天有效期处理 */
const HORIZONS: SymbolPlanHorizon[] = ['next_session', 'swing'];
const parseHorizon = (v: unknown): SymbolPlanHorizon | null =>
  typeof v === 'string' && HORIZONS.includes(v as SymbolPlanHorizon) ? (v as SymbolPlanHorizon) : null;

export function registerSymbolPlansModule(app: FastifyInstance): void {
  /** 当前生效计划 */
  app.get<{ Querystring: { code?: string; horizon?: SymbolPlanHorizon } }>(
    '/api/symbol-plans/active',
    (req, reply) => {
      const code = req.query?.code?.trim();
      if (!code) return reply.code(400).send({ ok: false, error: '缺少 code' });
      const horizon = parseHorizon(req.query?.horizon ?? 'next_session');
      if (!horizon) return reply.code(400).send({ ok: false, error: 'horizon 非法' });
      return { ok: true, data: repo.getActivePlan(code, horizon) };
    },
  );

  /** 历史版本（不可覆盖，全部保留） */
  app.get<{ Querystring: { code?: string; limit?: string } }>(
    '/api/symbol-plans/history',
    (req, reply) => {
      const code = req.query?.code?.trim();
      if (!code) return reply.code(400).send({ ok: false, error: '缺少 code' });
      const limit = Math.min(100, Math.max(1, Number(req.query?.limit ?? 20) || 20));
      return { ok: true, data: repo.listPlanHistory(code, limit) };
    },
  );

  /** 单份计划详情 + 事件 + 标注 */
  app.get<{ Params: { id: string } }>('/api/symbol-plans/:id', (req, reply) => {
    const plan = repo.getPlan(req.params.id);
    if (!plan) return reply.code(404).send({ ok: false, error: '计划不存在' });
    return {
      ok: true,
      data: { plan, events: repo.listEvents(plan.id), marks: listPlanMarks(plan.id) },
    };
  });

  /**
   * 预备上下文与候选目录（只读，不生成计划）。
   * 供前端「生成计划」前预览证据，也供调试。真正生成走 agent 工具。
   */
  app.post<{ Body: { code?: string; name?: string; secid?: string; horizon?: SymbolPlanHorizon } }>(
    '/api/symbol-plans/prepare',
    async (req, reply) => {
      const code = req.body?.code?.trim();
      if (!code) return reply.code(400).send({ ok: false, error: '缺少 code' });
      const horizon = parseHorizon(req.body?.horizon ?? 'next_session');
      if (!horizon) return reply.code(400).send({ ok: false, error: 'horizon 非法' });
      try {
        const snap = await prepareContext({
          code,
          name: req.body?.name,
          secid: req.body?.secid,
          horizon,
        });
        return {
          ok: true,
          data: {
            context: snap.context,
            catalog: snap.catalog,
            risk: snap.risk,
            execution: snap.execution,
            marketAction: snap.marketAction,
            primaryAction: snap.primaryAction,
            actionReasons: snap.actionReasons,
          },
        };
      } catch (e) {
        return reply
          .code(500)
          .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  /** 手动复核：按最新行情逐条求值。只读口径，不重复写 condition_hit 事件 */
  app.post<{ Params: { id: string } }>('/api/symbol-plans/:id/evaluate', async (req, reply) => {
    try {
      const ev = await evaluatePlanById(req.params.id, { readOnly: true });
      if (!ev) return reply.code(404).send({ ok: false, error: '计划不存在' });
      return { ok: true, data: ev };
    } catch (e) {
      // 内部要取行情，取数失败不能把错误栈透给前端
      req.log.error(e);
      return reply.code(500).send({ ok: false, error: '复核失败，请稍后重试' });
    }
  });

  /** 收盘复核归因 */
  app.post<{ Params: { id: string }; Body: { outcome?: string; note?: string } }>(
    '/api/symbol-plans/:id/review',
    (req, reply) => {
      const plan = repo.getPlan(req.params.id);
      if (!plan) return reply.code(404).send({ ok: false, error: '计划不存在' });
      const outcome = req.body?.outcome?.trim() || 'correct_wait';
      repo.appendEvent({
        planId: plan.id,
        planVersion: plan.version,
        kind: 'reviewed',
        note: `${outcome}${req.body?.note ? `：${req.body.note}` : ''}`,
      });
      return { ok: true };
    },
  );

  /** 手动过期 */
  app.post<{ Params: { id: string } }>('/api/symbol-plans/:id/expire', (req, reply) => {
    const plan = repo.getPlan(req.params.id);
    if (!plan) return reply.code(404).send({ ok: false, error: '计划不存在' });
    repo.updateStatus(plan.id, 'expired');
    repo.appendEvent({
      planId: plan.id,
      planVersion: plan.version,
      kind: 'expired',
      note: '用户手动置为过期',
    });
    return { ok: true };
  });

  /** 能力矩阵：前端据此显示「未覆盖范围」 */
  app.get('/api/symbol-plans/capabilities', () => ({
    ok: true,
    data: { probedAt: CAPABILITY_PROBED_AT, capabilities: CAPABILITIES },
  }));

  // bar 级条件求值：技术条件只在新 bar 收出后算，不进 10 秒轮询（R19 分频）。
  // 盘中 30 分钟一次覆盖 15m/60m 新 bar；收盘后一次做日线口径复核。
  defineModuleSchedules({
    app,
    module: 'symbolPlans',
    jobs: [
      {
        id: 'symbolPlans.intradayBarEval',
        label: '标的计划盘中 bar 级复核（每 30 分钟）',
        defaultCron: '5,35 9-11,13-14 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          await evaluateAllLivePlans();
        },
      },
      {
        id: 'symbolPlans.closeEval',
        label: '标的计划收盘复核（15:20）',
        defaultCron: '20 15 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          await evaluateAllLivePlans();
        },
      },
    ],
  });
}
