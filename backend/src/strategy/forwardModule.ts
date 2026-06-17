import type { FastifyInstance } from 'fastify';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import {
  computeForwardStats,
  isGlobalAutoSimEnabled,
  recordDailySamples,
  setGlobalAutoSimEnabled,
} from './forward';
import { rebalanceStrategy, runRebalanceAll } from './rebalance';
import { getStrategy } from './sim';

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
      {
        // M4 中线验证闭环：收盘前调仓建仓（diff 持仓 vs TopN → 自动建仓）。
        // 默认关闭：实际建仓还需全局自动总闸 + 单战法白名单同时开启（executeSimTrade 兜底校验）。
        id: 'strategy.rebalance',
        label: '战法调仓建仓（1435）',
        defaultCron: '35 14 * * 1-5',
        defaultEnabled: false,
        run: async () => {
          const results = await runRebalanceAll();
          const bought = results.reduce((s, r) => s + r.bought.length, 0);
          if (bought > 0) console.log(`[strategy] 调仓建仓完成：${bought} 笔买入`);
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

  // 某战法前向验证统计（样本曲线 + 累计收益 + 最大回撤 + 胜率 + Alpha + 闸门状态）
  app.get<{ Params: { id: string } }>('/api/strategies/:id/forward', async (req) => ({
    ok: true,
    data: await computeForwardStats(req.params.id),
  }));

  // 手动触发单战法调仓建仓（需全局总闸 + 单战法白名单开启才会实际建仓，否则原样返回跳过原因）
  app.post<{ Params: { id: string } }>('/api/strategies/:id/rebalance', async (req, reply) => {
    if (!getStrategy(req.params.id)) {
      return reply.code(404).send({ ok: false, error: '战法不存在' });
    }
    try {
      return { ok: true, data: await rebalanceStrategy(req.params.id) };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
