import type { FastifyInstance } from 'fastify';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import {
  computeForwardStats,
  isGlobalAutoSimEnabled,
  recordDailySamples,
  setGlobalAutoSimEnabled,
} from './forward';

// 挂载战法前向验证：收盘后记录各本地战法权益样本（只读），并暴露前向统计 + 自动模拟总闸读写。
// 自动买入默认关闭：仅当全局总闸 + 单战法白名单同时开启才允许（白名单经 PUT /api/strategies/:id 设置）。
// server.ts 仅需 registerStrategyForward(app) 一行接入。

export function registerStrategyForward(app: FastifyInstance): void {
  // 前向样本采集（默认启用：纯只读权益记录，安全；无战法则空跑）
  defineModuleSchedules({
    app,
    module: 'strategy',
    jobs: [
      {
        id: 'strategy.sample',
        label: '战法前向样本采集（1550）',
        defaultCron: '50 15 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          await recordDailySamples();
        },
      },
    ],
  });

  // 全局自动模拟总闸读写（默认关闭，高级实验开关）
  app.get('/api/strategies/auto-sim', () => ({
    ok: true,
    data: { enabled: isGlobalAutoSimEnabled() },
  }));
  app.put<{ Body: { enabled?: boolean } }>('/api/strategies/auto-sim', (req) => {
    setGlobalAutoSimEnabled(req.body?.enabled === true);
    return { ok: true, data: { enabled: isGlobalAutoSimEnabled() } };
  });

  // 某战法前向验证统计（样本曲线 + 累计收益 + 最大回撤 + 胜率 + 闸门状态）
  app.get<{ Params: { id: string } }>('/api/strategies/:id/forward', (req) => ({
    ok: true,
    data: computeForwardStats(req.params.id),
  }));
}
