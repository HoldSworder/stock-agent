import type { FastifyInstance, FastifyReply } from 'fastify';
import type { NotifyChannel, ResearchReportType, RunTrigger } from '@stock-agent/shared';
import * as svc from './service';
import { fetchAnnouncementContent } from './client';
import { runTask, type RunTaskResult } from '../runner';
import { listIntelReviews } from '../repo';
import { sendTelegram } from '../notify/telegram';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';

// 挂载研报模块：注册 /api/research/*。
// server.ts 仅需 registerResearchModule(app) 一行接入，删除即整模块下线。
// 数据源为东方财富研报中心：列表元数据 + 详情页正文抽取 + 本系统自有 LLM 按需分析。

const TYPES: ResearchReportType[] = ['stock', 'industry', 'strategy', 'macro', 'morning'];

function parseType(v: unknown): ResearchReportType {
  return TYPES.includes(v as ResearchReportType) ? (v as ResearchReportType) : 'stock';
}

/**
 * 情报研判统一执行体（合并研报机会 + 全网热点）：跑 agent（research_reports(discover) 五类研报 + 公告
 * + trendradar_hotspots(summary) 全网热点 → 合成一份综合情报），记录入库（taskName=情报研判）。
 * 手动按需与 8 点定时共用。承接原 research.dailyAnalysis（研报机会）与 trendradar intel.daily（热点），避免双跑。
 * maxSteps=14 容纳「discover→ann_content→hotspots→出报告」多轮；maxTokens=16000 防输出被截断。
 */
export async function runIntelReview(opts: {
  trigger: RunTrigger;
  channels: NotifyChannel[];
}): Promise<RunTaskResult> {
  return runTask(
    {
      id: null,
      name: svc.INTEL_TASK_NAME,
      prompt: svc.INTEL_PROMPT,
      modelConfig: { thinking: false, maxSteps: 14, maxTokens: 16000 },
      notifyChannels: opts.channels,
      timeoutSec: 600,
      purpose: 'research',
    },
    opts.trigger,
  );
}

