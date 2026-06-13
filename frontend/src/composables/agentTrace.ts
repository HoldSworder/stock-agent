import type { StreamEvent } from '@stock-agent/shared';

// agent 流式轨迹的共享数据模型与归约器。
// ChatView 与公共 AI 分析弹窗共用：把 token/reasoning/tool_call/tool_result 事件
// 累积为可渲染的步骤序列（文本/思考/工具调用分段）。run_started/run_finished/context/error
// 等带副作用的事件由各调用方自行处理，本模块只做纯轨迹累积。

/** agent 轨迹的一步：纯文本 / 思考 / 工具调用 */
export type Step =
  | { kind: 'text'; content: string }
  | { kind: 'think'; content: string }
  | {
      kind: 'tool';
      id?: string;
      name: string;
      args: string;
      result: string;
      ok: boolean;
      done: boolean;
      open: boolean;
    };

/** 解析 think 工具入参里的 thought 文本 */
export function parseThought(args: string): string {
  try {
    const o = JSON.parse(args || '{}');
    return typeof o.thought === 'string' ? o.thought : args;
  } catch {
    return args;
  }
}

/**
 * 将一个流式事件应用到步骤序列（就地修改 steps）。
 * 仅处理轨迹相关事件（token/reasoning/tool_call/tool_result），其余事件忽略。
 */
export function applyStepEvent(steps: Step[], e: StreamEvent): void {
  if (e.type === 'token') {
    // 追加到末尾 text 步骤；若末尾非 text 则新建一段，实现文本/工具分段轨迹
    const tail = steps[steps.length - 1];
    if (tail?.kind === 'text') tail.content += e.text;
    else steps.push({ kind: 'text', content: e.text });
  } else if (e.type === 'reasoning') {
    // 原生推理增量：累加到末尾 think 步骤；末尾非 think 则新建一段
    const tail = steps[steps.length - 1];
    if (tail?.kind === 'think') tail.content += e.text;
    else steps.push({ kind: 'think', content: e.text });
  } else if (e.type === 'tool_call') {
    if (e.name === 'think') {
      steps.push({ kind: 'think', content: parseThought(e.args) });
    } else {
      steps.push({
        kind: 'tool',
        id: e.id,
        name: e.name,
        args: e.args,
        result: '',
        ok: true,
        done: false,
        open: false,
      });
    }
  } else if (e.type === 'tool_result') {
    // 优先按 id 精确回填（并发同名工具不错位）；缺 id 时回退「最近未完成同名」
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s.kind !== 'tool' || s.done) continue;
      if (e.id ? s.id === e.id : s.name === e.name) {
        s.result = e.preview;
        s.ok = e.ok;
        s.done = true;
        break;
      }
    }
  }
}
