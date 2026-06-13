import type { ModelConfig, NotifyChannel, RunTrigger, StreamEvent } from '@stock-agent/shared';
import * as gateway from './agent/gateway';

export interface RunnableTask {
  id: string | null;
  name: string | null;
  prompt: string;
  modelConfig: ModelConfig;
  notifyChannels: NotifyChannel[];
  timeoutSec: number;
  /** 绑定的战法（存在时 agent 可用 sim_trade 落该战法账户） */
  strategy?: { id: string; name: string } | null;
  /** 调用用途分类（落 llm_calls）；缺省按定时任务计 */
  purpose?: string;
  /** 强制成交：sim_trade 跳过交易时段校验（收盘后按收盘价补买等） */
  forceTrade?: boolean;
}

export interface RunTaskResult {
  runId: string;
  status: string;
  outputText: string;
}

/**
 * 执行一个任务的完整生命周期。仅作为统一门面 gateway.call（agent 模式）的薄封装，
 * 保留既有调用方签名；运行管理、调用记录、瞬时重试、失败告警、自动推送全部由 gateway 接管。
 */
export async function runTask(
  task: RunnableTask,
  trigger: RunTrigger,
  onEvent?: (e: StreamEvent) => void,
): Promise<RunTaskResult> {
  const result = await gateway.call({
    mode: 'agent',
    trigger,
    purpose: task.purpose ?? 'scheduled-task',
    taskId: task.id ?? null,
    taskName: task.name,
    prompt: task.prompt,
    modelConfig: task.modelConfig,
    timeoutSec: task.timeoutSec,
    strategy: task.strategy ?? null,
    forceTrade: task.forceTrade ?? false,
    notifyChannels: task.notifyChannels,
    onEvent,
  });
  return {
    runId: result.runId ?? '',
    status: result.status,
    outputText: result.outputText,
  };
}
