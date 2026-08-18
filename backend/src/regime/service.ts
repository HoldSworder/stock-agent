import type {
  KlineBar,
  MaStructure,
  MarketRegimeBias,
  MarketRegimeDimension,
  MarketRegimeDivergence,
  MarketRegimeEqualWeight,
  MarketRegimeFrequency,
  MarketRegimeIndexItem,
  MarketRegimeOverview,
  MarketRegimePhase,
  ScorePart,
  StrengthBreakdown,
} from '@stock-agent/shared';
import { nowIso, shanghaiToday } from '../util';
import { countConsecutivePhase, getLatestSnapshot, getPrevSnapshot, upsertSnapshot } from './repo';

// 大盘阶段研判（确定性、规则化、零量化知识）：
// 用「多个主要指数的均线/趋势结构 + 全A等权失真校正 + 市场宽度 + 情绪周期 + 量能」六维度打分，
// 合成 0-100 强度分并按规则判定四档阶段（主升/反弹/退潮/震荡），给出明日倾向 + 建议交易频率 + 仓位区间。
// 关键设计（采纳专业交易者交叉意见）：
//   1) 反弹 vs 主升的区分靠「多指数共振 + 回撤是否守住关键均线 + 等权/全A是否同步走强」，而非单指数当日涨幅；
//   2) 判定依据全用 MA20/60/120 + 20 日趋势 + 多指数，天然多日平滑，单日大阳不会翻 MA60 结构；
//   3) 全A等权(880008) 校正市值加权大指数被权重股护盘的失真：权重红等权绿=护盘失真（判反弹/退潮），同步走强=真普涨（判主升）。
// 纯只读、不下单、不调 LLM。所有维度贡献可审计（breakdown），缺失维度按可用权重重归一，整体不阻断。

const clamp = (v: number, lo = 0, hi = 100): number => Math.min(Math.max(v, lo), hi);
const r1 = (n: number): number => Math.round(n * 10) / 10;

/** 参与判定的权重指数（覆盖权重蓝筹 + 中小盘 + 成长，避免只看上证失真） */
const REGIME_INDICES: ReadonlyArray<{ code: string; secid: string; name: string }> = [
  { code: '000001', secid: '1.000001', name: '上证指数' },
  { code: '000300', secid: '1.000300', name: '沪深300' },
  { code: '000905', secid: '1.000905', name: '中证500' },
  { code: '399006', secid: '0.399006', name: '创业板指' },
];

/** 权重失真校正的基准权重指数（与等权对照算背离）：沪深300 */
const WEIGHTED_BENCHMARK = '沪深300';

// ===== 纯函数指标（可独立自检）=====

/** 简单移动平均（末 n 根收盘），不足返回 null */
function sma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  const slice = closes.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

/** MA 是否走平转上：当前 MA(n) > look 根之前的 MA(n) */
function maSlopeUp(closes: number[], n: number, look = 5): boolean {
  if (closes.length < n + look) return false;
  const now = sma(closes, n);
  const past = sma(closes.slice(0, closes.length - look), n);
  return now != null && past != null && now > past;
}

/** 近 n 日涨跌幅 %（last / n 根前 close - 1） */
function pctChange(closes: number[], n: number): number {
  if (closes.length < n + 1) return 0;
  const last = closes[closes.length - 1];
  const base = closes[closes.length - 1 - n];
  return base > 0 ? ((last - base) / base) * 100 : 0;
}

/** 近 n 日上涨日占比（收盘高于前收），衡量路径质量 */
function upDayRatio(closes: number[], n: number): number {
  if (closes.length < 2) return 0.5;
  const win = closes.slice(-(n + 1));
  let up = 0;
  let cnt = 0;
  for (let i = 1; i < win.length; i++) {
    cnt += 1;
    if (win[i] > win[i - 1]) up += 1;
  }
  return cnt > 0 ? up / cnt : 0.5;
}

/** 均线排列：MA5>MA10>MA20>MA60 严格递减=多头，严格递增=空头，否则纠缠 */
function maAlignment(closes: number[]): MaStructure['alignment'] {
  const periods = [5, 10, 20, 60];
  const vals = periods.map((p) => sma(closes, p)).filter((v): v is number => v != null);
  if (vals.length < 2) return '纠缠';
  let desc = true;
  let asc = true;
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] >= vals[i - 1]) desc = false;
    if (vals[i] <= vals[i - 1]) asc = false;
  }
  return desc ? '多头排列' : asc ? '空头排列' : '纠缠';
}

/** 最近 vol 相对近 20 日均量的比值（放量>1 缩量<1），数据不足返回 1 */
function volRatio(bars: KlineBar[], n = 20): number {
  if (bars.length < n + 1) return 1;
  const vols = bars.map((b) => b.volume);
  const last = vols[vols.length - 1];
  const avg = vols.slice(-(n + 1), -1).reduce((a, b) => a + b, 0) / n;
  return avg > 0 ? last / avg : 1;
}

/** 从日线 bars 提炼单指数结构读数 */
function readIndex(name: string, secid: string, bars: KlineBar[]): MarketRegimeIndexItem | null {
  if (bars.length < 21) return null;
  const closes = bars.map((b) => b.close);
  const close = closes[closes.length - 1];
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  return {
    name,
    secid,
    close: Math.round(close * 100) / 100,
    alignment: maAlignment(closes),
    aboveMa20: ma20 != null && close >= ma20,
    aboveMa60: ma60 != null && close >= ma60,
    ma20SlopeUp: maSlopeUp(closes, 20),
    trendPct20: r1(pctChange(closes, 20)),
  };
}

