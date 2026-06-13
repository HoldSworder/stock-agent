import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ToolConfigUpdate } from '@stock-agent/shared';
import { listToolInfo } from './tools';
import { setOverride } from './toolConfig';

// 挂载 Agent 工具管理模块：注册 /api/tools/*。server.ts 仅需 registerToolsModule(app) 一行接入。
// 统一维护系统提供给 agent 的全部工具：自动罗列、全局启停、覆盖下发给 LLM 的描述文案。

export function registerToolsModule(app: FastifyInstance): void {
  // 工具清单（含分组 / 挂载条件 / 启停 / 描述覆盖）
  app.get('/api/tools', () => ({ ok: true, data: listToolInfo() }));

  // 启停 / 描述覆盖更新；回传该工具最新信息
  app.put<{ Params: { name: string }; Body: ToolConfigUpdate }>(
    '/api/tools/:name',
    (req, reply: FastifyReply) => {
      const name = req.params.name;
      const info = listToolInfo().find((t) => t.name === name);
      if (!info) return reply.code(404).send({ ok: false, error: `未知工具 ${name}` });
      setOverride(name, req.body ?? {});
      const updated = listToolInfo().find((t) => t.name === name);
      return { ok: true, data: updated };
    },
  );
}
