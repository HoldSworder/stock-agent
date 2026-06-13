import type { ModelConfig, StreamEvent } from '@stock-agent/shared';

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

export interface AnalysisKindDef {
  /** 运行名 + 历史标题 */
  taskName: string;
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
}

const kinds = new Map<string, AnalysisKindDef>();

export function registerKind(kind: string, def: AnalysisKindDef): void {
  kinds.set(kind, def);
}

export function getKind(kind: string): AnalysisKindDef | null {
  return kinds.get(kind) ?? null;
}
