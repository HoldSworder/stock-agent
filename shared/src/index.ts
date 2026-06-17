// 前后端共享的 DTO 类型定义。
// 后端 (Fastify) 与前端 (Vue) 都从这里导入，保证接口契约一致。

export type RunTrigger = 'cron' | 'manual' | 'chat' | 'watch';
export type RunStatus = 'running' | 'success' | 'error' | 'timeout' | 'canceled';
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type NotifyChannel = 'webui' | 'telegram';

/** 单个 agent 运行时的模型配置覆盖项 */
export interface ModelConfig {
  /** 留空则使用全局设置中的模型 */
  model?: string;
  temperature?: number;
  /** 推理开关，迁移自 openclaw 的 thinking=off 约定，默认关闭 */
  thinking?: boolean;
  /** 单次运行最大 agent 循环步数（工具调用轮次） */
  maxSteps?: number;
  /** 单次回复最大输出 token；留空使用模型默认（用于长结构化输出避免截断） */
  maxTokens?: number;
  /** 模型上下文窗口（token）；留空回退设置项 llmContextWindow 或内置默认，用于自动压缩预算 */
  contextWindow?: number;
}

/** 定时任务 / 可执行任务定义 */
export interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  /** 标准 5/6 段 cron 表达式；为空表示仅手动触发 */
  cronExpr?: string | null;
  tz: string;
  /** 驱动 agent 的指令 prompt */
  prompt: string;
  modelConfig: ModelConfig;
  notifyChannels: NotifyChannel[];
  /** 运行超时（秒） */
  timeoutSec: number;
  enabled: boolean;
  /** 绑定的战法 id（可空，仅战法模拟任务有值） */
  strategyId?: string | null;
  createdAt: string;
  updatedAt: string;
  /** 下次触发时间（仅查询时返回，非持久字段） */
  nextRunAt?: string | null;
}

export type ScheduledTaskInput = Omit<
  ScheduledTask,
  'id' | 'createdAt' | 'updatedAt' | 'nextRunAt'
>;

/** 一次运行记录 */
export interface TaskRun {
  id: string;
  taskId: string | null;
  taskName: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  inputPrompt: string;
  outputText: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  error: string | null;
}

/** 运行轨迹中的一条消息（完整记录，用于复盘） */
export interface RunMessage {
  id: string;
  runId: string;
  seq: number;
  role: MessageRole;
  content: string | null;
  /** assistant 发起的工具调用，JSON 字符串 */
  toolCalls: string | null;
  /** tool 角色返回的工具名 */
  toolName: string | null;
  createdAt: string;
}

/** 大盘指数 */
export interface MarketIndex {
  code: string;
  name: string;
  /** 点位 */
  point: number;
  /** 涨跌幅 % */
  pct: number;
  /** 东财 secid（市场前缀.代码），用于 K 线（指数 code 与个股撞码，须显式 secid） */
  secid: string;
}

/** 外围关键指数（美股/欧洲/亚太/汇率/债券/加密等），继承大盘指数并补充明细字段 */
export interface GlobalIndex extends MarketIndex {
  /** 区域分组：美股 / 中概 / 欧洲 / 亚太 / 汇率 / 债券 / 加密 */
  group: string;
  /** 涨跌额（缺失为 undefined） */
  change?: number;
  /** 最高 */
  high?: number;
  /** 最低 */
  low?: number;
  /** 开盘 */
  open?: number;
  /** 昨收 */
  prevClose?: number;
  /** 振幅 %（缺失为 undefined） */
  amplitude?: number;
}

/** 期货报价项（国内主力连续 / 国际盘） */
export interface FuturesItem {
  /** 品种名称，如 沪铜主连 / COMEX黄金 */
  name: string;
  /** 合约代码 f57 */
  code: string;
  /** 东财 secid（市场前缀.代码），如 113.cu0 / 101.GC00Y */
  secid: string;
  /** 最新价 */
  price: number;
  /** 涨跌幅 % */
  pct: number;
  /** 分组：有色 / 黑色 / 贵金属 / 能化 / 新能源 / 外盘 */
  group: string;
  /** 国内盘 / 外盘 */
  region: 'domestic' | 'overseas';
}

/** 板块榜单项 */
export interface SectorItem {
  code: string;
  name: string;
  /** 涨跌幅 % */
  pct: number;
  /** 60 日涨跌幅 %（板块级多日强弱，东财 f24；取不到为 null） */
  ret60?: number | null;
  /** 年初至今涨跌幅 %（东财 f25；取不到为 null） */
  ytd?: number | null;
  /** 领涨股名称 */
  leadStock: string;
  /** 领涨股代码 */
  leadStockCode: string;
}

/** 个股榜单项 */
export interface StockRankItem {
  code: string;
  name: string;
  /** 现价 */
  price: number;
  /** 涨跌幅 % */
  pct: number;
  /** 成交额（亿元） */
  amount: number;
}

/** 股票搜索联想候选 */
export interface StockSuggest {
  code: string;
  name: string;
  /** 市场标记，如 SH / SZ */
  market: string;
}

/** K 线周期：日/周/月（东财 klt 101/102/103）+ 分钟级（5/15/30/60/120 分钟） */
export type KlinePeriod = 'day' | 'week' | 'month' | '5m' | '15m' | '30m' | '60m' | '120m';

/** 单根 K 线（前复权） */
export interface KlineBar {
  /** 交易日 YYYY-MM-DD */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 成交量（手） */
  volume: number;
  /** 成交额（元） */
  amount: number;
}

/** 单个分时点（当日 1 分钟级） */
export interface TrendPoint {
  /** 时间 HH:MM */
  time: string;
  /** 现价 */
  price: number;
  /** 均价 */
  avg: number;
  /** 成交量（手） */
  volume: number;
}

/** 当日分时数据（含昨收基线） */
export interface TrendsResult {
  code: string;
  name: string;
  /** 昨收（分时基线） */
  prevClose: number;
  points: TrendPoint[];
}

/** 个股实时报价 */
export interface StockQuote {
  code: string;
  name: string;
  /** 现价 */
  price: number;
  /** 涨跌幅 % */
  pct: number;
  /** 昨收 */
  prevClose: number;
  /** 成交额（亿元） */
  amount: number;
  /** 振幅 %（best-effort，东财 f7，缺失为 undefined） */
  amplitude?: number;
  /** 换手率 %（best-effort，缺失为 undefined） */
  turnoverRate?: number;
  /** 量比（best-effort，缺失为 undefined） */
  volumeRatio?: number;
}

/** 关注标的（持久化条目） */
export interface WatchItem {
  code: string;
  name: string;
  /** 逗号分隔标签 */
  tags: string | null;
  note: string | null;
  addedAt: string;
}

/** 关注标的列表项：持久数据 + 实时报价 */
export interface WatchlistEntry extends WatchItem {
  quote: StockQuote | null;
}

/** 新增关注标的入参 */
export interface WatchlistInput {
  code: string;
  tags?: string;
  note?: string;
}

/** 批量添加关注标的入参（codes 为混合分隔的代码串） */
export interface WatchlistBulkInput {
  codes: string;
  /** 目标分组（写入 tags，逗号分隔） */
  tags?: string;
}

/** 批量添加结果汇总 */
export interface WatchlistBulkResult {
  /** 成功入库的代码 */
  added: string[];
  /** 无效/查无行情的代码 */
  invalid: string[];
}

/** 本系统 → 爱盯盘 单向镜像推送结果 */
export interface IdingpanPushResult {
  /** 镜像写入的受管分组数（按 tags 派生） */
  groups: number;
  /** 镜像写入的标的代码数（去重） */
  codes: number;
  /** 云端新建的备份记录 id（用于在爱盯盘里一键恢复） */
  recordId: string | null;
  /** 操作提示（爱盯盘不会自动应用云快照，需手动恢复） */
  note: string;
}

/** 同花顺自选同步结果汇总 */
export interface WatchlistSyncResult {
  /** 同步的命名分组数（type=0） */
  groups: number;
  /** 新增入库的代码 */
  added: string[];
  /** 移除的代码（同花顺已删且无本地自有分组） */
  removed: string[];
  /** 仅调整分组归属的标的数 */
  regrouped: number;
  /** 跳过的代码（查无行情，如指数/北交所/退市） */
  skipped: string[];
}

/** 板块资金流项 */
export interface SectorMoneyItem {
  code: string;
  name: string;
  /** 涨跌幅 % */
  pct: number;
  /** 主力净流入（亿元，正流入负流出） */
  netInflow: number;
}

/** 两市成交额 */
export interface TurnoverTotal {
  /** 沪市成交额（亿元） */
  shAmount: number;
  /** 深市成交额（亿元） */
  szAmount: number;
  /** 两市合计（亿元） */
  total: number;
  /** 昨日两市合计（亿元，best-effort，可能为 null） */
  prevTotal: number | null;
  /** 较昨变化 %（prevTotal 缺失时为 null） */
  chgPct: number | null;
}

/** 市场情绪温度 */
export interface MarketEmotion {
  /** 涨停数 */
  limitUp: number;
  /** 跌停数 */
  limitDown: number;
  /** 炸板数 */
  brokenBoard: number;
  /** 炸板率 %（炸板/(涨停+炸板)） */
  brokenRate: number;
  /** 最高连板数 */
  maxStreak: number;
}

/** 涨停板梯队中的个股 */
export interface LadderStock {
  code: string;
  name: string;
  /** 所属行业板块 */
  sector: string;
}

/** 涨停板梯队（按连板天数分组） */
export interface LadderTier {
  /** 连板天数（1=首板，2=2连板…） */
  streak: number;
  /** 该梯队个股数 */
  count: number;
  stocks: LadderStock[];
}

// ===== S6 龙头/连板梯队（龙头辨识分层）=====

/** 龙头梯队中的个股角色（A 股短线龙头战法分层） */
export type DragonRole = '总龙头' | '中军' | '弹性';

/** 龙头辨识个股：在连板梯队基础上叠加封板时间/封单/换手等龙头辨识维度 */
export interface DragonStock {
  code: string;
  name: string;
  /** 所属行业板块 */
  sector: string;
  /** 连板天数 */
  streak: number;
  /** 首次封板时间（HH:MM:SS，越早越强；缺失为空串） */
  firstSealTime: string;
  /** 封单额（亿元；缺失为 null） */
  sealFund: number | null;
  /** 换手率 %（缺失为 null） */
  turnoverRate: number | null;
  /** 龙头分 0-100（封板早/封单大/连板高/换手活合成） */
  dragonScore: number;
  /** 角色（总龙头/中军/弹性） */
  role: DragonRole;
}

/** 龙头梯队总览（连板梯队 + 龙头分层 + 情绪统计） */
export interface DragonOverview {
  asOf: string;
  /** 最高连板高度 */
  maxStreak: number;
  /** 涨停总数 */
  limitUpCount: number;
  /** 炸板率 % */
  brokenRate: number;
  /** 全场总龙头（龙头分最高者，可能为 null） */
  topDragon: DragonStock | null;
  /** 按连板天数分组的龙头梯队（高板→首板） */
  tiers: Array<{
    streak: number;
    count: number;
    stocks: DragonStock[];
  }>;
  /** 是否走了降级/缓存 */
  stale?: boolean;
  note: string;
}

/** S7 资金面：龙虎榜席位类型（按营业部名识别游资/机构/北向） */
export type CapitalSeatTag = '游资' | '机构' | '北向' | '其他';

/** S7 资金面：单个龙虎榜席位（买入/卖出金额，单位万元） */
export interface CapitalSeat {
  name: string;
  buy: number;
  sell: number;
  net: number;
  tag: CapitalSeatTag;
}

/** S7 资金面：个股最近一次龙虎榜席位拆分（买卖前 N 席位 + 游资/机构/北向识别） */
export interface DragonTigerSeats {
  date: string;
  /** 上榜原因 */
  reason: string;
  /** 买方前 N 席位 */
  buys: CapitalSeat[];
  /** 卖方前 N 席位 */
  sells: CapitalSeat[];
}

/** S7 资金面：个股单次龙虎榜上榜净额（净额趋势用，单位万元） */
export interface DragonTigerEntry {
  date: string;
  /** 当日涨跌幅 % */
  pct: number;
  /** 龙虎榜净买入（万元，正为净买） */
  net: number;
  /** 换手率 % */
  turnover: number;
  /** 上榜原因 */
  reason: string;
}

/** S7 资金面：个股龙虎榜资金面深挖（净额趋势 + 最近一次席位拆分），喂游资分析师 / KlineDialog 资金面 Tab */
export interface StockCapitalDetail {
  code: string;
  name: string;
  asOf: string;
  /** 近 N 次上榜净额趋势（东财，新→旧） */
  recent: DragonTigerEntry[];
  /** 最近一次龙虎榜席位拆分（akshare；无上榜或不可用为 null） */
  seats: DragonTigerSeats | null;
  note: string;
}

/** S9 技术指标库：MACD 读数（CN 口径：DIF/DEA/MACD 柱） */
export interface MacdReadout {
  /** 快线 DIF（短期 EMA - 长期 EMA） */
  dif: number;
  /** 慢线 DEA（DIF 的信号 EMA） */
  dea: number;
  /** MACD 柱（(DIF-DEA)×2，CN 习惯） */
  bar: number;
  /** 形态：金叉/死叉（当根穿越）｜多头/空头（DIF 在 DEA 上/下，未穿越） */
  state: '金叉' | '死叉' | '多头' | '空头';
}

/** S9 技术指标库：KDJ 读数 */
export interface KdjReadout {
  k: number;
  d: number;
  j: number;
  /** 超买(K>80)/超卖(K<20)/中性 */
  signal: '超买' | '超卖' | '中性';
}

/** S9 技术指标库：RSI 读数（6/12/24） */
export interface RsiReadout {
  rsi6: number;
  rsi12: number;
  rsi24: number;
  /** 以 RSI6 判：超买(>80)/超卖(<20)/中性 */
  signal: '超买' | '超卖' | '中性';
}

/** S9 技术指标库：BOLL 读数（布林带 20,2） */
export interface BollReadout {
  upper: number;
  mid: number;
  lower: number;
  /** %B =(收-下轨)/(上轨-下轨)，>1 破上轨、<0 破下轨 */
  pctB: number;
  /** 价格相对带位置 */
  pos: '上轨上方' | '中上轨' | '中下轨' | '下轨下方';
}

/** S9 技术指标库：个股技术指标快照（日线 MACD/KDJ/RSI/BOLL + 读数），喂技术分析师 / KlineDialog 副图读数条 */
export interface StockIndicators {
  code: string;
  asOf: string;
  /** 最新收盘 */
  close: number;
  /** K 线周期（默认日线 day） */
  period: KlinePeriod;
  macd: MacdReadout | null;
  kdj: KdjReadout | null;
  rsi: RsiReadout | null;
  boll: BollReadout | null;
  note: string;
}

/** S8 筹码分布：单日筹码快照（东财 stock_cyq_em，比例字段为 0-1） */
export interface ChipSnapshot {
  date: string;
  /** 获利比例（0-1，当前价上方持仓占比） */
  profitRatio: number;
  /** 平均成本 */
  avgCost: number;
  cost90Low: number;
  cost90High: number;
  /** 90 集中度（0-1，越小越集中=锁筹） */
  concentration90: number;
  cost70Low: number;
  cost70High: number;
  concentration70: number;
}

/** S8 筹码分布：个股筹码分布（最新快照 + 近 N 日趋势），喂技术分析师 / KlineDialog 筹码 Tab */
export interface StockChipDistribution {
  code: string;
  asOf: string;
  /** 最新一日筹码快照（不可用为 null） */
  latest: ChipSnapshot | null;
  /** 近 N 日趋势（新→旧），用于判断获利盘变化与筹码集中/发散 */
  recent: ChipSnapshot[];
  note: string;
}

