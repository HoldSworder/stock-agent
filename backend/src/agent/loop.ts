import type OpenAI from 'openai';
import type { ModelConfig, RunStatus, StreamEvent } from '@stock-agent/shared';
import { getLLM } from '../llm';
import { recordLlmCall } from '../usage';
import { appendRunMessage } from '../repo';
import { broadcast } from '../ws';
import {
  getToolDefinitions,
  toolMap,
  buildSearchToolDef,
  matchToolDefs,
  getCoreToolNames,
  SEARCH_TOOLS_NAME,
  type ToolContext,
} from './tools';
import { getStrategy } from '../strategy/sim';
import { getStrategyDirectiveAddon } from '../strategy/skill';
import { getContextWindow, getValue } from '../settings';
import { isAbortError, withLlmRetry } from './retry';
import { PROMPT_KEYS, getPrompt } from './promptConfig';

// 全局提示词（基础 system / 深思指令 / 压缩器 system）已抽至 promptConfig.ts 作为单一来源，
// 经中枢·提示词页可覆盖；此处通过 getPrompt 取生效值。

/** 返回 Asia/Shanghai 的实时上下文片段，注入 system，让行情判断有时间锚点 */
function buildTimeContext(): string {
  const tz = 'Asia/Shanghai';
  const now = new Date();
  const dateStr = now.toLocaleString('zh-CN', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const hm = hour * 60 + minute;
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  let phase: string;
  if (isWeekend) phase = '休市（周末）';
  else if (hm < 9 * 60 + 15) phase = '盘前';
  else if (hm <= 11 * 60 + 30) phase = '盘中（上午）';
  else if (hm < 13 * 60) phase = '午间休市';
  else if (hm <= 15 * 60) phase = '盘中（下午）';
  else phase = '盘后';
  return `\n\n## 当前时间\n现在是 ${dateStr}（${tz}），交易阶段：${phase}。涉及"今天/最新/尾盘/收盘"等判断以此为准。`;
}

export interface RunAgentOptions {
  runId: string;
  prompt: string;
  systemPrompt?: string;
  modelConfig: ModelConfig;
  history?: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  timeoutSec: number;
  /** 绑定的战法：存在时挂载 sim_trade / sim_positions，买卖落该战法模拟账户 */
  strategy?: { id: string; name: string } | null;
  /** 强制成交：sim_trade 跳过交易时段校验（收盘后按收盘价补买等） */
  forceTrade?: boolean;
  /** 调用用途分类（落 llm_calls，区分计量）；缺省按定时任务计 */
  purpose?: string;
  /** 任务名（明细展示用） */
  taskName?: string | null;
  /** 运行中止信号：abort 后尽快停止采样并以 status='canceled' 返回（省 token） */
  signal?: AbortSignal;
  /** prompt 缓存键：稳定值（如 chat:<sessionId>）以提升上游前缀缓存命中 */
  cacheKey?: string;
  onEvent?: (e: StreamEvent) => void;
}

export interface RunAgentResult {
  status: RunStatus;
  outputText: string;
  promptTokens: number;
  completionTokens: number;
  error?: string;
}

/** 是否为上下文超长错误（供反应式压缩重试） */
function isContextOverflow(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? '';
  if (code === 'context_length_exceeded') return true;
  const msg = (e instanceof Error ? e.message : String(e ?? '')).toLowerCase();
  return (
    msg.includes('context_length_exceeded') ||
    msg.includes('maximum context length') ||
    msg.includes('reduce the length') ||
    (msg.includes('context') && msg.includes('length') && msg.includes('token'))
  );
}

// ===== 上下文预算与压缩（仿 Codex：超阈值压缩 + 溢出反应式重试 + head-trim 兜底）=====

/** 触发压缩的上下文占用比例（相对可用窗口，已扣除输出预留） */
const COMPACT_RATIO = 0.75;
/** 压缩/裁剪后仍保留的最近原始消息条数（不含 system） */
const KEEP_RECENT_MSGS = 8;
/** 工具结果回放的 token 子预算占上下文窗口的比例（按预算裁剪，而非固定条数） */
const TOOL_BUDGET_RATIO = 0.4;
/** 未显式指定 maxTokens 时，预算里默认为输出预留的 token 量 */
const DEFAULT_RESERVED_OUTPUT = 4096;
/** 连续压缩仍溢出的上限，超过则 head-trim 兜底（仿 Codex 连续失败上限） */
const MAX_COMPACT_RETRY = 3;
/** 喂给压缩模型的历史序列化上限（字符） */
const COMPACT_INPUT_CHARS = 12000;
const TOOL_OMITTED_PLACEHOLDER = '[旧工具结果已省略]';
/** 单个工具调用的超时（毫秒）：超时按工具失败返回让模型改道，不中止整轮 */
const TOOL_TIMEOUT_MS = 30000;
/** 同名 + 相同入参的工具调用允许真实执行的次数；超过则短路回提示，防环路烧 token */
const MAX_SAME_TOOL_CALLS = 2;
/** 写/副作用类工具：本轮若含这些则全部串行执行以保序、避免竞态 */
const SERIAL_TOOLS = new Set([
  'mx_trade',
  'sim_trade',
  'mx_self_select',
  'notify_telegram',
  'save_today_plan',
  'propose_skill_update',
]);

type ChatMessages = OpenAI.Chat.Completions.ChatCompletionMessageParam[];

// CJK（中日韩）字符：tokenizer 下约 0.6 token/字；其余（拉丁/数字/符号）约 0.25 token/字（≈chars/4）。
// 之前统一 chars/4 对中文低估 ~2 倍，导致压缩触发过晚——这里按 CJK 加权，更贴近真实占用。
// eslint-disable-next-line no-control-regex
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const TOKEN_PER_CJK = 0.6;
const TOKEN_PER_OTHER = 0.25;

/** CJK 加权估算单串 token 数 */
function strTokens(s: string): number {
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) if (CJK_RE.test(ch)) cjk += 1;
  const other = s.length - cjk;
  return Math.ceil(cjk * TOKEN_PER_CJK + other * TOKEN_PER_OTHER);
}

