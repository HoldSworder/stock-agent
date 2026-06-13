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
];

const DEF_MAP = new Map(DEFS.map((d) => [d.key, d]));

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
  return DEFS.map((d) => {
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
