import type { ModelConfig, NotifyChannel, RunTrigger, StreamEvent } from '@stock-agent/shared';
import { runAgent } from './agent/loop';
import { createRun, finishRun } from './repo';
import { sendTelegram } from './notify/telegram';

export interface RunnableTask {
  id: string | null;
  name: string | null;
  prompt: string;
  modelConfig: ModelConfig;
  notifyChannels: NotifyChannel[];
  timeoutSec: number;
}

export interface RunTaskResult {
  runId: string;
  status: string;
  outputText: string;
}

/** 执行一个任务的完整生命周期：建运行记录 → agent → 收尾 → 按渠道推送 */
export async function runTask(
  task: RunnableTask,
  trigger: RunTrigger,
  onEvent?: (e: StreamEvent) => void,
): Promise<RunTaskResult> {
  const runId = createRun({
    taskId: task.id,
    taskName: task.name,
    trigger,
    inputPrompt: task.prompt,
  });
  onEvent?.({ type: 'run_started', runId });

  try {
    const result = await runAgent({
      runId,
      prompt: task.prompt,
      modelConfig: task.modelConfig,
      timeoutSec: task.timeoutSec,
      onEvent,
    });

    finishRun(runId, {
      status: result.status,
      outputText: result.outputText,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      error: result.error ?? null,
    });

    // 定时/手动任务：按渠道自动推送最终结果
    if (
      task.notifyChannels.includes('telegram') &&
      result.outputText &&
      result.status === 'success'
    ) {
      const title = task.name ? `【${task.name}】\n` : '';
      await sendTelegram(title + result.outputText);
    }

    onEvent?.({ type: 'run_finished', runId, status: result.status });
    return { runId, status: result.status, outputText: result.outputText };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    finishRun(runId, { status: 'error', error: msg });
    onEvent?.({ type: 'error', message: msg });
    onEvent?.({ type: 'run_finished', runId, status: 'error' });
    return { runId, status: 'error', outputText: '' };
  }
}