/** 单条消息的原始字符数（含工具调用入参），用于 usage 标定的字符基数 */
function messageChars(m: OpenAI.Chat.Completions.ChatCompletionMessageParam): number {
  let n = typeof m.content === 'string' ? m.content.length : m.content ? JSON.stringify(m.content).length : 0;
  const tc = (m as { tool_calls?: { function?: { arguments?: string; name?: string } }[] }).tool_calls;
  if (tc) for (const c of tc) n += (c.function?.arguments?.length ?? 0) + (c.function?.name?.length ?? 0);
  return n;
}

/** 整组消息原始字符总数（用于按真实 usage 标定 token/char 系数） */
function rawChars(messages: ChatMessages): number {
  let n = 0;
  for (const m of messages) n += messageChars(m);
  return n;
}

/** CJK 加权静态估算整组消息 token 数（无需引 tokenizer 依赖） */
function estimateTokensStatic(messages: ChatMessages): number {
  let t = 0;
  for (const m of messages) {
    const body = typeof m.content === 'string' ? m.content : m.content ? JSON.stringify(m.content) : '';
    t += strTokens(body) + 4;
    const tc = (m as { tool_calls?: { function?: { arguments?: string; name?: string } }[] }).tool_calls;
    if (tc) for (const c of tc) t += strTokens(c.function?.arguments ?? '') + strTokens(c.function?.name ?? '');
  }
  return t;
}

/**
 * 工具结果回放裁剪：从最新往旧累计 tool 结果 token，达到子预算后更早的 tool 内容替换为占位。
 * 至少保留最近一个 tool 全文（即便单条超预算）。仅作用于「发给模型的副本」，不改持久化/运行内的真实
 * messages，保证 tool_call 配对完整。
 */
function trimToolResults(messages: ChatMessages, budgetTokens: number): ChatMessages {
  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'tool') toolIdx.push(i);
  if (toolIdx.length === 0) return messages;
  const keepFull = new Set<number>();
  let acc = 0;
  for (let j = toolIdx.length - 1; j >= 0; j -= 1) {
    const i = toolIdx[j];
    const c = messages[i].content;
    const t = strTokens(typeof c === 'string' ? c : c ? JSON.stringify(c) : '');
    // 始终保留最近一个全文；其余按累计 token 子预算保留
    if (keepFull.size === 0 || acc + t <= budgetTokens) {
      keepFull.add(i);
      acc += t;
    } else {
      break;
    }
  }
  if (keepFull.size === toolIdx.length) return messages;
  return messages.map((m, i) =>
    m.role === 'tool' && !keepFull.has(i) ? { ...m, content: TOOL_OMITTED_PLACEHOLDER } : m,
  );
}