// ===== 维度打分（每项 0-100）=====

interface DimScore {
  label: string;
  value: number | null;
  weight: number;
}

/** D1 趋势结构：各指数站上 MA20/60/120 的加权得分，跨指数平均 */
function scoreTrend(items: MarketRegimeIndexItem[], allCloses: number[][]): number | null {
  if (items.length === 0) return null;
  const per = items.map((it, i) => {
    const closes = allCloses[i];
    const ma120 = sma(closes, 120);
    const close = closes[closes.length - 1];
    const aboveMa120 = ma120 != null && close >= ma120;
    return (it.aboveMa20 ? 40 : 0) + (it.aboveMa60 ? 40 : 0) + (aboveMa120 ? 20 : 0);
  });
  return per.reduce((a, b) => a + b, 0) / per.length;
}

/** D2 趋势持续性 + 回撤承接：多指数共振（站上MA60）+ MA20走平转上 + 上涨日占比 */
function scorePersistence(items: MarketRegimeIndexItem[], allCloses: number[][]): number | null {
  if (items.length === 0) return null;
  const consAboveMa60 = items.filter((i) => i.aboveMa60).length / items.length;
  const consSlopeUp = items.filter((i) => i.ma20SlopeUp).length / items.length;
  const upRatioAvg =
    allCloses.reduce((a, c) => a + upDayRatio(c, 20), 0) / allCloses.length;
  return clamp(100 * (0.4 * consAboveMa60 + 0.3 * consSlopeUp + 0.3 * upRatioAvg));
}

/**
 * D3 等权失真校正：全A等权是否同步走强（站上MA60 + 趋势向上 + 上涨占比高）。
 * source='breadth' 是「当日上涨家数占比」代理，与「站上 60 日均线」口径完全不同，
 * 只配拿去当宽度用（见 scoreBreadth），不能冒充等权趋势，故本维度直接判缺失。
 */
function scoreEqualWeight(eqw: MarketRegimeEqualWeight | null, distortion: boolean): number | null {
  if (!eqw || eqw.source === 'breadth') return null;
  const trendScore = clamp(50 + eqw.trendPct20 * 3); // ±16% 趋势 → 0/100 附近
  // upRatio 缺失时按可用权重重归一，而不是拿 trendScore 顶上——那会让同一个 trendPct20
  // 在这一维里占到 0.6 权重，趋势被重复计权，也与本文件 synthesize 的既定做法相悖
  const parts: Array<{ v: number; w: number }> = [
    { v: eqw.aboveMa60 ? 100 : 0, w: 0.4 },
    { v: trendScore, w: 0.3 },
  ];
  if (eqw.upRatio != null) parts.push({ v: eqw.upRatio, w: 0.3 });
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  let s = parts.reduce((a, p) => a + p.v * p.w, 0) / wsum;
  if (distortion) s = Math.min(s, 45); // 权重护盘、等权走弱：封顶压到反弹区
  return clamp(s);
}

/** D4 市场宽度：等权上涨占比优先，回退情绪广度 */
function scoreBreadth(eqw: MarketRegimeEqualWeight | null, sentimentBreadth: number | null): number | null {
  if (eqw?.upRatio != null) return clamp(eqw.upRatio);
  return sentimentBreadth != null ? clamp(sentimentBreadth) : null;
}

/** D6 量能：放量在多头结构中偏正面（此处只给量能水位，方向由趋势维度承担） */
function scoreVolume(vr: number): number {
  // 缩量(<0.8)偏防守、温和放量(1~1.5)最健康、极端放量(>2)可能是高潮/恐慌 → 钟形
  if (vr <= 0.6) return 30;
  if (vr <= 0.9) return 50;
  if (vr <= 1.5) return 75;
  if (vr <= 2.2) return 60;
  return 45;
}

/** 按可用权重重归一合成 0-100，返回分数 + 可审计贡献拆解 */
function synthesize(dims: DimScore[]): { score: number; breakdown: StrengthBreakdown } {
  const avail = dims.filter((d) => d.value != null);
  const totalWeight = avail.reduce((s, d) => s + d.weight, 0);
  if (totalWeight === 0) {
    return { score: 50, breakdown: { total: 50, parts: [{ label: '数据缺失·默认中性', value: 50 }] } };
  }
  const parts: ScorePart[] = dims.map((d) => ({
    label: d.value != null ? d.label : `${d.label}（缺）`,
    value: d.value != null ? r1((d.value * d.weight) / totalWeight) : 0,
  }));
  const score = Math.round(avail.reduce((s, d) => s + (d.value as number) * d.weight, 0) / totalWeight);
  return { score, breakdown: { total: score, parts } };
}

// ===== 阶段判定（规则优先级，非单纯看分）=====

interface Aggregates {
  consAboveMa60: number;
  consBull: number;
  majorAboveMa20: number;
  consBelowMa20: number;
  /** 全A等权是否站上 MA60；null = 口径缺失（只有上涨家数占比代理，不可当等权趋势用） */
  eqwAboveMa60: boolean | null;
  eqwTrendUp: boolean | null;
  distortion: boolean;
  sentimentIndex: number | null;
  sentimentPhase: string | null;
  volShrink: boolean;
}

