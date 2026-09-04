import type { FastifyInstance } from 'fastify';
import { SYMBOL_PLAN_OUTCOMES } from '@stock-agent/shared';
import * as repo from './repo';
import { listPlanMarks } from './markSync';
import { evaluateAllLivePlans, evaluatePlanById } from './evaluate';
import { prepareContext } from './orchestrator';
import { regenerateStalePlans } from './regenerate';
import { CAPABILITIES, CAPABILITY_PROBED_AT } from './capability';
import { CONE_STEPS, buildCone } from './projection';
import { calibrationOf, settleDueForecasts } from './forecast';
import { getKline } from '../market/eastmoney';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';

// 标的技术交易计划模块：证据层 + 候选目录 + 计划版本 + 条件求值。
// 计划生成由 agent 工具触发（走统一 gateway），本模块只提供只读与复核路由。
// 一行 registerSymbolPlansModule(app) 接入，删除即整模块下线。
export function registerSymbolPlansModule(app: FastifyInstance): void {
  /** 当前生效计划 */
  app.get<{ Querystring: { code?: string } }>('/api/symbol-plans/active', (req, reply) => {
    const code = req.query?.code?.trim();
    if (!code) return reply.code(400).send({ ok: false, error: '缺少 code' });
    return { ok: true, data: repo.getActivePlan(code) };
  });

  /**
   * 最新一版计划，含失效 / 过期 / 被替代。**只给展示**，业务判定用 /active。
   *
   * 面板必须走这个口：/active 在计划失效后返回 null，照它渲染就会把
   * 「计划刚失效、原因在这儿」显示成「你还没生成过计划」，用户视角是计划凭空消失。
   */
  app.get<{ Querystring: { code?: string } }>('/api/symbol-plans/latest', (req, reply) => {
    const code = req.query?.code?.trim();
    if (!code) return reply.code(400).send({ ok: false, error: '缺少 code' });
    return { ok: true, data: repo.getLatestPlan(code) };
  });

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
  app.post<{ Body: { code?: string; name?: string; secid?: string } }>(
    '/api/symbol-plans/prepare',
    async (req, reply) => {
      const code = req.body?.code?.trim();
      if (!code) return reply.code(400).send({ ok: false, error: '缺少 code' });
      try {
        const snap = await prepareContext({
          code,
          name: req.body?.name,
          secid: req.body?.secid,
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

  /**
   * 收盘复核归因。归因必须是 SYMBOL_PLAN_OUTCOMES 里的枚举——
   * 早先这里收任意字符串塞进 note，于是「这些计划错在哪一类」这个复盘唯一要回答的问题
   * 永远统计不出来。拒绝自由文本，自由描述放 note。
   */
  app.post<{ Params: { id: string }; Body: { outcome?: string; note?: string } }>(
    '/api/symbol-plans/:id/review',
    (req, reply) => {
      const plan = repo.getPlan(req.params.id);
      if (!plan) return reply.code(404).send({ ok: false, error: '计划不存在' });
      const raw = req.body?.outcome?.trim() ?? '';
      const hit = SYMBOL_PLAN_OUTCOMES.find((o) => o.value === raw);
      if (!hit) {
        return reply.code(400).send({
          ok: false,
          error: `outcome 需为以下之一：${SYMBOL_PLAN_OUTCOMES.map((o) => o.value).join(' / ')}`,
        });
      }
      repo.appendEvent({
        planId: plan.id,
        planVersion: plan.version,
        kind: 'reviewed',
        outcome: hit.value,
        note: `${hit.label}${req.body?.note ? `：${req.body.note}` : ''}`,
      });
      return { ok: true };
    },
  );

  /** 可选归因枚举，供前端渲染选项 */
  app.get('/api/symbol-plans/outcomes', async () => ({
    ok: true,
    data: SYMBOL_PLAN_OUTCOMES,
  }));

  /** 归因分布统计，并入战绩页 */
  app.get('/api/symbol-plans/outcome-stats', async () => ({
    ok: true,
    data: repo.planOutcomeStats(),
  }));

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

  /**
   * 走势推演：波动率锥（纯算术）+ 各情景的模型主观概率与历史记录条数。
   *
   * 概率原样回传但不参与任何计算，前端必须标注「模型主观估计，未经校准」。
   * 锥与概率放同一个响应只是省一次往返，两者语义完全独立：
   * 锥说的是「按历史波动会散到哪」，概率说的是「模型觉得往哪走」。
   */
  app.get<{ Querystring: { code?: string; steps?: string; secid?: string } }>(
    '/api/symbol-plans/projection',
    async (req, reply) => {
      const code = req.query?.code?.trim();
      if (!code) return reply.code(400).send({ ok: false, error: '缺少 code' });
      const steps = Math.min(60, Math.max(1, Number(req.query?.steps ?? CONE_STEPS.short) || 5));
      try {
        // 指数/ETF 只能按 secid 取，缺了会按 code 猜到另一只标的上
        const bars = await getKline(code, 'day', 200, req.query?.secid?.trim() || undefined);
        const cone = buildCone(bars, steps);
        const plan = repo.getActivePlan(code);
        const scenarios = (plan?.scenarios ?? [])
          .filter((s) => s.subjectiveProbabilityPct != null)
          .map((s) => ({
            id: s.id,
            rank: s.rank,
            name: s.name,
            probabilityPct: s.subjectiveProbabilityPct!,
            basis: s.probabilityBasis ?? null,
            calibration: calibrationOf(s.subjectiveProbabilityPct!),
          }));
        return { ok: true, data: { cone, scenarios } };
      } catch (e) {
        req.log.error(e);
        return reply.code(500).send({ ok: false, error: '推演取数失败，请稍后重试' });
      }
    },
  );

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
      // 必须排在 closeEval 之后：失效/过期是那一步判定并落库的，
      // 抢在它前面跑的话每天都只会重算「昨天就已失效」的那批，今天新失效的要等到明天。
      {
        id: 'symbolPlans.closeRegenerate',
        label: '标的计划收盘后自动重算失效计划（15:30）',
        defaultCron: '30 15 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          const s = await regenerateStalePlans();
          console.log(
            `[symbolPlans] 收盘重算：待重算 ${s.stale}，成功 ${s.regenerated}，失败 ${s.failed}，` +
              `顺延 ${s.deferred}，算法已变 ${s.outdated}，退出队列 ${s.retired}`,
          );
        },
      },
      // 概率预测核对。放在收盘之后，用的是已收出的日线；
      // 这一步不改变界面上的任何结论，只是让模型报的那个数以后有机会变准——不记录就永远没机会。
      {
        id: 'symbolPlans.settleForecasts',
        label: '情景概率预测核对（15:45）',
        defaultCron: '45 15 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          const s = await settleDueForecasts();
          console.log(
            `[symbolPlans] 预测核对：待判 ${s.checked}，兑现 ${s.settled.hit}，落空 ${s.settled.miss}，` +
              `超时 ${s.settled.timeout}，判不了 ${s.unjudgeable}（缺 secid 且无法确认市场，已终止并留痕）`,
          );
        },
      },
    ],
  });
}
