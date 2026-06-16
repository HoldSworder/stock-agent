import type { FastifyInstance } from 'fastify';
import { runTask } from '../runner';
import { sendTelegram } from '../notify/telegram';
import { computePlanFulfillment } from '../plan/service';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import {
  buildDeepReviewPrompt,
  buildReviewDigest,
  DEEP_REVIEW_TASK_NAME,
  onDeepReviewComplete,
} from './service';

// 挂载复盘模块定时：注册 /api/review/schedules。
// server.ts 仅需 registerReviewModule(app) 一行接入，删除即整模块下线。
// 深度复盘产出结构化 JSON 落 WebUI；原 market.review（15:05 大盘点评）已并入此处，
// 收盘后由本任务额外推一条「确定性 TG 摘要」（结构化结果 + 计划兑现度统计），承接其推送职责。

export function registerReviewModule(app: FastifyInstance): void {
  defineModuleSchedules({
    app,
    module: 'review',
    jobs: [
      {
        id: 'review.eod',
        label: '收盘后深度复盘',
        defaultCron: '35 15 * * 1-5',
        run: async () => {
          const prompt = await buildDeepReviewPrompt();
          const result = await runTask(
            {
              id: null,
              name: DEEP_REVIEW_TASK_NAME,
              prompt,
              modelConfig: { thinking: false, maxSteps: 8, maxTokens: 16000 },
              notifyChannels: ['webui'],
              timeoutSec: 420,
              purpose: 'review',
            },
            'cron',
          );
          // 复盘验证结论结构化回流共享主线（写 phase/强度/退潮态），best-effort。
          if (result.status === 'success') onDeepReviewComplete(result.outputText);
          // 确定性 TG 摘要：结构化结果解析 + 计划兑现度纯统计，best-effort，不阻断复盘落库。
          if (result.status === 'success' && result.outputText) {
            try {
              const digest = buildReviewDigest(result.outputText, computePlanFulfillment());
              await sendTelegram(digest);
            } catch (e) {
              console.warn('[review] 收盘摘要推送失败:', e instanceof Error ? e.message : e);
            }
          }
        },
      },
    ],
  });
}
