import axios from 'axios';
import type {
  AiAnalysisHistoryItem,
  AiAnalysisKindInfo,
  ApiResult,
  AppSettings,
  AuthStatus,
  LoginResult,
  ChatMessage,
  ChatSession,
  DailyPlanDetail,
  DailyPlanEvent,
  DailyPlanSummary,
  OneClickRunState,
  PlanFulfillment,
  DataSourceConfigUpdate,
  DataSourceHealth,
  DataSourceInfo,
  DataSourceRoute,
  DataSourceStats,
  DecisionAgentInfo,
  DecisionAgentUpdate,
  DecisionEngineConfig,
  DecisionEngineOverview,
  DecisionIndexInfo,
  DecisionVerdictCache,
  EtfPoolItem,
  EtfOverview,
  EtfRotationOverview,
  MidDrilldownResult,
  EtfSignalsResult,
  SentimentOverview,
  SentimentHistoryItem,
  BoardBreadthOverview,
  BoardBreadthHistoryItem,
  HotConceptOverview,
  ConceptStocksResult,
  ConceptWindow,
  MainlineConsensus,
  DragonOverview,
  StockCapitalDetail,
  StockIndicators,
  StockChipDistribution,
  RadarOverview,
  PositionTrend,
  EtfStatus,
  HomeModule,
  IdingpanPushResult,
  KlineBar,
  KlinePeriod,
  BacktestRun,
  BacktestRunInput,
  BacktestRunListItem,
  MacroOverview,
  UsMappingOverview,
  MarketOverview,
  ModuleScheduleJob,
  ModuleScheduleUpdate,
  OpsCleanupResult,
  OpsDbStats,
  PromptConfigUpdate,
  PromptInfo,
  RealPortfolio,
  RetentionConfig,
  CockpitEvent,
  CockpitOverview,
  SafetyState,
  SafetyUpdate,
  DisciplineConfig,
  DisciplineEvent,
  DisciplineOverride,
  DisciplineOverrideInput,
  DisciplineReport,
  PositionAttributionReport,
  VsSimReport,
  MarketTheme,
  MarketThemeStatus,
  ThemesRefreshResult,
  ScheduleOverviewItem,
  ResearchAiAnalysis,
  ResearchAnnouncementItem,
  ResearchQuery,
  ResearchReport,
  ResearchReportDetail,
  ResearchReportType,
  ResearchStatus,
  ReviewHistoryItem,
  RunMessage,
  ScheduledTask,
  ScheduledTaskInput,
  ToolInfo,
  ToolConfigUpdate,
  SimTrade,
  SimTradeInput,
  StockQuote,
  StockSuggest,
  SkillDimension,
  Strategy,
  StrategyInput,
  StrategyForwardStats,
  StrategyListItem,
  StrategySkillView,
  StrategySnapshot,
  TaskRun,
  LlmCallRecord,
  UsageSummary,
  TrendNews,
  TrendRadarStatus,
  TrendRssItem,
  TrendSummary,
  TrendSummaryHistoryItem,
  TrendTopic,
  TrendsResult,
  ClsTelegraph,
  WatchAlert,
  WatchConfig,
  WatchStats,
  WatchStatus,
  WatchStrategyView,
  EtfWatchAlert,
  EtfWatchConfig,
  EtfWatchLayerState,
  EtfWatchProbe,
  EtfWatchStatus,
  WatchlistBulkInput,
  WatchlistBulkResult,
  WatchlistEntry,
  WatchlistInput,
  WatchlistSyncResult,
  ScreenStrategy,
  ScreenNlStrategy,
  ScreenRun,
  ScreenRunDetail,
  ScreenEngineInfo,
} from '@stock-agent/shared';

const TOKEN_KEY = 'sa_token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

const http = axios.create({ baseURL: '/api', timeout: 30000 });

// 请求拦截：注入访问 token
http.interceptors.request.use((cfg) => {
  const token = getToken();
  if (token) cfg.headers['x-app-token'] = token;
  return cfg;
});

// 响应拦截：401 清 token 并跳登录页（避免在登录页自身重定向）
http.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err?.response?.status === 401) {
      clearToken();
      if (!location.pathname.startsWith('/login')) {
        const redirect = encodeURIComponent(location.pathname + location.search);
        location.assign(`/login?redirect=${redirect}`);
      }
    }
    return Promise.reject(err);
  },
);

async function unwrap<T>(p: Promise<{ data: ApiResult<T> }>): Promise<T> {
  const res = await p;
  if (!res.data.ok) throw new Error(res.data.error || '请求失败');
  return res.data.data as T;
}

