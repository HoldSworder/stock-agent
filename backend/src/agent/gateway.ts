import type OpenAI from 'openai';
import type {
  ModelConfig,
  NotifyChannel,
  RunStatus,
  RunTrigger,
  StreamEvent,
} from '@stock-agent/shared';
import { getLLM } from '../llm';
import { createRun, finishRun } from '../repo';
import { trackedChat } from '../usage';
import { sendTelegram } from '../notify/telegram';
import { runAgent } from './loop';

// ============================================================================
// 统一 LLM 出入口（唯一门面）。
// 全系统所有 LLM / agent 调用必须经此 call()，门面统一接管：
//   - 全局运行管理（runs：createRun/finishRun，进「Agent 运行中」抽屉）
//   - 调用记录（llm_calls：由 runAgent / trackedChat 内部落库）
//   - 瞬时错误重试、失败告警（仅 cron）、成功后可选自动推送
// 严禁业务侧再裸调 getLLM() / runAgent / trackedChat —— 一律走本门面。
//
//   mode='agent'   多步带工具的 agent 循环（支持流式 onEvent / history / 战法）
//   mode='oneshot' 单次 chat 分析（研报研判、热点研判、盯盘初筛等）
// ============================================================================

/** 失败告警：仅对后台定时任务（cron）推送，便于无人值守时及时发现；手动/流式调用方已自见错误 */
async function notifyFailure(
  taskName: string | null | undefined,
  trigger: RunTrigger,
  msg: string,
): Promise<void> {
  if (trigger !== 'cron') return;
  const title = taskName ? `【${taskName}】` : '定时任务';
  await sendTelegram(`⚠️ ${title} 执行失败\n${msg}`).catch(() => {});
}

interface GatewayBase {
  /** 调用用途分类（落 llm_calls，区分计量） */
  purpose: string;
  /** 任务名（运行管理与调用明细展示用） */
  taskName?: string | null;
  /** 运行触发来源 */
  trigger: RunTrigger;
  /** 是否建立全局 run（仅对 oneshot 生效，默认 true）；false=仅落调用记录、不进运行管理（如高频初筛/连通测试） */
  recordRun?: boolean;
  /** 流式事件回调（仅 agent 模式有 token/tool 轨迹；门面额外透传 run_started/run_finished） */
  onEvent?: (e: StreamEvent) => void;
}

/** 多步带工具的 agent 调用（恒建 run） */
export interface AgentCall extends GatewayBase {
  mode: 'agent';
  /** 绑定的中央定时任务 id，用于运行记录归属与战法每日产出反查 */
  taskId?: string | null;
  prompt: string;
  systemPrompt?: string;
  history?: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  modelConfig: ModelConfig;
  timeoutSec: number;
  /** 绑定的战法（存在时 agent 可用 sim_trade 落该战法账户） */
  strategy?: { id: string; name: string } | null;
  /** 强制成交：sim_trade 跳过交易时段校验 */
  forceTrade?: boolean;
  /** 运行中止信号：abort 后 agent 尽快停止并以 status='canceled' 返回 */
  signal?: AbortSignal;
  /** prompt 缓存键：稳定值（如 chat:<sessionId>）提升上游前缀缓存命中；缺省按 purpose+taskId 派生 */
  cacheKey?: string;
  /** 成功后自动推送的渠道（含 telegram 时推送最终结果） */
  notifyChannels?: NotifyChannel[];
}

