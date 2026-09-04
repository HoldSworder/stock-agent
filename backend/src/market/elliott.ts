import type {
  ElliottAnalysis,
  ElliottLabel,
  ElliottLeg,
  ElliottPrimary,
  ElliottSubdivision,
  ElliottSubLeg,
  ElliottTarget,
  ElliottTimeProjection,
  ElliottWaveCount,
  KlineBar,
  KlinePeriod,
  SwingPoint,
} from '@stock-agent/shared';
import {
  ELLIOTT_MIN_TRUSTED_CONFIDENCE,
  elliottLevelName,
  elliottPassedWord,
} from '@stock-agent/shared';
import { dedupeAlternating, detectSwings } from '../symbolPlans/structure';

// 波浪理论计数（KlineDialog 波浪图层）。
//
// 边界（重要）：本模块只产出**展示层参考读数**。计数结果不接入交易计划候选目录
// （symbolPlans/candidateCatalog.ts）、不参与 SymbolTradePlan 的触发/失效判定、
// 不进统一阶段状态机。`标的技术交易规划Agent开发计划.md` R13 原本禁止波浪进入 DTO 与图层，
// 本次是有意放开到展示层，放开范围仅限于此——不要把这里的结论接进任何交易决策链路。
//
// 算法是纯确定性的：摆动点复用 symbolPlans/structure.ts 的 detectSwings（ZigZag 简化版，
// 带 confirmed 语义），在其上按艾略特三铁律做浪序标注，目标位用斐波那契投射，
// 时间窗按已完成同级浪的 bar 数外推。不含任何主观判断，同一份数据每次跑结果一致。

/** 一个参与计数的摆动点（在 bars 中的位置一并带上，供 bar 数与时间外推用） */
interface WavePoint {
  kind: 'high' | 'low';
  time: string;
  price: number;
  /** 在 bars 数组中的下标 */
  idx: number;
}

/** 计数所需的最少 K 线根数：低于此数摆动点太少，任何计数都是噪声 */
const MIN_BARS = 30;
/** 一套驱动浪最多 5 段，即 6 个摆动点 */
const MAX_LEGS = 5;
/** 时间外推的 bar 数上限，防止异常数据把日期推到几十年后 */
const MAX_PROJECT_BARS = 500;

/** 各周期的级别中文名 */
const DEGREE_LABEL: Record<KlinePeriod, string> = {
  month: '月线级',
  week: '周线级',
  day: '日线级',
  '120m': '120分钟级',
  '60m': '60分钟级',
  '30m': '30分钟级',
  '15m': '15分钟级',
  '5m': '5分钟级',
};

/** 当前周期的「大一级」周期；月线已是最大级别，无上级 */
const PARENT_PERIOD: Record<KlinePeriod, KlinePeriod | null> = {
  month: null,
  week: 'month',
  day: 'week',
  '120m': 'day',
  '60m': 'day',
  '30m': 'day',
  '15m': 'day',
  '5m': 'day',
};

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** 中位数（空数组返回 0） */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ===== 摆动点准备 =====

/**
 * 取已确认摆动点并补上 bar 下标。
 *
 * 必须先按 confirmed 过滤再重新交替去重：过滤会打断 detectSwings 保证的高低交替，
 * 而浪序标注完全依赖交替性（浪1 高点后必须是浪2 低点）。这与 computeDowStructure 同一处理。
 * 未确认的末点不进序列——它随时可能被新数据推翻，拿它当「某浪已走完」的依据会让浪序天天变。
 */
function toWavePoints(bars: KlineBar[], period: KlinePeriod): WavePoint[] {
  const idxOf = new Map<string, number>();
  bars.forEach((b, i) => idxOf.set(b.time, i));
  const confirmed = dedupeAlternating(
    detectSwings(bars, period).filter((s: SwingPoint) => s.confirmed),
  );
  const out: WavePoint[] = [];
  for (const s of confirmed) {
    const idx = idxOf.get(s.time);
    if (idx == null) continue;
    out.push({ kind: s.kind, time: s.time, price: s.price, idx });
  }
  return out;
}

// ===== 时间外推 =====

/** 取 'YYYY-MM-DD' 部分并锚到 UTC 零点，后续加减一律用 UTC，避免本地时区把日期挪一天 */
function parseDatePart(time: string): Date {
  return new Date(`${time.slice(0, 10)}T00:00:00Z`);
}

const fmtDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * 按交易日推进 n 天（跳周末）。
 * ponytail: 不查节假日表，长假会让实际日期比推算晚几天。天花板是国庆/春节前后误差最大约一周；
 * 要精确得接一份交易日历（系统里已有节假日 gate 可作数据源），但时间窗本就是估算区间，暂不值这个复杂度。
 */
function addTradingDays(from: Date, n: number): Date {
  const d = new Date(from);
  let left = Math.min(MAX_PROJECT_BARS, Math.max(0, Math.round(n)));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}

/** A 股全天分时点数，用于把分钟级 bar 数折算成天数 */
const MINUTES_PER_SESSION = 240;

/** 从最后一根 bar 的时间起，向后推 n 根同周期 bar，返回预计日期 */
function projectDate(lastTime: string, period: KlinePeriod, n: number): string {
  const base = parseDatePart(lastTime);
  const bars = Math.min(MAX_PROJECT_BARS, Math.max(0, Math.round(n)));
  if (period === 'month') {
    const d = new Date(base);
    d.setUTCMonth(d.getUTCMonth() + bars);
    return fmtDate(d);
  }
  if (period === 'week') {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + bars * 7);
    return fmtDate(d);
  }
  if (period === 'day') return fmtDate(addTradingDays(base, bars));
  // 分钟级：按每天 240 分钟折算成交易日，不足一天也算一天
  const minutes = Number(period.replace('m', '')) || 1;
  const perDay = Math.max(1, Math.floor(MINUTES_PER_SESSION / minutes));
  return fmtDate(addTradingDays(base, Math.ceil(bars / perDay)));
}

// ===== 斐波那契贴合度 =====

/** 各浪与前浪的理论比例，用于打「像不像波浪」的分 */
const CANON: Record<string, number[]> = {
  w2: [0.382, 0.5, 0.618, 0.786],
  w3: [1.618, 2.618],
  w4: [0.236, 0.382, 0.5],
  w5: [0.618, 1.0, 1.618],
};
/** 比例偏离超过这个幅度即判完全不贴合 */
const FIT_TOLERANCE = 0.6;

/** 单个比例的贴合分：取与最近理论值的距离，线性衰减到 0 */
function fitScore(actual: number, canon: number[]): number {
  if (!Number.isFinite(actual) || actual <= 0) return 0;
  const dev = Math.min(...canon.map((c) => Math.abs(actual - c)));
  return clamp01(1 - dev / FIT_TOLERANCE);
}

// ===== 浪序标注 =====

/** 一个候选计数在评分前的中间产物 */
interface Candidate {
  count: ElliottWaveCount;
  /** 锚点在摆动点序列中的下标，用于挑「与主计数不同锚点」的备选 */
  anchor: number;
}

/**
 * 浪的长度，取**对数尺度**（|ln(p1/p0)|）而非绝对价差。
 *
 * 这一点用真实数据验过才敢定：601127 从 173 跌到 52，按点数算「浪5 = 浪1 等长」
 * 会得到 7.5 元的目标，按 2.618 倍扩展甚至算出负价——绝对价差在大幅波动的标的上
 * 根本不是等价的「一样长」。改到对数空间后，「等长」变成「同样的涨跌幅」，
 * 目标价恒为正、比例也与价格水平无关，是行情图上通用的处理方式。
 */
function legLen(pts: WavePoint[], i: number): number {
  const a = pts[i].price;
  const b = pts[i + 1].price;
  if (!(a > 0) || !(b > 0)) return 0;
  return Math.abs(Math.log(b / a));
}

/** 从 base 沿 dir 方向按对数长度投射一个价位；恒为正 */
const project = (base: number, len: number, dir: number, ratio: number): number =>
  base * Math.exp(dir * len * ratio);

/**
 * 按一个锚点尝试标注驱动浪。
 *
 * pts[0] 是浪1 起点，其后每个摆动点结束一浪；最后一个摆动点之后到最新价是「进行中的一浪」。
 * 三铁律只在数据足够时校验（例如浪4 重叠要等浪4 走完才判得了），
 * 校验不到的不算通过也不算失败，只从分母里去掉——否则早期结构会被无谓地压低分。
 */
