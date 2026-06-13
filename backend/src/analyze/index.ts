import type { FastifyInstance } from 'fastify';
import type { StreamEvent } from '@stock-agent/shared';
import * as gateway from '../agent/gateway';
import { getKind } from './registry';
import { listAnalyses, saveAnalysis } from './service';
import './kinds';

// 挂载公共 AI 分析模块：通用流式端点 /ws/analyze + 历史 /api/analyses/:kind。
// server.ts 仅需 registerAnalyzeModule(app) 一行接入，删除即整模块下线。
// 各分析能力（kind）在 ./kinds 注册，前端用 <AiAnalysisDialog kind=...> 复用同一弹窗。

export function registerAnalyzeModule(app: FastifyInstance): void {
  // ===== 历史记录（按 kind + 可选 refKey 作用域） =====
  app.get<{ Params: { kind: string }; Querystring: { refKey?: string; limit?: string; all?: string } }>(
    '/api/analyses/:kind',
    (req) => ({
      ok: true,
      data: listAnalyses(
        req.params.kind,
        req.query?.refKey?.trim() || null,
        req.query?.limit ? Math.min(Math.max(Number(req.query.limit) || 30, 1), 100) : 30,
        { allRefKeys: req.query?.all === '1' },
      ),
    }),
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
        if (result.outputText && result.status !== 'canceled') {
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
      } catch (e) {
        send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
        send({ type: 'run_finished', runId: '', status: 'error' });
      } finally {
        if (activeAbort === abort) activeAbort = null;
      }
    });

    socket.on('close', () => {
      activeAbort?.abort();
      activeAbort = null;
    });
  });
}
