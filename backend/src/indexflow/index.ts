import type { FastifyInstance } from 'fastify';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { cached } from '../lib/ttlCache';
import { shanghaiToday } from '../util';
import { latestTradeDate } from './repo';
import { buildIndexFlowResult, snapshotIndexFlows } from './service';

// 宽基指数资金流模块：10 个宽基指数的主力净流入，收盘后落一次当日快照，页面只读表。
// server.ts 只需 registerIndexFlowModule(app) 一行接入，删除即整模块下线。

export function registerIndexFlowModule(app: FastifyInstance): void {
  // 面板数据。读的是本地表，不触网，5 分钟缓存只是避免同页多组件重复查库。
  // 路径沿用原来的 /api/market/index-fundflow，前端无需改调用。
  app.get('/api/market/index-fundflow', async () => ({
    ok: true,
    data: await cached('indexflow:panel', 300_000, async () => buildIndexFlowResult()),
  }));

  defineModuleSchedules({
    app,
    module: 'indexflow',
    jobs: [
      {
        id: 'indexflow.snapshot',
        label: '指数资金流收盘快照（15:23）',
        // 15:20 已有大盘阶段与标的计划复核、15:25 是板块宽度，错开到 15:23
        defaultCron: '23 15 * * 1-5',
        // 纯取数落库不花钱。关掉就等于历史永远停在关掉那天，之后所有强弱结论都作废
        defaultEnabled: true,
        run: async () => {
          await snapshotIndexFlows();
        },
      },
      {
        id: 'indexflow.retry',
        // 漏一天就断一次连续段，而断档之后的样本要从缺口之后重新数起。
        // 这一跑只在今天还没落库时才真正取数，正常情况下是空转。
        label: '指数资金流当日补跑（15:45）',
        defaultCron: '45 15 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          if (latestTradeDate() === shanghaiToday()) return;
          await snapshotIndexFlows();
        },
      },
    ],
  });
}