function labelImpulse(
  pts: WavePoint[],
  anchor: number,
  bars: KlineBar[],
  period: KlinePeriod,
): Candidate | null {
  const completed = Math.min(MAX_LEGS, pts.length - 1);
  if (completed < 1) return null;
  const direction: 'up' | 'down' = pts[0].kind === 'low' ? 'up' : 'down';
  const sign = direction === 'up' ? 1 : -1;
  const rationale: string[] = [];
  let applicable = 0;
  let satisfied = 0;

  // 铁律一：浪2 不得回撤破浪1 起点
  if (completed >= 2) {
    applicable += 1;
    const ok = sign > 0 ? pts[2].price > pts[0].price : pts[2].price < pts[0].price;
    if (ok) satisfied += 1;
    rationale.push(
      `铁律一 浪2 不破浪1 起点：浪2 终点 ${r3(pts[2].price)} vs 浪1 起点 ${r3(pts[0].price)} → ${ok ? '满足' : '违反'}`,
    );
  }
  // 铁律三：浪4 不得进入浪1 价格区间（先判，浪3 那条要等浪5）
  if (completed >= 4) {
    applicable += 1;
    const ok = sign > 0 ? pts[4].price > pts[1].price : pts[4].price < pts[1].price;
    if (ok) satisfied += 1;
    rationale.push(
      `铁律三 浪4 不进浪1 区间：浪4 终点 ${r3(pts[4].price)} vs 浪1 终点 ${r3(pts[1].price)} → ${ok ? '满足' : '违反'}`,
    );
  }
  // 铁律二：浪3 不是 1/3/5 中最短的一浪（须三浪齐全才判得了）
  if (completed >= 5) {
    applicable += 1;
    const l1 = legLen(pts, 0);
    const l3 = legLen(pts, 2);
    const l5 = legLen(pts, 4);
    const ok = !(l3 < l1 && l3 < l5);
    if (ok) satisfied += 1;
    rationale.push(
      `铁律二 浪3 非最短：浪1 ${r3(l1)} / 浪3 ${r3(l3)} / 浪5 ${r3(l5)} → ${ok ? '满足' : '违反'}`,
    );
  } else if (completed >= 3) {
    const l1 = legLen(pts, 0);
    const l3 = legLen(pts, 2);
    if (l3 < l1) rationale.push(`提示：浪3 幅度 ${r3(l3)} 目前小于浪1 ${r3(l1)}，若浪5 更长则本计数作废`);
  }

  // 有任何一条铁律被违反即不成立——这正是「宁可判不出，也不硬凑一个计数」
  if (applicable > 0 && satisfied < applicable) return null;

  const legs = buildLegs(pts, completed, LABELS_IMPULSE);
  // 5 浪走完后当前走的是调整 A 浪，状态随「当前这一浪」定，legs 仍保留 1-5 标号
  const currentLabel: ElliottLabel = completed >= MAX_LEGS ? 'A' : (String(completed + 1) as ElliottLabel);
  const state: ElliottWaveCount['state'] = completed >= MAX_LEGS ? 'corrective' : 'impulse';
  // 进行中那一浪的方向与它的序号奇偶相关：奇数浪顺势、偶数浪逆势
  const currentDirection = currentDirOf(currentLabel, direction);
  const currentLeg = buildCurrentLeg(pts, bars, currentLabel);
  if (currentLeg) legs.push(currentLeg);

  const fit = impulseFit(pts, completed);
  const confidence = score(satisfied, applicable, completed, fit);
  rationale.push(`斐波那契贴合度 ${r3(fit)}，已完成 ${completed} 浪`);

  const invalidationPrice = impulseInvalidation(pts, completed, currentLabel);
  const close = bars[bars.length - 1]?.close ?? 0;
  // 现价已经破了失效价 = 这套计数已经作废，与违反铁律同等对待，不能带着目标位继续输出
  if (isBreached(invalidationPrice, close, currentLabel, direction)) return null;
  const raw = impulseTargets(pts, completed, currentLabel, sign);
  let targets = dropSelfDefeating(raw, invalidationPrice, currentDirection, close);
  if (raw.length > 0 && targets.length === 0) {
    rationale.push(
      `理论回撤位已越过失效价 ${invalidationPrice}，走到即违反铁律，故不给目标位——` +
        '这本身说明当前这一浪已几乎没有回撤空间',
    );
  }
  // 置信度不够就不给目标位，且必须在这里砍掉而不是留给前端隐藏：
  // 底稿要同时喂给 LLM 解读，前端藏起来、模型照念出来会自相矛盾
  if (confidence < ELLIOTT_MIN_TRUSTED_CONFIDENCE && targets.length > 0) {
    targets = [];
    rationale.push(`把握不足（${confidence} 分，低于 ${ELLIOTT_MIN_TRUSTED_CONFIDENCE} 分），不给目标位`);
  }

  const timeProjections = buildTimeProjections(legs, currentLabel, bars, period);
  return {
    anchor,
    count: {
      period,
      degreeLabel: DEGREE_LABEL[period],
      state,
      currentLabel,
      currentDirection,
      legs,
      targets,
      invalidationPrice,
      timeWindow: projectWindow(legs, bars, period),
      timeProjections,
      primary: pickPrimary(
        targets,
        timeProjections,
        currentDirection,
        close,
        comparableBars(legs, currentLabel),
      ),
      // 细分要更细周期的 K 线，取数在 getElliottAnalysis 里，算完后回填
      subdivision: null,
      confidence,
      rationale,
    },
  };
}

const LABELS_IMPULSE: ElliottLabel[] = ['1', '2', '3', '4', '5'];
const LABELS_CORRECTIVE: ElliottLabel[] = ['A', 'B', 'C'];

/** 奇数浪与整体方向同向，偶数浪逆向；调整 A/C 逆向、B 顺向 */
function currentDirOf(label: ElliottLabel, impulseDir: 'up' | 'down'): 'up' | 'down' {
  const rev = impulseDir === 'up' ? 'down' : 'up';
  if (label === 'A' || label === 'C') return rev;
  if (label === 'B') return impulseDir;
  return Number(label) % 2 === 1 ? impulseDir : rev;
}

/** 已完成的各浪 */
function buildLegs(pts: WavePoint[], completed: number, labels: ElliottLabel[]): ElliottLeg[] {
  const out: ElliottLeg[] = [];
  for (let i = 0; i < completed; i += 1) {
    out.push({
      label: labels[i],
      fromTime: pts[i].time,
      fromPrice: r3(pts[i].price),
      toTime: pts[i + 1].time,
      toPrice: r3(pts[i + 1].price),
      bars: pts[i + 1].idx - pts[i].idx,
      completed: true,
    });
  }
  return out;
}

/** 进行中的一浪：从最后一个已确认摆动点到最新收盘 */
function buildCurrentLeg(
  pts: WavePoint[],
  bars: KlineBar[],
  label: ElliottLabel,
): ElliottLeg | null {
  const last = pts[pts.length - 1];
  const lastBar = bars[bars.length - 1];
  if (!last || !lastBar) return null;
  const lastIdx = bars.length - 1;
  if (lastIdx <= last.idx) return null;
  return {
    label,
    fromTime: last.time,
    fromPrice: r3(last.price),
    toTime: lastBar.time,
    toPrice: r3(lastBar.close),
    bars: lastIdx - last.idx,
    completed: false,
  };
}

