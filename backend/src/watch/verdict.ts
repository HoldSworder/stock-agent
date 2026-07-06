import type { WatchActionType, WatchInstruction } from '@stock-agent/shared';

// 盯盘终审产出解析（纯函数，无副作用，便于单测）：
// 从 agent 文本里稳健切出 JSON，解析裁决 + 结构化执行指令。

/** 终审 JSON 结构 */
export interface Verdict {
  shouldAlert: boolean;
  verdict: string;
  advice: string;
  /** 结构化执行指令（买卖建议）；解析不出为 null */
  instruction: WatchInstruction | null;
}

/** 合法动作集合（解析校验，落到非枚举值时回退 null instruction） */
const WATCH_ACTIONS: ReadonlySet<string> = new Set<WatchActionType>([
  '买入',
  '加仓',
  '持有',
  '减仓',
  '清仓',
  '关注',
  '观望',
  '跳过',
]);

/** 任意值转有限数字，非法为 null */
function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
}

/** 从终审 JSON 的 instruction 字段构造结构化执行指令；缺/非法 action 视为无指令 */
export function parseInstruction(raw: unknown): WatchInstruction | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const action = typeof o.action === 'string' ? o.action.trim() : '';
  if (!WATCH_ACTIONS.has(action)) return null;
  return {
    action: action as WatchActionType,
    entryLow: numOrNull(o.entryLow),
    entryHigh: numOrNull(o.entryHigh),
    sizePct: numOrNull(o.sizePct),
    stopLoss: numOrNull(o.stopLoss),
    takeProfit: numOrNull(o.takeProfit),
    invalidation: typeof o.invalidation === 'string' ? o.invalidation.trim() : '',
    reason: typeof o.reason === 'string' ? o.reason.trim() : '',
  };
}

/**
 * 解析终审产出：从任意位置切出首个 `{` 到末个 `}` 的 JSON 再 parse，
 * 根治「散文在前 + JSON 在后」导致围栏剥离法失败、整段 blob 混入 advice 的问题。
 */
export function parseVerdict(text: string): Verdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as Partial<Verdict> & {
        instruction?: unknown;
      };
      return {
        shouldAlert: Boolean(obj.shouldAlert),
        verdict: typeof obj.verdict === 'string' ? obj.verdict : '',
        advice: typeof obj.advice === 'string' && obj.advice.trim() ? obj.advice : text.trim(),
        instruction: parseInstruction(obj.instruction),
      };
    } catch {
      /* 落到下方保守兜底 */
    }
  }
  // 解析失败：保守按「值得提示」处理，正文用原文
  return { shouldAlert: true, verdict: '', advice: text.trim(), instruction: null };
}
