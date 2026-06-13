import type {
  IndustryStrength,
  MidCandidate,
  PositionTrend,
  RadarOverview,
  TrendMetrics,
  TrendState,
} from '@stock-agent/shared';
import { computeMetrics, type EtfMetrics } from '../etf/data';
import { getSectorRanking } from '../market/eastmoney';
import { fetchRealPositions } from '../realPositions';
import { signals as etfSignals } from '../etf/service';
import { nowIso } from '../util';

// 中线主线雷达：纯确定性只读视图，复用 ETF 指标层（computeMetrics）对行业板块/持仓做趋势分级。
// 只接稳定数据（东财行业榜 + 日K + 真实持仓 + ETF 信号），不做短线情绪、不做双模式、不下单、不落库。
// 产出：行业强弱排序 + 持仓趋势状态 + 中线候选池，供 WebUI 与收盘后 Telegram 摘要。

/** 雷达扫描的行业板块上限（控制 K 线请求量） */
const INDUSTRY_LIMIT = 20;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** EtfMetrics（ETF 指标层）→ 通用 TrendMetrics 视图 */
function toTrendMetrics(m: EtfMetrics): TrendMetrics {
  return {
    price: m.price,
    ma20: m.ma20 != null ? r2(m.ma20) : null,
    ma60: m.ma60 != null ? r2(m.ma60) : null,
    ma250: m.ma250 != null ? r2(m.ma250) : null,
    maDeviation: m.maDeviation != null ? r2(m.maDeviation) : null,
    pricePercentile: m.pricePercentile != null ? Math.round(m.pricePercentile) : null,
    ret20: m.ret20 != null ? r2(m.ret20) : null,
    ret60: m.ret60 != null ? r2(m.ret60) : null,
    momentum: m.momentum != null ? r2(m.momentum) : null,
    volatility: m.volatility != null ? r2(m.volatility) : null,
  };
}

/** 趋势分级：多头排列 / 趋势向上 / 震荡 / 走弱（基于均线排列与 MA60 相对位置） */
export function classifyTrend(m: EtfMetrics): TrendState {
  const { price, ma20, ma60, ma250 } = m;
  if (price == null || ma60 == null) return 'range';
  if (ma20 != null && ma250 != null && price >= ma20 && ma20 >= ma60 && ma60 >= ma250) {
    return 'multi_long';
  }
  if (price > ma60 && (ma20 == null || ma20 >= ma60)) return 'up';
  if (price < ma60 * 0.97) return 'down';
  return 'range';
}

/** 综合强度 0-100：趋势基分 + 动量贡献 + 年线偏离修正 */
function strengthScore(trend: TrendState, m: EtfMetrics): number {
  const base = trend === 'multi_long' ? 72 : trend === 'up' ? 58 : trend === 'range' ? 44 : 24;
  const mom = m.momentum ?? 0;
  const dev = m.maDeviation ?? 0;
  return Math.round(clamp(base + clamp(mom * 0.5, -15, 18) + clamp(dev * 0.2, -8, 8), 0, 100));
}

const TREND_LABEL: Record<TrendState, string> = {
  multi_long: '多头排列',
  up: '趋势向上',
  range: '震荡',
  down: '走弱',
};

function trendNotes(trend: TrendState, m: EtfMetrics): string[] {
  const notes: string[] = [TREND_LABEL[trend]];
  if (m.momentum != null) notes.push(`动量 ${m.momentum >= 0 ? '+' : ''}${m.momentum.toFixed(1)}`);
  if (m.maDeviation != null) notes.push(`年线偏离 ${m.maDeviation >= 0 ? '+' : ''}${m.maDeviation.toFixed(1)}%`);
  if (m.pricePercentile != null) notes.push(`分位 ${m.pricePercentile.toFixed(0)}%`);
  return notes;
}

/** 行业强弱雷达：取行业涨幅榜 → 逐板块算趋势指标 → 综合强度排序 + 动量排名 */
export async function computeIndustryRadar(limit = INDUSTRY_LIMIT): Promise<IndustryStrength[]> {
  const boards = await getSectorRanking('industry', limit).catch(() => []);
  if (!boards.length) return [];
  const items = await Promise.all(
    boards.map(async (b): Promise<IndustryStrength> => {
      let metrics: EtfMetrics;
      try {
        metrics = await computeMetrics(b.code, null);
      } catch {
        metrics = {
          price: null, ma20: null, ma60: null, ma250: null, maDeviation: null,
          pricePercentile: null, ret20: null, ret60: null, momentum: null,
          absMomentumPositive: false, volatility: null, yearLow: null, yearHigh: null, barCount: 0,
        };
      }
      const trend = classifyTrend(metrics);
      return {
        code: b.code,
        name: b.name,
        pct: b.pct,
        leadStock: b.leadStock,
        leadStockCode: b.leadStockCode,
        trend,
        strengthScore: strengthScore(trend, metrics),
        momentumRank: null,
        metrics: toTrendMetrics(metrics),
        notes: trendNotes(trend, metrics),
      };
    }),
  );
  // 动量排名：仅对趋势向上/多头且动量为正者参与
  const ranked = items
    .filter((it) => (it.trend === 'multi_long' || it.trend === 'up') && (it.metrics.momentum ?? 0) > 0)
    .sort((a, b) => (b.metrics.momentum ?? 0) - (a.metrics.momentum ?? 0));
  ranked.forEach((it, i) => {
    it.momentumRank = i + 1;
  });
  // 综合强度倒序
  return items.sort((a, b) => b.strengthScore - a.strengthScore);
}

