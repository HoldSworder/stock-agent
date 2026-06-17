import type { FastifyInstance } from 'fastify';
import type {
  DecisionAgentUpdate,
  DecisionEngineConfig,
  DecisionEngineOverview,
  StreamEvent,
} from '@stock-agent/shared';
import { saveAnalysis } from '../analyze/service';
import { sendTelegram } from '../notify/telegram';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import {
  getEngineConfig,
  listAgentInfo,
  setAgentOverride,
  setEngineConfig,
} from './agentConfig';
import { debateRealPositions } from './sellcheck';
import { runDecision, runIndexDecision } from './service';
import { listIndexDefs, resolveIndex } from './indices';
import { reviewPending } from './reflection';
import { listVerdicts } from './verdictCache';

// 挂载多智能体辩论决策模块：WS /ws/decision（流式编排）+ 复用公共 ai_analyses 历史
// + decision.reflection 反思定时（收盘后复盘到期 pending 决策算 Alpha）。
// server.ts 仅需 registerDecisionModule(app) 一行接入，删除即整模块下线。
// 历史读取直接复用公共 GET /api/analyses/decision（由 analyze 模块提供），本模块不另开历史接口。

const ANALYSIS_KIND = 'decision';

/** 校验并归一 6 位股票代码 */
function normalizeCode(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  return /^\d{6}$/.test(s) ? s : null;
}

