import { PROMPT_KEYS, getPrompt } from './promptConfig';

// 聊天一轮的最终 prompt 组装。抽成纯函数是为了让注入规则可被自检覆盖。

export interface ChatPromptInput {
  /** 标的专属会话的标的代码；为空表示普通会话 */
  refCode?: string | null;
  refName?: string | null;
  /** 用户原文（落库的也是这一份，不含任何注入） */
  content: string;
  /** 快捷按钮带来的一键生成意图；仅对标的会话生效 */
  planIntent?: boolean | null;
}

/**
 * 组装送给模型的 prompt。
 * 普通会话原样返回用户输入；标的会话前置标的上下文；
 * 标的会话且带 planIntent 时，再插入固定工具序列的标准计划指令。
 */
export function buildChatPrompt(input: ChatPromptInput): string {
  const code = input.refCode?.trim();
  if (!code) return input.content;

  const name = input.refName?.trim();
  const parts = [
    getPrompt(PROMPT_KEYS.symbolSession)
      .replaceAll('{code}', code)
      .replaceAll('{name}', name ? ` ${name}` : ''),
  ];

  if (input.planIntent) parts.push(getPrompt(PROMPT_KEYS.symbolPlanGenerate));

  parts.push(input.content);
  return parts.join('\n\n');
}
