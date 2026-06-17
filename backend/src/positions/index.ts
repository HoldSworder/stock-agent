import type { FastifyInstance } from 'fastify';
import type {
  DisciplineConfig,
  DisciplineOverrideInput,
  VsSimReport,
  VsSimStrategyRow,
} from '@stock-agent/shared';
import { sendTelegram } from '../notify/telegram';
import { getMeta, setMeta } from '../settings';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { fetchRealPositions } from '../realPositions';
import { listStrategies } from '../strategy/sim';
import { computeForwardStats } from '../strategy/forward';
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
import { getAttribution, runAttribution } from './attribution';

// 真实持仓纪律模块：确定性体检（只读不下单）+ 逐票纪律覆盖 + 事件流 + 收盘前定时体检推送
// + 日终持仓归因 + 真实 vs 模拟战法绩效对照（均只读，绝不对真实账户下单）。
// server.ts 仅需 registerPositionsModule(app) 一行接入，删除即整模块下线。
// 与「持仓辩论」(decision 模块) 互补：本模块是不耗 token 的硬规则体检，辩论是 LLM 深度研判。

const CODE_RE = /^\d{6}$/;

/** medium 严重度纪律事件是否推送的 meta 开关（默认开） */
const PUSH_MEDIUM_META = 'discipline_push_medium';
function isPushMediumEnabled(): boolean {
  return (getMeta(PUSH_MEDIUM_META) ?? 'true') !== 'false';
}

/** 构造真实 vs 模拟战法绩效对照（只读，不反哺调参） */
async function buildVsSim(): Promise<VsSimReport> {
  // 真实账户：取实时持仓汇总；同花顺未配置等异常时降级为 realError，不阻断模拟侧对照
  let real: VsSimReport['real'] = null;
  let realError: string | null = null;
  try {
    const pf = await fetchRealPositions(false);
    const top = [...pf.positions].sort((a, b) => b.positionRate - a.positionRate)[0];
    real = {
      totalAsset: pf.totalAsset,
      todayProfit: pf.totalTodayProfit,
      todayRate: pf.totalAsset > 0 ? pf.totalTodayProfit / pf.totalAsset : 0,
      totalHoldProfit: pf.totalHoldProfit,
      topConcentration: top ? top.positionRate : 0,
      positionCount: pf.positionCount,
    };
  } catch (e) {
    realError = e instanceof Error ? e.message : String(e);
  }

  // 模拟侧：各本地战法前向统计（含 A3 的 Alpha）
  const locals = listStrategies().filter((s) => s.kind === 'local');
  const strategies: VsSimStrategyRow[] = await Promise.all(
    locals.map(async (s) => {
      const fwd = await computeForwardStats(s.id);
      return {
        strategyId: s.id,
        strategyName: s.name,
        cumReturn: fwd.cumReturn,
        alpha: fwd.alpha,
        maxDrawdown: fwd.maxDrawdown,
        winRate: fwd.winRate,
        screenStrategyName: fwd.screenStrategyName,
      };
    }),
  );

  return { asOf: new Date().toISOString(), real, realError, strategies };
}

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

  // medium 纪律事件推送开关（默认开）
  app.get('/api/positions/discipline/push-medium', () => ({
    ok: true,
    data: { enabled: isPushMediumEnabled() },
  }));
  app.put<{ Body: { enabled?: boolean } }>('/api/positions/discipline/push-medium', (req) => {
    setMeta(PUSH_MEDIUM_META, req.body?.enabled === false ? 'false' : 'true');
    return { ok: true, data: { enabled: isPushMediumEnabled() } };
  });

  // 日终持仓归因：取某日已落库归因；无 date 取最近一日
  app.get<{ Querystring: { date?: string } }>('/api/positions/attribution', (req, reply) => {
    try {
      return { ok: true, data: getAttribution(req.query.date) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 真实 vs 模拟战法绩效对照（只读）
  app.get('/api/positions/vs-sim', async (_req, reply) => {
    try {
      return { ok: true, data: await buildVsSim() };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 定时任务统一登记（经 defineModuleSchedules，避免与其它窗口双跑）。纯读不下单，安全；
  // 默认禁用，配好真实持仓数据源后到中枢·调度页启用。
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
          // 分级推送：high 必推，medium 受开关控制；合并为一条「少推准推」清单（high 置顶）。
          const high = created.filter((e) => e.severity === 'high');
          const medium = isPushMediumEnabled()
            ? created.filter((e) => e.severity === 'medium')
            : [];
          if (high.length + medium.length > 0) {
            const fmt = (e: (typeof created)[number]) => `• ${e.name}(${e.code})：${e.detail}`;
            const blocks: string[] = [];
            if (high.length) blocks.push(`🔴 需处理 ${high.length} 项：\n${high.map(fmt).join('\n')}`);
            if (medium.length) blocks.push(`🟡 关注 ${medium.length} 项：\n${medium.map(fmt).join('\n')}`);
            await sendTelegram(`📏 持仓纪律体检\n${blocks.join('\n\n')}`);
          }
        },
      },
      {
        id: 'positions.attribution.eod',
        label: '日终持仓归因（收盘 16:10）',
        defaultCron: '10 16 * * 1-5',
        run: async () => {
          const report = await runAttribution();
          if (report.items.length === 0) return;
          const sign = (v: number) => (v >= 0 ? '+' : '');
          const parts: string[] = [
            `📊 今日持仓归因（${report.date}）账户 ${sign(report.totalDayPnl)}${report.totalDayPnl.toFixed(0)} 元`,
          ];
          if (report.topWinner) {
            parts.push(
              `🏆 赢家 ${report.topWinner.name}(${report.topWinner.code}) ${sign(report.topWinner.dayPnl)}${report.topWinner.dayPnl.toFixed(0)} 元`,
            );
          }
          if (report.topLoser) {
            parts.push(
              `📉 输家 ${report.topLoser.name}(${report.topLoser.code}) ${report.topLoser.dayPnl.toFixed(0)} 元`,
            );
          }
          await sendTelegram(parts.join('\n'));
        },
      },
    ],
  });
}