export function registerDecisionModule(app: FastifyInstance): void {
  app.get('/ws/decision', { websocket: true }, (socket) => {
    // 当前在飞运行的中止控制器：socket 关闭或收到 stop 时 abort，及时止损省 token
    let activeAbort: AbortController | null = null;

    socket.on('message', async (raw: Buffer) => {
      let payload: { action?: string; assetType?: string; code?: string; name?: string; context?: string };
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: '消息格式错误' }));
        return;
      }
      if (payload.action === 'stop') {
        activeAbort?.abort();
        return;
      }
      if (payload.action !== 'generate') return;

      const send = (e: StreamEvent) => {
        try {
          socket.send(JSON.stringify(e));
        } catch {
          /* socket 可能已关闭 */
        }
      };

      // 股指辩论（独立精简链路）：按白名单解析 code 为指数定义
      const indexDef = payload.assetType === 'index' ? resolveIndex(payload.code) : null;
      if (payload.assetType === 'index' && !indexDef) {
        send({ type: 'error', message: '未知股指，请从白名单中选择' });
        send({ type: 'run_finished', runId: '', status: 'error' });
        return;
      }

      const code = indexDef ? indexDef.key : normalizeCode(payload.code);
      if (!code) {
        send({ type: 'error', message: '请输入合法的 6 位股票代码' });
        send({ type: 'run_finished', runId: '', status: 'error' });
        return;
      }

      // 上一轮若仍在跑，先中止，避免并发烧 token
      activeAbort?.abort();
      const abort = new AbortController();
      activeAbort = abort;
      send({ type: 'run_started', runId: '' });
      try {
        const result = indexDef
          ? await runIndexDecision(indexDef, { onEvent: send, signal: abort.signal, purpose: 'decision' })
          : await runDecision(
              {
                code,
                name: typeof payload.name === 'string' ? payload.name : undefined,
                context: typeof payload.context === 'string' ? payload.context : undefined,
              },
              { onEvent: send, signal: abort.signal, purpose: 'decision' },
            );
        // 成功结果落公共历史库（供弹窗历史列表切换查看），refKey 作用域为股票代码/指数 key
        saveAnalysis({
          kind: ANALYSIS_KIND,
          refKey: code,
          title: indexDef ? `${result.name} 指数研判` : `${result.name}(${code}) 决策`,
          runId: null,
          content: result.narrative,
        });
        send({ type: 'run_finished', runId: '', status: 'success' });
      } catch (e) {
        // abort 收口为 canceled，其余为 error
        const aborted = abort.signal.aborted || (e instanceof DOMException && e.name === 'AbortError');
        if (aborted) {
          send({ type: 'run_finished', runId: '', status: 'canceled' });
        } else {
          send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
          send({ type: 'run_finished', runId: '', status: 'error' });
        }
      } finally {
        if (activeAbort === abort) activeAbort = null;
      }
    });

    socket.on('close', () => {
      activeAbort?.abort();
      activeAbort = null;
    });
  });

  // 可决策股指白名单（前端「股指」下拉）：指数走 secid 取数，规避 6 位撞码
  app.get('/api/decision/indices', () => {
    return { ok: true, data: listIndexDefs() };
  });

  // —— 决策智能体治理（中枢·智能体页）——
  // 角色总览：全部角色（职责/模型档位/引用数据/启停）+ 引擎全局参数
  app.get('/api/decision/agents', () => {
    const data: DecisionEngineOverview = { agents: listAgentInfo(), config: getEngineConfig() };
    return { ok: true, data };
  });

  // 覆盖某角色职责指令 / 启停分析师；instruction 空串=清除覆盖。回传该角色最新信息
  app.put<{ Params: { key: string }; Body: DecisionAgentUpdate }>(
    '/api/decision/agents/:key',
    (req, reply) => {
      const updated = setAgentOverride(req.params.key, req.body ?? {});
      if (!updated) return reply.code(404).send({ ok: false, error: `未知决策角色 ${req.params.key}` });
      return { ok: true, data: updated };
    },
  );

  // 引擎全局参数（轮数/风控/模型/定向取数）部分更新。回传最新配置
  app.put<{ Body: Partial<DecisionEngineConfig> }>('/api/decision/config', (req) => {
    return { ok: true, data: setEngineConfig(req.body ?? {}) };
  });

  // 结构化裁决缓存总览（含失效项，fresh 标注是否仍有效）。可选 ?codes=600000,300001 过滤
  app.get<{ Querystring: { codes?: string } }>('/api/decision/verdicts', (req) => {
    const codes = req.query?.codes
      ? req.query.codes.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    return { ok: true, data: listVerdicts(codes) };
  });

  // 真实持仓「卖点检查」程序化定时（多 agent 辩论 + 推送）：取代 cronTasks.ts 自由 prompt 版
  // 旺财-1445-盘中卖点检查 / 旺财-1600-持仓日终监控（后者在 cronTasks.ts 经 DEPRECATE 机制停用，避免双跑）。
  // 逐只个股辩论后汇总研判，落公共历史库（kind=real-positions，与持仓页弹窗共享）并推 Telegram；
  // 无个股持仓则静默跳过。默认禁用，配置好真实持仓数据源后到中枢·调度页启用。
  const sellCheckJob = (title: string) => async () => {
    let report;
    try {
      report = await debateRealPositions();
    } catch (e) {
      console.warn(`[decision] ${title} 跳过：`, e instanceof Error ? e.message : e);
      return;
    }
    saveAnalysis({
      kind: 'real-positions',
      refKey: null,
      title,
      runId: null,
      content: report.outputText,
    });
    // 仅在有需重点处理标的时推送，避免无信号刷屏（与盯盘「默认沉默」一致）
    if (report.alertCount > 0) {
      await sendTelegram(`📌 ${title}\n\n${report.outputText}`);
    }
  };

  // 反思定时任务：收盘后（默认 30 16 * * 1-5）复盘到期 pending 决策，算个股 vs CSI300 Alpha 并回写教训。
  // 离线路径、非交互；默认开启，cron/enabled 经 /api/decision/schedules 运行时可配。
  defineModuleSchedules({
    app,
    module: 'decision',
    jobs: [
      {
        id: 'decision.sellcheck.intraday',
        label: '持仓辩论·盘中卖点检查（1445）',
        defaultCron: '45 14 * * 1-5',
        run: sellCheckJob('持仓辩论·盘中卖点检查'),
      },
      {
        id: 'decision.sellcheck.eod',
        label: '持仓辩论·持仓日终监控（1600）',
        defaultCron: '0 16 * * 1-5',
        run: sellCheckJob('持仓辩论·持仓日终监控'),
      },
      {
        id: 'decision.reflection',
        label: '决策反思复盘',
        defaultCron: '30 16 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          await reviewPending();
        },
      },
    ],
  });
}
