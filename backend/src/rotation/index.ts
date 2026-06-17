import type { FastifyInstance } from 'fastify';
import { runTask } from '../runner';
import { listEtfAnalyzeReviews } from '../repo';
import { buildRotationOverview, runMidDrilldown } from './service';
import { ETF_ANALYZE_PROMPT, ETF_ANALYZE_TASK_NAME } from '../etf/service';
import { cached } from '../lib/ttlCache';

// M1 ETF 行业轮动模块：仅保留确定性轮动榜（buildRotationOverview）。
// server.ts 仅需 registerRotationModule(app) 一行接入，删除即整模块下线。
// 合并后：ETF 轮动研判已并入「ETF 综合研判」（etf-analyze 单 kind/单定时 15:45，见 etf 模块），
// 本模块不再单独跑轮动 AI 研判，仅提供确定性轮动榜数据与「最新 ETF 综合研判」历史展示给 ETF 页轮动 Tab。

export function registerRotationModule(app: FastifyInstance): void {
  // 轮动榜确定性总览（只读，不调 LLM）
  app.get('/api/rotation/overview', async (_req, reply) => {
    try {
      // 响应级 120s 缓存：轮动榜复用 ETF 指标层聚合较重，中线视图慢变
      return { ok: true, data: await cached('rotation:overview', 120_000, buildRotationOverview) };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // M2 中线下钻：强赛道 ETF → 成分股 universe → 中线龙头选股（确定性 + 可选 LLM 横排，落库 screen_runs）
  app.post<{ Body?: { topEtf?: number; pickTopN?: number; context?: string; useLlm?: boolean } }>(
    '/api/rotation/drilldown',
    async (req, reply) => {
      try {
        const b = req.body ?? {};
        const data = await runMidDrilldown({
          topEtf: b.topEtf,
          pickTopN: b.pickTopN,
          context: b.context,
          useLlm: b.useLlm,
          trigger: 'manual',
        });
        return { ok: true, data };
      } catch (e) {
        return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  // 「ETF 综合研判」历史（合并后单一 ETF AI 分析；union 旧 ETF行业轮动研判/市场点评，ETF 页轮动 Tab 顶部取最新一条）
  app.get<{ Querystring: { limit?: string } }>('/api/rotation/reviews', (req) => ({
    ok: true,
    data: listEtfAnalyzeReviews(req.query?.limit ? Number(req.query.limit) : undefined),
  }));

  // 按需触发一次「ETF 综合研判」agent 任务（量化信号 + 中线轮动 + 持仓/消息 → 落库）
  app.post('/api/rotation/review', async (_req, reply) => {
    try {
      const result = await runTask(
        {
          id: null,
          name: ETF_ANALYZE_TASK_NAME,
          prompt: ETF_ANALYZE_PROMPT,
          modelConfig: { thinking: false, maxSteps: 14, maxTokens: 14000 },
          notifyChannels: ['webui'],
          timeoutSec: 600,
          purpose: 'analyze',
        },
        'manual',
      );
      return {
        ok: result.status === 'success',
        data: { runId: result.runId, status: result.status, text: result.outputText },
        error: result.status === 'success' ? undefined : `ETF 综合研判未成功（${result.status}）`,
      };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
