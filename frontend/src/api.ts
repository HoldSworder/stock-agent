import axios from 'axios';
import type {
  ApiResult,
  AppSettings,
  ChatMessage,
  ChatSession,
  RealPortfolio,
  RunMessage,
  ScheduledTask,
  ScheduledTaskInput,
  StockPick,
  TaskRun,
} from '@stock-agent/shared';

const http = axios.create({ baseURL: '/api', timeout: 30000 });

async function unwrap<T>(p: Promise<{ data: ApiResult<T> }>): Promise<T> {
  const res = await p;
  if (!res.data.ok) throw new Error(res.data.error || '请求失败');
  return res.data.data as T;
}

export const api = {
  // 设置
  getSettings: () => unwrap<AppSettings>(http.get('/settings')),
  updateSettings: (patch: Record<string, string>) =>
    unwrap<AppSettings>(http.put('/settings', patch)),
  testLLM: () => unwrap<{ ok: boolean; message: string }>(http.post('/settings/test-llm')),

  // 任务
  listTasks: () => unwrap<ScheduledTask[]>(http.get('/tasks')),
  getTask: (id: string) => unwrap<ScheduledTask>(http.get(`/tasks/${id}`)),
  createTask: (body: ScheduledTaskInput) => unwrap<ScheduledTask>(http.post('/tasks', body)),
  updateTask: (id: string, body: Partial<ScheduledTaskInput>) =>
    unwrap<ScheduledTask>(http.put(`/tasks/${id}`, body)),
  deleteTask: (id: string) => unwrap<void>(http.delete(`/tasks/${id}`)),
  triggerTask: (id: string) => unwrap<void>(http.post(`/tasks/${id}/trigger`)),

  // 运行 / 复盘
  listRuns: () => unwrap<TaskRun[]>(http.get('/runs')),
  getRun: (id: string) =>
    unwrap<{ run: TaskRun; messages: RunMessage[] }>(http.get(`/runs/${id}`)),
  listPicks: (params: { from?: string; to?: string; limit?: number }) =>
    unwrap<StockPick[]>(http.get('/picks', { params })),

  // 真实持仓
  getRealPositions: () => unwrap<RealPortfolio>(http.get('/positions/real', { timeout: 20000 })),

  // 聊天
  listSessions: () => unwrap<ChatSession[]>(http.get('/chat/sessions')),
  createSession: () => unwrap<ChatSession>(http.post('/chat/sessions')),
  listMessages: (id: string) =>
    unwrap<ChatMessage[]>(http.get(`/chat/sessions/${id}/messages`)),
};

/** 建立 WebSocket 连接（自动适配协议与主机） */
export function openWs(path: string): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return new WebSocket(`${proto}://${location.host}${path}`);
}
