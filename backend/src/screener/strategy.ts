import type { ScreenStrategy, ScreenFactorKey } from '@stock-agent/shared';

// 内置选股策略（TS 常量，类型安全、随代码分发，无需 YAML 依赖与运行时文件加载）。
// 每个策略 = 硬筛条件（L1）+ 因子权重（L2a）+ 理想点参数（动量/活跃度曲线）。
// 偏短线题材打法（契合用户尾盘套利/题材风口），dual_low 提供价值味中线兜底。

/** 硬筛阈值（null 表示该维度不约束） */
export interface HardFilter {
  /** 市盈率（动）下/上限；剔除亏损时把 peMin 设 >0 */
  peMin?: number | null;
  peMax?: number | null;
  pbMin?: number | null;
  pbMax?: number | null;
  /** 成交额下限（亿元，流动性门槛） */
  amountMinYi?: number | null;
  /** 换手率区间 % */
  turnoverMin?: number | null;
  turnoverMax?: number | null;
  /** 当日涨跌幅区间 %（上限剔除追涨涨停，下限剔除暴跌） */
  pctMin?: number | null;
  pctMax?: number | null;
  /** 总市值区间（亿元） */
  marketCapMinYi?: number | null;
  marketCapMaxYi?: number | null;
}

/** 理想点曲线参数：距 ideal 越近分越高，tolerance 控制衰减宽度 */
export interface IdealPoint {
  ideal: number;
  tolerance: number;
}

/** 后端内部策略定义（前端只消费其 ScreenStrategy 子集） */
export interface ScreenStrategyDef extends ScreenStrategy {
  hardFilters: HardFilter;
  /** 动量因子理想点（基于当日涨跌幅 %） */
  momentumIdeal: IdealPoint;
  /** 活跃度因子理想点（基于换手率 %） */
  activityIdeal: IdealPoint;
}

const STRATEGIES: ScreenStrategyDef[] = [
  {
    id: 'theme_momentum',
    name: '题材动量',
    description:
      '短线题材打法：抓处于温和上涨、量能活跃且所属板块当日走强的标的，回避一字追涨与暴跌。',
    factorWeights: { momentum: 0.3, themeHeat: 0.3, activity: 0.2, liquidity: 0.2 },
    hardFilters: {
      amountMinYi: 2,
      turnoverMin: 3,
      turnoverMax: 30,
      pctMin: -3,
      pctMax: 9,
      marketCapMinYi: 30,
      marketCapMaxYi: 800,
    },
    momentumIdeal: { ideal: 4, tolerance: 5 },
    activityIdeal: { ideal: 10, tolerance: 8 },
  },
  {
    id: 'volume_breakout',
    name: '放量突破',
    description:
      '量价突破打法：偏好放量、换手充分、当日红盘的中盘活跃股，捕捉资金介入初期。',
    factorWeights: { activity: 0.35, momentum: 0.25, liquidity: 0.25, themeHeat: 0.15 },
    hardFilters: {
      amountMinYi: 3,
      turnoverMin: 5,
      turnoverMax: 35,
      pctMin: 0,
      pctMax: 9,
      marketCapMinYi: 40,
      marketCapMaxYi: 1000,
    },
    momentumIdeal: { ideal: 5, tolerance: 5 },
    activityIdeal: { ideal: 14, tolerance: 10 },
  },
  {
    id: 'balanced_alpha',
    name: '均衡阿尔法',
    description:
      '估值、流动性、市值、动量、活跃度、题材热度均衡加权，适合不追极端风格的稳健候选池。',
    factorWeights: {
      value: 0.2,
      liquidity: 0.2,
      size: 0.15,
      momentum: 0.2,
      activity: 0.15,
      themeHeat: 0.1,
    },
    hardFilters: {
      peMin: 0,
      peMax: 80,
      pbMin: 0,
      pbMax: 10,
      amountMinYi: 1,
      turnoverMax: 40,
      pctMin: -7,
      pctMax: 9,
    },
    momentumIdeal: { ideal: 2, tolerance: 6 },
    activityIdeal: { ideal: 6, tolerance: 8 },
  },
  {
    id: 'dual_low',
    name: '双低价值',
    description:
      '低估值（低 PE+低 PB）+ 适度流动性的中线兜底，偏好被低估、走势平稳的标的。',
    factorWeights: { value: 0.5, liquidity: 0.2, size: 0.2, momentum: 0.1 },
    hardFilters: {
      peMin: 0,
      peMax: 30,
      pbMin: 0,
      pbMax: 3,
      amountMinYi: 0.5,
      pctMin: -5,
      pctMax: 5,
    },
    momentumIdeal: { ideal: 0, tolerance: 6 },
    activityIdeal: { ideal: 4, tolerance: 6 },
  },
];

const BY_ID = new Map(STRATEGIES.map((s) => [s.id, s]));

/** 默认策略 id（设置未配置时回退） */
export const DEFAULT_STRATEGY_ID = 'theme_momentum';

/** 全部内置策略的后端定义 */
export function listStrategyDefs(): ScreenStrategyDef[] {
  return STRATEGIES;
}

/** 前端/agent 用的策略清单（仅暴露 id/name/description/factorWeights） */
export function listStrategies(): ScreenStrategy[] {
  return STRATEGIES.map(({ id, name, description, factorWeights }) => ({
    id,
    name,
    description,
    factorWeights,
  }));
}

/** 按 id 取策略定义；未知 id 回退默认策略 */
export function getStrategyDef(id: string | null | undefined): ScreenStrategyDef {
  return (id && BY_ID.get(id)) || BY_ID.get(DEFAULT_STRATEGY_ID)!;
}

/** 是否为已知内置策略 id（保存默认值时校验，避免存入无效 id） */
export function hasStrategy(id: string): boolean {
  return BY_ID.has(id);
}

/** 该策略实际参与打分的因子键（权重 > 0） */
export function activeFactors(def: ScreenStrategyDef): ScreenFactorKey[] {
  return (Object.keys(def.factorWeights) as ScreenFactorKey[]).filter(
    (k) => (def.factorWeights[k] ?? 0) > 0,
  );
}
