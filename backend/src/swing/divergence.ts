import type { KlineBar, KlinePeriod, SwingPoint } from '@stock-agent/shared';
import { calcMacdSeries, type MacdPoint } from '../market/indicators';
import { dedupeAlternating, detectSwings } from '../symbolPlans/structure';

// 背驰检测：价格创了新极值，但推动它的力道反而衰减了。
//
// 这是整个波段模块唯一「系统里原本没有」的判断。缠论已有的分型、笔、中枢
// （symbolPlans/structure.ts）只描述结构走到哪了，不回答「这一段还有没有劲」。
//
// 四个必须写死、否则实现者各写一套就会得出不同结论的地方：
//
// 1) 「相邻同向段」不存在。摆动点顶底严格交替，所以同向的两段一定隔一段，
//    比较的是 i 与 i-2。若直接取 i-1 会拿下跌段和上涨段比面积，结论毫无意义。
//
// 2) 段的锚点用 detectSwings 的摆动点，**不用** chan.strokes。
//    实测原因：symbolPlans/structure.ts 的简化笔没有最小长度约束（其注释也自承「简化」），
//    387 根日线被切成 127 段、平均 3 根一段，拿 2 根和 3 根的段比 MACD 面积毫无意义——
//    2026-08-18 半导体回归就栽在这里：之后实际跌了 18%，却因段被切碎而全部判无背驰。
//    摆动点要求左右各 3 根内为极值且内置交替去重，段长合理，
//    而且波浪模块（market/elliott.ts）也用它，锚点因此与波浪一致。
//    全程只用这一套锚点，不与缠论分型混用。
//
// 3) MACD 与摆动点的对齐。MACD 前二十几根未成型，序列长度短于 K 线，
//    对齐一律走 time 反查，不许用任何数组下标推算。
//
// 4) 面积取段内柱的**代数和再取绝对值**，不是只累加与段方向同号的柱。
//    这一条最初写反了，自检立刻抓了出来：MACD 滞后于笔，一段下跌的前半段柱往往还是红的，
//    只筛负柱会让整段只剩一两根参与计算，段长瞬间变成「16 根 对 1 根」而被判不可比。
//    改用代数和还顺带修正了一个语义误解——先前担心「跨零轴正负相抵会伪造衰减」，
//    但一段下跌里若有很强反抽，它的净空头力道**确实**更弱，相抵恰好反映了这件事。
//    代价是需要防退化：净面积接近零时衰减比例会爆表，见 MIN_MEANINGFUL_AREA_RATIO。
//
// 5) 柱数差得太多的两段不可比，直接判无背驰，而不是强行归一。
//    段长差三倍以上时面积大小主要由时间长短决定，不反映力道。
//    宁可少报也不错报：这里报错一次，对应的是真金白银的一笔建仓。

/** 段内柱数比的可比区间。超出则两段不可比，判无背驰 */
const COMPARABLE_BAR_RATIO = { min: 0.4, max: 2.5 } as const;

/**
 * 段长下限只用于**记录与展示**，不用于剔除段。
 *
 * 这里踩过一次坑值得留档：先前为了挡掉 1~2 根的噪声段，在造段时 continue 跳过它们，
 * 结果破坏了方向交替——跳掉一段后剩下的序列变成 down/down/up，
 * 「同向两段隔一段」这个前提随之失效，日线上全部报「末段与隔一段方向不一致」。
 *
 * 跨度约束与交替约束在这里是冲突的，正确的分工是：
 *  - 交替性由摆动点保证（detectSwings 内置 dedupeAlternating）
 *  - 段长合理性由 COMPARABLE_BAR_RATIO 在比较时挡，它不改动段序列
 * 所以这个常量不参与过滤，只在依据文本里说明段有多长。
 */
const SHORT_SEGMENT_HINT = 4;