export const api = {
  // 鉴权
  authStatus: () => unwrap<AuthStatus>(http.get('/auth/status')),
  login: (password: string) =>
    unwrap<LoginResult>(http.post('/auth/login', { password })),
  setPassword: (next: string) =>
    unwrap<LoginResult>(http.post('/auth/password', { next })),

  // 设置
  getSettings: () => unwrap<AppSettings>(http.get('/settings')),
  updateSettings: (patch: Record<string, string>) =>
    unwrap<AppSettings>(http.put('/settings', patch)),
  testLLM: () => unwrap<{ ok: boolean; message: string }>(http.post('/settings/test-llm')),

  // 任务
  listTasks: () => unwrap<ScheduledTask[]>(http.get('/tasks')),
  getTask: (id: string) => unwrap<ScheduledTask>(http.get(`/tasks/${id}`)),
  createTask: (body: ScheduledTaskInput) => unwrap<ScheduledTask>(http.post('/tasks', body)),
  updateTask: (id: string, body: Partial<ScheduledTaskInput>) =>
    unwrap<ScheduledTask>(http.put(`/tasks/${id}`, body)),
  deleteTask: (id: string) => unwrap<void>(http.delete(`/tasks/${id}`)),
  triggerTask: (id: string, opts?: { forceTrade?: boolean }) =>
    unwrap<void>(http.post(`/tasks/${id}/trigger`, { forceTrade: opts?.forceTrade ?? false })),

  // 运行 / 复盘
  listRuns: () => unwrap<TaskRun[]>(http.get('/runs')),
  getRun: (id: string) =>
    unwrap<{ run: TaskRun; messages: RunMessage[] }>(http.get(`/runs/${id}`)),

  // 调用记录分析
  usage: {
    summary: (days = 30) =>
      unwrap<UsageSummary>(http.get('/usage/summary', { params: { days } })),
    calls: (limit = 100, purpose?: string) =>
      unwrap<LlmCallRecord[]>(http.get('/usage/calls', { params: { limit, purpose } })),
  },

  // 真实持仓
  getRealPositions: () => unwrap<RealPortfolio>(http.get('/positions/real', { timeout: 20000 })),

  // 真实持仓纪律（确定性体检 + 逐票覆盖 + 事件流）
  discipline: {
    check: () => unwrap<DisciplineReport>(http.get('/positions/discipline', { timeout: 25000 })),
    getConfig: () => unwrap<DisciplineConfig>(http.get('/positions/discipline/config')),
    setConfig: (patch: Partial<DisciplineConfig>) =>
      unwrap<DisciplineConfig>(http.put('/positions/discipline/config', patch)),
    listOverrides: () =>
      unwrap<DisciplineOverride[]>(http.get('/positions/discipline/overrides')),
    setOverride: (code: string, patch: DisciplineOverrideInput) =>
      unwrap<DisciplineOverride>(http.put(`/positions/discipline/overrides/${code}`, patch)),
    removeOverride: (code: string) =>
      unwrap<void>(http.delete(`/positions/discipline/overrides/${code}`)),
    events: (limit?: number) =>
      unwrap<DisciplineEvent[]>(http.get('/positions/discipline/events', { params: { limit } })),
    getPushMedium: () =>
      unwrap<{ enabled: boolean }>(http.get('/positions/discipline/push-medium')),
    setPushMedium: (enabled: boolean) =>
      unwrap<{ enabled: boolean }>(http.put('/positions/discipline/push-medium', { enabled })),
  },

  // 日终持仓归因 + 真实 vs 模拟绩效对照（只读）
  attribution: (date?: string) =>
    unwrap<PositionAttributionReport | null>(
      http.get('/positions/attribution', { params: { date } }),
    ),
  vsSim: () => unwrap<VsSimReport>(http.get('/positions/vs-sim', { timeout: 25000 })),

  // 结构化市场主线（复盘/热点聚合 market_themes）
  themes: {
    list: (includeArchived = false) =>
      unwrap<MarketTheme[]>(
        http.get('/themes', { params: includeArchived ? { includeArchived: '1' } : {} }),
      ),
    refresh: () =>
      unwrap<ThemesRefreshResult>(http.post('/themes/refresh', {}, { timeout: 60000 })),
    setStatus: (id: string, status: MarketThemeStatus) =>
      unwrap<MarketTheme>(http.put(`/themes/${id}`, { status })),
    // 板块主线研判（agent 过滤层）：历史记录 + 按需触发
    boardReviews: (limit?: number) =>
      unwrap<ReviewHistoryItem[]>(http.get('/themes/board-reviews', { params: { limit } })),
    boardReview: () =>
      unwrap<{ runId: string; status: string; text: string }>(
        http.post('/themes/board-review', {}, { timeout: 420000 }),
      ),
  },

  // 统一 AI 分析中心目录（全部 kind + 最新结论摘要；驾驶舱中心渲染）
  analysisCatalog: () =>
    unwrap<AiAnalysisKindInfo[]>(http.get('/analyses', { timeout: 20000 })),

  // 公共 AI 分析历史（按 kind + 可选 refKey 作用域；流式发起走 WS /ws/analyze）
  // all=true 时忽略 refKey，返回该 kind 全部历史（跨标的全局视图）
  listAnalyses: (kind: string, refKey?: string, limit?: number, all?: boolean) =>
    unwrap<AiAnalysisHistoryItem[]>(
      http.get(`/analyses/${kind}`, {
        params: { refKey, limit, all: all ? 1 : undefined },
        timeout: 20000,
      }),
    ),

  // 批量实时行情（计划/盯盘合并展示）
  quotes: (codes: string[]) =>
    unwrap<StockQuote[]>(http.get('/quotes', { params: { codes: codes.join(',') }, timeout: 20000 })),

  // 关注标的
  listWatchlist: () =>
    unwrap<WatchlistEntry[]>(http.get('/watchlist', { timeout: 20000 })),
  addWatch: (body: WatchlistInput) => unwrap<StockQuote>(http.post('/watchlist', body)),
  bulkAddWatch: (body: WatchlistBulkInput) =>
    unwrap<WatchlistBulkResult>(http.post('/watchlist/bulk', body, { timeout: 20000 })),
  updateWatch: (code: string, body: { tags?: string; note?: string }) =>
    unwrap<void>(http.put(`/watchlist/${code}`, body)),
  removeWatch: (code: string) => unwrap<void>(http.delete(`/watchlist/${code}`)),
  syncWatchlist: () =>
    unwrap<WatchlistSyncResult>(http.post('/watchlist/sync', {}, { timeout: 30000 })),
  deleteWatchGroup: (name: string) =>
    unwrap<{ affected: number }>(http.delete(`/watchlist/group/${encodeURIComponent(name)}`)),
  searchStocks: (q: string) =>
    unwrap<StockSuggest[]>(http.get('/search/suggest', { params: { q }, timeout: 8000 })),
  searchBoard: (q: string) =>
    unwrap<StockSuggest[]>(http.get('/search/board', { params: { q }, timeout: 8000 })),
  getKline: (code: string, period: KlinePeriod = 'day', limit = 250, secid?: string) =>
    unwrap<KlineBar[]>(
      http.get('/kline', {
        params: secid ? { secid, period, limit } : { code, period, limit },
        timeout: 15000,
      }),
    ),
  getTrends: (code: string, secid?: string) =>
    unwrap<TrendsResult>(
      http.get('/trends', { params: secid ? { secid } : { code }, timeout: 12000 }),
    ),
  pushIdingpan: () =>
    unwrap<IdingpanPushResult>(http.post('/watchlist/push-idingpan', {}, { timeout: 30000 })),
  // 自选 AI 研判已迁为统一 analyze kind（watchlist-stock / watchlist-combo），
  // 前端经 <AiAnalysisDialog> 走 /ws/analyze 流式 + /api/analyses 历史，原同步接口已下线。

  // 大盘看盘
  getMarketOverview: () =>
    unwrap<MarketOverview>(http.get('/market/overview', { timeout: 20000 })),
  getMacroOverview: () =>
    unwrap<MacroOverview>(http.get('/market/macro', { timeout: 20000 })),
  getUsMapping: () =>
    unwrap<UsMappingOverview>(http.get('/market/usmapping', { timeout: 20000 })),
  getMarketModules: () => unwrap<HomeModule[]>(http.get('/market/modules')),
  updateMarketModules: (patch: Record<string, boolean>) =>
    unwrap<HomeModule[]>(http.put('/market/modules', patch)),
  marketReview: () =>
    unwrap<{ runId: string; status: string; text: string }>(
      http.post('/market/review', {}, { timeout: 300000 }),
    ),
  listReviews: (limit?: number) =>
    unwrap<ReviewHistoryItem[]>(http.get('/reviews', { params: { limit } })),

  // 战法模拟
  listStrategies: () => unwrap<StrategyListItem[]>(http.get('/strategies', { timeout: 20000 })),
  createStrategy: (body: StrategyInput) => unwrap<Strategy>(http.post('/strategies', body)),
  getStrategy: (id: string) =>
    unwrap<StrategySnapshot>(http.get(`/strategies/${id}`, { timeout: 20000 })),
  updateStrategy: (
    id: string,
    body: {
      name?: string;
      description?: string | null;
      skillEnabled?: boolean;
      autoSimEnabled?: boolean;
      screenEngine?: string | null;
      screenStrategyId?: string | null;
    },
  ) => unwrap<Strategy>(http.put(`/strategies/${id}`, body)),
  deleteStrategy: (id: string) => unwrap<void>(http.delete(`/strategies/${id}`)),
  simTrade: (id: string, body: SimTradeInput) =>
    unwrap<SimTrade>(http.post(`/strategies/${id}/trade`, body, { timeout: 20000 })),
  runStrategy: (id: string, prompt: string) =>
    unwrap<{ runId: string; status: string; text: string }>(
      http.post(`/strategies/${id}/run`, { prompt }, { timeout: 600000 }),
    ),
  syncStrategy: (id: string) =>
    unwrap<StrategySnapshot>(http.post(`/strategies/${id}/sync`, {}, { timeout: 30000 })),
  resetStrategy: (id: string) =>
    unwrap<StrategySnapshot>(http.post(`/strategies/${id}/reset`, {}, { timeout: 30000 })),
  getStrategyDailyOutput: (id: string) =>
    unwrap<TaskRun[]>(http.get(`/strategies/${id}/daily-output`)),

  // 回测（单标的信号级 / 组合级）
  runBacktest: (body: BacktestRunInput) =>
    unwrap<BacktestRun>(http.post('/backtest/run', body, { timeout: 120000 })),
  listBacktestRuns: (limit?: number) =>
    unwrap<BacktestRunListItem[]>(http.get('/backtest/runs', { params: { limit } })),
  getBacktestRun: (id: string) => unwrap<BacktestRun>(http.get(`/backtest/runs/${id}`)),

  // 战法前向验证（样本曲线/累计收益/回撤/胜率）+ 自动模拟总闸
  getStrategyForward: (id: string) =>
    unwrap<StrategyForwardStats>(http.get(`/strategies/${id}/forward`, { timeout: 20000 })),
  getAutoSim: () => unwrap<{ enabled: boolean }>(http.get('/strategies/auto-sim')),
  setAutoSim: (enabled: boolean) =>
    unwrap<{ enabled: boolean }>(http.put('/strategies/auto-sim', { enabled })),

  // 战法 Skill 自迭代
  getStrategySkills: (id: string) =>
    unwrap<StrategySkillView>(http.get(`/strategies/${id}/skills`)),
  approveSkillProposal: (id: string, pid: string) =>
    unwrap<StrategySkillView>(http.post(`/strategies/${id}/skills/proposals/${pid}/approve`)),
  rejectSkillProposal: (id: string, pid: string) =>
    unwrap<StrategySkillView>(http.post(`/strategies/${id}/skills/proposals/${pid}/reject`)),
  rollbackSkill: (id: string, dimension: SkillDimension, version: number) =>
    unwrap<StrategySkillView>(
      http.post(`/strategies/${id}/skills/${dimension}/rollback`, { version }),
    ),
  updateSkill: (id: string, dimension: SkillDimension, content: string, reason?: string) =>
    unwrap<StrategySkillView>(http.put(`/strategies/${id}/skills/${dimension}`, { content, reason })),

  // 实时盯盘
  getWatchStatus: () => unwrap<WatchStatus>(http.get('/watch/status')),
  getWatchConfig: () => unwrap<WatchConfig>(http.get('/watch/config')),
  updateWatchConfig: (patch: Partial<WatchConfig>) =>
    unwrap<WatchConfig>(http.put('/watch/config', patch)),
  toggleWatch: (enabled: boolean) =>
    unwrap<WatchConfig>(http.post('/watch/toggle', { enabled })),
  listWatchAlerts: (limit?: number) =>
    unwrap<WatchAlert[]>(http.get('/watch/alerts', { params: { limit } })),
  getWatchStats: () => unwrap<WatchStats>(http.get('/watch/stats')),
  getWatchStrategyViews: () =>
    unwrap<WatchStrategyView[]>(http.get('/watch/strategy-views')),

  // ETF 多周期分层盯盘（独立于个股盯盘）
  etfWatch: {
    status: () => unwrap<EtfWatchStatus>(http.get('/etf-watch/status')),
    config: () => unwrap<EtfWatchConfig>(http.get('/etf-watch/config')),
    updateConfig: (patch: Partial<EtfWatchConfig>) =>
      unwrap<EtfWatchConfig>(http.put('/etf-watch/config', patch)),
    toggle: (enabled: boolean) =>
      unwrap<EtfWatchConfig>(http.post('/etf-watch/toggle', { enabled })),
    trigger: () => unwrap<EtfWatchStatus>(http.post('/etf-watch/trigger', {})),
    alerts: (limit?: number, scope?: 'today' | 'all') =>
      unwrap<EtfWatchAlert[]>(http.get('/etf-watch/alerts', { params: { limit, scope } })),
    states: () => unwrap<EtfWatchLayerState[]>(http.get('/etf-watch/states')),
    clearStates: () =>
      unwrap<{ cleared: boolean }>(http.post('/etf-watch/states/clear', {})),
    deleteState: (code: string) =>
      unwrap<{ removed: string }>(http.delete(`/etf-watch/states/${code}`)),
    analyze: (code: string) => unwrap<EtfWatchProbe>(http.post('/etf-watch/analyze', { code })),
  },

  // 热点雷达（TrendRadar）
  trendradar: {
    status: () => unwrap<TrendRadarStatus>(http.get('/trendradar/status', { timeout: 20000 })),
    trending: (top = 30) =>
      unwrap<TrendTopic[]>(http.get('/trendradar/trending', { params: { top }, timeout: 30000 })),
    news: (limit = 80) =>
      unwrap<TrendNews[]>(http.get('/trendradar/news', { params: { limit }, timeout: 30000 })),
    rss: (days = 1) =>
      unwrap<TrendRssItem[]>(http.get('/trendradar/rss', { params: { days }, timeout: 30000 })),
    search: (q: string) =>
      unwrap<TrendNews[]>(http.get('/trendradar/search', { params: { q }, timeout: 30000 })),
    summary: (type: 'daily' | 'weekly' = 'daily') =>
      unwrap<TrendSummary>(http.post('/trendradar/summary', { type }, { timeout: 180000 })),
    summaries: (limit = 30) =>
      unwrap<TrendSummaryHistoryItem[]>(
        http.get('/trendradar/summaries', { params: { limit }, timeout: 20000 }),
      ),
  },

  // 财联社电报（签名直连，失效降级 AKShare 多源）：返回全量带 important，前端本地切换全部/重点
  cls: {
    telegraph: (limit = 50) =>
      unwrap<ClsTelegraph[]>(http.get('/cls/telegraph', { params: { limit }, timeout: 30000 })),
  },

  // 研报（东方财富研报中心）
  research: {
    status: () => unwrap<ResearchStatus>(http.get('/research/status', { timeout: 20000 })),
    list: (query: ResearchQuery) =>
      unwrap<ResearchReport[]>(http.get('/research/list', { params: query, timeout: 30000 })),
    content: (type: ResearchReportType, encodeUrl: string, infoCode = '') =>
      unwrap<ResearchReportDetail>(
        http.get('/research/content', { params: { type, encodeUrl, infoCode }, timeout: 30000 }),
      ),
    analyze: (type: ResearchReportType, encodeUrl: string, infoCode = '') =>
      unwrap<ResearchAiAnalysis>(
        http.post('/research/analyze', { type, encodeUrl, infoCode }, { timeout: 300000 }),
      ),
    analyzeBatch: (body: { scope?: 'watchlist' | 'stock' | 'industry'; code?: string; industry?: string; limit?: number }) =>
      unwrap<ResearchAiAnalysis>(http.post('/research/analyze-batch', body, { timeout: 300000 })),
    discoverReview: () =>
      unwrap<{ runId: string; status: string; text: string }>(
        http.post('/research/discover-review', {}, { timeout: 420000 }),
      ),
    opportunityReviews: (limit?: number) =>
      unwrap<ReviewHistoryItem[]>(
        http.get('/research/opportunity-reviews', { params: { limit } }),
      ),
    announcements: (params?: { days?: number; limit?: number }) =>
      unwrap<ResearchAnnouncementItem[]>(
        http.get('/research/announcements', { params, timeout: 30000 }),
      ),
    announcementContent: (artCode: string) =>
      unwrap<{ text: string | null }>(
        http.get('/research/announcement-content', { params: { artCode }, timeout: 30000 }),
      ),
  },

  // 选股引擎（原生多因子三层漏斗）
  screener: {
    status: () =>
      unwrap<{
        engines: ScreenEngineInfo[];
        defaultEngine: string;
        strategies: ScreenStrategy[];
        defaultStrategyId: string;
        defaultTopN: number;
        recentRuns: ScreenRun[];
        nlStrategies: ScreenNlStrategy[];
      }>(http.get('/screener/status', { timeout: 20000 })),
    saveConfig: (body: { strategyId?: string; topN?: number }) =>
      unwrap<{ strategyId: string; topN: number }>(http.put('/screener/config', body)),
    runs: (limit?: number) =>
      unwrap<ScreenRun[]>(http.get('/screener/runs', { params: { limit } })),
    run: (id: string) =>
      unwrap<ScreenRunDetail>(http.get(`/screener/runs/${id}`, { timeout: 20000 })),
    screen: (body: {
      engine?: string;
      strategyId?: string;
      context?: string;
      topN?: number;
      useLlm?: boolean;
    }) => unwrap<ScreenRunDetail>(http.post('/screener/run', body, { timeout: 300000 })),
    evalRun: (id: string) =>
      unwrap<{ updated: number; detail: ScreenRunDetail | null }>(
        http.post(`/screener/runs/${id}/eval`, {}, { timeout: 120000 }),
      ),
  },

  // ETF 模块（跟踪池 + 确定性买卖信号）
  etf: {
    status: () => unwrap<EtfStatus>(http.get('/etf/status', { timeout: 20000 })),
    pool: () => unwrap<EtfPoolItem[]>(http.get('/etf/pool')),
    addPool: (body: { code: string; tags?: string; note?: string }) =>
      unwrap<EtfPoolItem[]>(http.post('/etf/pool', body, { timeout: 20000 })),
    updatePool: (code: string, body: { tags?: string; note?: string }) =>
      unwrap<EtfPoolItem[]>(http.put(`/etf/pool/${code}`, body)),
    removePool: (code: string) => unwrap<EtfPoolItem[]>(http.delete(`/etf/pool/${code}`)),
    signals: () => unwrap<EtfSignalsResult>(http.get('/etf/signals', { timeout: 60000 })),
    analyze: () =>
      unwrap<{ runId: string; status: string; text: string }>(
        http.post('/etf/analyze', {}, { timeout: 300000 }),
      ),
    overview: () => unwrap<EtfOverview>(http.get('/etf/overview', { timeout: 30000 })),
    modules: () => unwrap<HomeModule[]>(http.get('/etf/modules')),
    updateModules: (patch: Record<string, boolean>) =>
      unwrap<HomeModule[]>(http.put('/etf/modules', patch)),
    review: () =>
      unwrap<{ runId: string; status: string; text: string }>(
        http.post('/etf/review', {}, { timeout: 300000 }),
      ),
  },

  // 中线雷达（行业强弱 + 持仓趋势 + 候选池，确定性只读）
  radar: {
    overview: () => unwrap<RadarOverview>(http.get('/radar/overview', { timeout: 60000 })),
    // 持仓趋势跟随（对真实持仓算 MA60 趋势 + 跟随建议，确定性只读）
    positionTrends: () =>
      unwrap<PositionTrend[]>(http.get('/radar/position-trends', { timeout: 60000 })),
  },

  // M1 ETF 行业轮动（确定性轮动榜 + agent 过滤研判）
  rotation: {
    overview: () => unwrap<EtfRotationOverview>(http.get('/rotation/overview', { timeout: 60000 })),
    // M2 中线下钻：强赛道 ETF → 成分股 universe → 中线龙头选股（默认纯量化，不调 LLM）
    drilldown: (body?: { topEtf?: number; pickTopN?: number; context?: string; useLlm?: boolean }) =>
      unwrap<MidDrilldownResult>(http.post('/rotation/drilldown', body ?? {}, { timeout: 120000 })),
    reviews: (limit?: number) =>
      unwrap<ReviewHistoryItem[]>(http.get('/rotation/reviews', { params: { limit } })),
    review: () =>
      unwrap<{ runId: string; status: string; text: string }>(
        http.post('/rotation/review', {}, { timeout: 420000 }),
      ),
  },

  // S1 市场情绪周期（确定性 0-100 情绪指数 + 周期阶段 + 历史趋势）
  sentiment: {
    overview: () =>
      unwrap<SentimentOverview>(http.get('/sentiment/overview', { timeout: 60000 })),
    history: (limit?: number) =>
      unwrap<SentimentHistoryItem[]>(http.get('/sentiment/history', { params: { limit } })),
  },

  // 板块新高宽度主线识别（确定性：各板块创新高个股数横向排名 + 持续性判主线）
  breadth: {
    overview: () =>
      unwrap<BoardBreadthOverview>(http.get('/breadth/overview', { timeout: 120000 })),
    history: (code: string, limit?: number) =>
      unwrap<BoardBreadthHistoryItem[]>(
        http.get('/breadth/history', { params: { code, limit } }),
      ),
    // 主线共识（决策层：breadth 锚 ⋈ themes ⋈ radar 三方对齐）
    consensus: () =>
      unwrap<MainlineConsensus>(http.get('/breadth/consensus', { timeout: 120000 })),
  },

  // 热门细分概念（同花顺概念资金流近N日：涨幅 + 资金净额 合成热度分 + 主线主题归纳；点击概念经问财展开成分股）
  concepts: {
    hot: (window?: ConceptWindow) =>
      unwrap<HotConceptOverview>(http.get('/concepts/hot', { params: { window }, timeout: 60000 })),
    stocks: (name: string) =>
      unwrap<ConceptStocksResult>(
        http.get('/concepts/stocks', { params: { name }, timeout: 60000 }),
      ),
  },

  // S6 龙头/连板梯队（确定性连板梯队 + 龙头辨识分层）
  dragon: {
    overview: () => unwrap<DragonOverview>(http.get('/dragon/overview', { timeout: 60000 })),
  },

  // S7 资金面（个股龙虎榜净额趋势 + 最近一次席位拆分）
  capital: {
    stock: (code: string) =>
      unwrap<StockCapitalDetail>(http.get(`/capital/stock/${code}`, { timeout: 60000 })),
  },

  // S9 技术指标库（个股 MACD/KDJ/RSI/BOLL 读数）
  stockIndicators: (code: string) =>
    unwrap<StockIndicators>(http.get(`/stock/${code}/indicators`, { timeout: 30000 })),

  // S8 筹码分布（个股获利比例/成本区间/集中度）
  stockChips: (code: string) =>
    unwrap<StockChipDistribution>(http.get(`/stock/${code}/chips`, { timeout: 30000 })),

  // 数据源中心（统一管理外部取数：健康/配置/启停/统计）
  datasource: {
    list: () => unwrap<DataSourceInfo[]>(http.get('/datasource/list', { timeout: 20000 })),
    stats: () => unwrap<Record<string, DataSourceStats>>(http.get('/datasource/stats')),
    routes: () => unwrap<DataSourceRoute[]>(http.get('/datasource/routes')),
    health: (id: string) =>
      unwrap<DataSourceHealth>(http.post(`/datasource/${id}/health`, {}, { timeout: 30000 })),
    toggle: (id: string, enabled: boolean) =>
      unwrap<DataSourceInfo>(http.post(`/datasource/${id}/toggle`, { enabled })),
    config: (id: string, patch: DataSourceConfigUpdate) =>
      unwrap<DataSourceInfo>(http.put(`/datasource/${id}/config`, patch)),
  },

  // Agent 工具管理（罗列 / 启停 / 描述覆盖）
  tools: {
    list: () => unwrap<ToolInfo[]>(http.get('/tools', { timeout: 20000 })),
    config: (name: string, patch: ToolConfigUpdate) =>
      unwrap<ToolInfo>(http.put(`/tools/${name}`, patch)),
  },

  // Agent 提示词管理（全局提示词罗列 / 覆盖）
  prompts: {
    list: () => unwrap<PromptInfo[]>(http.get('/prompts', { timeout: 20000 })),
    config: (key: string, patch: PromptConfigUpdate) =>
      unwrap<PromptInfo>(http.put(`/prompts/${key}`, patch)),
  },

  // 调度总览（聚合中央任务 + 模块定时的只读视图）
  schedules: {
    list: () => unwrap<ScheduleOverviewItem[]>(http.get('/schedules', { timeout: 20000 })),
  },

  // 安全控制台（交易/模拟总闸：kill switch + 自动开关）
  safety: {
    state: () => unwrap<SafetyState>(http.get('/safety/state', { timeout: 20000 })),
    update: (patch: SafetyUpdate) => unwrap<SafetyState>(http.put('/safety/state', patch)),
    kill: (reason?: string) => unwrap<SafetyState>(http.post('/safety/kill', { reason })),
    resume: () => unwrap<SafetyState>(http.post('/safety/resume')),
  },

  // 驾驶舱（一屏概览 + 跨模块事件时间线，纯只读聚合）
  cockpit: {
    overview: () => unwrap<CockpitOverview>(http.get('/cockpit/overview', { timeout: 20000 })),
    timeline: (limit = 40) =>
      unwrap<CockpitEvent[]>(http.get('/cockpit/timeline', { params: { limit } })),
  },

  // 运维（SQLite 体积治理：统计 / 保留策略 / 清理 / VACUUM）
  ops: {
    stats: () => unwrap<OpsDbStats>(http.get('/ops/stats', { timeout: 20000 })),
    getRetention: () => unwrap<RetentionConfig>(http.get('/ops/retention')),
    setRetention: (patch: RetentionConfig) =>
      unwrap<RetentionConfig>(http.put('/ops/retention', patch)),
    cleanup: (body?: { table?: string; days?: number }) =>
      unwrap<OpsCleanupResult>(http.post('/ops/cleanup', body ?? {}, { timeout: 60000 })),
    vacuum: () => unwrap<{ dbSizeBytes: number }>(http.post('/ops/vacuum', {}, { timeout: 120000 })),
  },

  // 决策智能体（多 agent 辩论引擎：角色职责覆盖 / 分析师启停 / 引擎全局参数）
  decisionAgents: {
    list: () => unwrap<DecisionEngineOverview>(http.get('/decision/agents', { timeout: 20000 })),
    config: (key: string, patch: DecisionAgentUpdate) =>
      unwrap<DecisionAgentInfo>(http.put(`/decision/agents/${key}`, patch)),
    setEngine: (patch: Partial<DecisionEngineConfig>) =>
      unwrap<DecisionEngineConfig>(http.put('/decision/config', patch)),
    verdicts: (codes?: string[]) =>
      unwrap<DecisionVerdictCache[]>(
        http.get('/decision/verdicts', {
          params: codes && codes.length ? { codes: codes.join(',') } : undefined,
          timeout: 20000,
        }),
      ),
    // 可决策股指白名单（「股指」下拉）
    indices: () => unwrap<DecisionIndexInfo[]>(http.get('/decision/indices', { timeout: 20000 })),
  },

  // 今日计划（作战室）
  plan: {
    today: () => unwrap<DailyPlanDetail | null>(http.get('/plan/today', { timeout: 20000 })),
    fulfillment: () =>
      unwrap<PlanFulfillment | null>(http.get('/plan/fulfillment', { timeout: 20000 })),
    history: (limit = 60) =>
      unwrap<DailyPlanSummary[]>(http.get('/plan/list', { params: { limit }, timeout: 20000 })),
    get: (date: string) =>
      unwrap<DailyPlanDetail | null>(http.get(`/plan/${date}`, { timeout: 20000 })),
    events: (date: string) =>
      unwrap<DailyPlanEvent[]>(http.get(`/plan/${date}/events`, { timeout: 20000 })),
    generate: () =>
      unwrap<{ runId: string; status: string; text: string }>(
        http.post('/plan/generate', {}, { timeout: 600000 }),
      ),
    regenerate: (date: string) =>
      unwrap<{ runId: string; status: string; text: string }>(
        http.post(`/plan/${date}/regenerate`, {}, { timeout: 600000 }),
      ),
    reevaluate: () =>
      unwrap<{ runId: string; status: string; text: string }>(
        http.post('/plan/reevaluate', {}, { timeout: 600000 }),
      ),
    // 一键计划：后台串行刷新六源 + 生成计划，立即返回初始态，前端轮询 oneclickStatus 跟进
    oneclickStart: () =>
      unwrap<OneClickRunState>(http.post('/plan/oneclick', {}, { timeout: 20000 })),
    oneclickStatus: () =>
      unwrap<OneClickRunState>(http.get('/plan/oneclick', { timeout: 20000 })),
  },

  // 模块内定时（各模块自管，module 为 API 前缀：trendradar/review/research/market）
  moduleSchedules: {
    list: (module: string) =>
      unwrap<ModuleScheduleJob[]>(http.get(`/${module}/schedules`)),
    update: (module: string, id: string, patch: ModuleScheduleUpdate) =>
      unwrap<ModuleScheduleJob>(http.put(`/${module}/schedules/${id}`, patch)),
    trigger: (module: string, id: string) =>
      unwrap<void>(http.post(`/${module}/schedules/${id}/trigger`)),
  },

  // 聊天
  listSessions: () => unwrap<ChatSession[]>(http.get('/chat/sessions')),
  createSession: () => unwrap<ChatSession>(http.post('/chat/sessions')),
  deleteSession: (id: string) => unwrap<void>(http.delete(`/chat/sessions/${id}`)),
  listMessages: (id: string) =>
    unwrap<ChatMessage[]>(http.get(`/chat/sessions/${id}/messages`)),
};

/** 建立 WebSocket 连接（自动适配协议与主机，附带访问 token） */
export function openWs(path: string): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = getToken();
  const sep = path.includes('?') ? '&' : '?';
  const suffix = token ? `${sep}token=${encodeURIComponent(token)}` : '';
  return new WebSocket(`${proto}://${location.host}${path}${suffix}`);
}
