import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AssertionSource } from '@stock-agent/shared';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { shanghaiToday } from '../util';
import { buildCalendar } from './calendar';
import {
  accuracyBySource,
  buildReport,
  freezeAll,
  freezeOne,
  listAssertions,
  settleDue,
  trackedCodes,
} from './service';

// 技术断言账本模块。自包含：删掉 server.ts 里那一行接入即整模块下线。

const fail = (reply: FastifyReply, e: unknown): FastifyReply =>
  reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });

/** 统计默认回看天数 */
const DEFAULT_LOOKBACK_DAYS = 180;

function sinceOf(raw: unknown): string {
  const days = Number(raw);
  const n = Number.isFinite(days) && days > 0 ? Math.min(1000, days) : DEFAULT_LOOKBACK_DAYS;
  const d = new Date(`${shanghaiToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function registerAssertionsModule(app: FastifyInstance): void {
  /** 战绩总览：四维切片 + AI 情景统计 */
  app.get<{ Querystring: { days?: string } }>('/api/assertions/report', async (req, reply) => {
    try {
      return { ok: true, data: buildReport(sinceOf(req.query?.days)) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 转折日历：未来若干天内各标的的波浪时间位。
   *
   * asOf 可回放历史交易日——自检据此验证「8/20 那天系统是否已经说出 8/25」。
   */
  app.get<{ Querystring: { days?: string; asOf?: string } }>(
    '/api/assertions/calendar',
    async (req, reply) => {
      try {
        const raw = Number(req.query?.days);
        const days = Number.isFinite(raw) && raw > 0 ? Math.min(120, raw) : undefined;
        const asOf = req.query?.asOf;
        if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
          return reply.code(400).send({ ok: false, error: 'asOf 需为 YYYY-MM-DD' });
        }
        return { ok: true, data: buildCalendar(days, asOf) };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  /** 某标的各来源的遵循率，供详情页把统计挂到价位旁边 */
  app.get<{ Querystring: { code?: string } }>('/api/assertions/by-source', async (req, reply) => {
    try {
      const code = req.query?.code;
      if (code && !/^\d{6}$/.test(code)) {
        return reply.code(400).send({ ok: false, error: '非法标的代码' });
      }
      return { ok: true, data: accuracyBySource(code) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 下钻明细 */
  app.get<{
    Querystring: {
      code?: string;
      source?: string;
      kind?: string;
      period?: string;
      outcome?: string;
      limit?: string;
    };
  }>('/api/assertions/list', async (req, reply) => {
    try {
      const q = req.query ?? {};
      return {
        ok: true,
        data: listAssertions({
          code: q.code,
          source: q.source,
          kind: q.kind,
          period: q.period,
          outcome: q.outcome,
          limit: Number(q.limit) || undefined,
        }),
      };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 手动冻结（补数据 / 调试）。asOf 可回填历史交易日 */
  app.post<{ Body: { code?: string; asOf?: string } }>(
    '/api/assertions/freeze',
    async (req, reply) => {
      try {
        const asOf = req.body?.asOf ?? shanghaiToday();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
          return reply.code(400).send({ ok: false, error: 'asOf 需为 YYYY-MM-DD' });
        }
        if (req.body?.code) {
          if (!/^\d{6}$/.test(req.body.code)) {
            return reply.code(400).send({ ok: false, error: '非法标的代码' });
          }
          const t = trackedCodes().find((x) => x.code === req.body!.code);
          const written = await freezeOne(req.body.code, t?.secid ?? null, asOf);
          return { ok: true, data: { codes: 1, written, failed: 0 } };
        }
        return { ok: true, data: await freezeAll(asOf) };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  /** 手动结算 */
  app.post('/api/assertions/settle', async (_req, reply) => {
    try {
      return { ok: true, data: await settleDue() };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 冻结排在 symbolPlans.settleForecasts(15:45) 之后：那一步会更新计划状态，
  // 而跟踪范围里含「有活跃计划的标的」，先跑会把刚失效的计划标的也冻进来。
  defineModuleSchedules({
    app,
    module: 'assertions',
    jobs: [
      {
        id: 'assertions.freeze',
        label: '技术判断存档（15:50）',
        defaultCron: '50 15 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          const s = await freezeAll();
          console.log(
            `[assertions] 存档：标的 ${s.codes}，写入 ${s.written} 条判断，失败 ${s.failed}`,
          );
        },
      },
      // 结算必须排在冻结之后，否则当天新冻的那批会被立刻拿去判——
      // 而它们的判定窗口(barsAfter)此刻还是空的，白跑一趟
      {
        id: 'assertions.settle',
        label: '技术判断核对（15:55）',
        defaultCron: '55 15 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          const s = await settleDue();
          console.log(
            `[assertions] 核对：待判 ${s.checked}，遵循 ${s.settled.respected}，` +
              `未遵循 ${s.settled.violated}，未触及 ${s.settled.untouched}，判不了 ${s.settled.unjudgeable}`,
          );
        },
      },
    ],
  });
}

export type { AssertionSource };
