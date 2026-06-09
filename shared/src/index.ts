// 前后端共享的 DTO 类型定义。
// 后端 (Fastify) 与前端 (Vue) 都从这里导入，保证接口契约一致。

export type RunTrigger = 'cron' | 'manual' | 'chat';
export type RunStatus = 'running' | 'success' | 'error' | 'timeout';
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

/** 结构化选股留痕 —— 复盘核心 */
export interface StockPick {
  id: string;
  runId: string | null;
  code: string;
  name: string;
  price: number | null;
  /** 选入理由 */
  reason: string | null;
  /** 量价/技术信号，JSON 字符串 */
  signals: string | null;
  /** 逗号分隔标签，如 "尾盘套利,机器人" */
  tags: string | null;
  pickedAt: string;
}

export interface StockPickInput {
  code: string;
  name: string;
  price?: number | null;
  reason?: string | null;
  signals?: Record<string, unknown> | null;
  tags?: string[] | null;
}

/** 真实持仓中的单个标的（来源：同花顺投资账本，经 portfolio-sync 校正当日盈亏） */
export interface RealPosition {
  code: string;
  name: string;
  /** 市场代码（同花顺：1=沪 / 其他=深等） */
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
export interface RealPortfolio {
  /** 快照数据时间（ISO） */
  asOf: string;
  /** 快照来源日期 YYYY-MM-DD */
  sourceDate: string;
  /** OpenViking 来源 URI */
  sourceUri: string;
  /** 现金余额 */
  cash: number;
  positionCount: number;
  /** 持仓总市值 */
  totalMarketValue: number;
  /** 总资产 = 现金 + 持仓市值 */
  totalAsset: number;
  /** 累计持有盈亏 */
  totalHoldProfit: number;
  /** 当日盈亏合计 */
  totalTodayProfit: number;
  positions: RealPosition[];
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

/** 设置项（key-value）。模型为任意 OpenAI 兼容服务，非固定 DeepSeek。 */
export interface AppSettings {
  /** OpenAI 兼容服务的 Base URL */
  llmBaseUrl: string;
  /** 模型名 */
  llmModel: string;
  /** 出于安全，读取时仅返回是否已配置 */
  llmApiKeySet: boolean;
  emApiKeySet: boolean;
  mxApiKeySet: boolean;
  telegramBotTokenSet: boolean;
  telegramChatId: string;
  telegramThreadId: string;
  /** OpenViking 真实持仓数据源 */
  ovBaseUrl: string;
  ovApiKeySet: boolean;
  ovAccount: string;
  ovUser: string;
  ovEventsPrefix: string;
}

/** WebSocket 流式事件 */
export type StreamEvent =
  | { type: 'run_started'; runId: string }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; name: string; args: string }
  | { type: 'tool_result'; name: string; ok: boolean; preview: string }
  | { type: 'message'; role: MessageRole; content: string }
  | { type: 'run_finished'; runId: string; status: RunStatus }
  | { type: 'error'; message: string };

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