/**
 * 力道至少要衰减这个比例才算背驰。
 *
 * 0.2 的含义：后一段的柱面积不足前一段的 80%。
 * 取值偏保守是刻意的——A 股日线上「略微衰减」太常见，阈值低会让页面每天满屏背驰。
 */
const MIN_WEAKEN_RATIO = 0.2;

/**
 * 后一段净面积至少要占前一段的这个比例，才认为「衰减」这件事有意义。
 *
 * 防的是代数和退化：段内正负柱恰好抵消到接近零时，衰减比例会算出 99%，
 * 看起来是史无前例的强背驰，实际上只是这一段多空拉锯、力道方向不明。
 * 那种情况下不该给建仓信号，该判无结论。
 */
const MIN_MEANINGFUL_AREA_RATIO = 0.05;

/** 一段走势在 K 线上的范围与力道读数 */
interface StrokeSegment {
  dir: 'up' | 'down';
  /** 起止摆动点 */
  from: SwingPoint;
  to: SwingPoint;
  /** 在原始 K 线数组上的下标区间（闭区间） */
  fromIndex: number;
  toIndex: number;
  /** 段内柱代数和的绝对值，即这一段的净推动力 */
  area: number;
  /** 段内有效柱数（不筛符号，故等于段长扣掉 MACD 未成型的部分） */
  barCount: number;
  /** 段内 DIF 极值：下跌段取最小、上涨段取最大 */
  difExtreme: number;
  /** 段终点价格（下跌段是低点，上涨段是高点） */
  endPrice: number;
}

export interface DivergenceResult {
  /** 'bottom' 底背驰 / 'top' 顶背驰 / null 无 */
  kind: 'bottom' | 'top' | null;
  /**
   * 这条结论是否建立在**已走完并确认**的一段之上。
   *
   * false 表示用的是当前还在延伸的那一段——它能提前发现力道衰减，
   * 但结论会随每天新数据变动，明天可能就不成立了。
   * 这个区别决定它只能当预警、不能当确认，两者的仓位待遇也不同。
   */
  confirmed: boolean;
  /** 强度 0~1，按面积衰减比例算；无背驰为 null */
  strength: number | null;
  /** 后一段面积 ÷ 前一段面积；无背驰为 null */
  areaRatio: number | null;
  /** 判定依据逐条，页面与复盘都要看 */
  rationale: string[];
  /** 与判定相反的证据，单独列出 */
  counterEvidence: string[];
}

const NONE = (rationale: string[], counterEvidence: string[] = []): DivergenceResult => ({
  kind: null,
  confirmed: false,
  strength: null,
  areaRatio: null,
  rationale,
  counterEvidence,
});

/** 用 time 反查原始 K 线下标。查不到返回 -1，调用方必须处理 */
function indexOfTime(bars: KlineBar[], time: string): number {
  return bars.findIndex((b) => b.time === time);
}

/** 带 K 线下标的摆动点 */
interface AnchoredSwing extends SwingPoint {
  index: number;
}

/**
 * 把摆动点切成交替的段。
 *
 * 只取已确认的摆动点：未确认点会被后续新数据推翻（见 structure.ts 的 SWING_CONFIRM_BARS），
 * 拿它做建仓依据意味着同一段行情隔天可能给出不同结论。
 * 按 confirmed 过滤会打断顶底交替，故过滤后必须重新去重（这是 dedupeAlternating 注释里点明的坑）。
 *
 * **不剔除任何段**：剔段会破坏方向交替，见 SHORT_SEGMENT_HINT 的说明。
 * 段太短导致的不可比，由比较阶段的 COMPARABLE_BAR_RATIO 负责挡。
 */
