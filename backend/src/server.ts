import { timingSafeEqual } from 'node:crypto';
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
  isAuthEnabled,
  setPassword,
  verifyPassword,
  issueToken,
  verifyToken,
} from './auth';
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
  catchUpMissedRuns,
} from './scheduler';
import { listRuns, listRunsByTaskIds, getRun, listReviews, reconcileOrphanRuns } from './repo';
import { getUsageSummary, listLlmCalls } from './usage';
import { fetchRealPositions } from './realPositions';
import {
  getQuotes,
  searchSuggest,
  searchBoard,
  getKline,
  getTrends,
} from './market/eastmoney';
import {
  buildOverview,
  buildMarketReviewPrompt,
  buildFuturesOverseasReviewPrompt,
} from './market/overview';
import { getModules, setModules } from './market/modules';
import { registerMarketSchedule } from './market/schedule';
import { listWatch, addWatch, updateWatch, removeWatch, removeTagFromAll } from './watchlist';
import { syncFavorites, pushTagsDiff, pushRemove, pushDeleteGroup } from './thsFavorites';
import { pushToIdingpan } from './idingpan';
import { runTask } from './runner';
import {
  StrategyError,
  archiveStrategy,
  createStrategy,
  executeSimTrade,
  getStrategy,
  getStrategySnapshot,
  listStrategyItems,
  resetStrategy,
  updateStrategy,
} from './strategy/sim';
import { syncMiaoxiangStrategy } from './strategy/miaoxiangSync';
import {
  approveProposal,
  listSkillView,
  rejectProposal,
  rollbackSkill,
  updateSkillManually,
} from './strategy/skill';
import type {
  IdingpanPushResult,
  StrategyInput,
  SkillDimension,
  SimTradeInput,
  WatchlistBulkInput,
  WatchlistBulkResult,
  WatchlistEntry,
  WatchlistInput,
  WatchlistSyncResult,
  StockSuggest,
  KlineBar,
  KlinePeriod,
} from '@stock-agent/shared';
import * as gateway from './agent/gateway';
import {
  listSessions,
  createSession,
  deleteSession,
  pruneEmptySessions,
  listMessages,
  addMessage,
  touchSession,
} from './chat';
import { subscribe } from './ws';
import { registerWatchModule, startWatchEngine } from './watch';
import { registerTrendRadarModule } from './trendradar';
import { registerResearchModule } from './research';
import { registerPlanModule } from './plan';
import { registerEtfModule } from './etf';
import { registerDataSourceModule } from './datasource';
import { registerToolsModule } from './agent/toolsModule';
import { registerPromptsModule } from './agent/promptsModule';
import { registerSchedulesModule } from './scheduling/schedulesModule';
import { registerOpsModule } from './ops';
import { registerReviewModule } from './review';
import { registerAnalyzeModule } from './analyze';
import { registerDecisionModule } from './decision';
import { registerScreenerModule } from './screener';
import { registerSafetyModule } from './safety';
import { SafetyError } from './safety/guard';
import { registerPositionsModule } from './positions';
import { registerThemesModule } from './themes';
import { registerRadarModule } from './radar';
import { buildDeepReviewPrompt } from './review/service';
import { catchUpModuleMissedRuns } from './scheduling/moduleScheduler';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 写透同花顺：best-effort，失败仅告警，不阻断本地操作 */
async function pushThs(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn('[ths-sync] 写透同花顺失败:', e instanceof Error ? e.message : e);
  }
}

