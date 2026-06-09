import type OpenAI from 'openai';
import type { ModelConfig, RunStatus, StreamEvent } from '@stock-agent/shared';
import { getLLM } from '../llm';
import { appendRunMessage } from '../repo';
import { toolDefinitions, toolMap, type ToolContext } from './tools';

const BASE_SYSTEM_PROMPT = `你是一个 A 股投研与交易助手，运行在用户自建的选股平台中。
你可以调用妙想（东方财富）数据/选股/资讯/自选股/模拟盘工具获取真实行情并执行操作。
工作准则：
- 结论必须基于工具返回的真实数据，严禁编造行情或财务数字。
- 选股/选板块给出明确结论后，调用 save_stock_picks 把标的结构化留痕，便于复盘。
- 仅当用户明确要求推送时才调用 notify_telegram；定时任务结果由平台自动推送，无需自行调用。
- 推送/输出禁止使用 Markdown 表格（用竖排清单），尾盘选股类需包含现价。
- 回答精炼、条理清晰，给出依据来源。`;

export interface RunAgentOptions {
  runId: string;
  prompt: string;
  systemPrompt?: string;
  modelConfig: ModelConfig;
  history?: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  timeoutSec: number;
  onEvent?: (e: StreamEvent) => void;
}

export interface RunAgentResult {
  status: RunStatus;
  outputText: string;
  promptTokens: number;
  completionTokens: number;
  error?: string;
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { client, model } = getLLM();
  const useModel = opts.modelConfig.model || model;
  const maxSteps = opts.modelConfig.maxSteps ?? 12;
  const emit = opts.onEvent ?? (() => {});

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: opts.systemPrompt || BASE_SYSTEM_PROMPT },
    ...(opts.history ?? []),
    { role: 'user', content: opts.prompt },
  ];
  appendRunMessage({ runId: opts.runId, role: 'user', content: opts.prompt });

  const ctx: ToolContext = { runId: opts.runId };
  let promptTokens = 0;
  let completionTokens = 0;
  let finalText = '';

  const deadline = Date.now() + opts.timeoutSec * 1000;

  for (let step = 0; step < maxSteps; step++) {
    if (Date.now() > deadline) {
      return {
        status: 'timeout',
        outputText: finalText,
        promptTokens,
        completionTokens,
        error: '运行超时',
      };
    }

    const stream = await client.chat.completions.create({
      model: useModel,
      messages,
      tools: toolDefinitions,
      temperature: opts.modelConfig.temperature ?? 0.3,
      stream: true,
      stream_options: { include_usage: true },
    });

    let content = '';
    const toolCallAcc = new Map<
      number,
      { id: string; name: string; args: string }
    >();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
        completionTokens = chunk.usage.completion_tokens ?? completionTokens;
      }
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.content) {
        content += delta.content;
        emit({ type: 'token', text: delta.content });
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          const cur = toolCallAcc.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolCallAcc.set(idx, cur);
        }
      }
    }

    const toolCalls = [...toolCallAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((v) => v.name);

    // 无工具调用：本轮为最终回答
    if (toolCalls.length === 0) {
      finalText = content;
      if (content) {
        appendRunMessage({ runId: opts.runId, role: 'assistant', content });
        emit({ type: 'message', role: 'assistant', content });
      }
      return { status: 'success', outputText: finalText, promptTokens, completionTokens };
    }

    // 记录 assistant 的工具调用意图
    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: t.args || '{}' },
      })),
    });
    appendRunMessage({
      runId: opts.runId,
      role: 'assistant',
      content: content || null,
      toolCalls: JSON.stringify(toolCalls.map((t) => ({ name: t.name, args: t.args }))),
    });

    // 执行工具
    for (const call of toolCalls) {
      emit({ type: 'tool_call', name: call.name, args: call.args });
      let result: string;
      let ok = true;
      try {
        const parsed = call.args ? JSON.parse(call.args) : {};
        const tool = toolMap.get(call.name);
        if (!tool) throw new Error(`未知工具: ${call.name}`);
        result = await tool.run(parsed, ctx);
      } catch (e) {
        ok = false;
        result = `工具执行失败: ${e instanceof Error ? e.message : String(e)}`;
      }
      emit({ type: 'tool_result', name: call.name, ok, preview: result.slice(0, 300) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      appendRunMessage({
        runId: opts.runId,
        role: 'tool',
        content: result,
        toolName: call.name,
      });
    }
  }

  return {
    status: 'error',
    outputText: finalText,
    promptTokens,
    completionTokens,
    error: `超过最大步数 ${maxSteps}`,
  };
}
