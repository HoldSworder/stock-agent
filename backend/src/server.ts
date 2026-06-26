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
import {
  listRuns,
  listRunsByTaskIds,
  getRun,
  listReviews,
  reconcileOrphanRuns,
  cancelRunningRunsOnShutdown,
} from './repo';
import { sqlite } from './db/client';
import { getUsageSummary, listLlmCalls } from './usage';
import { fetchRealPositions } from './realPositions';
import {
  getQuotes,
  searchSuggest,
  searchBoard,
  getKline,
  getTrends,
} from './market/eastmoney';
import { getStockIndicators } from './market/indicators';
import { getChipDistribution } from './market/chip';
import {
  buildOverview,
  buildMarketBoardPrompt,
  MARKET_BOARD_TASK_NAME,
} from './market/overview';
import { buildMacroOverview } from './market/macro';
import { buildUsMapping } from './market/usMapping';
import { getModules, setModules } from './market/modules';
import { registerMarketSchedule } from './market/schedule';
import { cached } from './lib/ttlCache';
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
import { registerStrategyForward } from './strategy/forwardModule';
import {
  runBacktest,
  listBacktestRuns,
  getBacktestRun,
  BacktestError,
} from './backtest/service';
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
  BacktestRunInput,
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
import { registerEtfWatchModule, startEtfWatchEngine } from './etfwatch';
import { registerTrendRadarModule } from './trendradar';
import { registerResearchModule } from './research';
import { registerClsModule } from './cls';
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
import { registerRotationModule } from './rotation';
import { registerSentimentModule } from './sentiment';
import { registerBreadthModule } from './breadth';
import { registerConceptsModule } from './concepts';
import { registerDragonModule } from './dragon';
import { registerCapitalModule } from './capital';
import { registerCockpitModule } from './cockpit';
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
  // 响应级 60s 缓存：聚合 ~13 个东财接口，重进页面/多端共享同一快照（定时/agent 直连 buildOverview 不受影响）
  app.get('/api/market/overview', async () => ({
    ok: true,
    data: await cached('market:overview', 60_000, buildOverview),
  }));

  // 宏观·资金面底稿（日频/EOD 低频指标）：与实时盘面分离，10 分钟 TTL 足够
  app.get('/api/market/macro', async () => ({
    ok: true,
    data: await cached('market:macro', 600_000, buildMacroOverview),
  }));

  // 美股映射底稿（隔夜美股龙头/行业 → A股概念·ETF·个股）：盘前情绪背景，10 分钟 TTL
  app.get('/api/market/usmapping', async () => ({
    ok: true,
    data: await cached('market:usmapping', 600_000, buildUsMapping),
  }));

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

  // 一键 AI 大盘与板块研判：以当前盘面为上下文跑 agent（合并大盘复盘 + 板块主线）
  app.post('/api/market/review', async (_req, reply) => {
    try {
      const ov = await buildOverview();
      const result = await runTask(
        {
          id: null,
          name: MARKET_BOARD_TASK_NAME,
          prompt: await buildMarketBoardPrompt(ov),
          modelConfig: { thinking: false, maxSteps: 12, maxTokens: 14000 },
          notifyChannels: ['webui'],
          timeoutSec: 600,
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
    Body: {
      name?: string;
      description?: string | null;
      skillEnabled?: boolean;
      autoSimEnabled?: boolean;
      screenEngine?: string | null;
      screenStrategyId?: string | null;
      horizon?: 'short' | 'mid';
      pickTopN?: number | null;
      maxPositions?: number | null;
      rebalanceCron?: string | null;
    };
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

  // ===== 回测 =====
  // 入参校验失败（BacktestError）回 400，取数/引擎异常回 502
  const backtestErr = (reply: import('fastify').FastifyReply, e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(e instanceof BacktestError ? 400 : 502).send({ ok: false, error: msg });
  };

  app.post<{ Body: BacktestRunInput }>('/api/backtest/run', async (req, reply) => {
    try {
      return { ok: true, data: await runBacktest(req.body) };
    } catch (e) {
      return backtestErr(reply, e);
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/api/backtest/runs', (req, reply) => {
    try {
      const limit = req.query?.limit ? Number(req.query.limit) : undefined;
      return { ok: true, data: listBacktestRuns(limit) };
    } catch (e) {
      return backtestErr(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>('/api/backtest/runs/:id', (req, reply) => {
    const run = getBacktestRun(req.params.id);
    if (!run) return reply.code(404).send({ ok: false, error: '回测记录不存在' });
    return { ok: true, data: run };
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

  // ===== S9 技术指标库：个股 MACD/KDJ/RSI/BOLL 读数（KlineDialog 副图读数条）=====
  app.get<{ Params: { code: string } }>('/api/stock/:code/indicators', async (req, reply) => {
    const code = String(req.params.code || '').trim();
    if (!/^\d{6}$/.test(code)) return reply.code(400).send({ ok: false, error: '请提供 6 位个股代码' });
    try {
      return { ok: true, data: await getStockIndicators(code) };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ===== S8 筹码分布：个股获利比例/成本区间/集中度（KlineDialog 筹码 Tab）=====
  app.get<{ Params: { code: string } }>('/api/stock/:code/chips', async (req, reply) => {
    const code = String(req.params.code || '').trim();
    if (!/^\d{6}$/.test(code)) return reply.code(400).send({ ok: false, error: '请提供 6 位个股代码' });
    try {
      return { ok: true, data: await getChipDistribution(code) };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

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

  // 自选单只 / 组合 AI 研判已收编为统一 analyze kind（watchlist-stock / watchlist-combo），
  // 发起走 /ws/analyze 流式 + /api/analyses 历史；原内联同步路由已下线。

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

  // M1 ETF 行业轮动模块（确定性轮动榜 + agent 过滤研判，独立，删除此行整模块下线）
  registerRotationModule(app);

  // S1 市场情绪周期模块（确定性 0-100 情绪指数 + 周期阶段 + 收盘快照，纯只读，删除此行整模块下线）
  registerSentimentModule(app);

  // 板块新高宽度主线识别（确定性：各板块创新高个股数横向排名 + 持续性判主线 + 收盘快照，删除此行整模块下线）
  registerBreadthModule(app);

  // 热门细分概念主线归纳（确定性：概念涨幅 + 主力净流入 + 新高宽度 合成热度分 + 主题归纳，纯只读，删除此行整模块下线）
  registerConceptsModule(app);

  // S6 龙头/连板梯队模块（确定性连板梯队 + 龙头辨识分层，纯只读，删除此行整模块下线）
  registerDragonModule(app);
  registerCapitalModule(app);

  // 战法前向验证（收盘样本采集 + 前向统计 + 自动模拟总闸，自动买入默认关闭，删除此行整模块下线）
  registerStrategyForward(app);

  // 驾驶舱（一屏概览 + 跨模块事件时间线，纯只读聚合，删除此行整模块下线）
  registerCockpitModule(app);

  // 实时盯盘模块（独立，可删除以下两行整模块下线）
  registerWatchModule(app);
  startWatchEngine();

  // ETF 多周期分层盯盘模块（独立，可删除以下两行整模块下线）
  registerEtfWatchModule(app);
  startEtfWatchEngine();

  // 热点雷达模块（独立，删除此行整模块下线）
  registerTrendRadarModule(app);

  // 研报模块（独立，删除此行整模块下线）
  registerResearchModule(app);

  // 财联社电报模块（独立，删除此行整模块下线）
  registerClsModule(app);

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

  // 优雅关闭：开发热更新 / 手动重启发来的 SIGINT·SIGTERM，先关 HTTP 释放端口（根治新进程 EADDRINUSE），
  // 再把在跑 run 标 canceled（区别真崩溃），最后 checkpoint 落库并退出。只执行一次。
  let shuttingDown = false;
  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] 收到 ${signal}，开始优雅关闭...`);
    try {
      await app.close();
    } catch {
      /* 关闭期异常忽略，继续后续清理 */
    }
    try {
      const canceled = cancelRunningRunsOnShutdown();
      if (canceled > 0) console.log(`[server] 已将 ${canceled} 个在跑运行标记为 canceled`);
    } catch {
      /* 标记失败不阻断退出 */
    }
    try {
      sqlite.pragma('wal_checkpoint(TRUNCATE)');
      sqlite.close();
    } catch {
      /* 关闭期异常忽略 */
    }
    process.exit(0);
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => void gracefulShutdown(sig));
  }

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (e) {
    if ((e as { code?: string })?.code === 'EADDRINUSE') {
      console.error(
        `启动失败: 端口 ${config.port} 已被占用，可能有残留后端进程未退出。` +
          `请先停掉旧进程（lsof -nP -iTCP:${config.port} -sTCP:LISTEN -t | xargs kill）后重试。`,
      );
      process.exit(1);
    }
    throw e;
  }
  console.log(`[server] 监听 http://0.0.0.0:${config.port}`);
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
