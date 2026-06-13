import type { FastifyInstance } from 'fastify';
import { runTask } from '../runner';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { buildOverview, buildFuturesOverseasReviewPrompt } from './overview';

// 挂载大盘模块定时：注册 /api/market/schedules。
// 仅保留期货+外盘盘前复盘（次日 08:30）。
// 原「定时大盘复盘点评」(15:05) 与收盘深度复盘 review.eod 高度重复，已并入后者（见 review/index.ts），此处下线。

export function registerMarketSchedule(app: FastifyInstance): void {
  defineModuleSchedules({
    app,
    module: 'market',
    jobs: [
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
