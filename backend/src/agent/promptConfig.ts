import { eq } from 'drizzle-orm';
import type { PromptConfigUpdate, PromptInfo } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { nowIso } from '../util';

// Agent 提示词覆盖配置：把硬编码的全局提示词抽出，做成「覆盖优先，回退默认」。
// 仿 toolConfig.ts 直接读写 settings 表的单行 JSON（key=prompt_overrides），不污染 settings.ts 的 KEYS 映射。
// 此处为这三段全局提示词的「单一来源」：loop.ts 通过 getPrompt 取生效值。

const OVERRIDES_KEY = 'prompt_overrides';

/** 提示词键常量（供 loop.ts 引用，避免硬编码字符串散落） */
export const PROMPT_KEYS = {
  systemBase: 'system_base',
  thinkingDirective: 'thinking_directive',
  compactSystem: 'compact_system',
  // 今日计划三段运行时提示词（由 plan/service 在模块加载时 registerPromptDef 注入，
  // 此处仅声明 key 常量供运行时 getPrompt 引用，prompt 正文仍是 plan 模块的单一来源）
  planGen: 'plan_generate',
  planReview: 'plan_review',
  planReeval: 'plan_reevaluate',
  // 板块作战台 AI 行动建议：统一行动结构输出契约（结论/理由/证据/失效条件/动作）
  boardAction: 'board_action_structure',
  // 标的专属会话（K 线弹窗 Agent 页签）注入的两段：常驻标的上下文 + 一键生成计划的标准指令
  symbolSession: 'symbol_session_context',
  symbolPlanGenerate: 'symbol_plan_generate',
} as const;

const BASE_SYSTEM_PROMPT = `你是一个 A 股投研与交易助手，运行在用户自建的选股平台中。
你可以调用妙想（东方财富）数据/选股/资讯/自选股/模拟盘工具获取真实行情并执行操作。

## 工作方法（务必遵循）
1. 先理解任务，必要时用一两句话列出本次的简要计划与待验证项。
2. 收集数据：充分使用工具获取真实行情/财务/资金/委托数据。相互独立的查询尽量合并到一次调用（mx_finance_data 支持一次查多只多指标），减少往返。
3. 交叉验证：对关键数字做一致性核对（如现价、涨跌停、资金），数据矛盾时再查证，不要据残缺/可疑数据下结论。
4. 给出结论或执行操作，并说明依据来源。

## 持续性
- 在拿到足够证据前不要停下；信息不足时必须继续调用工具，严禁猜测或编造行情、财务数字。
- 工具报错时，先判断是参数错误（如代码格式、数量非 100 整数倍）还是数据缺失：修正入参后重试，而不是直接放弃。
- 不要过早结束：只有当任务真正完成、或已用尽可行手段，才给最终回答。

## 交易安全
- 下单（mx_trade）前务必先核对 6 位代码、现价/涨跌停价与可用资金/持仓，确保 quantity 为 100 整数倍且不超买超卖。
- 真实持仓（real_positions）只读，绝不可据此下单。

## 输出规范
- 结论必须基于工具返回的真实数据，给出依据来源。
- 仅当用户明确要求推送时才调用 notify_telegram；定时任务结果由平台自动推送，无需自行调用。
- 推送到 Telegram（notify_telegram）时禁止使用 Markdown 表格，须用竖排清单；WebUI 内的回答可正常使用表格。尾盘选股类须包含现价。
- 回答精炼、条理清晰。`;

/** thinking 模式下追加的深思指令（配合 think 工具） */
const THINKING_DIRECTIVE = `

## 深思模式（已开启）
- 面对复杂决策（选股、仓位、卖点判断）时，先用 think 工具拆解问题、列出假设与待验证项。
- 每次拿到关键数据后，用 think 做一步反思校验（数据是否支持假设、是否有矛盾）再继续。
- 想清楚即停止 think，转而用数据工具求证或直接给结论，避免空转。`;