/** 四档阶段判定：主升 → 退潮 → 反弹 → 震荡（优先级顺序） */
function classifyPhase(a: Aggregates): MarketRegimePhase {
  const sentWeak = a.sentimentPhase === '退潮' || a.sentimentPhase === '冰点';
  const sentOk = a.sentimentIndex == null || a.sentimentIndex >= 45;
  // 主升：多指数中期共振向上 + 全A等权同步走强 + 无护盘失真 + 情绪不弱
  // 等权口径缺失（null）时两侧都不算数：主升不给放行，退潮也不拿缺失当「等权走弱」的证据
  if (
    a.consAboveMa60 >= 0.6 &&
    a.consBull >= 0.5 &&
    a.eqwAboveMa60 === true &&
    a.eqwTrendUp === true &&
    !a.distortion &&
    sentOk
  ) {
    return '主升';
  }
  // 退潮：多指数跌破短均线 / 情绪退潮冰点 / 中期普遍走弱且等权也弱
  if (a.consBelowMa20 >= 0.6 || sentWeak || (a.consAboveMa60 <= 0.25 && a.eqwAboveMa60 === false)) {
    return '退潮';
  }
  // 反弹：站上短均线但中期未确认，或权重护盘（等权走弱）拉起的结构性反抽
  if (a.majorAboveMa20 >= 0.5 && (a.consAboveMa60 < 0.6 || a.distortion)) {
    return '反弹';
  }
  return '震荡';
}

const PHASE_META: Record<
  MarketRegimePhase,
  { frequency: MarketRegimeFrequency; positionRange: string; advice: string }
> = {
  主升: {
    frequency: '积极',
    positionRange: '60-90%',
    advice: '主升行情：多指数与全A等权共振向上，可重仓进攻主线龙头，正常/积极出手，回撤不破关键均线前持有让利润奔跑。',
  },
  反弹: {
    frequency: '正常',
    positionRange: '30-60%',
    advice: '反弹行情：中期趋势未确认或权重护盘失真，控制仓位、快进快出，只打最强主线，站稳 MA60、等权同步走强再加码。',
  },
  退潮: {
    frequency: '降低',
    positionRange: '≤30%',
    advice: '退潮期：多数个股走弱、情绪退潮，降低交易频率、以防守为主，止盈兑现，避免逆势加仓，等下一轮启动信号。',
  },
  震荡: {
    frequency: '观望',
    positionRange: '≤30%',
    advice: '震荡观望：方向不明、多空纠缠，控制仓位精选主线龙头，不追高不恐慌，等待方向明朗再出手。',
  },
};

/** 明日/近期倾向：由阶段 + 等权确认 + 分数动量决定（只给方向，不预测点位） */
function decideBias(phase: MarketRegimePhase, a: Aggregates, delta: number | null): MarketRegimeBias {
  if (phase === '主升') return '偏强';
  if (phase === '退潮') return '偏弱';
  if (phase === '反弹') {
    return a.eqwTrendUp && !a.distortion && (delta == null || delta >= 0) ? '偏强' : '中性';
  }
  // 震荡：按分数动量轻微倾斜
  if (delta != null && delta >= 3) return '偏强';
  if (delta != null && delta <= -3) return '偏弱';
  return '中性';
}

// ===== 展示丰富化（确定性文案，供完整面板逐维解读 / 展望 / 驱动 / 风险）=====

const pctInt = (frac: number): string => `${Math.round(frac * 100)}%`;

/** 量比档位白话 */
function volLabel(vr: number): string {
  if (vr <= 0.6) return '明显缩量';
  if (vr <= 0.9) return '缩量';
  if (vr <= 1.5) return '温和放量';
  if (vr <= 2.2) return '放量';
  return '异常放量';
}

/**
 * 该 eqw 是否真·全A等权口径。
 * source='breadth' 是「上涨家数占比」代理，它的 aboveMa60 真实含义只是「今天上涨家数过半」、
 * trendPct20 硬编码为 0，不能拿去断言「站上/失守 MA60」或「20日 +0%」——分数已判 null 的维度，
 * 文字结论也不许照旧断言。
 */
function isEqwUsable(eqw: MarketRegimeEqualWeight | null | undefined): boolean {
  return !!eqw && eqw.source !== 'breadth';
}

/** 代理口径下统一的文字口径说明（读数与证据共用） */
const EQW_PROXY_TEXT = '等权口径缺失（仅有上涨家数占比代理），未做失真校正';

interface DimContext {
  items: MarketRegimeIndexItem[];
  closesList: number[][];
  eqw: MarketRegimeEqualWeight | null;
  sentimentIndex: number | null;
  sentimentPhase: string | null;
  vr: number;
  distortion: boolean;
}