/** 大盘看盘总览（各块可选，分块容错；某块失败为 null） */
export interface MarketOverview {
  /** 数据时间 ISO */
  asOf: string;
  indices: MarketIndex[];
  /** 外围关键指数（美股/欧洲/亚太/汇率/债券/加密），分块容错，失败为空数组 */
  globalIndices: GlobalIndex[];
  /** 期货价格（国内主力连续 + 外盘商品），分块容错，失败为空数组 */
  futures: FuturesItem[];
  turnoverTotal: TurnoverTotal | null;
  emotion: MarketEmotion | null;
  ladder: LadderTier[] | null;
  hotIndustries: SectorItem[];
  hotConcepts: SectorItem[];
  moneyInflow: SectorMoneyItem[] | null;
  moneyOutflow: SectorMoneyItem[] | null;
  loserSectors: SectorItem[] | null;
  topLosers: StockRankItem[] | null;
  topTurnover: StockRankItem[];
  /** 本次是否有区块走了 stale 缓存（上游失败时回退上次成功数据） */
  stale?: boolean;
  /** 最近一次「全部区块均新鲜」的时间 ISO，stale 时用于提示缓存时效 */
  dataAsOf?: string;
}

/** 首页模块显隐配置项 */
export interface HomeModule {
  id: string;
  label: string;
  enabled: boolean;
}

// ===== 模块内定时（各模块自管的轻量定时项，不进 scheduled_tasks/任务页）=====

/** 单个模块定时项视图（GET /api/<module>/schedules 返回） */
export interface ModuleScheduleJob {
  id: string;
  label: string;
  cronExpr: string;
  enabled: boolean;
  /** 工作日命中法定节假日跳过 */
  skipHoliday: boolean;
  /** 下次运行时间（ISO），未启用或解析失败为 null */
  nextRunAt: string | null;
  /** 最近一次成功执行时间（ISO），无则 null */
  lastSuccessAt: string | null;
}

/** 更新模块定时项的入参 */
export interface ModuleScheduleUpdate {
  cronExpr?: string;
  enabled?: boolean;
}

// ===== 复盘（AI 结构化复盘结果）=====

/** 当前主线题材判断项 */
export interface ReviewMainTheme {
  /** 主线题材名称 */
  name: string;
  /** 强度描述，如「主线/分歧/退潮/启动」 */
  strength: string;
  /** 判断依据 */
  reason: string;
  /** 对照共享主线清单给出的验证结论（延续/加速/分歧/退潮/证伪），用于结构化回流 themes */
  verdict?: ThemeVerdict;
}

/** 复盘中的热门板块/概念项 */
export interface ReviewSector {
  name: string;
  /** 板块类型 */
  kind: '行业' | '概念';
  /** 点评 */
  note: string;
}

/** 复盘中的热门个股项 */
export interface ReviewStock {
  code: string;
  name: string;
  /** 点评（异动原因、所属主线等） */
  note: string;
}

/** 复盘中的妙想强势板块项 */
export interface ReviewStrongSector {
  name: string;
  /** 推荐原因 */
  reason: string;
  /** 领涨个股（可选） */
  leader?: string;
}

/** 复盘中的妙想强势个股项 */
export interface ReviewStrongStock {
  code: string;
  name: string;
  /** 推荐原因 */
  reason: string;
}

/** 复盘中的单只持仓点评 */
export interface ReviewPosition {
  code: string;
  name: string;
  /** 今日表现点评 */
  todayNote: string;
  /** 去留建议 */
  action: '持有' | '加仓' | '减仓' | '清仓' | '观望';
}

/** 情绪周期定位 */
export interface ReviewEmotionCycle {
  /** 周期阶段 */
  phase: '启动' | '发酵' | '高潮' | '退潮' | '冰点';
  /** 赚钱/亏钱效应描述 */
  moneyEffect: string;
  /** 判断依据 */
  note: string;
}

/** 资金面深度复盘（各项为自然语言描述，缺数据时注明不可得） */
export interface ReviewCapitalFlow {
  /** 北向资金 */
  northbound: string;
  /** 主力资金 */
  mainForce: string;
  /** 两融 */
  margin: string;
  /** 量能（放缩量） */
  volume: string;
  /** 风格切换（大小盘/价值成长） */
  styleNote: string;
}

/** 连板梯队质量复盘 */
export interface ReviewLadderQuality {
  /** 晋级率 */
  promotionRate: string;
  /** 炸板率 */
  brokenRate: string;
  /** 最高板高度 */
  maxHeight: string;
  /** 高度板分歧 */
  divergence: string;
  /** 涨停溢价率（昨日涨停个股今日平均溢价，情绪温度计核心指标） */
  limitUpPremium?: string;
}

/** 龙虎榜资金动向项（机构席位 / 知名游资净买入） */
export interface ReviewDragonTiger {
  code: string;
  name: string;
  /** 净买入额（自然语言描述，如「机构净买入1.2亿」） */
  netBuy: string;
  /** 点评（席位性质、合力判断等） */
  note: string;
}

/** 情绪标杆项（次日盯盘锚点：弱转强/强转弱/空间龙/主线龙头） */
export interface ReviewSentimentBenchmark {
  /** 标杆类型 */
  type: '弱转强' | '强转弱' | '空间龙' | '主线龙头';
  code: string;
  name: string;
  /** 走势反馈点评（正/负反馈、封单、承接等） */
  note: string;
}

/** 我的今日操作复盘 */
export interface ReviewMyTrade {
  code: string;
  name: string;
  /** 操作评估 */
  assessment: string;
  /** 结论 */
  verdict: '正确' | '失误' | '中性' | '待观察';
}

/** 自选股池复盘 */
export interface ReviewWatch {
  code: string;
  name: string;
  /** 强弱定性 */
  strength: string;
  /** 点评 */
  note: string;
}

/** 风险警示项 */
export interface ReviewRisk {
  title: string;
  detail: string;
}

/** 明日策略与计划 */
export interface ReviewTomorrowPlan {
  /** 重点关注 */
  focus: string[];
  /** 应对预案 */
  contingency: string[];
  /** 仓位建议 */
  positionAdvice: string;
}

/** 与近日对比 */
export interface ReviewTrendComparison {
  /** 主线延续 vs 切换 */
  mainlineContinuity: string;
  /** 情绪趋势 */
  emotionTrend: string;
  /** 综合说明 */
  note: string;
}

/** 外围市场综述（单个市场/指数对 A 股的影响） */
export interface ReviewOverseas {
  /** 市场/指数名称，如 纳斯达克 / 恒生指数 */
  name: string;
  /** 区域，如 美股 / 亚太 / 汇率 */
  region: string;
  /** 走势定性 */
  trend: string;
  /** 对 A 股的影响 */
  impact: string;
}

/** A 股 + 外围综合方向判断（喂给今日计划作为大环境趋势基准） */
export interface ReviewComprehensiveStance {
  /** 综合方向 */
  bias: '偏多' | '中性' | '偏空';
  /** 一句话综合定调 */
  summary: string;
  /** 关键驱动因素 */
  drivers: string[];
}

/** AI 复盘结构化结果（agent 输出契约，前端据此模块化渲染） */
export interface MarketReviewResult {
  /** 大盘走势综述 */
  marketTrend: string;
  /** 情绪/连板高度/资金面综述 */
  emotionNote: string;
  /** 情绪周期定位 */
  emotionCycle?: ReviewEmotionCycle | null;
  /** 资金面深度 */
  capitalFlow?: ReviewCapitalFlow | null;
  /** 连板梯队质量 */
  ladderQuality?: ReviewLadderQuality | null;
  /** 龙虎榜资金动向（机构/游资净买入，资金合力判断） */
  dragonTiger: ReviewDragonTiger[];
  /** 情绪标杆（次日盯盘锚点） */
  sentimentBenchmark: ReviewSentimentBenchmark[];
  /** 当前主线题材判断（可多条，按强度排序） */
  mainThemes: ReviewMainTheme[];
  /** 热门板块/细分概念梳理 */
  hotSectors: ReviewSector[];
  /** 热门个股梳理 */
  hotStocks: ReviewStock[];
  /** 妙想强势板块（确定性取数 + AI 归纳推荐原因） */
  strongSectors: ReviewStrongSector[];
  /** 妙想强势个股（确定性取数 + AI 归纳推荐原因） */
  strongStocks: ReviewStrongStock[];
  /** 逐只持仓复盘 */
  positionsReview: ReviewPosition[];
  /** 我的今日操作复盘 */
  myTradesReview: ReviewMyTrade[];
  /** 自选股池复盘 */
  watchlistReview: ReviewWatch[];
  /** 风险警示 */
  risks: ReviewRisk[];
  /** 明日策略与计划 */
  tomorrowPlan?: ReviewTomorrowPlan | null;
  /** 与近日对比 */
  trendComparison?: ReviewTrendComparison | null;
  /** 外围市场综述与对 A 股影响 */
  overseasMarkets?: ReviewOverseas[] | null;
  /** A 股 + 外围综合方向判断 */
  comprehensiveStance?: ReviewComprehensiveStance | null;
  /** 操作建议 / 明日策略 */
  suggestions: string[];
}

/** 复盘历史条目（来自一次成功的「一键复盘」运行） */
export interface ReviewHistoryItem {
  /** 运行 id */
  id: string;
  /** 复盘生成时间 ISO */
  createdAt: string;
  /** 结构化 JSON 输出原文（前端解析为 MarketReviewResult） */
  outputText: string | null;
}

/** AI 分析能力分组（驾驶舱 AI 分析中心按此分组展示卡片） */
export type AiAnalysisGroup =
  | '复盘'
  | '大盘'
  | '板块主线'
  | 'ETF'
  | '研报'
  | '热点'
  | '情报'
  | '持仓'
  | '决策';

/** 统一 AI 分析中心的能力目录条目（GET /api/analyses） */
export interface AiAnalysisKindInfo {
  /** 分析类型（对应后端注册 kind） */
  kind: string;
  /** 卡片标题 */
  title: string;
  /** 分组 */
  group: AiAnalysisGroup;
  /** 作用域：global 可一键发起；perStock 需个股，中心仅展示历史 + 引导去对应页 */
  scope: 'global' | 'perStock';
  /** 最新一条结论时间（ISO），无则 null */
  latestAt: string | null;
  /** 最新一条结论摘要，无则 null */
  latestSnippet: string | null;
  /** 底层模块定时所属模块前缀（无定时则 null），用于定时调度写操作分流 */
  scheduleModule: string | null;
  /** 底层模块定时 job id（无定时则 null），与 /api/schedules 的 id 对齐 */
  scheduleId: string | null;
}

/** 公共 AI 分析历史条目（通用弹窗各 kind 共用，仅最终正文） */
export interface AiAnalysisHistoryItem {
  id: string;
  /** 分析类型，如 real-positions */
  kind: string;
  /** 历史作用域键（如股票代码），全局类为 null */
  refKey: string | null;
  /** 展示标题 */
  title: string | null;
  /** 最终分析正文（Markdown） */
  content: string;
  createdAt: string;
}

// ===== 多智能体辩论决策（Decision Engine）类型 =====

/** 决策动作：买入 / 加仓 / 持有 / 减仓 / 卖出 */
export type DecisionAction = 'buy' | 'add' | 'hold' | 'reduce' | 'sell';

/** 单个分析师的聚焦短报告 */
export interface DecisionAnalystReport {
  /** 分析师角色名（如「基本面分析师」） */
  role: string;
  /** 多空倾向定性（偏多/偏空/中性） */
  stance: string;
  /** 该维度要点（精炼） */
  summary: string;
}

/** Trader 阶段产出的可执行方案（经 A 股硬约束校验后标注） */
export interface DecisionTraderPlan {
  /** 拟操作方向 */
  side: 'buy' | 'sell' | 'hold';
  /** 拟操作股数（已向下取整到 100 整数倍） */
  qty: number;
  /** 拟操作价位（元，可空表示市价/未定） */
  price?: number | null;
  /** A 股约束校验提示（涨跌停/手数取整/T+1 等），无问题为空数组 */
  warnings: string[];
  /** 方案说明 */
  note: string;
}

/** 三方风险辩论结果 */
export interface DecisionRiskDebate {
  /** 激进风格观点 */
  aggressive: string;
  /** 中立风格观点 */
  neutral: string;
  /** 保守风格观点 */
  conservative: string;
  /** 风控组长裁决 */
  verdict: string;
}

/** 多智能体辩论决策结果（固定 pipeline 产出契约，前后端共用） */
export interface DecisionResult {
  /** 6 位代码 */
  code: string;
  /** 标的名称（尽力解析，缺省回退代码） */
  name: string;
  /** 最终操作建议 */
  action: DecisionAction;
  /** 置信度 0-100 */
  confidence: number;
  /** 目标价（元，可空） */
  targetPrice?: number | null;
  /** 止损价（元，可空） */
  stopLoss?: number | null;
  /** 建议仓位 %（0-100，可空） */
  positionPct?: number | null;
  /** 核心持有/操作逻辑 */
  thesis: string;
  /** 关键风险清单 */
  keyRisks: string[];
  /** 分析师层各维度报告 */
  analystReports: DecisionAnalystReport[];
  /** 多头主张 */
  bullView: string;
  /** 空头主张 */
  bearView: string;
  /** 研究总监辩论裁决 */
  judgeView: string;
  /** Trader 可执行方案（经 A 股硬约束校验） */
  traderPlan?: DecisionTraderPlan | null;
  /** 三方风险辩论（未启用风控层时为 null） */
  riskDebate?: DecisionRiskDebate | null;
  /** 本次引用的历史决策教训（注入提示的记忆片段） */
  memoryUsed?: string[];
  /** 供人阅读/落历史的完整 Markdown 叙述 */
  narrative: string;
}

/** 决策场景：不同调用来源走独立缓存，避免串用 */
export type DecisionScenario = 'manual' | 'plan' | 'sellcheck' | 'watch';

/** 持有视角：短线 / 中线（贯穿 screener/decision/watch/strategy 四模块的周期挡位） */
export type Horizon = 'short' | 'mid';

/** 持有视角：短线 / 中线（decision 历史命名，等价 Horizon） */
export type DecisionHorizon = Horizon;

/**
 * 决策裁决缓存条目（结构化、可校验）。交易判断只认本结构，
 * 过期(expiresAt)、场景/视角不一致、或 invalidators 命中即视为失效须重跑；
 * 不再用 ai_analyses markdown latest 当交易缓存。
 */
export interface DecisionVerdictCache {
  code: string;
  name: string;
  scenario: DecisionScenario;
  horizon: DecisionHorizon;
  action: DecisionAction;
  confidence: number;
  /** 数据基准时刻 ISO */
  dataAsOf: string;
  /** 过期时刻 ISO */
  expiresAt: string;
  /** 输入指纹（场景+context+引擎配置） */
  inputHash: string;
  /** 失效条件清单（人读 + 价格越界判定锚点，如「现价跌破止损 X / 升破目标 Y」） */
  invalidators: string[];
  /** 完整决策结果快照 */
  result: DecisionResult;
  /** 是否仍然有效（读取时按当前时刻/可选现价判定） */
  fresh: boolean;
  createdAt: string;
  updatedAt: string;
}

// ===== 中线主线雷达（行业强弱 + 持仓趋势 + 候选池，确定性只读） =====

/** 趋势状态：多头排列 / 趋势向上 / 震荡 / 走弱 */
export type TrendState = 'multi_long' | 'up' | 'range' | 'down';

/** 趋势指标快照（复用 ETF 确定性指标层口径） */
export interface TrendMetrics {
  price: number | null;
  ma20: number | null;
  ma60: number | null;
  ma250: number | null;
  /** 年线（MA250）偏离 % */
  maDeviation: number | null;
  /** 价格分位 0-100 */
  pricePercentile: number | null;
  ret20: number | null;
  ret60: number | null;
  /** 动量打分（0.4*ret20+0.6*ret60） */
  momentum: number | null;
  volatility: number | null;
}

/** 评分构成项（前端拆解展示：基分/各项贡献，value 为对总分的贡献，可正可负） */
export interface ScorePart {
  label: string;
  value: number;
}

