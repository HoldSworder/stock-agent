import type { AiAnalysisHistoryItem, ModelConfig, StreamEvent } from '@stock-agent/shared';

// 公共 AI 分析「类型注册表」。
// 每个分析能力（kind）声明：任务名、prompt 构造、可选前置校验、历史作用域键、模型配置。
// 通用 WS（/ws/analyze）据 kind 查表后跑 agent 并流式回传，新增能力只需 registerKind。

/** 自定义执行器运行上下文 */
export interface AnalysisRunCtx {
  /** 流式事件回调（合成 tool_call/tool_result/token，复用 agentTrace 渲染） */
  onEvent: (e: StreamEvent) => void;
  /** 中止信号 */
  signal: AbortSignal;
}

/** 自定义执行器产出（替代默认 buildPrompt→gateway.agent 路径） */
export interface AnalysisRunResult {
  /** 落历史库的正文 */
  outputText: string;
  /** 历史作用域键（缺省回退 deriveRefKey） */
  refKey?: string | null;
  /** 运行状态（缺省 success；canceled 不入库） */
  status?: 'success' | 'timeout' | 'error' | 'canceled';
  /** 计量聚合（缺省由内部各 stage 自计，置空） */
  promptTokens?: number;
  completionTokens?: number;
  /** 运行 ID（缺省 null） */
  runId?: string | null;
}

/** 驾驶舱 AI 分析中心的能力分组 */
export type AnalysisGroup =
  | '复盘'
  | '大盘'
  | '板块主线'
  | 'ETF'
  | '研报'
  | '热点'
  | '情报'
  | '持仓'
  | '决策';

export interface AnalysisKindDef {
  /** 运行名 + 历史标题 */
  taskName: string;
  /** 中心卡片标题（缺省回退 taskName） */
  title?: string;
  /** 驾驶舱中心分组 */
  group: AnalysisGroup;
  /**
   * 作用域：global（无标的，可在中心一键发起）/ perStock（需个股，中心仅展示历史 + 引导去对应页）。
   * 缺省 global。
   */
  scope?: 'global' | 'perStock';
  /**
   * 历史读取器：置位即「外部持久化型」——历史不读 ai_analyses，改读此函数
   * （如 taskRun 复盘类读 task_runs、热点读 trend_summaries），与今日计划读取口径一致。
   */
  loadHistory?: (limit: number) => AiAnalysisHistoryItem[];
  /**
   * 跳过 ai_analyses 自动落库：置位用于「外部已持久化」的 kind（taskRun / trend_summaries 已落库），
   * 避免双写、保住今日计划读取。通常与 loadHistory 同时设置。
   */
  skipAutoSave?: boolean;
  /** 运行成功后的回调（如复盘验证回流共享主线）。best-effort，不应抛错。 */
  onSuccess?: (outputText: string) => void;
  /** 据入参构造 agent 指令 prompt */
  buildPrompt: (params: Record<string, unknown>) => string | Promise<string>;
  /**
   * 可选自定义流式执行器：存在时 /ws/analyze 走此路径（如多 agent 辩论编排），
   * 否则走默认 buildPrompt→gateway.agent。buildPrompt 仍需声明（兜底/类型完整）。
   */
  run?: (params: Record<string, unknown>, ctx: AnalysisRunCtx) => Promise<AnalysisRunResult>;
  /** 前置校验：抛错即中止本次分析（如无持仓），错误信息回传前端 */
  preflight?: (params: Record<string, unknown>) => void | Promise<void>;
  /** 历史作用域键（如股票代码）；全局类返回 null/不实现 */
  deriveRefKey?: (params: Record<string, unknown>) => string | null;
  /** 模型配置（缺省 thinking:false / maxSteps:12） */
  modelConfig?: ModelConfig;
  /** 运行超时（秒，缺省 300） */
  timeoutSec?: number;
  /** 调用用途分类（缺省 analyze） */
  purpose?: string;
  /**
   * 底层模块定时引用（唯一映射来源）：声明该能力对应的 defineModuleSchedules job。
   * AI 分析中心「定时调度」据此把能力 join 到 /api/schedules 项，就地开关 / 改 cron / 触发。
   * 无对应定时（如 perStock 决策）则不声明。
   */
  scheduleRef?: { module: string; jobId: string };
}

const kinds = new Map<string, AnalysisKindDef>();

export function registerKind(kind: string, def: AnalysisKindDef): void {
  kinds.set(kind, def);
}

export function getKind(kind: string): AnalysisKindDef | null {
  return kinds.get(kind) ?? null;
}

/** 全部已注册 kind（驾驶舱 AI 分析中心目录用），按注册顺序返回 */
export function listKinds(): Array<{ kind: string; def: AnalysisKindDef }> {
  return [...kinds.entries()].map(([kind, def]) => ({ kind, def }));
}