/** 把一段消息序列化为可读历史文本（供压缩模型阅读），并按上限做头尾截断 */
function serializeForSummary(messages: ChatMessages): string {
  const lines = messages.map((m) => {
    const role = m.role;
    let body = typeof m.content === 'string' ? m.content : m.content ? JSON.stringify(m.content) : '';
    const tc = (m as { tool_calls?: { function?: { name?: string; arguments?: string } }[] }).tool_calls;
    if (tc?.length) {
      body += tc.map((c) => `\n[调用工具 ${c.function?.name}] ${c.function?.arguments ?? ''}`).join('');
    }
    const tag = role === 'tool' ? `工具结果(${(m as { tool_call_id?: string }).tool_call_id ?? ''})` : role;
    return `### ${tag}\n${body}`;
  });
  const text = lines.join('\n\n');
  if (text.length <= COMPACT_INPUT_CHARS) return text;
  const head = Math.floor(COMPACT_INPUT_CHARS * 0.6);
  const tail = COMPACT_INPUT_CHARS - head;
  return `${text.slice(0, head)}\n...[中部省略]...\n${text.slice(-tail)}`;
}

/** 找到可安全保留的最近 K 条消息起点（不切断 assistant(tool_calls)→tool 配对） */
function safeKeepStart(rest: ChatMessages, keepN: number): number {
  let start = Math.max(0, rest.length - keepN);
  // tail 起点若是 tool 消息，会丢失其前置 assistant(tool_calls) → 前移直至非 tool
  while (start > 0 && rest[start].role === 'tool') start -= 1;
  return start;
}

/**
 * Codex 式压缩：把较早历史用 LLM 压成 handoff 摘要后物理替换。
 * 保留：system + 摘要(user) + 最近 KEEP_RECENT_MSGS 条原始消息（保证工具配对）。
 * 失败时退回 head-trim（直接丢弃较早消息），保证流程不被压缩本身阻断。
 */
async function compactMessages(
  client: OpenAI,
  messages: ChatMessages,
  ctx: {
    runId: string;
    purpose: string;
    taskName: string | null;
    signal?: AbortSignal;
    /** 累计压缩调用的 token 成本到 run 汇总（与 llm_calls 明细对齐） */
    addCost?: (promptTokens: number, completionTokens: number) => void;
  },
): Promise<ChatMessages> {
  const system = messages[0];
  const rest = messages.slice(1);
  const keepStart = safeKeepStart(rest, KEEP_RECENT_MSGS);
  const toSummarize = rest.slice(0, keepStart);
  const kept = rest.slice(keepStart);
  if (toSummarize.length === 0) return messages; // 没有可压缩的早期历史

  const summaryModel = getValue('llmLightModel') || getValue('llmModel');
  const startedAt = Date.now();
  try {
    const res = await client.chat.completions.create(
      {
        model: summaryModel,
        messages: [
          {
            role: 'system',
            content: getPrompt(PROMPT_KEYS.compactSystem),
          },
          { role: 'user', content: serializeForSummary(toSummarize) },
        ],
        temperature: 0.2,
        max_tokens: 1200,
      },
      { signal: ctx.signal },
    );
    recordLlmCall({
      purpose: `${ctx.purpose}-compact`,
      model: res.model || summaryModel,
      promptTokens: res.usage?.prompt_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - startedAt,
      success: true,
      runId: ctx.runId,
      taskName: ctx.taskName,
    });
    ctx.addCost?.(res.usage?.prompt_tokens ?? 0, res.usage?.completion_tokens ?? 0);
    const summary = res.choices[0]?.message?.content?.trim();
    if (!summary) return [system, ...kept];
    return [
      system,
      { role: 'user', content: `## 早前对话压缩摘要（自动生成，替代已省略的历史）\n${summary}` },
      ...kept,
    ];
  } catch (e) {
    // 含 abort：不外抛（由上层 aborted() 检查统一收口），压缩失败一律 head-trim 兜底
    if (isAbortError(e)) return [system, ...kept];
    recordLlmCall({
      purpose: `${ctx.purpose}-compact`,
      model: summaryModel,
      latencyMs: Date.now() - startedAt,
      success: false,
      error: e instanceof Error ? e.message : String(e),
      runId: ctx.runId,
      taskName: ctx.taskName,
    });
    // 压缩失败兜底：直接 head-trim 丢弃早期历史，仍保留 system + 最近消息
    return [system, ...kept];
  }
}