/** 强度评分拆解（合计 = 各 part 之和后裁剪到 0-100） */
export interface StrengthBreakdown {
  total: number;
  parts: ScorePart[];
}

/** 行业强弱（按趋势 + 动量综合排序） */
export interface IndustryStrength {
  /** 东财板块代码 BKxxxx */
  code: string;
  name: string;
  /** 板块归类：行业 / 概念（取数面扩到行业+概念后区分展示） */
  boardKind?: 'industry' | 'concept';
  /** 当日涨跌 % */
  pct: number | null;
  leadStock: string;
  leadStockCode: string;
  trend: TrendState;
  /** 综合强度 0-100 */
  strengthScore: number;
  /** 强度评分构成（趋势基分 + 龙头动能 + 板块60日持续 + 年线偏离修正） */
  breakdown: StrengthBreakdown;
  /** 池内动量排名（按龙头动能 + 板块60日融合键，1=最强） */
  momentumRank: number | null;
  /** 板块 60 日涨跌幅 %（板块级真实多日强弱；取不到为 null） */
  ret60?: number | null;
  metrics: TrendMetrics;
  notes: string[];
}

/** 持仓趋势状态（中线视角，趋势跟随建议为研判，不下单） */
export interface PositionTrend {
  code: string;
  name: string;
  trend: TrendState;
  strengthScore: number;
  /** 强度评分构成（基分 + 动量贡献 + 年线偏离修正） */
  breakdown: StrengthBreakdown;
  /** 持有盈亏 % */
  holdRate: number | null;
  /** 仓位 % */
  positionRate: number | null;
  /** 现价距 MA60 %（正=在 MA60 上方） */
  toMa60Pct: number | null;
  metrics: TrendMetrics;
  advice: string;
}

/** 中线候选（来自强势行业龙头或强趋势 ETF） */
export interface MidCandidate {
  code: string;
  name: string;
  kind: 'industry_leader' | 'etf';
  reason: string;
  fromIndustry?: string;
  strengthScore: number;
  /** 强度评分构成（来源行业/ETF 的基分 + 动量贡献等） */
  breakdown: StrengthBreakdown;
}

/** 中线雷达总览（行业强弱 + 持仓趋势 + 候选池） */
export interface RadarOverview {
  asOf: string;
  industries: IndustryStrength[];
  positions: PositionTrend[];
  candidates: MidCandidate[];
  note: string;
}

/** 决策交易记忆条目（反思闭环：记录入场快照 + 复盘后的 Alpha 与教训） */
export interface DecisionMemoryItem {
  id: string;
  code: string;
  name: string;
  /** 决策日 YYYY-MM-DD（Asia/Shanghai） */
  decisionDate: string;
  action: DecisionAction;
  confidence: number;
  /** 决策时入场价快照 */
  entryPrice: number | null;
  targetPrice: number | null;
  stopLoss: number | null;
  positionPct: number | null;
  thesis: string;
  /** pending 待复盘 / reviewed 已复盘 */
  status: 'pending' | 'reviewed';
  reviewedAt: string | null;
  /** 复盘时价格 */
  reviewPrice: number | null;
  /** 个股区间收益率（%） */
  stockReturn: number | null;
  /** 沪深300 区间收益率（%，取数失败为 null） */
  csi300Return: number | null;
  /** 超额收益 Alpha（%） */
  alpha: number | null;
  /** 复盘定性 */
  verdict: '正确' | '失误' | '中性' | null;
  /** 复盘教训（供后续同标的决策注入） */
  lesson: string | null;
  createdAt: string;
}

/** 真实持仓中的单个标的（来源：同花顺投资账本接口，实时报价计算盈亏） */
export interface RealPosition {
  code: string;
  name: string;
  /** 同花顺市场代码（scdm），用于报价接口拼 code，如 1 / 2 */
  market: string;
  /** 持仓股数 */
  qty: number;
  /** 持仓成本价 */
  avgCost: number;
  /** 现价 */
  price: number;
  /** 持有市值 */
  marketValue: number;
  /** 持有盈亏（累计） */
  holdProfit: number;
  /** 持有盈亏率 */
  holdRate: number;
  /** 当日盈亏（已校正为 T 日） */
  todayProfit: number;
  /** 当日盈亏率 */
  todayRate: number;
  /** 仓位占比 */
  positionRate: number;
  /** 持有天数 */
  holdDays: number;
}

/** 真实持仓组合快照 */
/** 场外基金持仓（来自同花顺投资账本 manFund 账户 merge_fund，净值/市值/盈亏均由同花顺给出） */
export interface FundPosition {
  /** 基金代码 */
  code: string;
  /** 基金名称 */
  name: string;
  /** 持有份额（fundcount） */
  shares: number;
  /** 成本净值（每份成本价 percost） */
  costNav: number;
  /** 最新净值（fundnav，盘中为估算、盘后为最新单位净值） */
  nav: number;
  /** 持有市值（fundvalue） */
  marketValue: number;
  /** 持有盈亏（posprofit） */
  holdProfit: number;
  /** 持有盈亏率（pospercent） */
  holdRate: number;
  /** 当日盈亏（now_profit，盘后为 0） */
  todayProfit: number;
  /** 当日涨跌幅（now_rate，盘后为 0） */
  todayRate: number;
  /** 仓位占比 */
  positionRate: number;
  /** 净值是否有效（nav>0） */
  estAvailable: boolean;
  /** 数据同步日期（同花顺 synchro_date） */
  asOf: string;
}

export interface RealPortfolio {
  /** 报价数据时间（ISO，取自同花顺实时报价时间戳） */
  asOf: string;
  /** 数据日期 YYYY-MM-DD（Asia/Shanghai） */
  sourceDate: string;
  /** 数据来源标记 */
  source: string;
  /** 现金余额 */
  cash: number;
  positionCount: number;
  /** 持仓总市值（含股票与场外基金） */
  totalMarketValue: number;
  /** 场外基金市值合计 */
  fundMarketValue: number;
  /** 总资产 = 现金 + 持仓市值（含基金） */
  totalAsset: number;
  /** 累计持有盈亏 */
  totalHoldProfit: number;
  /** 当日盈亏合计 */
  totalTodayProfit: number;
  positions: RealPosition[];
  /** 场外基金持仓（蚂蚁财富等，来自同花顺账本 manFund 账户） */
  funds: FundPosition[];
  /** 当日已清仓标的（qty=0，holdProfit/holdRate 为已实现盈亏；不计入上面的汇总） */
  closedToday: RealPosition[];
}

// ===== 战法模拟（本地纸上交易）=====

/** 战法（策略）—— 独立虚拟账户基础信息 */
/** 战法账户类型：local 本地虚拟盘 / miaoxiang 妙想东财模拟盘镜像 */
export type StrategyKind = 'local' | 'miaoxiang';