/** 六维度明细（原始分 + 白话解读 + 关键证据），contribution 由 breakdown 回填 */
function buildDimensions(
  ctx: DimContext,
  raw: Record<string, number | null>,
  breakdown: StrengthBreakdown,
): MarketRegimeDimension[] {
  const { items, closesList, eqw } = ctx;
  const n = items.length || 1;
  const cntAboveMa60 = items.filter((i) => i.aboveMa60).length;
  const cntAboveMa20 = items.filter((i) => i.aboveMa20).length;
  const cntBull = items.filter((i) => i.alignment === '多头排列').length;
  const cntSlopeUp = items.filter((i) => i.ma20SlopeUp).length;
  const upRatioAvg = closesList.length
    ? closesList.reduce((a, c) => a + upDayRatio(c, 20), 0) / closesList.length
    : 0.5;

  const defs: Array<{ key: string; label: string; weight: number; reading: string; evidence: string }> = [
    {
      key: 'trend',
      label: '趋势结构(均线)',
      weight: 25,
      reading:
        cntAboveMa60 >= n * 0.6
          ? '多数指数站上中长期均线，中期偏多'
          : cntAboveMa60 <= n * 0.25
            ? '多数指数失守中长期均线，中期偏空'
            : '指数分化、多空参半',
      evidence: `站上MA60 ${cntAboveMa60}/${n}·站上MA20 ${cntAboveMa20}/${n}·多头排列 ${cntBull}/${n}`,
    },
    {
      key: 'persistence',
      label: '趋势持续性/回撤承接',
      weight: 20,
      reading:
        (raw.persistence ?? 0) >= 60
          ? '多指数共振、回撤守住关键均线，趋势有延续性'
          : (raw.persistence ?? 0) <= 35
            ? '趋势不连续、回撤易破位，承接偏弱'
            : '趋势承接一般，需继续确认',
      evidence: `共振站上MA60 ${pctInt(cntAboveMa60 / n)}·MA20走平转上 ${pctInt(cntSlopeUp / n)}·近20日上涨日占比 ${pctInt(upRatioAvg)}`,
    },
    {
      key: 'equalWeight',
      label: '全A等权失真校正',
      weight: 20,
      reading: !isEqwUsable(eqw)
        ? EQW_PROXY_TEXT
        : ctx.distortion
          ? '权重股护盘、全A等权走弱，普涨成色不足'
          : eqw!.aboveMa60 && eqw!.trendPct20 > 0
            ? '全A等权同步走强，普涨成色好'
            : '全A等权偏弱，个股赚钱效应有限',
      evidence: !isEqwUsable(eqw)
        ? eqw?.upRatio != null
          ? `${eqw.name}·涨占比${eqw.upRatio}%（非等权口径，不作 MA60 与 20 日涨幅结论）`
          : '—'
        : `${eqw!.name}·${eqw!.aboveMa60 ? '站上MA60' : '失守MA60'}·20日${eqw!.trendPct20 >= 0 ? '+' : ''}${eqw!.trendPct20}%${eqw!.upRatio != null ? `·涨占比${eqw!.upRatio}%` : ''}`,
    },
    {
      key: 'breadth',
      label: '市场宽度',
      weight: 15,
      reading:
        (raw.breadth ?? 0) >= 60
          ? '上涨家数占优，宽度健康'
          : (raw.breadth ?? 0) <= 40
            ? '下跌家数占优，宽度偏弱'
            : '涨跌参半，宽度中性',
      evidence: eqw?.upRatio != null ? `上涨占比 ${eqw.upRatio}%` : ctx.sentimentIndex != null ? `情绪广度代理 ${Math.round(raw.breadth ?? 0)}` : '—',
    },
    {
      key: 'sentiment',
      label: '情绪周期',
      weight: 10,
      reading:
        ctx.sentimentIndex == null
          ? '情绪数据缺失'
          : ctx.sentimentIndex >= 60
            ? '情绪活跃、赚钱效应强'
            : ctx.sentimentIndex <= 35
              ? '情绪低迷、赚钱效应差'
              : '情绪中性',
      evidence:
        ctx.sentimentIndex != null
          ? `情绪指数 ${ctx.sentimentIndex}/100${ctx.sentimentPhase ? `·周期 ${ctx.sentimentPhase}` : ''}`
          : '—',
    },
    {
      key: 'volume',
      label: '量能',
      weight: 10,
      reading:
        ctx.vr >= 0.9 && ctx.vr <= 1.5
          ? '温和放量，量价健康'
          : ctx.vr < 0.9
            ? '缩量，人气不足'
            : '放量，注意分歧/高潮',
      evidence: `量比 ${ctx.vr.toFixed(2)}（${volLabel(ctx.vr)}）`,
    },
  ];

  return defs.map((d) => {
    const part = breakdown.parts.find((p) => p.label === d.label || p.label === `${d.label}（缺）`);
    const rv = raw[d.key];
    return {
      key: d.key,
      label: d.label,
      rawScore: rv != null ? Math.round(rv) : 0,
      weight: d.weight,
      contribution: part ? part.value : 0,
      reading: d.reading,
      evidence: d.evidence,
    };
  });
}

/** 明日及后续走势展望（确定性模板 + 动态拼接分数动量/持续天数） */
function buildOutlook(
  phase: MarketRegimePhase,
  delta: number | null,
  consecutiveDays: number,
): string {
  const base: Record<MarketRegimePhase, string> = {
    主升: '多指数与全A等权共振向上，明日及后续偏强，回撤不破关键均线前维持进攻；若量能持续温和放大、全A等权同步创新高，主升延续，重点留意高潮后过热与放量滞涨的见顶风险。',
    反弹: '站上短期均线但中期趋势尚未确认（或权重护盘、等权偏弱），明日方向偏中性；需看能否放量站稳 MA60、且全A等权同步转强来确认升级为主升，否则视为反抽，快进快出、不追高。',
    退潮: '多数个股走弱、情绪退潮，明日及后续偏弱，以防守观望为主；等涨停回升、炸板率下降、全A等权重回 MA60 等企稳信号出现，再小仓试错。',
    震荡: '多空纠缠、方向不明，明日中性；控制仓位精选主线龙头，等出现放量向上突破或跌破关键支撑后再顺势定方向。',
  };
  const momentum =
    delta == null
      ? '（暂无上一交易日对比）'
      : delta >= 3
        ? `（强度分较昨 +${r1(delta)}，动能转强）`
        : delta <= -3
          ? `（强度分较昨 ${r1(delta)}，动能转弱）`
          : `（强度分较昨基本持平）`;
  const persist =
    consecutiveDays === 1
      ? '当前阶段今日新切换，建议再观察 1-2 日确认。'
      : `当前阶段已持续 ${consecutiveDays} 个交易日。`;
  return `${base[phase]}${momentum}${persist}`;
}

