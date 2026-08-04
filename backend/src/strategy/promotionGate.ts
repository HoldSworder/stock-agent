import type { PromotionCheck, PromotionGateResult } from '@stock-agent/shared';

// 前向晋级门：判断一个策略的前向样本是否够格「上真实仓位」。
// 只看累计收益曲线是不够的，这里补三件事：
//   1. 小样本胜率看 Wilson 95% 置信下界，而不是点估计（30 笔 60% 胜率的下界只有约 42%）；
//   2. 同一天同一板块的批量交易不是独立样本，按「日期×板块」聚类后取有效簇数；
//   3. 从 N 个变体里挑最优会系统性高估，按多重检验提高胜率门槛。
// 永不自动晋级：本模块只出体检结论，开不开自动模拟仍由人决定。

/** 最少完整交易笔数 */
export const MIN_TRADES = 30;
/** 最少有效簇数（日期×板块聚类后） */
export const MIN_CLUSTERS = 30;
/** 基础胜率下界要求 % */
const BASE_WIN_LOWER_PCT = 50;
/** 95% 双侧正态分位 */
const Z95 = 1.96;

/**
 * Wilson 得分区间下界（比率的小样本置信下界）。
 * 用正态近似 wins/n ± z·se 在小样本下会给出越界甚至负值的荒谬区间，Wilson 不会。
 */
export function wilsonLowerBound(wins: number, n: number, z = Z95): number | null {
  if (n <= 0) return null;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (center - margin) / denom);
}

/**
 * 多重检验惩罚：从 N 个变体里挑最好的一个，其表现的期望值本身就高于单个变体。
 * 这里用「N 个独立标准正态的最大值期望 ≈ sqrt(2·lnN)」把这份虚高折算成额外的胜率要求。
 *
 * ponytail: 这是 Deflated Sharpe Ratio 的简化版——真正的 DSR 还要用变体间收益的方差与偏度，
 * 而我们的研究包并没有统一记录每个变体的完整收益序列。上限是「只惩罚数量、不惩罚相关性」，
 * 变体之间高度相关时会惩罚过重（偏保守，可接受）。升级路径：让研究脚本回传各变体的收益序列。
 */
export function multipleTestingPenaltyPct(variantCount: number): number {
  if (variantCount <= 1) return 0;
  // 每 1 个标准差折 10 个百分点的胜率要求，封顶 15 个百分点，避免变体一多门槛就high到不可能通过
  return Math.min(15, Math.round(Math.sqrt(2 * Math.log(variantCount)) * 10 * 10) / 10);
}

/** 一笔已平仓交易（喂给晋级门的最小信息） */
export interface GateTrade {
  /** 入场日 YYYY-MM-DD（聚类键的一半） */
  entryDate: string;
  /** 板块/行业标识（聚类键的另一半；未知传 null，此时退化为按日期聚类） */
  sector: string | null;
  /** 费后净收益（正数为盈利） */
  netPnl: number;
}

/**
 * 「日期×板块」聚类的有效簇数（Herfindahl 口径）。
 * 同一天在同一板块买 5 只，本质是同一个判断的 5 次表达，横截面高度相关，不能当 5 个独立样本。
 * 有效簇数 = 1 / Σ(每簇占比²)：均匀分布时等于簇数，全挤在一簇时等于 1。
 */