export interface Strategy {
  id: string;
  name: string;
  description?: string | null;
  /** 账户类型 */
  kind: StrategyKind;
  /** 初始资金 */
  initialCapital: number;
  /** 当前可用现金 */
  cash: number;
  archived: boolean;
  /** 最近同步时间（仅 miaoxiang 镜像账户） */
  syncedAt?: string | null;
  /** 是否启用 Skill 自迭代（复盘可提案调整选股/买入/卖出打法） */
  skillEnabled: boolean;
  /** 是否纳入自动模拟白名单（默认 false；仍受全局 simAutoEnabled 总闸约束） */
  autoSimEnabled: boolean;
  /** 买入关联的选股链路 id（如 nl；为空表示不关联选股模块） */
  screenEngine?: string | null;
  /** 买入关联的选股预设/策略 id（配合 screenEngine，买入标的来自该口径选出的候选） */
  screenStrategyId?: string | null;
  /** 持有视角：short 短线（默认）/ mid 中线，决定盯盘规则集与卖点档案口径 */
  horizon: Horizon;
  /** 自动建仓时每次取选股 TopN 只数（M4 调仓编排器用） */
  pickTopN?: number | null;
  /** 自动建仓持仓数上限（M4 调仓编排器用） */
  maxPositions?: number | null;
  /** 自动调仓 cron（为空走模块默认调度） */
  rebalanceCron?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 新建/更新战法入参 */
export interface StrategyInput {
  name: string;
  description?: string | null;
  initialCapital: number;
  kind?: StrategyKind;
  /** 是否启用 Skill 自迭代 */
  skillEnabled?: boolean;
  /** 是否纳入自动模拟白名单 */
  autoSimEnabled?: boolean;
  /** 买入关联的选股链路 id（如 nl） */
  screenEngine?: string | null;
  /** 买入关联的选股预设/策略 id */
  screenStrategyId?: string | null;
  /** 持有视角：short 短线（默认）/ mid 中线 */
  horizon?: Horizon;
  /** 自动建仓时每次取选股 TopN 只数 */
  pickTopN?: number | null;
  /** 自动建仓持仓数上限 */
  maxPositions?: number | null;
  /** 自动调仓 cron */
  rebalanceCron?: string | null;
}

/** 战法前向样本（单日权益快照） */
export interface StrategySample {
  strategyId: string;
  sampleDate: string;
  totalAsset: number;
  totalProfitRate: number;
  positionCount: number;
  cash: number;
}

/** 战法前向验证统计（基于样本曲线 + 成交流水，确定性计算） */
export interface StrategyForwardStats {
  strategyId: string;
  /** 首个样本日 */
  sinceDate: string | null;
  /** 样本天数 */
  days: number;
  /** 区间累计收益率（最新样本相对首样本，权益口径） */
  cumReturn: number | null;
  /** 期间最大回撤（权益曲线，负值） */
  maxDrawdown: number | null;
  /** 已实现交易笔数（卖出） */
  closedTrades: number;
  /** 已实现胜率（realizedProfit>0 占卖出比） */
  winRate: number | null;
  /** 沪深300 同期区间收益率（%，权益曲线起点日起算；样本/数据不足为 null） */
  csi300Return: number | null;
  /** 相对沪深300 超额 Alpha（%，cumReturn - csi300Return；任一缺失为 null） */
  alpha: number | null;
  /** 绑定的选股策略 id（战法 screenStrategyId，无则 null） */
  screenStrategyId: string | null;
  /** 绑定的选股策略名（无则 null） */
  screenStrategyName: string | null;
  /** 是否纳入自动模拟白名单 */
  autoSimEnabled: boolean;
  /** 全局自动模拟总闸是否开启 */
  globalAutoEnabled: boolean;
  samples: StrategySample[];
}

// ===== 战法 Skill（打法）自迭代 =====

/** Skill 维度：选股 / 买入 / 卖出 */
export type SkillDimension = 'pick' | 'buy' | 'sell';

/** Skill 状态：生效 / 待确认 / 历史 / 已驳回 */
export type SkillStatus = 'active' | 'pending' | 'archived' | 'rejected';

/** 一条战法 Skill 版本记录 */
export interface StrategySkill {
  id: string;
  strategyId: string;
  dimension: SkillDimension;
  /** 版本号（pending 为 0 占位） */
  version: number;
  content: string;
  status: SkillStatus;
  /** 变更理由 */
  reason: string | null;
  /** 来源运行 id（agent 提案时记录） */
  sourceRunId: string | null;
  createdAt: string;
  /** 审批/驳回时间 */
  decidedAt: string | null;
}

/** 某战法 Skill 的全景视图：三维度当前生效 + 待确认提案 + 历史版本 */
export interface StrategySkillView {
  strategyId: string;
  skillEnabled: boolean;
  /** 各维度当前 active 版本（无则 null） */
  active: Record<SkillDimension, StrategySkill | null>;
  /** 待用户确认的修订提案 */
  proposals: StrategySkill[];
  /** 各维度历史版本（含 active/archived，version desc） */
  history: Record<SkillDimension, StrategySkill[]>;
}

/** 战法持仓（含实时报价计算的市值/浮盈） */
export interface SimPosition {
  code: string;
  name: string;
  qty: number;
  avgCost: number;
  /** 现价（实时报价，取不到时退回成本价） */
  price: number;
  /** 涨跌幅 % */
  pct: number;
  /** 持有市值 */
  marketValue: number;
  /** 浮动盈亏 */
  holdProfit: number;
  /** 浮动盈亏率 */
  holdRate: number;
  /** 仓位占比（市值 / 总资产） */
  positionRate: number;
  /** 当前可卖股数（T+1：扣除当日买入） */
  sellableQty: number;
  /** 持有逻辑（如金属钨涨价；position 级，跨同步留存） */
  thesis?: string | null;
}

/** 战法成交流水 */
export interface SimTrade {
  id: string;
  strategyId: string;
  runId: string | null;
  /** 外部成交单号（妙想 order id，本地下单为 null） */
  extId?: string | null;
  code: string;
  name: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  amount: number;
  /** 卖出已实现盈亏（买入为 null） */
  realizedProfit: number | null;
  reason: string | null;
  /** cron | manual | agent */
  source: string;
  /** 成交日 YYYY-MM-DD */
  tradeDate: string;
  createdAt: string;
}

/** 手动模拟下单入参 */
export interface SimTradeInput {
  side: 'buy' | 'sell';
  code: string;
  qty: number;
  /** 限价（元），缺省用实时现价 */
  price?: number | null;
  reason?: string | null;
  /** 持有逻辑（如金属钨涨价；position 级，跨同步留存） */
  thesis?: string | null;
  /** 强制成交：跳过 A 股交易时段校验（手动下单时可用） */
  force?: boolean;
}

/** 战法完整快照：账户汇总 + 持仓 + 成交流水 */
export interface StrategySnapshot {
  strategy: Strategy;
  /** 数据时间 ISO */
  asOf: string;
  /** 持仓总市值 */
  totalMarketValue: number;
  /** 总资产 = 现金 + 持仓市值 */
  totalAsset: number;
  /** 浮动盈亏合计 */
  totalHoldProfit: number;
  /** 总收益（总资产 - 初始资金） */
  totalProfit: number;
  /** 总收益率（相对初始资金） */
  totalProfitRate: number;
  positions: SimPosition[];
  trades: SimTrade[];
}

/** 战法列表项：基础信息 + 账户汇总 */
export interface StrategyListItem {
  strategy: Strategy;
  totalAsset: number;
  totalProfit: number;
  totalProfitRate: number;
  positionCount: number;
}

/** 聊天会话 */
export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

// ===== TrendRadar 热点雷达模块 =====

/** 热榜话题项（auto_extract 高频词或预设关注词统计） */
export interface TrendTopic {
  /** 话题关键词 */
  keyword: string;
  /** 出现频次 */
  frequency: number;
  /** 命中新闻数 */
  matchedNews: number;
  /** 趋势（rising / falling / stable 等） */
  trend: string;
  /** 加权热度分 */
  weightScore: number;
}

/** 单条热榜新闻 */
export interface TrendNews {
  title: string;
  /** 平台 id，如 baidu / weibo */
  platform: string;
  /** 平台中文名 */
  platformName: string;
  /** 榜单排名 */
  rank: number | null;
  url: string | null;
  /** 抓取时间 */
  timestamp: string | null;
}

/** 单条 RSS 文章 */
export interface TrendRssItem {
  title: string;
  /** RSS 源 id，如 36kr / hacker-news */
  feedId: string;
  /** RSS 源中文名 */
  feedName: string;
  url: string | null;
  /** 发布时间 */
  publishedAt: string | null;
  /** 日期 YYYY-MM-DD */
  date: string | null;
}

/** 单条财经快讯/电报（首选财联社，失败按序降级到同花顺/富途/东财/新浪） */
export interface ClsTelegraph {
  /** 稳定 id（发布时间 + 标题哈希，前端去重/key 用） */
  id: string;
  /** 发布时间（ISO 字符串；解析失败回退原始串） */
  time: string;
  /** 电报标题（部分源无标题则空串） */
  title: string;
  /** 电报正文 */
  content: string;
  /** 涨跌倾向：positive 利好 / negative 利空 / neutral 中性（源无该字段时为 neutral） */
  tag: 'positive' | 'negative' | 'neutral';
  /** 实际来源中文名：财联社/同花顺/富途/东财/新浪（兜底降级时非财联社） */
  source: string;
  /** 是否财联社加红重点（level A/B）；非财联社降级源恒 false */
  important: boolean;
  /** 原文链接（部分源提供） */
  url?: string | null;
}

/** AI 热点研判（按需经本系统自有 LLM 基于 MCP 原始数据现场生成） */
export interface TrendSummary {
  /** 落库记录 id */
  id: string;
  /** daily / weekly */
  reportType: string;
  /** Markdown 报告正文 */
  content: string;
  /** 生成时间（ISO 字符串） */
  createdAt: string;
  /** 本次研判 prompt token 数 */
  promptTokens?: number | null;
  /** 本次研判 completion token 数 */
  completionTokens?: number | null;
}

/** 热点 AI 研判历史列表项 */
export interface TrendSummaryHistoryItem {
  id: string;
  /** daily / weekly */
  reportType: string;
  content: string;
  createdAt: string;
}

/** TrendRadar 系统状态 */
export interface TrendRadarStatus {
  /** 是否已在设置中启用 */
  enabled: boolean;
  /** MCP 是否连通 */
  online: boolean;
  /** 健康状态（healthy 等） */
  health: string | null;
  /** 最新数据日期 */
  latestRecord: string | null;
  /** 数据占用 */
  totalStorage: string | null;
  /** 出错/降级时的原因说明 */
  detail: string | null;
}

/** 研报类型：个股 / 行业 / 策略 / 宏观 / 券商晨报 */
export type ResearchReportType = 'stock' | 'industry' | 'strategy' | 'macro' | 'morning';

/** 单篇研报（东方财富研报中心列表元数据） */
export interface ResearchReport {
  /** 研报类型 */
  type: ResearchReportType;
  /** 标题 */
  title: string;
  /** 关联个股名（行业/策略等可能为空） */
  stockName: string;
  /** 关联个股代码（可能为空） */
  stockCode: string;
  /** 行业名（可能为空） */
  industryName: string;
  /** 机构简称 */
  orgName: string;
  /** 分析师（逗号分隔） */
  researcher: string;
  /** 东财评级（买入/增持/中性…），无则空 */
  rating: string;
  /** 评级变动（维持/上调/首次…），无则空 */
  ratingChange: string;
  /** 目标价（低/高，元），无则 null */
  targetPriceLow: number | null;
  targetPriceHigh: number | null;
  /** 本年/次年预测 EPS（元），无则 null */
  epsThisYear: number | null;
  epsNextYear: number | null;
  /** 本年/次年预测 PE，无则 null */
  peThisYear: number | null;
  peNextYear: number | null;
  /** 发布日期 YYYY-MM-DD */
  publishDate: string;
  /** 详情码（PDF/详情定位用） */
  infoCode: string;
  /** 详情页加密参数（拉正文用） */
  encodeUrl: string;
  /** 附件页数 */
  attachPages: number | null;
}

/** 研报正文详情 */
export interface ResearchReportDetail {
  /** 抽取到的正文纯文本；失败为 null */
  text: string | null;
  /** 详情页地址（兜底/外链） */
  detailUrl: string;
  /** PDF 全文地址（best-effort，可能不存在） */
  pdfUrl: string | null;
}

/** 研报 AI 分析结果 */
export interface ResearchAiAnalysis {
  /** Markdown 分析正文 */
  content: string;
  /** 本次分析覆盖的研报篇数 */
  reportCount: number;
}

/** 研报列表查询参数 */
export interface ResearchQuery {
  type: ResearchReportType;
  /** 个股代码（type=stock 时按个股过滤） */
  code?: string;
  /** 行业代码（type=industry 时过滤） */
  industry?: string;
  /** 评级过滤（如 买入） */
  rating?: string;
  /** 近 N 天 */
  days?: number;
  page?: number;
  pageSize?: number;
}

/** 研报机会发现：热门板块 */
export interface ResearchHotSector {
  name: string;
  /** 当日研报数 */
  reportCount: number;
  /** 评级上调/看多数 */
  upgradeCount: number;
  /** 一句话说明 */
  note: string;
}

/** 研报机会发现：个股机会线索 */
export interface ResearchOpportunity {
  code: string;
  name: string;
  /** 所属板块 */
  sector: string;
  /** 评级 */
  rating: string;
  /** 评级变动（上调/首次…） */
  ratingChange: string;
  /** 目标价（文本，可能为区间） */
  targetPrice: string;
  /** 机会逻辑 */
  reason: string;
}

/** 研报机会发现：风险提示 */
export interface ResearchRisk {
  title: string;
  detail: string;
}

/** 研报分析：非个股类（策略/宏观/晨报）单条要点 */
export interface ResearchCategoryNote {
  /** 机构/来源 */
  org: string;
  /** 标题 */
  title: string;
  /** AI 提炼要点 */
  point: string;
}

/** 公告列表项（全市场重大公告，实时爬取，不落库） */
export interface ResearchAnnouncementItem {
  /** 公告 art_code（取正文用） */
  artCode: string;
  /** 股票代码 */
  code: string;
  /** 股票名称 */
  name: string;
  /** 公告类型（取自 column_name） */
  type: string;
  /** 公告标题 */
  title: string;
  /** 发布时间 display_time（YYYY-MM-DD HH:mm） */
  time: string;
  /** 东方财富原文详情页 */
  url: string;
}

/** 研报分析：单条公告影响 */
export interface ResearchAnnouncementNote {
  /** 股票代码 */
  code: string;
  /** 股票名称 */
  name: string;
  /** 公告类型（取自 column_name） */
  type: string;
  /** 公告标题 */
  title: string;
  /** 利好/利空/中性 + 影响要点（AI 提炼，≤60字） */
  impact: string;
}

/** 研报机会发现：与历史的延续性结论 */
export interface ResearchOpportunityContinuity {
  /** 延续的板块/主线（上次也热、本次仍热） */
  persisting: string;
  /** 新增升温（本次新出现的密集关注/上调） */
  emerging: string;
  /** 退热/降温（上次热、本次弱化或消失） */
  fading: string;
  /** 综合追加结论 */
  note: string;
}

/** 研报机会发现结构化结果（由 LLM 输出 JSON 解析得到） */
export interface ResearchOpportunityReport {
  /** 数据日期 YYYY-MM-DD */
  date: string;
  /** 当日研报概述（总量/上调家数等） */
  marketDigest: string;
  /** 被研报集中关注/密集上调的板块 */
  hotSectors: ResearchHotSector[];
  /** 个股机会线索 */
  opportunities: ResearchOpportunity[];
  /** 主线/主题归纳 */
  themeSummary: string;
  /** 风险提示 */
  risks: ResearchRisk[];
  /** 与近几次研报机会发现的延续性对比（无历史时为 null） */
  continuity: ResearchOpportunityContinuity | null;
  /** 策略报告要点 */
  strategyNotes: ResearchCategoryNote[];
  /** 宏观研究要点 */
  macroNotes: ResearchCategoryNote[];
  /** 券商晨报要点 */
  morningNotes: ResearchCategoryNote[];
  /** 重大公告影响 */
  announcements: ResearchAnnouncementNote[];
}

/** 研报模块状态 */
export interface ResearchStatus {
  /** 是否已在设置中启用 */
  enabled: boolean;
  /** 数据源是否连通 */
  online: boolean;
  /** 出错/降级时的原因说明 */
  detail: string | null;
}

// ===== ETF 模块类型 =====

/** ETF 跟踪池标的（独立于自选股，ETF 模块自管） */
export interface EtfPoolItem {
  /** 6 位 ETF 代码 */
  code: string;
  name: string;
  /** 逗号分隔分组标签 */
  tags: string | null;
  note: string | null;
  addedAt: string;
}

/** 新增/更新 ETF 跟踪池入参 */
export interface EtfPoolInput {
  code: string;
  name?: string;
  tags?: string | null;
  note?: string | null;
}

/** ETF 综合操作建议 */
export type EtfAction = 'buy' | 'add' | 'hold' | 'reduce' | 'avoid';

/** ETF 结构化触发价（与今日计划 PlanTrigger 对齐，便于直接落计划项） */
export interface EtfTrigger {
  type: 'price' | 'breakout' | 'pullback';
  /** 触发价位（元） */
  value: number;
  note?: string;
}

/** 网格水位 */
export interface EtfGrid {
  /** 近一年区间下沿 */
  low: number;
  /** 近一年区间上沿 */
  high: number;
  /** 网格间距 % */
  stepPct: number;
  /** 当前价所处档位（0=底部 … gridCount=顶部） */
  level: number;
  gridCount: number;
  /** 下一档买入挂单价（向下一格） */
  nextBuy: number | null;
  /** 下一档卖出挂单价（向上一格） */
  nextSell: number | null;
}

/** 单只 ETF 确定性买卖信号 */
export interface EtfSignal {
  code: string;
  name: string;
  /** 现价（缺失为 null） */
  price: number | null;
  /** 昨收 */
  prevClose: number | null;
  /** 当日涨跌幅 % */
  pct: number | null;
  /** IOPV 参考净值（缺失为 null，由 LLM 用 mx_finance_data 补） */
  iopv: number | null;
  /** 折溢价率 %（正=溢价；缺失为 null） */
  premiumPct: number | null;
  /** 现价在近 2 年收盘区间的百分位 0-100（估值位置代理，非真实指数 PE 分位） */
  pricePercentile: number | null;
  /** 年线（MA250）偏离度 % */
  maDeviation: number | null;
  ma20: number | null;
  ma60: number | null;
  ma250: number | null;
  /** 动量打分（20/60 日收益加权 %） */
  momentum: number | null;
  /** 绝对动量为正（60 日收益>0） */
  absMomentumPositive: boolean;
  /** 池内相对动量排名（1=最强；无动量数据为 null） */
  momentumRank: number | null;
  /** 近 60 日年化波动率 %（网格间距用） */
  volatility: number | null;
  /** 网格水位提示 */
  grid: EtfGrid | null;
  /** 综合操作建议 */
  action: EtfAction;
  buyTrigger: EtfTrigger | null;
  sellTrigger: EtfTrigger | null;
  stopLoss: EtfTrigger | null;
  takeProfit: EtfTrigger | null;
  /** 信号要点（中文，逐条） */
  notes: string[];
  /** 指标缺失/降级原因（IOPV 缺失、K 线不足等） */
  warning: string | null;
}

/** ETF 信号集合（供前端与 agent） */
export interface EtfSignalsResult {
  /** 计算时间 ISO */
  asOf: string;
  signals: EtfSignal[];
}

/** ETF 模块状态 */
export interface EtfStatus {
  /** 是否已在设置中启用 */
  enabled: boolean;
  /** 跟踪池标的数 */
  poolSize: number;
}

// ===== ETF 市场总览（仿大盘页）类型 =====

/** ETF 榜单单项（涨跌幅/成交额/规模/资金流榜共用） */
export interface EtfListItem {
  code: string;
  name: string;
  /** 现价 */
  price: number;
  /** 当日涨跌幅 % */
  pct: number;
  /** 成交额（亿） */
  amount: number;
  /** 换手率 %（缺失为 undefined） */
  turnoverRate?: number;
  /** 规模/流通市值（亿，缺失为 undefined） */
  aum?: number;
  /** 主力净流入（亿，仅资金流榜有） */
  netInflow?: number;
  /** 东财 secid（点开 K 线用） */
  secid: string;
}

/** ETF 全市场概览统计 */
export interface EtfMarketStat {
  /** 全市场 ETF 数 */
  total: number;
  /** 上涨家数 */
  up: number;
  /** 下跌家数 */
  down: number;
  /** 平盘家数 */
  flat: number;
  /** 平均涨跌幅 % */
  avgPct: number;
  /** 全市场总成交额（亿） */
  totalAmount: number;
}

/** ETF 主题赛道分类（组内代表 ETF + 平均涨幅） */
export interface EtfThemeCategory {
  name: string;
  /** 组内平均涨跌幅 % */
  avgPct: number;
  /** 领涨代表 ETF */
  lead: { code: string; name: string; pct: number } | null;
  /** 组内成员（展示用，已带涨跌幅） */
  members: EtfListItem[];
}

/** ETF 市场总览快照（仿 MarketOverview） */
export interface EtfOverview {
  /** 快照时间 ISO */
  asOf: string;
  /** 全市场概览统计 */
  stat: EtfMarketStat | null;
  /** 主流/宽基代表 ETF 行情条 */
  broad: EtfListItem[];
  /** 涨幅榜 */
  gainers: EtfListItem[];
  /** 跌幅榜 */
  losers: EtfListItem[];
  /** 成交额榜（流动性 TOP） */
  turnover: EtfListItem[];
  /** 规模榜（AUM TOP） */
  aum: EtfListItem[];
  /** 主力净流入榜 */
  inflow: EtfListItem[];
  /** 主力净流出榜 */
  outflow: EtfListItem[];
  /** 主题赛道分类涨幅 */
  themes: EtfThemeCategory[];
}

// ===== M1 ETF 行业轮动引擎（建议向，中线赛道层）=====

/** ETF 赛道轮动状态机：上升 / 回踩 / 加速 / 过热 / 破位 */
export type EtfRotationState = '上升' | '回踩' | '加速' | '过热' | '破位';

/** 单只 ETF 的轮动评估项（确定性指标 + 5 态 + 综合强度） */
export interface EtfRotationItem {
  code: string;
  name: string;
  /** 来源：跟踪池 / 主题赛道代表 */
  source: 'pool' | 'theme';
  /** 所属赛道（主题源为分类名，跟踪池取 tags 首项，可空） */
  track: string | null;
  state: EtfRotationState;
  /** 综合轮动强度 0-100 */
  score: number;
  /** 强度评分构成（状态基分 + 相对强弱 + 动量 + 资金流） */
  breakdown: StrengthBreakdown;
  /** 相对沪深300 强弱（近 60 日超额收益 %，正=跑赢基准） */
  rs: number | null;
  ret20: number | null;
  ret60: number | null;
  ret120: number | null;
  /** 周线均线多头（周线 价>MA20>MA60） */
  weekMaTrend: boolean | null;
  /** 主力净流入（亿，缺为 null） */
  flowNetIn: number | null;
  /** 年线（MA250）偏离 % */
  maDeviation: number | null;
  /** 价格分位 0-100 */
  pricePercentile: number | null;
  /** 折溢价率 %（正=溢价，权威源集思录 discount_rt；未启用集思录或缺失为 null） */
  premiumPct: number | null;
  note: string;
}

/** ETF 行业轮动总览（按综合强度降序） */
export interface EtfRotationOverview {
  asOf: string;
  items: EtfRotationItem[];
  note: string;
}

/** M2 中线下钻：强赛道 ETF 入选条目（轮动榜里被选作下钻起点的 ETF） */
export interface MidDrilldownEtf {
  code: string;
  name: string;
  track: string | null;
  state: EtfRotationState;
  score: number;
  /** 该 ETF 取到的成分股只数（0=取数失败/未下钻） */
  constituentCount: number;
}

/** M2 中线下钻结果：强赛道 ETF → 合并成分股 universe → 中线选股龙头 */
export interface MidDrilldownResult {
  asOf: string;
  /** 入选的强赛道 ETF（上升/加速且 RS 为正，按强度降序） */
  strongEtfs: MidDrilldownEtf[];
  /** 合并去重后的 universe 总只数 */
  universeSize: number;
  /** 在 universe 内中线选股的运行详情（universe 为空则为 null） */
  run: ScreenRunDetail | null;
  /** 一句话说明（如无强赛道/无成分股的降级原因） */
  note: string;
}

// ===== S1 市场情绪周期（短线择时总开关，确定性只读，不下单/不调 LLM）=====

/** 情绪周期阶段（结合指数水位 + 日间方向判定） */
export type SentimentPhase = '冰点' | '恢复' | '高潮' | '退潮' | '震荡';

/** 情绪水位档位（仅按当日指数高低分档，与方向无关） */
export type SentimentLevel = '冰点' | '低迷' | '平稳' | '活跃' | '高潮';

/** 情绪指数的原始构成指标（best-effort，缺失为 null） */
export interface SentimentComponents {
  /** 上涨家数 */
  up: number | null;
  /** 下跌家数 */
  down: number | null;
  /** 平盘家数 */
  flat: number | null;
  /** 涨停数（含一字/ST） */
  limitUp: number | null;
  /** 真实涨停数（剔除一字/ST，赚钱效应更准） */
  realLimitUp: number | null;
  /** 跌停数 */
  limitDown: number | null;
  /** 真实跌停数 */
  realLimitDown: number | null;
  /** 炸板数 */
  brokenBoard: number | null;
  /** 炸板率 % */
  brokenRate: number | null;
  /** 最高连板高度 */
  maxStreak: number | null;
  /** 乐咕乐股市场活跃度 %（赚钱效应直读指标） */
  activity: number | null;
  /** 停牌数 */
  suspended: number | null;
}

/** 市场情绪周期总览（0-100 指数 + 水位档 + 周期阶段 + 白话仓位倾向） */
export interface SentimentOverview {
  /** 数据时刻 ISO */
  asOf: string;
  /** 交易日 YYYY-MM-DD（Asia/Shanghai） */
  tradeDate: string;
  /** 综合情绪指数 0-100 */
  index: number;
  /** 水位档位（按指数高低） */
  level: SentimentLevel;
  /** 周期阶段（水位 + 方向） */
  phase: SentimentPhase;
  /** 上一交易日指数（判方向用，无历史为 null） */
  prevIndex: number | null;
  /** 较上一交易日的变动（index - prevIndex，无历史为 null） */
  delta: number | null;
  /** 指数构成拆解（各分项贡献，可审计） */
  breakdown: StrengthBreakdown;
  /** 原始构成指标 */
  components: SentimentComponents;
  /** 白话仓位倾向建议（不需量化知识） */
  advice: string;
  /** 备注 */
  note: string;
  /** 是否有数据源降级（部分指标缺失，指数为不完整估计） */
  stale: boolean;
}

/** 情绪指数历史点（趋势图用） */
export interface SentimentHistoryItem {
  tradeDate: string;
  index: number;
  level: SentimentLevel;
  phase: SentimentPhase;
}

// ===== 板块新高宽度（主线识别，确定性只读，不下单/不调 LLM）=====

/** 板块口径：行业 / 概念 */
export type BoardKind = 'industry' | 'concept';

/**
 * 主线判定档：
 *  - none 未达标（新高数未过数量级地板）
 *  - candidate 候选（达标但未稳居榜首/持续不足）
 *  - confirmed 确认主线（新高数最多且持续多日稳居榜首）
 *  - fading 退潮（曾是主线，新高数骤降/榜首易主）
 */
export type BoardBreadthVerdict = 'none' | 'candidate' | 'confirmed' | 'fading';

/** 单个板块的新高宽度评估项 */
export interface BoardBreadthItem {
  boardCode: string;
  boardName: string;
  kind: BoardKind;
  /** 板块内创新高个股数（按 window 口径） */
  newHighCount: number;
  /** 板块成分股总数（算占比用） */
  consTotal: number;
  /** 新高占比 %（newHighCount/consTotal*100，consTotal=0 时为 null） */
  ratio: number | null;
  /** 当日横向排名（1 = 新高数最多） */
  rank: number;
  /** 连续达标天数（近端连续满足数量级地板的交易日数，含当日；无历史为 1） */
  streakDays: number;
  /** 近端居于榜首 Top 的天数（近 N 日内排名 ≤ TOP_RANK 的天数） */
  topDays: number;
  /** 较上一交易日新高数变化（无历史为 null） */
  delta: number | null;
  /** 主线判定 */
  verdict: BoardBreadthVerdict;
  /** 映射到的代表 ETF（无映射为 null） */
  etf: { code: string; name: string } | null;
  /** 一句话说明 */
  note: string;
}

/** 板块新高宽度总览（按新高数降序） */
export interface BoardBreadthOverview {
  /** 数据时刻 ISO */
  asOf: string;
  /** 交易日 YYYY-MM-DD（Asia/Shanghai） */
  tradeDate: string;
  /** 新高窗口口径（创月新高/半年新高/一年新高/历史新高） */
  window: string;
  /** 全市场当日创新高个股总数（相对集中度的分母参考） */
  marketNewHighTotal: number;
  /** 各板块宽度榜（按新高数降序） */
  items: BoardBreadthItem[];
  /** 当前确认的主线板块（verdict=confirmed，按新高数降序） */
  mainlines: BoardBreadthItem[];
  /** 备注 */
  note: string;
  /** 数据源降级（创新高/成分股取数失败时为 true，榜为不完整估计） */
  stale: boolean;
}

/** 板块新高宽度历史点（趋势/持续用） */
export interface BoardBreadthHistoryItem {
  tradeDate: string;
  boardCode: string;
  boardName: string;
  newHighCount: number;
  rank: number;
}

/** 设置项（key-value）。模型为任意 OpenAI 兼容服务，非固定 DeepSeek。 */
export interface AppSettings {
  /** OpenAI 兼容服务的 Base URL */
  llmBaseUrl: string;
  /** 模型名 */
  llmModel: string;
  /** 轻度模型名（用于盯盘初筛等低成本场景，复用默认 Base URL / API Key；空=跳过初筛） */
  llmLightModel: string;
  /** 主模型上下文窗口（token），用于 agent 自动压缩预算；空=内置默认 128000 */
  llmContextWindow: string;
  /** 已登录鉴权保护，读取时直接回显明文，便于核对 */
  llmApiKey: string;
  emApiKey: string;
  mxApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  telegramThreadId: string;
  /** 真实持仓数据源：同花顺投资账本 */
  thsCookie: string;
  thsUserId: string;
  thsFundKeys: string;
  /** 爱盯盘云同步 token（单向镜像用） */
  idpToken: string;
  /** TrendRadar 热点雷达 MCP 地址（streamable-HTTP） */
  trendradarMcpUrl: string;
  /** 是否启用热点雷达模块（'true' / 'false'） */
  trendradarEnabled: string;
  /** 研报数据源 Base URL（东方财富 reportapi，可选覆盖） */
  researchBaseUrl: string;
  /** 是否启用研报模块（'true' / 'false'） */
  researchEnabled: string;
  /** 是否启用 ETF 模块（'true' / 'false'） */
  etfEnabled: string;
  /** 行情数据源启停（参与 datasource 调度，'true' / 'false'） */
  eastmoneyEnabled: string;
  tencentEnabled: string;
  sinaEnabled: string;
  neteaseEnabled: string;
  /** 集思录（ETF 折溢价补充）启停，默认关闭 */
  jisiluEnabled: string;
  /** 集思录 cookie（可选，明文） */
  jisiluCookie: string;
  /** AKShare（aktools）HTTP 服务基址，如 http://群晖IP:8080 */
  akshareBaseUrl: string;
  /** AKShare 数据源启停，默认开启 */
  akshareEnabled: string;
  /** 华泰证券 AI 网关 apiKey（HT_APIKEY，五技能共用），明文回显 */
  htApiKey: string;
  /** 华泰证券 AI 网关 Base URL（可选覆盖，默认 https://ai.zhangle.com） */
  htscBaseUrl: string;
  /** 华泰证券 AI 网关数据源启停，默认开启 */
  htscEnabled: string;
  /** 同花顺问财 OpenAPI apiKey（IWENCAI_API_KEY），明文回显 */
  iwencaiApiKey: string;
  /** 同花顺问财 OpenAPI Base URL（可选覆盖，默认 https://openapi.iwencai.com） */
  iwencaiBaseUrl: string;
  /** 同花顺问财 ETF 选股数据源启停，默认开启 */
  iwencaiEnabled: string;
  /** 问财 ETF 选股网关 skill id（X-Claw-Skill-Id），默认 hithink-etf-selector */
  iwencaiSkillId: string;
  /** 问财个股选股网关 skill id（X-Claw-Skill-Id），账号开通后填入 */
  iwencaiStockSkillId: string;
  /** 同花顺问财个股选股数据源启停，默认关闭（需账号开通对应 skill） */
  iwencaiStockEnabled: string;
  /** 财联社电报数据源启停（经 AKShare 透传），默认开启 */
  clsEnabled: string;
  /** 雪球数据源启停（经 AKShare 透传），默认开启 */
  xueqiuEnabled: string;
}

// ===== 数据源中心（统一管理所有外部取数）=====

/** 数据源分类 */
export type DataSourceCategory = '行情' | '选股' | '账本' | '自选' | '资讯' | '研报' | '热点' | '本地';

/** 数据源接入协议 */
export type DataSourceProtocol = 'http-rest' | 'http-jsonp' | 'mcp' | 'local';

/** 数据源调用统计（进程内聚合） */
export interface DataSourceStats {
  /** 逻辑请求数（重试不重复计） */
  requests: number;
  /** 错误数 */
  errors: number;
  /** 错误率（无请求为 null） */
  errorRate: number | null;
  /** 缓存命中数 */
  cacheHits: number;
  /** 最近调用时间 ISO */
  lastCallAt: string | null;
  /** 最近错误信息 */
  lastError: string | null;
  /** 最近一次延迟（毫秒，缓存命中为 0） */
  lastLatencyMs: number | null;
}

/** 数据源单个凭据/配置字段（值一律明文回显，便于核对） */
export interface DataSourceConfigField {
  /** 设置键（camelCase，对应 AppSettings） */
  key: string;
  label: string;
  /** 敏感字段标记（仅用于前端样式提示，值仍明文回显） */
  secret: boolean;
  /** 当前值（明文回显） */
  value: string;
  /** 是否已配置（有非空值） */
  configured: boolean;
  /** 是否为该数据源就绪所必需 */
  required: boolean;
  placeholder?: string;
}

/** 行情调度链路（某能力的生效数据源顺序与最近命中源） */
export interface DataSourceRoute {
  /** 能力标识：quote 实时报价 / kline K线 */
  capability: string;
  /** 能力中文名 */
  label: string;
  /** 当前生效（已启用）的数据源顺序 */
  providers: string[];
  /** 最近一次成功命中的数据源 id */
  lastServed: string | null;
}

/** 数据源元信息 + 当前状态（列表项） */
export interface DataSourceInfo {
  id: string;
  name: string;
  category: DataSourceCategory;
  protocol: DataSourceProtocol;
  /** 基础地址（域名或本地路径） */
  baseUrl: string;
  description: string;
  /** 是否支持启停（有 enabled 开关） */
  toggleable: boolean;
  /** 当前是否启用（不支持启停的源恒为 true） */
  enabled: boolean;
  /** 必需凭据是否齐备 */
  ready: boolean;
  /** 凭据/配置字段（含掩码值） */
  config: DataSourceConfigField[];
  /** 调用统计 */
  stats: DataSourceStats;
}

/** 数据源健康检查结果 */
export interface DataSourceHealth {
  id: string;
  /** 是否连通 */
  online: boolean;
  /** 探测延迟（毫秒，失败为 null） */
  latencyMs: number | null;
  /** 失败原因 / 降级说明 */
  detail: string | null;
  checkedAt: string;
}

/** 数据源凭据/配置更新入参（key 为 AppSettings 字段名） */
export type DataSourceConfigUpdate = Record<string, string>;

/** 鉴权状态：是否已设置访问密码（开启鉴权） */
export interface AuthStatus {
  enabled: boolean;
}

/** 登录结果：返回无状态访问 token */
export interface LoginResult {
  token: string;
}

/** WebSocket 流式事件 */
export type StreamEvent =
  | { type: 'run_started'; runId: string }
  | { type: 'token'; text: string }
  /** 推理型模型原生思考增量（仅展示，不回填进上下文） */
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: string }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; preview: string }
  | { type: 'message'; role: MessageRole; content: string }
  | { type: 'run_finished'; runId: string; status: RunStatus }
  /** 上下文预算用量（每步采样后上报，供前端展示 token 预算 / 压缩提示） */
  | { type: 'context'; usedTokens: number; contextWindow: number; compacted: boolean }
  | { type: 'error'; message: string };

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ===== 实时盯盘（Watch Engine）独立模块类型 =====

