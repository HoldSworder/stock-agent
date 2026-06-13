import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PromptConfigUpdate } from '@stock-agent/shared';
import { listPromptInfo, setPromptOverride } from './promptConfig';

// 挂载 Agent 提示词管理模块：注册 /api/prompts/*。server.ts 仅需 registerPromptsModule(app) 一行接入。
// 把硬编码在 loop.ts 的全局提示词显式化：列出默认值 / 覆盖 / 启停，覆盖对所有 agent 运行全局生效。

export function registerPromptsModule(app: FastifyInstance): void {
  // 提示词清单（含默认值 / 当前覆盖 / 是否覆盖）
  app.get('/api/prompts', () => ({ ok: true, data: listPromptInfo() }));

  // 覆盖更新；content 为空串=清除覆盖回落默认。回传该段最新信息
  app.put<{ Params: { key: string }; Body: PromptConfigUpdate }>(
    '/api/prompts/:key',
    (req, reply: FastifyReply) => {
      const updated = setPromptOverride(req.params.key, req.body ?? {});
      if (!updated) return reply.code(404).send({ ok: false, error: `未知提示词 ${req.params.key}` });
      return { ok: true, data: updated };
    },
  );
}