/** 关键正向驱动因素 */
function buildDrivers(a: Aggregates, eqw: MarketRegimeEqualWeight | null, vr: number): string[] {
  const out: string[] = [];
  if (a.consAboveMa60 >= 0.6) out.push('多数指数站上 MA60');
  if (a.consBull >= 0.5) out.push('多指数多头排列');
  if (isEqwUsable(eqw) && eqw!.aboveMa60 && eqw!.trendPct20 > 0) out.push('全A等权同步走强（真普涨）');
  if (a.sentimentIndex != null && a.sentimentIndex >= 60) out.push('市场情绪活跃');
  if (vr >= 0.9 && vr <= 1.5) out.push('量能温和放大');
  if (a.majorAboveMa20 >= 0.75 && a.consAboveMa60 < 0.6) out.push('普遍站上 MA20（短线修复）');
  return out;
}

/** 关键风险提示 */
function buildRisks(
  a: Aggregates,
  eqw: MarketRegimeEqualWeight | null,
  vr: number,
  consecutiveDays: number,
): string[] {
  const out: string[] = [];
  if (a.distortion) out.push('权重股护盘、普涨成色不足');
  if (a.consBelowMa20 >= 0.6) out.push('多数指数跌破 MA20');
  if (a.sentimentPhase === '退潮' || a.sentimentPhase === '冰点') out.push(`情绪${a.sentimentPhase}`);
  if (a.volShrink) out.push('缩量、人气不足');
  if (vr > 2.2) out.push('异常放量，警惕分歧/高潮');
  // 代理口径（上涨家数占比）的 aboveMa60 只是「上涨家数过半」，不能写成「全A等权失守 MA60」
  if (isEqwUsable(eqw) && !eqw!.aboveMa60) out.push('全A等权失守 MA60');
  else if (eqw && !isEqwUsable(eqw)) out.push(EQW_PROXY_TEXT);
  if (consecutiveDays === 1) out.push('阶段今日新切换，待确认');
  return out;
}

// ===== 组装 =====

/** 取单指数日线（best-effort），失败返回空数组 */
async function fetchIndexBars(code: string, secid: string): Promise<KlineBar[]> {
  const { getKline } = await import('../market/eastmoney');
  return getKline(code, 'day', 260, secid).catch(() => [] as KlineBar[]);
}

/**
 * 组装大盘阶段总览（确定性只读 + 落库当日快照供方向判定与历史趋势）。
 * @param persist 是否写入当日快照（GET 与收盘定时均写，按日 upsert 幂等）
 */
