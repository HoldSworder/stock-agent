import type { KlineBar, KlinePeriod, SwingGrade, SwingWatchLevel } from '@stock-agent/shared';
import { isExchangeFund, splitGapRatio } from '../market/instrument';
import { atr } from '../positions/riskBudget';
import { isAShareTradingTime } from '../util';
import { buildSegments, detectDivergence, type DivergenceResult } from './divergence';
import { MIN_BARS_FOR_STRUCTURE } from './universe';

// 两级定级 + 建议区间 + 存档止损。
//
// 为什么必须分两级，而不是一个「到底了」：
//  - 一级只说明力道在衰减。这件事在 A 股太常见，单靠它开仓等于接飞刀，
//    所以它永远只能拿试探仓——即便将来通过验收也不放大。
//  - 二级要求力道衰减之后**又出现了独立的价格反转事实**。只有这一级的样本
//    有资格参与「能不能放大仓位」的验收。
//
// 一级与二级的差别不是同一个阈值换个说法，而是两类不同的证据：
// 前者是指标读数，后者是价格自己走出来的事实。
//
// 关于「区间」的定位，页面必须如实写清：
// 它解决的是**下单容差**（不用赌那个精确的最低点），不是预测精度。
// 区间宽度取 0.75 倍 ATR，就是按这只标的自身的日常波动来定容差。

/** 区间宽度：以 ATR 为单位。0.75 约等于日常波动的四分之三，够容错又不至于宽到没有意义 */
const ZONE_ATR_MULT = 0.75;

/** 存档止损相对区间锚点的距离，同样以 ATR 为单位 */
const STOP_ATR_MULT = 0.5;

/** 追高线：价格超过区间上沿这么多 ATR 就不该再追 */
const CHASE_GUARD_ATR_MULT = 0.5;

/** 关注价位最多给几条，多了反而看不出重点 */
const MAX_WATCH_LEVELS = 3;

/**
 * 除权除息日的标的名会带这些前缀（XD 除息、XR 除权、DR 两者都有）。
 *
 * 这类标的当天不做判断：除权当天的开盘价相对前收是断层的，
 * 尽管取数层已做前复权修正，但当天这一根的振幅、ATR 与相邻几根的关系仍不可比，
 * 分型与力道读数都会失真。实测抓到过一只 XD 标的被判出底部信号并建了仓。
 *
 * 宁可当天不给结论：第二天名称前缀消失后照常判，只损失一天。
 */
const EX_DIVIDEND_PREFIXES = ['XD', 'XR', 'DR'] as const;

/** 名称是否带除权除息标记 */
export function isExDividendName(name: string): boolean {
  return EX_DIVIDEND_PREFIXES.some((p) => name.startsWith(p));
}