export function buildSegments(
  bars: KlineBar[],
  period: KlinePeriod,
): Array<{ dir: 'up' | 'down'; from: AnchoredSwing; to: AnchoredSwing }> {
  const confirmed = dedupeAlternating(
    detectSwings(bars, period).filter((s) => s.confirmed),
  );
  const anchored: AnchoredSwing[] = [];
  for (const s of confirmed) {
    const idx = indexOfTime(bars, s.time);
    if (idx >= 0) anchored.push({ ...s, index: idx });
  }
  if (anchored.length < 2) return [];

  const out: Array<{ dir: 'up' | 'down'; from: AnchoredSwing; to: AnchoredSwing }> = [];
  for (let i = 1; i < anchored.length; i += 1) {
    const from = anchored[i - 1];
    const to = anchored[i];
    out.push({ dir: to.kind === 'high' ? 'up' : 'down', from, to });
  }
  return out;
}

/**
 * 把一段笔的力道读出来。
 *
 * @param macdByIndex 以原始 K 线下标为键的 MACD 点，未成型的下标查不到
 */
function readSegment(
  dir: 'up' | 'down',
  from: SwingPoint,
  to: SwingPoint,
  fromIndex: number,
  toIndex: number,
  macdByIndex: Map<number, MacdPoint>,
): StrokeSegment | null {
  let sum = 0;
  let barCount = 0;
  let difExtreme = dir === 'down' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (let i = fromIndex; i <= toIndex; i += 1) {
    const p = macdByIndex.get(i);
    if (!p) continue; // MACD 未成型的区段跳过，不当作 0 面积
    // 代数和：保留符号累加。MACD 滞后于笔，下跌段前半段的柱往往还是正的，
    // 只筛同号柱会让整段只剩一两根参与计算（自检里出现过 16 根对 1 根）
    sum += p.bar;
    barCount += 1;
    difExtreme = dir === 'down' ? Math.min(difExtreme, p.dif) : Math.max(difExtreme, p.dif);
  }
  if (barCount === 0 || !Number.isFinite(difExtreme)) return null;
  return {
    dir,
    from,
    to,
    fromIndex,
    toIndex,
    area: Math.abs(sum),
    barCount,
    difExtreme,
    endPrice: to.price,
  };
}

/**
 * 检测最后一段笔是否与其前一段同向笔构成背驰。
 *
 * @param bars 原始 K 线，**必须只含已收盘的根**。未收盘那根的柱值还在变，
 *   拿它算面积会让同一段行情在盘中反复给出不同结论。剔除由调用方负责（见 judge.ts）。
 * @param period K 线周期，摆动点 id 需要它
 */