/** head-trim 兜底：反应式压缩仍溢出时，强行丢弃最早的一批非 system 消息 */
function headTrim(messages: ChatMessages): ChatMessages {
  const system = messages[0];
  const rest = messages.slice(1);
  if (rest.length <= 2) return messages;
  // 丢弃前半段，保留后半段（并修正 tool 配对起点）
  const start = safeKeepStart(rest, Math.max(2, Math.ceil(rest.length / 2)));
  return [system, ...rest.slice(start)];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 单个工具执行超时错误（区别于 abort：超时按工具失败让模型改道，不中止整轮） */
class ToolTimeoutError extends Error {}
function isToolTimeout(e: unknown): boolean {
  return e instanceof ToolTimeoutError;
}

/**
 * 工具执行护栏：与中止信号竞速（abort → AbortError）并施加 per-call 超时（超时 → ToolTimeoutError）。
 * 无论哪种先到都尽快 settle 并清理监听/定时器，避免泄漏。
 */
function withToolGuard<T>(p: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')));
    const timer = setTimeout(
      () => finish(() => reject(new ToolTimeoutError('工具执行超时'))),
      timeoutMs,
    );
    if (signal?.aborted) return finish(() => reject(new DOMException('Aborted', 'AbortError')));
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

/** 工具调用指纹（同名 + 归一化入参），用于重复调用环路保护 */
function toolFingerprint(name: string, args: string): string {
  let norm = (args || '').trim();
  try {
    norm = JSON.stringify(sortKeys(JSON.parse(args || '{}')));
  } catch {
    /* 入参非 JSON：用原文 */
  }
  return `${name}:${norm}`;
}

/** 递归按键名排序，使等价对象产出稳定字符串（供指纹比对） */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return v;
}

/** 一段 assistant 文本是否为「实质正文」（而非「好的我来做…」之类的过程铺垫） */
function isSubstantive(text: string): boolean {
  const s = text.trim();
  if (s.length >= 80) return true;
  if (/(^|\n)\s*#{1,6}\s/.test(s)) return true; // 标题
  if (/(^|\n)\s*[-*]\s/.test(s)) return true; // 列表
  if (/\|.*\|/.test(s)) return true; // 表格
  if (s.includes('\n')) return true; // 多行
  return false;
}

/** 聚合本次运行的所有 assistant 文本为最终结果：过滤过程铺垫，始终保留结论段 */
function buildOutput(texts: string[]): string {
  const clean = texts.map((t) => t.trim()).filter(Boolean);
  if (clean.length === 0) return '';
  const kept = clean.filter((t, i) => i === clean.length - 1 || isSubstantive(t));
  return kept.join('\n\n');
}

/** 对流式 create 包一层指数退避重试（复用统一退避；abort/上下文超长不重试，交由上层处理） */
async function createStreamWithRetry(
  client: OpenAI,
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
  options?: { signal?: AbortSignal },
) {
  return withLlmRetry(() => client.chat.completions.create(params, { signal: options?.signal }));
}

/** 渐进式披露指令（常量，附在 system 基座后保持前缀稳定）：告知模型用 search_tools 按需加载工具 */
const PROGRESSIVE_DISCLOSURE_DIRECTIVE = `

## 工具加载（渐进式披露）
- 当前你只看到少数核心工具与 search_tools，其余工具（选股/研报/热点/大盘/ETF/计划/自选/模拟盘下单/决策等）默认未加载。
- 需要某项能力却不在可见工具中时，先调用 search_tools 用关键词检索加载，命中的工具会进入后续可调用列表，然后再调用它们。
- 检索示例：选股「选股 筛选」、研报「券商研报 评级」、热点「全网热点 新闻」、大盘「大盘 指数 情绪」、ETF「ETF 信号」、下单「妙想模拟盘 下单 买卖」、计划「今日计划 复盘」、自选「自选股」、决策「多空辩论 操作建议」。
- 一次 search_tools 可加载多个相关工具；已加载的工具无需重复检索。`;

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { client, model } = getLLM();
  const useModel = opts.modelConfig.model || model;
  const maxSteps = opts.modelConfig.maxSteps ?? 12;
  const thinking = opts.modelConfig.thinking ?? false;
  const strategyId = opts.strategy?.id ?? null;
  // 战法是否启用 Skill 自迭代：决定是否注入打法 + 挂载 propose_skill_update
  const skillEnabled = strategyId ? getStrategy(strategyId)?.skillEnabled ?? false : false;
  // 渐进式披露：pool 为全量可用工具池；初始仅暴露核心工具 + search_tools，其余经检索后加入 discovered。
  const pool = getToolDefinitions(thinking, strategyId, skillEnabled);
  const coreNames = getCoreToolNames(); // 生效核心集（含用户工具页覆盖）
  const searchDef = buildSearchToolDef();
  const poolByName = new Map(pool.map((d) => [d.function.name, d]));
  const discovered = new Set<string>();
  /** 当前步对模型可见的工具：核心 ∪ 已检索发现 + search_tools 元工具 */
  const visibleTools = (): OpenAI.Chat.Completions.ChatCompletionTool[] => [
    ...pool.filter((d) => coreNames.has(d.function.name) || discovered.has(d.function.name)),
    searchDef,
  ];
  // 事件流统一进全局总线 /ws/runs（供全局运行抽屉实时轨迹），同时转发调用方专属 socket
  const emit = (e: StreamEvent) => {
    broadcast(e);
    opts.onEvent?.(e);
  };

  const strategyDirective = opts.strategy
    ? `\n\n## 战法模拟（已绑定）\n- 本次运行绑定战法【${opts.strategy.name}】。买卖请用 sim_trade 落该战法的本地模拟账户，先用 sim_positions 查当前持仓与可用资金。\n- 必须遵守：涨停不可买 / 跌停不可卖、数量为 100 股整数倍、T+1（当日买入不可当日卖）、资金/可卖持仓充足；这只是本系统内的模拟记账，绝不触发真实或妙想下单。`
    : '';

  // 战法 Skill 打法（已启用且有 active 内容时注入；含提案指令）
  const skillAddon = strategyId && skillEnabled ? getStrategyDirectiveAddon(strategyId) : '';

  // system 前缀保持稳定以命中 provider 前缀缓存：易变的实时时间锚点不再拼进 system，
  // 改为附在「当前用户轮」末尾（最新 turn 本就不可缓存），避免每次请求前缀都不同导致缓存全失效。
  const systemPrompt =
    (opts.systemPrompt || getPrompt(PROMPT_KEYS.systemBase)) +
    PROGRESSIVE_DISCLOSURE_DIRECTIVE +
    (thinking ? getPrompt(PROMPT_KEYS.thinkingDirective) : '') +
    strategyDirective +
    skillAddon;

  // 注入用户轮的实时上下文（与 system 解耦，保证 system 前缀稳定）
  const userContent = opts.prompt + buildTimeContext();

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...(opts.history ?? []),
    { role: 'user', content: userContent },
  ];
  // 落库仍记录原始 prompt（不含时间锚点），保持运行轨迹干净可复盘
  appendRunMessage({ runId: opts.runId, role: 'user', content: opts.prompt });

  const ctx: ToolContext = {
    runId: opts.runId,
    strategyId,
    skillEnabled,
    forceTrade: opts.forceTrade ?? false,
    signal: opts.signal,
  };
  let promptTokens = 0;
  let completionTokens = 0;
  const assistantTexts: string[] = [];
  let nudged = false;
  // 工具调用指纹计数（跨步累计），用于重复调用环路保护
  const toolCallCounts = new Map<string, number>();

  const deadline = Date.now() + opts.timeoutSec * 1000;

  // 上下文预算：先扣除为输出预留的 token（避免提示+输出之和超窗），再按 COMPACT_RATIO 触发压缩
  const contextWindow = opts.modelConfig.contextWindow ?? getContextWindow();
  const reservedOutput = opts.modelConfig.maxTokens ?? DEFAULT_RESERVED_OUTPUT;
  const usableWindow = Math.max(1024, contextWindow - reservedOutput);
  const compactThreshold = Math.floor(usableWindow * COMPACT_RATIO);
  const toolBudget = Math.floor(contextWindow * TOOL_BUDGET_RATIO);
  // token/char 标定系数：拿到真实 usage.prompt_tokens 后据上次请求字符数标定，修正 CJK 估算偏差
  let tokenPerChar = 0;
  const estimateContext = (msgs: ChatMessages): number => {
    const stat = estimateTokensStatic(msgs);
    const cal = tokenPerChar > 0 ? Math.ceil(rawChars(msgs) * tokenPerChar) : 0;
    return Math.max(stat, cal);
  };
  const compactCtx = {
    runId: opts.runId,
    purpose: opts.purpose || 'scheduled-task',
    taskName: opts.taskName ?? null,
    signal: opts.signal,
    // 压缩调用的 token 计入 run 成本汇总（不计入「上下文占用」展示）
    addCost: (p: number, c: number) => {
      promptTokens += p;
      completionTokens += c;
    },
  };
  const aborted = () => opts.signal?.aborted ?? false;
  const canceledResult = (): RunAgentResult => ({
    status: 'canceled',
    outputText: buildOutput(assistantTexts),
    promptTokens,
    completionTokens,
    error: '运行已中止',
  });
  const timedOutResult = (): RunAgentResult => ({
    status: 'timeout',
    outputText: buildOutput(assistantTexts),
    promptTokens,
    completionTokens,
    error: '运行超时',
  });

  for (let step = 0; step < maxSteps; step++) {
    if (aborted()) return canceledResult();
    if (Date.now() > deadline) return timedOutResult();

    // 最后一步只允许收尾：禁用工具，强制基于已有信息给最终结论，避免直接报错
    const isFinalStep = step === maxSteps - 1;

    const stepStart = Date.now();
    let stepModel = useModel;
    let stepPrompt = 0;
    let stepCompletion = 0;
    let didCompact = false;

    // 预防式压缩：估算（含工具裁剪后的）请求体，超阈值先压缩历史
    if (estimateContext(trimToolResults(messages, toolBudget)) > compactThreshold) {
      const compacted = await compactMessages(client, messages, compactCtx);
      if (compacted !== messages) {
        messages.length = 0;
        messages.push(...compacted);
        didCompact = true;
      }
    }
    if (aborted()) return canceledResult();

    // 采样：reactive 容错——上下文溢出则压缩/兜底裁剪后重试同一步
    let stream: Awaited<ReturnType<typeof createStreamWithRetry>>;
    let overflowRetry = 0;
    let sentRawChars = 0;
    for (;;) {
      if (aborted()) return canceledResult();
      const reqMessages = trimToolResults(messages, toolBudget);
      sentRawChars = rawChars(reqMessages);
      try {
        stream = await createStreamWithRetry(
          client,
          {
            model: useModel,
            messages: reqMessages,
            tools: isFinalStep ? undefined : visibleTools(),
            temperature: opts.modelConfig.temperature ?? 0.3,
            ...(opts.modelConfig.maxTokens ? { max_tokens: opts.modelConfig.maxTokens } : {}),
            ...(opts.cacheKey ? { prompt_cache_key: opts.cacheKey } : {}),
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal: opts.signal },
        );
        break;
      } catch (e) {
        // 中止：信号已 abort 或错误为 abort 类，统一收口为 canceled（不外抛、避免门面误判可重试）
        if (isAbortError(e) || aborted()) return canceledResult();
        if (isContextOverflow(e) && overflowRetry < MAX_COMPACT_RETRY) {
          overflowRetry += 1;
          const next =
            overflowRetry < MAX_COMPACT_RETRY
              ? await compactMessages(client, messages, compactCtx)
              : headTrim(messages);
          messages.length = 0;
          messages.push(...next);
          didCompact = true;
          continue;
        }
        recordLlmCall({
          purpose: opts.purpose || 'scheduled-task',
          model: useModel,
          latencyMs: Date.now() - stepStart,
          success: false,
          error: e instanceof Error ? e.message : String(e),
          runId: opts.runId,
          taskName: opts.taskName ?? null,
        });
        throw e;
      }
    }

    let content = '';
    // 本步结束原因（length=输出达上限被截断），用于对工具入参 JSON 截断给出可读提示
    let finishReason: string | null = null;
    const toolCallAcc = new Map<
      number,
      { id: string; name: string; args: string }
    >();

    try {
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (chunk.model) stepModel = chunk.model;
        if (chunk.usage) {
          stepPrompt = chunk.usage.prompt_tokens ?? stepPrompt;
          stepCompletion = chunk.usage.completion_tokens ?? stepCompletion;
        }
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        // 推理型模型的原生思考增量（deepseek: reasoning_content；部分网关: reasoning）。
        // 仅透传给前端展示，不并入 content/messages，避免污染上下文与最终输出。
        const reasoning =
          (delta as { reasoning_content?: string; reasoning?: string })?.reasoning_content ??
          (delta as { reasoning?: string })?.reasoning;
        if (reasoning) emit({ type: 'reasoning', text: reasoning });
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
    } catch (e) {
      if (isAbortError(e) || aborted()) return canceledResult();
      throw e;
    }

    // 本 step 一次 completion 调用计量入库（区分用途）
    recordLlmCall({
      purpose: opts.purpose || 'scheduled-task',
      model: stepModel,
      promptTokens: stepPrompt,
      completionTokens: stepCompletion,
      latencyMs: Date.now() - stepStart,
      success: true,
      runId: opts.runId,
      taskName: opts.taskName ?? null,
    });

    // 累计本步 token 到 run 汇总（含各步采样 + 压缩调用，使 run 总量与 llm_calls 明细一致）
    promptTokens += stepPrompt;
    completionTokens += stepCompletion;

    // 用真实 prompt_tokens 标定 token/char 系数，供后续步更准估算（尤其中文）
    if (stepPrompt > 0 && sentRawChars > 0) {
      const ratio = stepPrompt / sentRawChars;
      tokenPerChar = Math.min(1.5, Math.max(0.15, ratio));
    }

    // 上报本步上下文用量（真实 prompt_tokens 优先，缺失时回退估算）供前端展示 token 预算
    emit({
      type: 'context',
      usedTokens: stepPrompt || estimateContext(messages),
      contextWindow,
      compacted: didCompact,
    });

    const toolCalls = [...toolCallAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((v) => v.name);

    // 无工具调用：本轮为最终回答
    if (toolCalls.length === 0) {
      // 空回答兜底：既无工具调用又无文本，nudge 一次让其基于现有信息作答
      if (!content.trim() && !nudged && !isFinalStep) {
        nudged = true;
        messages.push({
          role: 'user',
          content: '请基于已获取的信息直接给出最终结论；若信息确实不足，请说明缺口与下一步建议。',
        });
        continue;
      }
      if (content) {
        assistantTexts.push(content);
        appendRunMessage({ runId: opts.runId, role: 'assistant', content });
        emit({ type: 'message', role: 'assistant', content });
      }
      return {
        status: 'success',
        outputText: buildOutput(assistantTexts),
        promptTokens,
        completionTokens,
      };
    }

    // 带工具调用的这一轮里若有正文（模型常把完整报告写在此处），一并纳入最终输出
    if (content.trim()) assistantTexts.push(content);

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

    // 执行单个工具：含环路保护（重复短路）、per-call 超时、abort 竞速。abort 时抛出交由上层收口。
    type ToolCall = { id: string; name: string; args: string };
    const execOne = async (call: ToolCall): Promise<{ call: ToolCall; result: string }> => {
      emit({ type: 'tool_call', id: call.id, name: call.name, args: call.args });
      const fp = toolFingerprint(call.name, call.args);
      const prior = toolCallCounts.get(fp) ?? 0;
      // 环路保护：同名同参已执行达上限，短路回提示而非真实再请求（省 token / 步数）
      if (prior >= MAX_SAME_TOOL_CALLS) {
        const notice = `[环路保护] 工具 ${call.name} 已用相同入参执行 ${prior} 次，结果见上文。请基于已有数据推进或更换查询条件，勿重复相同调用。`;
        emit({ type: 'tool_result', id: call.id, name: call.name, ok: true, preview: notice.slice(0, 300) });
        return { call, result: notice };
      }
      toolCallCounts.set(fp, prior + 1);
      let result: string;
      let ok = true;
      try {
        const parsed = call.args ? JSON.parse(call.args) : {};
        if (call.name === SEARCH_TOOLS_NAME) {
          // 渐进式披露元工具：在全量池内检索，命中工具并入 discovered，后续步骤即可直接调用
          const q = typeof parsed.query === 'string' ? parsed.query : '';
          const limit = typeof parsed.limit === 'number' ? parsed.limit : undefined;
          const m = matchToolDefs(q, pool, limit);
          for (const d of m.defs) discovered.add(d.function.name);
          result = m.text;
        } else {
          const tool = toolMap.get(call.name);
          if (!tool) throw new Error(`未知工具: ${call.name}`);
          // per-call 超时同时受整轮 deadline 约束：取二者较小，保证 timeoutSec 为硬边界
          const budgetMs = Math.max(1000, Math.min(TOOL_TIMEOUT_MS, deadline - Date.now()));
          result = await withToolGuard(tool.run(parsed, ctx), opts.signal, budgetMs);
          // 宽容：已成功执行的池内工具并入 discovered，避免其在后续步骤从可见列表消失
          if (poolByName.has(call.name)) discovered.add(call.name);
        }
      } catch (e) {
        if (isAbortError(e) || aborted()) throw e; // abort 上抛，由 gather 处统一收口 canceled
        ok = false;
        if (e instanceof SyntaxError) {
          // 入参不是合法 JSON：多因输出被长度截断导致入参残缺，给出明确收敛引导而非裸解析报错
          result =
            finishReason === 'length'
              ? `工具 ${call.name} 入参解析失败：输出被长度截断，入参 JSON 不完整。请精简各标的 thesis/confirmConditions/invalidConditions 等文字、分清主次，只调用一次 ${call.name} 落库。`
              : `工具 ${call.name} 入参不是合法 JSON（${e.message}）。请重新生成完整、合法的入参后重试。`;
        } else {
          result = isToolTimeout(e)
            ? `工具执行超时（>${TOOL_TIMEOUT_MS / 1000}s），已跳过本次调用。请改用更聚焦的查询或更换条件。`
            : `工具执行失败: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      emit({ type: 'tool_result', id: call.id, name: call.name, ok, preview: result.slice(0, 300) });
      return { call, result };
    };

    // 执行工具：无副作用工具可并发；含写/副作用工具时全部串行以保序、避免竞态
    if (aborted()) return canceledResult();
    const serial = toolCalls.length === 1 || toolCalls.some((c) => SERIAL_TOOLS.has(c.name));
    let outcomes: { call: ToolCall; result: string }[];
    try {
      if (serial) {
        outcomes = [];
        for (const call of toolCalls) {
          if (aborted()) return canceledResult();
          outcomes.push(await execOne(call));
        }
      } else {
        outcomes = await Promise.all(toolCalls.map(execOne));
      }
    } catch (e) {
      if (isAbortError(e) || aborted()) return canceledResult();
      throw e;
    }

    // 回填工具结果（保持与 assistant.tool_calls 同序，确保配对完整）
    for (const { call, result } of outcomes) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      appendRunMessage({
        runId: opts.runId,
        role: 'tool',
        content: result,
        toolName: call.name,
      });
    }

    // 工具批次后再判一次时限：让 timeoutSec 成为硬边界（步内长耗时不再越界）
    if (aborted()) return canceledResult();
    if (Date.now() > deadline) return timedOutResult();
  }

  return {
    status: 'error',
    outputText: buildOutput(assistantTexts),
    promptTokens,
    completionTokens,
    error: `超过最大步数 ${maxSteps}`,
  };
}
