import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DataSourceConfigUpdate } from '@stock-agent/shared';
import { listSources, getSourceInfo, checkHealth, toggleSource, updateSourceConfig } from './registry';
import { snapshot } from './metrics';
import { getRoutes } from './scheduler';

// 挂载数据源中心模块：注册 /api/datasource/*。server.ts 仅需 registerDataSourceModule(app) 一行接入。
// 统一收口所有外部数据源的健康检查、凭据配置、启停与调用统计。

export function registerDataSourceModule(app: FastifyInstance): void {
  const fail = (reply: FastifyReply, e: unknown): FastifyReply =>
    reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });

  // 数据源列表（含启停 / 就绪 / 掩码凭据 / 调用统计）
  app.get('/api/datasource/list', () => ({ ok: true, data: listSources() }));

  // 调用统计快照（sourceId -> 统计）
  app.get('/api/datasource/stats', () => ({ ok: true, data: snapshot() }));

  // 行情调度链路（各能力生效数据源顺序与最近命中源）
  app.get('/api/datasource/routes', () => ({ ok: true, data: getRoutes() }));

  // 实时连通性 / 健康检查
  app.post<{ Params: { id: string } }>('/api/datasource/:id/health', async (req, reply) => {
    try {
      return { ok: true, data: await checkHealth(req.params.id) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 启停（仅 toggleable 数据源生效）
  app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/datasource/:id/toggle',
    (req, reply) => {
      const info = toggleSource(req.params.id, req.body?.enabled === true);
      if (!info) return reply.code(404).send({ ok: false, error: `未知数据源 ${req.params.id}` });
      return { ok: true, data: info };
    },
  );

  // 凭据 / 配置更新（仅接受该源声明的字段；敏感字段空串不覆盖）
  app.put<{ Params: { id: string }; Body: DataSourceConfigUpdate }>(
    '/api/datasource/:id/config',
    (req, reply) => {
      const info = updateSourceConfig(req.params.id, req.body ?? {});
      if (!info) return reply.code(404).send({ ok: false, error: `未知数据源 ${req.params.id}` });
      return { ok: true, data: info };
    },
  );

  // 单个数据源信息
  app.get<{ Params: { id: string } }>('/api/datasource/:id', (req, reply) => {
    const info = getSourceInfo(req.params.id);
    if (!info) return reply.code(404).send({ ok: false, error: `未知数据源 ${req.params.id}` });
    return { ok: true, data: info };
  });
}
