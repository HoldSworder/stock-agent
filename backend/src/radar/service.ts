import type {
  IndustryStrength,
  MidCandidate,
  PositionTrend,
  RadarOverview,
  SectorItem,
  StrengthBreakdown,
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

/** 雷达每类（行业/概念）扫描板块数上限（控制 K 线请求量；行业+概念合计≈2×） */
const PER_KIND_LIMIT = 20;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** 取数失败 / 数据不足时的空指标（趋势落「震荡」基分，各项均为 null） */
const EMPTY_METRICS: EtfMetrics = {
  price: null, ma20: null, ma60: null, ma250: null, maDeviation: null,
  pricePercentile: null, ret20: null, ret60: null, ret120: null, momentum: null,
  absMomentumPositive: false, volatility: null, yearLow: null, yearHigh: null, barCount: 0,
};

/** computeMetrics 包一层降级：抛错时返回空指标，绝不让上层失败 */
async function safeMetrics(code: string, currentPrice: number | null = null): Promise<EtfMetrics> {
  try {
    return await computeMetrics(code, currentPrice);
  } catch {
    return EMPTY_METRICS;
  }
}

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

/** 综合强度 0-100：趋势基分 + 龙头动能 + 板块60日持续 + 年线偏离修正（同时产出可展示的评分构成）。
 * ret60Board 为板块级真实 60 日涨幅（东财 f24），是中线持续性的板块口径信号；其余项为龙头代理口径。 */
function scoreWithBreakdown(
  trend: TrendState,
  m: EtfMetrics,
  ret60Board: number | null = null,
): { score: number; breakdown: StrengthBreakdown } {
  const base = trend === 'multi_long' ? 72 : trend === 'up' ? 58 : trend === 'range' ? 44 : 24;
  const momPart = clamp((m.momentum ?? 0) * 0.5, -15, 18);
  const midPart = clamp((ret60Board ?? 0) * 0.15, -10, 15);
  const devPart = clamp((m.maDeviation ?? 0) * 0.2, -8, 8);
  const score = Math.round(clamp(base + momPart + midPart + devPart, 0, 100));
  const parts = [
    { label: `趋势基分·${TREND_LABEL[trend]}`, value: base },
    { label: '龙头动能', value: r2(momPart) },
    { label: '年线偏离修正', value: r2(devPart) },
  ];
  // 板块 60 日持续性仅在有板块级数据时计入（持仓趋势无此项）
  if (ret60Board != null) parts.splice(2, 0, { label: '板块60日持续', value: r2(midPart) });
  return { score, breakdown: { total: score, parts } };
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

/** 取数面板块数上限（控制龙头代理 K 线请求量；今日榜 + 中线榜合并去重后截断） */
const MAX_BOARDS = 48;

/** 中线动量排名融合键：龙头动能(20/60日) 0.6 + 板块60日(f24) 0.4，作为中线强弱的多日口径 */
function momentumKey(it: IndustryStrength): number {
  return 0.6 * (it.metrics.momentum ?? 0) + 0.4 * (it.ret60 ?? 0);
}

/** 行业强弱雷达：行业 + 概念「今日涨幅榜 + 60日中线强势榜」合并去重 → 逐板块算中线趋势指标
 * → 综合强度排序 + 动量排名。强度/排名用多日口径（龙头动能 + 板块60日持续），非当日涨幅，避免情绪偏置。 */
export async function computeIndustryRadar(perKind = PER_KIND_LIMIT): Promise<IndustryStrength[]> {
  // 今日榜（f3）+ 中线榜（60日 f24）两个口径并取，让多日强但今日平淡的板块也进入取数面
  const [todayInd, todayCon, midInd, midCon] = await Promise.all([
    getSectorRanking('industry', perKind, 'today').catch(() => []),
    getSectorRanking('concept', perKind, 'today').catch(() => []),
    getSectorRanking('industry', perKind, 'mid60').catch(() => []),
    getSectorRanking('concept', perKind, 'mid60').catch(() => []),
  ]);
  // 合并去重（今日榜优先入列，再补中线榜），按板块代码去重（概念可能与行业重名/重码）
  const seenCode = new Set<string>();
  const boards: Array<{ b: SectorItem; kind: 'industry' | 'concept' }> = [];
  const pushAll = (list: SectorItem[], kind: 'industry' | 'concept'): void => {
    for (const b of list) {
      if (!b.code || seenCode.has(b.code) || boards.length >= MAX_BOARDS) continue;
      seenCode.add(b.code);
      boards.push({ b, kind });
    }
  };
  pushAll(todayInd, 'industry');
  pushAll(todayCon, 'concept');
  pushAll(midInd, 'industry');
  pushAll(midCon, 'concept');
  if (!boards.length) return [];
  const items = await Promise.all(
    boards.map(async ({ b, kind }): Promise<IndustryStrength> => {
      let metrics = await safeMetrics(b.code);
      // 东财板块（90.BKxxxx）日 K 接口在部分网络下被重置取不到 → 回退用领涨/龙头个股 K 线代理板块中线趋势
      let proxied = false;
      if (metrics.barCount === 0 && /^\d{6}$/.test(b.leadStockCode)) {
        const lead = await safeMetrics(b.leadStockCode);
        if (lead.barCount > 0) {
          metrics = lead;
          proxied = true;
        }
      }
      const ret60 = b.ret60 ?? null;
      const trend = classifyTrend(metrics);
      const { score, breakdown } = scoreWithBreakdown(trend, metrics, ret60);
      const notes = trendNotes(trend, metrics);
      if (ret60 != null) notes.push(`板块60日 ${ret60 >= 0 ? '+' : ''}${ret60.toFixed(1)}%`);
      if (proxied) notes.push(`龙头代理(${b.leadStock || b.leadStockCode})`);
      return {
        code: b.code,
        name: b.name,
        boardKind: kind,
        pct: b.pct,
        leadStock: b.leadStock,
        leadStockCode: b.leadStockCode,
        trend,
        strengthScore: score,
        breakdown,
        momentumRank: null,
        ret60,
        metrics: toTrendMetrics(metrics),
        notes,
      };
    }),
  );
  // 动量排名：趋势非走弱且多日融合键为正者参与，按融合键（龙头动能 + 板块60日）降序
  const ranked = items
    .filter((it) => it.trend !== 'down' && momentumKey(it) > 0)
    .sort((a, b) => momentumKey(b) - momentumKey(a));
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
      const metrics = await safeMetrics(p.code, p.price ?? null);
      const trend = classifyTrend(metrics);
      const { score, breakdown } = scoreWithBreakdown(trend, metrics);
      const toMa60Pct =
        metrics.price != null && metrics.ma60 != null && metrics.ma60 > 0
          ? r2(((metrics.price - metrics.ma60) / metrics.ma60) * 100)
          : null;
      return {
        code: p.code,
        name: p.name,
        trend,
        strengthScore: score,
        breakdown,
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
      // 龙头强度沿用所属行业的评分构成
      breakdown: ind.breakdown,
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
      const etfMomPart = r2(clamp((s.momentum ?? 0) * 0.5, -15, 18));
      const etfScore = Math.round(clamp(55 + etfMomPart, 0, 100));
      out.push({
        code: s.code,
        name: s.name,
        kind: 'etf',
        reason: `ETF 趋势${s.action === 'add' ? '延续' : '右侧'}${s.momentumRank ? `（动量排名${s.momentumRank}）` : ''}`,
        strengthScore: etfScore,
        breakdown: {
          total: etfScore,
          parts: [
            { label: 'ETF 趋势基分', value: 55 },
            { label: '动量贡献', value: etfMomPart },
          ],
        },
      });
    }
  } catch {
    /* ETF 信号不可用：仅返回行业龙头候选 */
  }
  return out.sort((a, b) => b.strengthScore - a.strengthScore).slice(0, 12);
}

/** 组装中线雷达总览。
 * 注：前端 BoardStrengthPanel 仅渲染 `industries`，「持仓趋势」「中线候选池」分别与 /positions、/screener
 * 重叠且无任何消费方（agent 工具直接调 computeIndustryRadar；本模块无定时/TG）。故此处只算行业强弱，
 * positions/candidates 返回空数组以保持 DTO 形态；computePositionTrends/buildCandidates 保留在代码中可随时复接（G2 可逆）。
 * 收益：每次 /radar/overview 不再白拉真实持仓+逐只K线与 ETF 信号。 */
export async function buildRadarOverview(): Promise<RadarOverview> {
  const industries = await computeIndustryRadar().catch(() => [] as IndustryStrength[]);
  return {
    asOf: nowIso(),
    industries,
    positions: [],
    candidates: [],
    note: '中线趋势研判（确定性指标，仅供参考，不构成下单建议）',
  };
}