/** 单次 chat 分析调用 */
export interface OneShotCall extends GatewayBase {
  mode: 'oneshot';
  prompt: string;
  systemPrompt?: string;
  /** 覆盖模型（缺省用全局模型，如初筛用轻度模型） */
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export type GatewayCall = AgentCall | OneShotCall;

export interface GatewayResult {
  /** 建立的运行 id；recordRun=false 时为 null */
  runId: string | null;
  status: RunStatus;
  outputText: string;
  promptTokens: number;
  completionTokens: number;
  error?: string;
}

/** 全系统唯一 LLM 出入口。永不抛错：失败以 GatewayResult.status='error' 返回，调用方据 status 决策。 */
export async function call(opts: GatewayCall): Promise<GatewayResult> {
  return opts.mode === 'agent' ? runAgentCall(opts) : runOneShotCall(opts);
}

/** agent 模式：恒建 run（agent 需 run 承载消息轨迹），含瞬时重试 + 失败告警 + 可选自动推送 */
async function runAgentCall(opts: AgentCall): Promise<GatewayResult> {
  const runId = createRun({
    taskId: opts.taskId ?? null,
    taskName: opts.taskName ?? null,
    trigger: opts.trigger,
    inputPrompt: opts.prompt,
  });
  opts.onEvent?.({ type: 'run_started', runId });

  try {
    // 不在此重跑整个 runAgent：瞬时错误已由 loop 内 createStreamWithRetry 在「请求层」吸收。
    // 整轮重试会重放已执行的工具调用（含 sim_trade/mx_trade），有重复下单与浪费 token 隐患，故收敛。
    const result = await runAgent({
      runId,
      prompt: opts.prompt,
      systemPrompt: opts.systemPrompt,
      history: opts.history,
      modelConfig: opts.modelConfig,
      timeoutSec: opts.timeoutSec,
      strategy: opts.strategy ?? null,
      forceTrade: opts.forceTrade ?? false,
      purpose: opts.purpose,
      taskName: opts.taskName ?? null,
      signal: opts.signal,
      cacheKey: opts.cacheKey ?? `${opts.purpose}:${opts.taskId ?? opts.taskName ?? 'agent'}`,
      onEvent: opts.onEvent,
    });

    finishRun(runId, {
      status: result.status,
      outputText: result.outputText,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      error: result.error ?? null,
    });

    if (opts.notifyChannels?.includes('telegram') && result.outputText && result.status === 'success') {
      const title = opts.taskName ? `【${opts.taskName}】\n` : '';
      await sendTelegram(title + result.outputText);
    }
    if (result.status === 'error') {
      await notifyFailure(opts.taskName, opts.trigger, result.error ?? '未知错误');
    }

    opts.onEvent?.({ type: 'run_finished', runId, status: result.status });
    return {
      runId,
      status: result.status,
      outputText: result.outputText,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      error: result.error,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    finishRun(runId, { status: 'error', error: msg });
    opts.onEvent?.({ type: 'error', message: msg });
    opts.onEvent?.({ type: 'run_finished', runId, status: 'error' });
    await notifyFailure(opts.taskName, opts.trigger, msg);
    return { runId, status: 'error', outputText: '', promptTokens: 0, completionTokens: 0, error: msg };
  }
}

/** 单次分析：可选建 run；LLM 调用经 trackedChat 落 llm_calls */
async function runOneShotCall(opts: OneShotCall): Promise<GatewayResult> {
  const runId =
    opts.recordRun !== false
      ? createRun({
          taskId: null,
          taskName: opts.taskName ?? null,
          trigger: opts.trigger,
          inputPrompt: opts.prompt,
        })
      : null;

  try {
    const { client, model } = getLLM();
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (opts.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt });
    messages.push({ role: 'user', content: opts.prompt });

    const res = await trackedChat(
      client,
      {
        model: opts.model || model,
        messages,
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens != null ? { max_tokens: opts.maxTokens } : {}),
      },
      { purpose: opts.purpose, runId, taskName: opts.taskName ?? null },
    );

    const outputText = res.choices[0]?.message?.content ?? '';
    const promptTokens = res.usage?.prompt_tokens ?? 0;
    const completionTokens = res.usage?.completion_tokens ?? 0;
    if (runId) finishRun(runId, { status: 'success', outputText, promptTokens, completionTokens });
    return { runId, status: 'success', outputText, promptTokens, completionTokens };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (runId) finishRun(runId, { status: 'error', error: msg });
    return { runId, status: 'error', outputText: '', promptTokens: 0, completionTokens: 0, error: msg };
  }
}
