import type { FastifyInstance, FastifyReply } from 'fastify';
import { cached } from '../lib/ttlCache';
import { listSectors } from './sectors';
import { SectorIntelError, digestSector, latestDigest, sectorRss } from './service';

// 挂载赛道资讯模块：注册 /api/sectorintel/*（吸收 investment-news 12 赛道）。
// 数据源为 TrendRadar RSS（feedId 以 iv_ 前缀，108 全球源已落库）；要点由本系统 LLM 现场提炼。
// 历史复用统一 ai_analyses（kind=sector-intel），前端经 /api/analyses/sector-intel 回看。
// server.ts 仅需 registerSectorIntelModule(app) 一行接入，删除即整模块下线。
export function registerSectorIntelModule(app: FastifyInstance): void {
  const fail = (reply: FastifyReply, e: unknown) => {
    const code = e instanceof SectorIntelError ? 400 : 502;
    return reply.code(code).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
  };

  // 赛道清单（含每赛道源数）
  app.get('/api/sectorintel/sectors', () => ({ ok: true, data: listSectors() }));

  // 某赛道最新 RSS（120s 响应缓存：经 MCP 拉取，重进/切赛道免重复请求）
  app.get<{ Params: { sector: string }; Querystring: { days?: string } }>(
    '/api/sectorintel/:sector/rss',
    async (req, reply) => {
      try {
        const days = Math.min(Math.max(Number(req.query?.days) || 2, 1), 14);
        const sector = req.params.sector;
        const data = await cached(`sectorintel:rss:${sector}:${days}`, 120_000, () =>
          sectorRss(sector, days),
        );
        return { ok: true, data };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // 某赛道最新一条「今日要点」（无则 data=null）
  app.get<{ Params: { sector: string } }>(
    '/api/sectorintel/:sector/digest',
    (req, reply) => {
      try {
        return { ok: true, data: latestDigest(req.params.sector) };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // 现场生成某赛道「今日要点」（走本系统 LLM，生成即落库 ai_analyses）
  app.post<{ Params: { sector: string } }>(
    '/api/sectorintel/:sector/digest',
    async (req, reply) => {
      try {
        return { ok: true, data: await digestSector(req.params.sector) };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
}
