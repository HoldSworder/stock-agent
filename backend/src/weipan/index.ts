import type { FastifyInstance } from 'fastify';
import type { WeipanConfig, WeipanEvent } from '@stock-agent/shared';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { getWeipanConfig, updateWeipanConfig } from './config';
import { broadcastWeipan, subscribeWeipan } from './bus';
import {
  applyWeipanConfig,
  getWeipanStatus,
  startWeipanEngine,
  triggerWeipanNow,
} from './engine';
import { buildPositionsFromTodayPicks } from './builder';
import { listWeipanAlerts, countWeipanAlertsToday } from './store';

export { startWeipanEngine } from './engine';

/**
 * 挂载尾盘套利确定性盯盘模块：注册 /api/weipan/* 与 /ws/weipan，并定义「尾盘选出后建仓」定时。
 * server.ts 仅需 registerWeipanModule(app) + startWeipanEngine() 两行即可接入，删除即整模块下线。
 * 与个股盯盘（/api/watch）、ETF 盯盘（/api/etf-watch）完全解耦；全程无 LLM。
 */
export function registerWeipanModule(app: FastifyInstance): void {
  app.get('/api/weipan/status', () => ({ ok: true, data: getWeipanStatus() }));
  app.get('/api/weipan/config', () => ({ ok: true, data: getWeipanConfig() }));

  app.put<{ Body: Partial<WeipanConfig> }>('/api/weipan/config', (req) => {
    const cfg = updateWeipanConfig(req.body ?? {});
    applyWeipanConfig();
    return { ok: true, data: cfg };
  });

  app.post<{ Body: { enabled: boolean } }>('/api/weipan/toggle', (req) => {
    const cfg = updateWeipanConfig({ enabled: Boolean(req.body?.enabled) });
    applyWeipanConfig();
    return { ok: true, data: cfg };
  });

  // 手动触发一次盯盘检测（忽略开关与交易时段，单次）
  app.post('/api/weipan/trigger', async () => ({ ok: true, data: await triggerWeipanNow() }));

  // 手动触发一次建仓（读当日尾盘选股建虚拟仓；受安全总闸 autoLocalSimEnabled 约束）
  app.post('/api/weipan/build', async () => ({ ok: true, data: await buildPositionsFromTodayPicks() }));

  app.get<{ Querystring: { limit?: string; scope?: string } }>('/api/weipan/alerts', (req) => ({
    ok: true,
    data: listWeipanAlerts(
      req.query.limit ? Number(req.query.limit) : 100,
      (req.query.scope ?? 'all') === 'today',
    ),
  }));

  app.get('/api/weipan/stats', () => ({
    ok: true,
    data: { alertsToday: countWeipanAlertsToday(), trackedCount: getWeipanStatus().trackedCount },
  }));

  // WebSocket：状态 / 信号 / 告警 流
  app.get('/ws/weipan', { websocket: true }, (socket) => {
    const send = (e: WeipanEvent) => {
      try {
        socket.send(JSON.stringify(e));
      } catch {
        /* socket 可能已关闭 */
      }
    };
    send({ type: 'status', status: getWeipanStatus() });
    const unsub = subscribeWeipan(send);
    socket.on('close', unsub);
  });

  // 建仓定时：尾盘选股（14:40 cron）落库后，约 14:46 读当日 picks 等权建虚拟仓。默认禁用，验证后到运维页启用。
  defineModuleSchedules({
    app,
    module: 'weipan',
    jobs: [
      {
        id: 'weipan.build',
        label: '尾盘选出后建仓',
        defaultCron: '46 14 * * 1-5',
        defaultEnabled: false,
        run: async () => {
          const r = await buildPositionsFromTodayPicks();
          console.log(`[weipan] 建仓定时：${r.note}`);
        },
      },
    ],
  });
}