/** 持仓趋势跟随建议（确定性研判，不下单） */
function positionAdvice(trend: TrendState, holdRate: number | null): string {
  if (trend === 'multi_long' || trend === 'up') {
    return holdRate != null && holdRate < 0
      ? '趋势仍向上但当前浮亏，持有观察，回踩不破 MA20 可考虑补；破 MA60 离场'
      : '趋势良好，趋势跟随持有，回踩 MA20 不破可加仓';
  }
  if (trend === 'down') return '趋势走弱（跌破 MA60），中线视角应减仓/离场规避';
  return '趋势震荡，持有观望，等方向选择后再操作';
}

/** 持仓趋势状态：对每只真实持仓算趋势指标 + 跟随建议 */
export async function computePositionTrends(): Promise<PositionTrend[]> {
  let positions;
  try {
    positions = (await fetchRealPositions()).positions;
  } catch {
    return [];
  }
  return Promise.all(
    positions.map(async (p): Promise<PositionTrend> => {
      let metrics: EtfMetrics;
      try {
        metrics = await computeMetrics(p.code, p.price ?? null);
      } catch {
        metrics = {
          price: p.price ?? null, ma20: null, ma60: null, ma250: null, maDeviation: null,
          pricePercentile: null, ret20: null, ret60: null, momentum: null,
          absMomentumPositive: false, volatility: null, yearLow: null, yearHigh: null, barCount: 0,
        };
      }
      const trend = classifyTrend(metrics);
      const toMa60Pct =
        metrics.price != null && metrics.ma60 != null && metrics.ma60 > 0
          ? r2(((metrics.price - metrics.ma60) / metrics.ma60) * 100)
          : null;
      return {
        code: p.code,
        name: p.name,
        trend,
        strengthScore: strengthScore(trend, metrics),
        holdRate: p.holdRate != null ? r2(p.holdRate * 100) : null,
        positionRate: p.positionRate != null ? r2(p.positionRate * 100) : null,
        toMa60Pct,
        metrics: toTrendMetrics(metrics),
        advice: positionAdvice(trend, p.holdRate != null ? p.holdRate * 100 : null),
      };
    }),
  );
}

/** 中线候选池：强势行业龙头 + 强趋势 ETF，去重后按强度排序 */
async function buildCandidates(industries: IndustryStrength[]): Promise<MidCandidate[]> {
  const out: MidCandidate[] = [];
  const seen = new Set<string>();
  // 强势行业（多头/向上）龙头
  for (const ind of industries.filter((i) => i.trend === 'multi_long' || i.trend === 'up').slice(0, 6)) {
    const code = ind.leadStockCode;
    if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    out.push({
      code,
      name: ind.leadStock || code,
      kind: 'industry_leader',
      reason: `${ind.name}（${TREND_LABEL[ind.trend]}，强度${ind.strengthScore}）龙头`,
      fromIndustry: ind.name,
      strengthScore: ind.strengthScore,
    });
  }
  // 强趋势 ETF（信号 buy/add + 绝对动量为正）
  try {
    const sig = await etfSignals();
    for (const s of sig.signals
      .filter((x) => (x.action === 'buy' || x.action === 'add') && x.absMomentumPositive)
      .sort((a, b) => (a.momentumRank ?? 99) - (b.momentumRank ?? 99))
      .slice(0, 6)) {
      if (seen.has(s.code)) continue;
      seen.add(s.code);
      out.push({
        code: s.code,
        name: s.name,
        kind: 'etf',
        reason: `ETF 趋势${s.action === 'add' ? '延续' : '右侧'}${s.momentumRank ? `（动量排名${s.momentumRank}）` : ''}`,
        strengthScore: clamp(55 + (s.momentum ?? 0) * 0.5, 0, 100),
      });
    }
  } catch {
    /* ETF 信号不可用：仅返回行业龙头候选 */
  }
  return out.sort((a, b) => b.strengthScore - a.strengthScore).slice(0, 12);
}

/** 组装中线雷达总览（行业 + 持仓 + 候选池），各块 best-effort 降级 */
export async function buildRadarOverview(): Promise<RadarOverview> {
  const [industries, positions] = await Promise.all([
    computeIndustryRadar().catch(() => [] as IndustryStrength[]),
    computePositionTrends().catch(() => [] as PositionTrend[]),
  ]);
  const candidates = await buildCandidates(industries).catch(() => [] as MidCandidate[]);
  return {
    asOf: nowIso(),
    industries,
    positions,
    candidates,
    note: '中线趋势研判（确定性指标，仅供参考，不构成下单建议）',
  };
}

/** 收盘后 Telegram 摘要：强势行业 Top + 走弱持仓提示（确定性组装） */
export function buildRadarDigest(ov: RadarOverview): string {
  const lines: string[] = ['📡 中线雷达摘要'];
  const strong = ov.industries.filter((i) => i.trend === 'multi_long' || i.trend === 'up').slice(0, 5);
  if (strong.length) {
    lines.push(
      '强势行业：' +
        strong.map((i) => `${i.name}(${TREND_LABEL[i.trend]}·${i.strengthScore})`).join('、'),
    );
  }
  const weak = ov.positions.filter((p) => p.trend === 'down');
  if (weak.length) {
    lines.push('走弱持仓：' + weak.map((p) => `${p.name}(${p.code})`).join('、') + '（趋势破位，中线注意减仓）');
  }
  if (ov.candidates.length) {
    lines.push('中线候选：' + ov.candidates.slice(0, 5).map((c) => `${c.name}(${c.code})`).join('、'));
  }
  return lines.join('\n');
}
