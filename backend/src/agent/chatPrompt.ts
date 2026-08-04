import type { SymbolPlanHorizon } from '@stock-agent/shared';
import { PROMPT_KEYS, getPrompt } from './promptConfig';

// 聊天一轮的最终 prompt 组装。抽成纯函数是为了让注入规则可被自检覆盖：
// horizon 钉错车道会让计划落到另一张卡片上，是这里唯一真正危险的失误。

/** 车道枚举 → 中文名，供提示词占位符与前端文案对齐 */
const HORIZON_LABEL: Record<SymbolPlanHorizon, string> = {
  next_session: '下一交易日',
  swing: '1~4 周波段',
};

export interface ChatPromptInput {
  /** 标的专属会话的标的代码；为空表示普通会话 */
  refCode?: string | null;
  refName?: string | null;
  /** 用户原文（落库的也是这一份，不含任何注入） */
  content: string;
  /** 快捷按钮带来的一键生成意图；仅对标的会话生效 */
  planIntent?: SymbolPlanHorizon | null;
}

/**
 * 组装送给模型的 prompt。
 * 普通会话原样返回用户输入；标的会话前置标的上下文；
 * 标的会话且带 planIntent 时，再插入钉死 horizon 的标准计划指令。
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

  const horizon = input.planIntent;
  if (horizon === 'next_session' || horizon === 'swing') {
    parts.push(
      getPrompt(PROMPT_KEYS.symbolPlanGenerate)
        .replaceAll('{horizonLabel}', HORIZON_LABEL[horizon])
        .replaceAll('{horizon}', horizon),
    );
  }

  parts.push(input.content);
  return parts.join('\n\n');
}