/** 盯盘信号来源：持仓 / 自选 / 全市场扫描 */
export type WatchSource = 'position' | 'watch' | 'scan';

/** 信号严重度（用于优先级排序与展示） */
export type WatchSeverity = 'low' | 'medium' | 'high';

/** 触发信号类型 */
export type WatchSignalType =
  | 'drawdown_from_high' // 持仓：从今日高点回撤
  | 'break_cost' // 持仓：跌破成本
  | 'surge_drop' // 持仓：单轮急跌
  | 'limit_open' // 持仓：涨停打开 / 炸板
  | 'near_limit_up' // 自选：临近涨停
  | 'fast_rise' // 自选：单轮涨速异动
  | 'breakout' // 自选：创日内新高
  | 'new_limit_up' // 扫描：新晋涨停
  | 'sector_inflow' // 扫描：板块主力大幅净流入
  | 'take_profit' // 战法：达止盈线
  | 'eod_settle' // 战法：尾盘了结（不过夜）
  | 'strategy_stop' // 战法：跌破止损线
  | 'plan_buy' // 今日计划：命中买点触发价
  | 'plan_stop' // 今日计划：跌破计划止损/卖点
  | 'plan_take_profit' // 今日计划：达计划止盈
  | 'weekly_break'; // 中线：跌破周线趋势（周线MA/高点回撤），中线盯盘档专用

/**
 * 信号去向：描述一条信号在确定性管道中的最终落点（解释「为何没升级成 AI 建议」）。
 * - hysteresis：迟滞门静默（持续成立期间重复信号被收敛）
 * - cooldown：同类信号冷却中
 * - low_score：低于确定性打分门
 * - over_capacity：超单轮限流被丢弃（下轮再排）
 * - cache_reused：近期已研判，复用不再唤醒
 * - to_ai：入选并送 AI 终审（结果见对应 alert）
 */
export type WatchDisposition =
  | 'hysteresis'
  | 'cooldown'
  | 'low_score'
  | 'over_capacity'
  | 'cache_reused'
  | 'to_ai';

/** 一条触发信号（Hot Path 产出，未必都唤醒 LLM） */
export interface WatchSignal {
  code: string;
  name: string;
  source: WatchSource;
  type: WatchSignalType;
  severity: WatchSeverity;
  /** 触发时现价 */
  price: number;
  /** 触发时涨跌幅 % */
  pct: number;
  /** 人类可读的触发说明 */
  detail: string;
  /** 触发分值（越大越优先唤醒） */
  score: number;
  /** 换手率 %（C 技术指标，best-effort） */
  turnoverRate?: number;
  /** 量比（C 技术指标，best-effort） */
  volumeRatio?: number;
  /** 所属战法 id（持仓来自战法时有值） */
  strategyId?: string;
  /** 所属战法名（页面展示用） */
  strategyName?: string;
  /** 触发时间 ISO */
  at: string;
  /** 本信号在确定性管道中的去向（广播时附带，纯展示用） */
  disposition?: WatchDisposition;
}

/** 落库的盯盘告警（含 AI 研判结论） */
export interface WatchAlert {
  id: string;
  code: string;
  name: string;
  source: WatchSource;
  signalType: WatchSignalType;
  severity: WatchSeverity;
  /** 触发说明 */
  detail: string;
  /** 关联的 agent 运行 id */
  runId: string | null;
  /** AI 建议正文 */
  adviceText: string | null;
  /** 结论枚举（买点：关注/买入/跳过；卖点：持有/减仓/清仓/观望） */
  verdict: string | null;
  /** 终审是否值得推送（默认沉默） */
  shouldAlert: boolean;
  /** Telegram 是否已投递（死信重试用） */
  delivered: boolean;
  /** 触发时现价（结果反思回看基准） */
  triggerPrice: number;
  /** 事后应验结果：命中/打脸/持平/未回看 */
  outcome: 'hit' | 'miss' | 'flat' | null;
  /** 事后涨跌幅 %（现价相对 triggerPrice） */
  outcomePct: number | null;
  /** 本次研判消耗 prompt tokens */
  promptTokens: number | null;
  /** 本次研判消耗 completion tokens */
  completionTokens: number | null;
  /** 所属战法 id（持仓来自战法时有值） */
  strategyId: string | null;
  /** 所属战法名（页面展示用） */
  strategyName: string | null;
  /** 本地战法自动卖出执行状态：成交 / 跳过 / 无（非自动卖出场景） */
  execStatus: 'executed' | 'skipped' | null;
  /** 自动卖出回执或跳过原因（如 T+1 锁定、可卖不足、已成交明细） */
  execNote: string | null;
  createdAt: string;
}