async function main() {
  ensureSchema();
  migrateLegacySettings();
  // 回收上一个进程遗留的孤儿运行（避免前端永远显示「运行中」）
  const orphans = reconcileOrphanRuns();
  if (orphans > 0) console.log(`[server] 已回收 ${orphans} 个中断的运行记录`);
  // 种子任务（首次启动写入，默认禁用）
  const { seedCronTasksIfEmpty, syncCronTasksFromOpenClaw } = await import('./seeds/cronTasks');
  seedCronTasksIfEmpty();
  // 幂等迁移：把已有任务同步到 OpenClaw 线上逻辑（重命名近义旧任务、受保护改写 prompt、补建缺失任务、停用已废任务）
  const synced = syncCronTasksFromOpenClaw();
  if (synced > 0) console.log(`[server] 已同步 ${synced} 个定时任务到 OpenClaw 线上逻辑`);
  // 战法种子：创建两战法并按名绑定任务（幂等，仅首次执行妙想初次同步）
  const { seedStrategiesAndBind } = await import('./seeds/strategies');
  await seedStrategiesAndBind();

  const app = Fastify({ logger: { level: 'info' } });
  // 生产配置 CORS_ORIGINS 白名单则按白名单放行，否则反射任意来源（本地开发）
  const corsOrigin = config.corsOrigins
    ? config.corsOrigins.split(',').map((s) => s.trim()).filter(Boolean)
    : true;
  await app.register(cors, { origin: corsOrigin });
  await app.register(websocket);

  // ===== 全局鉴权：保护所有 /api 与 /ws（登录/状态端点除外）=====
  // 未设置访问密码时放行（首次 bootstrap），用户在设置页设密后即开启。
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api') && !url.startsWith('/ws')) return;
    if (url === '/api/auth/login' || url === '/api/auth/status') return;
    // 配套浏览器扩展用 BRIDGE_SECRET 作为机器凭据，匹配则绕过 app 登录（看自选股/推送凭据等）
    if (config.bridgeSecret) {
      const provided = String(req.headers['x-bridge-secret'] ?? '');
      if (provided) {
        const a = Buffer.from(provided);
        const b = Buffer.from(config.bridgeSecret);
        if (a.length === b.length && timingSafeEqual(a, b)) return;
      }
    }
    if (!isAuthEnabled()) return;
    const token = url.startsWith('/ws')
      ? String((req.query as Record<string, unknown>)?.token ?? '')
      : String(req.headers['x-app-token'] ?? '');
    if (!verifyToken(token)) {
      return reply.code(401).send({ ok: false, error: '未登录或登录已失效' });
    }
  });

  // ===== 鉴权 =====
  app.get('/api/auth/status', () => ({ ok: true, data: { enabled: isAuthEnabled() } }));
  app.post<{ Body: { password?: string } }>('/api/auth/login', (req, reply) => {
    const password = String(req.body?.password ?? '');
    if (!isAuthEnabled() || !verifyPassword(password)) {
      return reply.code(401).send({ ok: false, error: '密码错误' });
    }
    return { ok: true, data: { token: issueToken() } };
  });
  app.post<{ Body: { next?: string } }>('/api/auth/password', (req, reply) => {
    const next = String(req.body?.next ?? '').trim();
    if (!next) {
      return reply.code(400).send({ ok: false, error: '新密码不能为空' });
    }
    setPassword(next);
    return { ok: true, data: { token: issueToken() } };
  });

  // ===== 设置 =====
  app.get('/api/settings', () => ({ ok: true, data: getPublicSettings() }));
  app.put<{ Body: SettingsUpdate }>('/api/settings', (req) => {
    updateSettings(req.body ?? {});
    return { ok: true, data: getPublicSettings() };
  });
  app.post('/api/settings/test-llm', async () => ({ ok: true, data: await testLLM() }));

  // 配套浏览器扩展推送凭据（idpToken / thsCookie）的受保护端点。
  // 需配置 BRIDGE_SECRET，且请求头 x-bridge-secret 匹配；否则拒绝，避免公网暴露密钥写入。
  app.put<{ Body: { idpToken?: string; thsCookie?: string } }>(
    '/api/credentials',
    (req, reply) => {
      const expected = config.bridgeSecret;
      if (!expected) {
        return reply
          .code(503)
          .send({ ok: false, error: '后端未配置 BRIDGE_SECRET，凭据写入端点已禁用' });
      }
      const provided = String(req.headers['x-bridge-secret'] ?? '');
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return reply.code(401).send({ ok: false, error: '密钥校验失败' });
      }
      const patch: SettingsUpdate = {};
      if (typeof req.body?.idpToken === 'string' && req.body.idpToken) {
        patch.idpToken = req.body.idpToken;
      }
      if (typeof req.body?.thsCookie === 'string' && req.body.thsCookie) {
        patch.thsCookie = req.body.thsCookie;
      }
      if (Object.keys(patch).length === 0) {
        return reply.code(400).send({ ok: false, error: '未提供 idpToken 或 thsCookie' });
      }
      updateSettings(patch);
      return { ok: true, data: getPublicSettings() };
    },
  );

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
  app.post<{ Params: { id: string }; Body: { forceTrade?: boolean } }>(
    '/api/tasks/:id/trigger',
    (req, reply) => {
      if (!getTask(req.params.id)) {
        return reply.code(404).send({ ok: false, error: '任务不存在' });
      }
      // 后台异步执行，进度通过 /ws/runs 广播
      void triggerTask(req.params.id, { forceTrade: req.body?.forceTrade ?? false });
      return { ok: true };
    },
  );

  // ===== 运行记录 / 复盘 =====
  app.get('/api/runs', () => ({ ok: true, data: listRuns(100) }));
  app.get<{ Params: { id: string } }>('/api/runs/:id', (req) => ({
    ok: true,
    data: getRun(req.params.id),
  }));

  // ===== LLM 调用记录分析 =====
  app.get<{ Querystring: { days?: string } }>('/api/usage/summary', (req) => ({
    ok: true,
    data: getUsageSummary(req.query.days ? Number(req.query.days) : 30),
  }));
  app.get<{ Querystring: { limit?: string; purpose?: string } }>('/api/usage/calls', (req) => ({
    ok: true,
    data: listLlmCalls(
      req.query.limit ? Number(req.query.limit) : 100,
      req.query.purpose || undefined,
    ),
  }));

  // ===== 大盘看盘 =====
  // buildOverview / buildMarketReviewPrompt 已抽至 ./market/overview，供本处与定时复盘共用
  app.get('/api/market/overview', async () => ({ ok: true, data: await buildOverview() }));

  // 复盘历史（成功的「一键复盘」运行）
  app.get<{ Querystring: { limit?: string } }>('/api/reviews', (req) => ({
    ok: true,
    data: listReviews(req.query.limit ? Number(req.query.limit) : undefined),
  }));

  // 模块显隐配置
  app.get('/api/market/modules', () => ({ ok: true, data: getModules() }));
  app.put<{ Body: Record<string, boolean> }>('/api/market/modules', (req) => ({
    ok: true,
    data: setModules(req.body ?? {}),
  }));

  // 一键 AI 复盘点评：以当前盘面为上下文跑 agent
  app.post('/api/market/review', async (_req, reply) => {
    try {
      const ov = await buildOverview();
      const result = await runTask(
        {
          id: null,
          name: '大盘复盘点评',
          prompt: buildMarketReviewPrompt(ov),
          modelConfig: { thinking: false, maxSteps: 10 },
          notifyChannels: ['webui'],
          timeoutSec: 300,
          purpose: 'market-review',
        },
        'manual',
      );
      return {
        ok: result.status === 'success',
        data: { runId: result.runId, status: result.status, text: result.outputText },
        error: result.status === 'success' ? undefined : `复盘点评未成功（${result.status}）`,
      };
    } catch (e) {
      return reply
        .code(502)
        .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 期货 + 外盘盘前复盘点评：聚焦商品期货与隔夜外盘对 A 股的传导
  app.post('/api/market/review/futures-overseas', async (_req, reply) => {
    try {
      const ov = await buildOverview();
      const result = await runTask(
        {
          id: null,
          name: '期货+外盘复盘',
          prompt: buildFuturesOverseasReviewPrompt(ov),
          modelConfig: { thinking: false, maxSteps: 10 },
          notifyChannels: ['webui'],
          timeoutSec: 300,
          purpose: 'futures-overseas-review',
        },
        'manual',
      );
      return {
        ok: result.status === 'success',
        data: { runId: result.runId, status: result.status, text: result.outputText },
        error: result.status === 'success' ? undefined : `复盘点评未成功（${result.status}）`,
      };
    } catch (e) {
      return reply
        .code(502)
        .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

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

  // ===== 战法模拟 =====
  // 规则校验失败（StrategyError）回 400，其余异常回 502
  const strategyErr = (reply: import('fastify').FastifyReply, e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    const userErr = e instanceof StrategyError || e instanceof SafetyError;
    return reply.code(userErr ? 400 : 502).send({ ok: false, error: msg });
  };

  app.get('/api/strategies', async (_req, reply) => {
    try {
      return { ok: true, data: await listStrategyItems() };
    } catch (e) {
      return strategyErr(reply, e);
    }
  });

  app.post<{ Body: StrategyInput }>('/api/strategies', (req, reply) => {
    try {
      return { ok: true, data: createStrategy(req.body) };
    } catch (e) {
      return strategyErr(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>('/api/strategies/:id', async (req, reply) => {
    if (!getStrategy(req.params.id)) {
      return reply.code(404).send({ ok: false, error: '战法不存在' });
    }
    try {
      return { ok: true, data: await getStrategySnapshot(req.params.id) };
    } catch (e) {
      return strategyErr(reply, e);
    }
  });

  app.put<{
    Params: { id: string };
    Body: { name?: string; description?: string | null; skillEnabled?: boolean };
  }>(
    '/api/strategies/:id',
    (req, reply) => {
      const s = updateStrategy(req.params.id, req.body ?? {});
      if (!s) return reply.code(404).send({ ok: false, error: '战法不存在' });
      return { ok: true, data: s };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/strategies/:id', (req, reply) => {
    if (!getStrategy(req.params.id)) {
      return reply.code(404).send({ ok: false, error: '战法不存在' });
    }
    archiveStrategy(req.params.id);
    return { ok: true };
  });

  // 重置本地战法账户：清空持仓/成交、现金回初始资金，返回最新快照
  app.post<{ Params: { id: string } }>('/api/strategies/:id/reset', async (req, reply) => {
    if (!getStrategy(req.params.id)) {
      return reply.code(404).send({ ok: false, error: '战法不存在' });
    }
    try {
      resetStrategy(req.params.id);
      return { ok: true, data: await getStrategySnapshot(req.params.id, { skipSync: true }) };
    } catch (e) {
      return strategyErr(reply, e);
    }
  });

  // 战法每日产出：该战法绑定任务的历史运行记录（倒序），前端按日期分组展示
  app.get<{ Params: { id: string } }>('/api/strategies/:id/daily-output', (req, reply) => {
    if (!getStrategy(req.params.id)) {
      return reply.code(404).send({ ok: false, error: '战法不存在' });
    }
    const taskIds = listTasks()
      .filter((t) => t.strategyId === req.params.id)
      .map((t) => t.id);
    return { ok: true, data: listRunsByTaskIds(taskIds) };
  });

  // 手动模拟买/卖
  app.post<{ Params: { id: string }; Body: SimTradeInput }>(
    '/api/strategies/:id/trade',
    async (req, reply) => {
      try {
        const r = await executeSimTrade({
          strategyId: req.params.id,
          side: req.body.side,
          code: req.body.code,
          qty: req.body.qty,
          price: req.body.price ?? undefined,
          reason: req.body.reason ?? null,
          thesis: req.body.thesis ?? null,
          source: 'manual',
          force: req.body.force ?? false,
        });
        return { ok: true, data: r.trade };
      } catch (e) {
        return strategyErr(reply, e);
      }
    },
  );

  // 手动同步妙想镜像账户（仅 kind=miaoxiang 有效）
  app.post<{ Params: { id: string } }>('/api/strategies/:id/sync', async (req, reply) => {
    const strategy = getStrategy(req.params.id);
    if (!strategy) return reply.code(404).send({ ok: false, error: '战法不存在' });
    try {
      await syncMiaoxiangStrategy(req.params.id);
      return { ok: true, data: await getStrategySnapshot(req.params.id, { skipSync: true }) };
    } catch (e) {
      return strategyErr(reply, e);
    }
  });

  // 一键触发该战法的选股/买卖 agent 运行
  app.post<{ Params: { id: string }; Body: { prompt?: string } }>(
    '/api/strategies/:id/run',
    async (req, reply) => {
      const strategy = getStrategy(req.params.id);
      if (!strategy) return reply.code(404).send({ ok: false, error: '战法不存在' });
      const prompt = (req.body?.prompt ?? '').trim();
      if (!prompt) return reply.code(400).send({ ok: false, error: '请输入运行指令' });
      try {
        const result = await runTask(
          {
            id: null,
            name: `战法·${strategy.name}`,
            prompt,
            modelConfig: { thinking: false, maxSteps: 14 },
            notifyChannels: ['webui'],
            timeoutSec: 600,
            strategy: { id: strategy.id, name: strategy.name },
            purpose: 'strategy',
          },
          'manual',
        );
        return {
          ok: result.status === 'success',
          data: { runId: result.runId, status: result.status, text: result.outputText },
          error: result.status === 'success' ? undefined : `运行未成功（${result.status}）`,
        };
      } catch (e) {
        return strategyErr(reply, e);
      }
    },
  );

  // ===== 战法 Skill（打法）自迭代 =====
  app.get<{ Params: { id: string } }>('/api/strategies/:id/skills', (req, reply) => {
    if (!getStrategy(req.params.id)) {
      return reply.code(404).send({ ok: false, error: '战法不存在' });
    }
    return { ok: true, data: listSkillView(req.params.id) };
  });

  app.post<{ Params: { id: string; pid: string } }>(
    '/api/strategies/:id/skills/proposals/:pid/approve',
    (req, reply) => {
      try {
        approveProposal(req.params.pid);
        return { ok: true, data: listSkillView(req.params.id) };
      } catch (e) {
        return strategyErr(reply, e);
      }
    },
  );

  app.post<{ Params: { id: string; pid: string } }>(
    '/api/strategies/:id/skills/proposals/:pid/reject',
    (req, reply) => {
      try {
        rejectProposal(req.params.pid);
        return { ok: true, data: listSkillView(req.params.id) };
      } catch (e) {
        return strategyErr(reply, e);
      }
    },
  );

  app.post<{ Params: { id: string; dimension: SkillDimension }; Body: { version: number } }>(
    '/api/strategies/:id/skills/:dimension/rollback',
    (req, reply) => {
      try {
        rollbackSkill(req.params.id, req.params.dimension, Number(req.body?.version));
        return { ok: true, data: listSkillView(req.params.id) };
      } catch (e) {
        return strategyErr(reply, e);
      }
    },
  );

  app.put<{
    Params: { id: string; dimension: SkillDimension };
    Body: { content: string; reason?: string };
  }>('/api/strategies/:id/skills/:dimension', (req, reply) => {
    try {
      updateSkillManually(
        req.params.id,
        req.params.dimension,
        req.body?.content ?? '',
        req.body?.reason ?? null,
      );
      return { ok: true, data: listSkillView(req.params.id) };
    } catch (e) {
      return strategyErr(reply, e);
    }
  });

  // ===== 股票搜索联想 =====
  app.get<{ Querystring: { q?: string } }>('/api/search/suggest', async (req, reply) => {
    try {
      const data: StockSuggest[] = await searchSuggest(req.query?.q ?? '');
      return { ok: true, data };
    } catch (e) {
      return reply
        .code(502)
        .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ===== 板块搜索联想（名称 → BK 代码）=====
  app.get<{ Querystring: { q?: string } }>('/api/search/board', async (req, reply) => {
    try {
      const data: StockSuggest[] = await searchBoard(req.query?.q ?? '');
      return { ok: true, data };
    } catch (e) {
      return reply
        .code(502)
        .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ===== K 线（个股 / 板块 / 大盘指数）=====
  app.get<{ Querystring: { code?: string; secid?: string; period?: string; limit?: string } }>(
    '/api/kline',
    async (req, reply) => {
      const code = req.query?.code ?? '';
      const secid = req.query?.secid;
      // 指数须带显式 secid（与个股撞码）；否则按 code 解析（个股 6 位 / 板块 BKxxxx）
      if (secid) {
        if (!/^\d+\.[A-Za-z0-9]+$/.test(secid)) {
          return reply.code(400).send({ ok: false, error: '非法 secid' });
        }
      } else if (!/^(\d{6}|BK\d+)$/i.test(code)) {
        return reply.code(400).send({ ok: false, error: '非法标的代码' });
      }
      const allowed: KlinePeriod[] = ['day', 'week', 'month', '5m', '15m', '30m', '60m', '120m'];
      const period = allowed.includes(req.query?.period as KlinePeriod)
        ? (req.query!.period as KlinePeriod)
        : 'day';
      const limit = Math.min(Math.max(Number(req.query?.limit) || 250, 30), 800);
      try {
        const data: KlineBar[] = await getKline(code, period, limit, secid);
        return { ok: true, data };
      } catch (e) {
        return reply
          .code(502)
          .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  // ===== 批量实时行情（计划/盯盘等页面合并展示）=====
  app.get<{ Querystring: { codes?: string } }>('/api/quotes', async (req, reply) => {
    const codes = Array.from(new Set((req.query?.codes ?? '').match(/\d{6}/g) ?? []));
    if (codes.length === 0) return { ok: true, data: [] };
    try {
      return { ok: true, data: await getQuotes(codes) };
    } catch (e) {
      return reply
        .code(502)
        .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ===== 当日分时（个股 / 板块 / 大盘指数）=====
  app.get<{ Querystring: { code?: string; secid?: string } }>('/api/trends', async (req, reply) => {
    const code = req.query?.code ?? '';
    const secid = req.query?.secid;
    // 指数须带显式 secid（与个股撞码）；否则按 code 解析（个股 6 位 / 板块 BKxxxx）
    if (secid) {
      if (!/^\d+\.[A-Za-z0-9]+$/.test(secid)) {
        return reply.code(400).send({ ok: false, error: '非法 secid' });
      }
    } else if (!/^(\d{6}|BK\d+)$/i.test(code)) {
      return reply.code(400).send({ ok: false, error: '非法标的代码' });
    }
    try {
      return { ok: true, data: await getTrends(code, secid) };
    } catch (e) {
      return reply
        .code(502)
        .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ===== 关注标的 =====
  app.get('/api/watchlist', async (_req, reply) => {
    try {
      const items = listWatch();
      const quotes =
        items.length > 0 ? await getQuotes(items.map((i) => i.code)) : [];
      const quoteMap = new Map(quotes.map((q) => [q.code, q]));
      const data: WatchlistEntry[] = items.map((i) => ({
        ...i,
        quote: quoteMap.get(i.code) ?? null,
      }));
      return { ok: true, data };
    } catch (e) {
      return reply
        .code(502)
        .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post<{ Body: WatchlistInput }>('/api/watchlist', async (req, reply) => {
    const code = (req.body?.code ?? '').trim();
    if (!/^\d{6}$/.test(code)) {
      return reply.code(400).send({ ok: false, error: '请输入 6 位股票代码' });
    }
    try {
      const [quote] = await getQuotes([code]);
      if (!quote || !quote.name) {
        return reply
          .code(400)
          .send({ ok: false, error: `未查到代码 ${code} 的行情，请确认是否为主板/创业板标的` });
      }
      const tags = req.body?.tags?.trim() || null;
      addWatch({
        code,
        name: quote.name,
        tags,
        note: req.body?.note?.trim() || null,
      });
      await pushThs(() => pushTagsDiff(code, null, tags));
      return { ok: true, data: { ...quote } };
    } catch (e) {
      return reply
        .code(502)
        .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 批量添加：粘贴代码串（逗号/空格/换行混合分隔），去重校验后一次批量取行情入库
  app.post<{ Body: WatchlistBulkInput }>('/api/watchlist/bulk', async (req, reply) => {
    const raw = req.body?.codes ?? '';
    const codes = Array.from(new Set(raw.match(/\d{6}/g) ?? []));
    if (codes.length === 0) {
      return reply.code(400).send({ ok: false, error: '未识别到任何 6 位股票代码' });
    }
    const tags = req.body?.tags?.trim() || null;
    try {
      const quotes = await getQuotes(codes);
      const quoteMap = new Map(quotes.map((q) => [q.code, q]));
      const added: string[] = [];
      const invalid: string[] = [];
      for (const code of codes) {
        const quote = quoteMap.get(code);
        if (!quote || !quote.name) {
          invalid.push(code);
          continue;
        }
        addWatch({ code, name: quote.name, tags, note: null });
        added.push(code);
      }
      for (const code of added) await pushThs(() => pushTagsDiff(code, null, tags));
      const data: WatchlistBulkResult = { added, invalid };
      return { ok: true, data };
    } catch (e) {
      return reply
        .code(502)
        .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.put<{ Params: { code: string }; Body: { tags?: string; note?: string } }>(
    '/api/watchlist/:code',
    async (req) => {
      const code = req.params.code;
      const newTags = req.body?.tags?.trim();
      const oldTags = listWatch().find((i) => i.code === code)?.tags ?? null;
      updateWatch(code, {
        tags: newTags ?? undefined,
        note: req.body?.note?.trim() ?? undefined,
      });
      if (newTags !== undefined) {
        await pushThs(() => pushTagsDiff(code, oldTags, newTags || null));
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: { code: string } }>('/api/watchlist/:code', async (req) => {
    const code = req.params.code;
    const tags = listWatch().find((i) => i.code === code)?.tags ?? null;
    removeWatch(code);
    await pushThs(() => pushRemove(code, tags));
    return { ok: true };
  });

  // 删除分组（tag）：本地从所有标的剥离该 tag，并写透删除同花顺对应分组
  app.delete<{ Params: { name: string } }>('/api/watchlist/group/:name', async (req) => {
    const name = decodeURIComponent(req.params.name);
    const affected = removeTagFromAll(name);
    await pushThs(() => pushDeleteGroup(name));
    return { ok: true, data: { affected } };
  });

  // 与同花顺自选股同步（以同花顺为准调和本地）
  app.post('/api/watchlist/sync', async (_req, reply) => {
    try {
      const data: WatchlistSyncResult = await syncFavorites();
      return { ok: true, data };
    } catch (e) {
      return reply
        .code(502)
        .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 本系统 → 爱盯盘 单向镜像（手动触发，推送云端手动备份）
  app.post('/api/watchlist/push-idingpan', async (_req, reply) => {
    try {
      const data: IdingpanPushResult = await pushToIdingpan();
      return { ok: true, data };
    } catch (e) {
      return reply
        .code(502)
        .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 单只标的 AI 研判
  app.post<{ Params: { code: string } }>(
    '/api/watchlist/:code/analyze',
    async (req, reply) => {
      const item = listWatch().find((i) => i.code === req.params.code);
      if (!item) return reply.code(404).send({ ok: false, error: '标的不在关注列表' });
      try {
        const prompt =
          `请对关注标的 ${item.name}(${item.code}) 做个股研判：` +
          '用 mx_finance_data 查实时量价/资金流/估值与涨跌停价，用 mx_search 查最新消息面与公告，' +
          (item.tags ? `结合标签【${item.tags}】所属主线，` : '') +
          (item.note ? `参考我的备注【${item.note}】，` : '') +
          '给出：当前所处位置与趋势、关键支撑/压力位、买卖点建议、主要风险提示。' +
          '结论精炼、分点、给依据，禁止 Markdown 表格。';
        const result = await runTask(
          {
            id: null,
            name: `个股研判·${item.name}`,
            prompt,
            modelConfig: { thinking: false, maxSteps: 10 },
            notifyChannels: ['webui'],
            timeoutSec: 300,
            purpose: 'analyze',
          },
          'manual',
        );
        return {
          ok: result.status === 'success',
          data: { runId: result.runId, status: result.status, text: result.outputText },
          error: result.status === 'success' ? undefined : `研判未成功（${result.status}）`,
        };
      } catch (e) {
        return reply
          .code(502)
          .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  // 整组关注标的一键 AI 分析
  app.post('/api/watchlist/analyze', async (_req, reply) => {
    const items = listWatch();
    if (items.length === 0) {
      return reply.code(400).send({ ok: false, error: '关注列表为空' });
    }
    try {
      const list = items
        .map((i) => `${i.name}(${i.code})${i.tags ? ` [${i.tags}]` : ''}`)
        .join('、');
      const prompt =
        `以下是我的关注标的清单：${list}。` +
        '请逐只用 mx_finance_data 查实时量价/资金/估值，必要时用 mx_search 补充消息面，' +
        '做一次组合层面的轮动研判：逐只给当前位置与买卖点倾向，再综合排序当前最值得关注/最该回避的标的及理由，并给风险提示。' +
        '结论精炼、分点、给依据，禁止 Markdown 表格。';
      const result = await runTask(
        {
          id: null,
          name: '关注标的组合研判',
          prompt,
          modelConfig: { thinking: false, maxSteps: 12 },
          notifyChannels: ['webui'],
          timeoutSec: 300,
          purpose: 'analyze',
        },
        'manual',
      );
      return {
        ok: result.status === 'success',
        data: { runId: result.runId, status: result.status, text: result.outputText },
        error: result.status === 'success' ? undefined : `分析未成功（${result.status}）`,
      };
    } catch (e) {
      return reply
        .code(502)
        .send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ===== 聊天 =====
  app.get('/api/chat/sessions', () => {
    pruneEmptySessions();
    return { ok: true, data: listSessions() };
  });
  app.post('/api/chat/sessions', () => ({ ok: true, data: createSession() }));
  app.delete<{ Params: { id: string } }>('/api/chat/sessions/:id', (req) => {
    deleteSession(req.params.id);
    return { ok: true };
  });
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
    // 当前在飞运行的中止控制器：socket 关闭或收到 stop 控制消息时 abort，及时停止后端 run 省 token
    let activeAbort: AbortController | null = null;

    socket.on('message', async (raw: Buffer) => {
      let payload: { sessionId?: string; content?: string; thinking?: boolean; action?: string };
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: '消息格式错误' }));
        return;
      }
      // 控制消息：用户主动停止当前运行
      if (payload.action === 'stop') {
        activeAbort?.abort();
        return;
      }
      const { sessionId, content } = payload;
      if (!sessionId || !content) return;

      const history: ChatCompletionMessageParam[] = listMessages(sessionId).map((m) => ({
        role: m.role === 'tool' ? 'assistant' : (m.role as 'user' | 'assistant' | 'system'),
        content: m.content,
      }));
      addMessage(sessionId, 'user', content);

      const send = (e: StreamEvent) => {
        try {
          socket.send(JSON.stringify(e));
        } catch {
          /* socket 可能已关闭 */
        }
      };
      // 上一轮若仍在跑（异常情况），先中止，避免并发烧 token
      activeAbort?.abort();
      const abortController = new AbortController();
      activeAbort = abortController;
      // 运行管理 + 调用记录 + run 生命周期事件均由 gateway 接管（经 onEvent 透传到本 socket）
      const result = await gateway.call({
        mode: 'agent',
        trigger: 'chat',
        purpose: 'chat',
        taskName: '聊天',
        prompt: content,
        history,
        // 深思开关由前端传入，缺省按开启（兼容老前端）
        modelConfig: { thinking: payload.thinking ?? true },
        timeoutSec: 300,
        signal: abortController.signal,
        // 同一会话用稳定缓存键，提升多轮对话的上游前缀缓存命中
        cacheKey: `chat:${sessionId}`,
        onEvent: send,
      });
      if (activeAbort === abortController) activeAbort = null;
      // 中止运行不写入 assistant 结果（避免把半截/空回答落库污染会话）
      if (result.status !== 'canceled' && result.outputText) {
        addMessage(sessionId, 'assistant', result.outputText);
      }
      if (history.length === 0) touchSession(sessionId, content.slice(0, 20));
      else touchSession(sessionId);
    });

    // 连接关闭：中止在飞运行（避免 socket 断开后 run 仍继续跑、继续烧 token）
    socket.on('close', () => {
      activeAbort?.abort();
      activeAbort = null;
    });
  });

  // ===== WebSocket：一键复盘（流式）=====
  // 以当前盘面快照 + 真实持仓为上下文跑 agent，强制输出结构化 JSON 供前端模块化渲染。
  app.get('/ws/review', { websocket: true }, (socket) => {
    socket.on('message', async (raw: Buffer) => {
      let payload: { action?: string };
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: '消息格式错误' }));
        return;
      }
      if (payload.action !== 'generate') return;

      const send = (e: StreamEvent) => {
        try {
          socket.send(JSON.stringify(e));
        } catch {
          /* socket 可能已关闭 */
        }
      };

      // 上下文组装（盘面/持仓/自选/上次复盘）已抽至 ./review/service，供定时深度复盘共用
      const prompt = await buildDeepReviewPrompt();

      // 前端 run_finished 依赖先收到最终 message 才能解析结构化结果，故在此拦截 gateway 的
      // run_finished，待补发 message 后再发，保证「message → run_finished」次序。
      const onEvent = (e: StreamEvent) => {
        if (e.type === 'run_finished') return;
        send(e);
      };
      const result = await gateway.call({
        mode: 'agent',
        trigger: 'manual',
        purpose: 'review',
        taskName: '一键复盘',
        prompt,
        // 数据已预置，限制工具轮次以尽快收敛、避免超时；末步强制综合产出
        modelConfig: { thinking: false, maxSteps: 8, maxTokens: 16000 },
        timeoutSec: 420,
        onEvent,
      });
      send({ type: 'message', role: 'assistant', content: result.outputText });
      send({ type: 'run_finished', runId: result.runId ?? '', status: result.status });
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
  // 停机期间错过的定时任务检查（仅提示不自动补跑）；不阻塞启动
  void catchUpMissedRuns();

  // 安全控制台（交易/模拟总闸：kill switch + 自动开关，须早于交易类模块注册）
  registerSafetyModule(app);

  // 真实持仓纪律模块（确定性体检 + 纪律事件 + 定时，独立，删除此行整模块下线）
  registerPositionsModule(app);

  // 结构化市场主线模块（复盘/热点聚合 market_themes，独立，删除此行整模块下线）
  registerThemesModule(app);

  // 中线雷达模块（行业强弱+持仓趋势+候选池，确定性只读，独立，删除此行整模块下线）
  registerRadarModule(app);

  // 实时盯盘模块（独立，可删除以下两行整模块下线）
  registerWatchModule(app);
  startWatchEngine();

  // 热点雷达模块（独立，删除此行整模块下线）
  registerTrendRadarModule(app);

  // 研报模块（独立，删除此行整模块下线）
  registerResearchModule(app);

  // 今日计划模块（独立，删除此行整模块下线）
  registerPlanModule(app);

  // ETF 模块（独立，删除此行整模块下线）
  registerEtfModule(app);

  // 数据源中心模块（独立，删除此行整模块下线）
  registerDataSourceModule(app);

  // Agent 工具管理（罗列 / 启停 / 描述覆盖，独立，删除此行整模块下线）
  registerToolsModule(app);

  // Agent 提示词管理（全局提示词罗列 / 覆盖，独立，删除此行整模块下线）
  registerPromptsModule(app);

  // 调度总览（聚合中央任务 + 模块定时的只读视图，独立，删除此行整模块下线）
  registerSchedulesModule(app);

  // 运维模块（SQLite 体积治理 + 自动清理定时，独立，删除此行整模块下线）
  registerOpsModule(app);

  // 复盘模块定时（独立，删除此行整模块定时下线）
  registerReviewModule(app);

  // 公共 AI 分析模块（流式弹窗 + 历史，独立，删除此行整模块下线）
  registerAnalyzeModule(app);

  // 多智能体辩论决策模块（流式 /ws/decision + 复用公共历史，独立，删除此行整模块下线）
  registerDecisionModule(app);

  // 选股引擎模块（三层漏斗多因子选股，独立，删除此行整模块下线）
  registerScreenerModule(app);

  // 大盘模块定时（独立，删除此行整模块定时下线）
  registerMarketSchedule(app);

  // 各模块定时注册完成后，做一次停机期间错过检查（仅提示不自动补跑）；不阻塞启动
  void catchUpModuleMissedRuns();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[server] 监听 http://0.0.0.0:${config.port}`);
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
