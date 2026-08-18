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

/**
 * 一手 = 100 股。各行情源 volume 口径不一（新浪/mootdx 给「股」、东财 f56/腾讯给「手」），
 * 换算系数必须走这个常量，避免字面量 100 散落在各解析层后被单独改掉。
 */
export const SHARES_PER_LOT = 100;

/** 单根 K 线（前复权） */
export interface KlineBar {
  /** 交易日 YYYY-MM-DD */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /**
   * 成交量，单位固定为「手」（1 手 = SHARES_PER_LOT 股）。
   * 返回「股」的源（新浪、mootdx）必须在自己的解析层除以 SHARES_PER_LOT 后再落库；
   * 返回「手」的源（腾讯、东财 f56）不得再除。混单位会让量比与成交量中位数整体差 100 倍。
   */
  volume: number;
  /** 成交额（元）；部分源日线不返回成交额（腾讯 fqkline、新浪），此时为 0 */
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
  /**
   * 这份分时所属的交易日 YYYY-MM-DD（数据源给的，取不到时缺省）。
   * 消费方不要拿「今天」补日期：周末/节假日打开时那份分时其实是上一交易日的。
   */
  tradeDate?: string;
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

/** 驾驶舱关注标的（用户自维护，独立于自选股；含实时报价） */
export interface CockpitFocusItem {
  code: string;
  name: string;
  note: string | null;
  /** 手动排序位，越小越靠前 */
  sortOrder: number;
  createdAt: string;
  quote: StockQuote | null;
}

/** 新增驾驶舱关注标的入参 */
export interface CockpitFocusInput {
  code: string;
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

/**
 * S9 技术指标库：量能读数（「这只标的今天是不是放量」的显式数值）。
 *
 * 两套口径不可混用：收盘后用「当日成交额 ÷ 前 20 日成交额中位数」，
 * 盘中日 K 未收完时该比值会系统性偏低，改用东财实时量比（已按时间折算，本身可比）。
 */
export interface VolumeReadout {
  /** 量比数值 */
  ratio: number;
  /**
   * 口径来源。`volume_median20` 仅在「本源根本不返回成交额」（腾讯 fqkline 日线、新浪）时启用；
   * 若是窗口内成交额样本不足（疑似停牌），本读数直接为 null 而不换口径复活。
   */
  basis: 'amount_median20' | 'volume_median20' | 'realtime';
  /** 七档定性（两种口径各有一套阈值，标签字典共用） */
  state: VolumeState;
  /** 可直接渲染的中文标签，消费方无须自带阈值或字典 */
  label: string;
  /** 换手率 %，ETF 与缺失为 null */
  turnoverRate: number | null;
  /** 口径回退/降级等提示，供前端显式展示；无提示时省略 */
  warnings?: string[];
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
  /** 量能读数；数据不足或盘中取不到实时量比时为 null */
  volume: VolumeReadout | null;
  note: string;
}

/** S10 点位测算：主导波段（摆动高低点） */
export interface SwingRange {
  /** 波段方向：up=先低后高（回撤位在下方，看支撑）/ down=先高后低（回撤位在上方，看压力） */
  direction: 'up' | 'down';
  /** 波段高点价 */
  high: number;
  /** 波段低点价 */
  low: number;
  /** 高点所在日期 */
  highTime: string;
  /** 低点所在日期 */
  lowTime: string;
}

/** S10 点位测算：单个斐波那契点位 */
export interface FibLevel {
  /** 比例标签，如 '38.2%'、'161.8%' */
  ratio: string;
  /** 该比例对应价位 */
  price: number;
}

/** S10 点位测算：经典枢轴点（据上一根 H/L/C） */
export interface PivotLevels {
  pp: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
}

/** S10 点位测算：多周期均线结构 */
export interface MaStructure {
  /** 各周期 SMA 值（数据不足的周期不返回） */
  values: Array<{ period: number; value: number }>;
  /** 均线排列：短周期在长周期上方=多头，反之空头，否则纠缠 */
  alignment: '多头排列' | '空头排列' | '纠缠';
  /** 距现价最近的上方压力均线（无则 null） */
  resistanceMa: { period: number; value: number } | null;
  /** 距现价最近的下方支撑均线（无则 null） */
  supportMa: { period: number; value: number } | null;
}

/** S10 点位测算：斐波那契/摆动高低点/ATR/枢轴点/多周期均线，喂走势研判 agent（确定性、不含主观预测） */
export interface PriceLevels {
  code: string;
  asOf: string;
  /** 最新收盘 */
  close: number;
  /** K 线周期 */
  period: KlinePeriod;
  /** 主导波段（摆动高低点）；数据不足为 null */
  swing: SwingRange | null;
  /** 斐波那契回撤位（波段内 23.6/38.2/50/61.8/78.6%） */
  fibRetracements: FibLevel[];
  /** 斐波那契扩展位（顺势目标 127.2/161.8%） */
  fibExtensions: FibLevel[];
  /** ATR(14) 绝对值 */
  atr: number | null;
  /** ATR% =ATR/收盘×100 */
  atrPct: number | null;
  /** 经典枢轴点 */
  pivot: PivotLevels | null;
  /** 多周期均线结构 */
  ma: MaStructure | null;
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

/** 股指主力资金流：单日读数（主力净流入单位「亿」，红涨绿跌） */
export interface IndexFundFlowDay {
  /** 交易日 YYYY-MM-DD */
  date: string;
  /** 主力净流入额（亿，正为净流入） */
  main: number;
  /** 当日指数涨跌幅 % */
  pct: number;
}

/** 股指主力资金流：单个指数的多日序列（升序 旧→新，取数失败 days 为空数组） */
export interface IndexFundFlow {
  code: string;
  name: string;
  /** 东财 secid（市场前缀.代码），用于开 K 线 */
  secid: string;
  days: IndexFundFlowDay[];
}

/** 股指主力资金流：大盘页面板数据（7 个主要股指近 N 日主力净流入趋势） */
export interface IndexFundFlowResult {
  /** 数据时间 ISO */
  asOf: string;
  items: IndexFundFlow[];
}

// ===== 宏观·资金面底稿（低频全局指标：日频/EOD，与实时盘面分离）=====
// 各块 best-effort，上游失败为 null。note=该指标的「影响力 + 如何使用」固定说明，
// 同时用于 UI 展示与注入 agent prompt。统一定性为「环境/背景/护栏」，非择时信号。

/** 单个股指期货基差项（期货主连 vs 对应现货指数） */
export interface MacroBasisItem {
  /** 品种名，如 IF·沪深300 */
  name: string;
  /** 期货主连最新收盘 */
  future: number;
  /** 对应现货指数最新点位 */
  spot: number;
  /** 基差 = 期货 − 现货（负=贴水，正=升水） */
  basis: number;
  /** 基差率 % = 基差 / 现货 * 100 */
  basisPct: number;
}

/** 股指期货基差（IF/IH/IC/IM） */
export interface MacroBasis {
  /** 数据时间（期货主连日线最新日） */
  asOf: string;
  items: MacroBasisItem[];
  note: string;
}

/** 资金面利率（SHIBOR 隔夜/1周） */
export interface MacroShibor {
  /** 报价日 */
  date: string;
  /** 隔夜 O/N（%） */
  overnight: number | null;
  /** 1 周（%） */
  week1: number | null;
  note: string;
}

/** 最近一次降准（存款准备金率） */
export interface MacroRrr {
  /** 公布时间 */
  announceDate: string;
  /** 生效时间 */
  effectiveDate: string;
  /** 大型金融机构调整后比率（%） */
  bigBankAfter: number | null;
  /** 调整幅度（%，负=降准） */
  bigBankDelta: number | null;
  note: string;
}

/** 两融余额（融资余额合计 + 近期趋势） */
export interface MacroMargin {
  /** 信用交易日期 */
  date: string;
  /** 融资余额合计（亿元，含沪深可得部分） */
  financeBalance: number;
  /** 覆盖范围说明（如 沪市 / 沪深合计） */
  scope: string;
  /** 较上一交易日变化（亿元；不可得为 null） */
  changeAmount: number | null;
  /** 近 N 日趋势 */
  trend: '上升' | '下降' | '走平';
  note: string;
}

/** 南向资金（港股通净流入） */
export interface MacroSouthbound {
  /** 交易日 */
  date: string;
  /** 南向净流入（亿元，沪+深港股通成交净买额合计） */
  netInflow: number;
  note: string;
}

/** 沪深300 估值分位（滚动市盈率历史分位） */
export interface MacroValuation {
  /** 数据日 */
  date: string;
  /** 当前滚动市盈率 */
  pe: number;
  /** 历史分位 0-100（越低越便宜） */
  percentile: number;
  note: string;
}

/** 单品种股指期货持仓（中信单家 + 前20席位合计，含日增减） */
export interface CffexVarietyRank {
  /** 品种代码 IF/IH/IC/IM */
  variety: string;
  /** 展示名（如 IF·沪深300） */
  name: string;
  /** 中信期货持买单量合计 */
  citicLong: number;
  /** 中信期货持卖单量合计 */
  citicShort: number;
  /** 中信净持仓（持买−持卖；负=偏空） */
  citicNet: number;
  /** 中信净持仓日增减 */
  citicNetChg: number;
  /** 前20席位持买单量合计 */
  top20Long: number;
  /** 前20席位持卖单量合计 */
  top20Short: number;
  /** 前20席位净持仓 */
  top20Net: number;
  /** 前20席位净持仓日增减 */
  top20NetChg: number;
}

/** 中金所股指期货持仓榜（前20会员持仓排名） */
export interface MacroCffexRank {
  /** 交易日 YYYY-MM-DD */
  date: string;
  items: CffexVarietyRank[];
  note: string;
}

/** 美股行业/主题 ETF（一只 ETF = 一个板块代理）隔夜行情 + A股映射桥接 */
export interface UsSectorEtf {
  /** ETF 名称（东财 f58） */
  name: string;
  /** 东财 secid，如 105.SMH */
  secid: string;
  /** 隔夜涨跌幅 % */
  pct: number;
  /** 主题大类，如 半导体/AI算力 */
  theme: string;
  /** 对应 A股概念名（供消费 agent 关联真实板块） */
  aConcept: string;
  /** 对应 A股 ETF（代码+名） */
  aEtfs: { code: string; name: string }[];
}

/** 美股映射总览（隔夜美股行业/主题 ETF 排名 → A股概念·ETF 桥接） */
export interface UsMappingOverview {
  /** 数据时间 ISO */
  asOf: string;
  /** 按隔夜涨跌幅降序排列的美股板块 ETF（含 A股桥接） */
  sectors: UsSectorEtf[];
  note: string;
}

/** 宏观·资金面总览（各块可选，分块容错；失败为 null） */
export interface MacroOverview {
  /** 数据时间 ISO */
  asOf: string;
  basis: MacroBasis | null;
  shibor: MacroShibor | null;
  rrr: MacroRrr | null;
  margin: MacroMargin | null;
  southbound: MacroSouthbound | null;
  valuation: MacroValuation | null;
  cffexRank: MacroCffexRank | null;
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
  /** 晋级门体检（统计显著性；只体检不自动晋级） */
  gate: PromotionGateResult;
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
  /**
   * 取价失败：price 退回了成本价，holdProfit/holdRate 被置 0 而非真实盈亏。
   * 运行态标记（每次取价现算），不落库；消费方应把这类持仓标灰并拒绝当作权益样本。
   */
  priceStale?: boolean;
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
  /** 任一持仓取价失败：本快照的盈亏/总资产不可信，不得作为当日权益样本落库 */
  priceStale?: boolean;
  /** 取价失败的标的代码 */
  stalePriceCodes?: string[];
}

/**
 * 历史持仓（按标的汇总复盘）：每个曾持有的标的一行，全历史加权均价 + 首买/末卖时间。
 * 用于「卖飞/卖对」复盘：卖出后至今收益 = 现价/均卖价-1（正=卖飞少赚、负=躲跌卖对）。
 */
export interface StrategyHistoryItem {
  code: string;
  name: string;
  /** holding 持有中 / closed 已清仓 */
  status: 'holding' | 'closed';
  /** 累计买入股数 */
  buyQty: number;
  /** 加权平均买入价 */
  avgBuyPrice: number;
  /** 累计卖出股数 */
  sellQty: number;
  /** 加权平均卖出价（从未卖出为 null） */
  avgSellPrice: number | null;
  /** 当前持有数量（买-卖） */
  currentQty: number;
  /** 现价（取数失败为 null） */
  currentPrice: number | null;
  /** 已实现盈亏（卖出笔 realizedProfit 合计） */
  realizedProfit: number;
  /** 持有收益 = 已实现 + 持有中浮盈（持有量×(现价-均买价)） */
  holdProfit: number;
  /** 持有收益率（对累计买入额），无买入为 null */
  holdProfitRate: number | null;
  /** 卖出后至今收益 %（已清仓且有现价：现价/均卖价-1），否则 null */
  postSellReturn: number | null;
  /** 首买 / 末买 交易日 YYYY-MM-DD */
  firstBuyDate: string | null;
  lastBuyDate: string | null;
  /** 首卖 / 末卖 交易日 YYYY-MM-DD */
  firstSellDate: string | null;
  lastSellDate: string | null;
}

/**
 * 战法列表项：基础信息 + 账户汇总。
 * 快照取失败时不编造数字：totalProfit / totalProfitRate / positionCount 一律为 null，
 * 由 snapshotError 说明原因，前端渲染「—」+ 错误角标。旧行为（补 0）会让「持有 5 只、
 * 浮亏 8%」的战法在取价失败时显示成「+0.00 (0.00%)、0 持仓」。
 */
export interface StrategyListItem {
  strategy: Strategy;
  /** 总资产。取失败时退回本地库里的现金（确定值），并置 snapshotError */
  totalAsset: number;
  /** 总收益；快照取失败为 null */
  totalProfit: number | null;
  /** 总收益率；快照取失败为 null */
  totalProfitRate: number | null;
  /** 持仓只数；快照取失败为 null */
  positionCount: number | null;
  /** 快照取失败原因：非空表示本卡片的数字不完整，不得作为权益样本 */
  snapshotError?: string;
}

/** 聊天会话 */
export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 绑定标的代码：非空表示这是某标的的专属长期跟踪会话（K 线详情弹窗内的对话栏） */
  refCode?: string | null;
  /** 绑定标的名称 */
  refName?: string | null;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

// ===== 标的 K 线标注（agent 在对话中打点，长期留存供跟踪复核）=====

/**
 * 标注形态：
 * - `price_line` 水平价位线或价格带（支撑/压力/目标价/止损位），仅需 price：
 *   1 个点画一条线，2 个点画下沿到上沿的价格带（计划里的区间型关键位走这条）
 * - `point` 单 K 线点位标记（某日买卖点/关键事件），1 个点，需 time + price
 * - `range` 时间区间（主升浪/横盘区），2 个点，各需 time + price
 * - `trend_line` 趋势线/线段，2 个点，各需 time + price
 */
export type SymbolMarkKind = 'price_line' | 'point' | 'range' | 'trend_line';

/** 标注点位：日/周/月 K 用 `YYYY-MM-DD`，分钟级用 `YYYY-MM-DD HH:mm` */
export interface SymbolMarkPoint {
  time?: string | null;
  price?: number | null;
}

/** 标注有效状态：active 当前有效 / invalid 已失效（变灰保留） / historical 历史版本 */
export type SymbolMarkStatus = 'active' | 'invalid' | 'historical';

export interface SymbolMark {
  id: string;
  code: string;
  kind: SymbolMarkKind;
  /** 图上显示的短标签 */
  label: string;
  /** 详细理由，鼠标悬浮与标注清单展示 */
  note?: string | null;
  points: SymbolMarkPoint[];
  /** 覆盖默认配色（十六进制），留空按 kind 取默认色 */
  color?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  createdAt: string;
  /** 计划标注的语义键（如 plan.support.0），手工标注为空 */
  semanticKey?: string | null;
  /** 所属周期；price_line 可跨周期展示，其余只在所属周期展示 */
  timeframe?: KlinePeriod | null;
  /** support/resistance/entry/stop/target/structure */
  role?: string | null;
  planId?: string | null;
  planVersion?: number | null;
  status?: SymbolMarkStatus | null;
  invalidatedAt?: string | null;
}

export interface SymbolMarkInput {
  code: string;
  kind: SymbolMarkKind;
  label: string;
  note?: string | null;
  points: SymbolMarkPoint[];
  color?: string | null;
  sessionId?: string | null;
  runId?: string | null;
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

/** 赛道资讯：单个赛道定义（吸收 investment-news 12 赛道，源经 TrendRadar RSS 抓取） */
export interface SectorDef {
  /** 赛道 id（ai/semi/robot/auto/energy/bio/space/security/tech/consumer/macro/science） */
  id: string;
  /** 赛道中文名 */
  label: string;
  /** 该赛道配置的源数量 */
  feedCount: number;
}

/** 赛道资讯：单条文章（在 TrendRssItem 上附赛道归属） */
export interface SectorRssItem extends TrendRssItem {
  /** 所属赛道 id */
  sector: string;
}

/** 赛道资讯：单赛道「今日要点」AI 提炼结果 */
export interface SectorDigest {
  sector: string;
  /** Markdown 正文（3-5 条要点 + 翻译 + 溯源） */
  content: string;
  createdAt: string;
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

/** 大V观点支持的平台 */
export type KolPlatform = 'weibo' | 'xiaohongshu';

/** 关注的大V账号（名单在「大V观点」页维护） */
export interface KolAccount {
  /** 微博 UID（纯数字）/ 小红书 userId（24 位 hex），两个 ID 空间不重叠 */
  uid: string;
  platform: KolPlatform;
  /** 昵称 */
  screenName: string;
  /** 小红书号（与 userId 是两套 ID），仅小红书有，用于和 App 里的账号核对 */
  redId?: string;
  /** 头像 URL */
  avatar: string;
  /** 微博认证信息（如「深圳东方港湾投资管理股份有限公司董事长」）/ 小红书个人简介，无则空串 */
  verifiedReason: string;
  /** 粉丝数展示串（微博「1313.3万」、小红书「1万+」，原样透传） */
  followersCount: string;
  /** 是否参与定时抓取 */
  enabled: boolean;
  addedAt: string;
}

/** 博文配图（已下载到本地，src 为站内地址） */
export interface KolImage {
  /** 站内可直接访问的地址，形如 /media/kol/202607/<file>.jpg */
  src: string;
  /** 原图宽高，供前端预留位置避免加载时抖动；未知为 0 */
  width: number;
  height: number;
}

/** 单条大V博文 / 小红书笔记 */
export interface KolPost {
  /** 微博 bid / 小红书 noteId（业务主键，前端 key 与去重用） */
  bid: string;
  /** 作者 UID */
  uid: string;
  platform: KolPlatform;
  screenName: string;
  avatar: string;
  /** 已清洗的正文（微博长文为补拉后的全文；小红书为「标题\n\n正文」） */
  text: string;
  /** 发布时间（ISO 字符串）；小红书降级记录为首次入库时间 */
  createdAt: string;
  /** 原文链接 */
  url: string;
  /** 是否转发他人博文（小红书恒 false） */
  isRetweet: boolean;
  /** 被转发的原文（含原作者），非转发为 null */
  retweetText: string | null;
  reposts: number;
  comments: number;
  attitudes: number;
  /** 笔记配图（已缓存到本地）。小红书大量信息画在图里，正文往往只是引子 */
  images?: KolImage[];
  /** 仅有标题的降级记录（小红书未配置 Cookie 时，拿不到正文与发布时间） */
  titleOnly?: boolean;
  /** 正文是否为长文（截断后需补拉全文），落库后不再关心 */
  isLongText?: boolean;
  /** 是否置顶帖（置顶时间可能是很久以前，抓取时按此过滤旧帖） */
  isTop?: boolean;
}

/** 大V候选项（微博为搜索结果，小红书为主页链接/分享短链解析结果） */
export interface KolSearchResult {
  uid: string;
  /** 省略时按微博处理，保持旧调用方兼容 */
  platform?: KolPlatform;
  /** 小红书号，仅小红书候选项有 */
  redId?: string;
  screenName: string;
  avatar: string;
  /** 粉丝数展示串 */
  followersCount: string;
  /** 认证信息 / 个人简介，用于辨别真身与同名号 */
  verifiedReason: string;
}

/** 大V观点抓取结果概要 */
export interface KolRefreshResult {
  /** 本轮扫描的大V数 */
  accounts: number;
  /** 新增入库的博文数 */
  inserted: number;
  /** 抓取失败的大V昵称（单个失败不阻断整轮） */
  failed: string[];
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

// ===== 大盘阶段（Market Regime，确定性只读，不下单/不调 LLM）=====

/** 大盘阶段：主升（重仓进攻）/ 反弹（控仓快打）/ 退潮（降频防守）/ 震荡（观望精选） */
export type MarketRegimePhase = '主升' | '反弹' | '退潮' | '震荡';

/** 明日/近期方向倾向（只给方向，不伪装点位预测） */
export type MarketRegimeBias = '偏强' | '偏弱' | '中性';

/** 建议交易频率 */
export type MarketRegimeFrequency = '积极' | '正常' | '降低' | '观望';

/** 单个权重指数的结构读数（用于多指数共振判定） */
export interface MarketRegimeIndexItem {
  /** 指数名（如 上证指数 / 沪深300 / 创业板指） */
  name: string;
  /** 东财 secid（如 1.000001） */
  secid: string;
  /** 最新收盘 */
  close: number;
  /** 均线排列（多头/空头/纠缠） */
  alignment: MaStructure['alignment'];
  /** 是否站上 MA20 */
  aboveMa20: boolean;
  /** 是否站上 MA60 */
  aboveMa60: boolean;
  /** MA20 是否走平转上（近 5 日斜率为正） */
  ma20SlopeUp: boolean;
  /** 近 20 日涨跌幅 %（趋势方向） */
  trendPct20: number;
}

/** 等权口径读数（880008 全A等权 优先，取不到回退宽度代理） */
export interface MarketRegimeEqualWeight {
  /** 数据来源：880008 全A等权 / 东财等权指数 / 宽度代理 */
  source: 'tdx880008' | 'em' | 'breadth';
  /** 口径名（如 全A等权880008 / 沪深300等权 / 上涨家数占比代理） */
  name: string;
  /** 是否站上 MA60（宽度代理时用占比阈值近似） */
  aboveMa60: boolean;
  /** 近 20 日涨跌幅 %（宽度代理时为占比变化近似） */
  trendPct20: number;
  /** 成分股上涨占比 %（880008 自带 up/down 家数；宽度代理直读） */
  upRatio: number | null;
}

/** 单维度打分明细（原始分 + 白话解读 + 关键证据，供面板逐维展示） */
export interface MarketRegimeDimension {
  /** 维度键 */
  key: string;
  /** 展示名 */
  label: string;
  /** 原始得分 0-100（该维度自身强弱，未加权） */
  rawScore: number;
  /** 权重（%） */
  weight: number;
  /** 对综合分的贡献点数（加权重归一后，合计≈score） */
  contribution: number;
  /** 白话解读（不需量化知识） */
  reading: string;
  /** 关键证据数值（供核对） */
  evidence: string;
}

/** 权重 vs 等权背离信号（区分护盘失真 vs 真普涨的关键） */
export interface MarketRegimeDivergence {
  /** 是否存在明显背离（权重强而等权弱=护盘失真） */
  active: boolean;
  /** 白话说明 */
  note: string;
}

/** 大盘阶段总览（确定性合成 + 白话建议，仅供参考不构成投资建议） */
export interface MarketRegimeOverview {
  /** 数据时刻 ISO */
  asOf: string;
  /** 交易日 YYYY-MM-DD（Asia/Shanghai） */
  tradeDate: string;
  /** 当前阶段 */
  phase: MarketRegimePhase;
  /** 综合强度分 0-100（越高越偏进攻） */
  score: number;
  /** 明日/近期方向倾向 */
  tomorrowBias: MarketRegimeBias;
  /** 建议交易频率 */
  suggestedFrequency: MarketRegimeFrequency;
  /** 建议仓位区间（白话，如 "60-90%"） */
  positionRange: string;
  /** 上一交易日阶段（无历史为 null） */
  prevPhase: MarketRegimePhase | null;
  /** 已连续处于当前阶段的交易日数（含今日，>=1） */
  consecutiveDays: number;
  /** 较上一交易日的分数变动（无历史为 null） */
  delta: number | null;
  /** 各维度贡献拆解（可审计，合计≈score；向后兼容徽标用） */
  breakdown: StrengthBreakdown;
  /** 六维度打分明细（原始分 + 白话解读 + 证据，供完整面板逐维展示） */
  dimensions: MarketRegimeDimension[];
  /** 明日及后续一段时间走势展望（确定性模板文字） */
  outlook: string;
  /** 关键正向驱动因素 */
  drivers: string[];
  /** 关键风险提示 */
  risks: string[];
  /** 参与判定的权重指数明细 */
  indices: MarketRegimeIndexItem[];
  /** 等权口径读数（取不到为 null） */
  equalWeight: MarketRegimeEqualWeight | null;
  /** 权重 vs 等权背离信号 */
  divergence: MarketRegimeDivergence;
  /** 白话操作建议（不需量化知识） */
  advice: string;
  /** 备注 */
  note: string;
  /** 是否有数据源降级（部分维度缺失，结论为不完整估计） */
  stale: boolean;
  /** HMM 影子信号（隐马尔可夫概率视角，best-effort，取不到为 null；摘要路径不填） */
  hmm?: MarketRegimeHmm | null;
}

/** HMM 单个隐状态的统计画像（训后按均值收益排序赋名） */
export interface MarketRegimeHmmState {
  /** 状态名：强势 / 震荡 / 弱势 */
  name: '强势' | '震荡' | '弱势';
  /** 该状态历史天数 */
  days: number;
  /** 该状态年化收益 %（缺失为 null） */
  annRet: number | null;
  /** 该状态年化波动 %（缺失为 null） */
  annVol: number | null;
}

/**
 * 大盘阶段 HMM 影子信号（隐马尔可夫概率视角，与规则四态并列、相互印证）。
 * sidecar 在全A等权(880008)日线上现训 GaussianHMM，纯确定性、不调 LLM，取不到为 null。
 */
export interface MarketRegimeHmm {
  /** 数据日 YYYY-MM-DD */
  asOf: string;
  /** 当前最可能隐状态：强势 / 震荡 / 弱势 */
  state: '强势' | '震荡' | '弱势';
  /** 最新一日三态后验概率（%，合计≈100） */
  probs: { 强势: number; 震荡: number; 弱势: number };
  /** 强弱读数 0-100（强势概率−弱势概率归一，越高越偏进攻，供与规则 score 对照） */
  strength: number;
  /** 各隐状态画像（从弱到强） */
  perState: MarketRegimeHmmState[];
  /** 状态转移矩阵（行=当前态，列=次态概率） */
  transition: number[][];
  /** 实际训练用有效样本数（交易日） */
  window: number;
  /** 隐状态数 */
  nStates: number;
  /** 训练标的（默认 880008 全A等权） */
  symbol: string;
}

/** 大盘阶段历史点（趋势图用） */
export interface MarketRegimeHistoryItem {
  tradeDate: string;
  phase: MarketRegimePhase;
  score: number;
  tomorrowBias: MarketRegimeBias;
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

/**
 * 主线生命周期阶段（ETF 中线口径的四阶段；与 verdict 一一对应但语义面向操作）：
 *  - none 未入场景（未达数量级地板）
 *  - brewing 酝酿（已达标，但跨日确认未完成：居首天数不够或核心股换了一批）
 *  - advancing 主升（跨日确认成立：确认门槛 + 稳居榜首 + 核心股延续）
 *  - diverging 分歧（曾确认，现掉了部分条件但仍达地板）
 *  - fading 退幕（曾主线，现掉地板 / 跌出榜首 / 新高数腰斩）
 *
 * ETF 层面不单列「高潮」阶段：ETF 波动与换手远低于个股，题材分冲高那套个股口径搬过来没有意义，
 * 过热应由个股/ETF 自身的超买与成交额分位判断，不由板块宽度阶段承担。
 */
export type BoardMainlineStage = 'none' | 'brewing' | 'advancing' | 'diverging' | 'fading';

/**
 * 阶段允许的开仓动作（硬路由）。
 * 关键约束：阶段只用于「收紧」——禁止开新仓、强制只减不加，绝不用于放大仓位。
 * 因为阶段判定天然滞后（主升/分歧只能事后确认），拿滞后信号去加码会系统性地在高位加仓。
 */
export type BoardStageAction = 'none' | 'probe' | 'lead' | 'hold_only' | 'exit_only';

/** 核心股延续度：今日与上一交易日「板块内创新高个股集合」的重叠情况 */
export interface CoreContinuity {
  /** 重叠只数 */
  kept: number;
  /** 上一交易日核心股只数（无历史为 0） */
  prevCount: number;
  /** 重叠率 = kept / min(今日, 上日)，无历史或历史无该字段为 null（未知不阻断确认） */
  overlap: number | null;
}

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
  /** 生命周期阶段（与 verdict 同源，面向操作语义） */
  stage: BoardMainlineStage;
  /** 该阶段允许的开仓动作（硬路由，只收紧不放大） */
  stageAction: BoardStageAction;
  /** 核心股延续度（跨日确认要看「还是不是同一批股」） */
  continuity: CoreContinuity;
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

// ===== 热门细分概念（同花顺概念资金流热度榜 + 主线主题归纳，确定性只读，不下单/不调 LLM）=====
// 数据源：同花顺「概念资金流·近N日排行」(akshare stock_fund_flow_concept)，默认近 5 日。
// 热度 = 近 N 日涨幅 + 资金净额 两维归一加权（同花顺无成分接口，不含新高宽度维）。

/** 热门概念时间窗口（近几日口径，映射同花顺概念资金流 N日排行） */
export type ConceptWindow = '3日' | '5日' | '10日' | '20日';

/** 单个细分概念的热度评估项 */
export interface HotConceptItem {
  /** 概念名（如 玻璃基板/六氟化钨；作为唯一键，同花顺资金流不返回板块代码） */
  boardName: string;
  /** 当日涨跌幅 % */
  pct: number;
  /** 资金净额（亿元，主力净流入口径；取不到为 null） */
  netInflow: number | null;
  /** 公司家数（成分股数量；取不到为 null） */
  companies: number | null;
  /** 综合热度分 0-100（当日涨幅 + 资金净额 组内归一加权） */
  heatScore: number;
  /** 归纳到的父级主线主题（如 半导体/AI算力/通信；未命中为「其他」） */
  theme: string;
  /** 今日领涨股名（同花顺口径，今日涨幅最高成分股；无代码故不可点击） */
  leadStock: string;
  /** 今日领涨股涨跌幅 %（取不到为 null） */
  leadStockPct: number | null;
  /** 一句话说明 */
  note: string;
}

/** 按主线主题归纳的细分概念分组（组内按热度降序） */
export interface HotConceptGroup {
  /** 父级主线主题 */
  theme: string;
  /** 组内细分概念（按热度分降序） */
  items: HotConceptItem[];
  /** 组内最高热度分（用于主题间排序） */
  topHeat: number;
}

/** 热门细分概念总览（确定性热度 + 主题归纳） */
export interface HotConceptOverview {
  /** 数据时刻 ISO */
  asOf: string;
  /** 交易日 YYYY-MM-DD（Asia/Shanghai） */
  tradeDate: string;
  /** 当前时间窗口（近几日口径，默认 5日） */
  window: ConceptWindow;
  /** 按主题归纳的分组（按组内最高热度降序） */
  groups: HotConceptGroup[];
  /** 按热度分降序的扁平榜（top-N） */
  flat: HotConceptItem[];
  /** 备注 */
  note: string;
  /** 数据源降级（涨幅/资金取数失败时为 true，榜为不完整估计） */
  stale: boolean;
}

/** 概念成分股（点击概念展开，经问财取板块内全部标的，标注龙头/今日领涨） */
export interface ConceptStockItem {
  /** 6 位代码 */
  code: string;
  /** 名称 */
  name: string;
  /** 最新价（取不到为 null） */
  price: number | null;
  /** 当日涨跌幅 %（取不到为 null） */
  pct: number | null;
  /** 总市值（亿元，取不到为 null；用于判龙头） */
  marketCap: number | null;
  /** 是否板块龙头（总市值最大） */
  isLeader: boolean;
  /** 是否今日领涨（当日涨幅最高） */
  isTopGainer: boolean;
}

/** 概念成分股展开结果（点击概念后按需加载） */
export interface ConceptStocksResult {
  /** 概念名 */
  concept: string;
  /** 成分股（默认按总市值降序，龙头在前） */
  stocks: ConceptStockItem[];
  /** 数据时刻 ISO */
  asOf: string;
  /** 备注（含取数源/降级说明） */
  note: string;
}

// ===== 主线共识（跨源对齐：breadth 确定性判定 ⋈ themes 多源协同 ⋈ radar 中线趋势）=====

/** 三方共识档：resonance 共振（同向）/ diverge 分歧（背离）/ watch 观察（仅锚成立） */
export type MainlineConsensusLevel = 'resonance' | 'diverge' | 'watch';

/** 单条主线的三源对齐结果（以 breadth 新高宽度为确定性锚） */
export interface MainlineConsensusItem {
  /** 东财板块代码 BKxxxx（来自 breadth 锚板块，作跨源/跨页稳定 join key；取不到为 null） */
  boardCode: string | null;
  /** 板块名（以 breadth 锚板块为准） */
  board: string;
  /** 对应代表 ETF（无映射为 null） */
  etf: { code: string; name: string } | null;
  // —— breadth（确定性硬证据，权重最高）——
  breadthVerdict: BoardBreadthVerdict | null;
  /** 生命周期阶段（来自 breadth 锚，决定允许动作） */
  breadthStage: BoardMainlineStage | null;
  /** 阶段允许的开仓动作（硬路由） */
  breadthAction: BoardStageAction | null;
  /** 核心股跨日延续度（overlap=null 表示历史快照尚无该字段） */
  continuity: CoreContinuity | null;
  newHighCount: number | null;
  topDays: number | null;
  // —— themes（多源协同度）——
  themeStrength: number | null;
  themeTrend: 'rising' | 'flat' | 'falling' | null;
  themePhase: string | null;
  // —— radar（中线趋势强度）——
  radarTrend: TrendState | null;
  radarStrength: number | null;
  /** 三方共识判定 */
  consensus: MainlineConsensusLevel;
  /** 一行人话说明（拼三源结论） */
  note: string;
}

/** 主线共识总览（决策层聚合，仅研判不下单） */
export interface MainlineConsensus {
  asOf: string;
  items: MainlineConsensusItem[];
  note: string;
}

// ===== 板块主线作战台（board workbench：buildMainlineConsensus 的决策视图投影 + 派生操盘标签）=====
// 不新造板块判断源：阶段/强度/趋势/ETF/共识直接投影自 MainlineConsensusItem；
// actionTag / cycleFit / riskTags 为派生操盘标签；以 boardCode 为跨源/跨页稳定键。

/** 统一操盘动作标签（首页作战台 / 板块卡片 / 持仓暴露共用） */
export type BoardActionTag = '观察' | '试错' | '持有' | '加仓候选' | '减仓' | '回避' | '等待';

/** 周期视角适配（板块更适合的交易周期，与生命周期阶段 ThemePhase 正交，是两个维度） */
export type BoardCycleFit = '超短' | '短线' | '波段' | '中线' | '长线';

/** 板块作战台列表项：投影自 MainlineConsensusItem + 派生操盘标签 */
export interface BoardWorkbenchItem {
  /** 东财板块代码 BKxxxx（稳定 join key；取不到为 null） */
  boardCode: string | null;
  /** 板块名（breadth 锚板块名） */
  board: string;
  /** 生命周期阶段（来自 themes 回流，未命中/未知为 null） */
  phase: ThemePhase | null;
  /** 多源协同强度 0-100（无 theme 命中为 null） */
  strength: number | null;
  /** 强度趋势 */
  strengthTrend: 'rising' | 'flat' | 'falling' | null;
  /** 三方共识档 */
  consensus: MainlineConsensusLevel;
  /** 主线生命周期阶段（来自 breadth 确定性锚，决定 actionTag 的许可上限） */
  stage: BoardMainlineStage | null;
  /** 阶段允许的开仓动作（硬路由） */
  stageAction: BoardStageAction | null;
  /** 代表 ETF（无映射为 null） */
  etf: { code: string; name: string } | null;
  /** 派生操盘动作标签（不得越出 stageAction 的许可） */
  actionTag: BoardActionTag;
  /** 适配交易周期（派生自共识 + 趋势） */
  cycleFit: BoardCycleFit;
  /** 风险标签（退潮/拥挤/分歧等；无则空数组） */
  riskTags: string[];
  /** 核心证据摘要（一行，来自共识 note） */
  evidenceNote: string;
}

/** 板块作战台总览（board Tab 常驻头 + 首页作战台复用） */
export interface BoardWorkbench {
  asOf: string;
  items: BoardWorkbenchItem[];
  note: string;
}

/** 板块内可执行标的（龙头 / 补涨复用同一结构） */
export interface BoardStockPick {
  code: string;
  name: string;
  /** 最新价（取不到为 null） */
  price: number | null;
  /** 当日涨跌幅 %（取不到为 null） */
  pct: number | null;
  /** 总市值（亿元，取不到为 null） */
  marketCap: number | null;
  /** 日线趋势/位置/量能强度分 0-100（越高越强，用于龙头排序） */
  trendScore: number | null;
  /** 资金确认分 0-100（近5日主力净流入持续性，用于补涨判定） */
  fundScore: number | null;
  /** 一句话入选理由 */
  reason: string;
}

/** 板块详情（作战台下钻）：workbench item + 标的解析 + 暴露 + AI 行动建议 */
export interface BoardWorkbenchDetail {
  /** 列表项主干（投影自共识） */
  item: BoardWorkbenchItem;
  /** 龙头（成分内市值 + 趋势强度排序取头部） */
  leaders: BoardStockPick[];
  /** 补涨（相对强度低 + 位置不高 + 资金确认） */
  laggards: BoardStockPick[];
  /** 失效条件（研判 / 派生，条列） */
  invalidators: string[];
  /** 用户在该板块的持仓/自选暴露（无则空数组） */
  exposure: BoardExposureHolding[];
  /** AI 行动建议（未生成为 null） */
  aiAction: AiActionVerdict | null;
  /** 数据快照日 YYYY-MM-DD（对齐 breadth 快照，标注时效） */
  snapshotDate: string;
  note: string;
}

// ===== 持仓 / 自选 板块暴露（懒相交：主线板块成分 ∩ 用户持仓/自选）=====

/** 单条标的的暴露状态：在主线 / 退潮 / 拥挤 / 无主线关联 */
export type BoardExposureStatus = 'mainline' | 'fading' | 'crowded' | 'none';

/** 命中的板块及其阶段（一只票可命中多个主线板块） */
export interface BoardExposureHolding {
  code: string;
  name: string;
  /** 账户来源：real 真实持仓 / sim 模拟 / watch 自选 */
  account: 'real' | 'sim' | 'watch';
  /** 命中的主线板块 */
  boards: Array<{
    boardCode: string | null;
    boardName: string;
    consensus: MainlineConsensusLevel;
    phase: ThemePhase | null;
  }>;
  /** 综合暴露状态 */
  status: BoardExposureStatus;
}

/** 板块暴露总览 */
export interface BoardExposure {
  asOf: string;
  /** 数据快照日 YYYY-MM-DD（对齐 breadth 快照） */
  snapshotDate: string;
  holdings: BoardExposureHolding[];
  note: string;
}

// ===== AI 行动结构输出契约（结论 / 理由 / 证据 / 失效条件 / 动作，减少报告式长文）=====

/** 结构化 AI 行动研判（对齐 DecisionResult 先例，经 prompt 约定 + parseJsonObject 解析产出） */
export interface AiActionVerdict {
  /** 一句话结论 */
  conclusion: string;
  /** 理由（条列） */
  reasons: string[];
  /** 证据（条列，含来源/数据点） */
  evidence: string[];
  /** 失效条件（触发则结论作废） */
  invalidators: string[];
  /** 建议动作（统一标签） */
  action: BoardActionTag;
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
  /** 中金所股指期货持仓榜（直连 CFFEX CSV）启停，默认开启 */
  cffexEnabled: string;
  /** 美股映射（隔夜美股龙头/行业 → A股概念·ETF·个股）启停，默认开启 */
  usMapEnabled: string;
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
  /** a-stock-data sidecar 基址，如 http://a-stock-data:9119（同 compose 网络服务名） */
  astockBaseUrl: string;
  /** a-stock-data 数据源启停，默认开启 */
  astockEnabled: string;
  /** 微博大V博文数据源启停，默认开启 */
  weiboEnabled: string;
  /** 微博 Cookie（选填）：默认走免登录访客态，填入登录态 Cookie 可提升配额与抓取稳定性 */
  weiboCookie: string;
  /** 小红书博主笔记数据源启停，默认开启 */
  xhsEnabled: string;
  /** 小红书 Cookie（选填）：不填只能抓到标题，填了才有正文与发布时间 */
  xhsCookie: string;
  /** 微博抓取窗口（天）：只收这个天数内发布的博文，默认 2 */
  weiboFetchDays: string;
  /** 小红书抓取窗口（天）：越小请求越少、越不易触发风控，默认 2 */
  xhsFetchDays: string;
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

/** 日K本地缓存覆盖情况（数据源页展示；盘前预热 + 盘中增量 + 每周全量重刷） */
export interface KlineCacheStats {
  /** 当前生效的复权基准日（每周全量重刷时推进） */
  adjBase: string;
  lastPrewarmAt: string | null;
  lastPrewarmCodes: number;
  lastFullRefreshAt: string | null;
  lastIntradayAt: string | null;
  lastError: string | null;
  /** 已缓存的标的数 */
  codeCount: number;
  /** 总行数 */
  rowCount: number;
  /** 缓存中的最新交易日 */
  latestDate: string | null;
  /** 覆盖到最新交易日的标的数 */
  freshCodeCount: number;
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
  /**
   * 运行出错。runId 必须带上：前端要按它查回这一轮自己的世代，
   * 否则旧 run 迟到的 error 会把另一轮正在跑的 run 误收尾成空闲。
   */
  | { type: 'error'; message: string; runId?: string };

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
  /**
   * 命中的标的计划条件来源。仅 tick 级计划条件的信号带此字段，
   * 供 engine 把命中回写进计划事件流——rules 层是纯函数不落库，
   * 不带上这几个 id 的话盘中触发只会飘过一条告警，计划详情里查不到任何痕迹。
   */
  planHit?: { planId: string; planVersion: number; conditionId: string };
}

/** 个股盯盘执行动作（可闭眼照做的明确动作） */
export type WatchActionType =
  | '买入'
  | '加仓'
  | '持有'
  | '减仓'
  | '清仓'
  | '关注'
  | '观望'
  | '跳过';

/**
 * 个股盯盘结构化执行指令（买卖建议）：动作 + 价位 + 仓位 + 失效条件。
 * 买点由 agent 产出（单 agent 路径解析 / 多 agent 路径由 DecisionResult 组装），
 * 字段缺失为 null，前端按非空字段渲染（避免占位 0）。
 */
export interface WatchInstruction {
  /** 明确动作 */
  action: WatchActionType;
  /** 建议买入价区间下沿（无则 null） */
  entryLow: number | null;
  /** 建议买入价区间上沿（无则 null） */
  entryHigh: number | null;
  /** 本次操作 / 目标仓位 %（减/清仓为撤出比例；无则 null） */
  sizePct: number | null;
  /** 止损价（无则 null） */
  stopLoss: number | null;
  /** 目标 / 止盈价（无则 null） */
  takeProfit: number | null;
  /** 失效条件（一句话，触发即离场/作废） */
  invalidation: string;
  /** 一句话依据 */
  reason: string;
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
  /** 结构化执行指令（买卖建议：动作/价位/仓位/失效条件）；无则 null */
  instruction: WatchInstruction | null;
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
  /** 是否纳入实时盯盘（缺省 true，关闭则该战法持仓不进监控池） */
  monitorEnabled: boolean;
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

// ===== ETF 多周期分层盯盘（独立模块，与个股盯盘解耦）=====

/** 多周期框架：30 分钟 / 60 分钟 / 日线 */
export type EtfWatchTimeframe = '30m' | '60m' | 'day';

/** 信号类型：建层买点 / 撤层卖点 / 硬止损 */
export type EtfWatchSignalType = 'buy_layer' | 'sell_layer' | 'hard_stop';

/** 仓位层级（L1 试探 / L2 加仓 / L3 确认） */
export type EtfWatchLayer = 1 | 2 | 3;

/** 信号去向（确定性管道落点，纯展示） */
export type EtfWatchDisposition = 'cooldown' | 'low_confidence' | 'to_ai' | 'emitted';

/** 最终裁决（买点由 AI 裁决，卖点/硬止损为确定性动作） */
export type EtfWatchVerdict = '建仓' | '观察' | '放弃' | '撤层' | '硬止损';

/** 趋势阶段（确定性合成：均线排列 + MACD 零轴 + 收盘相对 MA60 位置） */
export type EtfTrendStage = '趋势初期' | '主升中' | '高位钝化' | '震荡' | '趋势破坏' | '未知';

/** 资金/量价确认读数（确定性证据：量价健康度 + 份额趋势 + 量比/换手/主力净流入） */
export interface EtfConfirm {
  /** 0-100 确认分（量价健康度 + 份额趋势 + 量比） */
  score: number;
  /** 确认标签：健康（量价配合）/ 背离（缩量上涨）/ 派发警惕（滞涨放量）/ 数据不足 */
  label: '健康' | '背离' | '派发警惕' | '数据不足';
  /** 量价一行读数（人类可读） */
  volPriceNote: string;
  /** 份额趋势一行读数（人类可读） */
  shareTrendNote: string;
  /** 量比（无数据为 null） */
  volRatio: number | null;
  /** 换手率 %（无数据为 null） */
  turnover: number | null;
  /** 主力净流入（亿元，东财口径弱证据；无数据为 null） */
  mainNetInflow: number | null;
  /** 最新份额（份；无数据为 null） */
  shares: number | null;
  /** 数据时点 ISO */
  asOf: string;
}

/** 执行指令动作（可闭眼照做的明确动作） */
export type EtfExecActionType = '建仓' | '加仓' | '持有' | '减仓' | '清仓' | '观望';

/**
 * 可闭眼照做的执行指令（agent 主导填写方向/轻重/价位，确定性护栏兜底改写）。
 * 卖点/硬止损为确定性直接构造，买点由 agent 产出后经护栏校验。
 */
export interface EtfExecInstruction {
  /** 明确动作 */
  action: EtfExecActionType;
  /** 涉及层级（无则 null） */
  layer: number | null;
  /** 建议买入价区间下沿（无则 null） */
  entryLow: number | null;
  /** 建议买入价区间上沿（无则 null） */
  entryHigh: number | null;
  /** 本次操作占总仓位 %（减/清仓为撤出比例） */
  sizePct: number;
  /** 操作后预计总仓位 %（无则 null） */
  totalAfterPct: number | null;
  /** 止损价（建/加/持仓必给；无则 null） */
  stopLoss: number | null;
  /** 失效条件（一句话，触发即离场/作废） */
  invalidation: string;
  /** 一句话依据 */
  reason: string;
  /** 若被确定性护栏改写/限制，写明原因；未改写为 null */
  guardrailNote: string | null;
}

/** 一条 ETF 多周期信号（确定性产出，买点再经置信度增信） */
export interface EtfWatchSignal {
  code: string;
  name: string;
  type: EtfWatchSignalType;
  /** 对应层级（buy/sell 为该层；hard_stop 为清到的最高层） */
  layer: EtfWatchLayer;
  /** 触发周期（hard_stop 归 day） */
  timeframe: EtfWatchTimeframe;
  /** 建议仓位百分比（buy_layer：该层目标仓位；sell/hard_stop：撤出比例） */
  positionPct: number;
  /** 触发时现价 */
  price: number;
  /** 当日涨跌幅 % */
  pct: number;
  /** 触发周期 MACD DIF */
  dif: number;
  /** 触发周期 MACD DEA */
  dea: number;
  /** 人类可读触发说明 */
  detail: string;
  /** 触发时间 ISO（检测时刻，非 K 线收盘时刻） */
  at: string;
  /** 触发周期最新收盘 K 线的时间（与 at/检测时刻区分，定位是哪根 bar） */
  barTime: string;
  /** 去向标签（广播附带，纯展示） */
  disposition?: EtfWatchDisposition;
}

/** 落库的 ETF 盯盘告警（买点含混合置信度 + agent 研判） */
export interface EtfWatchAlert {
  id: string;
  code: string;
  name: string;
  signalType: EtfWatchSignalType;
  layer: number;
  timeframe: EtfWatchTimeframe;
  positionPct: number;
  detail: string;
  /** 触发时现价 */
  triggerPrice: number;
  dif: number;
  dea: number;
  /** 0-100 混合置信度（仅买点；卖点/硬止损为 null） */
  confidence: number | null;
  /** 最终裁决（买点由 AI 裁决并经置信门校准；卖点/硬止损为确定性动作） */
  verdict: EtfWatchVerdict | null;
  /** agent 一句话研判（买点；卖点可空） */
  advice: string | null;
  /** 资金/量价确认读数（确定性证据；无则 null） */
  confirm: EtfConfirm | null;
  /** 可闭眼照做的执行指令（买点经 agent+护栏；卖点/硬止损确定性构造） */
  instruction: EtfExecInstruction | null;
  /** 触发时趋势阶段（确定性合成；无则 null） */
  trendStage: EtfTrendStage | null;
  /** 触发周期最新收盘 K 线的时间（区分检测时刻 createdAt） */
  barTime: string | null;
  /** 关联 agent 运行 id（买点调 agent 时有值） */
  runId: string | null;
  /** Telegram 是否已投递 */
  delivered: boolean;
  createdAt: string;
}

/** 单只 ETF 的逻辑层状态（告警模式：按引擎自身发出的信号维护「建议持仓层」） */
export interface EtfWatchLayerState {
  code: string;
  name: string;
  /** 已建层集合（升序） */
  heldLayers: EtfWatchLayer[];
  /** 各层建仓价（撤层/硬止损基准），键为层号字符串 */
  layerEntryPrice: Record<string, number>;
  /** 各层建仓时间 ISO（键为层号字符串），供「持仓起始日 / 隔日」过期标识展示 */
  layerEntryAt?: Record<string, string>;
  /** 持有以来最高价（移动止盈 / 移动止损参考） */
  peakPrice: number;
  /** 趋势阶段（确定性合成，每轮评估刷新；用于「该持有还是该防守」基调） */
  trendStage?: EtfTrendStage | null;
  updatedAt: string;
}

/** ETF 多周期盯盘配置（独立持久化，etfwatch_* 键前缀） */
export interface EtfWatchConfig {
  /** 引擎总开关 */
  enabled: boolean;
  /** 轮询间隔（秒） */
  pollSec: number;
  /** 标的来源：纳入真实持仓中的场内 ETF */
  includePositions: boolean;
  /** 标的来源：纳入 ETF 跟踪池 */
  includePool: boolean;
  /** 额外盯盘代码白名单（逗号分隔） */
  extraCodes: string;
  /** L1 试探仓目标仓位 %（默认 40） */
  layer1Pct: number;
  /** L2 加仓目标仓位 %（默认 40） */
  layer2Pct: number;
  /** L3 确认仓目标仓位 %（默认 20） */
  layer3Pct: number;
  /** 零轴过滤：水下金叉(DIF<0)降级观察不建仓 */
  zeroAxisFilter: boolean;
  /** 大周期方向过滤（L1 需 60m 多头 / L2 需日线多头 / L3 需周线多头） */
  higherTfFilter: boolean;
  /** 硬止损：跌破建仓均价 % 立即清该层及以下 */
  hardStopPct: number;
  /** 移动止损回看根数：30m 死叉时若 60m 仍多头，改提移动止损（跌破近 N 根 30m 低点才撤） */
  trailLookback: number;
  /** 移动止盈：持仓盈利状态下从持有高点回撤 ≥ 此 % 触发减/撤层（守主升浪利润；0=关闭） */
  trailTakeProfitPct: number;
  /** 禁追高护栏：当日涨幅 ≥ 此 % 时禁止新建/加仓（降级观望；0=关闭） */
  chaseGuardPct: number;
  /** 最大总仓位 %：执行指令的累计目标仓位不得超过此值（护栏削减；0=不限制） */
  maxTotalPct: number;
  /** 买点是否调 agent 给混合置信度 */
  agentConfirmBuy: boolean;
  /** 置信度门：买点低于此值降级观察不推送（0=不拦截） */
  minConfidence: number;
  /** 同标的同类信号冷却（分钟） */
  cooldownMin: number;
  /** 是否推送 Telegram */
  pushTelegram: boolean;
}

/** ETF 盯盘引擎状态（心跳） */
export interface EtfWatchStatus {
  enabled: boolean;
  running: boolean;
  /** 当前是否交易时段 */
  inSession: boolean;
  /** 上次轮询时间 ISO */
  lastPollAt: string | null;
  /** 上次轮询命中信号数 */
  lastSignalCount: number;
  /** 当前跟踪标的数 */
  trackedCount: number;
  config: EtfWatchConfig;
}

/** ETF 盯盘 WebSocket 推送事件（独立于 WatchEvent / StreamEvent） */
export type EtfWatchEvent =
  | { type: 'status'; status: EtfWatchStatus }
  | { type: 'signal'; signal: EtfWatchSignal }
  | { type: 'alert'; alert: EtfWatchAlert }
  | { type: 'states'; at: string; states: EtfWatchLayerState[] };

// ===== 尾盘套利确定性盯盘（weipan：只买当日选出的 3 只 + 次日确定性移动止盈/止盈/止损/尾盘了结，无 LLM）=====

/** 尾盘盯盘卖出原因：止损 / 止盈 / 移动止盈(冲高回落) / 尾盘了结 */
export type WeipanExitReason = 'stop_loss' | 'take_profit' | 'trailing' | 'eod';

/** 信号去向：emitted 已确定性执行并推送 / cooldown 冷却内跳过 / skipped 命中但下单被市场规则拒 */
export type WeipanDisposition = 'emitted' | 'cooldown' | 'skipped';

/** 尾盘盯盘确定性信号（纯规则命中，无 LLM） */
export interface WeipanSignal {
  code: string;
  name: string;
  reason: WeipanExitReason;
  /** 现价（触发价） */
  price: number;
  /** 当日涨跌幅 % */
  pct: number;
  /** 建仓均价 */
  avgCost: number;
  /** 盘中观测到的当日最高 */
  dayHigh: number;
  /** 相对成本浮盈 % */
  gainPct: number;
  /** 自当日高点回撤 %（trailing 触发依据） */
  drawdownPct: number;
  /** 人话触发说明 */
  detail: string;
  at: string;
  disposition?: WeipanDisposition;
}

/** 尾盘盯盘告警（一次确定性卖出的留痕） */
export interface WeipanAlert {
  id: string;
  code: string;
  name: string;
  reason: WeipanExitReason;
  detail: string;
  /** 触发价 */
  triggerPrice: number;
  /** 实际模拟卖出股数（被市场规则拒则为 0） */
  soldQty: number;
  /** 已实现盈亏（未成交为 null） */
  realizedProfit: number | null;
  /** 是否成功推送 */
  delivered: boolean;
  /** 未成交时的跳过原因（如跌停不可卖/T+1/可卖不足） */
  skipNote: string | null;
  createdAt: string;
}

/** 尾盘盯盘配置（独立持久化，前缀 weipan_） */
export interface WeipanConfig {
  /** 总开关（另受全局 autoLocalSimEnabled 安全总闸约束） */
  enabled: boolean;
  /** 轮询秒 */
  pollSec: number;
  /** 每只建仓占「建仓时可用现金」的百分比 */
  perPositionPct: number;
  /** 同标同因冷却分钟 */
  cooldownMin: number;
  /** 命中是否推送 Telegram */
  pushTelegram: boolean;
}

/** 尾盘盯盘引擎状态（心跳） */
export interface WeipanStatus {
  enabled: boolean;
  running: boolean;
  inSession: boolean;
  lastPollAt: string | null;
  lastSignalCount: number;
  /** 当前跟踪（持仓）标的数 */
  trackedCount: number;
  /** 绑定的尾盘战法 id（未找到为 null） */
  strategyId: string | null;
  config: WeipanConfig;
}

/** 尾盘盯盘 WebSocket 推送事件 */
export type WeipanEvent =
  | { type: 'status'; status: WeipanStatus }
  | { type: 'signal'; signal: WeipanSignal }
  | { type: 'alert'; alert: WeipanAlert };

/** 手动检测的动作建议（含持仓视角的减/清仓） */
export type EtfWatchProbeAction = '建仓' | '加仓' | '观察' | '减仓' | '清仓' | '放弃';

/** 单周期 MACD 读数（手动检测报告用） */
export interface EtfWatchTfReadout {
  timeframe: '30m' | '60m' | 'day' | 'week';
  /** 形态：金叉/死叉/多头/空头 */
  state: MacdReadout['state'];
  dif: number;
  dea: number;
  /** DIF ≥ DEA（多头排列） */
  bullish: boolean;
  /** DIF > 0（零轴上方） */
  aboveZero: boolean;
  /** 最新已收盘 bar 时间 */
  barTime: string;
  /** 最新收盘价 */
  close: number;
}

/** 即时检测的确定性部分（先于 AI 立即可得，用于先渲染读数表/持仓） */
export interface EtfWatchProbeBase {
  code: string;
  name: string;
  /** 现价（取数失败回退日线收盘） */
  price: number;
  /** 当日涨跌幅 % */
  pct: number;
  /** 当前已建层（引擎逻辑状态） */
  heldLayers: EtfWatchLayer[];
  /** 各层建仓价 */
  layerEntryPrice: Record<string, number>;
  /** 多周期读数（30m/60m/day，含 week 若有） */
  readouts: EtfWatchTfReadout[];
  /** 30m/60m/日线多头共振数（0-3） */
  resonance: number;
  /** 资金/量价确认读数（确定性证据；无则 null） */
  confirm: EtfConfirm | null;
  /** 趋势阶段（确定性合成；无则 null） */
  trendStage: EtfTrendStage | null;
  /** 检测时间 ISO */
  at: string;
}

/** 单只 ETF 的即时多周期检测 + AI 研判报告（只读，不落库/不推送/不改层状态） */
export interface EtfWatchProbe {
  code: string;
  name: string;
  /** 现价（取数失败回退日线收盘） */
  price: number;
  /** 当日涨跌幅 % */
  pct: number;
  /** 当前已建层（引擎逻辑状态） */
  heldLayers: EtfWatchLayer[];
  /** 各层建仓价 */
  layerEntryPrice: Record<string, number>;
  /** 多周期读数（30m/60m/day，含 week 若有） */
  readouts: EtfWatchTfReadout[];
  /** 30m/60m/日线多头共振数（0-3） */
  resonance: number;
  /** 0-100 混合置信度（AI 失败时为 null） */
  confidence: number | null;
  /** AI 动作裁决 */
  action: EtfWatchProbeAction;
  /** AI 一句话研判（markdown） */
  advice: string;
  /** 资金/量价确认读数（确定性证据；无则 null） */
  confirm: EtfConfirm | null;
  /** 趋势阶段（确定性合成；无则 null） */
  trendStage: EtfTrendStage | null;
  /** 可闭眼照做的执行指令（agent 主导 + 护栏兜底；无则 null） */
  instruction: EtfExecInstruction | null;
  /** 关联 agent 运行 id */
  runId: string | null;
  /** 检测时间 ISO */
  at: string;
}

/** /ws/etf-watch/probe 流式事件：复用 StreamEvent（agent 轨迹）+ 检测专属帧 */
export type EtfWatchProbeStreamEvent =
  | { type: 'probe_base'; base: EtfWatchProbeBase }
  | { type: 'probe_done'; probe: EtfWatchProbe }
  | StreamEvent;

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

/** 盘中分时作战指引（四段，各一句话关注点；缺省段为 undefined） */
export interface IntradayGuide {
  /** 集合竞价（9:15-9:25）：高开/低开与外盘映射关注 */
  auction?: string;
  /** 早盘（9:30-11:30）：主线分歧/承接关注 */
  morning?: string;
  /** 午盘（13:00-14:30）：持续性/量能关注 */
  midday?: string;
  /** 尾盘（14:30-15:00）：资金回流/获利了结关注 */
  tail?: string;
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
  /** 今日风险清单（AI 产出，3-5 条；旧计划为空数组） */
  keyRisks: string[];
  /** 盘中分时作战指引（AI 产出；旧计划为 null） */
  intradayGuide: IntradayGuide | null;
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
  /**
   * 去重归属标注（G2 不静默失联）：本任务已停用、其职能由别处承担时给出人读说明，
   * 如「已迁至外部 OpenClaw · 旺财 ETF 编排」「已并入 research.dailyAnalysis 模块定时」。
   * 右侧启用开关即「一键恢复」。仅对 enabled=false 的项填充，否则为 null。
   */
  supersededBy?: string | null;
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

// ===== 驾驶舱「今日全景」统一读模型 =====
// 所有总览数字统一从这里投影，避免同一指标在驾驶舱 / 大盘页 / 计划页各算各的而对不上。
// 每个区块自带 status：ok 正常 / empty 无数据 / error 取数失败——失败必须显式说明，不能整块消失。

export type PanoramaBlockStatus = 'ok' | 'empty' | 'error';

/** 区块信封：数据 + 状态 + 失败原因 */
export interface PanoramaBlock<T> {
  status: PanoramaBlockStatus;
  /** status=ok 时有值 */
  data: T | null;
  /** status≠ok 时的人话说明（直接展示给用户，不再让区块凭空消失） */
  note: string;
}

/** 结论带·能不能做（秒开层：只用本地快照，实际仓位由实时层的 account 块补位） */
export interface PanoramaCanTrade {
  phase: MarketRegimePhase | null;
  score: number | null;
  /** 当前档的单笔风险预算 % */
  singleTradeRiskPct: number;
  /** 当前档的总仓上限 % */
  totalMaxPositionPct: number;
  conclusion: string;
}

/** 结论带·做什么 */
export interface PanoramaFocus {
  board: string | null;
  stage: BoardMainlineStage | null;
  action: BoardStageAction | null;
  etf: { code: string; name: string } | null;
  conclusion: string;
}

/** 结论带·该动谁（秒开层只给计划侧；持仓侧由实时层的 discipline 块补位） */
export interface PanoramaTodo {
  /** 今日计划待触发数 */
  planPending: number;
  /** 今日计划已失效数 */
  planInvalid: number;
  conclusion: string;
}

/** 第1层·情绪当前读数（读收盘快照，不重算） */
export interface PanoramaSentimentNow {
  tradeDate: string;
  index: number;
  level: string;
  phase: string;
  /** 较上一交易日变动 */
  delta: number | null;
  /** 白话仓位倾向建议 */
  advice: string;
}

/** 第2层·今日计划的一条具体操作 */
export interface PanoramaPlanAction {
  code: string;
  name: string;
  /** buy/add/reduce/sell/hold */
  direction: string;
  /** 触发条件文本（价位/形态） */
  trigger: string;
  status: PlanItemStatus;
  confidence: number | null;
  assetType: string;
}

/** 第3层·ETF 多周期盯盘（层级 + 最近动作建议） */
export interface PanoramaEtfWatchItem {
  code: string;
  name: string;
  /** 已建层（如 [1,2]） */
  heldLayers: number[];
  /** 趋势阶段（无则 null） */
  trendStage: string | null;
  /** 最近一条告警的动作建议（无则 null） */
  lastAction: string | null;
  lastAt: string | null;
}

export interface PanoramaEtfWatch {
  /** 引擎是否在跑 */
  running: boolean;
  alertsToday: number;
  items: PanoramaEtfWatchItem[];
}

/** 第3层·个股盯盘 */
export interface PanoramaStockWatchAlert {
  code: string;
  name: string;
  severity: string;
  advice: string;
  at: string;
}

export interface PanoramaStockWatch {
  running: boolean;
  inSession: boolean;
  alertsToday: number;
  lastSignalCount: number;
  alerts: PanoramaStockWatchAlert[];
}

// ===== 实时层（需网络取数，前端并行加载后补位）=====

/** 真实账户当前状态 */
export interface PanoramaAccount {
  totalAsset: number;
  cash: number;
  /** 总仓位率 % */
  positionPct: number;
  /** 今日盈亏额 */
  todayProfit: number;
  /** 今日盈亏率 % */
  todayRate: number;
  positionCount: number;
}

/** 持仓纪律汇总（逐票明细仍在持仓页） */
export interface PanoramaDisciplineItem {
  code: string;
  name: string;
  status: DisciplineStatus;
  /** 一句话动作（含建议减仓股数时优先给股数） */
  action: string;
}

export interface PanoramaDisciplineSummary {
  stopLoss: number;
  takeProfit: number;
  overweight: number;
  stopNotExecuted: number;
  healthy: number;
  /** 实际总仓 % */
  totalPositionPct: number;
  /** 本档总仓上限 % */
  totalMaxPositionPct: number;
  warnings: string[];
  /** 需要处理的前若干票 */
  items: PanoramaDisciplineItem[];
}

/** ETF 轮动榜条目（赛道层结论） */
export interface PanoramaRotationItem {
  code: string;
  name: string;
  track: string | null;
  state: string;
  score: number;
  rs: number | null;
}

/** 情绪硬读数（判断敢不敢追的最直接依据） */
export interface PanoramaDragonRead {
  maxStreak: number;
  limitUpCount: number;
  brokenRate: number;
  topDragon: string | null;
}

/** 驾驶舱实时层（需网络；各块独立降级，失败不影响秒开层） */
export interface CockpitPanoramaLive {
  asOf: string;
  account: PanoramaBlock<PanoramaAccount>;
  discipline: PanoramaBlock<PanoramaDisciplineSummary>;
  rotation: PanoramaBlock<PanoramaRotationItem[]>;
  dragon: PanoramaBlock<PanoramaDragonRead>;
}

/** 情绪与阶段的逐日读数（一个点 = 一个交易日） */
export interface PanoramaSentimentPoint {
  date: string;
  /** 情绪指数 0-100 */
  sentiment: number | null;
  /** 大盘强度分 0-100 */
  regimeScore: number | null;
  phase: MarketRegimePhase | null;
  /** 涨停家数 */
  limitUp: number | null;
  /** 跌停家数 */
  limitDown: number | null;
  /** 炸板率 % */
  brokenRate: number | null;
  /** 上涨家数 */
  advancers: number | null;
  /** 下跌家数 */
  decliners: number | null;
}

/** 主线生命周期泳道的一格 */
export interface PanoramaLaneItem {
  board: string;
  boardCode: string;
  newHighCount: number;
  topDays: number;
  etf: { code: string; name: string } | null;
}

/** 按阶段分组的泳道 */
export interface PanoramaLane {
  stage: BoardMainlineStage;
  action: BoardStageAction;
  items: PanoramaLaneItem[];
}

/** 账户逐日表现（净值曲线 + 日历热力共用） */
export interface PanoramaEquityPoint {
  date: string;
  /** 当日账户收益率 %（各持仓贡献之和） */
  dayPct: number;
  /** 累计净值（起点 1） */
  nav: number;
}

/** 系统健康矩阵的一格 */
export interface PanoramaHealthCell {
  key: string;
  label: string;
  status: 'ok' | 'warn' | 'down';
  /** 一句话读数，如「覆盖 128 只 · 至 2026-08-01」 */
  detail: string;
}

/** 驾驶舱今日全景·秒开层（纯本地 DB/内存读取，不含任何网络调用） */
export interface CockpitPanorama {
  asOf: string;
  tradeDate: string;
  canTrade: PanoramaBlock<PanoramaCanTrade>;
  focus: PanoramaBlock<PanoramaFocus>;
  todo: PanoramaBlock<PanoramaTodo>;
  /** 第1层：情绪当前读数 */
  sentimentNow: PanoramaBlock<PanoramaSentimentNow>;
  sentimentTrend: PanoramaBlock<PanoramaSentimentPoint[]>;
  lanes: PanoramaBlock<PanoramaLane[]>;
  /** 第2层：今日计划的具体操作清单 */
  planActions: PanoramaBlock<PanoramaPlanAction[]>;
  /** 第3层：ETF 多周期盯盘层级与动作 */
  etfWatch: PanoramaBlock<PanoramaEtfWatch>;
  /** 第3层：个股盯盘告警 */
  stockWatch: PanoramaBlock<PanoramaStockWatch>;
  equity: PanoramaBlock<PanoramaEquityPoint[]>;
  health: PanoramaBlock<PanoramaHealthCell[]>;
}

// ===== 选股漏斗诊断（只读研究统计，不自动放宽生产门槛）=====

/** 单个硬筛条件的拦截统计 */
export interface ScreenFilterStat {
  key: string;
  label: string;
  /** 门槛的可读描述，如「成交额 ≥ 2 亿」 */
  threshold: string;
  /** 单独看这一条会拦掉多少只（各条独立统计，会相互重叠） */
  rejected: number;
  /** 仅被这一条拦住的只数——放宽它最多能救回这么多 */
  soleRejected: number;
}

/** 阈值敏感性：该条件按比例放宽/收紧后的候选数 */
export interface ScreenSensitivityRow {
  key: string;
  label: string;
  /** delta 为门槛的相对变动（+0.25 = 放宽 25%），count 为对应的候选数；不可扫描时为空数组 */
  points: Array<{ delta: number; count: number }>;
  /** points 为空时说明为什么无法扫描（如门槛为 0，相对缩放无意义） */
  note?: string;
}

/** 差一点入选的标的（恰好只被一条门槛拦住） */
export interface ScreenNearMiss {
  code: string;
  name: string;
  failedKey: string;
  failedLabel: string;
  /** 实际值 */
  actual: number | null;
  /** 门槛值 */
  threshold: number;
  /** 距门槛的相对差距 %（正数表示还差多少） */
  gapPct: number;
}

/** 选股漏斗诊断：被硬筛刷掉的那部分去了哪里 */
export interface ScreenFunnelDiagnostics {
  marketCount: number;
  /** 通过可交易性过滤（剔科创/北交/ST）后的只数 */
  tradableCount: number;
  filteredCount: number;
  filters: ScreenFilterStat[];
  sensitivity: ScreenSensitivityRow[];
  nearMisses: ScreenNearMiss[];
  note: string;
}

// ===== 前向晋级门（统计显著性体检，只读不自动晋级）=====

/** 单条门槛的体检结果 */
export interface PromotionCheck {
  key: string;
  label: string;
  /** 实测值（已格式化） */
  actual: string;
  /** 门槛要求（已格式化） */
  required: string;
  passed: boolean;
  /** 为什么要有这条门槛 */
  note: string;
}

/**
 * 晋级门体检：一个策略要被认可为「可上仓位」，光看累计收益曲线不够。
 * 小样本胜率要看置信下界；同日同板块的批量交易不是独立样本；从 N 个变体里挑最优会系统性高估。
 * 本结构只做体检与展示，永不自动晋级。
 */
export interface PromotionGateResult {
  passed: boolean;
  /** 完整可归因的交易笔数（已平仓） */
  trades: number;
  /** 点胜率 % */
  winRate: number | null;
  /** Wilson 95% 胜率下界 % */
  wilsonLowerPct: number | null;
  /** 日期(×板块)聚类后的有效簇数（Herfindahl 口径，同日批量交易不重复计数） */
  effectiveClusters: number;
  /** 簇等权胜率 % */
  clusterWinRatePct: number | null;
  /** 簇等权胜率 95% 正态下界 % */
  clusterWinLowerPct: number | null;
  /** 费后平均每笔净收益 */
  avgNetPnl: number | null;
  /** 累计已实现盈亏 */
  totalNetPnl: number;
  /** 申报的变体数（从多少个参数/规则变体里挑出来的；0=未申报） */
  variantCount: number;
  /** 多重检验惩罚后的胜率下界要求 % */
  requiredWinLowerPct: number;
  checks: PromotionCheck[];
  note: string;
}

// ===== 真实持仓纪律（确定性体检，只读不下单）=====

/** 纪律命中类型 */
export type DisciplineKind =
  | 'stop_loss'
  | 'take_profit'
  | 'overweight'
  | 'over_hold'
  | 'near_stop'
  /** 曾触发止损但至今仍持有：风险预算反推仓位的前提是止损真的会执行，不追踪这条整套口径就是自欺 */
  | 'stop_not_executed';

/**
 * 市场阶段对应的风险预算档（ETF 中线口径，按本项目标的自行标定）。
 *
 * 不照搬个股短线系统那套 1.5%/1.0%/0.6%/0.3%：那是按 3-6% 的个股结构止损距离标的，
 * 而 ETF 的有效损失距离在 12% 量级，同样的风险预算除以更大的分母会把仓位压到毫无意义的水平；
 * 反过来把个股风险预算配上 ETF 的宽止损，又会反推出超过 100% 的仓位。故这里按本项目实际止损距离重标。
 */
export interface RiskBudgetTier {
  /** 单笔权益风险预算 %：这笔交易走到止损时，最多亏掉总权益的百分之多少 */
  singleTradeRiskPct: number;
  /** 总仓上限 % */
  totalMaxPositionPct: number;
  /** 单票绝对上限 %（个股） */
  singleMaxStockPct: number;
  /** 单票绝对上限 %（ETF，可比个股宽：一篮子本身已分散） */
  singleMaxEtfPct: number;
  /** 单板块敞口上限 % */
  boardMaxExposurePct: number;
}

/** 单票的仓位反推明细（风险预算 ÷ 有效损失距离 → 允许权重，再与绝对上限取小） */
export interface PositionSizing {
  /** 结构止损距离 %（相对成本） */
  stopDistancePct: number;
  /** ATR 波动距离 %（取 atrMult × ATR14/价格；无日线数据为 null） */
  atrDistancePct: number | null;
  /** 跳空缓冲 %（个股取近 60 日向下跳空 P95；ETF 几乎不跳空故为 0） */
  gapBufferPct: number;
  /** 费用滑点缓冲 % */
  costBufferPct: number;
  /** 有效损失距离 % = max(结构止损, ATR距离) + 跳空缓冲 + 费用缓冲 */
  effectiveLossPct: number;
  /** 风险预算反推的权重上限 % */
  riskCapPct: number;
  /** 该阶段该资产类型的绝对权重上限 % */
  absoluteCapPct: number;
  /** 最终允许权重 % = min(风险反推, 绝对上限) */
  allowedWeightPct: number;
  /** 按当前总权益与价格折算的允许股数（已向下取整到 100 股） */
  allowedShares: number;
  /** 当前实际持股数 */
  currentShares: number;
  /** 需减仓股数（当前 - 允许，≤0 表示无需减仓） */
  reduceShares: number;
}

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
  /** 风险预算反推的仓位明细（无价格/成本时为 null） */
  sizing: PositionSizing | null;
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
  /** 当前市场阶段（风险预算档由它决定；取不到快照为 null，此时回落到震荡档） */
  regimePhase: MarketRegimePhase | null;
  /** 当前生效的风险预算档 */
  budget: RiskBudgetTier;
  items: DisciplinePositionItem[];
  account: DisciplineAccountCheck;
  counts: {
    stopLoss: number;
    takeProfit: number;
    overweight: number;
    overHold: number;
    healthy: number;
    /** 曾触发止损但仍持有的笔数 */
    stopNotExecuted: number;
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

/** 选股因子白话说明（前端 tooltip：给无量化背景用户解释每个因子看什么、越高代表什么） */
export const SCREEN_FACTOR_DESC: Record<ScreenFactorKey, string> = {
  midTrend: '中期上升趋势是否成立：价格站上中期均线、均线多头排列的程度。看的是中线方向，不是当天涨跌。分越高＝中线越走多。',
  value: '估值贵不贵：市盈率 / 市净率等是否偏低。越便宜分越高（成长股策略可能弱化此项）。',
  liquidity: '买卖好不好成交：成交额 / 换手是否充足。越活跃越不容易被一两笔大单砸盘，分越高。',
  size: '流通市值大小：偏好中大盘还是中小盘由策略决定。分高代表更贴合该策略想要的体量。',
  momentum: '近期涨得强不强：过去一段时间的涨幅强弱。越强分越高（追强势思路）。',
  activity: '盘面活跃度：换手率 / 振幅等，资金参与是否积极。分越高代表当下越有人气。',
  themeHeat: '是否踩中热门题材：结合你填的「题材上下文」与市场热点。命中当前主线题材分越高。',
  trend: '短中期趋势方向：结合均线斜率判断向上还是向下。趋势向上分越高。',
  fundFlow: '资金在不在买：主力 / 大单净流入情况。净流入越多分越高。',
  dragonRank: '是不是板块龙头：在所属板块 / 题材里的龙头地位（涨幅排名、连板等）。越靠龙头分越高。',
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
  /** 漏斗诊断（被硬筛刷掉的那部分去哪了；老运行或非 multifactor 链路为 null） */
  diagnostics?: ScreenFunnelDiagnostics | null;
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
export type CockpitEventKind = 'discipline' | 'trade' | 'watch' | 'decision' | 'plan';

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

/** 首板赚钱效应指数（同花顺 883994「昨日打首板表现」）单根日线（趋势图用） */
export interface MoneyEffectPoint {
  /** YYYY-MM-DD */
  date: string;
  close: number;
}

/**
 * 首板赚钱效应总览（同花顺 883994「昨日打首板表现」= 首板隔日溢价累积指数）。
 * 信号口径与影子战法一致：站上 MA5 且 MA5 向上 → 升温(满)，否则退潮(空)，无未来函数。
 */
export interface MoneyEffectOverview {
  asOf: string;
  /** 最新一根日线日期 YYYY-MM-DD */
  tradeDate: string;
  /** 最新收盘（指数点位） */
  close: number;
  /** MA5（截至最新一日） */
  ma5: number;
  /** MA10（截至最新一日） */
  ma10: number;
  /** 前一日收盘 */
  prevClose: number;
  /** 收盘是否站上 MA5 */
  aboveMa5: boolean;
  /** MA5 是否向上（较前一日 MA5 抬升） */
  ma5SlopeUp: boolean;
  /** 择时信号：升温(满) / 退潮(空) */
  signal: '升温' | '退潮';
  /** 最新收盘较前一日涨跌幅 %（缺失为 null） */
  delta: number | null;
  /** 近 ~60 根日线（升序），供趋势图 */
  series: MoneyEffectPoint[];
  /** 数据降级标记 */
  stale: boolean;
  note: string;
}

/** 驾驶舱一屏概览：安全状态 + 当日计划兑现 + 强势主线 + 模块总结 + 选股候选 + 事件时间线 */
export interface CockpitOverview {
  asOf: string;
  safety: SafetyState;
  /** 大盘阶段研判（确定性，best-effort；取数失败为 null） */
  regime: MarketRegimeOverview | null;
  /** 首板赚钱效应(883994)最近一次快照（本地 meta，秒开；无快照为 null） */
  moneyEffect: MoneyEffectOverview | null;
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

// ---- 因子探索（离线预计算的因子目录 + IC + 当前快照） ----

/** 单个因子在某未来收益视角下的横截面 Rank IC 统计 */
export interface FactorIcStat {
  /** 参与统计的交易日数 */
  days: number;
  /** 平均 Rank IC */
  meanIc: number;
  /** IC 信息比（mean/std），衡量稳健性 */
  icir: number;
  /** t 值（icir * sqrt(days)），衡量显著性 */
  t: number;
  /** IC 为正的交易日比例 */
  posRate: number;
}

/** 因子目录条目（含分类、中文介绍、公式、方向、IC 统计） */
export interface FactorCatalogItem {
  /** 因子代码（与快照 values 的 key 对应） */
  name: string;
  /** 中文名 */
  cn: string;
  /** 分类（16 大族之一或「其他」） */
  category: string;
  /** 中文介绍（无精修文案时回退到分类级介绍） */
  desc: string;
  /** 公式简述（可能为空） */
  formula: string;
  /** 方向：pos 越大越看多，neg 为反向信号 */
  direction: 'pos' | 'neg';
  /** 信号簇：横截面/主题强度 | 绝对趋势动量 | 反向信号 */
  cluster: string;
  /** 强度档：strong | ok | weak | na（按 5 日口径） */
  strength: 'strong' | 'ok' | 'weak' | 'na';
  /** 未来 5 日 IC 统计 */
  ic5: FactorIcStat | null;
  /** 未来 10 日 IC 统计 */
  ic10: FactorIcStat | null;
}

/** 因子目录元信息（样本范围 + 口径说明） */
export interface FactorCatalogMeta {
  /** 生成时间（ISO，含 +08:00） */
  generatedAt: string;
  sampleEtfCount: number;
  tradingDays: number;
  factorCount: number;
  /** 快照对应的交易日 */
  snapshotDate: string;
  /** 未来收益视角（如 [5, 10]） */
  horizons: number[];
  /** 分类 → 分类级介绍 */
  categoryIntro: Record<string, string>;
  /** 必须在 UI 展示的诚实口径提示 */
  caveats: string[];
}

/** GET /api/factors/catalog 响应数据 */
export interface FactorCatalogResponse {
  meta: FactorCatalogMeta;
  catalog: FactorCatalogItem[];
}

/** 最新交易日单只 ETF 的全因子值 */
export interface FactorSnapshotItem {
  code: string;
  name: string;
  /** 因子代码 → 当日值 */
  values: Record<string, number>;
}

/** GET /api/factors/snapshot 响应数据 */
export interface FactorSnapshotResponse {
  snapshotDate: string;
  generatedAt: string;
  items: FactorSnapshotItem[];
}

// ---- 量化研究模式库 ----

/** 研究标的库条目（独立于 ETF 关注列表） */
export interface ResearchUniverseItem {
  code: string;
  name: string;
  tags?: string | null;
  note?: string | null;
  addedAt: string;
}
export interface ResearchUniverseInput {
  code: string;
  name: string;
  tags?: string | null;
  note?: string | null;
}

export type ModeStatus = 'experiment' | 'recommended' | 'baseline' | 'retired';
export type TrackingMode = 'system' | 'external';

/** 退出规则（声明式，站内跟踪引擎可执行的白名单） */
export type ModeExit =
  | { type: 'rankDrop' }
  | { type: 'belowMaDrawdown'; ma: number; drawdownPct: number }
  | { type: 'supertrend'; period: number; mult: number };

/** 横截面加权 z-score 选 TopN 的 spec（原默认形态，无 kind 字段即视为此类） */
export interface CrossSectionSpec {
  kind?: 'crossSection';
  /** 选股因子（可加权组合），名称取站内可计算白名单：rs90 / momN / trendQuality / crossRank 等 */
  selectorFactors: Array<{ name: string; weight: number }>;
  /** 持仓数 */
  topN: number;
  /** 各仓权重（如 [0.7,0.3]），省略则等权 */
  weights?: number[];
  /** 调仓周期（交易日） */
  rebalanceDays: number;
  /** 是否同主题去重 */
  dedupTheme?: boolean;
  /** 退出规则集 */
  exits?: ModeExit[];
}

/** 主题优先单仓 spec 的入场门槛（缺省即不设该门槛） */
export interface ThemeFirstGates {
  /** 标的 mainline_persist 下限 */
  mainlinePersist?: number;
  /** 主题内 MA120 上方占比下限 */
  themeBreadthAbove120?: number;
  /** 主题 theme_amount_power 下限 */
  themeAmountPower?: number;
  /** 主题最少成员数 */
  minThemeMembers?: number;
}

/** 主题优先单仓 spec：先选主线主题，再买主题内代表标的 */
export interface ThemeFirstSpec {
  kind: 'themeFirst';
  /** 主题聚合打分因子，如 mainline_quality_score */
  themeKey: string;
  /** 主题内选代表的因子 */
  leaderKey: string;
  /** 入场门槛 */
  gates: ThemeFirstGates;
  /** 复核周期（交易日） */
  rebalanceDays: number;
  /** 最短持有交易日，未满不因排名类原因换手 */
  minHoldDays: number;
  /** 主题跌出前 N 名即退出 */
  themeTopExit: number;
  /** 盈利保护触发的浮盈阈值（小数，如 0.15） */
  protectGain: number;
  /** 盈利保护触发的峰值回撤阈值（小数，如 0.06） */
  protectDrawdown: number;
  /** 跌破该均线即退出 */
  exitMa: 20 | 30 | 60 | 120;
  /** 调仓相位锚点（python 的 active_days[0]），保证复现 */
  anchorDate: string;
}

/** 声明式策略规格：system 跟踪模式必填，引擎据此每日算持仓/信号 */
export type ModeSpec = CrossSectionSpec | ThemeFirstSpec;

/** 回测核心指标（均为可选，缺失即不展示） */
export interface ModeBacktestMetrics {
  /** 复利总收益（%），受后期权益基数放大，存在路径依赖偏差 */
  return?: number;
  /** 非复利（等权）累计收益（%），每段等权，用于去除复利的路径依赖偏差 */
  flatReturn?: number;
  annualized?: number;
  maxDrawdown?: number;
  trades?: number;
  avgPositions?: number;
  maxPositions?: number;
  winRate?: number;
}
export interface ModeCostRow {
  caliber: string;
  return?: number;
  maxDrawdown?: number;
  trades?: number;
}
export interface ModeSegmentRow {
  label: string;
  return?: number;
  maxDrawdown?: number;
  trades?: number;
}

/** 标的池来源口径 */
export type ModeUniversePolicy =
  /** 数据库 ETF 跟踪池（生产跟踪默认，会随用户增删漂移） */
  | 'db-etf-pool'
  /** mode/ 下 python 研究脚本的内置池（与回测留档同源） */
  | 'research-fallback'
  /** 调用方显式给定 */
  | 'custom';

/**
 * 模式引擎协议标记：一条跟踪/回测证据出自「哪一版引擎 / 哪个标的池 / 哪档成本」。
 * 引擎规则一改（例如修好一条从未触发的离场、给回放加上成本），同一份 spec 就会跑出
 * 不同曲线；没有这个标记，新旧样本会被混进同一个晋级门判断，看上去像同一套策略的多次验证。
 */
export interface ModeProtocolMark {
  /** 可直接展示/比对的完整口径串 */
  protocolVersion: string;
  /** 引擎语义版本。v1-legacy = supertrend 恒不触发 + 零成本回放的历史口径 */
  engineVersion: string;
  universePolicy: ModeUniversePolicy;
  /**
   * 排序后**申报池**的哈希（含影响主题归类的规范化名称）。
   * 不是「当天取数成功的子集」：一只标的瞬时取数失败就换 hash 的话，晋级门只回溯到
   * 第一次口径变更为止，样本会被截断到当天，结构上永远攒不满最小样本量。
   */
  universeHash: string;
  /** 当次实际纳入引擎的标的数（元数据，不进口径键；申报池规模见 protocolVersion） */
  poolSize: number;
  /** 单边成本（bps），买卖分列 */
  costBps: { buyBps: number; sellBps: number };
  /** 与该模式研究基准池是否同源；false = 站内跟踪结果不可与回测留档直接对比。未知为 null */
  sameAsResearchPool: boolean | null;
}

/** 回测结果列表项（不含交易记录 markdown，省带宽） */
export interface ResearchModeBacktestListItem {
  id: string;
  modeId: string;
  label: string;
  range?: string | null;
  poolSize?: number | null;
  metrics: ModeBacktestMetrics;
  costSensitivity: ModeCostRow[];
  segments: ModeSegmentRow[];
  concentrationMd?: string | null;
  isRecommended: boolean;
  /** 回测协议号（规则一改就换号；空串=改造前的历史结果，口径未知） */
  protocol: string;
  /** 引擎语义版本；历史记录回填为 v1-legacy，不可与新版结果横向比较 */
  engineVersion: string | null;
  createdAt: string;
}
export interface ResearchModeBacktestInput {
  label: string;
  range?: string;
  poolSize?: number;
  metrics: ModeBacktestMetrics;
  costSensitivity?: ModeCostRow[];
  segments?: ModeSegmentRow[];
  concentrationMd?: string;
  tradesMd?: string;
  isRecommended?: boolean;
  /** 回测协议号：规则/阈值有任何改动都必须换号，旧协议结果不再作为当前证据 */
  protocol?: string;
  /** 引擎语义版本（协议号的一部分，单列一份便于按版本过滤） */
  engineVersion?: string;
}

/** 当日应持仓 */
export interface ModeHolding {
  code: string;
  name: string;
  weight: number;
}
/** 当日买卖信号 */
export interface ModeSignalAction {
  kind: 'enter' | 'exit' | 'switch';
  code: string;
  name?: string;
  note?: string;
}
export interface ResearchModeDaily {
  modeId: string;
  date: string;
  holdings: ModeHolding[];
  signal?: ModeSignalAction[] | null;
  dayReturn?: number | null;
  cumReturn?: number | null;
  drawdown?: number | null;
  source: TrackingMode;
  /** 产出这行的引擎口径；null = 加列之前的历史行（按 v1-legacy 看待） */
  protocol?: ModeProtocolMark | null;
  createdAt?: string;
}
export interface ResearchModeDailyInput {
  date: string;
  holdings: ModeHolding[];
  signal?: ModeSignalAction[];
  dayReturn?: number;
  cumReturn?: number;
  drawdown?: number;
  /** 本次跟踪的引擎口径。同日重跑时一并刷新，否则协议会停留在上一版 */
  protocol?: ModeProtocolMark;
}

export interface ResearchModeEvent {
  id: string;
  modeId: string;
  date: string;
  kind: 'enter' | 'exit' | 'switch';
  detail?: string | null;
  createdAt: string;
}

/** 模式主体 */
export interface ResearchMode {
  id: string;
  name: string;
  category?: string | null;
  tags?: string | null;
  status: ModeStatus;
  summary?: string | null;
  buySellMd?: string | null;
  recommendedConfig?: string | null;
  analysisMd?: string | null;
  universeNote?: string | null;
  risksMd?: string | null;
  followed: boolean;
  trackingMode: TrackingMode;
  spec?: ModeSpec | null;
  source?: string | null;
  /** 该模式从多少个参数/规则变体中挑出（0=未申报，不计多重检验惩罚） */
  variantCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 列表项：附带头条收益（推荐回测的 return）与回测数 */
export interface ResearchModeListItem {
  id: string;
  name: string;
  category?: string | null;
  tags?: string | null;
  status: ModeStatus;
  summary?: string | null;
  recommendedConfig?: string | null;
  followed: boolean;
  trackingMode: TrackingMode;
  headlineReturn?: number | null;
  /** 头条非复利（等权）收益，列表优先展示此项以去除复利偏差 */
  headlineFlatReturn?: number | null;
  headlineDrawdown?: number | null;
  backtestCount: number;
  /** 申报变体数（多重检验折扣用；列表页据此算晋级门，免得再回查模式主体） */
  variantCount: number;
  /** 晋级门是否通过；null = 尚无跟踪样本，无从体检 */
  gatePassed?: boolean | null;
  updatedAt: string;
}

/** 详情：模式 + 多版本回测 + 最近跟踪 + 事件 */
export interface ResearchModeDetail {
  mode: ResearchMode;
  backtests: ResearchModeBacktestListItem[];
  recentDaily: ResearchModeDaily[];
  events: ResearchModeEvent[];
  /** 晋级门体检（跟踪样本的统计显著性；只体检不自动晋级） */
  gate: PromotionGateResult;
}

/** 站内自跟踪即时触发结果 */
export interface ModeTrackResult {
  date: string;
  holdings: ModeHolding[];
  events: Array<{ kind: 'enter' | 'exit' | 'switch'; detail: string }>;
  dayReturn: number;
  cumReturn: number;
  drawdown: number;
}

/** upsert 模式入参（codex/cursor 写 API） */
export interface ResearchModeUpsert {
  id: string;
  name: string;
  category?: string;
  tags?: string;
  status?: ModeStatus;
  summary?: string;
  buySellMd?: string;
  recommendedConfig?: string;
  analysisMd?: string;
  universeNote?: string;
  risksMd?: string;
  trackingMode?: TrackingMode;
  spec?: ModeSpec | null;
  source?: string;
  /** 从多少个变体中挑出（研究脚本登记时申报） */
  variantCount?: number;
}

// ===== 战法库（手工收录外部收集的战法）=====

/** collected 已收集 / testing 验证中 / adopted 已采用 / retired 已弃用 */
export type PlaybookStatus = 'collected' | 'testing' | 'adopted' | 'retired';

/** 持有周期：短线 / 中线 / 长线 */
export type PlaybookHorizon = 'short' | 'mid' | 'long';

/** 战法条目 */
export interface Playbook {
  id: string;
  name: string;
  /** 一句话核心 */
  summary?: string | null;
  /** 类型：打板 / 低吸 / 趋势 / 套利 / 中线… */
  category?: string | null;
  /** 逗号分隔标签 */
  tags?: string | null;
  horizon?: PlaybookHorizon | null;
  /** 适用环境逗号串：主升 / 反弹 / 退潮 / 震荡 */
  marketEnv?: string | null;
  /** 出处：书名 / 公众号 / 大V */
  source?: string | null;
  sourceUrl?: string | null;
  pickMd?: string | null;
  buyMd?: string | null;
  sellMd?: string | null;
  riskMd?: string | null;
  /** 个人心得 */
  notesMd?: string | null;
  /** 0-5 星 */
  rating: number;
  status: PlaybookStatus;
  /** 可执行回测规则；未配置则该战法只能导入外部回测结果 */
  spec?: PlaybookSpec | null;
  createdAt: string;
  updatedAt: string;
}

/** 新建 / 编辑战法入参 */
export type PlaybookUpsert = Omit<Playbook, 'id' | 'createdAt' | 'updatedAt'>;

// ---- 战法可执行规则 DSL（站内回测严格按此逐 bar 求值，不做近似替代）----

/** 数值比较符 */
export type PlaybookOp = 'gte' | 'lte' | 'gt' | 'lt';

/**
 * 单条规则条件。每条都能由日/周线严格算出，不含主观判断。
 * 除 pnlPct（仅卖出可用）外，买入/卖出条件通用。
 */
export type PlaybookRule =
  /** 价格或均线与另一条均线的关系：上方/下方/上穿/下穿 */
  | {
      kind: 'ma';
      maType: 'sma' | 'ema';
      /** 比较左侧：收盘价，或另一条均线 */
      left: 'close' | 'ma';
      /** left='ma' 时的均线周期 */
      leftPeriod?: number;
      /** 比较右侧均线周期 */
      period: number;
      relation: 'above' | 'below' | 'crossUp' | 'crossDown';
    }
  /** 均线多头/空头排列，如 [5,10,20] 依次递减为多头 */
  | { kind: 'maAlign'; maType: 'sma' | 'ema'; periods: number[]; dir: 'up' | 'down' }
  /** 近 days 根的涨跌幅（%） */
  | { kind: 'pctChange'; days: number; op: PlaybookOp; value: number }
  /** 创 days 日新高 / 新低（收盘口径） */
  | { kind: 'extreme'; extreme: 'newHigh' | 'newLow'; days: number }
  /** 量比：当根成交量 / 前 days 根均量 */
  | { kind: 'volRatio'; days: number; op: PlaybookOp; value: number }
  /** MACD(12,26,9) 状态 */
  | { kind: 'macd'; signal: 'goldCross' | 'deadCross' | 'barAbove0' | 'barBelow0' }
  /** KDJ(9,3,3) 状态；kAbove/kBelow 需给 value */
  | { kind: 'kdj'; signal: 'goldCross' | 'deadCross' | 'kAbove' | 'kBelow'; value?: number }
  /** RSI 阈值 */
  | { kind: 'rsi'; period: number; op: PlaybookOp; value: number }
  /** BOLL(20,2) 相对位置 */
  | { kind: 'boll'; pos: 'aboveUpper' | 'belowLower' | 'aboveMid' | 'belowMid' }
  /** 距近 days 根最高收盘的回撤（%，正数表示回撤幅度） */
  | { kind: 'drawdown'; days: number; op: PlaybookOp; value: number }
  /** 连续 bars 根阳线 / 阴线 */
  | { kind: 'consecutive'; dir: 'up' | 'down'; bars: number }
  /** 当根涨停 / 跌停（按代码段涨跌幅上限判定） */
  | { kind: 'limit'; dir: 'up' | 'down' }
  /** 持仓浮动盈亏（%），仅卖出规则可用 */
  | { kind: 'pnlPct'; op: PlaybookOp; value: number }
  /** 已持有 bars 根，仅卖出规则可用 */
  | { kind: 'heldBars'; op: PlaybookOp; value: number }
  // ---- 以下为标的交易计划新增规则（纯追加，旧 spec 不受影响）----
  /** 成交额比：当根成交额 / 前 days 根成交额中位数（分母不含当根） */
  | { kind: 'amountRatio'; days: number; op: PlaybookOp; value: number }
  /** 收盘位置 (close-low)/(high-low)，0=收在最低，1=收在最高 */
  | { kind: 'closeLocation'; op: PlaybookOp; value: number }
  /**
   * 绝对价位关系：计划把候选价位编译成具体数字后使用。
   * crossUp/crossDown 需前一根在另一侧；holdAbove/holdBelow 只看当根收盘；touch 看当根高低是否触及。
   */
  | {
      kind: 'priceLevel';
      level: number;
      relation: 'crossUp' | 'crossDown' | 'holdAbove' | 'holdBelow' | 'touch';
    }
  /** 计划生效以来经过的完整 bar 数（时间止损/有效期）；回测语境无计划锚点，故为 live_only */
  | { kind: 'barsSincePlan'; op: PlaybookOp; value: number };

/**
 * 规则可回测能力（R18）。
 * `backtest` 可在历史 bar 上严格求值；`live_only` 依赖实时/计划上下文，
 * `assertRunnableSpec` 遇到它必须明确拒绝，不得静默判 false。
 */
export type PlaybookRuleCapability = 'backtest' | 'live_only';

/** 规则 kind → 可回测能力。未列出的 kind 视为未注册，同样被拒绝。 */
export const PLAYBOOK_RULE_CAPABILITY: Record<string, PlaybookRuleCapability> = {
  ma: 'backtest',
  maAlign: 'backtest',
  pctChange: 'backtest',
  extreme: 'backtest',
  volRatio: 'backtest',
  macd: 'backtest',
  kdj: 'backtest',
  rsi: 'backtest',
  boll: 'backtest',
  drawdown: 'backtest',
  consecutive: 'backtest',
  limit: 'backtest',
  pnlPct: 'backtest',
  heldBars: 'backtest',
  amountRatio: 'backtest',
  closeLocation: 'backtest',
  priceLevel: 'backtest',
  barsSincePlan: 'live_only',
};

/**
 * 规则的时间语义。
 * `state`：可持续成立，每轮按最新 bar 重算即可（收盘在 MA20 上方、MACD 柱在零轴上方…）。
 * `event`：只在发生的那一根为真（金叉、上穿、触及）。多条件情景里若不做锁存，
 * 「周线金叉 + 日线站上压力位」这种组合只要不落在同一根 bar 上就永远凑不齐。
 */
export type PlaybookRuleSemantics = 'state' | 'event';

/**
 * 判定规则语义。**必须按 relation / signal 判，不能按 kind 判**——
 * 同一个 kind 下两种语义都有：macd 的 goldCross 是事件而 barAbove0 是状态，
 * ma 的 crossUp 是事件而 above 是状态，priceLevel 五个 relation 混合。
 * 按 kind 建表会把 macd 整体误判成事件，让「MACD 柱在零轴上方」被永久锁存。
 */
export function semanticsOf(rule: PlaybookRule): PlaybookRuleSemantics {
  switch (rule.kind) {
    case 'macd':
    case 'kdj':
      return rule.signal === 'goldCross' || rule.signal === 'deadCross' ? 'event' : 'state';
    case 'ma':
      return rule.relation === 'crossUp' || rule.relation === 'crossDown' ? 'event' : 'state';
    case 'priceLevel':
      return rule.relation === 'holdAbove' || rule.relation === 'holdBelow' ? 'state' : 'event';
    case 'limit':
      // 涨跌停是当根发生的事件，次日不再成立
      return 'event';
    default:
      return 'state';
  }
}

/**
 * 规则组：all=全部满足，any=任一满足。
 * MVP 不改这个 JSON 形状，已落库的 PlaybookSpec 无需迁移即可继续读取与回测（R18）。
 */
export interface PlaybookRuleGroup {
  mode: 'all' | 'any';
  rules: PlaybookRule[];
}

/** 回测标的池来源 */
export type PlaybookUniverseKind = 'codes' | 'watchlist' | 'etfPool' | 'researchUniverse';

/** 成交口径：信号在收盘确认，次日开盘 / 次日收盘成交（均无前视） */
export type PlaybookFill = 'nextOpen' | 'nextClose';

/** 战法可执行回测配置 */
export interface PlaybookSpec {
  universe: { kind: PlaybookUniverseKind; codes?: string[] };
  /** 仅日线 / 周线 */
  period: 'day' | 'week';
  /** 每只标的取多少根 K 线 */
  barLimit: number;
  entry: PlaybookRuleGroup;
  /** 卖出规则（任一满足即卖）；与下方硬止损/止盈/持有上限取先触发者 */
  exit: PlaybookRuleGroup;
  /** 硬止损（%，正数），留空不启用 */
  stopLossPct?: number | null;
  /** 硬止盈（%，正数），留空不启用 */
  takeProfitPct?: number | null;
  /** 最长持有 bar 数，留空不限 */
  maxHoldBars?: number | null;
  fill: PlaybookFill;
  /** 交易成本，留空用 A 股默认档 */
  costs?: Partial<BacktestCosts>;
}

/**
 * 标的覆盖度。取数失败/超时预算被剔除的标的**不是随机缺失**——集中在退市、长期停牌、
 * 流动性差的标的上，剔除方向系统性偏乐观，所以「申请了多少、实际纳入多少」必须随指标一起摆出来。
 */
export interface PlaybookCoverage {
  requested: number;
  included: number;
  /** 实际纳入 / 申请（0-1） */
  ratio: number;
  /** 取数失败或样本不足的标的 */
  failed: string[];
  /** 超出取数时长预算未纳入的标的 */
  skipped: string[];
}

/** 回测核心指标（站内跑与外部导入共用） */
export interface PlaybookBacktestMetrics {
  /** 累计收益（%） */
  returnPct?: number;
  annualizedPct?: number;
  maxDrawdownPct?: number;
  /** 完整交易笔数 */
  trades?: number;
  winRatePct?: number;
  /** 盈亏比（总盈利 / 总亏损） */
  profitFactor?: number;
  /** 单笔平均收益（%） */
  avgReturnPct?: number;
  /** 平均持有 bar 数 */
  avgHoldBars?: number;
  /** 最大连续亏损笔数 */
  maxConsecutiveLosses?: number;
  /**
   * 标的覆盖度。挂在 metrics 里而不是单开一列：它是「这组指标可信到什么程度」的限定语，
   * 必须与指标同生共死，且能直接搭 playbook_backtests.metrics 这份 JSON 落库，无需加列。
   */
  coverage?: PlaybookCoverage;
}

/** 逐笔成交（含成本后净收益） */
export interface PlaybookTrade {
  code: string;
  name?: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  /** 扣除成本后的收益率（%） */
  returnPct: number;
  holdBars: number;
  /** 触发卖出的原因：规则 / 止损 / 止盈 / 持有上限 / 数据结束 */
  exitReason: string;
}

/** 权益曲线点（等权组合口径） */
export interface PlaybookEquityPoint {
  date: string;
  equity: number;
}

/** 一条回测记录 */
export interface PlaybookBacktest {
  id: string;
  playbookId: string;
  label: string;
  /** system=站内引擎跑；external=外部导入 / 手工填 */
  source: 'system' | 'external';
  /** 数据区间描述 */
  range?: string | null;
  /** 参与回测的标的数 */
  poolSize?: number | null;
  metrics: PlaybookBacktestMetrics;
  trades: PlaybookTrade[];
  equity: PlaybookEquityPoint[];
  /** 口径说明（成交/成本/数据边界） */
  notes: string[];
  /** 跑这次回测用的规则快照（external 可空） */
  spec?: PlaybookSpec | null;
  createdAt: string;
}

/** 列表项：省去逐笔与权益曲线 */
export type PlaybookBacktestListItem = Omit<PlaybookBacktest, 'trades' | 'equity' | 'spec'>;

/** 外部导入回测结果入参 */
export interface PlaybookBacktestImport {
  label: string;
  range?: string;
  poolSize?: number;
  metrics: PlaybookBacktestMetrics;
  trades?: PlaybookTrade[];
  equity?: PlaybookEquityPoint[];
  notes?: string[];
}

// ===== 标的技术交易计划（个股/ETF 通用，K 线弹窗内的持续跟踪计划）=====

/** 每组证据的来源与时效元信息，缺数据一律显式降级而非静默 */
export interface EvidenceMeta {
  asOf: string;
  source: string;
  period: KlinePeriod;
  /** 是否前复权。周线降级到不复权源时为 false 并写入 warnings */
  adjusted: boolean;
  /** 最后一根 bar 是否已收完。盘中日 K 为 false，此时禁止用完整日量能口径下结论 */
  completeBar: boolean;
  stale: boolean;
  warnings: string[];
}

/** 道氏趋势状态 */
export type DowTrendState = 'uptrend' | 'downtrend' | 'range' | 'transition';

/** 确认后的摆动高低点。结构结论必须引用其 id，不能只给文字 */
export interface SwingPoint {
  id: string;
  period: KlinePeriod;
  kind: 'high' | 'low';
  time: string;
  price: number;
  /** 是否已被后续走势确认（未确认的点不得用于结构失效位） */
  confirmed: boolean;
}

/** 过渡态细分：低点抬高（待突破前高）/ 突破前高（待回踩确认） */
export type DowTransitionKind = 'higher_low' | 'breakout_pending' | null;

/** 道氏结构读数 */
export interface DowStructure {
  period: KlinePeriod;
  state: DowTrendState;
  /** state='transition' 时的细分；其余状态为 null。下游据此判定，不得靠匹配 rationale 文案 */
  transitionKind: DowTransitionKind;
  swings: SwingPoint[];
  /** 最近一个已确认高点/低点的 id，供计划引用 */
  lastConfirmedHighId: string | null;
  lastConfirmedLowId: string | null;
  /** 判定依据的人类可读说明，逐条对应引用到的 swing id */
  rationale: string[];
}

/** 缠论简化结构状态；一律保留 candidate 语义，证据不足返回 insufficient */
export type ChanSetup =
  | 'none'
  | 'first_buy_candidate'
  | 'second_buy_candidate'
  | 'third_buy_candidate'
  | 'first_sell_candidate'
  | 'second_sell_candidate'
  | 'third_sell_candidate'
  | 'insufficient';

/** 顶/底分型 */
export interface ChanFractal {
  id: string;
  kind: 'top' | 'bottom';
  time: string;
  price: number;
}

/** 候选中枢（三个次级别摆动的共同重叠区） */
export interface ChanPivotZone {
  id: string;
  low: number;
  high: number;
  startTime: string;
  endTime: string;
  /** 价格当前是否仍在中枢内 */
  active: boolean;
}

export interface ChanStructure {
  period: KlinePeriod;
  setup: ChanSetup;
  fractals: ChanFractal[];
  /** 简化笔：交替分型连线，只存端点 id 对 */
  strokes: Array<{ id: string; fromFractalId: string; toFractalId: string; dir: 'up' | 'down' }>;
  pivots: ChanPivotZone[];
  rationale: string[];
}

/** 量价状态分级（阈值见计划 4.2） */
export type VolumeState =
  | 'extreme_shrink'
  | 'clear_shrink'
  | 'mild_shrink'
  | 'normal'
  | 'mild_expand'
  | 'clear_expand'
  | 'extreme_expand';

/** 量价形态：下游据此判定，不得靠匹配 verdict 中文文案 */
export type VolumePricePattern =
  | 'heavy_down'
  | 'stall_on_volume'
  | 'breakout_confirmed'
  | 'healthy_pullback'
  | null;

/**
 * 形态判定实际采用的量能口径。成交额优先（不受复权影响），
 * 本源根本不给成交额时才回退成交量；样本不足（疑似停牌）不回退，整体为 null。
 */
export interface VolumeBasisReading {
  ratio: number;
  source: 'amount' | 'volume';
  state: VolumeState;
}

export interface VolumePriceReading {
  period: KlinePeriod;
  /** 当根成交额 / 前 20 完整根成交额中位数（分母不含当根） */
  amountRatio20: number | null;
  volumeRatio20: number | null;
  /** 成交额口径的七档定性；成交额缺失时为 null（此时看 basis 字段） */
  amountState: VolumeState | null;
  /** 实际喂给形态判定与文案的口径；量额俱不可用为 null。可选以兼容既有构造方 */
  basis?: VolumeBasisReading | null;
  /** (close-low)/(high-low) */
  closeLocation: number | null;
  /** 个股换手率（%），ETF 通常为空 */
  turnoverRate: number | null;
  /** 结构化形态标志，供阶段状态机判定 */
  pattern: VolumePricePattern;
  /** 量价定性结论，如「放量突破确认」「放量滞涨」「放量下跌」 */
  verdict: string;
  warnings: string[];
}

/** 结构化相对强弱（相对各基准的超额收益 %） */
export interface RelativeStrengthReading {
  benchmarkCode: string;
  benchmarkName: string;
  role: SymbolBenchmarkRole;
  rs5: number | null;
  rs20: number | null;
  rs60: number | null;
  /** 超额收益趋势：改善 / 走平 / 恶化 */
  trend: 'improving' | 'flat' | 'deteriorating' | 'unknown';
}

/** 板块/成分股广度证据（只读日频快照，禁止实时遍历） */
export interface BreadthEvidence {
  /** 快照所属板块或指数 */
  scopeCode: string;
  scopeName: string;
  scopeKind: 'board' | 'index';
  tradeDate: string;
  newHighCount: number;
  total: number;
  ratio: number;
  rank: number | null;
  /** 相比上一快照的变化方向 */
  trend: 'improving' | 'flat' | 'deteriorating' | 'unknown';
  /** 快照过期或无映射时为 true，页面须显示未覆盖 */
  missing: boolean;
  note: string;
}

/** 统一市场阶段（面向用户的唯一阶段，不暴露各模型分别投票） */
export type SymbolMarketPhase =
  | 'decline'
  | 'bottoming'
  | 'recovery'
  | 'uptrend'
  | 'acceleration'
  | 'distribution'
  | 'uncertain';

/** 阶段判定结果，含滞回所需的连续计数与迁移证据 */
export interface SymbolPhaseReading {
  phase: SymbolMarketPhase;
  /** 候选阶段：已满足条件但尚未达到滞回确认次数时与 phase 不同 */
  pendingPhase: SymbolMarketPhase | null;
  /** 候选阶段已连续满足的完整 bar 数 */
  pendingBars: number;
  /** 累计到哪一根 bar。持久化后回传，保证同一根 bar 内重复生成不重复累计 */
  lastBarTime: string | null;
  /** 该阶段是否为盘中未收完 bar 猜出的暂定值，收盘后第一根 K 即可直接推翻 */
  tentative?: boolean;
  /** 迁移所需的连续满足次数 */
  requiredBars: number;
  /** 盘中预警状态，不改写日线阶段 */
  intradayAlert: string | null;
  /** 迁移证据，须引用 swing/fractal id */
  evidence: string[];
  phaseModelVersion: string;
}

/**
 * 计划涉及的 K 线周期，由大到小。**周期序与可见性规则的唯一事实源**，
 * 前端图表过滤、候选分层、风险锚定都必须从这里取，不许各处自己排一遍。
 *
 * 早先计划分 next_session / swing 两条期限车道，同一标的要生成两份互不相干的计划，
 * 各自有一套有效期、时间止损与 triggerMode，用户还得在界面上手动切。
 * 现在合并为一份：时间尺度改由每条价位/条件自己的 timeframe 表达
 * —— 周线级压力位就是波段目标，60 分钟级上穿就是次日盘中触发，无需再分车道。
 */
export const PLAN_PERIODS = ['week', 'day', '60m'] as const;
export type PlanPeriod = (typeof PLAN_PERIODS)[number];

/**
 * 全部 K 线周期由粗到细。仅用于比大小，与 PLAN_PERIODS（只有这三层会产候选）不是一回事：
 * 图表可以停在月线或 15 分钟这些不产候选的周期上，可见性照样要判得出来。
 */
const PERIOD_ORDER: readonly KlinePeriod[] = [
  'month',
  'week',
  'day',
  '120m',
  '60m',
  '30m',
  '15m',
  '5m',
];

/** 周期粗细排名：数字越小周期越大 */
export function planPeriodRank(p: KlinePeriod): number {
  const i = PERIOD_ORDER.indexOf(p);
  return i < 0 ? PERIOD_ORDER.length : i;
}

/**
 * 图表处于 chartPeriod 时，timeframe=linePeriod 的计划线该不该画。
 * 规则：**本周期及更大周期的线都画，更小周期的不画**。
 * 看周线图时不该被一堆 60 分钟级触发线糊满；看 60 分钟图时周线压力位仍是有效边界。
 */
export function isPlanLineVisible(chartPeriod: KlinePeriod, linePeriod: KlinePeriod): boolean {
  return planPeriodRank(linePeriod) <= planPeriodRank(chartPeriod);
}

/**
 * 持有时长口径：短期 = 次日到本周内要完成的动作，中长期 = 数周到数月的仓位安排。
 *
 * 界面按这个分栏而不是按 K 线周期，是因为「60 分钟」「周线」说的是判定用哪根 bar，
 * 回答不了「这条线是让我明天就动手，还是拿几个月」——而后者才是决定要不要现在下单的问题。
 * 唯一事实源放在这里，禁止前端各页各判一遍。
 */
export type PlanSpan = 'short' | 'long';

export function planSpanOf(tf: KlinePeriod): PlanSpan {
  // 比日线更粗的（周、月）才算中长期；日线及更细的都在一周内要有结论
  return planPeriodRank(tf) < planPeriodRank('day') ? 'long' : 'short';
}

export const PLAN_SPAN_LABEL: Record<PlanSpan, string> = {
  short: '短期（次日到本周内）',
  long: '中长期（数周到数月）',
};

export type SymbolPlanAction = 'wait' | 'probe' | 'add' | 'hold' | 'reduce' | 'exit';

export type SymbolPlanStatus =
  | 'draft'
  | 'active'
  | 'triggered'
  | 'invalid'
  | 'completed'
  | 'expired'
  | 'superseded';

/**
 * 「仍然生效」的状态。盘中引擎求值、图上挂辅助线、给可下单指令都只认这几种。
 *
 * 放在 shared 作唯一事实源：前端要用它区分「计划刚失效」和「从未生成过计划」——
 * 两者都拿不到生效计划，但一个该显示失效原因，另一个该引导去生成，
 * 各写一套白名单迟早对不上，用户看到的就是「计划无缘无故消失了」。
 */
export const PLAN_LIVE_STATUSES: readonly SymbolPlanStatus[] = ['draft', 'active', 'triggered'];

export function isPlanLive(status: SymbolPlanStatus): boolean {
  return PLAN_LIVE_STATUSES.includes(status);
}

export type TradeLevelRole =
  | 'support'
  | 'resistance'
  | 'entry_trigger'
  | 'add_trigger'
  | 'invalidation'
  | 'stop'
  | 'target';

export interface TradeLevel {
  id: string;
  role: TradeLevelRole;
  timeframe: KlinePeriod;
  price?: number;
  zoneLow?: number;
  zoneHigh?: number;
  label: string;
  rationale: string;
  evidenceIds: string[];
  /**
   * 该价位由哪些来源汇聚而成，原样透传自被选中的 CandidateLevel.sources。
   *
   * 不带这个字段的话，图上的黄金分割虚线与计划价位线就是两套互不相认的东西：
   * 用户打开分割图层后多出一堆虚线，却无从判断哪条正是计划采纳的触发线来源。
   * candidateId（形如 lvl:week:0:12.340）只编码了周期与排名，反查不出来源。
   *
   * 可选：本字段晚于计划表上线，历史行解析出来是 undefined，此时前端不显示溯源即可，
   * 设成必填等于对老计划撒谎。
   */
  sources?: CandidateLevelSource[];
}

/** 计划条件直接包装并扩展现有 PlaybookRule，不发明第二套 DSL */
export interface PlanCondition {
  id: string;
  rule: PlaybookRule;
  timeframe: KlinePeriod;
  description: string;
  required: boolean;
  evidenceIds: string[];
}

/**
 * 条件求值频率。放在 shared 是因为前端也要据此逐条件显示「盘中触发 / 收盘确认」
 * —— 早先这个信息是计划级的单个 execution.triggerMode，由 horizon 一刀切定成
 * swing=收盘确认、next_session=盘中预警，跟条件实际怎么判完全脱节：
 * 一份 swing 计划里的「上穿 12.30」明明是 tick 级触发，界面却写着收盘确认。
 *
 * 只有 priceLevel 的 crossUp/crossDown/touch 能按 tick 做 O(1) 比较；
 * holdAbove/holdBelow 是收盘口径，与均线/MACD/量价一样必须等整根 bar 收完。
 */
export function cadenceOf(cond: PlanCondition): 'tick' | 'bar' {
  if (cond.rule.kind === 'priceLevel') {
    return cond.rule.relation === 'holdAbove' || cond.rule.relation === 'holdBelow' ? 'bar' : 'tick';
  }
  return 'bar';
}

/**
 * 把按基准价算出的股数等比换算到另一个成交价（向下取整到整手，A 股最小交易单位）。
 *
 * 风险金额 = 股数 × (成交价 − 止损价) 是固定的，就是风险预算本身，所以股数与
 * 「成交价到止损的距离」成反比。计划的建仓股数在准备上下文时按现价算出，
 * 那时 LLM 还没挑触发价；若照搬到更高的触发价上下单，实际风险距离变大，
 * 亏损会同比例超出预算——一次就能把「单笔最多亏 1%」变成亏 1.5%。
 *
 * @returns 换算后的整手股数；入参不成立（价格非正、成交价不在止损上方）时返回 null，不猜。
 */
export function rescaleSharesToEntry(
  shares: number,
  basisPrice: number,
  entryPrice: number,
  stopPrice: number,
): number | null {
  if (!(shares > 0) || !(basisPrice > stopPrice) || !(entryPrice > stopPrice) || !(stopPrice > 0)) {
    return null;
  }
  return Math.floor((shares * (basisPrice - stopPrice)) / (entryPrice - stopPrice) / 100) * 100;
}

/**
 * 主路径触发条件的待办进度：排序 + 计数 + 还差哪几条。
 *
 * 放在 shared 而不是组件里，是为了让「只统计触发条件」这条不变式能被自检锁住——
 * 失效条件是反向语义，满足它意味着计划作废，一旦混进「已满足 M/N」就会把
 * 「快触发了」和「快作废了」显示成同一件事。
 *
 * @param conditions 主路径的**触发**条件（不要传失效条件）
 * @param satisfied 逐条件的命中判定；尚未复核时传 () => undefined
 */
export function planConditionProgress(
  conditions: PlanCondition[],
  satisfied: (id: string) => boolean | undefined,
): { ordered: PlanCondition[]; done: number; total: number; missing: PlanCondition[] } {
  // 必要条件置顶：required 决定「非它不可」还是「锦上添花」，不排在前面等于没这个字段
  const ordered = [...conditions].sort((a, b) => Number(b.required) - Number(a.required));
  const missing = ordered.filter((c) => !satisfied(c.id));
  return { ordered, done: ordered.length - missing.length, total: ordered.length, missing };
}

export interface TradeScenario {
  id: string;
  rank: 'primary' | 'alternative' | 'risk';
  name: string;
  conditions: PlanCondition[];
  action: SymbolPlanAction;
  invalidConditions: PlanCondition[];
  /**
   * 目标价位 id，**按优先级排列，首项即第一目标**。
   * 预测核对（forecast.ts）只认首项：取「首个可解析项」会让判定结果随数组顺序漂移，
   * 同一份计划两次落库能判出不同结局，校准表也就失去了复现性。
   */
  targetLevelIds: string[];
  /** 模型主观概率，只展示不参与计算；口径见 SymbolTradePlanProposal.scenarioSelections */
  subjectiveProbabilityPct?: number;
  probabilityBasis?: string;
}

/**
 * 波动率锥：按 σ_N = σ_日 × √N 张开的未来价格区间。
 * 纯算术，不含任何模型判断——它回答的是「按历史波动，价格大致会散到哪」，
 * 不回答「会往哪走」。方向那一层由情景折线表达，两者刻意分开画。
 */
export interface ProjectionCone {
  /** 计算基准价（最后一根收盘） */
  basePrice: number;
  /** 日对数收益标准差（小数，非百分比） */
  sigmaDaily: number;
  /** 参与估计的样本根数 */
  sampleSize: number;
  /** 未来第 step 根（1-based）的上下轨 */
  steps: Array<{
    step: number;
    p1Low: number;
    p1High: number;
    p2Low: number;
    p2High: number;
  }>;
}

/** 走势推演响应：算术锥 + 模型主观概率，两层语义独立，界面上必须分开表述 */
export interface SymbolPlanProjection {
  cone: ProjectionCone | null;
  scenarios: Array<{
    id: string;
    rank: 'primary' | 'alternative' | 'risk';
    name: string;
    /** 模型主观估计，未经校准。只展示，不参与计算 */
    probabilityPct: number;
    basis: string | null;
    /** 同档位历史记录数与已判定/兑现数，样本不足时界面只显示记录数 */
    calibration: { recorded: number; settled: number; hit: number };
  }>;
}

/** 基准角色 */
export type SymbolBenchmarkRole =
  | 'underlying_index'
  | 'sector'
  | 'peer'
  | 'broad_market'
  | 'relative_strength';

export interface SymbolBenchmark {
  code: string;
  name: string;
  role: SymbolBenchmarkRole;
  /** 东财 secid。指数与个股撞码，取 K 线必须显式传；无行情源的基准留空并跳过相对强弱 */
  secid?: string | null;
}

/** 账户侧持仓上下文：市场判断不受它影响，账户动作必须考虑它 */
export interface SymbolPositionContext {
  state: 'none' | 'holding';
  quantity: number;
  availableQuantity: number;
  avgCost: number | null;
  currentWeightPct: number;
  unrealizedPnlPct: number | null;
  allowedWeightPct: number | null;
  concentrationWarnings: string[];
}

// ---- 候选目录（计划 4.11）：LLM 只能从这里挑，不得自由填价 ----

/** 候选价位来源 */
export type CandidateLevelSource =
  | 'swing'
  | 'pivot_zone'
  | 'prev_extreme'
  | 'ma'
  | 'classic_pivot'
  | 'fibonacci'
  | 'adapter';

export interface CandidateLevel {
  candidateId: string;
  contextId: string;
  candidateModelVersion: string;
  timeframe: KlinePeriod;
  /** 聚类后的价格区，单一价位时 low===high */
  low: number;
  high: number;
  /** 代表价（区间中值） */
  price: number;
  sources: CandidateLevelSource[];
  /** 该价位可承担的语义角色，LLM 从中选一个 */
  compatibleRoles: TradeLevelRole[];
  score: number;
  /** 评分分项，供证据抽屉展示 */
  scoreParts: {
    structureImportance: number;
    historicalTouch: number;
    distance: number;
    confluence: number;
    recency: number;
  };
  /** 距现价的 ATR 倍数（正=上方，负=下方） */
  atrDistance: number | null;
  label: string;
  description: string;
  sourceEvidenceIds: string[];
  /** 保底候选（结构失效位、最近摆动点）不因总分低被裁掉 */
  guaranteed: boolean;
}

/** 候选条件用途分组，用于分组限量 */
export type CandidateConditionPurpose =
  | 'price_level'
  | 'volume_confirm'
  | 'structure_confirm'
  | 'time_window'
  | 'gate';

export interface CandidateCondition {
  candidateId: string;
  contextId: string;
  candidateModelVersion: string;
  purpose: CandidateConditionPurpose;
  rule: PlaybookRule;
  timeframe: KlinePeriod;
  description: string;
  /** 由哪个候选价位展开而来（非价位类条件为 null） */
  fromLevelCandidateId: string | null;
  /**
   * 该条件适合承担的角色（触发 / 失效 / 目标）。
   * 已成立的条件会被摘掉 'invalidation'，见 alreadySatisfied；
   * 方向已错过的事件型条件（见 directionMissed）会被摘空，任何角色都用不了。
   */
  suitableFor: Array<'trigger' | 'invalidation' | 'target'>;
  /**
   * 建目录时这条规则**当下就已成立**。
   *
   * 存在的意义是拦住「出生即失效」的计划：失效条件的语义是「将来若发生则计划作废」，
   * 拿一个已经发生的事实当失效条件，计划一落库、第一次复核就判失效——
   * 用户看到的是一份写着 exit 却当场作废的计划，收盘重算还会每天再产一份。
   * 对触发条件不是问题（「已经站上均线」本就可以是入场依据），故只摘 invalidation 用途。
   */
  alreadySatisfied?: boolean;
  /**
   * 事件型价位条件的**方向已经错过**：现价已在该价位的另一侧，
   * 事件要成立得先原路走回去再穿一次。
   *
   * 与 alreadySatisfied 是两码事，必须单独判：`crossDown` 在「价位已在现价上方」时
   * 最后一根并没有穿，状态型判据看不出问题，于是它照常留在失效候选里——
   * 而它实际永远不会成立，失效保护形同虚设；对称地已被上穿的压力位若被挑成
   * `crossUp` 触发条件（触发条件一律 required），整份计划会永远无法触发。
   * 故这类条件的所有用途都摘掉。
   */
  directionMissed?: boolean;
  evidenceIds: string[];
  capability: PlaybookRuleCapability;
}

export interface CandidateCatalog {
  contextId: string;
  candidateModelVersion: string;
  /** 目录内容哈希，用于检测跨快照混用 */
  catalogHash: string;
  levels: CandidateLevel[];
  conditions: CandidateCondition[];
  /** 各来源被裁掉的数量，禁止静默截断 */
  omittedCounts: Record<string, number>;
  warnings: string[];
  createdAt: string;
  expiresAt: string;
}

/** 技术上下文：只回摘要与 contextId，候选目录另用独立工具取 */
export interface SymbolTechnicalContext {
  contextId: string;
  candidateModelVersion: string;
  evidenceVersion: string;
  code: string;
  name: string;
  assetType: SymbolAssetType;
  /** 东财 secid，随上下文一路带到计划落库，见 SymbolTradePlan.secid */
  secid: string | null;
  asOf: string;
  dataStatus: 'complete' | 'provisional' | 'degraded';
  /** 每周期一行读数，不含原始 K 线数组 */
  periods: Array<{
    meta: EvidenceMeta;
    close: number;
    ma20: number | null;
    ma60: number | null;
    atr: number | null;
    atrPct: number | null;
    macdState: string | null;
    barCount: number;
  }>;
  dow: DowStructure | null;
  chan: ChanStructure | null;
  volumePrice: VolumePriceReading | null;
  phase: SymbolPhaseReading;
  relativeStrength: RelativeStrengthReading[];
  breadth: BreadthEvidence | null;
  benchmarks: SymbolBenchmark[];
  /** 执行质量与事件风险，缺数据显式标注 */
  executionQuality: Array<{ key: string; value: string; missing: boolean }>;
  eventRisks: Array<{ kind: string; date: string | null; note: string }>;
  positionContext: SymbolPositionContext | null;
  /** 大盘阶段与板块阶段，只用于收紧不放大 */
  marketRegimePhase: string | null;
  boardStage: string | null;
  /** 候选目录数量摘要，完整目录走 list_symbol_plan_candidates */
  candidateSummary: { levels: number; conditions: number; catalogHash: string };
  activePlan: { id: string; version: number; status: SymbolPlanStatus } | null;
  existingMarkCount: number;
  warnings: string[];
}

export type SymbolAssetType = 'stock' | 'etf' | 'index';

/** LLM 唯一允许提交的缩小输入：只选后端已给出的候选 ID */
export interface SymbolTradePlanProposal {
  contextId: string;
  candidateModelVersion: string;
  catalogHash: string;
  summary: string;
  changes: string[];
  levelSelections: Array<{
    candidateLevelId: string;
    role: TradeLevelRole;
    label?: string;
  }>;
  scenarioSelections: Array<{
    rank: 'primary' | 'alternative' | 'risk';
    name: string;
    conditionCandidateIds: string[];
    invalidConditionCandidateIds: string[];
    /** 目标候选价位 id，按优先级排列，首项即第一目标；必须都出现在 levelSelections 里，否则落库后解析不出价 */
    targetCandidateLevelIds: string[];
    /**
     * 模型对该情景的主观概率（0~100）。**只用于展示，禁止参与任何计算**。
     *
     * 这是一个未经校准的数：LLM 报 70% 时并不意味着这类判断长期兑现七成。
     * 一旦它流进仓位、止损或告警的计算，事后就再也分不清某次超配是模型看错了
     * 还是这个数本身没根——所以 risk.ts / evaluate.ts / 告警链路一律不读它，
     * 由 selfcheck 扫源码强制（见 symbolPlanProjection.selfcheck.ts）。
     *
     * 每次落库 symbol_plan_forecasts，到期自动核对，这个数才有机会变准。
     */
    subjectiveProbabilityPct?: number;
    /** 模型给出该概率的依据，一句话。空着就不显示，不编 */
    probabilityBasis?: string;
  }>;
}

export interface SymbolTradePlanRisk {
  structuralStop: number | null;
  volatilityStop: number | null;
  executionStop: number | null;
  atrPct: number | null;
  maxAccountRiskPct: number;
  suggestedPositionPct: number | null;
  timeStopBars: number | null;
  gapRiskNote: string | null;
  /**
   * 风险预算允许的持股数（已向下取整到整手）与需减持股数，直接取自 computeSizing。
   * 只给百分比等于把「换算成能下单的量」甩给用户心算，而这一步恰恰最容易算错。
   * 账户未接入时为 null——此时只能给百分比，界面必须照实说，不能拿 0 冒充。
   */
  allowedShares: number | null;
  reduceShares: number | null;
  /** 有效损失距离 %（结构位与 2×ATR 取大，再叠加跳空与费用缓冲） */
  effectiveLossPct: number | null;
  /** 上面这些股数按哪个价算出。实际挂单价不同于它时必须等比换算，见 rescaleSharesToEntry */
  sizingBasisPrice: number | null;
}

export interface SymbolTradePlanExitPlan {
  firstTakeProfitLevelId: string | null;
  secondTakeProfitLevelId: string | null;
  trailingRule: string | null;
  reduceFractions: number[];
  profitProtectionRule: string | null;
}

export interface SymbolTradePlanExecution {
  // 无 triggerMode：触发口径按条件粒度由 cadenceOf(cond) 决定，见该函数注释
  chaseGuardAtr: number | null;
  maxPremiumPct: number | null;
  maxSpreadPct: number | null;
  nextReviewAt: string;
}

export interface SymbolTradePlan {
  id: string;
  version: number;
  code: string;
  name: string;
  assetType: SymbolAssetType;
  /**
   * 东财 secid（如 `1.000300`）。求值与预测结算必须用它取 K 线：
   * 指数与个股撞码，单凭 code 会把 000300 解析成深市个股，拿另一只标的的 OHLC 判触及。
   * 旧计划为 null。
   */
  secid: string | null;
  status: SymbolPlanStatus;
  asOf: string;
  validFrom: string;
  expiresAt: string | null;
  dataStatus: 'complete' | 'provisional' | 'degraded';
  /** 以下五项由后端从证据直接派生，LLM 不得提交 */
  marketPhase: SymbolMarketPhase;
  trendState: DowTrendState;
  chanSetup: ChanSetup;
  marketAction: SymbolPlanAction;
  primaryAction: SymbolPlanAction;
  summary: string;
  changes: string[];
  levels: TradeLevel[];
  scenarios: TradeScenario[];
  positionContext: SymbolPositionContext | null;
  risk: SymbolTradePlanRisk;
  exitPlan: SymbolTradePlanExitPlan;
  execution: SymbolTradePlanExecution;
  benchmarks: SymbolBenchmark[];
  assetSpecificRisks: string[];
  /** 生成时的证据快照，供历史回看与口径追溯 */
  evidenceSnapshot: unknown;
  evidenceVersion: string;
  phaseModelVersion: string;
  candidateModelVersion: string;
  contextId: string | null;
  sessionId: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 计划生命周期事件 */
export type SymbolPlanEventKind =
  | 'created'
  | 'activated'
  | 'condition_hit'
  | 'triggered'
  | 'invalidated'
  | 'expired'
  | 'reviewed'
  | 'superseded';

export interface SymbolPlanEvent {
  id: string;
  planId: string;
  planVersion: number;
  kind: SymbolPlanEventKind;
  /** 触发该事件的条件 id（若有） */
  conditionId: string | null;
  note: string;
  createdAt: string;
}

/** 计划结果归因（复盘只评价计划条件，不混入用户是否成交） */
export type SymbolPlanOutcome =
  | 'correct_wait'
  | 'valid_trigger'
  | 'false_breakout'
  | 'structure_invalidated'
  | 'time_expired'
  | 'execution_blocked'
  | 'data_degraded'
  | 'user_override';

/** 单条条件的求值状态 */
export interface PlanConditionState {
  conditionId: string;
  satisfied: boolean;
  /** 本轮刚由未满足变为满足 */
  justHit: boolean;
  /** 该条件的求值频率：价格条件走 tick，技术条件走 bar */
  cadence: 'tick' | 'bar';
  detail: string;
  evaluatedAt: string;
}

export interface SymbolPlanEvaluation {
  planId: string;
  planVersion: number;
  status: SymbolPlanStatus;
  conditions: PlanConditionState[];
  triggered: boolean;
  /**
   * 计划整份失效。**只统计 rank !== 'risk' 的情景**：风险情景的失效条件本就是
   * 「该减仓了」这件事本身，把它算成整份失效会灰化所有价位线，用户拿不到减仓指令。
   */
  invalidated: boolean;
  /**
   * 本轮判为触发的情景，供前端显示「触发的是哪条路径、该做什么动作」。
   * `via='invalidation'` 表示这是风险情景的失效条件命中（即减仓/清仓信号），
   * 与主路径的触发条件命中（`via='trigger'`）刻意区分开。
   */
  triggeredScenarios: Array<{
    scenarioId: string;
    rank: TradeScenario['rank'];
    action: SymbolPlanAction;
    via: 'trigger' | 'invalidation';
  }>;
  expired: boolean;
  needsNewVersion: boolean;
  summary: string;
  evaluatedAt: string;
}