/** 盯盘配置（独立持久化，watch_* 键前缀） */
export interface WatchConfig {
  /** 引擎总开关 */
  enabled: boolean;
  /** 轮询间隔（秒） */
  pollSec: number;
  /** 监控范围开关 */
  watchPositions: boolean;
  watchWatchlist: boolean;
  watchScan: boolean;
  /** 自选监控重点分组（tag 名；空=不纳入任何自选） */
  watchGroup: string;
  /** 持仓：从今日高点回撤阈值 % */
  drawdownPct: number;
  /** 持仓：单轮急跌阈值 % */
  surgeDropPct: number;
  /** 自选：单轮涨速阈值 % */
  fastRisePct: number;
  /** 自选：临近涨停阈值 %（距涨停价） */
  nearLimitPct: number;
  /** 扫描：板块主力净流入阈值（亿元） */
  sectorInflowYi: number;
  /** 同标的同类信号冷却（分钟） */
  cooldownMin: number;
  /** 同标的近期研判缓存复用窗口（分钟） */
  cacheReuseMin: number;
  /** 单轮最多唤醒 LLM 次数（限流） */
  maxConcurrent: number;
  /** 是否推送 Telegram */
  pushTelegram: boolean;
  /** 多空对辩研判（先列多空理由再裁决） */
  adversarial: boolean;
  /** 注入该标的近期研判历史做对比 */
  historyCompare: boolean;
  /** 历史对比取近 N 条 */
  historyLookback: number;
  /** 结果反思：次交易日回看历史告警应验并注入研判 */
  reflection: boolean;
  /** 确定性打分门：信号 score 低于此值直接沉默（0=不拦截） */
  minScore: number;
  /** 盘中技术指标（量比/换手）注入规则与 prompt */
  techContext: boolean;
  /** 全市场扫描分频（秒，>=pollSec 才生效） */
  scanEverySec: number;
  /** 自选标的评估分频（秒，>=pollSec 才生效） */
  watchEverySec: number;
  /** 收盘后推送当日告警摘要 */
  dailyDigest: boolean;
}

/** 盯盘统计（成本与命中率可观测） */
export interface WatchStats {
  /** 今日告警条数（含沉默） */
  alertsToday: number;
  /** 今日初筛/打分门拦截条数 */
  screenedToday: number;
  /** 今日研判消耗 token 合计（prompt+completion） */
  tokensToday: number;
  /** 已成熟告警命中率 %（hit/(hit+miss)），无样本为 null */
  hitRate: number | null;
  /** 已成熟样本数（hit+miss） */
  maturedCount: number;
}

/** 战法盯盘卖点档案（量化触发参数，按战法可扩展） */
export interface StrategySellProfile {
  /** 止盈线：浮盈 % 达此值触发 take_profit */
  takeProfitPct: number;
  /** 冲高回落：从今日高点回撤 % 达此值触发（覆盖全局 drawdownPct） */
  intradayDrawdownPct: number;
  /** 止损线：跌破成本 % 达此值触发 strategy_stop */
  stopLossPct: number;
  /** 尾盘了结时间（Asia/Shanghai 分钟数，如 14:50=890），到点对战法持仓产 eod_settle */
  eodCutoffMin: number;
  /**
   * 中线趋势破坏均线周期（中线盯盘档）：跌破该周期均线即产 weekly_break 告警。
   * 配合 maBreakTimeframe；为空表示不启用周线趋势破坏检查（短线档默认不设）。
   */
  maBreakPeriod?: number | null;
  /** 趋势破坏均线时间框架：week 周线（默认）/ day 日线 */
  maBreakTimeframe?: 'day' | 'week';
  /** 中线移动止盈：从持有以来最高（周线收盘）回撤 % 达此值告警，锁住趋势利润；为空不启用 */
  trailingStop?: number | null;
}

/** 战法盯盘视图（页面展示：归属 + 卖点档案 + 现行卖出 Skill） */
export interface WatchStrategyView {
  strategyId: string;
  name: string;
  kind: StrategyKind;
  /** 卖点档案（无则该战法不启用战法专属触发） */
  profile: StrategySellProfile | null;
  /** 现行 active 卖出 Skill 内容（无则 null） */
  sellSkill: string | null;
}

/** 监控池实时行情条目（推前端展示） */
export interface WatchQuoteItem {
  code: string;
  name: string;
  source: WatchSource;
  price: number;
  pct: number;
  /** 今日内滚动最高价 */
  dayHigh: number;
  /** 所属战法 id（持仓来自战法时有值） */
  strategyId?: string;
  /** 所属战法名（页面展示用） */
  strategyName?: string;
}

/** 引擎运行状态（心跳） */
export interface WatchStatus {
  enabled: boolean;
  running: boolean;
  /** 当前是否交易时段 */
  inSession: boolean;
  /** 上次轮询时间 ISO */
  lastPollAt: string | null;
  /** 上次轮询命中信号数 */
  lastSignalCount: number;
  /** 今日已产生告警数 */
  alertsToday: number;
  config: WatchConfig;
}

/** 自动/拒绝成交实时事件（经盯盘总线推送，让自动建仓/卖出与总闸拒绝「看得见」） */
export interface WatchTradeEvent {
  /** 发生时刻 ISO */
  at: string;
  /** auto_buy 自动买入成功 / auto_sell 自动卖出成功 / rejected 被安全总闸拒绝 */
  kind: 'auto_buy' | 'auto_sell' | 'rejected';
  /** 触发来源：cron | agent | watch（rejected 时为被拒来源） */
  source: string;
  code: string;
  name: string;
  qty: number | null;
  price: number | null;
  amount: number | null;
  /** 卖出已实现盈亏（买入/拒绝为 null） */
  realizedProfit: number | null;
  strategyId: string | null;
  strategyName: string | null;
  /** 操作原因（买卖）或拒绝原因（rejected） */
  reason: string | null;
}

/** 盯盘 WebSocket 推送事件（独立于 StreamEvent） */
export type WatchEvent =
  | { type: 'status'; status: WatchStatus }
  | { type: 'quotes'; at: string; items: WatchQuoteItem[] }
  | { type: 'signal'; signal: WatchSignal }
  | { type: 'alert'; alert: WatchAlert }
  | { type: 'trade'; trade: WatchTradeEvent };

// ===================== LLM 调用记录分析 =====================

/** LLM 调用用途分类 */
export type UsagePurpose =
  | 'chat'
  | 'review'
  | 'market-review'
  | 'watch-research'
  | 'watch-screen'
  | 'research'
  | 'analyze'
  | 'strategy'
  | 'scheduled-task'
  | 'connectivity';

/** 用途中文展示标签 */
export const USAGE_PURPOSE_LABELS: Record<UsagePurpose, string> = {
  chat: '对话',
  review: '一键复盘',
  'market-review': '大盘点评',
  'watch-research': '盯盘研判',
  'watch-screen': '盯盘初筛',
  research: '研报分析',
  analyze: '自选研判',
  strategy: '战法运行',
  'scheduled-task': '定时任务',
  connectivity: '连通测试',
};

// ===================== 今日计划（Daily Plan）=====================

/** 计划状态：草稿 / 生效 / 已收盘复盘 */
export type PlanStatus = 'draft' | 'active' | 'closed';

/** 标的操作方向 */
export type PlanDirection = 'buy' | 'hold' | 'reduce' | 'sell' | 'watch';

/** 标的项盘中状态 */
export type PlanItemStatus = 'pending' | 'triggered' | 'done' | 'invalid';

/** 标的来源（体现「研报/热点/板块/选股/持仓/自选」串联） */
export type PlanItemSource =
  | 'research'
  | 'hotspot'
  | 'sector'
  | 'screener'
  | 'position'
  | 'watchlist'
  | 'other';

/** 触发条件类型 */
export type PlanTriggerType = 'price' | 'breakout' | 'pullback';

/** 计划标的资产类型：个股 / ETF（基金） */
export type PlanAssetType = 'stock' | 'etf';

/** 计划事件类型 */
export type PlanEventKind = 'created' | 'regenerated' | 'trigger_hit' | 'note' | 'review';

/** 结构化触发条件（盯盘引擎据 value 做廉价数值比较） */
export interface PlanTrigger {
  type: PlanTriggerType;
  /** 触发价位（breakout=突破上破 / price·pullback=回落下破） */
  value: number;
  note?: string;
}

/** 今日择时档位：进攻 / 均衡 / 防守（大盘走势+资金+情绪+外盘综合定档，约束个股与 ETF 的方向与仓位） */
export type TimingLevel = 'attack' | 'balanced' | 'defense';

/** 大盘研判 */
export interface MarketStance {
  /** 方向 */
  bias: 'bull' | 'bear' | 'neutral';
  /** 今日择时档位（前提闸门）：进攻可正常 buy / 均衡精选 / 防守禁新开多。缺省按 bias 推断 */
  timingLevel?: TimingLevel;
  /** 建议仓位 %（0-100） */
  positionPct: number;
  /** 关键支撑位（文本，如「上证 3380」） */
  support: string;
  /** 关键压力位 */
  resistance: string;
  /** 一句话定调 */
  summary: string;
}

/** 重点板块 */
export interface PlanFocusSector {
  name: string;
  /** 强度阶段：主线/启动/分歧/退潮 等 */
  strength: string;
  reason: string;
}

