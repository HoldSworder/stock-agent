import type { FastifyInstance, FastifyReply } from 'fastify';
import * as svc from './service';
import { sendTelegram } from '../notify/telegram';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { cached } from '../lib/ttlCache';

/** 生成热点研判并推送 Telegram（定时任务用） */
async function runSummaryAndPush(type: 'daily' | 'weekly'): Promise<void> {
  const data = await svc.summaryReport(type, 'cron');
  const title = type === 'weekly' ? '周度热点研判' : '每日热点研判';
  await sendTelegram(`【${title}】\n${data.content}`).catch(() => {});
}

/**
 * 挂载热点雷达模块：注册 /api/trendradar/*。
 * server.ts 仅需 registerTrendRadarModule(app) 一行接入，删除即整模块下线。
 * 数据源为群晖 TrendRadar MCP(结构化热榜/新闻/RSS)；AI 研判由本系统自有 LLM 现场生成。
 */
export function registerTrendRadarModule(app: FastifyInstance): void {
  const fail = (reply: FastifyReply, e: unknown) =>
    reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });

  // 模块内定时（默认禁用，配置后到情报页启用）。
  // 合并：每日热点研判已并入「情报研判」（research 模块 8:00，研报+热点合一），此处下线 intel.daily 避免双跑；
  // 仅保留周度热点研判（近一周底稿，周日推送），与每日情报研判不冲突。
  defineModuleSchedules({
    app,
    module: 'trendradar',
    jobs: [
      {
        id: 'intel.weekly',
        label: '周度热点 AI 研判',
        defaultCron: '0 18 * * 0',
        // 周日触发，节假日 gate 对周末无影响
        skipHoliday: false,
        run: () => runSummaryAndPush('weekly'),
      },
    ],
  });

  // status 内部已容错，永不抛错
  app.get('/api/trendradar/status', async () => ({ ok: true, data: await svc.status() }));

  app.get<{ Querystring: { top?: string; mode?: string } }>(
    '/api/trendradar/trending',
    async (req, reply) => {
      try {
        const top = Math.min(Math.max(Number(req.query?.top) || 10, 1), 50);
        const mode = req.query?.mode === 'daily' ? 'daily' : 'current';
        // 响应级 120s 缓存（key 含 mode+top）：热榜经 MCP 拉取，重进情报页免重复请求
        const data = await cached(`trendradar:trending:${mode}:${top}`, 120_000, () =>
          svc.trending(top, mode),
        );
        return { ok: true, data };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.get<{ Querystring: { platforms?: string; limit?: string } }>(
    '/api/trendradar/news',
    async (req, reply) => {
      try {
        const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200);
        const platforms = req.query?.platforms
          ? req.query.platforms.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;
        // 响应级 120s 缓存（key 含 platforms+limit）：新闻流经 MCP 拉取，重进免重复请求
        const data = await cached(
          `trendradar:news:${platforms?.join(',') ?? 'all'}:${limit}`,
          120_000,
          () => svc.latestNews(limit, platforms),
        );
        return { ok: true, data };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.get<{ Querystring: { feeds?: string; days?: string } }>(
    '/api/trendradar/rss',
    async (req, reply) => {
      try {
        const days = Math.min(Math.max(Number(req.query?.days) || 1, 1), 30);
        const feeds = req.query?.feeds
          ? req.query.feeds.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;
        // 响应级 120s 缓存（key 含 feeds+days）：RSS 经 MCP 拉取，重进免重复请求
        const data = await cached(
          `trendradar:rss:${feeds?.join(',') ?? 'all'}:${days}`,
          120_000,
          () => svc.latestRss(days, feeds),
        );
        return { ok: true, data };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/trendradar/search',
    async (req, reply) => {
      const q = (req.query?.q ?? '').trim();
      if (!q) return reply.code(400).send({ ok: false, error: '请输入搜索关键词' });
      try {
        const limit = Math.min(Math.max(Number(req.query?.limit) || 30, 1), 100);
        return { ok: true, data: await svc.searchNews(q, limit) };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // 按需生成热点 AI 研判（走本系统自有 LLM，基于 MCP 拉取的原始热点数据），生成即落库
  app.post<{ Body: { type?: string } }>('/api/trendradar/summary', async (req, reply) => {
    try {
      const type = req.body?.type === 'weekly' ? 'weekly' : 'daily';
      return { ok: true, data: await svc.summaryReport(type) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 热点 AI 研判历史（含正文，供前端回看/切换）
  app.get<{ Querystring: { limit?: string } }>(
    '/api/trendradar/summaries',
    async (req, reply) => {
      try {
        const limit = Math.min(Math.max(Number(req.query?.limit) || 30, 1), 100);
        return { ok: true, data: svc.listSummaries(limit) };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
}
