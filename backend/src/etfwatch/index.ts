import type { FastifyInstance } from 'fastify';
import type {
  EtfWatchConfig,
  EtfWatchEvent,
  EtfWatchProbe,
  EtfWatchProbeStreamEvent,
} from '@stock-agent/shared';
import { getEtfWatchConfig, updateEtfWatchConfig } from './config';
import {
  clearAllLayerStates,
  countEtfAlertsToday,
  deleteLayerState,
  listEtfAlerts,
  listLayerStates,
} from './store';
import { broadcastEtfWatch, subscribeEtfWatch } from './bus';
import {
  applyEtfWatchConfig,
  getEtfWatchStatus,
  startEtfWatchEngine,
  triggerEtfWatchNow,
} from './engine';
import { aiVerdict, analyzeEtfTarget, readEtfProbeBase } from './analyze';
import { saveAnalysis } from '../analyze/service';

export { startEtfWatchEngine } from './engine';

/**
 * 挂载 ETF 多周期分层盯盘模块：注册 /api/etf-watch/* 与 /ws/etf-watch。
 * server.ts 仅需 registerEtfWatchModule(app) + startEtfWatchEngine() 两行即可接入，删除即整模块下线。
 * 与个股盯盘（/api/watch、/ws/watch）完全解耦。
 */
export function registerEtfWatchModule(app: FastifyInstance): void {
  app.get('/api/etf-watch/status', () => ({ ok: true, data: getEtfWatchStatus() }));
  app.get('/api/etf-watch/config', () => ({ ok: true, data: getEtfWatchConfig() }));

  app.put<{ Body: Partial<EtfWatchConfig> }>('/api/etf-watch/config', (req) => {
    const cfg = updateEtfWatchConfig(req.body ?? {});
    applyEtfWatchConfig();
    return { ok: true, data: cfg };
  });

  app.post<{ Body: { enabled: boolean } }>('/api/etf-watch/toggle', (req) => {
    const cfg = updateEtfWatchConfig({ enabled: Boolean(req.body?.enabled) });
    applyEtfWatchConfig();
    return { ok: true, data: cfg };
  });

  // 手动触发一次检测（忽略交易时段与开关，仅单次、不启动轮询）
  app.post('/api/etf-watch/trigger', async () => ({
    ok: true,
    data: await triggerEtfWatchNow(),
  }));

  app.get<{ Querystring: { limit?: string; scope?: string } }>(
    '/api/etf-watch/alerts',
    (req) => ({
      ok: true,
      data: listEtfAlerts(
        req.query.limit ? Number(req.query.limit) : 100,
        (req.query.scope ?? 'all') === 'today',
      ),
    }),
  );

  app.get('/api/etf-watch/states', () => ({ ok: true, data: listLayerStates() }));

  // 手动清空全部建议持仓层（清后即广播空层状态，前端立即更新）
  app.post('/api/etf-watch/states/clear', () => {
    clearAllLayerStates();
    broadcastEtfWatch({ type: 'states', at: new Date().toISOString(), states: listLayerStates() });
    return { ok: true, data: { cleared: true } };
  });

  // 移除单只 ETF 的建议持仓层
  app.delete<{ Params: { code: string } }>('/api/etf-watch/states/:code', (req) => {
    deleteLayerState(String(req.params.code));
    broadcastEtfWatch({ type: 'states', at: new Date().toISOString(), states: listLayerStates() });
    return { ok: true, data: { removed: req.params.code } };
  });

  // 手动检测：即时对单只 ETF 跑多周期读数 + AI 研判（只读，不落库/不推送/不改层状态）
  app.post<{ Body: { code: string } }>('/api/etf-watch/analyze', async (req) => ({
    ok: true,
    data: await analyzeEtfTarget(String(req.body?.code ?? '')),
  }));

  app.get('/api/etf-watch/stats', () => ({
    ok: true,
    data: { alertsToday: countEtfAlertsToday(), trackedCount: getEtfWatchStatus().trackedCount },
  }));

  // WebSocket：单只 ETF 即时检测（流式）。先回确定性读数（probe_base），再流式 AI 研判轨迹，
  // 收敛后回结构化裁决（probe_done）并落库（kind=etf-watch-probe，refKey=code）供关闭后回看。
  app.get('/ws/etf-watch/probe', { websocket: true }, (socket) => {
    let abort: AbortController | null = null;
    const send = (e: EtfWatchProbeStreamEvent) => {
      try {
        socket.send(JSON.stringify(e));
      } catch {
        /* socket 可能已关闭 */
      }
    };
    socket.on('message', async (raw: Buffer) => {
      let p: { action?: string; code?: string };
      try {
        p = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (p.action === 'stop') {
        abort?.abort();
        return;
      }
      if (p.action !== 'generate') return;

      abort?.abort();
      const ac = new AbortController();
      abort = ac;
      try {
        const base = await readEtfProbeBase(String(p.code ?? ''));
        send({ type: 'probe_base', base });
        const v = await aiVerdict(
          base.code,
          base.name,
          base.price,
          base.pct,
          base.heldLayers,
          base.readouts,
          base.resonance,
          base.confirm,
          { onEvent: send, signal: ac.signal },
        );
        if (ac.signal.aborted) return; // 用户已停止，不落库不回最终帧
        const probe: EtfWatchProbe = {
          ...base,
          confidence: v.confidence,
          action: v.action,
          advice: v.advice,
          confirm: base.confirm,
          trendStage: base.trendStage,
          instruction: v.instruction,
          runId: v.runId,
          at: new Date().toISOString(),
        };
        send({ type: 'probe_done', probe });
        saveAnalysis({
          kind: 'etf-watch-probe',
          refKey: base.code,
          title: `ETF检测·${base.name}`,
          runId: v.runId,
          content: JSON.stringify(probe),
        });
      } catch (e) {
        send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
        send({ type: 'run_finished', runId: '', status: 'error' });
      } finally {
        if (abort === ac) abort = null;
      }
    });
    // 关闭弹窗只断流，不 abort：任务跑完落库，下次打开同标的可回看
    socket.on('close', () => {});
  });

  // WebSocket：状态 / 信号 / 告警 / 层状态流
  app.get('/ws/etf-watch', { websocket: true }, (socket) => {
    const send = (e: EtfWatchEvent) => {
      try {
        socket.send(JSON.stringify(e));
      } catch {
        /* socket 可能已关闭 */
      }
    };
    send({ type: 'status', status: getEtfWatchStatus() });
    send({ type: 'states', at: new Date().toISOString(), states: listLayerStates() });
    const unsub = subscribeEtfWatch(send);
    socket.on('close', unsub);
  });
}
