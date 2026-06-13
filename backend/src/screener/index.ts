import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ScreenRunDetail } from '@stock-agent/shared';
import * as svc from './service';
import { sendTelegram } from '../notify/telegram';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';

// 挂载选股引擎模块：注册 /api/screener/*。
// server.ts 仅需 registerScreenerModule(app) 一行接入，删除即整模块下线。
// 三层漏斗：全市场快照 → 规则硬筛 → 多因子打分 → LLM 横排 → 组合去集中 → TopN。

/** TopN 结果转 Telegram 文案（含现价，便于盘后复盘基准） */
function toTelegram(detail: ScreenRunDetail): string {
  const head = `【选股·${detail.strategyName}】Top${detail.picks.length}（全市场${detail.marketCount}→硬筛${detail.filteredCount}）`;
  const view = detail.marketView ? `\n大盘：${detail.marketView}` : '';
  const lines = detail.picks.map((p) => {
    const tags = p.riskTags.length ? ` ⚠️${p.riskTags.join('/')}` : '';
    const thesis = p.thesis ? `\n   ${p.thesis}` : '';
    return `${p.rank}. ${p.name}(${p.code}) ${p.price} ${p.pct >= 0 ? '+' : ''}${p.pct}% 分${p.screenScore}${tags}${thesis}`;
  });
  return `${head}${view}\n${lines.join('\n')}`;
}

export function registerScreenerModule(app: FastifyInstance): void {
  const fail = (reply: FastifyReply, e: unknown) =>
    reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });

  // 模块内定时：每个交易日收盘后跑默认策略出 TopN，best-effort 推 Telegram
  defineModuleSchedules({
    app,
    module: 'screener',
    jobs: [
      {
        id: 'screener.daily',
        label: '每日收盘选股（15:10）',
        defaultCron: '10 15 * * 1-5',
        defaultEnabled: false,
        run: async () => {
          const detail = await svc.runScreen({
            trigger: 'cron',
            taskName: '每日收盘选股',
          });
          await sendTelegram(toTelegram(detail)).catch(() => {});
        },
      },
    ],
  });

  app.get('/api/screener/status', async () => ({ ok: true, data: svc.status() }));

  // 页内默认配置（本条多因子链路：默认策略 + 默认 TopN，供收盘定时任务用）
  app.put<{ Body: { strategyId?: string; topN?: number } }>(
    '/api/screener/config',
    (req) => {
      const b = req.body ?? {};
      return { ok: true, data: svc.setDefaults({ strategyId: b.strategyId, topN: b.topN }) };
    },
  );

  app.get<{ Querystring: { limit?: string } }>('/api/screener/runs', (req) => ({
    ok: true,
    data: svc.listRuns(req.query?.limit ? Number(req.query.limit) : undefined),
  }));

  app.get<{ Params: { id: string } }>('/api/screener/runs/:id', (req, reply) => {
    const detail = svc.getRunDetail(req.params.id);
    if (!detail) return reply.code(404).send({ ok: false, error: '选股记录不存在' });
    return { ok: true, data: detail };
  });

  // 手动选股（同步执行，含全市场取数 + LLM 横排，较慢）
  app.post<{
    Body: { engine?: string; strategyId?: string; context?: string; topN?: number; useLlm?: boolean };
  }>('/api/screener/run', async (req, reply) => {
    try {
      const b = req.body ?? {};
      const data = await svc.runScreen({
        engine: b.engine,
        strategyId: b.strategyId,
        context: b.context,
        topN: b.topN,
        useLlm: b.useLlm,
        trigger: 'manual',
        taskName: '手动选股',
      });
      return { ok: true, data };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // T+N 轻量复盘：用最新快照价回填区间收益
  app.post<{ Params: { id: string } }>('/api/screener/runs/:id/eval', async (req, reply) => {
    try {
      const r = await svc.evalRun(req.params.id);
      return { ok: true, data: { ...r, detail: svc.getRunDetail(req.params.id) } };
    } catch (e) {
      return fail(reply, e);
    }
  });
}
