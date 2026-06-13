import type { FastifyInstance } from 'fastify';
import type { DisciplineConfig, DisciplineOverrideInput } from '@stock-agent/shared';
import { sendTelegram } from '../notify/telegram';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import {
  evaluateDiscipline,
  getDisciplineConfig,
  setDisciplineConfig,
  listOverrides,
  setOverride,
  removeOverride,
  listDisciplineEvents,
  recordDisciplineEvents,
} from './discipline';

// 真实持仓纪律模块：确定性体检（只读不下单）+ 逐票纪律覆盖 + 事件流 + 收盘前定时体检推送。
// server.ts 仅需 registerPositionsModule(app) 一行接入，删除即整模块下线。
// 与「持仓辩论」(decision 模块) 互补：本模块是不耗 token 的硬规则体检，辩论是 LLM 深度研判。

const CODE_RE = /^\d{6}$/;

export function registerPositionsModule(app: FastifyInstance): void {
  const fail = (reply: import('fastify').FastifyReply, e: unknown) =>
    reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });

  // 实时纪律体检（取实时持仓现算）
  app.get('/api/positions/discipline', async (_req, reply) => {
    try {
      return { ok: true, data: await evaluateDiscipline() };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 账户级默认纪律阈值
  app.get('/api/positions/discipline/config', () => ({ ok: true, data: getDisciplineConfig() }));
  app.put<{ Body: Partial<DisciplineConfig> }>('/api/positions/discipline/config', (req) => ({
    ok: true,
    data: setDisciplineConfig(req.body ?? {}),
  }));

  // 逐票纪律覆盖
  app.get('/api/positions/discipline/overrides', () => ({ ok: true, data: listOverrides() }));
  app.put<{ Params: { code: string }; Body: DisciplineOverrideInput }>(
    '/api/positions/discipline/overrides/:code',
    (req, reply) => {
      if (!CODE_RE.test(req.params.code)) {
        return reply.code(400).send({ ok: false, error: '请输入 6 位股票代码' });
      }
      return { ok: true, data: setOverride(req.params.code, req.body ?? {}) };
    },
  );
  app.delete<{ Params: { code: string } }>(
    '/api/positions/discipline/overrides/:code',
    (req) => {
      removeOverride(req.params.code);
      return { ok: true };
    },
  );

  // 纪律事件历史
  app.get<{ Querystring: { limit?: string } }>('/api/positions/discipline/events', (req) => ({
    ok: true,
    data: listDisciplineEvents(req.query.limit ? Number(req.query.limit) : undefined),
  }));

  // 收盘前确定性纪律体检定时：体检 → 记事件（按日去重）→ 高严重度命中推 Telegram。
  // 纯读不下单，安全；默认禁用，配好真实持仓数据源后到中枢·调度页启用。
  defineModuleSchedules({
    app,
    module: 'positions',
    jobs: [
      {
        id: 'positions.discipline.intraday',
        label: '持仓纪律体检（盘中 14:40）',
        defaultCron: '40 14 * * 1-5',
        run: async () => {
          const report = await evaluateDiscipline();
          const created = recordDisciplineEvents(report);
          const high = created.filter((e) => e.severity === 'high');
          if (high.length > 0) {
            const lines = high.map((e) => `• ${e.name}(${e.code})：${e.detail}`);
            await sendTelegram(`📏 持仓纪律体检命中 ${high.length} 项需处理：\n${lines.join('\n')}`);
          }
        },
      },
    ],
  });
}
