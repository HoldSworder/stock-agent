import type { FastifyInstance } from 'fastify';
import type { MarketThemeStatus, NotifyChannel, RunTrigger } from '@stock-agent/shared';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { runTask, type RunTaskResult } from '../runner';
import { listMarketBoardReviews } from '../repo';
import {
  buildMarketBoardPrompt,
  buildOverview,
  MARKET_BOARD_TASK_NAME,
} from '../market/overview';
import { listThemes, refreshThemes, setThemeStatus } from './service';

// 结构化市场主线模块：以东财真实板块为主源沉淀 market_themes，并承载合并后的「大盘与板块研判」AI 分析。
// server.ts 仅需 registerThemesModule(app) 一行接入，删除即整模块下线。
// 确定性聚合不下单、不调 LLM；研判任务经 gateway（runTask）跑 agent，成功落 taskRun 供今日计划复用。
// 合并：原「大盘复盘点评」+「板块主线研判」收敛为单一「大盘与板块研判」，单 kind/单定时/单计划源。

const VALID_STATUS: MarketThemeStatus[] = ['active', 'fading', 'archived'];

/**
 * 大盘与板块研判统一执行体：一次 agent 同时做大盘复盘点评（盘面快照）+ 板块主线研判
 * （market_board_strength 确定性底稿过滤），成功落 taskRun（taskName=大盘与板块研判），
 * 供今日计划生成读取与大盘页各 Tab 展示。手动与定时共用。
 */
export async function runMarketBoardReview(opts: {
  trigger: RunTrigger;
  channels: NotifyChannel[];
}): Promise<RunTaskResult> {
  const ov = await buildOverview();
  return runTask(
    {
      id: null,
      name: MARKET_BOARD_TASK_NAME,
      prompt: await buildMarketBoardPrompt(ov),
      modelConfig: { thinking: false, maxSteps: 12, maxTokens: 14000 },
      notifyChannels: opts.channels,
      timeoutSec: 600,
      purpose: 'market-review',
    },
    opts.trigger,
  );
}

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

  // 大盘与板块研判历史（成功运行，倒序；union 旧大盘复盘点评/板块主线研判，大盘页 Tab 顶部取最新一条展示结论）
  app.get<{ Querystring: { limit?: string } }>('/api/themes/board-reviews', (req) => ({
    ok: true,
    data: listMarketBoardReviews(req.query?.limit ? Number(req.query.limit) : undefined),
  }));

  // 按需触发一次「大盘与板块研判」agent 任务（盘面快照大盘复盘 + market_board_strength 底稿过滤板块主线 → 落库）
  app.post('/api/themes/board-review', async (_req, reply) => {
    try {
      const result = await runMarketBoardReview({ trigger: 'manual', channels: ['webui'] });
      return {
        ok: result.status === 'success',
        data: { runId: result.runId, status: result.status, text: result.outputText },
        error: result.status === 'success' ? undefined : `大盘与板块研判未成功（${result.status}）`,
      };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 收盘后定时：大盘与板块研判（合并大盘复盘 + 板块主线，单一定时；底稿取数在 market_board_strength 工具内完成）。
  // 复用原 themes.boardReview 调度槽位，避免历史调度配置失效。默认禁用，配好行情/模型后到调度页启用。
  defineModuleSchedules({
    app,
    module: 'themes',
    jobs: [
      {
        id: 'themes.boardReview',
        label: '大盘与板块研判（收盘后 15:40）',
        defaultCron: '40 15 * * 1-5',
        run: async () => {
          await runMarketBoardReview({ trigger: 'cron', channels: ['webui', 'telegram'] });
        },
      },
    ],
  });
}