export function registerResearchModule(app: FastifyInstance): void {
  const fail = (reply: FastifyReply, e: unknown) =>
    reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });

  // 模块内定时。情报研判（研报机会 + 全网热点 合并）为唯一情报定时（替代原 research.dailyAnalysis
  // 与 trendradar intel.daily，避免双跑）。复用 research.dailyAnalysis 槽位，避免历史调度配置失效。
  defineModuleSchedules({
    app,
    module: 'research',
    jobs: [
      {
        id: 'research.dailyAnalysis',
        label: '情报研判·研报+热点（8:00）',
        defaultCron: '0 8 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          // 周末由 cron 1-5 排除，节假日由 skipHoliday gate，周一窗口由聚合层 discoverWindowDays 补齐
          await runIntelReview({ trigger: 'cron', channels: ['webui', 'telegram'] });
        },
      },
      {
        id: 'research.watchlistDigest',
        label: '自选股机构观点综述',
        defaultCron: '0 18 * * 1-5',
        run: async () => {
          // 运行管理与调用记录由 gateway 统一接管（trigger=cron）
          const data = await svc.analyzeBatch({
            scope: 'watchlist',
            trigger: 'cron',
            taskName: '研报机构观点综述',
          });
          await sendTelegram(`【研报机构观点综述】\n${data.content}`).catch(() => {});
        },
      },
    ],
  });

  // status 内部已容错，永不抛错
  app.get('/api/research/status', async () => ({ ok: true, data: await svc.status() }));

  app.get<{
    Querystring: {
      type?: string;
      code?: string;
      industry?: string;
      rating?: string;
      days?: string;
      page?: string;
      pageSize?: string;
    };
  }>('/api/research/list', async (req, reply) => {
    try {
      const q = req.query ?? {};
      return {
        ok: true,
        data: await svc.listReports({
          type: parseType(q.type),
          code: q.code?.trim() || undefined,
          industry: q.industry?.trim() || undefined,
          rating: q.rating?.trim() || undefined,
          days: q.days ? Math.min(Math.max(Number(q.days) || 30, 1), 365) : undefined,
          page: q.page ? Math.max(Number(q.page) || 1, 1) : undefined,
          pageSize: q.pageSize ? Math.min(Math.max(Number(q.pageSize) || 30, 1), 100) : undefined,
        }),
      };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Querystring: { type?: string; encodeUrl?: string; infoCode?: string } }>(
    '/api/research/content',
    async (req, reply) => {
      const encodeUrl = (req.query?.encodeUrl ?? '').trim();
      if (!encodeUrl) return reply.code(400).send({ ok: false, error: '缺少 encodeUrl' });
      try {
        return {
          ok: true,
          data: await svc.reportContent(parseType(req.query?.type), encodeUrl, req.query?.infoCode?.trim() || ''),
        };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // 单篇 AI 研判（走自有 LLM，较慢）。包成 run 记录，纳入全局运行抽屉
  app.post<{ Body: { type?: string; encodeUrl?: string; infoCode?: string } }>(
    '/api/research/analyze',
    async (req, reply) => {
      const encodeUrl = (req.body?.encodeUrl ?? '').trim();
      if (!encodeUrl) return reply.code(400).send({ ok: false, error: '缺少 encodeUrl' });
      const type = parseType(req.body?.type);
      try {
        // 运行管理与调用记录由 gateway 统一接管
        const data = await svc.analyzeReport(type, encodeUrl, req.body?.infoCode?.trim() || '', {
          trigger: 'manual',
          taskName: `研报分析·${type}`,
        });
        return { ok: true, data };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // 多篇机构观点综述（默认自选股）。包成 run 记录，纳入全局运行抽屉
  app.post<{ Body: { scope?: string; code?: string; industry?: string; limit?: number } }>(
    '/api/research/analyze-batch',
    async (req, reply) => {
      const b = req.body ?? {};
      const scope = b.scope === 'stock' || b.scope === 'industry' ? b.scope : 'watchlist';
      try {
        // 运行管理与调用记录由 gateway 统一接管
        const data = await svc.analyzeBatch({
          scope,
          code: b.code?.trim() || undefined,
          industry: b.industry?.trim() || undefined,
          limit: b.limit ? Number(b.limit) : undefined,
          trigger: 'manual',
          taskName: `研报机构观点综述·${scope}`,
        });
        return { ok: true, data };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // ===== 研报机会发现复盘 =====

  // 按需生成：跑 agent（research_reports(discover) + trendradar_hotspots(summary) → 合成情报），记录入库（taskName=情报研判）
  app.post('/api/research/discover-review', async (_req, reply) => {
    try {
      const result = await runIntelReview({ trigger: 'manual', channels: ['webui'] });
      return {
        ok: result.status === 'success',
        data: { runId: result.runId, status: result.status, text: result.outputText },
        error: result.status === 'success' ? undefined : `情报研判未成功（${result.status}）`,
      };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 情报研判历史（成功的「情报研判」运行；union 旧「研报机会」保历史不丢）
  app.get<{ Querystring: { limit?: string } }>('/api/research/opportunity-reviews', (req) => ({
    ok: true,
    data: listIntelReviews(req.query?.limit ? Number(req.query.limit) : undefined),
  }));

  // ===== 公告列表（全市场重大公告，纯实时爬取，不落库） =====

  // 列表：材料性筛选后的重大公告，按发布时间倒序
  app.get<{ Querystring: { days?: string; limit?: string } }>(
    '/api/research/announcements',
    async (req, reply) => {
      try {
        const days = req.query?.days ? Number(req.query.days) : undefined;
        const limit = req.query?.limit ? Number(req.query.limit) : undefined;
        return { ok: true, data: await svc.listMaterialAnnouncements(days, limit) };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // 正文：按 art_code 实时抓 notice_content（点开抽屉时调用；原文外链由列表行的 url 提供）
  app.get<{ Querystring: { artCode?: string } }>(
    '/api/research/announcement-content',
    async (req, reply) => {
      try {
        const artCode = (req.query?.artCode ?? '').trim();
        if (!artCode) return reply.code(400).send({ ok: false, error: '缺少 artCode' });
        return { ok: true, data: { text: await fetchAnnouncementContent(artCode) } };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
}
