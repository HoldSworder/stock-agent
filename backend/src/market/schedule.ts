import type { FastifyInstance } from 'fastify';
import { runTask } from '../runner';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import {
  buildOverview,
  buildMarketReviewPrompt,
  buildFuturesOverseasReviewPrompt,
} from './overview';

// 挂载大盘模块定时：注册 /api/market/schedules。
// 复用盘面快照 + 复盘点评 prompt，分两档定时：
// ①大盘复盘（收盘后 15:05）②期货+外盘复盘（次日盘前 08:30）。

export function registerMarketSchedule(app: FastifyInstance): void {
  defineModuleSchedules({
    app,
    module: 'market',
    jobs: [
      {
        id: 'market.review',
        label: '定时大盘复盘点评',
        defaultCron: '5 15 * * 1-5',
        run: async () => {
          const ov = await buildOverview();
          await runTask(
            {
              id: null,
              name: '大盘复盘点评',
              prompt: buildMarketReviewPrompt(ov),
              modelConfig: { thinking: false, maxSteps: 10 },
              notifyChannels: ['webui', 'telegram'],
              timeoutSec: 300,
              purpose: 'market-review',
            },
            'cron',
          );
        },
      },
      {
        id: 'market.futuresOverseas',
        label: '期货+外盘盘前复盘',
        defaultCron: '30 8 * * 1-5',
        run: async () => {
          const ov = await buildOverview();
          await runTask(
            {
              id: null,
              name: '期货+外盘复盘',
              prompt: buildFuturesOverseasReviewPrompt(ov),
              modelConfig: { thinking: false, maxSteps: 10 },
              notifyChannels: ['webui', 'telegram'],
              timeoutSec: 300,
              purpose: 'futures-overseas-review',
            },
            'cron',
          );
        },
      },
    ],
  });
}
