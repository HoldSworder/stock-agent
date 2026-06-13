import type { FastifyInstance } from 'fastify';
import type { WatchConfig, WatchEvent } from '@stock-agent/shared';
import { getWatchConfig, updateWatchConfig } from './config';
import { getStats, listAlerts } from './store';
import { subscribeWatch } from './bus';
import { applyWatchConfig, getWatchStatus, startWatchEngine } from './engine';
import { getStrategyViews, seedStrategyProfiles } from './strategyProfile';

export { startWatchEngine } from './engine';

/**
 * 挂载实时盯盘模块：注册 /api/watch/* 与 /ws/watch。
 * server.ts 仅需 registerWatchModule(app) + startWatchEngine() 两行即可接入，删除即整模块下线。
 */
export function registerWatchModule(app: FastifyInstance): void {
  // 幂等种子：写入战法卖点档案 + 写回尾盘套利卖出 Skill（启动时一次，与 enabled 无关）
  try {
    seedStrategyProfiles();
  } catch (e) {
    console.warn('[watch] 战法卖点档案种子异常:', e instanceof Error ? e.message : e);
  }

  app.get('/api/watch/status', () => ({ ok: true, data: getWatchStatus() }));
  app.get('/api/watch/config', () => ({ ok: true, data: getWatchConfig() }));

  app.put<{ Body: Partial<WatchConfig> }>('/api/watch/config', (req) => {
    const cfg = updateWatchConfig(req.body ?? {});
    applyWatchConfig();
    return { ok: true, data: cfg };
  });

  app.post<{ Body: { enabled: boolean } }>('/api/watch/toggle', (req) => {
    const cfg = updateWatchConfig({ enabled: Boolean(req.body?.enabled) });
    applyWatchConfig();
    return { ok: true, data: cfg };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/watch/alerts', (req) => ({
    ok: true,
    data: listAlerts(req.query.limit ? Number(req.query.limit) : 100),
  }));

  app.get('/api/watch/stats', () => ({ ok: true, data: getStats() }));

  app.get('/api/watch/strategy-views', () => ({ ok: true, data: getStrategyViews() }));

  // WebSocket：盯盘实时行情 / 信号 / 告警流
  app.get('/ws/watch', { websocket: true }, (socket) => {
    const send = (e: WatchEvent) => {
      try {
        socket.send(JSON.stringify(e));
      } catch {
        /* socket 可能已关闭 */
      }
    };
    // 连接即推一次当前状态
    send({ type: 'status', status: getWatchStatus() });
    const unsub = subscribeWatch(send);
    socket.on('close', unsub);
  });
}