/** 驱动浪的斐波那契贴合度：可测的比例各打一分再取均值，测不到时给中性 0.5 */
function impulseFit(pts: WavePoint[], completed: number): number {
  const l1 = completed >= 1 ? legLen(pts, 0) : 0;
  if (!(l1 > 0)) return 0.5;
  const scores: number[] = [];
  if (completed >= 2) scores.push(fitScore(legLen(pts, 1) / l1, CANON.w2));
  if (completed >= 3) scores.push(fitScore(legLen(pts, 2) / l1, CANON.w3));
  if (completed >= 4) {
    const l3 = legLen(pts, 2);
    if (l3 > 0) scores.push(fitScore(legLen(pts, 3) / l3, CANON.w4));
  }
  if (completed >= 5) scores.push(fitScore(legLen(pts, 4) / l1, CANON.w5));
  if (scores.length === 0) return 0.5;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * 置信度合成：铁律满足度占一半，结构完整度与斐波那契贴合度各占一部分。
 * 铁律测不到时给中性 0.5，不能算满分——「还没轮到校验」不等于「已经通过校验」。
 */
function score(satisfied: number, applicable: number, completed: number, fit: number): number {
  const iron = applicable === 0 ? 0.5 : satisfied / applicable;
  const completeness = Math.min(1, completed / MAX_LEGS);
  return Math.round((0.5 * iron + 0.2 * completeness + 0.3 * fit) * 100) / 100;
}

/** 当前浪的目标位。取不到理论依据的浪（如浪1）不给目标——凭空给一个价就是编 */
function impulseTargets(
  pts: WavePoint[],
  completed: number,
  current: ElliottLabel,
  sign: number,
): ElliottTarget[] {
  const mk = (ratio: number, from: number, len: number, dir: number, note: string): ElliottTarget => ({
    ratio: `${Math.round(ratio * 1000) / 10}%`,
    price: r3(project(from, len, dir, ratio)),
    note,
  });
  if (current === '2' && completed >= 1) {
    const l1 = legLen(pts, 0);
    return [0.5, 0.618].map((r) => mk(r, pts[1].price, l1, -sign, `浪2 回撤浪1 的 ${r * 100}%`));
  }
  if (current === '3' && completed >= 2) {
    const l1 = legLen(pts, 0);
    return [1.618, 2.618].map((r) => mk(r, pts[2].price, l1, sign, `浪3 = 浪1 长度的 ${r} 倍，自浪2 终点起算`));
  }
  if (current === '4' && completed >= 3) {
    const l3 = legLen(pts, 2);
    return [0.382, 0.5].map((r) => mk(r, pts[3].price, l3, -sign, `浪4 回撤浪3 的 ${r * 100}%`));
  }
  if (current === '5' && completed >= 4) {
    const l1 = legLen(pts, 0);
    return [0.618, 1.0].map((r) => mk(r, pts[4].price, l1, sign, `浪5 = 浪1 长度的 ${r} 倍，自浪4 终点起算`));
  }
  if (current === 'A' && completed >= 5) {
    const whole = pts[0].price > 0 && pts[5].price > 0 ? Math.abs(Math.log(pts[5].price / pts[0].price)) : 0;
    return [0.382, 0.618].map((r) => mk(r, pts[5].price, whole, -sign, `调整 A 浪回撤整个 1-5 浪的 ${r * 100}%`));
  }
  return [];
}

/**
 * 现价是否已经跌破/涨破这套计数的失效价。
 *
 * 铁律只看已完成的摆动点，看不到「浪还在走、但价格已经走到不该去的地方」：
 * 601127 日线曾据此输出一套上行浪4 计数，失效价（浪1 顶）57.92，而现价 51.84 早已跌穿——
 * 铁律三要等浪4 走完才校验得到，于是一套已经死掉的计数照样带着目标位输出。
 * 失效价既然是「破了就作废」，就必须拿现价对它判一次，而不是只在图上画条线让用户自己比。
 */
function isBreached(
  invalidation: number | null,
  close: number,
  current: ElliottLabel,
  impulseDir: 'up' | 'down',
): boolean {
  if (invalidation == null || !(close > 0)) return false;
  const up = impulseDir === 'up';
  // A 浪的失效价是浪5 极值：顺势越过它说明 5 浪压根没走完，这套「已完成 5 浪」的判断就是错的
  if (current === 'A') return up ? close > invalidation : close < invalidation;
  // 1-5 浪的失效价一律在逆势一侧，逆势越过即结构破坏
  return up ? close < invalidation : close > invalidation;
}

/**
 * 剔除「走到就已经把这套计数证伪」的目标位。
 *
 * 浪2、浪4 这类回撤浪是朝着自己的失效价走的：601127 日线浪4 的 38.2%/50% 回撤位算出来是
 * 58.7 / 59.8，而浪4 的失效价（浪1 终点）是 57.92——照这个目标走过去，铁律三先被破了。
 * 同时报出「目标」和「到不了这个目标」是自相矛盾的，宁可不给目标。
 * 浪3、浪5、A 浪的失效价在身后（背离行进方向），不受此规则影响。
 */
function dropSelfDefeating(
  targets: ElliottTarget[],
  invalidation: number | null,
  direction: 'up' | 'down' | null,
  close: number,
): ElliottTarget[] {
  const alive = targets.filter((t) => Number.isFinite(t.price) && t.price > 0);
  if (invalidation == null || !direction || !(close > 0)) return alive;
  // 失效价在身后就不构成约束
  const guardAhead = direction === 'up' ? invalidation > close : invalidation < close;
  if (!guardAhead) return alive;
  return alive.filter((t) => (direction === 'up' ? t.price < invalidation : t.price > invalidation));
}

/** 当前浪的失效价：破了它这套计数就不成立 */
function impulseInvalidation(
  pts: WavePoint[],
  completed: number,
  current: ElliottLabel,
): number | null {
  if (current === '2' && completed >= 1) return r3(pts[0].price);
  if (current === '3' && completed >= 2) return r3(pts[2].price);
  // 浪4 的边界正是浪1 终点：进入浪1 区间即违反铁律三
  if (current === '4' && completed >= 3) return r3(pts[1].price);
  if (current === '5' && completed >= 4) return r3(pts[4].price);
  if (current === 'A' && completed >= 5) return r3(pts[5].price);
  return null;
}

// ===== 斐波那契时间投射 =====

/** 时间比例：一浪走多久，常与「可比前浪」的时长成斐波那契比例 */
const FIB_TIME = [0.382, 0.618, 1.0, 1.618] as const;

/**
 * 当前浪的「可比前浪」bar 数——时间投射的基准。
 *
 * 取哪一浪不是随手定的，遵循波浪理论里成对的时间关系：
 * 回撤浪比照它回撤的那一浪，推进浪比照浪1，A 浪比照它所回撤的整段 1-5，
 * B/C 浪比照 A 浪。取不到基准（如浪1 本身，前面没有可比对象）时返回 null，不硬凑。
 */
function comparableBars(
  legs: ElliottLeg[],
  current: ElliottLabel,
): { bars: number; ref: string } | null {
  const done = legs.filter((l) => l.completed);
  const at = (i: number): ElliottLeg | undefined => done[i];
  const pick = (i: number, ref: string): { bars: number; ref: string } | null => {
    const l = at(i);
    return l && l.bars > 0 ? { bars: l.bars, ref } : null;
  };
  switch (current) {
    case '2':
    case '3':
    case '5':
      return pick(0, '浪1');
    case '4':
      return pick(1, '浪2');
    case 'A': {
      // A 浪回撤的是整段 1-5，比照对象自然是这一整段的时长
      const total = done.slice(0, 5).reduce((s, l) => s + l.bars, 0);
      return total > 0 ? { bars: total, ref: '整段 1-5 浪' } : null;
    }
    case 'B':
    case 'C':
      return pick(0, 'A 浪');
    default:
      return null;
  }
}

/**
 * 斐波那契时间位：从当前浪起点起算，投射 {38.2%, 61.8%, 100%, 161.8%} × 可比前浪 bar 数。
 *
 * 已经走过的时间位直接取那根 bar 的真实日期（精确，不用倒推），
 * 未到的才用 projectDate 外推。两者都返回，让「浅档时间已过、下一档在哪天」一眼可见。
 */
function buildTimeProjections(
  legs: ElliottLeg[],
  current: ElliottLabel | null,
  bars: KlineBar[],
  period: KlinePeriod,
): ElliottTimeProjection[] {
  const running = legs.find((l) => !l.completed);
  const lastBar = bars[bars.length - 1];
  if (!running || !current || !lastBar) return [];
  const base = comparableBars(legs, current);
  if (!base) return [];
  const startIdx = bars.length - 1 - running.bars;
  if (startIdx < 0) return [];
  const out: ElliottTimeProjection[] = [];
  for (const r of FIB_TIME) {
    const n = Math.round(base.bars * r);
    if (n <= 0) continue;
    // 可比前浪很短时（几根 bar），相邻比例会四舍五入到同一根，投出两个日期相同的时间位。
    // 只保留最早触及该根的那个比例，否则界面上会出现「38.2% 和 61.8% 是同一天」这种废话。
    if (out.length > 0 && out[out.length - 1].bars === n) continue;
    const idx = startIdx + n;
    const reached = idx <= bars.length - 1;
    out.push({
      ratio: `${Math.round(r * 1000) / 10}%`,
      date: reached
        ? bars[idx].time.slice(0, 10)
        : projectDate(lastBar.time, period, idx - (bars.length - 1)),
      bars: n,
      reached,
    });
  }
  return out;
}

/**
 * 首选参考：沿当前浪行进方向「下一个尚未到达」的价位与时间位。
 *
 * 刻意不主张「哪一档最可能」——那需要一个我们给不出的概率模型。
 * 「下一个未到达」是可辩护的：价格与时间都必须先经过它，因此它是最先要面对的那个数字。
 * 全部到达时退回最远一档并在 note 里说明，不留空。
 */
function pickPrimary(
  targets: ElliottTarget[],
  projections: ElliottTimeProjection[],
  direction: 'up' | 'down' | null,
  close: number,
  base: { bars: number; ref: string } | null,
): ElliottPrimary | null {
  if (targets.length === 0) return null;
  const up = direction === 'up';
  const sorted = [...targets].sort((a, b) => (up ? a.price - b.price : b.price - a.price));
  const unreachedPrice = sorted.find((t) => !(close > 0 && (up ? close >= t.price : close <= t.price)));
  const price = unreachedPrice ?? sorted[sorted.length - 1];
  const time = projections.find((p) => !p.reached) ?? null;
  const parts = [
    unreachedPrice ? '沿当前浪方向下一个尚未走过的档位' : '各档位均已走过，取最远一档',
  ];
  if (time && base) parts.push(`时间位按${base.ref} ${base.bars} 根 × ${time.ratio} 投射`);
  else if (projections.length > 0) parts.push('斐波那契时间位均已走过，未给预计日期');
  else parts.push('无可比前浪，未给预计日期');
  return {
    price: price?.price ?? null,
    ratio: price?.ratio ?? null,
    date: time?.date ?? null,
    note: parts.join('；'),
  };
}

/**
 * 当前浪预计走完的时间窗：拿已完成同级浪的 bar 数中位数当「一浪该走多久」，
 * 减去已经走掉的根数得到剩余，再给出 0.6~1.6 倍的区间——单点日期会给人一种它算得准的错觉。
 */
function projectWindow(
  legs: ElliottLeg[],
  bars: KlineBar[],
  period: KlinePeriod,
): ElliottWaveCount['timeWindow'] {
  const current = legs.find((l) => !l.completed);
  const done = legs.filter((l) => l.completed);
  const lastBar = bars[bars.length - 1];
  if (!current || done.length === 0 || !lastBar) return null;
  const typical = median(done.map((l) => l.bars));
  if (!(typical > 0)) return null;
  const remain = Math.max(1, typical - current.bars);
  return {
    fromDate: projectDate(lastBar.time, period, remain * 0.6),
    toDate: projectDate(lastBar.time, period, remain * 1.6),
    bars: Math.round(remain),
  };
}

/**
 * 调整浪兜底：驱动浪的铁律一条都过不了时，按最近两段已完成浪当 A、B，进行中的当 C。
 * 只标 A-B-C 不标更复杂的调整形态（三角形、平台、联合），
 * 因为再细分就得引入主观判断，而这里的定位是确定性读数。
 */
function labelCorrective(
  pts: WavePoint[],
  anchor: number,
  bars: KlineBar[],
  period: KlinePeriod,
): Candidate | null {
  if (pts.length < 3) return null;
  // A 浪方向即 C 浪方向：pts[0] 是高点则 A 向下
  const signA = pts[0].kind === 'high' ? -1 : 1;
  const close = bars[bars.length - 1]?.close ?? 0;
  // 现价已越过 A 浪起点（逆 A 方向）说明这不是简单的 A-B-C 调整，别硬套
  if (close > 0 && (signA > 0 ? close < pts[0].price : close > pts[0].price)) return null;
  const legs = buildLegs(pts, 2, LABELS_CORRECTIVE);
  const currentLeg = buildCurrentLeg(pts, bars, 'C');
  if (currentLeg) legs.push(currentLeg);
  const lenA = legLen(pts, 0);
  const fit = lenA > 0 ? fitScore(legLen(pts, 1) / lenA, [0.5, 0.618, 0.786]) : 0.5;
  const confidence = score(0, 0, 2, fit);
  // 与驱动浪同一条规矩：置信度不够就不给目标位，前后端与 LLM 底稿共用这一份判断
  const trusted = confidence >= ELLIOTT_MIN_TRUSTED_CONFIDENCE;
  const targets: ElliottTarget[] =
    lenA > 0 && trusted
      ? [1.0, 1.618]
          .map((r) => ({
            ratio: `${Math.round(r * 1000) / 10}%`,
            price: r3(project(pts[2].price, lenA, signA, r)),
            note: `C 浪 = A 浪长度的 ${r} 倍，自 B 浪终点起算`,
          }))
          .filter((t) => Number.isFinite(t.price) && t.price > 0)
      : [];
  const correctiveProjections = buildTimeProjections(legs, 'C', bars, period);
  return {
    anchor,
    count: {
      period,
      degreeLabel: DEGREE_LABEL[period],
      state: 'corrective',
      currentLabel: 'C',
      currentDirection: signA > 0 ? 'up' : 'down',
      legs,
      targets,
      // 标准锯齿形中 B 浪不应越过 A 浪起点，越过即说明这不是简单调整
      invalidationPrice: r3(pts[0].price),
      timeWindow: projectWindow(legs, bars, period),
      timeProjections: correctiveProjections,
      primary: pickPrimary(
        targets,
        correctiveProjections,
        signA > 0 ? 'up' : 'down',
        close,
        comparableBars(legs, 'C'),
      ),
      subdivision: null,
      confidence,
      rationale: [
        '驱动浪三铁律无法全部满足，退化按 A-B-C 调整浪标注',
        `B 浪回撤 A 浪 ${lenA > 0 ? Math.round((legLen(pts, 1) / lenA) * 1000) / 10 : '—'}%，贴合度 ${r3(fit)}`,
        ...(trusted
          ? []
          : [`把握不足（${confidence} 分，低于 ${ELLIOTT_MIN_TRUSTED_CONFIDENCE} 分），不给目标位`]),
      ],
    },
  };
}

/** 数据不足或结构不清晰时的空计数（不硬凑一个浪序） */
function unclearCount(period: KlinePeriod, reason: string): ElliottWaveCount {
  return {
    period,
    degreeLabel: DEGREE_LABEL[period],
    state: 'unclear',
    currentLabel: null,
    currentDirection: null,
    legs: [],
    targets: [],
    invalidationPrice: null,
    timeWindow: null,
    timeProjections: [],
    primary: null,
    subdivision: null,
    confidence: 0,
    rationale: [reason],
  };
}

// ===== 单周期计数入口 =====

/**
 * 在单个周期上给出主计数与备选计数。
 *
 * 锚点候选是「让计数一直延伸到最后一个已确认摆动点」的那几个起点：起点越靠前，已完成的浪越多。
 * 同一段走势按不同起点数出来的浪序本就都是合法解释，故取分最高的当主计数、次高且锚点不同的当备选，
 * 把「可能数错了」这件事显式摆到界面上，而不是假装只有一个答案。
 */
export function countWaves(
  bars: KlineBar[],
  period: KlinePeriod,
): { main: ElliottWaveCount; alternate: ElliottWaveCount | null } {
  if (bars.length < MIN_BARS) {
    return { main: unclearCount(period, `K 线仅 ${bars.length} 根，不足 ${MIN_BARS} 根，无法计数`), alternate: null };
  }
  const pts = toWavePoints(bars, period);
  const n = pts.length;
  if (n < 3) {
    return { main: unclearCount(period, `已确认摆动点仅 ${n} 个，不足以标注浪序`), alternate: null };
  }

  const cands: Candidate[] = [];
  // 锚点从「能凑满 5 浪」一直试到「只有 1 浪已完成」
  for (let i = Math.max(0, n - (MAX_LEGS + 1)); i <= n - 2; i += 1) {
    const c = labelImpulse(pts.slice(i), i, bars, period);
    if (c) cands.push(c);
  }
  if (cands.length === 0) {
    const corrective = labelCorrective(pts.slice(n - 3), n - 3, bars, period);
    return {
      main: corrective?.count ?? unclearCount(period, '驱动浪与调整浪均无法成立，当前结构不清晰'),
      alternate: null,
    };
  }
  cands.sort((a, b) => b.count.confidence - a.count.confidence);
  const main = cands[0];
  const alt = cands.find((c) => c.anchor !== main.anchor) ?? null;
  return { main: main.count, alternate: alt?.count ?? null };
}

// ===== 子浪细分 =====

/**
 * 细分周期阶梯：父周期 → 候选子周期及其「一根父 bar 约合多少根子 bar」。
 * 倍数是 A 股交易时段的固定换算（全天 240 分钟、一周 5 个交易日、一月约 21 个交易日），
 * 用来在取数**之前**估算够不够，避免为了挑周期先白拉一次线。
 */
const SUB_LADDER: Record<KlinePeriod, Array<{ period: KlinePeriod; mult: number }>> = {
  month: [
    { period: 'week', mult: 4 },
    { period: 'day', mult: 21 },
  ],
  week: [
    { period: 'day', mult: 5 },
    { period: '60m', mult: 20 },
  ],
  day: [
    { period: '120m', mult: 2 },
    { period: '60m', mult: 4 },
    { period: '30m', mult: 8 },
    { period: '15m', mult: 16 },
  ],
  '120m': [
    { period: '30m', mult: 4 },
    { period: '15m', mult: 8 },
    { period: '5m', mult: 24 },
  ],
  '60m': [
    { period: '15m', mult: 4 },
    { period: '5m', mult: 12 },
  ],
  '30m': [{ period: '5m', mult: 6 }],
  '15m': [{ period: '5m', mult: 3 }],
  '5m': [],
};

/**
 * 细分的目标子 bar 数区间。
 *
 * 下限 40 是 detectSwings 能稳定给出三四个摆动点的量；上限 120 同样重要——
 * 实测把一条 14 天的日线浪切成 88 根 30m，日内两小时的抖动幅度就压过了中途的真实回调，
 * 削出来的 a-b-c 变成「第一段吃掉整条浪、后两段是当天的日内噪声」。挑最粗的够用周期最省事。
 */
const MIN_SUB_BARS = 40;
const MAX_SUB_BARS = 120;

/**
 * 子摆动的显著性门槛：一段子浪至少要回撤父浪总幅度的这个比例才算数。
 * 与周期无关、按比例衡量，是把日内噪声挡在外面的那道闸——只靠「挑粗一点的周期」挡不干净。
 */
const MIN_SUB_RETRACE = 0.15;

/** 该周期下细分进行中那一浪该用哪个子周期、取多少根（取不到合适的返回 null） */
export function pickSubPeriod(
  period: KlinePeriod,
  legBars: number,
): { period: KlinePeriod; limit: number } | null {
  if (legBars <= 0) return null;
  const ladder = SUB_LADDER[period] ?? [];
  // 优先取落在区间里的最粗周期；都不落区间时退而求其次挑第一个到得了下限的
  const hit =
    ladder.find((c) => legBars * c.mult >= MIN_SUB_BARS && legBars * c.mult <= MAX_SUB_BARS) ??
    ladder.find((c) => legBars * c.mult >= MIN_SUB_BARS);
  if (!hit) return null;
  // 多取一截余量：detectSwings 需要左窗口，切口处的摆动点否则确认不了
  return { period: hit.period, limit: Math.min(800, Math.ceil(legBars * hit.mult) + 80) };
}

/** 驱动浪在下一级细分成 5 段，调整浪细分成 3 段——相邻级别的交替性 */
const isMotiveLabel = (l: ElliottLabel): boolean => l === '1' || l === '3' || l === '5';
const SUB_LABELS_MOTIVE = ['1', '2', '3', '4', '5'] as const;
const SUB_LABELS_CORRECTIVE = ['a', 'b', 'c'] as const;

/**
 * 削减摆动点：先按显著性门槛剔噪声，再按段数上限收到目标段数。起点锚点始终保留。
 *
 * 细分不能直接套 countWaves：它的锚点是贴着最新一根浮动的，只标最近那几段。
 * 实测 159516 的 B 浪从 8/04 起，countWaves 却只数出 8/14 之后的三段，前十天整段丢掉——
 * 而「当前处于这一浪的哪个阶段」恰恰要求细分覆盖整条浪。
 *
 * 两道削减缺一不可：只按段数削，日内两小时的抖动会因为幅度恰好最大而留下来，
 * 把整条浪挤成一段；只按门槛削，遇到结构复杂的浪又会剩下十几段没法标号。
 *
 * 每次成对删除相邻两点：删一个会破坏高低交替，删相邻两个则天然保持。
 * 允许删到最后一对（i 可取到 length-2），否则末端的噪声摆动永远赖着不走，
 * 进行中那段子浪就会从一个没有意义的位置起算。
 */
function reduceSwings(points: WavePoint[], max: number, minAmp: number): WavePoint[] {
  let pts = points;
  while (pts.length >= 2) {
    let bestIdx = -1;
    let bestAmp = Infinity;
    // i 从 1 起：起点锚点不参与删除，它标定了父浪的起始位置
    for (let i = 1; i <= pts.length - 2; i += 1) {
      const a = pts[i].price;
      const b = pts[i + 1].price;
      if (!(a > 0) || !(b > 0)) continue;
      const amp = Math.abs(Math.log(b / a));
      if (amp < bestAmp) {
        bestAmp = amp;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    if (pts.length <= max && bestAmp >= minAmp) break;
    pts = [...pts.slice(0, bestIdx), ...pts.slice(bestIdx + 2)];
  }
  return pts;
}

/**
 * 细分进行中的那一浪：在它的日期区间内用更细周期找摆动点并顺次标号。
 *
 * 只细分进行中那一段——已经走完的浪细分出来只是复盘，而「现在处于这一浪的哪个位置」
 * 才是能指导操作的信息。父浪字母由调用方给（同一段走势在两种读法下前缀不同）。
 * 目标段数按父浪性质定：父浪是驱动浪就找 5 段，是调整浪就找 3 段。
 */
function buildSubdivision(
  running: ElliottLeg,
  subBars: KlineBar[],
  subPeriod: KlinePeriod,
  parentLabel: ElliottLabel,
): ElliottSubdivision | null {
  // 只保留落在这一浪区间内的子 bar。上界同样要钳：两条序列各自取数、新鲜度并不同步，
  // 盘中实测出现过日线还停在昨天、60m 已经有今天的 bar，细分于是画到了父浪终点之外。
  // 父浪终点带时分（分钟级父浪）时按完整时间戳比，否则按日期比——后者要保留当天的日内 bar。
  const upper = running.toTime;
  const withinUpper =
    upper.length > 10
      ? (t: string): boolean => t <= upper
      : (t: string): boolean => t.slice(0, 10) <= upper;
  const seg = subBars.filter((b) => b.time >= running.fromTime && withinUpper(b.time));
  if (seg.length < MIN_BARS) return null;
  // 取到的子 bar 够不到父浪起点时必须放弃：否则细分会从半途开始，
  // 却仍以「这一浪的内部结构」示人——实测周线父浪从 3/27 起、60m 只回溯到 7/03 就撞过这个坑
  if (seg[0].time.slice(0, 10) > running.fromTime.slice(0, 10)) return null;
  const motive = isMotiveLabel(parentLabel);
  const labels = motive ? SUB_LABELS_MOTIVE : SUB_LABELS_CORRECTIVE;
  const up = running.toPrice > running.fromPrice;

  // 用父浪起点做第一个锚点：detectSwings 的左窗口决定了开头几根出不了摆动点，
  // 不显式补锚的话细分永远从浪的中段开始，正是上面注释里说的那个 bug。
  const anchor: WavePoint = {
    kind: up ? 'low' : 'high',
    time: running.fromTime,
    price: running.fromPrice,
    idx: 0,
  };
  const detected = toWavePoints(seg, subPeriod).filter((p) => p.time > running.fromTime);
  // 开头与锚点同类的点要丢掉，否则序列不交替，浪序无从标起
  while (detected.length > 0 && detected[0].kind === anchor.kind) detected.shift();
  // 显著性门槛按父浪自身幅度折算：涨了 30% 的浪里，2% 的回头不算一段子浪
  const parentAmp =
    running.fromPrice > 0 && running.toPrice > 0
      ? Math.abs(Math.log(running.toPrice / running.fromPrice))
      : 0;
  // 目标点数 = 已完成子浪数 + 1（最后一段是进行中的，不占摆动点）
  const pts = reduceSwings([anchor, ...detected], labels.length, parentAmp * MIN_SUB_RETRACE);
  if (pts.length < 1) return null;

  // 数字父浪 + 数字子浪必须加分隔符：浪5 的第 1 子浪写成 '51' 会被读成「五十一」。
  // 字母那侧没有歧义（Ba / B1 / 2a 都读得通），不必一律加，免得标签平白变长
  const sub = (i: number): string =>
    `${parentLabel}${/^\d$/.test(parentLabel) && /^\d$/.test(labels[i]) ? '-' : ''}${labels[i]}`;

  const legs: ElliottSubLeg[] = [];
  for (let i = 0; i < pts.length - 1 && i < labels.length; i += 1) {
    legs.push({
      label: sub(i),
      fromTime: pts[i].time,
      fromPrice: r3(pts[i].price),
      toTime: pts[i + 1].time,
      toPrice: r3(pts[i + 1].price),
      bars: pts[i + 1].idx - pts[i].idx,
      completed: true,
    });
  }
  // 最后一个摆动点之后到最新价即进行中的子浪
  const lastPt = pts[pts.length - 1];
  const lastBar = seg[seg.length - 1];
  if (legs.length < labels.length && lastBar && seg.length - 1 > lastPt.idx) {
    legs.push({
      label: sub(legs.length),
      fromTime: lastPt.time,
      fromPrice: r3(lastPt.price),
      // 终点对齐父浪终点而不是子序列的末根：两条序列新鲜度不同步时，
      // 子序列可能比父级少一根，界面上就会出现「父浪走到 0.766、子浪却走到 0.770」这种对不上的数
      toTime: running.toTime,
      toPrice: running.toPrice,
      bars: seg.length - 1 - lastPt.idx,
      completed: false,
    });
  }
  if (legs.length === 0) return null;
  const current = legs.find((l) => !l.completed) ?? null;
  return {
    period: subPeriod,
    parentLabel,
    legs,
    currentLabel: current?.label ?? null,
    note:
      `按 ${DEGREE_LABEL[subPeriod]} 在 ${parentLabel} 浪区间内细分（${seg.length} 根，` +
      `${parentLabel} 浪为${motive ? '驱动浪，按 5 段' : '调整浪，按 3 段'}找）；` +
      '子浪级别更低、更易被后续走势改写，只作当前位置参考',
  };
}

// ===== 高一度重标读法 =====

/** 大级别当前浪是不是调整浪——决定小级别该按 1-5 还是 A-B-C 读 */
function isCorrectiveWave(label: ElliottLabel | null): boolean {
  return label === '2' || label === '4' || label === 'A' || label === 'B' || label === 'C';
}

/**
 * 高一度重标：把 minor 整段 5 浪视作高一级的 A 浪、进行中那段视作 B 浪。
 *
 * 为什么需要这一份：驱动浪与调整浪在相邻级别是交替的——大级别若正走调整浪（2/4/A/B/C），
 * 它在小级别只能细分成 A-B-C，不可能细分成 1-2-3-4-5。而 buildAnalysis 有意让两层独立计数、
 * 不做跨层校验，于是会出现「周线说在走浪2 调整、日线却按驱动浪数出 1-5」这种自相矛盾。
 * 这份重标就是把同一段走势按大级别语境换个称呼摆出来，两种读法并列由用户自己取舍。
 *
 * 关键：两种读法的**价位完全相同**（锚点与量度区间一样），分歧在这一浪之后——
 * minor 叫 A 浪意味着后面还有 B 跌 C 涨，本读法叫 B 浪则意味着后面直接 C 跌创新低。
 */
function buildContextualCount(
  minor: ElliottWaveCount,
  major: ElliottWaveCount | null,
  bars: KlineBar[],
  period: KlinePeriod,
): ElliottWaveCount | null {
  const done = minor.legs.filter((l) => l.completed);
  const running = minor.legs.find((l) => !l.completed);
  // A-B-C 兜底计数再抬一度没有确定性依据；驱动浪计数才谈得上「整段视作 A 浪」
  if (minor.state === 'unclear' || done.length === 0 || !running) return null;
  if (minor.currentLabel === 'C') return null;

  const degreeLabel = `${DEGREE_LABEL[period]}·高一度`;
  const context = major
    ? major.state === 'unclear'
      ? '大级别结构不清晰，此读法缺少语境支持'
      : `大级别当前为${major.degreeLabel}第 ${major.currentLabel} 浪（${isCorrectiveWave(major.currentLabel) ? '调整浪，下一级只能细分为 A-B-C，本读法与之相符' : '驱动浪，下一级应细分为 1-5，本读法与之不符，仅作并列参考'}）`
    : '无大级别可参照，此读法缺少语境支持';

  // 5 浪未走完：高一度的 A 浪本身还在进行，谈不上 B 浪，更给不出 B 的目标位
  if (done.length < MAX_LEGS) {
    const spanBars = done.reduce((s, l) => s + l.bars, 0) + running.bars;
    return {
      period,
      degreeLabel,
      state: 'corrective',
      currentLabel: 'A',
      currentDirection: minor.legs[0].toPrice > minor.legs[0].fromPrice ? 'up' : 'down',
      legs: [
        {
          label: 'A',
          fromTime: done[0].fromTime,
          fromPrice: done[0].fromPrice,
          toTime: running.toTime,
          toPrice: running.toPrice,
          bars: spanBars,
          completed: false,
        },
      ],
      targets: [],
      invalidationPrice: null,
      timeWindow: null,
      timeProjections: [],
      primary: null,
      subdivision: null,
      confidence: minor.confidence,
      rationale: [
        `高一度读法：整段视作 A 浪，目前仍在 A 浪内部（走到第 ${minor.currentLabel} 浪），未进入 B 浪`,
        context,
      ],
    };
  }

  // 5 浪已完成：整段折叠成 A，进行中那段即 B
  const legA: ElliottLeg = {
    label: 'A',
    fromTime: done[0].fromTime,
    fromPrice: done[0].fromPrice,
    toTime: done[4].toTime,
    toPrice: done[4].toPrice,
    bars: done.slice(0, 5).reduce((s, l) => s + l.bars, 0),
    completed: true,
  };
  const legB: ElliottLeg = { ...running, label: 'B' };
  const legs = [legA, legB];
  const aDown = legA.toPrice < legA.fromPrice;
  const currentDirection: 'up' | 'down' = aDown ? 'up' : 'down';
  const close = bars[bars.length - 1]?.close ?? 0;
  // B 浪不应越过 A 浪起点：越过说明这不是一段简单的 A-B-C 调整，本读法作废。
  // 注意这与 minor 的失效价（A 浪终点）是两回事——价格回到 A 浪终点只是 B 浪走完转 C，不是证伪。
  const invalidationPrice = legA.fromPrice;
  const breached = aDown ? close > invalidationPrice : close < invalidationPrice;
  if (breached) return null;

  // 目标位与 minor 完全同源（同一锚点、同一量度区间），只把口径文案改成 B 回撤 A
  const targets: ElliottTarget[] = minor.targets.map((t) => ({
    ...t,
    note: `B 浪回撤 A 浪的 ${t.ratio}（A 浪即左侧整段 5 浪）`,
  }));
  const timeProjections = buildTimeProjections(legs, 'B', bars, period);
  return {
    period,
    degreeLabel,
    state: 'corrective',
    currentLabel: 'B',
    currentDirection,
    legs,
    targets,
    invalidationPrice,
    // 必须按自己的 legs 重算，不能借用 minor 的：minor 的时间窗取的是 5 段小浪的 bar 中位数（这里是 4 根），
    // 而 B 浪的可比对象是 24 根的 A 浪。借用会让界面对 B 浪报出「还需约 1 根」这种差一个数量级的数。
    timeWindow: projectWindow(legs, bars, period),
    timeProjections,
    primary: pickPrimary(targets, timeProjections, currentDirection, close, comparableBars(legs, 'B')),
    subdivision: null,
    confidence: minor.confidence,
    rationale: [
      `高一度读法：左侧整段 5 浪（${legA.fromTime} ${legA.fromPrice} → ${legA.toTime} ${legA.toPrice}）视作 A 浪，当前反向段即 B 浪`,
      context,
      `价位与「${DEGREE_LABEL[period]}」那套完全相同，分歧在本浪之后：叫 A 浪则后面还有 B 跌 C 涨，叫 B 浪则后面直接走 C、有创新${aDown ? '低' : '高'}的含义`,
      `失效价 ${invalidationPrice}（B 浪越过 A 浪起点即作废）；价格回到 ${legA.toPrice} 只表示 B 浪结束转 C，不是证伪`,
    ],
  };
}

// ===== 多周期组装 =====

/** 一套计数的一句话描述 */
function describe(c: ElliottWaveCount | null): string {
  if (!c || c.state === 'unclear') return c ? `${c.degreeLabel}结构不清晰` : '';
  if (!c.currentLabel) return `${c.degreeLabel}结构不清晰`;
  const isLetter = /[ABC]/.test(c.currentLabel);
  const dir = c.currentDirection === 'up' ? '上行' : '回落';
  return isLetter
    ? `${c.degreeLabel}调整 ${c.currentLabel} 浪${dir}中`
    : `${c.degreeLabel}第 ${c.currentLabel} 浪${dir}中`;
}

/** 两层独立计数拼成一句结论 */
function buildSummary(major: ElliottWaveCount | null, minor: ElliottWaveCount | null): string {
  const a = describe(major);
  const b = describe(minor);
  if (a && b) return `${a}，其中 ${b}`;
  return a || b || '数据不足，无法给出波浪计数';
}

/**
 * 组装多周期波浪分析。两层各自独立跑同一套 countWaves，不做跨层校验——
 * 严格要求小级别浪序嵌进大级别浪序，会让绝大多数真实标的直接判 unclear，
 * 参考价值反而归零。代价是两层结论偶尔会互相矛盾，这一点由 note 显式说明。
 */
export function buildAnalysis(
  code: string,
  minorBars: KlineBar[],
  minorPeriod: KlinePeriod,
  majorBars: KlineBar[] | null,
  majorPeriod: KlinePeriod | null,
  sub?: { period: KlinePeriod; bars: KlineBar[] } | null,
): ElliottAnalysis {
  const last = minorBars[minorBars.length - 1];
  const minorRes = countWaves(minorBars, minorPeriod);
  const majorCount =
    majorPeriod && majorBars && majorBars.length > 0 ? countWaves(majorBars, majorPeriod).main : null;
  const minor = minorRes.main;
  const contextual = buildContextualCount(minor, majorCount, minorBars, minorPeriod);

  // 细分只算一次：两种读法说的是同一段物理走势，差别只在浪标前缀
  const running = minor.legs.find((l) => !l.completed);
  if (sub && sub.bars.length > 0 && running) {
    minor.subdivision = buildSubdivision(running, sub.bars, sub.period, minor.currentLabel ?? 'A');
    // 只有高级别读法走到 B 浪时，它的进行中段才与 minor 的是同一段；
    // 「A 浪仍在进行」那个降级分支里 A 浪横跨 minor 的好几段浪，
    // 子周期是按 minor 的段长取的、盖不住它，而且它的内部结构就是 minor 的 1..k 浪、已经在上面列出来了
    if (contextual?.currentLabel === 'B') {
      contextual.subdivision = buildSubdivision(running, sub.bars, sub.period, 'B');
    }
  }

  return {
    code,
    asOf: last?.time ?? '',
    close: r3(last?.close ?? 0),
    major: majorCount,
    minor,
    alternate: minorRes.alternate,
    contextual,
    summary: buildSummary(majorCount, minor),
    note:
      '波浪计数为规则化推断（艾略特三铁律 + 斐波那契投射），存在备选解释；' +
      '见顶位／见底位与时间窗是量级参考而非预测，跌破/涨破失效价则本计数作废。各级别为独立计数，可能互相矛盾。',
  };
}

/**
 * 取 K 线并给出波浪分析。支持个股(6位)/板块(BKxxxx 自动解析)/大盘指数(显式 secid)。
 * 大级别与当前级别各取一次线；大级别取数失败只降级为单层，不让整个接口失败。
 */
export async function getElliottAnalysis(
  code: string,
  period: KlinePeriod = 'day',
  secid?: string,
): Promise<ElliottAnalysis> {
  // 惰性导入：保持本模块纯算法可独立自检，取数（及其 db 依赖链）仅在实际拉线时加载
  const { getKline } = await import('./eastmoney');
  const majorPeriod = PARENT_PERIOD[period];
  // 带 secid 时**不能**把 code 一起送进取数：astockdata(mootdx) 忽略 secid、只把 code 当 symbol，
  // 且在分钟链里排第一，填了 code 会让上证指数(1.000001) 命中同码个股平安银行(000001)。
  // 这与 /api/kline 和 datasource/scheduler.ts 是同一条约定；code 仍保留给 DTO 做身份标识。
  const fetchCode = secid ? '' : code;
  const [minorBars, majorBars] = await Promise.all([
    getKline(fetchCode, period, 260, secid).catch(() => [] as KlineBar[]),
    majorPeriod
      ? getKline(fetchCode, majorPeriod, 260, secid).catch(() => [] as KlineBar[])
      : Promise.resolve([] as KlineBar[]),
  ]);

  // 细分周期得先知道「进行中那一浪有多长」才挑得出来，所以这一次取数只能串在计数之后。
  // 挑周期本身不依赖真实 bar 数（SUB_LADDER 用固定换算倍数估），故只多一次往返、不用试探性拉线。
  // countWaves 是纯函数且只跑 260 根内存数据，这里与 buildAnalysis 里各算一次的开销可忽略，
  // 换来的是不必为了传一个 bar 数把计数结果在两个函数间来回穿。
  const runningBars = countWaves(minorBars, period).main.legs.find((l) => !l.completed)?.bars ?? 0;
  const subPick = pickSubPeriod(period, runningBars);
  const sub = subPick
    ? {
        period: subPick.period,
        bars: await getKline(fetchCode, subPick.period, subPick.limit, secid).catch(
          () => [] as KlineBar[],
        ),
      }
    : null;

  return buildAnalysis(code, minorBars, period, majorBars.length ? majorBars : null, majorPeriod, sub);
}

/** 波浪文本（注入解读 prompt 的只读底稿） */
export function formatElliottForPrompt(a: ElliottAnalysis): string {
  const lines: string[] = [`波浪计数（${a.asOf || '—'}，最新价 ${a.close}）`, `结论：${a.summary}`];
  const dump = (title: string, c: ElliottWaveCount | null): void => {
    if (!c) return;
    lines.push(`【${title}·${c.degreeLabel}】置信度 ${c.confidence}，状态 ${c.state}，当前 ${c.currentLabel ?? '—'} 浪`);
    for (const l of c.legs) {
      lines.push(
        `  浪${l.label}：${l.fromTime} ${l.fromPrice} → ${l.toTime} ${l.toPrice}（${l.bars} 根${l.completed ? '' : '，进行中'}）`,
      );
    }
    if (c.targets.length) {
      // 标明「互为备选」与「是否已走过」：不标的话模型会把两档讲成先后目标，
      // 也会把价格已经走过的那一档继续说成「将要涨到」。
      // 名称走 shared 的 elliottLevelName，与界面上图、面板显示的完全同一套词
      const up = c.currentDirection === 'up';
      const passed = elliottPassedWord(c.currentDirection);
      const cells = c.targets.map((t) => {
        const reached = a.close > 0 && (up ? a.close >= t.price : a.close <= t.price);
        return `${t.ratio}→${t.price}${reached ? `（${passed}）` : ''}`;
      });
      lines.push(
        `  ${elliottLevelName(c.currentLabel, c.currentDirection)}（这一浪可能停下的价位，互为备选、非先后目标）：${cells.join(' / ')}`,
      );
    }
    if (c.invalidationPrice != null) lines.push(`  失效价：${c.invalidationPrice}`);
    if (c.timeWindow) {
      lines.push(`  时间窗：约 ${c.timeWindow.fromDate} ~ ${c.timeWindow.toDate}（还需约 ${c.timeWindow.bars} 根）`);
    }
    if (c.timeProjections.length) {
      lines.push(
        `  斐波那契时间位：${c.timeProjections.map((t) => `${t.ratio}→${t.date}${t.reached ? '（已过）' : ''}`).join(' / ')}`,
      );
    }
    if (c.primary?.price != null) {
      lines.push(
        `  首选参考：${c.primary.price}${c.primary.ratio ? `（${c.primary.ratio}）` : ''}` +
          `${c.primary.date ? `，预计 ${c.primary.date} 前后` : ''}——${c.primary.note}`,
      );
    }
    if (c.subdivision) {
      const s = c.subdivision;
      lines.push(`  ${s.parentLabel} 浪内部细分（${s.period}，当前 ${s.currentLabel ?? '—'}）：`);
      for (const l of s.legs) {
        lines.push(
          `    ${l.label}：${l.fromTime} ${l.fromPrice} → ${l.toTime} ${l.toPrice}${l.completed ? '' : '（进行中）'}`,
        );
      }
    }
    for (const r of c.rationale) lines.push(`  · ${r}`);
  };
  dump('大级别', a.major);
  dump('当前级别', a.minor);
  dump('高一度读法', a.contextual);
  dump('备选计数', a.alternate);
  if (a.contextual?.currentLabel === 'B' && a.minor?.currentLabel) {
    lines.push(
      `注意：「当前级别」与「高一度读法」是同一段走势的两种称呼，见顶位／见底位完全相同，` +
        `分歧在这一浪之后——前者（第 ${a.minor.currentLabel} 浪）意味着后面还有一跌一涨、仍有推进空间，` +
        `后者（B 浪）意味着本浪走完直接进 C 浪。解读时必须把这个分歧讲出来。`,
    );
  }
  return lines.join('\n');
}

// ===== assert 自检（`tsx backend/src/market/elliott.ts` 直接运行）=====
// 构造标准 5 浪断言计数与目标位方向正确；构造违反铁律的序列断言被拒绝而非硬凑。
if (process.argv[1] && /elliott\.ts$/.test(process.argv[1])) {
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(`自检失败：${msg}`);
  };

  /** 造一段从 from 线性走到 to 的 K 线，追加到 acc 后面 */
  function leg(acc: KlineBar[], to: number, n: number): KlineBar[] {
    const from = acc.length ? acc[acc.length - 1].close : to;
    for (let i = 1; i <= n; i += 1) {
      const base = from + ((to - from) * i) / n;
      const day = acc.length + 1;
      acc.push({
        time: `2026-${String(Math.floor(day / 28) + 1).padStart(2, '0')}-${String((day % 28) + 1).padStart(2, '0')}`,
        open: base,
        close: base,
        high: base + 0.05,
        low: base - 0.05,
        volume: 1000,
        amount: 10000,
      });
    }
    return acc;
  }

  // 标准上行 5 浪：10 →(1) 14 →(2) 12 →(3) 20 →(4) 17 →(5) 22，末尾留一段回调（进行中的 A 浪）
  const impulse: KlineBar[] = [];
  leg(impulse, 10, 6);
  leg(impulse, 14, 8);
  leg(impulse, 12, 6);
  leg(impulse, 20, 12);
  leg(impulse, 17, 6);
  leg(impulse, 22, 8);
  leg(impulse, 20.5, 6);
  const up = countWaves(impulse, 'day');
  assert(up.main.state !== 'unclear', `标准 5 浪应可计数，实际 ${up.main.state}：${up.main.rationale.join('；')}`);
  assert(up.main.legs.length >= 3, `标准 5 浪应标出多段浪，实际 ${up.main.legs.length} 段`);
  assert(
    up.main.legs.some((l) => !l.completed),
    '应包含一段进行中的浪（最后一个摆动点之后到最新价）',
  );
  assert(up.main.confidence > 0, `置信度应大于 0，实际 ${up.main.confidence}`);

  // 铁律三：浪4 跌进浪1 区间（浪1 顶 14，浪4 回到 13）必须被拒绝，不得当驱动浪输出
  const overlap: KlineBar[] = [];
  leg(overlap, 10, 6);
  leg(overlap, 14, 8);
  leg(overlap, 12, 6);
  leg(overlap, 20, 12);
  leg(overlap, 13, 8);
  leg(overlap, 21, 8);
  leg(overlap, 19.5, 6);
  const bad = countWaves(overlap, 'day');
  const fiveWaveImpulse = bad.main.state === 'impulse' && bad.main.legs.filter((l) => l.completed).length >= 5;
  assert(!fiveWaveImpulse, '浪4 进入浪1 区间时不得输出完整 5 浪驱动计数');

  // 铁律一：浪2 跌破浪1 起点（起点 10，浪2 回到 9）同样不得成为该锚点下的驱动浪
  const brokeStart: KlineBar[] = [];
  leg(brokeStart, 10, 6);
  leg(brokeStart, 14, 8);
  leg(brokeStart, 9, 8);
  leg(brokeStart, 16, 12);
  leg(brokeStart, 14.5, 6);
  const b2 = countWaves(brokeStart, 'day');
  const anchoredAtTen = b2.main.legs[0]?.fromPrice === 10 && b2.main.state === 'impulse';
  assert(!anchoredAtTen, '浪2 跌破浪1 起点时，不得以该起点输出驱动浪计数');

  // 目标位方向：目标必须落在当前浪推进的那一侧，方向算反会在图上画出完全离谱的线
  const c = up.main;
  {
    const lastClose = impulse[impulse.length - 1].close;
    assert(c.targets.length > 0, '标准 5 浪走完后应给出 A 浪回撤目标');
    for (const t of c.targets) {
      const ok = c.currentDirection === 'up' ? t.price > lastClose : t.price < lastClose;
      assert(ok, `${c.currentDirection} 向的目标位落在了反方向：${t.ratio} → ${t.price} vs 最新价 ${lastClose}`);
    }
    // 失效价同理：5 浪走完后转 A 浪，失效价应是浪5 高点（涨回去说明 5 浪没走完）
    assert(
      c.invalidationPrice != null && c.invalidationPrice > lastClose,
      `A 浪失效价应高于最新价（浪5 顶）：${c.invalidationPrice} vs ${lastClose}`,
    );
  }

  // 数据不足必须显式返回 unclear，而不是拿两三个点硬标浪序
  assert(countWaves(impulse.slice(0, 10), 'day').main.state === 'unclear', '数据不足时应返回 unclear');

  // 时间窗必须落在最后一根 bar 之后，且 from <= to
  if (c.timeWindow) {
    const lastTime = impulse[impulse.length - 1].time;
    assert(c.timeWindow.fromDate > lastTime, `时间窗起点应晚于最后一根 bar：${c.timeWindow.fromDate} vs ${lastTime}`);
    assert(c.timeWindow.fromDate <= c.timeWindow.toDate, '时间窗 from 不应晚于 to');
  }

  // 目标价恒为正。真实数据（601127 从 173 跌到 52）曾按点数算出 -63 / -141 的目标价，
  // 对数尺度让这在结构上不可能发生。构造一段跌幅极大的走势守住这条。
  {
    const crash: KlineBar[] = [];
    leg(crash, 180, 6);
    leg(crash, 120, 10);
    leg(crash, 132, 6);
    leg(crash, 55, 14);
    leg(crash, 68, 6);
    leg(crash, 50, 8);
    const res = countWaves(crash, 'day');
    for (const c of [res.main, res.alternate]) {
      if (!c) continue;
      for (const t of c.targets) {
        assert(t.price > 0, `目标价必须为正（对数尺度投射）：${c.currentLabel} 浪 ${t.ratio} → ${t.price}`);
      }
    }
  }

  // 目标位不得越过自己的失效价——走到就已经把这套计数证伪，同时报出来是自相矛盾的
  {
    const all: Array<ElliottWaveCount | null> = [];
    for (const series of [impulse, overlap, brokeStart]) {
      const r = countWaves(series, 'day');
      all.push(r.main, r.alternate);
      const lastClose = series[series.length - 1].close;
      for (const c of all) {
        if (!c || c.invalidationPrice == null || !c.currentDirection) continue;
        const guardAhead =
          c.currentDirection === 'up' ? c.invalidationPrice > lastClose : c.invalidationPrice < lastClose;
        if (!guardAhead) continue;
        for (const t of c.targets) {
          const ok = c.currentDirection === 'up' ? t.price < c.invalidationPrice : t.price > c.invalidationPrice;
          assert(ok, `目标位越过了失效价：${t.ratio} → ${t.price}，失效价 ${c.invalidationPrice}`);
        }
      }
      all.length = 0;
    }
  }

  // 现价已破失效价的计数不得输出。601127 日线真实数据曾输出一套上行浪4 计数，
  // 失效价 57.92 而现价 51.84 早已跌穿——铁律三要等浪4 走完才校验得到，漏过了它。
  {
    const breached: KlineBar[] = [];
    leg(breached, 10, 6);
    leg(breached, 16, 8); // 浪1 顶 16
    leg(breached, 13, 6);
    leg(breached, 24, 12);
    leg(breached, 12, 10); // 浪4 已跌到 12，远低于浪1 顶 16
    const res = countWaves(breached, 'day');
    const last = breached[breached.length - 1].close;
    for (const c of [res.main, res.alternate]) {
      if (!c || c.invalidationPrice == null || c.state === 'unclear') continue;
      // 输出的每一套计数，其失效价都不应已被现价击穿。浪1 的走向即整套计数的顺势方向
      const impulseUp = c.legs[0] ? c.legs[0].toPrice > c.legs[0].fromPrice : true;
      const broken =
        c.currentLabel === 'A'
          ? impulseUp
            ? last > c.invalidationPrice
            : last < c.invalidationPrice
          : impulseUp
            ? last < c.invalidationPrice
            : last > c.invalidationPrice;
      assert(
        !broken,
        `不得输出现价已击穿失效价的计数：当前 ${c.currentLabel} 浪，失效价 ${c.invalidationPrice}，现价 ${last}`,
      );
    }
  }

  // 多周期组装：大级别取不到线时应降级为单层而不是抛错
  const single = buildAnalysis('TEST', impulse, 'day', null, 'week');
  assert(single.major === null && single.minor != null, '大级别缺数据时应降级为单层');
  assert(single.summary.length > 0, 'summary 不应为空');

  // 高一度读法：5 浪走完时必须折叠出 A + B，且 A 段首尾要等于原 5 浪的首尾。
  // 折叠错位会让「B 浪回撤 A 浪多少」整个算错。
  {
    const ctx = single.contextual;
    assert(ctx != null, '5 浪已完成时应产出高一度读法');
    assert(ctx!.currentLabel === 'B', `高一度当前浪应为 B，实际 ${ctx!.currentLabel}`);
    const done = single.minor!.legs.filter((l) => l.completed);
    const legA = ctx!.legs[0];
    assert(
      legA.label === 'A' &&
        legA.fromTime === done[0].fromTime &&
        legA.fromPrice === done[0].fromPrice &&
        legA.toTime === done[4].toTime &&
        legA.toPrice === done[4].toPrice,
      'A 段首尾必须等于原 5 浪的首尾',
    );
    assert(
      legA.bars === done.slice(0, 5).reduce((s, l) => s + l.bars, 0),
      'A 段 bar 数应为 5 段之和',
    );
    // 价位同源：两种读法量的是同一段，候选位必须逐个相等
    assert(
      JSON.stringify(ctx!.targets.map((t) => t.price)) ===
        JSON.stringify(single.minor!.targets.map((t) => t.price)),
      '两种读法的候选位价格必须完全相同',
    );
    // 失效价则必须不同：minor 是浪5 终点，高一度是 A 浪起点
    assert(
      ctx!.invalidationPrice === legA.fromPrice,
      `高一度失效价应为 A 浪起点 ${legA.fromPrice}，实际 ${ctx!.invalidationPrice}`,
    );
  }

  // 5 浪未走完时不得给出 B 浪目标位——高一度的 A 浪本身还在走，谈 B 浪是无中生有
  {
    const partial: KlineBar[] = [];
    leg(partial, 10, 6);
    leg(partial, 14, 8);
    leg(partial, 12, 6);
    leg(partial, 20, 12);
    leg(partial, 18, 6);
    const ctx = buildAnalysis('TEST', partial, 'day', null, 'week').contextual;
    if (ctx) {
      assert(ctx.currentLabel !== 'B' || ctx.targets.length === 0, '5 浪未完成时不得给 B 浪目标位');
    }
  }

  // 斐波那契时间位必须单调递增且比例与 bar 数对应
  {
    const c = single.minor!;
    const base = c.legs.filter((l) => l.completed).slice(0, 5).reduce((s, l) => s + l.bars, 0);
    for (const t of c.timeProjections) {
      const r = Number(t.ratio.replace('%', '')) / 100;
      assert(
        Math.abs(t.bars - Math.round(base * r)) <= 1,
        `时间位 bar 数与比例不符：${t.ratio} → ${t.bars}，基准 ${base}`,
      );
    }
    for (let i = 1; i < c.timeProjections.length; i += 1) {
      assert(
        c.timeProjections[i].bars > c.timeProjections[i - 1].bars,
        '时间位应按 bar 数递增',
      );
    }
  }

  // 首选必须是「沿行进方向下一个尚未到达」的那一档
  {
    const c = single.minor!;
    if (c.primary?.price != null && c.targets.length > 0) {
      const last = impulse[impulse.length - 1].close;
      const up = c.currentDirection === 'up';
      const unreached = c.targets
        .filter((t) => !(up ? last >= t.price : last <= t.price))
        .sort((a, b) => (up ? a.price - b.price : b.price - a.price));
      if (unreached.length > 0) {
        assert(
          c.primary.price === unreached[0].price,
          `首选应取最近的未到达档 ${unreached[0].price}，实际 ${c.primary.price}`,
        );
      }
    }
  }

  // 价位名称：按「浪的性质 × 行进方向」四种组合给出对应说法，且一律不带浪标。
  // 带了浪标就会出现「A候选」这种既看不出用途、又与高一度读法的 B 浪打架的标签。
  {
    const cases: Array<[ElliottLabel, 'up' | 'down', string]> = [
      ['A', 'up', '反弹见顶位'],
      ['B', 'up', '反弹见顶位'],
      ['2', 'up', '反弹见顶位'],
      ['C', 'down', '回调见底位'],
      ['4', 'down', '回调见底位'],
      ['3', 'up', '上行见顶位'],
      ['5', 'down', '下行见底位'],
    ];
    for (const [label, dir, want] of cases) {
      const got = elliottLevelName(label, dir);
      assert(got === want, `${label} 浪 ${dir} 向应叫「${want}」，实际「${got}」`);
      assert(!/[1-5ABC]/.test(got), `价位名称不得带浪标：${got}`);
    }
    assert(elliottLevelName(null, 'up') === '见顶位', '无浪标时应退回方向说法');
    assert(elliottLevelName('A', null) === '转折位', '无方向时应退回中性说法');
    assert(elliottPassedWord('up') === '已突破' && elliottPassedWord('down') === '已跌破', '走过档位的说法应随方向');
  }

  // 子周期阶梯：短浪要挑更细的周期，长浪要挑更粗的，且都不该越界
  {
    assert(pickSubPeriod('day', 10)?.period === '60m', `10 根日线浪应选 60m，实际 ${pickSubPeriod('day', 10)?.period}`);
    assert(pickSubPeriod('day', 30)?.period === '120m', `30 根日线浪应选 120m，实际 ${pickSubPeriod('day', 30)?.period}`);
    assert(pickSubPeriod('5m', 10) === null, '5 分钟已是最细级别，不应再细分');
    assert((pickSubPeriod('day', 10)?.limit ?? 0) <= 800, '取数条数不应超过上限');
  }

  // eslint-disable-next-line no-console
  console.log(
    'elliott.ts 自检通过（标准5浪计数 · 浪4重叠拒绝 · 浪2破起点拒绝 · 目标位方向 · 数据不足降级 · ' +
      '时间窗外推 · 单层降级 · 高一度折叠 · 未完成不给B目标 · 斐波那契时间位 · 首选取最近未达档 · ' +
      '价位名称按性质×方向且不带浪标 · 子周期阶梯）：',
    JSON.stringify({ state: c.state, current: c.currentLabel, conf: c.confidence, targets: c.targets }),
  );
}