function compare(p0: StrokeSegment, p1: StrokeSegment, confirmed: boolean): DivergenceResult {
  const dir = p1.dir;
  const rationale: string[] = [];
  const counter: string[] = [];

  // 条件一：价格创新极值。下跌段要新低，上涨段要新高
  const madeExtreme = dir === 'down' ? p1.endPrice < p0.endPrice : p1.endPrice > p0.endPrice;
  const priceWord = dir === 'down' ? '新低' : '新高';
  if (madeExtreme) {
    rationale.push(
      `价格创${priceWord}：这一段走到 ${p1.endPrice.toFixed(3)}，上一段是 ${p0.endPrice.toFixed(3)}`,
    );
  } else {
    counter.push(
      `价格没创${priceWord}（这一段 ${p1.endPrice.toFixed(3)}，上一段 ${p0.endPrice.toFixed(3)}），不构成背驰`,
    );
    return NONE(rationale, counter);
  }

  // 条件二：两段柱数可比。差太多则面积主要由时长决定，不反映力道
  const barRatio = p1.barCount / p0.barCount;
  if (barRatio < COMPARABLE_BAR_RATIO.min || barRatio > COMPARABLE_BAR_RATIO.max) {
    counter.push(
      `两段长度差太多（${p0.barCount} 根 对 ${p1.barCount} 根），面积不可比，不判背驰`,
    );
    return NONE(rationale, counter);
  }
  rationale.push(
    `两段长度可比：${p0.barCount} 根 对 ${p1.barCount} 根` +
      (p1.barCount < SHORT_SEGMENT_HINT ? '（这一段偏短，结论把握有限）' : ''),
  );

  // 条件三：力道衰减达阈值
  if (!(p0.area > 0)) {
    return NONE(rationale, ['上一段力道读数为零，无法比较']);
  }
  const areaRatio = p1.area / p0.area;
  // 防代数和退化：净面积接近零说明这一段多空拉锯、力道方向不明，
  // 此时算出的 99% 衰减是假的，不该给建仓信号
  if (areaRatio < MIN_MEANINGFUL_AREA_RATIO) {
    counter.push(
      `这一段多空拉锯、净推动力接近零（只有上一段的 ${(areaRatio * 100).toFixed(1)}%），` +
        `力道方向不明，不判背驰`,
    );
    return NONE(rationale, counter);
  }
  const weaken = 1 - areaRatio;
  if (weaken < MIN_WEAKEN_RATIO) {
    counter.push(
      `力道没有明显减弱（这一段是上一段的 ${(areaRatio * 100).toFixed(0)}%，` +
        `要低于 ${((1 - MIN_WEAKEN_RATIO) * 100).toFixed(0)}% 才算），不判背驰`,
    );
    return NONE(rationale, counter);
  }
  rationale.push(
    `力道减弱：这一段的推动力只有上一段的 ${(areaRatio * 100).toFixed(0)}%`,
  );

  // 条件四：DIF 同向背离。价格更极端但 DIF 反而没更极端，才是真背离
  const difDiverged =
    dir === 'down' ? p1.difExtreme > p0.difExtreme : p1.difExtreme < p0.difExtreme;
  if (difDiverged) {
    rationale.push(
      `指标未跟随创${priceWord}（${p0.difExtreme.toFixed(3)} → ${p1.difExtreme.toFixed(3)}）`,
    );
  } else {
    counter.push(
      `指标跟着价格一起创${priceWord}（${p0.difExtreme.toFixed(3)} → ${p1.difExtreme.toFixed(3)}），` +
        `力道虽减弱但方向未背离，不判背驰`,
    );
    return NONE(rationale, counter);
  }

  return {
    kind: dir === 'down' ? 'bottom' : 'top',
    confirmed,
    // 衰减 20% 记 0 分、衰减 100% 记 1 分，线性映射到可用区间
    strength: Math.min(1, Math.max(0, (weaken - MIN_WEAKEN_RATIO) / (1 - MIN_WEAKEN_RATIO))),
    areaRatio,
    rationale,
    counterEvidence: counter,
  };
}

/**
 * 检测背驰。优先给已确认段的结论；给不出时退一步看当前还在延伸的那一段。
 *
 * 为什么必须有「未完成段」这条路：2026-08-18 半导体回归揭示的固有限制——
 * 那天之后实际跌了 18%，但当时最后一个确认结构点是 8 月 4 日的低点，
 * 之后是一段还在上涨、顶尚未形成的走势。摆动高点要右侧 3 根才确认，
 * 所以「已确认顶背驰」在那天**不可能**成立，连候选顶点都没有。
 * 只看已确认段，这个模块就永远给不出任何提前提示，只能事后追认。
 *
 * 两条路的结论不等价，靠 confirmed 字段区分，绝不可混为一谈：
 *  - confirmed=true：段已走完，结论稳定
 *  - confirmed=false：段还在延伸，能提前发现力道衰减，但明天可能就不成立
 *
 * @param bars 原始 K 线，**必须只含已收盘的根**。未收盘那根的柱值还在变，
 *   拿它算面积会让同一段行情在盘中反复给出不同结论。剔除由调用方负责（见 judge.ts）。
 * @param period K 线周期，摆动点 id 需要它
 */
