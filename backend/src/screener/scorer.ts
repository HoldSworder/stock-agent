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
  /** 取不到数的因子。空数组 = 数据齐全 */
  missingFactors: ScreenFactorKey[];
  /** 缺失因子占策略总权重的比例（0-1）。用于判断这个分还能不能比 */
  missingWeight: number;
  /**
   * 这只能不能参与排名。缺失权重超过 MAX_MISSING_WEIGHT 就是 false。
   *
   * 分数照算照展示（使用者要能看到它为什么被排除），但不进 TopN——
   * 拿半份数据算出来的分和拿全份算出来的分不是同一把尺，混在一张榜上比就是错的。
   */
  rankable: boolean;
}

/**
 * 缺失权重上限：超过这个比例就不参与排名。
 *
 * 取 1/3 的理由：多数策略的主导因子权重在 0.4 左右（如中线龙头的 midTrend），
 * 容忍到 1/3 意味着「丢掉一个次要因子还能比，丢掉主导因子就不能比」。
 * 这是个判断值而非推导值——真要调，先看被剔掉的都是些什么标的。
 */
const MAX_MISSING_WEIGHT = 1 / 3;

/**
 * 对候选池打分（横截面），按策略权重加权出 screenScore（0-100）。
 * factors[].weight 为该因子对总分的贡献（score * 归一权重），其和等于 screenScore。
 */
/**
 * 候选 code → 趋势/资金因子分（0-100）的外部补充表（由 trend.ts 限量取 K 线/资金流后算得）。
 * 仅 trend / fundFlow 两个因子需要逐只历史数据，故经此参数注入；缺失则该因子记中性 50。
 */
export type ExtraFactorScores = Map<string, Partial<Record<ScreenFactorKey, number>>>;

/**
 * @param baselineRows 分位排名的基准行集（缺省即 rows 自身）。
 *   二段增强会对截断后的候选子集重打分，若仍拿子集当基准，分位口径与初筛那次不一致——
 *   原本全市场分位 95 的流动性会被压回 50 上下，screenScore 在两次调用间量纲漂移，
 *   最终落库的分数和用于截断的分数就不是同一把尺。传初筛行集可把基准固定住。
 */
export function scoreCandidates(
  rows: SnapshotRow[],
  def: ScreenStrategyDef,
  theme: ThemeContext,
  extraScores?: ExtraFactorScores,
  baselineRows?: SnapshotRow[],
): ScoredRow[] {
  const keys = activeFactors(def);
  const totalW = keys.reduce((s, k) => s + (def.factorWeights[k] ?? 0), 0) || 1;

  const base = baselineRows && baselineRows.length > 0 ? baselineRows : rows;
  const valueScore = buildValueScorer(base);
  const amountRanker = percentileRanker(base.map((r) => r.amount), 'high');
  const turnoverLiqRanker = percentileRanker(base.map((r) => r.turnoverRate), 'high');
  const sizeRanker = percentileRanker(base.map((r) => r.marketCap), 'low'); // 偏好中小盘

  // 返回 null = 这项数据取不到。**不许返回 50 冒充中性**：
  // 那会把取数不全的标的抬到「中等偏上」，排在真实弱势但数据齐全的标的之前。
  const factorScore = (key: ScreenFactorKey, r: SnapshotRow): number | null => {
    switch (key) {
      case 'value':
        return valueScore(r);
      case 'liquidity': {
        // 两项各自缺失时不能求平均：percentileRanker 对 null 返回 50，
        // 平均进去就等于用「中性分」补齐缺的那半，缺一半的标的会被抬到 50 以上。
        const amt = r.amount != null ? amountRanker(r.amount) : null;
        const turn = r.turnoverRate != null ? turnoverLiqRanker(r.turnoverRate) : null;
        if (amt != null && turn != null) return (amt + turn) / 2;
        return amt ?? turn;
      }
      case 'size':
        return r.marketCap == null ? null : sizeRanker(r.marketCap);
      case 'momentum':
        // 涨跌幅缺失时尤其危险：snapshot 的 num() 会把它变成 0%，
        // 而 dual_low 策略的动量理想值正是 0 → 缺失反而拿满分动量。
        return r.pct == null ? null : idealScore(r.pct, def.momentumIdeal);
      case 'activity': {
        if (r.turnoverRate == null && r.volumeRatio == null) return null;
        const turn = r.turnoverRate != null ? idealScore(r.turnoverRate, def.activityIdeal) : null;
        const vr =
          r.volumeRatio != null ? idealScore(r.volumeRatio, { ideal: 1.6, tolerance: 1.5 }) : null;
        if (turn != null && vr != null) return turn * 0.6 + vr * 0.4;
        return turn ?? vr;
      }
      case 'themeHeat': {
        // 没有所属行业就无从谈题材热度，这是真的缺数而不是「热度中等」
        if (!r.industry) return null;
        let base = theme.industryHeat.get(r.industry) ?? 50;
        if (theme.keywords.length) {
          const hit = theme.keywords.some(
            (k) => r.industry.includes(k) || r.name.includes(k),
          );
          if (hit) base = Math.min(100, base + 25);
        }
        return base;
      }
      case 'trend':
      case 'fundFlow':
      case 'midTrend':
      case 'dragonRank': {
        // 趋势/资金流/中线趋势/龙头分为逐只历史/涨停池因子，由外部 extraScores 注入。
        // 注入失败（取数超时、接口挂了）返回 null——这些往往是策略的主导因子，
        // 记中性会让「趋势因子权重 0.4 的中线策略」在完全没有趋势数据时照样出榜。
        const v = extraScores?.get(r.code)?.[key];
        return typeof v === 'number' ? v : null;
      }
      default:
        return null;
    }
  };

  return rows.map((r) => {
    const raw = keys.map((k) => ({
      key: k,
      score: factorScore(k, r),
      w: (def.factorWeights[k] ?? 0) / totalW,
    }));

    // 权重只在取到数的因子之间归一。缺失的不按中性摊进去，也不白占权重：
    // 前者抬高数据不全的标的，后者等于按 0 分惩罚一次取数故障。
    const availW = raw.reduce((s, f) => s + (f.score != null ? f.w : 0), 0);
    const missing = raw.filter((f) => f.score == null);
    const missingWeight = Math.round((1 - availW) * 1000) / 1000;

    const factors: ScreenFactorScore[] = raw.map((f) => {
      if (f.score == null) return { key: f.key, score: null, weight: null };
      const score = Math.round(f.score * 10) / 10;
      const w = availW > 0 ? f.w / availW : 0;
      return { key: f.key, score, weight: Math.round(score * w * 10) / 10 };
    });
    const screenScore =
      Math.round(factors.reduce((s, f) => s + (f.weight ?? 0), 0) * 10) / 10;

    return {
      row: r,
      screenScore,
      factors,
      missingFactors: missing.map((f) => f.key),
      missingWeight,
      // 涨跌幅单独一票否决，与权重无关：它出现在榜单每一行、参与风险标签，
      // 且落库那一列不允许空值。取不到就不该进榜，而不是填个 0 冒充平盘。
      rankable: r.pct != null && missingWeight <= MAX_MISSING_WEIGHT,
    };
  });
}

export { MAX_MISSING_WEIGHT as __test__MAX_MISSING_WEIGHT };
