import type { AssertionSource } from '@stock-agent/shared';

// 各套方法的可信度权重：由「比同距离随机价位强多少」算出来，用于给候选价位排序。
//
// 为什么不直接用命中率：命中率里混着「这条线本来就容易被摸到」的成分，
// 各来源的价位远近分布差很多（实测「价格没走到」的比例从 18% 到 47%）。
// 只有减去同距离安慰剂的成绩，剩下的才是这套方法自己的本事。
//
// 纪律：
// 1. 权重由统计**确定性映射**而来，不做参数搜索。
// 2. 但映射形状、钳位边界、平滑参数本身也是选择，所以有协议版本号——
//    改任何一个都要升版，旧口径的历史成绩不能与新口径混用。
// 3. 永远给得出权重不等于永远该用权重：样本不够就中性，让它退回今天的行为。

/**
 * 权重协议版本。
 *
 * 改映射形状、钳位边界、平滑参数、样本门槛中的任何一个都必须升版。
 * 升版后旧数据只能用于训练，不能拿来验收新版本——否则就是在同一批数据上
 * 既发现规律又宣布规律成立。
 */
export const WEIGHT_PROTOCOL_VERSION = 'weight-v1';

/** 中性权重。样本不够、熔断、或该来源不参与加权时都取它 */
export const NEUTRAL_WEIGHT = 1;

/**
 * 权重上下限。
 *
 * 再强的统计也不该让某一套方法一票定音——这套账本只有 7 只标的、几十个交易日，
 * 任何来源的优势都还谈不上稳固。钳位保证最坏情况下排序也只是被轻推，不会被改写。
 */
export const WEIGHT_MIN = 0.7;
export const WEIGHT_MAX = 1.3;

/** 增益下界到达这个幅度才给满权重。5 个百分点是一个来源值得被优先看的合理起点 */
const FULL_EDGE = 0.05;

/** 最少要有这么多个独立日期才谈得上统计。少于此一律中性 */
export const MIN_BLOCKS = 20;

/** 单日权重最多变动这么多，防止样本抖动让排序跳来跳去 */
export const MAX_DAILY_STEP = 0.05;

/** 新权重在 EMA 里占的比重，其余沿用昨天的 */
export const EMA_ALPHA = 0.25;

/**
 * 滞回：权重要离开中性，增益下界必须超过 ENTER；已经离开的要回到中性，
 * 必须跌破 EXIT。两个阈值拉开距离，避免在临界点上反复启停。
 */
const ENTER_EDGE = 0.02;
const EXIT_EDGE = 0.005;

/** 一条配对样本：同一条真实价位与它的安慰剂对照 */
export interface PairedSample {
  /** 分块键，取记录日。同一天的样本高度相关，重采样必须整块一起抽 */
  block: string;
  /** 真实价位是否掉头了 */
  realHit: boolean;
  /** 该条对应的安慰剂命中率（多个伪价位的平均） */
  placeboRate: number;
}

/** 增益的点估计与下界 */
export interface EdgeEstimate {
  /** 真实命中率 − 安慰剂命中率 */
  edge: number;
  /** 按日期分块 bootstrap 的 95% 下界 */
  lower: number;
  /** 参与统计的独立日期数 */
  blocks: number;
  samples: number;
}

/** 可复现的伪随机数，与 placebo.ts 同一套实现 */
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

/**
 * 「真实 − 安慰剂」增益的下界，用**按日期分块的配对 bootstrap**。
 *
 * 为什么不用 Wilson：Wilson 只适用于单个二项比例，而这里要估的是两个**相关**比例的差值
 * （真实与安慰剂共用同一段行情、同一批 K 线）。套 Wilson 在数学上不成立。
 *
 * 为什么整块重采样：同一天的几十条价位判断受同一波行情驱动，不是独立样本。
 * 逐条重采样会把有效样本量当成条数，区间会窄得离谱。按日期整块抽才反映真实不确定性。
 *
 * @param iterations 重采样次数。固定值 + 固定种子，保证同输入同结果
 */