export interface SwingJudgement {
  grade: SwingGrade;
  /** 区间锚点：底部取最低端点，顶部取最高端点。给不出时为 null */
  anchor: number | null;
  zone: { low: number; high: number } | null;
  /** 建议产生时存档的初始止损，此后永不修改 */
  initialStop: number | null;
  /** 追高线：价格高于此值不再建仓 */
  chaseGuard: number | null;
  atr14: number | null;
  watchLevels: SwingWatchLevel[];
  rationale: string[];
  counterEvidence: string[];
  /** 判不了时的原因；能判时为 null */
  unavailableReason: string | null;
  /** 背驰原始读数，存档与复盘用 */
  divergence: DivergenceResult | null;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

function unavailable(reason: string): SwingJudgement {
  return {
    grade: 'none',
    anchor: null,
    zone: null,
    initialStop: null,
    chaseGuard: null,
    atr14: null,
    watchLevels: [],
    rationale: [],
    counterEvidence: [],
    unavailableReason: reason,
    divergence: null,
  };
}

/**
 * 剔除未收盘的那一根。
 *
 * 盘中最后一根的高低点与收盘价都还在变，拿它算区间和止损，
 * 会让同一个建议在一天之内反复改口——而建议一旦给出就该存档不动。
 * 只在交易时段剔除；收盘后最后一根已经定死，不该丢掉当天的信息。
 */
export function dropUnclosedBar(bars: KlineBar[], now = new Date()): KlineBar[] {
  return isAShareTradingTime(now) ? bars.slice(0, -1) : bars;
}

/**
 * 两个交易日之间隔了多少自然日。周线、月线的正常间隔不算停牌。
 * @param from YYYY-MM-DD
 * @param to YYYY-MM-DD
 */
function calendarGapDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * 没有 XD/XR/DR 前缀时，当天仍不判断背驰和破位的情形：
 * 除权除息、ETF 份额折算、份额合并、复牌缺口。
 * 认定门槛与日线复权同一条：跳空超过该品种涨跌幅极限才进折算判断。
 * 股票向上大跳空可能是真实暴涨，不当成份额合并；基金向上超幅度才认合并。
 * 跨境和商品 ETF 不设涨跌幅，关闭百分比推断，只认复牌这种日历缺口。
 * @returns 人话原因；当天可以判断时返回 null
 */
function corporateActionReason(
  bars: KlineBar[],
  period: KlinePeriod,
  code?: string,
  name?: string,
): string | null {
  if (name != null && isExDividendName(name)) {
    return '今天除权除息，价格是断层的，等明天再看';
  }
  if (bars.length < 2) return null;
  const prev = bars[bars.length - 2];
  const cur = bars[bars.length - 1];
  if (!(prev.close > 0) || !(cur.open > 0)) return null;
  const openRatio = cur.open / prev.close;
  const gap = splitGapRatio(code, name);
  if (period === 'day' && calendarGapDays(prev.time, cur.time) >= 5 && Math.abs(openRatio - 1) > 0.01) {
    return '今天是复牌缺口，当天不判断背驰和破位';
  }
  if (gap == null) return null;
  if (openRatio < 1 - gap) {
    return '今天跳空超过该品种涨跌幅极限，按除权或份额折算处理，当天不判断背驰和破位';
  }
  if (code && isExchangeFund(code) && openRatio > 1 + gap) {
    return '今天向上跳空超过该品种幅度，按份额合并处理，当天不判断背驰和破位';
  }
  return null;
}

/**
 * 二级确认：力道衰减之后，价格自己走出了反转事实。
 *
 * 底部至少收盘站上该极值之前的摆动高点。
 * 顶部至少收盘跌破该极值之前的摆动低点。
 * 只碰到极值当根的高点或低点，仍算一级。
 *
 * 为什么用收盘价而不是盘中价：盘中越过又收回来的太多，
 * 那属于试了一下没成，不该算反转确认。
 */
function hasReversalConfirm(
  bars: KlineBar[],
  extremeIndex: number,
  dir: 'bottom' | 'top',
  priorSwing: number,
): { ok: boolean; at: string | null; threshold: number } {
  const threshold = priorSwing;
  for (let i = extremeIndex + 1; i < bars.length; i += 1) {
    const c = bars[i].close;
    if (dir === 'bottom' ? c > threshold : c < threshold) {
      return { ok: true, at: bars[i].time, threshold };
    }
  }
  return { ok: false, at: null, threshold };
}

/**
 * 上下方关注价位。
 *
 * 全部取自同一套摆动点，不掺入 market/levels.ts 的斐波/枢轴——
 * 那套用的是「最近 60 根最高最低」这个另一套锚点，两套混在一张卡片上，
 * 使用者无法分辨哪条线是怎么来的。
 *
 * 距离只回答「到这条线还有多远」，**不是**「预计会回调这么多」。
 */
function buildWatchLevels(
  bars: KlineBar[],
  period: KlinePeriod,
  close: number,
): SwingWatchLevel[] {
  const segs = buildSegments(bars, period);
  const pts = segs.length > 0 ? [segs[0].from, ...segs.map((s) => s.to)] : [];
  const out: SwingWatchLevel[] = [];
  const seen = new Set<number>();

  // 由近及远遍历，先收离现价最近的几条
  for (const p of [...pts].reverse()) {
    const price = r3(p.price);
    if (seen.has(price) || !(price > 0)) continue;
    seen.add(price);
    const side: 'below' | 'above' = price < close ? 'below' : 'above';
    out.push({
      price,
      side,
      distancePct: r3((Math.abs(price - close) / close) * 100),
      basis: p.kind === 'low' ? `${p.time} 那波的低点` : `${p.time} 那波的高点`,
    });
  }

  // 上下各留最近的几条，避免一边倒
  const below = out.filter((l) => l.side === 'below').slice(0, MAX_WATCH_LEVELS);
  const above = out.filter((l) => l.side === 'above').slice(0, MAX_WATCH_LEVELS);
  return [...below, ...above];
}

/**
 * 定级。
 *
 * @param bars K 线。调用方应先经 dropUnclosedBar 剔除未收盘那根。
 * @param period 周期
 */
export function judgeSwing(
  bars: KlineBar[],
  period: KlinePeriod,
  name?: string,
  code?: string,
): SwingJudgement {
  // 除权、折算、合并、复牌当天不给结论：那一根与相邻几根不可比
  const action = corporateActionReason(bars, period, code, name);
  if (action) return unavailable(action);
  if (bars.length < MIN_BARS_FOR_STRUCTURE) {
    return unavailable(`只有 ${bars.length} 根K线，不够看出结构（至少要 ${MIN_BARS_FOR_STRUCTURE} 根）`);
  }
  const a = atr(bars);
  if (a == null || !(a > 0)) {
    return unavailable('算不出这只标的的日常波动幅度，给不出区间');
  }
  const close = bars[bars.length - 1].close;
  if (!(close > 0)) return unavailable('最新收盘价异常，不做判断');

  const div = detectDivergence(bars, period);
  const watchLevels = buildWatchLevels(bars, period, close);

  // 没有力道衰减 → 无信号，但关注价位照给（这是页面上最日常有用的信息）
  if (!div.kind) {
    // 保底给一句正面说明：背驰不成立时往往只产出反证，
    // 页面上就会出现「暂无信号」下面一片空白，看起来像是系统没算。
    // 使用者需要知道系统确实看过了、看到的是什么。
    const rationale =
      div.rationale.length > 0
        ? div.rationale
        : [`看了近 ${bars.length} 根K线，当前没有出现力道衰减的迹象`];
    return {
      grade: 'none',
      anchor: null,
      zone: null,
      initialStop: null,
      chaseGuard: null,
      atr14: r3(a),
      watchLevels,
      rationale,
      counterEvidence: div.counterEvidence,
      unavailableReason: null,
      divergence: div,
    };
  }

  const isBottom = div.kind === 'bottom';
  const rationale = [...div.rationale];
  const counter = [...div.counterEvidence];

  // 区间锚点：这一段走到的极值。已确认段取摆动点价格，延伸段取区间内实际极值
  const segs = buildSegments(bars, period);
  const lastSeg = segs[segs.length - 1];
  let anchor: number;
  let anchorIndex: number;
  if (div.confirmed && lastSeg) {
    anchor = lastSeg.to.price;
    anchorIndex = lastSeg.to.index;
  } else {
    // 延伸段：从最后一个确认摆动点到最新一根之间的实际极值
    const from = lastSeg ? lastSeg.to.index : Math.max(0, bars.length - 20);
    const tail = bars.slice(from);
    if (isBottom) {
      const lows = tail.map((b) => b.low);
      anchor = Math.min(...lows);
      anchorIndex = from + lows.indexOf(anchor);
    } else {
      const highs = tail.map((b) => b.high);
      anchor = Math.max(...highs);
      anchorIndex = from + highs.indexOf(anchor);
    }
  }

  const zone = isBottom
    ? { low: r3(anchor), high: r3(anchor + ZONE_ATR_MULT * a) }
    : { low: r3(anchor - ZONE_ATR_MULT * a), high: r3(anchor) };
  const initialStop = isBottom ? r3(anchor - STOP_ATR_MULT * a) : r3(anchor + STOP_ATR_MULT * a);
  const chaseGuard = isBottom
    ? r3(zone.high + CHASE_GUARD_ATR_MULT * a)
    : r3(zone.low - CHASE_GUARD_ATR_MULT * a);

  rationale.push(
    `区间 ${zone.low}~${zone.high}（按这只标的日常波动 ${r3(a)} 算出的下单容差，不是预测它会走到哪）`,
  );

  // 二级：延伸段永远够不上——它的极值点还没被确认，谈不上「反转已经发生」
  let grade: SwingGrade = isBottom ? 'risk_easing_bottom' : 'risk_easing_top';
  if (!div.confirmed) {
    counter.push('这一段还在走，极值点尚未定下来，只能算提前提示');
  } else {
    const priorSwing = lastSeg?.from.price;
    const conf =
      priorSwing != null && priorSwing > 0
        ? hasReversalConfirm(bars, anchorIndex, div.kind, priorSwing)
        : { ok: false, at: null, threshold: priorSwing ?? 0 };
    if (conf.ok) {
      grade = isBottom ? 'turn_confirmed_bottom' : 'turn_confirmed_top';
      rationale.push(
        isBottom
          ? `${conf.at} 收盘站上了该低点之前的摆动高点 ${r3(conf.threshold)}，价格自己走出了转向`
          : `${conf.at} 收盘跌破了该高点之前的摆动低点 ${r3(conf.threshold)}，价格自己走出了转向`,
      );
    } else {
      counter.push(
        isBottom
          ? `价格还没站上该低点之前的摆动高点 ${r3(conf.threshold)}，只碰到最低那根的高点仍算一级`
          : `价格还没跌破该高点之前的摆动低点 ${r3(conf.threshold)}，只碰到最高那根的低点仍算一级`,
      );
    }
  }

  return {
    grade,
    anchor: r3(anchor),
    zone,
    initialStop,
    chaseGuard,
    atr14: r3(a),
    watchLevels,
    rationale,
    counterEvidence: counter,
    unavailableReason: null,
    divergence: div,
  };
}

/** 供规则存档引用，改动即须升规则版本 */
export const JUDGE_PARAMS = {
  zoneAtrMult: ZONE_ATR_MULT,
  stopAtrMult: STOP_ATR_MULT,
  chaseGuardAtrMult: CHASE_GUARD_ATR_MULT,
  maxWatchLevels: MAX_WATCH_LEVELS,
} as const;