export async function buildRegimeOverview(persist = true): Promise<MarketRegimeOverview> {
  let stale = false;

  // 1) 权重指数结构（多指数共振）
  const barsList = await Promise.all(REGIME_INDICES.map((ix) => fetchIndexBars(ix.code, ix.secid)));
  const items: MarketRegimeIndexItem[] = [];
  const closesList: number[][] = [];
  REGIME_INDICES.forEach((ix, i) => {
    const bars = barsList[i];
    const it = readIndex(ix.name, ix.secid, bars);
    if (it) {
      items.push(it);
      closesList.push(bars.map((b) => b.close));
    }
  });
  if (items.length < REGIME_INDICES.length) stale = true;

  // 2) 全A等权（880008）失真校正口径；取不到回退宽度代理
  let eqw: MarketRegimeEqualWeight | null = null;
  try {
    const { getAllAEqualWeight } = await import('./client');
    const s = await getAllAEqualWeight(260);
    const closes = s.bars.map((b) => b.close);
    if (closes.length >= 61) {
      const ma60 = sma(closes, 60);
      const close = closes[closes.length - 1];
      const total = (s.upCount ?? 0) + (s.downCount ?? 0);
      eqw = {
        source: 'tdx880008',
        name: '全A等权880008',
        aboveMa60: ma60 != null && close >= ma60,
        trendPct20: r1(pctChange(closes, 20)),
        upRatio: total > 0 && s.upCount != null ? r1((s.upCount / total) * 100) : null,
      };
    }
  } catch {
    /* 880008 取不到：下方回退宽度代理 */
  }

  // 3) 情绪周期（确定性底稿，best-effort）
  let sentimentIndex: number | null = null;
  let sentimentPhase: string | null = null;
  let sentimentBreadth: number | null = null;
  try {
    const { buildSentimentOverview } = await import('../sentiment/service');
    const sent = await buildSentimentOverview(false);
    sentimentIndex = sent.index;
    sentimentPhase = sent.phase;
    const c = sent.components;
    if (c.up != null && c.down != null) {
      const denom = c.up + c.down + (c.flat ?? 0);
      if (denom > 0) sentimentBreadth = (c.up / denom) * 100;
    }
  } catch {
    stale = true;
  }

  // 等权取不到 → 用情绪广度作宽度代理（每股一票口径），保证失真校正维度不缺
  if (!eqw && sentimentBreadth != null) {
    eqw = {
      source: 'breadth',
      name: '上涨家数占比代理',
      aboveMa60: sentimentBreadth >= 50,
      trendPct20: 0,
      upRatio: r1(sentimentBreadth),
    };
    stale = true;
  }

  // 4) 量能（放量/缩量，取上证 bars）
  const shBars = barsList[0] ?? [];
  const vr = volRatio(shBars, 20);

  // 5) 权重 vs 等权背离（护盘失真判定）
  const benchmark = items.find((i) => i.name === WEIGHTED_BENCHMARK) ?? items[0] ?? null;
  const distortion =
    !!benchmark && isEqwUsable(eqw) && benchmark.trendPct20 > 1 && eqw!.trendPct20 < 0;
  const divergence: MarketRegimeDivergence = {
    active: distortion,
    note: distortion
      ? `${benchmark?.name}近20日+${benchmark?.trendPct20}% 但全A等权${eqw?.trendPct20}%，权重股护盘、多数个股走弱，普涨成色不足`
      : isEqwUsable(eqw)
        ? '权重与等权方向一致，未见明显护盘失真'
        : '等权口径暂缺，未做背离校正',
  };

  // 6) 维度打分 + 合成（保留每维原始分供面板逐维展示）
  // 代理 eqw（上涨家数占比）不参与趋势判定：它的 aboveMa60 只是「过半上涨」，
  // 用它点亮 eqwTrendUp 会让「某天上涨家数过半」直接把大盘判成主升并给出 60-90% 仓位建议
  const eqwUsable = isEqwUsable(eqw);
  const eqwTrendUp = eqwUsable ? eqw!.aboveMa60 || eqw!.trendPct20 > 0 : null;
  const raw: Record<string, number | null> = {
    trend: scoreTrend(items, closesList),
    persistence: scorePersistence(items, closesList),
    equalWeight: scoreEqualWeight(eqw, distortion),
    breadth: scoreBreadth(eqw, sentimentBreadth),
    sentiment: sentimentIndex,
    volume: scoreVolume(vr),
  };
  const dims: DimScore[] = [
    { label: '趋势结构(均线)', value: raw.trend, weight: 25 },
    { label: '趋势持续性/回撤承接', value: raw.persistence, weight: 20 },
    { label: '全A等权失真校正', value: raw.equalWeight, weight: 20 },
    { label: '市场宽度', value: raw.breadth, weight: 15 },
    { label: '情绪周期', value: raw.sentiment, weight: 10 },
    { label: '量能', value: raw.volume, weight: 10 },
  ];
  const { score, breakdown } = synthesize(dims);

  // 7) 聚合标志 + 阶段判定
  const n = items.length || 1;
  const agg: Aggregates = {
    consAboveMa60: items.filter((i) => i.aboveMa60).length / n,
    consBull: items.filter((i) => i.alignment === '多头排列').length / n,
    majorAboveMa20: items.filter((i) => i.aboveMa20).length / n,
    consBelowMa20: items.filter((i) => !i.aboveMa20).length / n,
    eqwAboveMa60: eqwUsable ? eqw!.aboveMa60 : null,
    eqwTrendUp,
    distortion,
    sentimentIndex,
    sentimentPhase,
    volShrink: vr < 0.8,
  };
  const phase = items.length === 0 ? '震荡' : classifyPhase(agg);

  // 8) 方向 / 持续天数 / 环比
  const tradeDate = shanghaiToday();
  const prev = getPrevSnapshot(tradeDate);
  const delta = prev ? score - prev.score : null;
  const bias = decideBias(phase, agg, delta);
  const consecutiveDays = countConsecutivePhase(tradeDate, phase);
  const meta = PHASE_META[phase];

  // 9) 展示丰富化：逐维解读 + 明日展望 + 驱动 / 风险
  const dimensions = buildDimensions(
    { items, closesList, eqw, sentimentIndex, sentimentPhase, vr, distortion },
    raw,
    breakdown,
  );
  const outlook = buildOutlook(phase, delta, consecutiveDays);
  const drivers = buildDrivers(agg, eqw, vr);
  const risks = buildRisks(agg, eqw, vr, consecutiveDays);

  // 9.5) HMM 影子信号（概率视角，与规则四态并列印证）。best-effort：
  // 取不到不置 stale（HMM 为增益非必需，规则结论已完整），面板降级隐藏。
  let hmm: MarketRegimeOverview['hmm'] = null;
  try {
    const { getRegimeHmm } = await import('./client');
    hmm = await getRegimeHmm();
  } catch {
    /* sidecar 未接 / 样本不足：HMM 视角降级隐藏 */
  }

  const overview: MarketRegimeOverview = {
    asOf: nowIso(),
    tradeDate,
    phase,
    score,
    tomorrowBias: bias,
    suggestedFrequency: meta.frequency,
    positionRange: meta.positionRange,
    prevPhase: prev ? prev.phase : null,
    consecutiveDays,
    delta: delta != null ? r1(delta) : null,
    breakdown,
    dimensions,
    outlook,
    drivers,
    risks,
    indices: items,
    equalWeight: eqw,
    divergence,
    advice:
      meta.advice +
      (consecutiveDays === 1 ? '（阶段今日新切换，建议再观察 1-2 日确认）' : ''),
    note:
      '大盘阶段研判（确定性合成，仅供参考，不构成投资建议）。' +
      (stale ? '⚠️ 部分数据源降级，结论为不完整估计。' : ''),
    stale,
    hmm,
  };

  if (persist && items.length > 0) {
    upsertSnapshot({
      tradeDate,
      phase,
      score,
      tomorrowBias: bias,
      suggestedFrequency: meta.frequency,
      positionRange: meta.positionRange,
      breakdown,
    });
  }

  return overview;
}

