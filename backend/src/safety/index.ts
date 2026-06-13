import type { FastifyInstance } from 'fastify';
import type { SafetyUpdate } from '@stock-agent/shared';
import { getSafetyState, updateSafetyState, killAll, resumeAll } from './guard';

// 安全控制台模块：交易/模拟总闸的只读状态 + 写控制（kill switch / 自动开关 / 手动强制开关）。
// server.ts 仅需 registerSafetyModule(app) 一行接入，且应早于 watch/strategy 等交易模块注册。

export function registerSafetyModule(app: FastifyInstance): void {
  // 当前安全状态
  app.get('/api/safety/state', () => ({ ok: true, data: getSafetyState() }));

  // 更新开关（部分字段）
  app.put<{ Body: SafetyUpdate }>('/api/safety/state', (req) => ({
    ok: true,
    data: updateSafetyState(req.body ?? {}),
  }));

  // 急停：拉下总闸，拒绝一切后续交易/模拟
  app.post<{ Body: { reason?: string } }>('/api/safety/kill', (req) => ({
    ok: true,
    data: killAll(req.body?.reason ?? null),
  }));

  // 解除急停
  app.post('/api/safety/resume', () => ({ ok: true, data: resumeAll() }));
}

export { getSafetyState, assertTradeAllowed, SafetyError } from './guard';
