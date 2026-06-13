import { eq } from 'drizzle-orm';
import type {
  DecisionAgentGroup,
  DecisionAgentInfo,
  DecisionAgentTier,
  DecisionAgentUpdate,
  DecisionEngineConfig,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { getMeta, getValue, setMeta } from '../settings';
import { nowIso } from '../util';

// 决策引擎多 agent 治理：把硬编码在 service.ts 的角色「职责指令」抽出做成「覆盖优先，回退默认」，
// 并把 7 个分析师做成可启停、把散落的 decision_* 全局参数收口为结构化读写。
// 仿 toolConfig.ts / promptConfig.ts，直接读写 settings 表单行 JSON（key=decision_agent_overrides），
// 不污染 settings.ts 的 KEYS 映射。此处是各角色职责指令与启停状态的「单一来源」，service.ts 经 getInstruction / getEnabledAnalystKeys 取生效值。

const OVERRIDES_KEY = 'decision_agent_overrides';

/** 决策角色定义（职责指令为可覆盖部分，运行时数据 / 输出契约仍在 service.ts 固定拼接） */
interface AgentDef {
  key: string;
  label: string;
  group: DecisionAgentGroup;
  tier: DecisionAgentTier;
  /** 引用的预取数据块（仅分析师有，展示用） */
  dataKeys: string[];
  /** 是否可启停（仅分析师） */
  toggleable: boolean;
  /** 默认职责指令 */
  baseInstruction: string;
}

/** 分析师 key 常量（与 service.ts 的 ANALYST_ROLES 顺序一一对应） */
export const ANALYST_KEYS = [
  'analyst.fundamental',
  'analyst.technical',
  'analyst.capital',
  'analyst.news',
  'analyst.policy',
  'analyst.sentiment',
  'analyst.lockup',
] as const;

/** 其余角色 key 常量（供 service.ts 引用，避免字符串散落） */
export const AGENT_KEYS = {
  bull: 'bull',
  bear: 'bear',
  judge: 'judge',
  trader: 'trader',
  riskAggressive: 'risk.aggressive',
  riskNeutral: 'risk.neutral',
  riskConservative: 'risk.conservative',
  riskChair: 'risk.chair',
  pm: 'pm',
} as const;

/**
 * 角色注册表（定义即在中枢·智能体页可视化 + 覆盖职责）。
 * baseInstruction 为「职责人设」语义片段，不含 ${name}/${code} 等运行时占位——
 * 标的、数据块、输出 JSON 契约由 service.ts 在指令之后固定拼接，覆盖不影响输出契约。
 */
const DEFS: AgentDef[] = [
  // —— 分析师层（7 角色并行，轻模型，可启停）——
  {
    key: 'analyst.fundamental',
    label: '基本面分析师',
    group: '分析师',
    tier: 'quick',
    dataKeys: ['statements', 'valuation', 'quote', 'research'],
    toggleable: true,
    baseInstruction:
      '财报盈利质量与成长性（营收/净利同比、毛利率、ROE、经营现金流）、估值水平（PE/PB 与行业对比）、研报一致预期与目标价，判断当前价位是否高估/低估',
  },
  {
    key: 'analyst.technical',
    label: '技术面分析师',
    group: '分析师',
    tier: 'quick',
    dataKeys: ['kline', 'series', 'relStrength', 'intraday', 'quote'],
    toggleable: true,
    baseInstruction:
      '价格所处位置（高位/中位/低位）、趋势方向、量价配合、关键支撑/压力位与买卖结构',
  },
  {
    key: 'analyst.capital',
    label: '游资情绪分析师',
    group: '分析师',
    tier: 'quick',
    dataKeys: ['dragon', 'hotspot', 'fundFlow', 'series', 'sector', 'intraday', 'quote', 'news'],
    toggleable: true,
    baseInstruction:
      '龙虎榜席位与净买入动向、主力/游资资金净流入流出、换手率与量比、题材情绪周期与拥挤度，判断是吸筹还是出货',
  },
  {
    key: 'analyst.news',
    label: '新闻分析师',
    group: '分析师',
    tier: 'quick',
    dataKeys: ['news', 'research'],
    toggleable: true,
    baseInstruction:
      '近期公司公告、业绩/重大事项、机构观点的利好利空与催化剂，判断新闻面对短期走势的影响',
  },
  {
    key: 'analyst.policy',
    label: '政策分析师',
    group: '分析师',
    tier: 'quick',
    dataKeys: ['policy', 'market', 'marketSeries', 'stance'],
    toggleable: true,
    baseInstruction:
      '所属行业最新政策、监管动向、窗口指导与产业扶持/限制，判断政策面是顺风还是逆风（政策市核心）',
  },
  {
    key: 'analyst.sentiment',
    label: '舆情分析师',
    group: '分析师',
    tier: 'quick',
    dataKeys: ['hotspot', 'news', 'market'],
    toggleable: true,
    baseInstruction:
      '散户与市场讨论热度、关注度变化、情绪是亢奋还是恐慌，判断舆情是助涨还是潜在反向指标',
  },
  {
    key: 'analyst.lockup',
    label: '解禁监控师',
    group: '分析师',
    tier: 'quick',
    dataKeys: ['lockup', 'quote'],
    toggleable: true,
    baseInstruction:
      '限售解禁时点与规模、大股东增减持计划、股权质押比例，判断是否存在 A 股特有的供给冲击/抛压风险',
  },

  // —— 多空辩论层 ——
  {
    key: AGENT_KEYS.bull,
    label: '多头研究员',
    group: '辩论',
    tier: 'quick',
    dataKeys: [],
    toggleable: false,
    baseInstruction:
      '你是【多头研究员】，论证为何应买入/持有该标的。基于下方各分析师结论，给出最有力的看多理由，并针对看空可能的质疑做反驳。精炼（≤220 字），分点。',
  },
  {
    key: AGENT_KEYS.bear,
    label: '空头研究员',
    group: '辩论',
    tier: 'quick',
    dataKeys: [],
    toggleable: false,
    baseInstruction:
      '你是【空头研究员】，论证为何应卖出/规避该标的。基于下方各分析师结论与多头观点，给出最有力的看空理由，并针对多头逻辑做反驳。精炼（≤220 字），分点。',
  },
  {
    key: AGENT_KEYS.judge,
    label: '研究总监',
    group: '辩论',
    tier: 'deep',
    dataKeys: [],
    toggleable: false,
    baseInstruction:
      '你是【研究总监】，需在多空辩论后做出裁决。基于下方多空双方观点与分析师结论，判断该标的当前更偏多还是偏空、核心矛盾是什么，给出明确的方向倾向与理由（≤200 字）。',
  },

  // —— 交易层 ——
  {
    key: AGENT_KEYS.trader,
    label: '交易员 Trader',
    group: '交易',
    tier: 'quick',
    dataKeys: [],
    toggleable: false,
    baseInstruction: '你是【交易员 Trader】，需把研究总监的研判转成 A 股可执行方案。',
  },

  // —— 风控博弈层 ——
  {
    key: AGENT_KEYS.riskAggressive,
    label: '激进派风控',
    group: '风控',
    tier: 'quick',
    dataKeys: [],
    toggleable: false,
    baseInstruction: '倾向把握机会、容忍更高波动，主张更积极的仓位',
  },
  {
    key: AGENT_KEYS.riskNeutral,
    label: '中立派风控',
    group: '风控',
    tier: 'quick',
    dataKeys: [],
    toggleable: false,
    baseInstruction: '在收益与风险间求平衡，主张适中仓位与纪律',
  },
  {
    key: AGENT_KEYS.riskConservative,
    label: '保守派风控',
    group: '风控',
    tier: 'quick',
    dataKeys: [],
    toggleable: false,
    baseInstruction: '风险厌恶、优先保本，主张谨慎仓位与严格止损',
  },
  {
    key: AGENT_KEYS.riskChair,
    label: '风控组长',
    group: '风控',
    tier: 'quick',
    dataKeys: [],
    toggleable: false,
    baseInstruction:
      '你是【风控组长】，需在激进/中立/保守三方风控辩论后裁决出最终可接受的仓位上限与止损纪律（≤160 字）。',
  },

  // —— 最终决策层 ——
  {
    key: AGENT_KEYS.pm,
    label: '组合经理',
    group: '决策',
    tier: 'deep',
    dataKeys: [],
    toggleable: false,
    baseInstruction: '你是【组合经理】，需基于全部研判给出对该标的的最终可执行操作。',
  },
];

const DEF_MAP = new Map(DEFS.map((d) => [d.key, d]));

interface AgentOverride {
  /** 覆盖职责指令（缺省/空串=用代码默认） */
  instruction?: string;
  /** 是否启用（仅分析师生效；缺省视为 true） */
  enabled?: boolean;
}

type OverrideMap = Record<string, AgentOverride>;

/** 读取全部角色覆盖配置；解析失败按空配置处理 */
function getOverrides(): OverrideMap {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, OVERRIDES_KEY))
    .get();
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as OverrideMap) : {};
  } catch {
    return {};
  }
}

