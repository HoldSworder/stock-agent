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
 * advice 产出长度上限（含截断标记）。advice 会直接进 Telegram 推送与驾驶舱告警行，
 * 模型偶尔把整段思考写在散文里，不设上限会让一条告警撑满整屏。
 */
const ADVICE_MAX = 400;
const CUT_MARK = '…（原文过长已截断）';

/**
 * 超长正文尾部截断并留痕，便于回看时知道被截过而不是模型只说了这些。
 * 按码点而非 UTF-16 码元切分：直接 slice 会把 emoji 等代理对切成孤立高位，
 * 落库与 Telegram 推送都会渲染成替换字符。
 */
function capAdvice(s: string): string {
  const t = s.trim();
  if (t.length <= ADVICE_MAX) return t;
  const budget = ADVICE_MAX - CUT_MARK.length;
  return `${[...t].slice(0, budget).join('')}${CUT_MARK}`;
}

/**
 * 从任意文本里切出终审 JSON。
 * 以最后一个 `}` 为终点，起点从左往右逐个 `{` 试探，取第一个能 parse 成功的片段——
 * 模型常在散文里写花括号（举例、伪代码），固定用首个 `{` 当起点会把散文并进来导致整段解析失败，
 * 进而丢掉尾部那段合法裁决，让依赖 verdict 的自动卖出静默不执行。
 */
function extractVerdictJson(text: string): Record<string, unknown> | null {
  const end = text.lastIndexOf('}');
  if (end === -1) return null;
  for (let from = 0; ; ) {
    const start = text.indexOf('{', from);
    if (start === -1 || start > end) return null;
    try {
      const obj: unknown = JSON.parse(text.slice(start, end + 1));
      if (obj && typeof obj === 'object') return obj as Record<string, unknown>;
    } catch {
      /* 该起点切出的片段不是合法 JSON，换下一个 `{` 继续试 */
    }
    from = start + 1;
  }
}

/**
 * 解析终审产出：从任意位置切出终审 JSON 再 parse，
 * 根治「散文在前 + JSON 在后」导致围栏剥离法失败、整段 blob 混入 advice 的问题。
 *
 * advice 绝不回落到整段原文——原文里混着模型的思考过程（常含英文自言自语），
 * 落进告警正文既误导人又会撑破前端布局。分三级：
 *   1. JSON 里的 advice 字段（超长截断留痕）
 *   2. 字段缺失时返回空串，交由调用方回退到触发原因（`advice || detail`）——
 *      占位文案会把下游那层兜底吃掉，让「因为什么触发」这个真信息永久丢失
 *   3. 整段 JSON 都解析不出时才用原文，但截断并标注「未按结构化格式输出」
 */
export function parseVerdict(text: string): Verdict {
  // 空产出不构成告警：此时既无裁决也无正文，推送出去只会是一条空消息
  if (!text.trim()) {
    return { shouldAlert: false, verdict: '', advice: '', instruction: null };
  }
  const obj = extractVerdictJson(text);
  if (obj) {
    const adviceText = typeof obj.advice === 'string' ? obj.advice.trim() : '';
    return {
      shouldAlert: Boolean(obj.shouldAlert),
      verdict: typeof obj.verdict === 'string' ? obj.verdict : '',
      advice: adviceText ? capAdvice(adviceText) : '',
      instruction: parseInstruction(obj.instruction),
    };
  }
  // 解析失败：保守按「值得提示」处理，正文用截断后的原文并标明格式异常
  return {
    shouldAlert: true,
    verdict: '',
    advice: `模型未按结构化格式输出，原文：${capAdvice(text)}`,
    instruction: null,
  };
}
