import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ScheduledTaskInput, StreamEvent } from '@stock-agent/shared';
import { config } from './config';
import { ensureSchema } from './db/migrate';
import {
  getPublicSettings,
  updateSettings,
  migrateLegacySettings,
  type SettingsUpdate,
} from './settings';
import { testLLM } from './llm';
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
} from './tasks';
import {
  reloadScheduler,
  rescheduleTask,
  getNextRun,
  triggerTask,
} from './scheduler';
import { listRuns, getRun, listPicks } from './repo';
import { fetchRealPositions } from './realPositions';
import { runAgent } from './agent/loop';
import { createRun, finishRun } from './repo';
import {
  listSessions,
  createSession,
  listMessages,
  addMessage,
  touchSession,
} from './chat';
import { subscribe } from './ws';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  ensureSchema();
  migrateLegacySettings();
  // 种子任务（首次启动写入，默认禁用）
  const { seedCronTasksIfEmpty } = await import('./seeds/cronTasks');
  seedCronTasksIfEmpty();

  const app = Fastify({ logger: { level: 'info' } });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // ===== 设置 =====
  app.get('/api/settings', () => ({ ok: true, data: getPublicSettings() }));
  app.put<{ Body: SettingsUpdate }>('/api/settings', (req) => {
    updateSettings(req.body ?? {});
    return { ok: true, data: getPublicSettings() };
  });
  app.post('/api/settings/test-llm', async () => ({ ok: true, data: await testLLM() }));

  // ===== 任务 CRUD =====
  app.get('/api/tasks', () => ({
    ok: true,
    data: listTasks().map((t) => ({ ...t, nextRunAt: getNextRun(t.id) })),
  }));
  app.get<{ Params: { id: string } }>('/api/tasks/:id', (req, reply) => {
    const t = getTask(req.params.id);
    if (!t) return reply.code(404).send({ ok: false, error: '任务不存在' });
    return { ok: true, data: { ...t, nextRunAt: getNextRun(t.id) } };
  });
  app.post<{ Body: ScheduledTaskInput }>('/api/tasks', (req) => {
    const t = createTask(req.body);
    rescheduleTask(t.id);
    return { ok: true, data: t };
  });
  app.put<{ Params: { id: string }; Body: Partial<ScheduledTaskInput> }>(
    '/api/tasks/:id',
    (req, reply) => {
      const t = updateTask(req.params.id, req.body);
      if (!t) return reply.code(404).send({ ok: false, error: '任务不存在' });
      rescheduleTask(t.id);
      return { ok: true, data: t };
    },
  );
  app.delete<{ Params: { id: string } }>('/api/tasks/:id', (req) => {
    deleteTask(req.params.id);
    rescheduleTask(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/trigger', (req, reply) => {
    if (!getTask(req.params.id)) {
      return reply.code(404).send({ ok: false, error: '任务不存在' });
    }
    // 后台异步执行，进度通过 /ws/runs 广播
    void triggerTask(req.params.id);
    return { ok: true };
  });

  // ===== 运行记录 / 复盘 =====
  app.get('/api/runs', () => ({ ok: true, data: listRuns(100) }));
  app.get<{ Params: { id: string } }>('/api/runs/:id', (req) => ({
    ok: true,
    data: getRun(req.params.id),
  }));
  app.get<{ Querystring: { from?: string; to?: string; limit?: string } }>(
    '/api/picks',
    (req) => ({
      ok: true,
      data: listPicks({
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    }),
  );

  // ===== 真实持仓 =====
  app.get('/api/positions/real', async (_req, reply) => {
    try {
      return { ok: true, data: await fetchRealPositions() };
    } catch (e) {
      return reply
        .code(502)
        .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ===== 聊天 =====
  app.get('/api/chat/sessions', () => ({ ok: true, data: listSessions() }));
  app.post('/api/chat/sessions', () => ({ ok: true, data: createSession() }));
  app.get<{ Params: { id: string } }>('/api/chat/sessions/:id/messages', (req) => ({
    ok: true,
    data: listMessages(req.params.id),
  }));

  // ===== WebSocket：运行监控（全局广播）=====
  app.get('/ws/runs', { websocket: true }, (socket) => {
    const unsub = subscribe((e) => socket.send(JSON.stringify(e)));
    socket.on('close', unsub);
  });

  // ===== WebSocket：聊天（流式）=====
  app.get('/ws/chat', { websocket: true }, (socket) => {
    socket.on('message', async (raw: Buffer) => {
      let payload: { sessionId: string; content: string };
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: '消息格式错误' }));
        return;
      }
      const { sessionId, content } = payload;
      if (!sessionId || !content) return;

      const history: ChatCompletionMessageParam[] = listMessages(sessionId).map((m) => ({
        role: m.role === 'tool' ? 'assistant' : (m.role as 'user' | 'assistant' | 'system'),
        content: m.content,
      }));
      addMessage(sessionId, 'user', content);

      const runId = createRun({
        taskId: null,
        taskName: '聊天',
        trigger: 'chat',
        inputPrompt: content,
      });
      const send = (e: StreamEvent) => {
        try {
          socket.send(JSON.stringify(e));
        } catch {
          /* socket 可能已关闭 */
        }
      };
      send({ type: 'run_started', runId });
      try {
        const result = await runAgent({
          runId,
          prompt: content,
          history,
          modelConfig: { thinking: false },
          timeoutSec: 300,
          onEvent: send,
        });
        finishRun(runId, {
          status: result.status,
          outputText: result.outputText,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          error: result.error ?? null,
        });
        if (result.outputText) addMessage(sessionId, 'assistant', result.outputText);
        if (history.length === 0) touchSession(sessionId, content.slice(0, 20));
        else touchSession(sessionId);
        send({ type: 'run_finished', runId, status: result.status });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        finishRun(runId, { status: 'error', error: msg });
        send({ type: 'error', message: msg });
        send({ type: 'run_finished', runId, status: 'error' });
      }
    });
  });

  // ===== 静态前端（生产）=====
  const publicDir = resolve(__dirname, '../public');
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ ok: false, error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  reloadScheduler();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[server] 监听 http://0.0.0.0:${config.port}`);
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