export function detectDivergence(bars: KlineBar[], period: KlinePeriod): DivergenceResult {
  const segs = buildSegments(bars, period);
  if (segs.length < 3) {
    return NONE([`有效段 ${segs.length} 段，不足 3 段，凑不出同向两段可比`]);
  }

  const closes = bars.map((b) => b.close);
  const macdByIndex = new Map<number, MacdPoint>(calcMacdSeries(closes).map((p) => [p.index, p]));
  if (macdByIndex.size === 0) {
    return NONE([`样本 ${bars.length} 根，指标未成型`]);
  }

  const read = (
    dir: 'up' | 'down',
    from: SwingPoint,
    to: SwingPoint,
    fi: number,
    ti: number,
  ): StrokeSegment | null => readSegment(dir, from, to, fi, ti, macdByIndex);

  // 已确认段的不成立结论。留着做兜底返回值：
  // 若延伸段也不成立，返回它比返回延伸段的说明更有信息量（它基于走完的段）
  let confirmedMiss: DivergenceResult | null = null;

  // --- 路一：已确认的末段 与 同向的前一段（顶底交替，故隔一段） ---
  const curr = segs[segs.length - 1];
  const prev = segs[segs.length - 3];
  if (curr.dir === prev.dir) {
    const p0 = read(prev.dir, prev.from, prev.to, prev.from.index, prev.to.index);
    const p1 = read(curr.dir, curr.from, curr.to, curr.from.index, curr.to.index);
    if (p0 && p1) {
      const done = compare(p0, p1, true);
      if (done.kind) return done;
      // 已确认段不成立时不直接返回：当前延伸段可能已在衰减，那才是提前信号
      confirmedMiss = done;
    }
  }

  // --- 路二：当前还在延伸的那一段 与 同向的上一段 ---
  // 延伸段 = 从最后一个确认摆动点到当前最新一根。方向与末段相反
  const lastSwing = curr.to;
  const lastIdx = bars.length - 1;
  const extDir: 'up' | 'down' = curr.dir === 'up' ? 'down' : 'up';
  const spanBars = lastIdx - lastSwing.index;
  if (spanBars < 2) {
    return confirmedMiss ?? NONE([`当前段才走了 ${spanBars} 根，太短，不做力道比较`]);
  }
  // 延伸段的终点用区间内的实际极值，而不是最新收盘价——
  // 判断「有没有创新高」要看这一段摸到过的最高点
  const tail = bars.slice(lastSwing.index, lastIdx + 1);
  const extEndPrice =
    extDir === 'up' ? Math.max(...tail.map((b) => b.high)) : Math.min(...tail.map((b) => b.low));
  const extTo: SwingPoint = {
    id: `sw:${period}:${extDir === 'up' ? 'high' : 'low'}:${bars[lastIdx].time}:extending`,
    period,
    kind: extDir === 'up' ? 'high' : 'low',
    time: bars[lastIdx].time,
    price: extEndPrice,
    confirmed: false,
  };
  // 与延伸段同向的上一段：末段方向与延伸段相反，故取倒数第二段
  const sameDirPrev = segs[segs.length - 2];
  if (!sameDirPrev || sameDirPrev.dir !== extDir) {
    return confirmedMiss ?? NONE(['找不到与当前延伸段同向的上一段，不做力道比较']);
  }
  const e0 = read(extDir, sameDirPrev.from, sameDirPrev.to, sameDirPrev.from.index, sameDirPrev.to.index);
  const e1 = read(extDir, lastSwing, extTo, lastSwing.index, lastIdx);
  if (!e0 || !e1) {
    return confirmedMiss ?? NONE(['当前延伸段没有有效指标读数，不做力道比较']);
  }
  const ext = compare(e0, e1, false);
  if (ext.kind) {
    ext.rationale.unshift('这一段还在走，结论会随后续走势变动，只作提前提示');
    return ext;
  }
  return confirmedMiss ?? ext;
}

/** 供自检与规则存档引用，改动即须升规则版本 */
export const DIVERGENCE_PARAMS = {
  minWeakenRatio: MIN_WEAKEN_RATIO,
  minMeaningfulAreaRatio: MIN_MEANINGFUL_AREA_RATIO,
  comparableBarRatio: COMPARABLE_BAR_RATIO,
  shortSegmentHint: SHORT_SEGMENT_HINT,
} as const;
