import type {
  AssertionKind,
  AssertionSource,
  ChanStructure,
  ElliottAnalysis,
  KlineBar,
  KlinePeriod,
  PriceLevels,
} from '@stock-agent/shared';
import { ASSERTION_TOLERANCE_BARS } from '@stock-agent/shared';
import { SWING_CONFIRM_BARS } from '../symbolPlans/structure';
import { shiftTradingDays } from '../market/calendar';

// 从各技术模块**已有的输出**里抽取可证伪断言。
//
// 纪律：本文件不做任何技术计算，只做「结论 → 可判对错的陈述」的翻译。
// 一旦这里开始自己算点位，同一个位子就会有两套算法，统计出来的遵循率
// 说的就不是界面上那条线准不准了。

/** 一条待冻结的断言（尚未分配 id 与到期日） */
export interface DraftAssertion {
  kind: AssertionKind;
  source: AssertionSource;
  statement: string;
  price: number | null;
  priceHigh: number | null;
  windowFrom: string | null;
  windowTo: string | null;
  /** 期望触及后的反应方向：up=向上反弹，down=向下受阻 */
  direction: 'up' | 'down' | null;
  /** 溯源标识，同时充当同日幂等的语义键 */
  evidenceRef: string;
  /**
   * 该条断言属于哪个周期。缺省即冻结主周期（日线）。
   *
   * 必须逐条落对：结算侧靠它决定 `getKline` 取哪套 K 线、`detectSwings` 按哪个周期找转折。
   * 填错就是拿日线去判周线。
   */
  period?: KlinePeriod;
  /**
   * 到期日覆盖。缺省走统一的观察窗。
   *
   * 时间断言需要它：周线的预测窗口落在一两个月后，用统一的 20 天到期，
   * 那条断言会在窗口还没走到时就被判「没走到」，然后永远学不到东西。
   */
  dueDate?: string;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const fmt = (n: number): string => (n < 10 ? n.toFixed(3) : n.toFixed(2));

/**
 * 点位断言只收「现价够得着」的那些。
 *
 * 远到离谱的位子（如波浪 261.8% 扩展打出的翻倍价）在观察窗内几乎必然 untouched，
 * 它们不进分母、不影响遵循率，却会把账本撑大好几倍、让下钻列表全是废条目。
 * 用 ATR 倍数而不是百分比设界：同样是 10%，高波动标的一周就能走到，低波动的一年都到不了。
 */
const MAX_DISTANCE_ATR = 8;

/**
 * 被实测证伪、不再登记的斐波那契时间档。
 *
 * 只排这一档而不是「远端全排」：100% 档同样比 61.8% 远，实测却有 14/22 = 64%。
 * 依据是账本的实测成绩，不是「越远越不准」的直觉。
 */
export const DEAD_TIME_RATIO = '161.8%';

/** 该条断言是否属于已被证伪的时间档。存量记录改不了，展示层据此一并滤掉 */
export function isDeadTimeAssertion(evidenceRef: string | null): boolean {
  return evidenceRef?.endsWith(`:time:${DEAD_TIME_RATIO}`) ?? false;
}

/** 价位离现价太远就不值得记 */
function withinReach(price: number, close: number, atr: number | null): boolean {
  if (!(price > 0) || !(close > 0)) return false;
  if (!atr || atr <= 0) return true;
  return Math.abs(price - close) / atr <= MAX_DISTANCE_ATR;
}

/**
 * 价位在现价上方即「压力」，触及后应向下受阻；下方即「支撑」，触及后应向上反弹。
 * 断言的方向必须这么定，而不能照搬来源自己的多空语义——判定看的是
 * 「价格摸到这条线之后有没有掉头」，与这条线当初为什么被画出来无关。
 */
function reactionDirection(price: number, close: number): 'up' | 'down' {
  return price >= close ? 'down' : 'up';
}

/**
 * 波浪：见顶/见底位与斐波那契时间位。
 *
 * @param degree 取哪一级计数。`minor` 是主周期（日线），`major` 是大级别（周线）。
 *   大级别**只登记时间位、不登记价位**：`withinReach` 与落库的 ATR 快照都是日线量纲，
 *   拿它去筛周线价位、再用「反向走出 ≥1 个日线 ATR」判周线是否守住，量纲整个是错的。
 *   要做周线价位得先算周线 ATR，那是另一件事。
 */
export function fromElliott(
  a: ElliottAnalysis,
  atr: number | null,
  degree: 'minor' | 'major' = 'minor',
): DraftAssertion[] {
  const out: DraftAssertion[] = [];
  const c = degree === 'major' ? a.major : a.minor;
  if (!c || c.state === 'unclear') return out;
  const close = a.close;
  const levelsAllowed = degree === 'minor';

  for (const t of levelsAllowed ? c.targets : []) {
    if (!withinReach(t.price, close, atr)) continue;
    out.push({
      kind: 'level',
      source: 'elliott',
      statement: `波浪判${c.currentLabel ?? '?'}浪可能在 ${fmt(t.price)}（${t.ratio}）停下`,
      price: r3(t.price),
      priceHigh: null,
      windowFrom: null,
      windowTo: null,
      direction: reactionDirection(t.price, close),
      evidenceRef: `elliott:${c.period}:${c.currentLabel}:target:${t.ratio}`,
    });
  }

  /**
   * 失效价同样是可证伪的位子，而且方向与普通支撑压力**一致**，不能取反。
   *
   * 这里踩过一次坑：曾按「失效价被触及后应顺势穿过」登记成反向，结果
   * 「价格击穿失效价、波浪计数被证伪」会被判成 respected，等于给波浪判错记一分——
   * 实测 183 条失效价断言（占波浪断言的一半）都在反着算分。
   * 正确的读法是：这套计数**预期价格不越过**这里，所以它就是一条普通的顶／底，
   * 触及后掉头才算这条判断有效。
   */
  if (levelsAllowed && c.invalidationPrice != null && withinReach(c.invalidationPrice, close, atr)) {
    out.push({
      kind: 'level',
      source: 'elliott',
      statement: `波浪判${c.currentLabel ?? '?'}浪不应越过 ${fmt(c.invalidationPrice)}（越过则该计数作废）`,
      price: r3(c.invalidationPrice),
      priceHigh: null,
      windowFrom: null,
      windowTo: null,
      direction: reactionDirection(c.invalidationPrice, close),
      evidenceRef: `elliott:${c.period}:${c.currentLabel}:invalidation`,
    });
  }

  /**
   * 时间位只取「下一个尚未走过」的那一个：已经走过的没有预测价值，
   * 更远的几档在观察窗内多半还没到期，记了也只是占位。
   *
   * 161.8% 那一档整个排除掉。实测 27 笔已判定里只有 7 笔命中，26%，
   * Wilson 95% 区间 [13%, 45%]——**上界都够不到 50%**，明显低于其余档，
   * 不是「不够准」而是有害：留着它，时间断言整体从 56% 被拖到 49%。
   * 判定窗口已经放宽到 ±3 根（7 根宽）仍然如此，说明这么远的时间外推本身就没有信息。
   */
  const nextTime = c.timeProjections.find((t) => !t.reached && t.ratio !== DEAD_TIME_RATIO);
  if (nextTime && c.currentLabel) {
    out.push({
      kind: 'time',
      source: 'elliott',
      statement: `波浪推${c.currentLabel}浪约在 ${nextTime.date} 前后走完（${nextTime.ratio} 时间位）`,
      price: null,
      priceHigh: null,
      windowFrom: nextTime.date,
      windowTo: nextTime.date,
      direction: c.currentDirection,
      evidenceRef: `elliott:${c.period}:${c.currentLabel}:time:${nextTime.ratio}`,
      period: c.period,
      // 周线的预测窗口在一两个月后，统一 20 天到期会让它在窗口还没走到时就被判「没走到」
      dueDate: timeDueDate(nextTime.date, c.period),
    });
  }
  return out;
}

/**
 * 时间断言应该等到哪天才下判断。
 *
 * 要等的是「预测窗口上界 + 容差根数 + 摆动点确认根数」全部走完。少等一样都会系统性判错：
 * 恰好踩在窗口边缘命中的那个转折，此刻还没被标成已确认，会被记成「没转」。
 *
 * 日线按交易日推，不能拿自然日凑——跨周末和长假会少算好几根。
 * 周线按每根 7 天投射一个保守的日期即可，真正的结算时机由 judgeTime 按实际走出的根数把关。
 */
function timeDueDate(windowTo: string, period: KlinePeriod): string {
  const bars = ASSERTION_TOLERANCE_BARS + SWING_CONFIRM_BARS;
  return period === 'day' ? shiftTradingDays(windowTo, bars) : addDays(windowTo, bars * 7);
}

/** 自然日加减 */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 黄金分割与枢轴：来自 S10 点位测算 */
export function fromLevels(lv: PriceLevels): DraftAssertion[] {
  const out: DraftAssertion[] = [];
  const close = lv.close;
  const atr = lv.atr;

  for (const f of lv.fibRetracements) {
    if (!withinReach(f.price, close, atr)) continue;
    out.push({
      kind: 'level',
      source: 'fib',
      statement: `黄金分割 ${f.ratio} 回撤位 ${fmt(f.price)}`,
      price: r3(f.price),
      priceHigh: null,
      windowFrom: null,
      windowTo: null,
      direction: reactionDirection(f.price, close),
      evidenceRef: `fib:${lv.period}:retrace:${f.ratio}`,
    });
  }
  for (const f of lv.fibExtensions) {
    if (!withinReach(f.price, close, atr)) continue;
    out.push({
      kind: 'level',
      source: 'fib',
      statement: `黄金分割 ${f.ratio} 扩展位 ${fmt(f.price)}`,
      price: r3(f.price),
      priceHigh: null,
      windowFrom: null,
      windowTo: null,
      direction: reactionDirection(f.price, close),
      evidenceRef: `fib:${lv.period}:extend:${f.ratio}`,
    });
  }

  if (lv.pivot) {
    const p = lv.pivot;
    const rows: Array<[string, number]> = [
      ['PP', p.pp],
      ['R1', p.r1],
      ['R2', p.r2],
      ['S1', p.s1],
      ['S2', p.s2],
    ];
    for (const [name, price] of rows) {
      if (!withinReach(price, close, atr)) continue;
      out.push({
        kind: 'level',
        source: 'pivot',
        statement: `枢轴 ${name} ${fmt(price)}`,
        price: r3(price),
        priceHigh: null,
        windowFrom: null,
        windowTo: null,
        direction: reactionDirection(price, close),
        evidenceRef: `pivot:${lv.period}:${name}`,
      });
    }
  }

  // 均线只取最近的上下各一条：更远的均线在观察窗内够不着，
  // 且它们的支撑/压力含义要等价格走到附近才谈得上
  if (lv.ma?.supportMa && withinReach(lv.ma.supportMa.value, close, atr)) {
    out.push({
      kind: 'level',
      source: 'ma',
      statement: `MA${lv.ma.supportMa.period} 支撑 ${fmt(lv.ma.supportMa.value)}`,
      price: r3(lv.ma.supportMa.value),
      priceHigh: null,
      windowFrom: null,
      windowTo: null,
      direction: 'up',
      evidenceRef: `ma:${lv.period}:support:${lv.ma.supportMa.period}`,
    });
  }
  if (lv.ma?.resistanceMa && withinReach(lv.ma.resistanceMa.value, close, atr)) {
    out.push({
      kind: 'level',
      source: 'ma',
      statement: `MA${lv.ma.resistanceMa.period} 压力 ${fmt(lv.ma.resistanceMa.value)}`,
      price: r3(lv.ma.resistanceMa.value),
      priceHigh: null,
      windowFrom: null,
      windowTo: null,
      direction: 'down',
      evidenceRef: `ma:${lv.period}:resistance:${lv.ma.resistanceMa.period}`,
    });
  }
  return out;
}

/** 缠论中枢：上下边界各算一条断言 */
export function fromChan(
  chan: ChanStructure,
  close: number,
  atr: number | null,
): DraftAssertion[] {
  const out: DraftAssertion[] = [];
  // 只取最近一个中枢：更早的中枢边界价格早已走过，留着只会稀释统计
  const zone = chan.pivots[chan.pivots.length - 1];
  if (!zone) return out;
  const edges: Array<['high' | 'low', number]> = [
    ['high', zone.high],
    ['low', zone.low],
  ];
  for (const [side, price] of edges) {
    if (!withinReach(price, close, atr)) continue;
    out.push({
      kind: 'level',
      source: 'chan',
      statement: `缠论中枢${side === 'high' ? '上沿' : '下沿'} ${fmt(price)}（${zone.startTime}~${zone.endTime}）`,
      price: r3(price),
      priceHigh: null,
      windowFrom: null,
      windowTo: null,
      direction: reactionDirection(price, close),
      evidenceRef: `chan:${chan.period}:zone:${zone.id}:${side}`,
    });
  }
  return out;
}

/** 道氏：最近一个已确认摆动高低点，是最朴素的支撑压力 */
export function fromDow(
  swings: Array<{ kind: 'high' | 'low'; price: number; time: string; confirmed: boolean }>,
  period: KlinePeriod,
  close: number,
  atr: number | null,
): DraftAssertion[] {
  const out: DraftAssertion[] = [];
  const confirmed = swings.filter((s) => s.confirmed);
  const lastHigh = [...confirmed].reverse().find((s) => s.kind === 'high');
  const lastLow = [...confirmed].reverse().find((s) => s.kind === 'low');
  for (const s of [lastHigh, lastLow]) {
    if (!s || !withinReach(s.price, close, atr)) continue;
    out.push({
      kind: 'level',
      source: 'dow',
      statement: `前${s.kind === 'high' ? '高' : '低'} ${fmt(s.price)}（${s.time}）`,
      price: r3(s.price),
      priceHigh: null,
      windowFrom: null,
      windowTo: null,
      /**
       * 方向必须按价位相对现价的位置定，不能按它当初是高点还是低点。
       *
       * `judgeLevel` 是用 direction 决定「往哪个方向算掉头」的：up 看触及后能不能向上走够，
       * down 看能不能向下走够。一个已经被跌破的前低，此刻在现价**上方**，是压力不是支撑，
       * 却因为 kind='low' 被写成 up，于是拿反了的测试去判它。
       * 实测 711 条道氏记录里有 115 条（16%）方向与实际位置相反。
       *
       * 这条与 fromLevels / fromChan / fromElliott 的处理本来就该一致——
       * 判定问的是「摸到这条线之后有没有掉头」，与这条线当初为什么被画出来无关。
       */
      direction: reactionDirection(s.price, close),
      evidenceRef: `dow:${period}:${s.kind}:${s.time}`,
    });
  }
  return out;
}

/** 同一价位被多个来源指向时各记各的：统计要的正是「哪个来源准」，合并就分不出来了 */
export function collectAssertions(input: {
  elliott: ElliottAnalysis | null;
  levels: PriceLevels | null;
  chan: ChanStructure | null;
  swings: Array<{ kind: 'high' | 'low'; price: number; time: string; confirmed: boolean }>;
  period: KlinePeriod;
  bars: KlineBar[];
}): DraftAssertion[] {
  const { elliott, levels, chan, swings, period } = input;
  const close = levels?.close ?? elliott?.close ?? 0;
  const atr = levels?.atr ?? null;
  const out: DraftAssertion[] = [];
  if (elliott) {
    out.push(...fromElliott(elliott, atr, 'minor'));
    // 大级别只出时间位。它的方向常与日线相反（实测 7 只标的里 5 只如此），
    // 是「见高点」的主要来源；价位不出，理由见 fromElliott 的 degree 注释
    out.push(...fromElliott(elliott, atr, 'major'));
  }
  if (levels) out.push(...fromLevels(levels));
  if (chan) out.push(...fromChan(chan, close, atr));
  out.push(...fromDow(swings, period, close, atr));
  // 同一 evidenceRef 只留一条：唯一索引会挡住重复，但提前去重能避免整批插入报错
  const seen = new Set<string>();
  return out.filter((a) => (seen.has(a.evidenceRef) ? false : (seen.add(a.evidenceRef), true)));
}
