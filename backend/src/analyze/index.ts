import type { FastifyInstance } from 'fastify';
import type { AiAnalysisKindInfo, StreamEvent } from '@stock-agent/shared';
import * as gateway from '../agent/gateway';
import { getKind, listKinds } from './registry';
import { listAnalyses, saveAnalysis } from './service';
import './kinds';

// 挂载公共 AI 分析模块：目录 /api/analyses + 通用流式端点 /ws/analyze + 历史 /api/analyses/:kind。
// server.ts 仅需 registerAnalyzeModule(app) 一行接入，删除即整模块下线。
// 各分析能力（kind）在 ./kinds 注册，前端用 <AiAnalysisDialog kind=...> 复用同一弹窗，
// 驾驶舱「AI 分析中心」据 /api/analyses 目录一处发起 + 看全部历史结论。

/** 目录卡片用：取正文首段做摘要（去 Markdown 噪声，截断） */
function snippet(content: string, max = 90): string {
  const s = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function registerAnalyzeModule(app: FastifyInstance): void {
  // ===== AI 分析中心目录（驾驶舱）：全部 kind + 最新一条结论摘要 =====
  app.get('/api/analyses', () => {
    const data: AiAnalysisKindInfo[] = listKinds().map(({ kind, def }) => {
      // taskRun / trend_summaries 型读 loadHistory；其余（decision/real-positions）读 ai_analyses 全量
      const latest = def.loadHistory
        ? def.loadHistory(1)[0] ?? null
        : listAnalyses(kind, null, 1, { allRefKeys: true })[0] ?? null;
      return {
        kind,
        title: def.title ?? def.taskName,
        group: def.group,
        scope: def.scope ?? 'global',
        latestAt: latest?.createdAt ?? null,
        latestSnippet: latest ? snippet(latest.content) : null,
        scheduleModule: def.scheduleRef?.module ?? null,
        scheduleId: def.scheduleRef?.jobId ?? null,
      };
    });
    return { ok: true, data };
  });

  // ===== 历史记录（按 kind + 可选 refKey 作用域） =====
  app.get<{ Params: { kind: string }; Querystring: { refKey?: string; limit?: string; all?: string } }>(
    '/api/analyses/:kind',
    (req) => {
      const def = getKind(req.params.kind);
      const limit = req.query?.limit
        ? Math.min(Math.max(Number(req.query.limit) || 30, 1), 100)
        : 30;
      // loadHistory 型（taskRun / trend_summaries）：历史读外部库，与今日计划读取口径一致
      if (def?.loadHistory) {
        return { ok: true, data: def.loadHistory(limit) };
      }
      return {
        ok: true,
        data: listAnalyses(req.params.kind, req.query?.refKey?.trim() || null, limit, {
          allRefKeys: req.query?.all === '1',
        }),
      };
    },
  );

  // ===== 流式分析（agent 轨迹：thinking / 工具调用 / 文本） =====
  app.get('/ws/analyze', { websocket: true }, (socket) => {
    // 当前在飞运行的中止控制器：socket 关闭或收到 stop 时 abort，及时止损省 token
    let activeAbort: AbortController | null = null;

    socket.on('message', async (raw: Buffer) => {
      let payload: { action?: string; kind?: string; params?: Record<string, unknown> };
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

      const kind = String(payload.kind ?? '');
      const def = getKind(kind);
      if (!def) {
        send({ type: 'error', message: `未知分析类型: ${kind}` });
        return;
      }
      const params =
        payload.params && typeof payload.params === 'object' ? payload.params : {};

      // 上一轮若仍在跑，先中止，避免并发烧 token
      activeAbort?.abort();
      const abort = new AbortController();
      activeAbort = abort;
      try {
        // 前置校验失败：回传错误并补 run_finished（gateway 未启动）
        if (def.preflight) await def.preflight(params);

        // 自定义执行器路径（如多 agent 辩论编排）：自管 run_started/run_finished + 落库。
        if (def.run) {
          send({ type: 'run_started', runId: '' });
          try {
            const r = await def.run(params, { onEvent: send, signal: abort.signal });
            const status = r.status ?? 'success';
            if (r.outputText && status !== 'canceled') {
              // skipAutoSave 型（taskRun / trend_summaries 已落库）不再双写 ai_analyses，保住今日计划读取
              if (!def.skipAutoSave) {
                const suffix =
                  status === 'timeout' ? '（部分·超时）' : status === 'error' ? '（部分·中断）' : '';
                saveAnalysis({
                  kind,
                  refKey: r.refKey ?? def.deriveRefKey?.(params) ?? null,
                  title: def.taskName ? `${def.taskName}${suffix}` : def.taskName,
                  runId: r.runId ?? null,
                  content: r.outputText,
                  promptTokens: r.promptTokens,
                  completionTokens: r.completionTokens,
                });
              }
              if (status === 'success') def.onSuccess?.(r.outputText);
            }
            send({ type: 'run_finished', runId: r.runId ?? '', status });
          } catch (e) {
            const aborted =
              abort.signal.aborted || (e instanceof DOMException && e.name === 'AbortError');
            if (aborted) {
              send({ type: 'run_finished', runId: '', status: 'canceled' });
            } else {
              send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
              send({ type: 'run_finished', runId: '', status: 'error' });
            }
          }
          return;
        }

        const prompt = await def.buildPrompt(params);
        const result = await gateway.call({
          mode: 'agent',
          trigger: 'manual',
          purpose: def.purpose ?? 'analyze',
          taskName: def.taskName,
          prompt,
          modelConfig: def.modelConfig ?? { thinking: false, maxSteps: 12 },
          timeoutSec: def.timeoutSec ?? 300,
          signal: abort.signal,
          onEvent: send,
        });
        // 落历史库：只要产出了正文就保存（含 timeout/error 的部分结论），
        // 仅 canceled（用户主动停止）不入库。非 success 标题加后缀以便区分。
        // skipAutoSave 型（gateway 已落 task_runs）不再双写 ai_analyses，历史改读 loadHistory。
        if (result.outputText && result.status !== 'canceled') {
          if (!def.skipAutoSave) {
            const suffix =
              result.status === 'timeout'
                ? '（部分·超时）'
                : result.status === 'error'
                  ? '（部分·中断）'
                  : '';
            saveAnalysis({
              kind,
              refKey: def.deriveRefKey?.(params) ?? null,
              title: def.taskName ? `${def.taskName}${suffix}` : def.taskName,
              runId: result.runId,
              content: result.outputText,
              promptTokens: result.promptTokens,
              completionTokens: result.completionTokens,
            });
          }
          if (result.status === 'success') def.onSuccess?.(result.outputText);
        }
      } catch (e) {
        send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
        send({ type: 'run_finished', runId: '', status: 'error' });
      } finally {
        if (activeAbort === abort) activeAbort = null;
      }
    });

    socket.on('close', () => {
      // 关闭弹窗只断开实时流，不中止任务；任务跑完后由 saveAnalysis 落库，下次打开弹窗即可见
      activeAbort = null;
    });
  });
}