export function effectiveClusterCount(trades: GateTrade[]): number {
  if (trades.length === 0) return 0;
  const sizes = new Map<string, number>();
  for (const t of trades) {
    const key = `${t.entryDate}|${t.sector ?? ''}`;
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  const total = trades.length;
  let hh = 0;
  for (const n of sizes.values()) hh += (n / total) ** 2;
  return hh > 0 ? Math.round(1 / hh) : 0;
}

/** 簇等权胜率：先在簇内算胜率，再对簇取等权平均——避免大簇主导整体胜率 */
function clusterEqualWeightWinRate(trades: GateTrade[]): { rate: number | null; clusters: number } {
  if (trades.length === 0) return { rate: null, clusters: 0 };
  const buckets = new Map<string, { wins: number; n: number }>();
  for (const t of trades) {
    const key = `${t.entryDate}|${t.sector ?? ''}`;
    const b = buckets.get(key) ?? { wins: 0, n: 0 };
    b.n += 1;
    if (t.netPnl > 0) b.wins += 1;
    buckets.set(key, b);
  }
  const rates = [...buckets.values()].map((b) => b.wins / b.n);
  const rate = rates.reduce((s, v) => s + v, 0) / rates.length;
  return { rate, clusters: rates.length };
}

const pct = (v: number | null): string => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const money = (v: number | null): string => (v == null ? '—' : v.toFixed(0));

/**
 * 计算晋级门体检结果。
 * @param variantCount 该策略是从多少个变体里挑出来的（0/1 = 未做变体搜索，不惩罚）
 */
export function evaluatePromotionGate(trades: GateTrade[], variantCount = 0): PromotionGateResult {
  const n = trades.length;
  const wins = trades.filter((t) => t.netPnl > 0).length;
  const winRate = n > 0 ? wins / n : null;
  const wilson = wilsonLowerBound(wins, n);

  const { rate: clusterRate, clusters: rawClusters } = clusterEqualWeightWinRate(trades);
  const effClusters = effectiveClusterCount(trades);
  // 簇等权胜率的 95% 下界（簇数即样本量）。同样用 Wilson：正态近似在 rate 为 1 或 0 时方差为 0，
  // 下界会等于点估计（「10 个簇全赢 → 下界 100%」），与本模块选用 Wilson 的初衷正相反。
  const clusterLower =
    clusterRate != null && rawClusters > 0
      ? wilsonLowerBound(clusterRate * rawClusters, rawClusters)
      : null;

  const totalNetPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const avgNetPnl = n > 0 ? totalNetPnl / n : null;

  const penalty = multipleTestingPenaltyPct(variantCount);
  const requiredWinLowerPct = BASE_WIN_LOWER_PCT + penalty;

  const checks: PromotionCheck[] = [
    {
      key: 'trades',
      label: '完整交易笔数',
      actual: String(n),
      required: `≥ ${MIN_TRADES}`,
      passed: n >= MIN_TRADES,
      note: '样本太少时任何胜率都不可信，先攒够笔数再谈显著性。',
    },
    {
      key: 'wilson',
      label: 'Wilson 95% 胜率下界',
      actual: pct(wilson),
      required: `> ${requiredWinLowerPct.toFixed(1)}%`,
      passed: wilson != null && wilson * 100 > requiredWinLowerPct,
      note:
        '点胜率是运气与实力的混合，置信下界才是「最差也有这么好」的保证。' +
        (penalty > 0 ? `本策略申报 ${variantCount} 个变体，多重检验惩罚 +${penalty} 个百分点。` : ''),
    },
    {
      key: 'clusters',
      label: '日期×板块有效簇数',
      actual: String(effClusters),
      required: `≥ ${MIN_CLUSTERS}`,
      passed: effClusters >= MIN_CLUSTERS,
      note: '同日同板块批量下单只是同一个判断的多次表达，不能充当多个独立样本。',
    },
    {
      key: 'clusterWin',
      label: '簇等权胜率 95% 下界',
      actual: pct(clusterLower),
      required: `> ${BASE_WIN_LOWER_PCT}%`,
      passed: clusterLower != null && clusterLower * 100 > BASE_WIN_LOWER_PCT,
      note: '先在簇内算胜率再对簇等权，避免某几个交易特别密集的日子主导整体成绩。',
    },
    {
      key: 'netPnl',
      label: '费后收益',
      actual: `平均 ${money(avgNetPnl)} / 累计 ${money(totalNetPnl)}`,
      required: '均 > 0',
      passed: avgNetPnl != null && avgNetPnl > 0 && totalNetPnl > 0,
      note: '高胜率也可能是「赚小钱亏大钱」，必须同时看费后的平均与累计。',
    },
  ];

  return {
    passed: checks.every((c) => c.passed),
    trades: n,
    winRate: winRate == null ? null : Math.round(winRate * 1000) / 10,
    wilsonLowerPct: wilson == null ? null : Math.round(wilson * 1000) / 10,
    effectiveClusters: effClusters,
    clusterWinRatePct: clusterRate == null ? null : Math.round(clusterRate * 1000) / 10,
    clusterWinLowerPct: clusterLower == null ? null : Math.round(clusterLower * 1000) / 10,
    avgNetPnl: avgNetPnl == null ? null : Math.round(avgNetPnl * 100) / 100,
    totalNetPnl: Math.round(totalNetPnl * 100) / 100,
    variantCount,
    requiredWinLowerPct,
    checks,
    note:
      '晋级门只做体检，永不自动晋级：即便全部通过，是否开启自动模拟 / 上真实仓位仍由人决定。' +
      '任何因参数敏感性分析产生的规则改动，都必须换协议号并重新累积前向样本。',
  };
}
