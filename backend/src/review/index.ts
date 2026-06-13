import type { FastifyInstance } from 'fastify';
import { runTask } from '../runner';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { buildDeepReviewPrompt, DEEP_REVIEW_TASK_NAME } from './service';

// 挂载复盘模块定时：注册 /api/review/schedules。
// server.ts 仅需 registerReviewModule(app) 一行接入，删除即整模块下线。
// 深度复盘产出结构化 JSON（复用 listReviews 历史），仅落 WebUI，不推 Telegram（JSON 不适合直推）。

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
          await runTask(
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
        },
      },
    ],
  });
}
