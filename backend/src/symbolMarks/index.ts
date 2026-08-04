import type { FastifyInstance } from 'fastify';
import * as repo from './repo';

// 标的 K 线标注模块：agent 在标的详情对话中打点（add_kline_mark 工具），前端 K 线图叠加展示。
// 对外只读 + 删除，写入统一走 agent 工具，保证「图上每条线都有对话记录可追溯」。
// 一行 registerSymbolMarksModule(app) 接入，删除即整模块下线。
export function registerSymbolMarksModule(app: FastifyInstance): void {
  app.get<{ Querystring: { code?: string } }>('/api/symbol-marks', (req, reply) => {
    const code = req.query?.code?.trim();
    if (!code) return reply.code(400).send({ ok: false, error: '缺少 code' });
    return { ok: true, data: repo.listMarks(code) };
  });

  app.delete<{ Params: { id: string } }>('/api/symbol-marks/:id', (req, reply) => {
    const r = repo.removeMark(req.params.id);
    if (r === 'not_found') return reply.code(404).send({ ok: false, error: '标注不存在' });
    if (r === 'plan_protected') {
      return reply
        .code(409)
        .send({ ok: false, error: '计划标注不可删除（随计划新版本自动失效，保留历史可追溯）' });
    }
    return { ok: true };
  });
}
