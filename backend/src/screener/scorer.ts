import type { ScreenFactorKey, ScreenFactorScore } from '@stock-agent/shared';
import { getSectorByChange, getSectorMoneyFlow } from '../market/eastmoney';
import type { SnapshotRow } from './snapshot';
import type { ScreenStrategyDef, IdealPoint } from './strategy';
import { activeFactors } from './strategy';

// L2a 多因子打分（确定性、横截面）：
//  - 分位排名法：value / liquidity / size（在候选池内按指标分位归一 0-100）。
//  - 理想点曲线法：momentum / activity（距理想值越近分越高）。
//  - 题材热度：themeHeat（候选所属行业当日是否走强/资金净流入 + 题材关键词命中）。
// 仅用全市场快照横截面数据，不对 5000 只逐只取历史 K 线（稳定性/反转因子留作后续）。

/** 题材热度上下文：行业热度表 + 用户/agent 题材关键词 */
export interface ThemeContext {
  /** 行业名 → 热度分 0-100 */
  industryHeat: Map<string, number>;
  /** 题材关键词（命中候选行业/名称即加分） */
  keywords: string[];
}

/**
 * 构建题材热度上下文：行业涨幅榜 + 行业主力净流入榜，归一为行业热度表。
 * best-effort：取数失败则返回空表（themeHeat 全员中性 50），不阻断选股。
 */
export async function buildThemeContext(context: string): Promise<ThemeContext> {
  const industryHeat = new Map<string, number>();
  try {
    const [gainers, inflow] = await Promise.all([
      getSectorByChange('gainers', 50).catch(() => []),
      getSectorMoneyFlow('inflow', 50).catch(() => []),
    ]);
    // 涨幅榜：排名越靠前热度越高（线性 50→100）
    gainers.forEach((s, i) => {
      const heat = 100 - (i / Math.max(1, gainers.length)) * 50;
      industryHeat.set(s.name, Math.max(industryHeat.get(s.name) ?? 0, heat));
    });
    // 净流入榜：再叠加资金面加成（取较高者，避免线性叠加溢出）
    inflow.forEach((s, i) => {
      const heat = 90 - (i / Math.max(1, inflow.length)) * 40;
      industryHeat.set(s.name, Math.max(industryHeat.get(s.name) ?? 0, heat));
    });
  } catch {
    /* 行业榜取数失败：themeHeat 退化为中性 */
  }
  const keywords = context
    .split(/[\s,，、;；/|]+/)
    .map((k) => k.trim())
    .filter((k) => k.length >= 2);
  return { industryHeat, keywords };
}

/** 理想点曲线：score = 100 * exp(-((v-ideal)/tolerance)^2) */
function idealScore(v: number, p: IdealPoint): number {
  const z = (v - p.ideal) / (p.tolerance || 1);
  return 100 * Math.exp(-(z * z));
}

/** 在候选池内按某指标做分位排名（0-100）。direction='high' 越大越好，'low' 越小越好。 */
function percentileRanker(
  values: Array<number | null>,
  direction: 'high' | 'low',
): (v: number | null) => number {
  const valid = values.filter((x): x is number => x != null).sort((a, b) => a - b);
  const n = valid.length;
  return (v) => {
    if (v == null || n === 0) return 50; // 缺失 → 中性
    // 小于等于 v 的占比
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (valid[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    const pctile = (lo / n) * 100;
    return direction === 'high' ? pctile : 100 - pctile;
  };
}

/** 估值分位：PE 与 PB 均「越低越好」，亏损（PE<=0 / PB<=0）记最差 0 */
function buildValueScorer(rows: SnapshotRow[]): (r: SnapshotRow) => number {
  const peRanker = percentileRanker(
    rows.map((r) => (r.pe != null && r.pe > 0 ? r.pe : null)),
    'low',
  );
  const pbRanker = percentileRanker(
    rows.map((r) => (r.pb != null && r.pb > 0 ? r.pb : null)),
    'low',
  );
  return (r) => {
    const pe = r.pe != null && r.pe <= 0 ? 0 : peRanker(r.pe);
    const pb = r.pb != null && r.pb <= 0 ? 0 : pbRanker(r.pb);
    return (pe + pb) / 2;
  };
}

/** 单只候选的完整打分 */
export interface ScoredRow {
  row: SnapshotRow;
  screenScore: number;
  factors: ScreenFactorScore[];
}

/**
 * 对候选池打分（横截面），按策略权重加权出 screenScore（0-100）。
 * factors[].weight 为该因子对总分的贡献（score * 归一权重），其和等于 screenScore。
 */
/**
 * 候选 code → 趋势/资金因子分（0-100）的外部补充表（由 trend.ts 限量取 K 线/资金流后算得）。
 * 仅 trend / fundFlow 两个因子需要逐只历史数据，故经此参数注入；缺失则该因子记中性 50。
 */
export type ExtraFactorScores = Map<string, Partial<Record<ScreenFactorKey, number>>>;

export function scoreCandidates(
  rows: SnapshotRow[],
  def: ScreenStrategyDef,
  theme: ThemeContext,
  extraScores?: ExtraFactorScores,
): ScoredRow[] {
  const keys = activeFactors(def);
  const totalW = keys.reduce((s, k) => s + (def.factorWeights[k] ?? 0), 0) || 1;

  const valueScore = buildValueScorer(rows);
  const amountRanker = percentileRanker(rows.map((r) => r.amount), 'high');
  const turnoverLiqRanker = percentileRanker(rows.map((r) => r.turnoverRate), 'high');
  const sizeRanker = percentileRanker(rows.map((r) => r.marketCap), 'low'); // 偏好中小盘

  const factorScore = (key: ScreenFactorKey, r: SnapshotRow): number => {
    switch (key) {
      case 'value':
        return valueScore(r);
      case 'liquidity':
        return (amountRanker(r.amount) + turnoverLiqRanker(r.turnoverRate)) / 2;
      case 'size':
        return sizeRanker(r.marketCap);
      case 'momentum':
        return idealScore(r.pct, def.momentumIdeal);
      case 'activity': {
        const turn = r.turnoverRate != null ? idealScore(r.turnoverRate, def.activityIdeal) : 50;
        const vr =
          r.volumeRatio != null ? idealScore(r.volumeRatio, { ideal: 1.6, tolerance: 1.5 }) : null;
        return vr != null ? turn * 0.6 + vr * 0.4 : turn;
      }
      case 'themeHeat': {
        let base = r.industry ? theme.industryHeat.get(r.industry) ?? 50 : 50;
        if (theme.keywords.length) {
          const hit = theme.keywords.some(
            (k) => r.industry.includes(k) || r.name.includes(k),
          );
          if (hit) base = Math.min(100, base + 25);
        }
        return base;
      }
      case 'trend':
      case 'fundFlow': {
        // 趋势/资金流为逐只历史因子，由外部 extraScores 注入；缺失记中性 50
        const v = extraScores?.get(r.code)?.[key];
        return typeof v === 'number' ? v : 50;
      }
      default:
        return 50;
    }
  };

  return rows.map((r) => {
    const factors: ScreenFactorScore[] = keys.map((k) => {
      const score = Math.round(factorScore(k, r) * 10) / 10;
      const normW = (def.factorWeights[k] ?? 0) / totalW;
      return { key: k, score, weight: Math.round(score * normW * 10) / 10 };
    });
    const screenScore = Math.round(factors.reduce((s, f) => s + f.weight, 0) * 10) / 10;
    return { row: r, screenScore, factors };
  });
}