function writeOverrides(map: OverrideMap): void {
  const value = JSON.stringify(map);
  const now = nowIso();
  db.insert(schema.settings)
    .values({ key: OVERRIDES_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: now } })
    .run();
}

/** 取某角色的生效职责指令（覆盖优先，回退代码默认；未知 key 回退空串） */
export function getInstruction(key: string): string {
  const ov = getOverrides()[key]?.instruction;
  if (typeof ov === 'string' && ov.trim()) return ov;
  return DEF_MAP.get(key)?.baseInstruction ?? '';
}

/** 某分析师是否启用（缺省 true；非分析师恒 true） */
function isEnabled(key: string, overrides: OverrideMap): boolean {
  const def = DEF_MAP.get(key);
  if (!def?.toggleable) return true;
  return overrides[key]?.enabled ?? true;
}

/**
 * 取当前启用的分析师 key 列表（保持注册表顺序）。
 * 兜底：若全部被禁用则回退全部启用，避免分析师层空跑导致辩论失依据。
 */
export function getEnabledAnalystKeys(): string[] {
  const overrides = getOverrides();
  const enabled = ANALYST_KEYS.filter((k) => isEnabled(k, overrides));
  return enabled.length ? [...enabled] : [...ANALYST_KEYS];
}

/** 列出全部角色展示信息（默认/生效职责、是否覆盖、启停态） */
export function listAgentInfo(): DecisionAgentInfo[] {
  const overrides = getOverrides();
  return DEFS.map((d) => {
    const ov = overrides[d.key]?.instruction;
    const overridden = typeof ov === 'string' && ov.trim().length > 0;
    return {
      key: d.key,
      label: d.label,
      group: d.group,
      tier: d.tier,
      dataKeys: d.dataKeys,
      toggleable: d.toggleable,
      enabled: isEnabled(d.key, overrides),
      baseInstruction: d.baseInstruction,
      instruction: overridden ? (ov as string) : d.baseInstruction,
      overridden,
    };
  });
}

