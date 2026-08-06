import type { KlineBar, ProjectionCone } from '@stock-agent/shared';

// 走势推演的算术层（计划 S5）。
// 这里只做波动率锥：按历史日波动把未来 N 根的价格散布范围张开。
// 刻意不含任何方向判断——方向由计划的情景折线表达，两者在图上分开画，
// 混在一起会让「统计上的散布」看起来像「模型预测的路径」。

/** 估计 σ 用的回看根数。太短会被单日异动带偏，太长会把早就变了的波动率算进来 */
const LOOKBACK = 120;

/** 至少要这么多样本才给锥。样本不足时返回 null，不用短样本硬算一个看起来很精确的区间 */
const MIN_SAMPLE = 30;

/**
 * 日对数收益标准差（样本标准差，n−1）。
 * 用对数收益而非涨跌幅：价格是乘性过程，√N 外推只在对数空间才成立。
 */
export function dailyLogSigma(bars: KlineBar[]): { sigma: number; sample: number } | null {
  const closes = bars
    .map((b) => b.close)
    .filter((c) => Number.isFinite(c) && c > 0)
    .slice(-(LOOKBACK + 1));
  if (closes.length < MIN_SAMPLE + 1) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i += 1) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const sigma = Math.sqrt(variance);
  return Number.isFinite(sigma) && sigma > 0 ? { sigma, sample: rets.length } : null;
}

/**
 * 波动率锥：未来 steps 根的 ±1σ / ±2σ 上下轨。
 *
 * σ_N = σ_日 × √N 是随机游走假设下的标准结论；A 股有明显的波动聚集与涨跌停约束，
 * 所以这个锥是「量级参考」而不是「置信区间」——界面上必须照此措辞，
 * 不能写成「95% 概率落在这里」。
 *
 * ponytail: 只按 √N 外推，不做 GARCH 之类的波动率建模。天花板是波动率突变时
 * （比如刚出财报）锥会偏窄；要更准得引入条件异方差模型，那是另一个量级的工程。
 *
 * @returns 样本不足或基准价非法时返回 null，不猜
 */
export function buildCone(bars: KlineBar[], steps: number): ProjectionCone | null {
  const est = dailyLogSigma(bars);
  const last = bars[bars.length - 1];
  if (!est || !last || !(last.close > 0) || !(steps > 0)) return null;
  const base = last.close;
  const out: ProjectionCone['steps'] = [];
  for (let n = 1; n <= steps; n += 1) {
    const s = est.sigma * Math.sqrt(n);
    const r3 = (v: number): number => Math.round(v * 1000) / 1000;
    out.push({
      step: n,
      p1Low: r3(base * Math.exp(-s)),
      p1High: r3(base * Math.exp(s)),
      p2Low: r3(base * Math.exp(-2 * s)),
      p2High: r3(base * Math.exp(2 * s)),
    });
  }
  return {
    basePrice: Math.round(base * 1000) / 1000,
    sigmaDaily: Math.round(est.sigma * 1e6) / 1e6,
    sampleSize: est.sample,
    steps: out,
  };
}

/** 短期锥取一周（5 个交易日），中长期取一个月（20 个） */
export const CONE_STEPS: Record<'short' | 'long', number> = { short: 5, long: 20 };