export function bootstrapEdge(samples: PairedSample[], iterations = 2000): EdgeEstimate {
  const byBlock = new Map<string, PairedSample[]>();
  for (const s of samples) {
    const arr = byBlock.get(s.block);
    if (arr) arr.push(s);
    else byBlock.set(s.block, [s]);
  }
  const blocks = [...byBlock.values()];
  const meanOf = (rows: PairedSample[]): number => {
    if (rows.length === 0) return 0;
    let d = 0;
    for (const r of rows) d += (r.realHit ? 1 : 0) - r.placeboRate;
    return d / rows.length;
  };
  const edge = meanOf(samples);
  if (blocks.length < 2) {
    return { edge, lower: edge, blocks: blocks.length, samples: samples.length };
  }
  const rnd = seeded(1337);
  const draws: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const picked: PairedSample[] = [];
    for (let b = 0; b < blocks.length; b += 1) {
      picked.push(...blocks[Math.floor(rnd() * blocks.length)]);
    }
    draws.push(meanOf(picked));
  }
  draws.sort((a, b) => a - b);
  return {
    edge,
    lower: draws[Math.floor(draws.length * 0.05)],
    blocks: blocks.length,
    samples: samples.length,
  };
}

/** 一个来源的权重结论 */
export interface SourceWeight {
  source: AssertionSource;
  weight: number;
  /** 为什么是这个权重，直接展示给人看 */
  reason: string;
  estimate: EdgeEstimate;
}

/**
 * 由增益下界确定性映射出权重。
 *
 * 形状取「下界为 0 时中性，到 FULL_EDGE 时拉满」的线性段，负增益对称压低。
 * 用线性而不是别的曲线，只因为它最容易解释——权重要能对人说清楚为什么。
 *
 * @param prev 昨天的权重，用于平滑与滞回；首次为空
 */
export function weightOf(
  source: AssertionSource,
  est: EdgeEstimate,
  prev?: number,
): SourceWeight {
  const neutral = (reason: string): SourceWeight => ({
    source,
    weight: NEUTRAL_WEIGHT,
    reason,
    estimate: est,
  });
  if (est.blocks < MIN_BLOCKS) {
    return neutral(`只有 ${est.blocks} 个独立日期的样本，不足 ${MIN_BLOCKS} 个，先不加权`);
  }
  const away = prev != null && Math.abs(prev - NEUTRAL_WEIGHT) > 1e-9;
  // 滞回：还没离开中性的要过 ENTER 才动；已经离开的跌破 EXIT 才回去
  const threshold = away ? EXIT_EDGE : ENTER_EDGE;
  if (Math.abs(est.lower) < threshold) {
    return neutral(
      `比随便挑一个同样远近的价位只强 ${(est.lower * 100).toFixed(1)} 个百分点，还看不出差别`,
    );
  }
  const raw =
    NEUTRAL_WEIGHT +
    (Math.max(-1, Math.min(1, est.lower / FULL_EDGE)) * (WEIGHT_MAX - WEIGHT_MIN)) / 2;
  let w = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, raw));
  if (prev != null) {
    // 先 EMA 平滑，再按单日上限截断。两道都要：EMA 管长期抖动，上限管突变
    w = prev + (w - prev) * EMA_ALPHA;
    w = Math.max(prev - MAX_DAILY_STEP, Math.min(prev + MAX_DAILY_STEP, w));
    w = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, w));
  }
  const dir = est.lower > 0 ? '强' : '弱';
  return {
    source,
    weight: Math.round(w * 1000) / 1000,
    reason:
      `比随便挑一个同样远近的价位${dir} ${Math.abs(est.lower * 100).toFixed(1)} 个百分点` +
      `（${est.blocks} 个独立日期、${est.samples} 条记录）`,
    estimate: est,
  };
}