/** 板块作战台 AI 行动建议：统一「行动结构」输出契约，要求返回严格 JSON（无 JSON schema，靠约定 + 事后解析） */
const BOARD_ACTION_PROMPT = `你是 A 股板块主线研判助手。基于给定的板块确定性底稿（共识档 / 阶段 / 强度 / 龙头 / 补涨），
给出一条「行动结构」研判，只研判不下单。

严格只输出一个 JSON 对象（不要 Markdown、不要额外文字），字段如下：
{
  "conclusion": "一句话结论（该板块现在该做什么）",
  "reasons": ["理由1", "理由2"],
  "evidence": ["证据1（含数据点/来源）", "证据2"],
  "invalidators": ["失效条件1（触发则结论作废）", "失效条件2"],
  "action": "观察|试错|持有|加仓候选|减仓|回避|等待 之一"
}
要求：基于底稿事实，不编造数字；action 必须是给定七个标签之一；数组各 2-4 条，精炼。`;

/**
 * 标的专属会话前缀：K 线弹窗 Agent 页签的每轮提问都会前置这段，
 * 使模型无需追问即可锁定标的、并知道分析结论可以落到 K 线图与计划卡片上。
 * 占位符：{code} 标的代码、{name} 标的名称（无名称时为空串）。
 */
const SYMBOL_SESSION_PROMPT = `【当前跟踪标的】{code}{name}
（本会话所有分析默认针对该标的。
要给「下一交易日/后续一段时间该怎么做」这类完整判断时，走结构化计划流程：先用 search_tools 检索「标的计划 K线阶段 触发失效」加载计划工具，再依次调 get_symbol_technical_context → list_symbol_plan_candidates（levels 与 conditions）→ save_symbol_trade_plan；阶段、风险、仓位、主动作由后端算定，你只挑候选 ID 并写摘要，禁止自己写价格数字。
只是随手标一条线时，用 search_tools 检索「标注 打点」，再用 list_kline_marks 查重、add_kline_mark 打点）`;

/**
 * 一键生成标的交易计划的标准指令：由 Agent 页签的两个快捷按钮触发，
 * 把 horizon 钉死在用户点的那条车道上，并要求必须真正落库，否则计划卡片仍是空的。
 * 占位符：{horizon} 车道枚举值、{horizonLabel} 车道中文名。
 */
const SYMBOL_PLAN_GENERATE_PROMPT = `## 本轮任务：生成 horizon={horizon}（{horizonLabel}）的技术交易计划
- 本轮只处理 horizon={horizon} 这一条车道。get_symbol_technical_context 与 save_symbol_trade_plan 的 horizon 都必须传 {horizon}，禁止改成另一条车道，也禁止一轮里同时生成两条。
- 工具序列固定，不可跳步：get_symbol_technical_context（horizon={horizon}）→ list_symbol_plan_candidates（catalog=levels 与 catalog=conditions 各取一次）→ save_symbol_trade_plan。三次调用必须用同一个 contextId。
- 阶段、趋势、风险、仓位、主动作全部由后端算定，你不能修改，只能解释。价位与条件只能按 candidateId 从候选目录里挑，禁止自己写价格数字、禁止发明条件。
- 必须真正调用 save_symbol_trade_plan 才算完成本轮任务。只在对话里口述结论、没有落库的，视为未完成，要继续把提案提交上去；提案被拒就按返回的问题清单修正后重提。
- summary 用一两句话说清「现在该做什么、什么条件下改变动作」；相对上一版有变化时写进 changes。
- 收尾用一句话回报已保存的计划版本号与主动作，提示用户可切到「交易计划」页签核对。`;

/** 上下文压缩器（compactMessages）的 system 指令 */
const COMPACT_SYSTEM =
  '你是对话压缩器。把以下 A 股投研 agent 的较早对话与工具结果压成简洁的交接摘要，' +
  '务必保留：已确认的关键数据（代码/现价/涨跌停/资金/持仓/委托结果）、已做的结论与决策、' +
  '尚未完成的待办与下一步。丢弃寒暄与过程铺垫。用中文要点列表，不要编造未出现的数字。';

interface PromptDef {
  key: string;
  label: string;
  hint: string;
  base: string;
}