/**
 * 驾驶舱摘要：读最新已落库快照构建紧凑总览（纯本地 DB 读，秒开、不触网）。
 * 完整明细（多指数/等权/背离）见大盘页 /api/market/regime 实时接口。无快照返回 null。
 */
export function getRegimeSummaryForCockpit(): MarketRegimeOverview | null {
  const snap = getLatestSnapshot();
  if (!snap) return null;
  const prev = getPrevSnapshot(snap.tradeDate);
  const meta = PHASE_META[snap.phase];
  return {
    asOf: snap.updatedAt,
    tradeDate: snap.tradeDate,
    phase: snap.phase,
    score: snap.score,
    tomorrowBias: snap.tomorrowBias,
    suggestedFrequency: snap.suggestedFrequency,
    positionRange: snap.positionRange,
    prevPhase: prev ? prev.phase : null,
    consecutiveDays: countConsecutivePhase(snap.tradeDate, snap.phase),
    delta: prev ? r1(snap.score - prev.score) : null,
    breakdown: snap.breakdown,
    dimensions: [],
    outlook: '',
    drivers: [],
    risks: [],
    indices: [],
    equalWeight: null,
    divergence: { active: false, note: '完整明细见大盘页' },
    advice: meta.advice,
    note: '驾驶舱摘要（最近一次收盘快照，完整明细见大盘页）。',
    stale: false,
  };
}

/** 大盘阶段文本摘要（注入 agent 研判/今日计划的确定性底稿） */
export function formatForAgent(ov: MarketRegimeOverview): string {
  const idx = ov.indices
    .map((i) => `${i.name} ${i.alignment}${i.aboveMa60 ? '·站上MA60' : '·失守MA60'}(20日${i.trendPct20 >= 0 ? '+' : ''}${i.trendPct20}%)`)
    .join('；');
  // 代理口径不得进 prompt 冒充等权结论：LLM 会把「失守MA60·20日+0%」当成事实继续推理
  const eqw = !ov.equalWeight
    ? '等权口径暂缺'
    : !isEqwUsable(ov.equalWeight)
      ? `${EQW_PROXY_TEXT}${ov.equalWeight.upRatio != null ? `，上涨占比${ov.equalWeight.upRatio}%` : ''}`
      : `${ov.equalWeight.name} ${ov.equalWeight.aboveMa60 ? '站上MA60' : '失守MA60'}，20日${ov.equalWeight.trendPct20 >= 0 ? '+' : ''}${ov.equalWeight.trendPct20}%${ov.equalWeight.upRatio != null ? `，上涨占比${ov.equalWeight.upRatio}%` : ''}`;
  const d = ov.delta == null ? '—' : `${ov.delta >= 0 ? '+' : ''}${ov.delta}`;
  const drivers = ov.drivers.length ? ov.drivers.join('、') : '—';
  const risks = ov.risks.length ? ov.risks.join('、') : '—';
  const hmmLine = ov.hmm
    ? `\nHMM概率视角（全A等权${ov.hmm.symbol}·${ov.hmm.window}日）：当前【${ov.hmm.state}】｜强弱读数 ${ov.hmm.strength}/100｜强势${ov.hmm.probs.强势}%·震荡${ov.hmm.probs.震荡}%·弱势${ov.hmm.probs.弱势}%（与规则结论相互印证，分歧即预警）`
    : '';
  return (
    `大盘阶段（${ov.tradeDate}${ov.stale ? '·数据降级' : ''}）\n` +
    `阶段【${ov.phase}】｜强度分 ${ov.score}/100（较上一交易日 ${d}）｜已持续 ${ov.consecutiveDays} 个交易日\n` +
    `明日倾向【${ov.tomorrowBias}】｜建议交易频率【${ov.suggestedFrequency}】｜建议仓位 ${ov.positionRange}\n` +
    `权重指数：${idx}\n` +
    `等权口径：${eqw}\n` +
    `权重vs等权：${ov.divergence.note}\n` +
    `驱动：${drivers}\n` +
    `风险：${risks}\n` +
    `明日及后续展望：${ov.outlook}\n` +
    `操作建议：${ov.advice}${hmmLine}`
  );
}