/** 计划标的项 */
export interface DailyPlanItem {
  id: string;
  planId: string;
  code: string;
  name: string;
  /** 资产类型：个股 / ETF（落库时按代码前缀自动判定，可显式指定） */
  assetType: PlanAssetType;
  direction: PlanDirection;
  thesis: string;
  buyTrigger: PlanTrigger | null;
  sellTrigger: PlanTrigger | null;
  stopLoss: PlanTrigger | null;
  takeProfit: PlanTrigger | null;
  positionHint: string;
  /** 右侧确认条件（个股突破确认 / ETF 回踩转强等，盘中据此判断是否真正介入） */
  confirmConditions: string[];
  /** 逻辑失效条件（满足则当天取消计划/降级，供盘中纠偏与收盘复盘对照） */
  invalidConditions: string[];
  source: PlanItemSource;
  /** 计划 agent 对该标的的综合置信度 0-100（盘前生成时打分；null=未给），与仅个股辩论后才有的 debateConfidence 语义不同 */
  confidence: number | null;
  priority: number;
  status: PlanItemStatus;
  lastNote: string | null;
  /** 多 agent 辩论结论（落库后增强，个股自动跑决策引擎）：持有/减仓/清仓，null=未辩论 */
  debateVerdict: string | null;
  /** 辩论置信度（0-100），null=未辩论 */
  debateConfidence: number | null;
  /** 辩论一句话要点（组合经理 thesis），null=未辩论 */
  debateNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 计划事件 */
export interface DailyPlanEvent {
  id: string;
  planId: string;
  itemId: string | null;
  ts: string;
  kind: PlanEventKind;
  /** JSON 文本载荷 */
  payload: string | null;
  runId: string | null;
}

/** 今日计划（主记录） */
export interface DailyPlan {
  id: string;
  /** 计划日 YYYY-MM-DD */
  planDate: string;
  status: PlanStatus;
  marketStance: MarketStance | null;
  focusSectors: PlanFocusSector[];
  externalContext: string;
  narrative: string;
  runId: string | null;
  reviewSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 计划详情：计划 + 标的项 + 事件 */
export interface DailyPlanDetail {
  plan: DailyPlan;
  items: DailyPlanItem[];
  events: DailyPlanEvent[];
}

/** 计划兑现度（纯代码统计，不经 AI 估算） */
export interface PlanFulfillment {
  /** 计划日 YYYY-MM-DD */
  planDate: string;
  /** 标的总数 */
  total: number;
  /** 设了任一触发价（买/卖/损/盈）的标的数，作为兑现率分母 */
  withTrigger: number;
  /** 已触发（status=triggered 或 done）总数 */
  triggered: number;
  /** 已完成 */
  done: number;
  /** 已失效 */
  invalid: number;
  /** 待触发 */
  pending: number;
  /** 兑现率 = 设触发价且已触发/完成 ÷ withTrigger；withTrigger=0 时为 null */
  hitRate: number | null;
}

/** 计划历史列表项（轻量摘要，供历史抽屉渲染） */
export interface DailyPlanSummary {
  planDate: string;
  status: PlanStatus;
  /** 大盘方向（无 marketStance 时为 null） */
  bias: 'bull' | 'bear' | 'neutral' | null;
  /** 一句话定调 */
  summary: string;
  /** 计划标的数 */
  itemCount: number;
  updatedAt: string;
}

/** 单条 LLM 调用记录 */
export interface LlmCallRecord {
  id: string;
  purpose: UsagePurpose | string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  success: boolean;
  error: string | null;
  runId: string | null;
  taskName: string | null;
  createdAt: string;
}

/** 按用途聚合 */
export interface UsagePurposeStat {
  purpose: UsagePurpose | string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 按模型聚合 */
export interface UsageModelStat {
  model: string;
  calls: number;
  totalTokens: number;
}

/** 每日趋势点（Asia/Shanghai 自然日） */
export interface UsageDailyPoint {
  date: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 调用记录总览（统计窗口内） */
export interface UsageSummary {
  /** 统计窗口天数 */
  days: number;
  totals: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** 成功率 %（无样本为 null） */
    successRate: number | null;
  };
  byPurpose: UsagePurposeStat[];
  byModel: UsageModelStat[];
  daily: UsageDailyPoint[];
}

// ===== Agent 工具管理（工具页）=====

/** 工具可用性：常驻 / 绑定战法 / 战法+Skill / 思考开启时挂载 */
export type ToolAvailability = 'always' | 'strategy' | 'strategy_skill' | 'thinking';

/** 单个 agent 工具的展示与配置信息（GET /api/tools 返回项） */
export interface ToolInfo {
  /** 工具函数名（唯一键） */
  name: string;
  /** 分组（妙想 / 行情持仓 / 决策 / ...） */
  group: string;
  /** 挂载条件 */
  availability: ToolAvailability;
  /** 代码内置描述 */
  baseDescription: string;
  /** 生效描述（有覆盖时为覆盖值，否则同 baseDescription） */
  description: string;
  /** 入参 JSON Schema（只读展示） */
  parameters: Record<string, unknown>;
  /** 是否启用（默认 true；false 时不下发给 LLM） */
  enabled: boolean;
  /** 描述是否被用户覆盖 */
  overridden: boolean;
  /** 是否为常驻核心工具（渐进式披露下初始即可见；false=需经 search_tools 检索加载） */
  core?: boolean;
}

/** 工具配置更新入参（PUT /api/tools/:name）；description 为空串=清除覆盖回落默认 */
export interface ToolConfigUpdate {
  enabled?: boolean;
  description?: string;
  /** 是否设为常驻核心工具（渐进式披露下初始即可见，无需 search_tools 检索） */
  core?: boolean;
}

// ===== Agent 提示词管理（智能体中枢·提示词）=====

/** 单段提示词的展示与配置信息（GET /api/prompts 返回项） */
export interface PromptInfo {
  /** 提示词键（唯一） */
  key: string;
  /** 展示名 */
  label: string;
  /** 用途说明（这段提示词的作用 / 注入位置） */
  hint: string;
  /** 代码内置默认值 */
  baseContent: string;
  /** 生效值（有覆盖为覆盖值，否则同 baseContent） */
  content: string;
  /** 是否被用户覆盖 */
  overridden: boolean;
}

/** 提示词配置更新入参（PUT /api/prompts/:key）；content 为空串=清除覆盖回落默认 */
export interface PromptConfigUpdate {
  content?: string;
}

// ===== 调度总览（智能体中枢·调度，聚合中央任务 + 模块定时）=====

/** 调度来源：central 中央任务（scheduled_tasks）/ module 模块内定时 */
export type ScheduleType = 'central' | 'module';

/** 统一调度总览项（GET /api/schedules 返回项） */
export interface ScheduleOverviewItem {
  /** central=任务 id；module=job id */
  id: string;
  type: ScheduleType;
  /** module 任务的模块前缀（写操作分流用）；central 为 null */
  module: string | null;
  /** 名称（central=任务名 / module=label） */
  name: string;
  cronExpr: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastSuccessAt: string | null;
  /** 仅 central：驱动 agent 的完整 prompt */
  prompt: string | null;
  /** 仅 central：绑定战法 id */
  strategyId: string | null;
  /** 仅 central：模型配置 */
  modelConfig: ModelConfig | null;
  /** 仅 central：运行超时秒 */
  timeoutSec: number | null;
  /** 疑似重复分组标识（同一 cron 时刻聚合）；无冲突为 null */
  duplicateGroup?: string | null;
  /** 重复风险：none=无 / time_conflict=同刻同类 / purpose_conflict=疑似同用途 */
  risk?: 'none' | 'time_conflict' | 'purpose_conflict';
}

/** 全局安全控制状态（交易/模拟总闸） */
export interface SafetyState {
  /** 总急停：开启后拒绝一切交易/模拟动作 */
  killSwitch: boolean;
  killReason: string | null;
  /** 自动本地模拟交易开关（cron/agent/watch 触发的 sim_trade） */
  autoLocalSimEnabled: boolean;
  /** 自动外部模拟交易开关（cron/agent 触发的 mx_trade 妙想模拟盘） */
  autoExternalSimEnabled: boolean;
  /** 是否允许手动强制成交（跳过交易日/时段校验） */
  allowManualForceTrade: boolean;
  updatedAt: string;
}

/** 安全控制更新（部分字段） */
export interface SafetyUpdate {
  killSwitch?: boolean;
  killReason?: string | null;
  autoLocalSimEnabled?: boolean;
  autoExternalSimEnabled?: boolean;
  allowManualForceTrade?: boolean;
}

// ===== 真实持仓纪律（确定性体检，只读不下单）=====

/** 纪律命中类型 */
export type DisciplineKind =
  | 'stop_loss'
  | 'take_profit'
  | 'overweight'
  | 'over_hold'
  | 'near_stop';

/** 单票纪律主状态：healthy 或某一命中类型 */
export type DisciplineStatus = 'healthy' | DisciplineKind;

/** 账户级默认纪律阈值 */
export interface DisciplineConfig {
  /** 成本止损线（%，正数，如 8=跌破成本 8% 触发） */
  stopLossPct: number;
  /** 止盈线（%） */
  takeProfitPct: number;
  /** 最长持有交易日；null 不限 */
  maxHoldDays: number | null;
  /** 单票最大仓位占比（%） */
  singleMaxWeightPct: number;
  /** 总持仓上限占比（%，留现金缓冲） */
  totalMaxPositionPct: number;
}

/** 逐票纪律覆盖（留空字段回退账户默认） */
export interface DisciplineOverride {
  code: string;
  name: string | null;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  maxHoldDays: number | null;
  singleMaxWeightPct: number | null;
  note: string | null;
  updatedAt: string;
}

/** 逐票纪律覆盖写入 */
export interface DisciplineOverrideInput {
  name?: string | null;
  stopLossPct?: number | null;
  takeProfitPct?: number | null;
  maxHoldDays?: number | null;
  singleMaxWeightPct?: number | null;
  note?: string | null;
}

/** 单条纪律命中点 */
export interface DisciplineFlag {
  kind: DisciplineKind;
  severity: 'high' | 'medium' | 'low';
  detail: string;
}

/** 单票纪律体检结果 */
export interface DisciplinePositionItem {
  code: string;
  name: string;
  /** 资产类型：stock 个股 / etf 场内基金（ETF 走更宽松的趋势级纪律） */
  assetType: 'stock' | 'etf';
  price: number;
  avgCost: number;
  /** 持有盈亏率（小数） */
  holdRate: number;
  /** 仓位占比（小数） */
  positionRate: number;
  holdDays: number;
  /** 生效纪律（含来源） */
  rule: {
    stopLossPct: number;
    takeProfitPct: number;
    maxHoldDays: number | null;
    singleMaxWeightPct: number;
    source: 'default' | 'override';
  };
  status: DisciplineStatus;
  flags: DisciplineFlag[];
  /** 直白可执行建议（中文） */
  advice: string;
}

/** 账户级纪律检查 */
export interface DisciplineAccountCheck {
  /** 总持仓占比（小数） */
  totalPositionRate: number;
  totalMaxPositionPct: number;
  overTotal: boolean;
  /** 现金占比（小数） */
  cashRate: number;
  /** 最大单一持仓 */
  topConcentration: { code: string; name: string; rate: number } | null;
  warnings: string[];
}

/** 真实持仓纪律体检报告 */
export interface DisciplineReport {
  asOf: string;
  config: DisciplineConfig;
  items: DisciplinePositionItem[];
  account: DisciplineAccountCheck;
  counts: {
    stopLoss: number;
    takeProfit: number;
    overweight: number;
    overHold: number;
    healthy: number;
  };
}

/** 纪律事件（落库 + 推送去重） */
export interface DisciplineEvent {
  id: string;
  code: string;
  name: string;
  kind: DisciplineKind;
  severity: 'high' | 'medium' | 'low';
  detail: string;
  holdRate: number | null;
  createdAt: string;
}

// ===== 日终持仓归因（确定性只读，落库 + 可推送）=====

/** 单票当日盈亏贡献 */
export interface PositionAttributionItem {
  code: string;
  name: string;
  /** 当日盈亏额（元） */
  dayPnl: number;
  /** 当日盈亏率（小数） */
  dayRate: number;
  /** 仓位权重（小数，市值 / 总资产） */
  weight: number;
  /** 当日对账户的盈亏贡献（小数，dayRate × weight） */
  contribution: number;
  /** 确定性归因文本（可选白话增强留空） */
  note: string | null;
}

/** 某交易日的账户级持仓归因 */
export interface PositionAttributionReport {
  /** 归因日 YYYY-MM-DD */
  date: string;
  /** 数据时间 ISO */
  asOf: string;
  /** 账户当日盈亏额（元） */
  totalDayPnl: number;
  /** 账户当日盈亏率（小数，对总资产） */
  totalDayRate: number;
  /** 逐票贡献（按贡献绝对值倒序） */
  items: PositionAttributionItem[];
  /** 当日最大赢家（无持仓为 null） */
  topWinner: PositionAttributionItem | null;
  /** 当日最大输家（无持仓为 null） */
  topLoser: PositionAttributionItem | null;
}

// ===== 真实持仓 vs 模拟战法绩效对照（只读，不反哺调参）=====

/** 单个模拟战法的对照行 */
export interface VsSimStrategyRow {
  strategyId: string;
  strategyName: string;
  /** 区间累计收益率（%，权益口径） */
  cumReturn: number | null;
  /** 相对沪深300 超额 Alpha（%） */
  alpha: number | null;
  /** 最大回撤（%，负值） */
  maxDrawdown: number | null;
  /** 已实现胜率 */
  winRate: number | null;
  /** 绑定选股策略名（无则 null） */
  screenStrategyName: string | null;
}

/** 真实 vs 模拟绩效对照 */
export interface VsSimReport {
  asOf: string;
  real: {
    /** 总资产 */
    totalAsset: number;
    /** 当日盈亏额 */
    todayProfit: number;
    /** 当日盈亏率（小数） */
    todayRate: number;
    /** 累计持有盈亏额 */
    totalHoldProfit: number;
    /** 最大单一持仓集中度（小数） */
    topConcentration: number;
    /** 持仓数 */
    positionCount: number;
  } | null;
  /** 真实数据缺失原因（如同花顺未配置）；有则 real 为 null */
  realError: string | null;
  /** 各本地模拟战法对照 */
  strategies: VsSimStrategyRow[];
}

// ===== 运维（Ops）·SQLite 体积治理 =====

/** 单张表的运维统计 */
export interface OpsTableStat {
  /** 物理表名 */
  table: string;
  /** 中文展示名 */
  label: string;
  /** 行数 */
  rows: number;
  /** 是否可清理（日志/历史白名单） */
  cleanable: boolean;
  /** 按时间清理依据的时间列名（不可清理为 null） */
  timeColumn: string | null;
  /** 当前保留天数配置（0=不自动清理） */
  retentionDays: number;
}

/** 数据库总览统计（GET /api/ops/stats 返回） */
export interface OpsDbStats {
  /** 数据库文件体积（字节） */
  dbSizeBytes: number;
  /** 所有表总行数 */
  totalRows: number;
  tables: OpsTableStat[];
  /** 自动清理定时是否启用 */
  autoEnabled: boolean;
}

/** 保留策略：表名 -> 保留天数（0/缺省=不自动清理） */
export type RetentionConfig = Record<string, number>;

/** 清理结果（POST /api/ops/cleanup 返回） */
export interface OpsCleanupResult {
  /** 各表删除行数 */
  deleted: Record<string, number>;
  /** 删除总行数 */
  total: number;
  /** 清理后数据库体积（字节） */
  dbSizeBytes: number;
}

// ===== 决策智能体（智能体中枢·智能体，多 agent 辩论引擎角色治理）=====

/** 角色所用模型档位：quick 轻模型 / deep 重模型 */
export type DecisionAgentTier = 'quick' | 'deep';

/** 角色分组（流水线阶段） */
export type DecisionAgentGroup = '分析师' | '辩论' | '交易' | '风控' | '决策';

/** 单个决策角色的展示与配置信息（GET /api/decision/agents 返回项） */
export interface DecisionAgentInfo {
  /** 角色键（如 analyst.fundamental / bull / judge / risk.aggressive / pm） */
  key: string;
  /** 中文名 */
  label: string;
  /** 流水线阶段分组 */
  group: DecisionAgentGroup;
  /** 所用模型档位 */
  tier: DecisionAgentTier;
  /** 引用的预取数据块（仅分析师有，展示用） */
  dataKeys: string[];
  /** 是否可启停（仅 7 个分析师为 true） */
  toggleable: boolean;
  /** 是否启用（不可启停者恒 true） */
  enabled: boolean;
  /** 代码默认职责指令 */
  baseInstruction: string;
  /** 生效职责指令（覆盖优先，回退默认） */
  instruction: string;
  /** 职责指令是否被覆盖 */
  overridden: boolean;
}

/** 决策引擎全局参数（收口散落的 decision_* 元数据） */
export interface DecisionEngineConfig {
  /** 多空辩论轮数（1-3） */
  rounds: number;
  /** 三方风险辩论轮数（1-3） */
  riskRounds: number;
  /** 是否启用风控博弈层 */
  riskEnabled: boolean;
  /** 轻模型（空=回退 llmLightModel→llmModel） */
  quickModel: string;
  /** 重模型（空=回退 llmModel） */
  deepModel: string;
  /** 是否启用舆情/游资定向热点取数 */
  targetedFetch: boolean;
}

/** 可决策股指白名单项（GET /api/decision/indices）；指数走 secid 取数，规避 6 位撞码 */
export interface DecisionIndexInfo {
  /** 稳定主键（历史 refKey / 前端选项 value） */
  key: string;
  /** 指数中文名 */
  name: string;
  /** 东财 secid（市场前缀.代码） */
  secid: string;
}

/** 决策智能体总览（GET /api/decision/agents） */
export interface DecisionEngineOverview {
  agents: DecisionAgentInfo[];
  config: DecisionEngineConfig;
}

/** 角色配置更新入参（PUT /api/decision/agents/:key）；instruction 空串=清除覆盖，enabled 仅对分析师生效 */
export interface DecisionAgentUpdate {
  instruction?: string;
  enabled?: boolean;
}

// ===== 选股引擎（Screener）：多链路（engine），当前内置「多因子三层漏斗」 =====

/** 一条选股链路（engine）的元信息：前端用 id 切 Tab，后端按 id 分发编排 */
export interface ScreenEngineInfo {
  /** 链路 id（如 multifactor），run/config 入参用此引用 */
  id: string;
  /** 链路名（Tab 展示） */
  name: string;
  /** 链路说明 */
  description: string;
  /** 是否可用（规划中链路为 false，前端置灰） */
  enabled: boolean;
}


/**
 * 选股因子键（均可从全市场快照横截面计算，不依赖逐只历史 K 线）：
 * value 估值 / liquidity 流动性 / size 市值 / momentum 动量 / activity 活跃度 / themeHeat 题材热度。
 * 需逐只历史的稳定性/反转因子留作后续（需另接 K 线，避免对全市场 5000 只逐只取数）。
 */
export type ScreenFactorKey =
  | 'midTrend'
  | 'value'
  | 'liquidity'
  | 'size'
  | 'momentum'
  | 'activity'
  | 'themeHeat'
  | 'trend'
  | 'fundFlow'
  | 'dragonRank';

/** 选股因子中文标签（前端展示） */
export const SCREEN_FACTOR_LABELS: Record<ScreenFactorKey, string> = {
  midTrend: '中线趋势',
  value: '估值',
  liquidity: '流动性',
  size: '市值',
  momentum: '动量',
  activity: '活跃度',
  themeHeat: '题材热度',
  trend: '趋势',
  fundFlow: '资金流',
  dragonRank: '龙头分',
};

/** 自然语言选股预设（nl 链路：一段自然语言 keyword 直喂妙想 mx_screener，与战法定时任务同源） */
export interface ScreenNlStrategy {
  id: string;
  name: string;
  /** 预设说明 */
  description: string;
  /** 自然语言选股 keyword（前端「选股口径」展示，亦为战法买入关联的指标口径） */
  keyword: string;
}

/** 选股策略（内置 TS 常量；前端下拉与 agent 入参用 id 引用） */
export interface ScreenStrategy {
  id: string;
  name: string;
  /** 策略说明（短线/中线定位、适用场景） */
  description: string;
  /** 各因子权重（0-1，内部归一化；缺省因子按 0 处理） */
  factorWeights: Partial<Record<ScreenFactorKey, number>>;
  /** 硬筛 + 理想点的人话口径（前端「指标口径」展示，如「成交额≥2亿」「动量理想+4%」） */
  criteria: string[];
  /** 策略周期定位：short 短线（默认）/ mid 中线趋势 */
  horizon?: Horizon;
}

/** 单只候选的某因子得分（0-100，便于前端迷你条/雷达展示） */
export interface ScreenFactorScore {
  key: ScreenFactorKey;
  /** 归一后的因子分 0-100 */
  score: number;
  /** 该因子在加权总分中的贡献（score * 权重，已归一） */
  weight: number;
}

/** 一只选股候选（确定性打分 + 可选 LLM 横向排序产出） */
export interface ScreenPick {
  /** 最终排名（1 起） */
  rank: number;
  code: string;
  name: string;
  /** 选股快照价（T+N 复盘基准） */
  price: number;
  /** 选股时涨跌幅 % */
  pct: number;
  /** 所属行业（东财 f100，缺失为空串） */
  industry: string;
  /** 确定性多因子总分 0-100 */
  screenScore: number;
  /** 各因子分（展示用） */
  factors: ScreenFactorScore[];
  /** LLM 选股逻辑（横向比较后的一句话理由；未跑 LLM 时为 null） */
  thesis: string | null;
  /** 风险标签（LLM 或规则给出，如「高位」「业绩雷」） */
  riskTags: string[];
  /** LLM 信心分 0-100（未跑 LLM 时为 null） */
  confidence: number | null;
  /** 跟踪要点（盘中关注什么；可空） */
  watchItems: string[];
  /** 失效条件（破位/逻辑证伪即放弃；可空） */
  invalidators: string[];
  // ===== T+N 轻量复盘（按需回填）=====
  /** 复盘时最新价（未复盘为 null） */
  evalPrice?: number | null;
  /** 复盘时间 ISO（未复盘为 null） */
  evalAt?: string | null;
  /** 区间收益率 %（evalPrice 相对 price，未复盘为 null） */
  evalReturn?: number | null;
}

/** 一次选股运行的元信息（列表项与详情共用头部） */
export interface ScreenRun {
  id: string;
  /** 产出该次运行的选股链路 id（如 multifactor） */
  engine: string;
  /** 使用的策略 id */
  strategyId: string;
  /** 策略名（落库快照，避免策略改名后丢失） */
  strategyName: string;
  trigger: RunTrigger;
  /** 全市场快照只数（L0） */
  marketCount: number;
  /** 硬筛后候选数（L1） */
  filteredCount: number;
  /** 最终输出 TopN 数 */
  topN: number;
  /** 题材上下文（用户/agent 传入，透传 LLM） */
  context: string | null;
  /** LLM 全局大盘观（未跑 LLM 为 null） */
  marketView: string | null;
  /** LLM 选股总体逻辑（未跑 LLM 为 null） */
  selectionLogic: string | null;
  /** LLM 组合风险提示（未跑 LLM 为 null） */
  portfolioRisk: string | null;
  /** 关联 agent/oneshot 运行 id（计量与运行管理） */
  runId: string | null;
  /** 持有视角：short 短线（默认）/ mid 中线下钻 */
  horizon?: Horizon;
  /** 下钻 universe 来源说明（如「轮动 TopN 强赛道成分股」；全市场为空） */
  universeNote?: string | null;
  createdAt: string;
}

/** 选股运行详情：元信息 + 候选清单 */
export interface ScreenRunDetail extends ScreenRun {
  picks: ScreenPick[];
}

/** 选股链路实时进度阶段（快照→硬筛→打分→二段增强→LLM 横排） */
export type ScreenProgressStage = 'snapshot' | 'filter' | 'score' | 'enrich' | 'rank';

/** 一条选股进度事件（后端逐阶段经 WebSocket 推送，前端展示步进与实时只数） */
export interface ScreenProgressEvent {
  stage: ScreenProgressStage;
  /** 中文阶段名（前端步进条直接展示） */
  label: string;
  status: 'running' | 'done';
  /** 全市场快照只数（snapshot 阶段回填） */
  marketCount?: number;
  /** 硬筛后候选只数（filter 阶段回填） */
  filteredCount?: number;
  /** LLM 候选池只数（score/rank 阶段回填） */
  poolCount?: number;
  /** 运行模式备注（如「盘前模式」「已放宽硬筛」） */
  note?: string;
}

// ===== 结构化市场主线（market_themes 模块）=====

/** 主线状态：active 活跃 / fading 退潮中 / archived 归档 */
export type MarketThemeStatus = 'active' | 'fading' | 'archived';

/** 主线生命周期阶段（由复盘验证回流写入） */
export type ThemePhase = '启动' | '加速' | '分歧' | '退潮' | '未知';

/** 复盘对单条共享主线的验证结论 */
export type ThemeVerdict = '延续' | '加速' | '分歧' | '退潮' | '证伪';

/** 主线信号来源：复盘计划 / 热点雷达 / 研报 */
export type ThemeSource = 'board' | 'review' | 'hotspot' | 'research';

/** 主线证据（逐条留痕，含来源与时间） */
export interface ThemeEvidence {
  source: ThemeSource;
  text: string;
  /** 采集日 YYYY-MM-DD（Asia/Shanghai） */
  at: string;
}

/** 结构化市场主线（把复盘/热点/研报的板块判断统一沉淀） */
export interface MarketTheme {
  id: string;
  /** 主线名（归并键，如「半导体」「机器人」） */
  theme: string;
  /** 关联东财板块代码（可空） */
  boardCode: string | null;
  /** 强度 0-100（多源叠加，越高越强） */
  strength: number;
  status: MarketThemeStatus;
  /** 生命周期阶段（复盘验证回流写入，默认「未知」） */
  phase: ThemePhase;
  /** 命中过的来源集合 */
  sources: ThemeSource[];
  /** 证据要点（最近若干条） */
  evidence: ThemeEvidence[];
  /** 首次出现日 YYYY-MM-DD */
  firstSeenDate: string;
  /** 最近更新日 YYYY-MM-DD（据此判定退潮/归档） */
  lastSeenDate: string;
  /** 主线持续天数（首次出现→最近出现，含端点；越长越是中线主升浪而非一日游） */
  durationDays: number;
  /** 强度趋势（据 strengthHistory 近段对比）：rising 走强 / flat 走平 / falling 走弱 */
  strengthTrend: 'rising' | 'flat' | 'falling';
  /** 强度历史快照（按日去重，最多近 30 日，旧→新），驱动趋势判断与前端走势 */
  strengthHistory: Array<{ date: string; strength: number }>;
  updatedAt: string;
}

/** 主线聚合刷新结果 */
export interface ThemesRefreshResult {
  asOf: string;
  /** 本次写入/更新的主线条数 */
  ingested: number;
  /** 本次转入 fading/archived 的条数 */
  archived: number;
  /** 当前活跃主线总数 */
  activeTotal: number;
}

// ===== 驾驶舱（紧凑概览 + 急停 + 事件时间线）=====

/** 事件来源域 */
export type CockpitEventKind = 'discipline' | 'trade' | 'watch' | 'decision';

/** 统一事件时间线条目（跨模块聚合，确定性只读） */
export interface CockpitEvent {
  /** 复合唯一 id：`${kind}:${原始id}` */
  id: string;
  /** 发生时刻 ISO */
  at: string;
  kind: CockpitEventKind;
  /** 严重度：info 常规 / warn 关注 / high 高优先 */
  severity: 'info' | 'warn' | 'high';
  /** 一行标题 */
  title: string;
  /** 详情 */
  detail: string;
  code?: string | null;
  name?: string | null;
  /** 是否为自动来源（cron/agent/watch 触发的成交）；trade 类事件专用，前端打「自动」徽标 */
  auto?: boolean;
}

/** 驾驶舱当日计划定调（直达计划全文用的轻量摘要） */
export interface CockpitPlanStance {
  /** 计划状态：draft/active/closed */
  status: PlanStatus;
  /** 大盘方向（无 marketStance 时为 null） */
  bias: 'bull' | 'bear' | 'neutral' | null;
  /** 建议仓位 %（无 marketStance 时为 null） */
  positionPct: number | null;
  /** 一句话定调（无 marketStance 时为空串） */
  summary: string;
}

/**
 * 结构化消息催化记录（情报研判落库 → 今日计划读取）：按题材去重，
 * 追踪首次出现/重复次数/是否发酵，供选股识别「起爆前·未发酵」催化主线。
 */
export interface NewsCatalyst {
  id: string;
  /** 题材/板块名（去重键） */
  theme: string;
  /** 催化类型：政策/订单/事件/业绩/资金等（可空） */
  catalystType: string | null;
  /** 受益方向描述（可空） */
  direction: string | null;
  /** 相关标的（代码或名称） */
  codes: string[];
  /** 预计兑现/发酵时间窗描述（可空） */
  catalystWindow: string | null;
  /** 首次出现日 YYYY-MM-DD */
  firstSeenDate: string;
  /** 最近出现日 YYYY-MM-DD */
  lastSeenDate: string;
  /** 累计出现次数 */
  seenCount: number;
  /** 是否已发酵/高位（true=追高风险；false=起爆前未发酵） */
  fermented: boolean;
  /** 已兑现涨幅 %（可空） */
  realizedPct: number | null;
  /** 催化要点/备注（可空） */
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 一键计划编排单步状态：pending 待执行 / running 进行中 / success 成功 / error 失败（尽力而为继续） / skipped 跳过 */
export type OneClickStepState = 'pending' | 'running' | 'success' | 'error' | 'skipped';

/** 一键计划编排单步快照 */
export interface OneClickStepStatus {
  /** 步骤标识：intel/market-board/etf/screener/plan */
  key: string;
  /** 步骤展示名 */
  label: string;
  status: OneClickStepState;
  /** 关联的 taskRun id（选股步为 screen_runs id，可空） */
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** 失败原因（status=error 时） */
  error: string | null;
}

/** 一键计划编排运行态（内存单例快照，供前端轮询渲染管线进度） */
export interface OneClickRunState {
  /** 是否正在运行 */
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  steps: OneClickStepStatus[];
}

/** 写入/更新一条催化记录的入参（按 theme upsert） */
export interface NewsCatalystInput {
  theme: string;
  catalystType?: string | null;
  direction?: string | null;
  codes?: string[];
  catalystWindow?: string | null;
  fermented?: boolean;
  realizedPct?: number | null;
  note?: string | null;
}

/** 驾驶舱模块总结卡：消费各模块【最新一次持久化产出】，秒开展示摘要并可跳全文 */
export interface CockpitModuleSummary {
  /** 模块标识：intel/market-board/review/etf/plan/screener */
  key: string;
  /** 卡片标题 */
  title: string;
  /** 「查看全文」跳转的前端路由 path */
  route: string;
  /** 路由 query（如复盘/情报页的 tab），可空 */
  routeQuery?: Record<string, string>;
  /** 一句话定调/头条（结构化产出可提炼，否则为空串） */
  headline: string;
  /** 摘要正文（首段或截断），无产出时给缺失说明 */
  excerpt: string;
  /** 产出时间 ISO（无产出为 null） */
  createdAt: string | null;
  /** 是否非当日产出（过期需注意时效） */
  stale: boolean;
}

/** 驾驶舱精简选股候选（最新一次选股运行的前若干条，供一屏速览） */
export interface CockpitScreenerPick {
  rank: number;
  code: string;
  name: string;
  /** 确定性多因子分 0-100 */
  screenScore: number;
  /** LLM 横排信心 0-100（未跑 LLM 为 null） */
  confidence: number | null;
  /** 一句话选股逻辑（未跑 LLM 为 null） */
  thesis: string | null;
}

/** 驾驶舱一屏概览：安全状态 + 当日计划兑现 + 强势主线 + 模块总结 + 选股候选 + 事件时间线 */
export interface CockpitOverview {
  asOf: string;
  safety: SafetyState;
  /** 当日计划兑现（无当日计划时为 null） */
  plan: PlanFulfillment | null;
  /** 当日计划定调（无当日计划时为 null），供驾驶舱直达计划全文 */
  planStance: CockpitPlanStance | null;
  /** 强度最高的若干活跃主线 */
  themes: MarketTheme[];
  /** 各模块最新产出摘要卡 */
  modules: CockpitModuleSummary[];
  /** 最新一次选股运行的精简候选（无运行为空数组） */
  screenerPicks: CockpitScreenerPick[];
  /** 合并后的最近事件时间线（按时间倒序） */
  events: CockpitEvent[];
}

// ===== 回测（Backtest）：单标的信号级（阶段一）+ 组合级（阶段二）=====

/** 回测范围：单标的信号 / 多标的组合 */
export type BacktestScope = 'signal' | 'portfolio';

/** 预设策略（白话口径，无需量化知识） */
export type BacktestPreset = 'maTrend' | 'momentum';

/** 预设策略参数（缺省取默认值） */
export interface BacktestParams {
  /** maTrend：快线周期（默认 10） */
  fastPeriod?: number;
  /** maTrend：慢线周期（默认 30） */
  slowPeriod?: number;
  /** momentum：动能回看天数（默认 20） */
  lookback?: number;
  /** momentum：N 日涨幅阈值（%，默认 0 表示创 lookback 新高即入） */
  breakoutPct?: number;
  /** 止损：跌破近 N 日最低价（默认 10） */
  stopLookback?: number;
  /** 盈亏比目标（默认 2） */
  rr?: number;
  /** ATR 移动止盈倍数（>0 启用跟踪止盈骑趋势，默认 0 关闭） */
  atrTrailMult?: number;
}

/** A 股成本口径（bps = 万分之一） */
export interface BacktestCosts {
  /** 佣金（双边，bps），默认 2.5（万 2.5） */
  commissionBps: number;
  /** 单笔最低佣金（元），默认 5 */
  minCommission: number;
  /** 印花税（卖出单边，bps），默认 5（0.05%），映射时折半摊双边近似 */
  stampDutyBps: number;
  /** 过户费（双边，bps），默认 0.1 */
  transferFeeBps: number;
  /** 滑点（bps），默认 2 */
  slippageBps: number;
}

/** 单只系统配置（组合回测用） */
export interface BacktestSystemInput {
  code: string;
  /** 默认配置上限权重（缺省等权） */
  weight?: number;
}

/** 发起回测入参 */
export interface BacktestRunInput {
  /** 默认 signal */
  scope?: BacktestScope;
  /** signal：单标的 6 位代码 */
  code?: string;
  /** portfolio：多标的（与 systems 二选一，systems 优先） */
  codes?: string[];
  /** portfolio：带权重的系统配置 */
  systems?: BacktestSystemInput[];
  /** 仅支持 day / week（日/周线，天然契合 T+1） */
  period?: KlinePeriod;
  /** 取多少根 K 线（默认 500） */
  limit?: number;
  preset: BacktestPreset;
  params?: BacktestParams;
  /** 初始资金（元，默认 100000） */
  equity?: number;
  /** 单笔风险占总资金比例（%，默认 1） */
  riskPct?: number;
  costs?: Partial<BacktestCosts>;
  label?: string;
}

/** 回测核心指标（取引擎子集，前端红涨绿跌渲染） */
export interface BacktestMetricsLite {
  /** 完成的完整持仓笔数 */
  trades: number;
  /** 胜率（0-1） */
  winRate: number;
  /** 盈亏比（总盈利/总亏损） */
  profitFactor: number;
  /** 最大回撤（%，正值） */
  maxDrawdown: number;
  /** 夏普（日频） */
  sharpe: number;
  /** 区间总收益率（%） */
  returnPct: number;
  /** 期末权益 */
  finalEquity: number;
  /** 期初权益 */
  startEquity: number;
}

/** 净值曲线点 */
export interface BacktestEquityPoint {
  /** 交易日 YYYY-MM-DD */
  time: string;
  equity: number;
}

/** 成交腿（K 线买卖点标注 + 流水表） */
export interface BacktestTradeLite {
  symbol: string;
  side: 'long' | 'short';
  entry: number;
  exit: number;
  /** 建仓日 YYYY-MM-DD */
  entryTime: string;
  /** 平仓日 YYYY-MM-DD */
  exitTime: string;
  /** 该笔已实现盈亏（元） */
  pnl: number;
  /** 离场原因（stop / target / trail 等引擎标签） */
  reason: string;
}

/** 单系统绩效（组合回测分解，scope=signal 时为空） */
export interface BacktestSystemMetrics {
  code: string;
  weight: number;
  metrics: BacktestMetricsLite;
}

/** 一次回测的完整结果 */
export interface BacktestRun {
  id: string;
  scope: BacktestScope;
  label: string;
  codes: string[];
  preset: BacktestPreset;
  params: BacktestParams;
  period: KlinePeriod;
  /** 数据区间描述，如 2023-01-03 ~ 2026-06-16（580 根） */
  range: string;
  costs: BacktestCosts;
  metrics: BacktestMetricsLite;
  /** 组合分系统绩效（signal 为空数组） */
  systems: BacktestSystemMetrics[];
  equity: BacktestEquityPoint[];
  trades: BacktestTradeLite[];
  /** 口径 / 近似说明（前端提示） */
  notes: string[];
  createdAt: string;
}

/** 列表项（不含曲线 / 流水，省带宽） */
export interface BacktestRunListItem {
  id: string;
  scope: BacktestScope;
  label: string;
  codes: string[];
  preset: BacktestPreset;
  period: KlinePeriod;
  range: string;
  metrics: BacktestMetricsLite;
  createdAt: string;
}