/** 全局提示词注册表（定义即可在中枢·提示词页可视化 + 覆盖） */
const DEFS: PromptDef[] = [
  {
    key: PROMPT_KEYS.systemBase,
    label: '基础系统提示词',
    hint: '所有 agent 运行的 system 前缀（人格 / 工作方法 / 交易安全 / 输出规范）。定时任务自带 prompt 时不替换此段。',
    base: BASE_SYSTEM_PROMPT,
  },
  {
    key: PROMPT_KEYS.thinkingDirective,
    label: '深思模式指令',
    hint: '开启 thinking 时追加到 system 末尾，引导配合 think 工具拆解与反思。',
    base: THINKING_DIRECTIVE,
  },
  {
    key: PROMPT_KEYS.compactSystem,
    label: '上下文压缩指令',
    hint: '上下文超阈值时，压缩器把较早历史压成交接摘要所用的 system 指令。',
    base: COMPACT_SYSTEM,
  },
  {
    key: PROMPT_KEYS.boardAction,
    label: '板块行动结构研判',
    hint: '板块作战台「AI 行动建议」的输出契约：要求返回结论/理由/证据/失效条件/动作的严格 JSON。',
    base: BOARD_ACTION_PROMPT,
  },
  {
    key: PROMPT_KEYS.symbolSession,
    label: '标的会话上下文',
    hint: 'K 线弹窗 Agent 页签每轮提问的前缀，锁定当前标的并指明打点与计划流程。占位符：{code} {name}。',
    base: SYMBOL_SESSION_PROMPT,
  },
  {
    key: PROMPT_KEYS.symbolPlanGenerate,
    label: '标的计划一键生成指令',
    hint: 'Agent 页签「生成下一交易日计划 / 1~4周波段计划」按钮注入的标准指令，钉死 horizon 并要求必须落库。占位符：{horizon} {horizonLabel}。',
    base: SYMBOL_PLAN_GENERATE_PROMPT,
  },
];

// 提示词定义注册表：内置三段全局提示词 + 各业务模块在加载时通过 registerPromptDef 注入（如今日计划三段）。
// 用 Map 保插入顺序，listPromptInfo 据此渲染中枢·提示词页。
const DEF_MAP = new Map<string, PromptDef>(DEFS.map((d) => [d.key, d]));

/**
 * 注册一段可覆盖提示词（业务模块在加载时调用，把自己的运行时 prompt 收编进统一提示词管理）。
 * 把 prompt 正文留在原业务模块（单一来源 + 兼容旧种子签名匹配），此处仅登记其默认值供可视化 + 覆盖。
 * 重复 key 以最后一次为准（幂等，热重载安全）。
 */
export function registerPromptDef(def: PromptDef): void {
  DEF_MAP.set(def.key, def);
}

/** 读取全部提示词覆盖配置（key -> content）；解析失败按空配置处理 */
export function getOverrides(): Record<string, string> {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, OVERRIDES_KEY))
    .get();
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** 取某段提示词的生效值（有覆盖用覆盖，否则回退代码默认；未知 key 回退空串） */
export function getPrompt(key: string): string {
  const override = getOverrides()[key];
  if (typeof override === 'string' && override.trim()) return override;
  return DEF_MAP.get(key)?.base ?? '';
}

/** 列出全部提示词的展示信息（默认值 / 当前覆盖 / 是否覆盖） */
export function listPromptInfo(): PromptInfo[] {
  const overrides = getOverrides();
  return [...DEF_MAP.values()].map((d) => {
    const ov = overrides[d.key];
    const overridden = typeof ov === 'string' && ov.trim().length > 0;
    return {
      key: d.key,
      label: d.label,
      hint: d.hint,
      baseContent: d.base,
      content: overridden ? ov : d.base,
      overridden,
    };
  });
}

/** 写入某段提示词覆盖；content 传空串=清除覆盖回落默认。返回该段最新信息（未知 key 返回 null） */
export function setPromptOverride(key: string, patch: PromptConfigUpdate): PromptInfo | null {
  if (!DEF_MAP.has(key)) return null;
  const map = getOverrides();
  if (patch.content != null) {
    const trimmed = patch.content.trim();
    if (trimmed) map[key] = trimmed;
    else delete map[key]; // 空串=清除覆盖
  }
  const value = JSON.stringify(map);
  const now = nowIso();
  db.insert(schema.settings)
    .values({ key: OVERRIDES_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: now } })
    .run();
  return listPromptInfo().find((p) => p.key === key) ?? null;
}