// ===== assert 自检（`tsx backend/src/regime/service.ts` 直接运行）=====
// 用纯指标函数构造两个已知形态，断言分类与打分方向正确（不触网、不落库）。
if (process.argv[1] && /regime\/service\.ts$/.test(process.argv[1])) {
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(`自检失败：${msg}`);
  };
  // 造一段线性上行的 closes（多头/站上均线/趋势为正）
  const upCloses = Array.from({ length: 130 }, (_, i) => 10 + i * 0.1);
  assert(maAlignment(upCloses) === '多头排列', `上行应判多头，实际 ${maAlignment(upCloses)}`);
  assert(maSlopeUp(upCloses, 20) === true, 'MA20 应走平转上');
  assert(pctChange(upCloses, 20) > 0, '近20日应为正涨幅');
  assert(upDayRatio(upCloses, 20) === 1, '全上行日占比应为 1');
  // 造一段线性下行的 closes（空头/破位/趋势为负）
  const downCloses = Array.from({ length: 130 }, (_, i) => 30 - i * 0.1);
  assert(maAlignment(downCloses) === '空头排列', `下行应判空头，实际 ${maAlignment(downCloses)}`);
  assert(pctChange(downCloses, 20) < 0, '近20日应为负涨幅');

  // 主升聚合 → 应判主升
  const bullAgg: Aggregates = {
    consAboveMa60: 1, consBull: 1, majorAboveMa20: 1, consBelowMa20: 0,
    eqwAboveMa60: true, eqwTrendUp: true, distortion: false,
    sentimentIndex: 60, sentimentPhase: '恢复', volShrink: false,
  };
  assert(classifyPhase(bullAgg) === '主升', `强多头应判主升，实际 ${classifyPhase(bullAgg)}`);

  // 退潮聚合（普遍破位 + 情绪退潮）→ 应判退潮
  const bearAgg: Aggregates = {
    consAboveMa60: 0, consBull: 0, majorAboveMa20: 0, consBelowMa20: 1,
    eqwAboveMa60: false, eqwTrendUp: false, distortion: false,
    sentimentIndex: 25, sentimentPhase: '退潮', volShrink: true,
  };
  assert(classifyPhase(bearAgg) === '退潮', `普遍破位应判退潮，实际 ${classifyPhase(bearAgg)}`);

  // 护盘失真（权重站上但等权走弱）→ 应判反弹
  const distAgg: Aggregates = {
    consAboveMa60: 0.5, consBull: 0.25, majorAboveMa20: 0.75, consBelowMa20: 0.25,
    eqwAboveMa60: false, eqwTrendUp: false, distortion: true,
    sentimentIndex: 50, sentimentPhase: '震荡', volShrink: false,
  };
  assert(classifyPhase(distAgg) === '反弹', `护盘失真应判反弹，实际 ${classifyPhase(distAgg)}`);

  // 展望 / 驱动 / 风险 文案生成
  const outlook = buildOutlook('主升', 5, 3);
  assert(outlook.length > 0 && outlook.includes('主升'), '主升展望应非空且含阶段描述');
  assert(buildDrivers(bullAgg, null, 1.2).length > 0, '强多头应有正向驱动因素');
  assert(buildRisks(distAgg, null, 1.0, 1).some((r) => r.includes('护盘')), '护盘失真应列入风险');

  // 代理 eqw（上涨家数占比）不得冒充等权口径下结论：它的 aboveMa60 只是「今天上涨家数过半」、
  // trendPct20 硬编码 0。分数已判 null 的维度，文字结论（风险项 / 维度证据 / LLM prompt）
  // 也一律不许断言「全A等权失守 MA60」「20日+0%」。
  const proxyEqw: MarketRegimeEqualWeight = {
    source: 'breadth',
    name: '上涨家数占比代理',
    aboveMa60: false,
    trendPct20: 0,
    upRatio: 42,
  };
  const realEqw: MarketRegimeEqualWeight = {
    source: 'tdx880008',
    name: '全A等权880008',
    aboveMa60: false,
    trendPct20: -3.2,
    upRatio: 42,
  };
  const proxyRisks = buildRisks(bearAgg, proxyEqw, 1.0, 3);
  assert(!proxyRisks.some((r) => r.includes('全A等权失守')), '代理口径不得断言「全A等权失守 MA60」');
  assert(proxyRisks.some((r) => r.includes('等权口径缺失')), '代理口径必须明说等权口径缺失');
  assert(
    buildRisks(bearAgg, realEqw, 1.0, 3).some((r) => r.includes('全A等权失守')),
    '真等权口径失守 MA60 仍必须列入风险',
  );

  const emptyBreakdown: StrengthBreakdown = { total: 0, parts: [] };
  const dimCtx = {
    items: [] as MarketRegimeIndexItem[],
    closesList: [] as number[][],
    sentimentIndex: null,
    sentimentPhase: null,
    vr: 1,
    distortion: false,
  };
  const proxyDim = buildDimensions({ ...dimCtx, eqw: proxyEqw }, {}, emptyBreakdown).find(
    (d) => d.key === 'equalWeight',
  )!;
  assert(!proxyDim.evidence.includes('失守MA60'), '代理口径的维度证据不得写「失守MA60」');
  assert(!proxyDim.evidence.includes('20日'), '代理口径的维度证据不得写 20 日涨幅（硬编码 0）');
  assert(proxyDim.reading.includes('等权口径缺失'), '代理口径的维度读数必须说明口径缺失');
  const realDim = buildDimensions({ ...dimCtx, eqw: realEqw }, {}, emptyBreakdown).find(
    (d) => d.key === 'equalWeight',
  )!;
  assert(realDim.evidence.includes('失守MA60'), '真等权口径的维度证据照旧给出 MA60 结论');

  // eslint-disable-next-line no-console
  console.log('regime/service.ts 自检通过：分类 + 展望/驱动/风险 文案生成均正确');
}