/** 写入某角色覆盖；instruction 空串=清除覆盖；enabled 仅对分析师生效。返回该角色最新信息（未知 key 返回 null） */
export function setAgentOverride(key: string, patch: DecisionAgentUpdate): DecisionAgentInfo | null {
  const def = DEF_MAP.get(key);
  if (!def) return null;
  const map = getOverrides();
  const cur: AgentOverride = map[key] ?? {};
  const next: AgentOverride = { ...cur };

  if (patch.instruction != null) {
    const trimmed = patch.instruction.trim();
    if (trimmed) next.instruction = trimmed;
    else delete next.instruction; // 空串=清除覆盖
  }
  if (patch.enabled != null && def.toggleable) {
    if (patch.enabled) delete next.enabled; // 启用为默认态，不留垃圾键
    else next.enabled = false;
  }

  // 全默认（无指令覆盖且启用）则不留垃圾键
  if (next.instruction == null && next.enabled == null) delete map[key];
  else map[key] = next;

  writeOverrides(map);
  return listAgentInfo().find((a) => a.key === key) ?? null;
}

// ===== 全局参数（收口散落的 decision_* 元数据）=====

const META_KEYS = {
  rounds: 'decision_debate_rounds',
  riskRounds: 'decision_risk_rounds',
  riskEnabled: 'decision_risk_enabled',
  quickModel: 'decision_quick_model',
  deepModel: 'decision_deep_model',
  targetedFetch: 'decision_targeted_fetch',
} as const;

function clampRound(raw: string | undefined, fallback = 1): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3) : fallback;
}

/** 读取决策引擎全局参数（模型为空表示运行时回退，service.ts 自行回退） */
export function getEngineConfig(): DecisionEngineConfig {
  const riskRaw = getMeta(META_KEYS.riskEnabled);
  const targetedRaw = getMeta(META_KEYS.targetedFetch);
  return {
    rounds: clampRound(getMeta(META_KEYS.rounds)),
    riskRounds: clampRound(getMeta(META_KEYS.riskRounds)),
    riskEnabled: riskRaw ? riskRaw === 'true' : true,
    quickModel: getMeta(META_KEYS.quickModel) ?? '',
    deepModel: getMeta(META_KEYS.deepModel) ?? '',
    targetedFetch: targetedRaw ? targetedRaw !== 'false' : true,
  };
}

/** 解析运行期生效模型（service.ts 用）：quick 空回退 llmLightModel→llmModel；deep 空回退 llmModel */
export function resolveModels(): { quickModel: string; deepModel: string } {
  const cfg = getEngineConfig();
  return {
    quickModel: cfg.quickModel || getValue('llmLightModel') || getValue('llmModel'),
    deepModel: cfg.deepModel || getValue('llmModel'),
  };
}

/** 写入决策引擎全局参数（部分更新）。返回最新配置 */
export function setEngineConfig(patch: Partial<DecisionEngineConfig>): DecisionEngineConfig {
  if (patch.rounds != null) setMeta(META_KEYS.rounds, String(clampRound(String(patch.rounds))));
  if (patch.riskRounds != null) {
    setMeta(META_KEYS.riskRounds, String(clampRound(String(patch.riskRounds))));
  }
  if (patch.riskEnabled != null) setMeta(META_KEYS.riskEnabled, patch.riskEnabled ? 'true' : 'false');
  if (patch.quickModel != null) setMeta(META_KEYS.quickModel, patch.quickModel.trim());
  if (patch.deepModel != null) setMeta(META_KEYS.deepModel, patch.deepModel.trim());
  if (patch.targetedFetch != null) {
    setMeta(META_KEYS.targetedFetch, patch.targetedFetch ? 'true' : 'false');
  }
  return getEngineConfig();
}
