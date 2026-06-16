import type { FastifyInstance } from 'fastify';
import { runTask } from '../runner';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import {
  buildOverview,
  buildMarketBoardPrompt,
  MARKET_BOARD_TASK_NAME,
} from './overview';

// 挂载大盘模块定时：注册 /api/market/schedules。
// 期货+外盘已源级合并进「大盘与板块研判」，不再单独定时。
// 原「定时大盘复盘点评」(15:05) 与收盘深度复盘 review.eod 高度重复，已并入后者（见 review/index.ts），此处下线。

export function registerMarketSchedule(app: FastifyInstance): void {
  defineModuleSchedules({
    app,
    module: 'market',
    jobs: [
      {
        // 大盘与板块研判定时：与手动（/ws/analyze kind=market-board）同口径，落 task_runs
        // 供今日计划「大盘 + 板块/中线 + 期货外盘」基准源。默认禁用，与 review.eod(15:35) 错开避免双跑。
        id: 'market.boardReview',
        label: '大盘与板块研判（收盘后 1540）',
        defaultCron: '40 15 * * 1-5',
        run: async () => {
          const ov = await buildOverview();
          await runTask(
            {
              id: null,
              name: MARKET_BOARD_TASK_NAME,
              prompt: await buildMarketBoardPrompt(ov),
              modelConfig: { thinking: false, maxSteps: 12, maxTokens: 14000 },
              notifyChannels: ['webui', 'telegram'],
              timeoutSec: 600,
              purpose: 'market-review',
            },
            'cron',
          );
        },
      },
    ],
  });
}
