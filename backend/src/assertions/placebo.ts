import type { KlineBar, KlinePeriod } from '@stock-agent/shared';
import { judgeLevel } from './judge';

// 安慰剂对照：回答「这套方法给的价位，比在同样距离上随便挑一个价位强多少」。
//
// 为什么必须有它：账本报的是绝对命中率（枢轴 46%、道氏 54%），可没人知道
// 随便挑一个同样远近的价位能拿多少。如果随机价位也有 50%，那 54% 就不是本事。
// 各来源给出的价位远近分布还不一样（实测「价格没走到」的比例从 18% 到 47%），
// 远近本身就影响触及率与反应率，不做同距离对照就是在比不同的东西。
//
// 纪律：
// 1. 本文件不做任何技术计算，只生成伪价位并调用**同一个** judgeLevel。
//    对照组和真实组必须走完全相同的判定，否则差值里混的是判定差异而不是价位质量差异。
// 2. 随机必须可复现。带固定种子，同样输入永远得到同样结果，
//    否则每次跑出来的权重都不一样，没法审计也没法回滚。

/**
 * 每条真实价位配几个伪价位。
 *
 * 只配一个的话单次随机方差太大——同一个真实价位换个种子，对照结果可能从「赢」变成「输」。
 * 多配几个再取平均，把对照组自身的噪声压下去。
 */
export const PLACEBO_PER_REAL = 8;

/**
 * 距离分桶宽度（ATR 倍数）。同桶内才算「同样远近」。
 *
 * 太窄则伪价位几乎等于真实价位、对照失去意义；太宽则远近差异重新混进来。
 * 0.25 个 ATR 约等于日内四分之一的常见波动，够细又不至于退化。
 */
export const PLACEBO_BUCKET_ATR = 0.25;

/**
 * 可复现的伪随机数（mulberry32）。
 *
 * 不用 Math.random：那样每次跑出的对照结果都不同，权重就成了随机数，
 * 既没法复现也没法在出问题时倒查是哪一次的对照把权重推歪了。
 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把字符串折成一个稳定的整数种子，保证同一条记录每次都得到同一批伪价位 */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 一条真实价位的对照输入 */
export interface PlaceboInput {
  /** 用于生成稳定种子，取该条记录的 id */
  id: string;
  code: string;
  period: KlinePeriod;
  /** 真实价位 */
  price: number;
  /** 记录当时的收盘价 */
  close: number;
  atr: number;
  reactionBars: number;
  dueDate: string;
  /** 判定基准日（今天），与真实记录结算时同一个 */
  today: string;
  /** 记录日之后的 K 线，与真实记录判定时同一批 */
  bars: KlineBar[];
  /** 同一天该标的的其他真实价位，用于敏感性分析时避开 */
  otherRealPrices: number[];
}

/** 一条真实价位的对照结果 */
export interface PlaceboOutcome {
  /** 伪价位里被触及并判出结果的个数 */
  judged: number;
  /** 其中判为「掉头了」的个数 */
  hit: number;
  /** 排除掉落在其他真实价位附近的伪价位后，重新统计的一组 */
  judgedClean: number;
  hitClean: number;
}

/** 伪价位落在真实结构这么近的范围内就算「撞上了」，敏感性分析里排除 */
const NEAR_REAL_ATR = 0.15;

/**
 * 为一条真实价位生成同距离的伪价位并判定。
 *
 * 伪价位取在「与真实价位同一个距离桶、同一侧」的随机位置：
 * 同侧是因为上方压力与下方支撑的判定方向不同，跨侧比就不是同类比较了。
 *
 * 关于伪价位偶尔落在别的真实结构上（整数关口、另一套方法的价位）：
 * 这会让对照组偏强、从而低估真实来源的优势，属于**保守偏差**，不该直接排除掉。
 * 但也不能装作没有，所以另算一组排除后的结果，两组一起报，由读的人判断。
 */
export function judgePlacebo(input: PlaceboInput): PlaceboOutcome {
  const { price, close, atr } = input;
  if (!(atr > 0) || !(close > 0)) {
    return { judged: 0, hit: 0, judgedClean: 0, hitClean: 0 };
  }
  const up = price >= close;
  const distAtr = Math.abs(price - close) / atr;
  // 落到哪个距离桶，伪价位就在这个桶里取
  const bucket = Math.floor(distAtr / PLACEBO_BUCKET_ATR);
  const lo = bucket * PLACEBO_BUCKET_ATR;
  const hi = lo + PLACEBO_BUCKET_ATR;

  const rnd = seeded(hashSeed(input.id));
  const out: PlaceboOutcome = { judged: 0, hit: 0, judgedClean: 0, hitClean: 0 };
  for (let i = 0; i < PLACEBO_PER_REAL; i += 1) {
    const d = (lo + rnd() * (hi - lo)) * atr;
    const fake = up ? close + d : close - d;
    if (!(fake > 0)) continue;
    // 方向与真实价位同一套规则：在上方就看会不会向下受阻，在下方就看会不会向上反弹
    const dir = up ? 'down' : 'up';
    const o = judgeLevel(
      input.bars,
      fake,
      dir,
      atr,
      input.reactionBars,
      input.dueDate,
      input.today,
    );
    if (o !== 'respected' && o !== 'violated') continue;
    out.judged += 1;
    if (o === 'respected') out.hit += 1;
    // 敏感性组：避开真实结构附近
    const collides = input.otherRealPrices.some(
      (p) => Math.abs(p - fake) / atr < NEAR_REAL_ATR,
    );
    if (collides) continue;
    out.judgedClean += 1;
    if (o === 'respected') out.hitClean += 1;
  }
  return out;
}
