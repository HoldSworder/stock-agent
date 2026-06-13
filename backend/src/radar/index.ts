import type { FastifyInstance, FastifyReply } from 'fastify';
import { sendTelegram } from '../notify/telegram';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { buildRadarDigest, buildRadarOverview } from './service';

// 挂载中线雷达模块：注册 /api/radar/* 与 /api/radar/schedules。
// server.ts 仅需 registerRadarModule(app) 一行接入，删除即整模块下线。
// 纯确定性只读视图（复用 ETF 指标层），收盘后可推一条 Telegram 摘要；不下单、不落库、不跑 LLM。

export function registerRadarModule(app: FastifyInstance): void {
  const fail = (reply: FastifyReply, e: unknown) =>
    reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });

  // 中线雷达总览（行业强弱 + 持仓趋势 + 候选池）
  app.get('/api/radar/overview', async (_req, reply) => {
    try {
      return { ok: true, data: await buildRadarOverview() };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 收盘后中线雷达扫描：确定性计算 + Telegram 摘要（默认禁用，配置好行情/持仓后启用）
  defineModuleSchedules({
    app,
    module: 'radar',
    jobs: [
      {
        id: 'radar.refresh',
        label: '收盘后中线雷达扫描（1540）',
        defaultCron: '40 15 * * 1-5',
        run: async () => {
          const ov = await buildRadarOverview();
          // 有强势行业或走弱持仓才推，避免无信号刷屏
          const hasSignal =
            ov.industries.some((i) => i.trend === 'multi_long' || i.trend === 'up') ||
            ov.positions.some((p) => p.trend === 'down');
          if (hasSignal) {
            try {
              await sendTelegram(buildRadarDigest(ov));
            } catch (e) {
              console.warn('[radar] 摘要推送失败:', e instanceof Error ? e.message : e);
            }
          }
        },
      },
    ],
  });
}
