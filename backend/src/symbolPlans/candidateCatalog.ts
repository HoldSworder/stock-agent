import { createHash } from 'node:crypto';
import type {
  CandidateCatalog,
  CandidateCondition,
  CandidateConditionPurpose,
  CandidateLevel,
  CandidateLevelSource,
  ChanStructure,
  DowStructure,
  KlineBar,
  KlinePeriod,
  PlaybookRule,
  PlanPeriod,
  PriceLevels,
  TradeLevelRole,
} from '@stock-agent/shared';
import { PLAN_PERIODS, PLAYBOOK_RULE_CAPABILITY } from '@stock-agent/shared';
// 直接用 playbook 的纯函数求值，不经 evaluate.ts：那边依赖 repo 与计划实例，
// 从这里引会成环，且候选阶段根本没有计划可传
import { buildSeries, evalRule, type Series } from '../playbook/rules';
import { isBarUnclosed } from './sessionClock';
import { TIME_STOP_BARS } from './risk';

// 候选目录生成器（计划 4.11）。这是 R1 架构的阻塞级前置能力：
// LLM 只能从这里挑 ID，不允许自由填价格，所以「候选够不够用」直接决定计划质量。
// 全流程确定性：同一份 fixture 两次生成的 catalogHash / 候选ID / 排序必须完全一致。

/** 候选模型版本：聚类容差、评分权重、上限、白名单任一变化都要递增 */
export const CANDIDATE_MODEL_VERSION = 'candidate-v5';

/**
 * 分层配额。候选按 week/day/60m 三层各自产出，配额也按层分。
 *
 * 合计 21 个价位、40 条条件，是被 format.ts 的 CATALOG_SOFT_LIMIT=4000 字符反推出来的：
 * 再多就会在格式化时被 capLines 从尾部裁掉，而**被裁掉的 candidateId LLM 根本看不见**，
 * 却仍会因为「引用了不存在的候选」被 validateProposal 打回，表现为无限重试。
 * 改这两个数必须同步跑 symbolPlanCandidates 自检里的「全部 candidateId 可见」硬断言。
 *
 * 层内配比按信息密度给：日线是主战场给最多，周线只要几个大级别边界，
 * 60 分钟只用来给次日的触发/失效点，不需要铺满。
 */
const LEVEL_CAP: Record<PlanPeriod, number> = { week: 5, day: 10, '60m': 6 };
/** 层内单侧上限：现价上下各不超过该层的一半 */
const SIDE_CAP: Record<PlanPeriod, number> = { week: 3, day: 5, '60m': 3 };
/** 条件总量硬上限（跨三层合计） */
const CONDITION_CAP = 40;
/**
 * 各层「计划期内可触达」的 ATR 倍数，超出则距离分衰减。
 * 一律以**日线 ATR** 为尺（三层共用同一把尺才可比）：60 分钟级别的位子应当近，
 * 周线级别的位子远一点也算合理目标。
 */
const REACH_ATR: Record<PlanPeriod, number> = { week: 12, day: 6, '60m': 2 };
/** 非价格条件按用途限量（4.11.3） */
const PURPOSE_CAP: Record<CandidateConditionPurpose, number> = {
  price_level: Number.MAX_SAFE_INTEGER, // 由 LEVEL_CAP 间接限制
  volume_confirm: 4,
  structure_confirm: 4,
  time_window: 2,
  gate: 4,
};

/** 评分权重（4.11.2） */
const W = {
  structureImportance: 0.3,
  historicalTouch: 0.25,
  distance: 0.2,
  confluence: 0.15,
  recency: 0.1,
} as const;

/** 各来源的结构重要性基准分（0~1） */
const SOURCE_IMPORTANCE: Record<CandidateLevelSource, number> = {
  swing: 1,
  pivot_zone: 0.9,
  prev_extreme: 0.85,
  ma: 0.6,
  classic_pivot: 0.5,
  fibonacci: 0.45,
  adapter: 0.7,
};

/** 历史触碰回看根数 */
const TOUCH_LOOKBACK = 120;

/** 单个原始候选（聚类前） */
interface RawLevel {
  price: number;
  source: CandidateLevelSource;
  label: string;
  evidenceId: string;
  /** 该来源直接建议的角色（聚类后合并去重） */
  roles: TradeLevelRole[];
  /** 保底候选：结构失效位与最近摆动点，不因分低被裁 */
  guaranteed?: boolean;
}

/** 单层输入：该周期自己的 K 线、点位测算与结构 */
export interface CatalogPeriodInput {
  period: PlanPeriod;
  bars: KlineBar[];
  /** 复用 market/levels.ts 的产出，不在此重算 ATR/枢轴/斐波/均线 */
  levels: PriceLevels;
  dow: DowStructure | null;
  chan: ChanStructure | null;
}

export interface CatalogInput {
  contextId: string;
  /**
   * 标的代码。用于建目录时判定「条件是否当下已成立」——
   * 求值器要靠它区分 10% / 20% / 30% 涨跌幅板，拿 contextId 冒充会把创业板按主板算。
   */
  code: string;
  /**
   * 三层周期各自的结构与点位，缺哪层就少哪层的候选（不回退、不用别层的数据顶替）。
   * 早先只从日线出候选，导致「周线级压力位」这种波段计划最需要的东西根本进不了目录，
   * 只能靠 LLM 在描述里空口提一句，落不成可求值的条件。
   */
  periods: CatalogPeriodInput[];
  /** 适配器给的执行位（涨跌停价、IOPV 闸门等），与技术支撑压力分开归类。只挂日线层 */
  adapterLevels?: Array<{ price: number; label: string; evidenceId: string }>;
  /** 有效期（ISO），到期后 contextId 失效 */
  expiresAt: string;
  createdAt: string;
}

// ===== 4.11.1 原始候选来源 =====

function collectRawLevels(
  input: CatalogPeriodInput,
  price: number,
  adapterLevels: CatalogInput['adapterLevels'],
): { raws: RawLevel[]; omitted: Record<string, number> } {
  const { levels, dow, chan, bars } = input;
  const tf = input.period;
  const raws: RawLevel[] = [];
  const omitted: Record<string, number> = {};
  const countOmitted = (k: string, n: number): void => {
    if (n > 0) omitted[k] = (omitted[k] ?? 0) + n;
  };

  // 确认摆动点：保留最近 2 高 + 2 低（其余计入 omitted）
  if (dow) {
    const confirmed = dow.swings.filter((s) => s.confirmed);
    const highs = confirmed.filter((s) => s.kind === 'high');
    const lows = confirmed.filter((s) => s.kind === 'low');
    const keepHighs = highs.slice(-2);
    const keepLows = lows.slice(-2);
    countOmitted('swing', highs.length - keepHighs.length + (lows.length - keepLows.length));
    for (const s of [...keepHighs, ...keepLows]) {
      raws.push({
        price: s.price,
        source: 'swing',
        label: `${s.kind === 'high' ? '摆动高点' : '摆动低点'} ${s.time}`,
        evidenceId: s.id,
        roles: s.kind === 'high' ? ['resistance', 'target'] : ['support', 'invalidation', 'stop'],
        // 最近一个已确认摆动点是结构失效位的锚，保底
        guaranteed: s.id === dow.lastConfirmedHighId || s.id === dow.lastConfirmedLowId,
      });
    }
  }

  // 候选中枢上下沿：只保留 detectPivots 已筛出的最近一个
  if (chan) {
    for (const p of chan.pivots) {
      raws.push({
        price: p.low,
        source: 'pivot_zone',
        label: `中枢下沿 ${p.low.toFixed(3)}`,
        evidenceId: p.id,
        roles: ['support', 'invalidation'],
      });
      raws.push({
        price: p.high,
        source: 'pivot_zone',
        label: `中枢上沿 ${p.high.toFixed(3)}`,
        evidenceId: p.id,
        roles: ['resistance', 'entry_trigger'],
      });
    }
  }

  // 前高/前低：不含当根的近 60 根极值
  if (bars.length >= 21) {
    const win = bars.slice(-61, -1);
    if (win.length > 0) {
      const hi = Math.max(...win.map((b) => b.high));
      const lo = Math.min(...win.map((b) => b.low));
      raws.push({
        price: hi,
        source: 'prev_extreme',
        label: `前高 ${hi.toFixed(3)}`,
        evidenceId: `ext:high:${tf}`,
        roles: ['resistance', 'entry_trigger', 'target'],
      });
      raws.push({
        price: lo,
        source: 'prev_extreme',
        label: `前低 ${lo.toFixed(3)}`,
        evidenceId: `ext:low:${tf}`,
        roles: ['support', 'invalidation', 'stop'],
      });
    }
  }

  // 均线：只保留距现价最近的上方压力与下方支撑（4.11.1 的「最外 3 个」按现价两侧各取最近，避免堆满 6 条）
  const maList = levels.ma?.values ?? [];
  const maKept: typeof maList = [];
  if (levels.ma?.resistanceMa) maKept.push(levels.ma.resistanceMa);
  if (levels.ma?.supportMa) maKept.push(levels.ma.supportMa);
  // 再补一条离现价第三近的，凑满 3 条
  const rest = maList
    .filter((m) => !maKept.some((k) => k.period === m.period))
    .sort((a, b) => Math.abs(a.value - price) - Math.abs(b.value - price));
  if (rest[0]) maKept.push(rest[0]);
  countOmitted('ma', Math.max(0, maList.length - maKept.length));
  for (const m of maKept) {
    raws.push({
      price: m.value,
      source: 'ma',
      label: `MA${m.period} ${m.value.toFixed(3)}`,
      evidenceId: `ma:${tf}:${m.period}`,
      roles: m.value > price ? ['resistance'] : ['support'],
    });
  }

  // 经典枢轴：现价上下最近各 1 个；PP 只在位于当前价格区间时保留
  if (levels.pivot) {
    const p = levels.pivot;
    const above = [p.r1, p.r2, p.r3].filter((v) => v > price).sort((a, b) => a - b);
    const below = [p.s1, p.s2, p.s3].filter((v) => v < price).sort((a, b) => b - a);
    countOmitted('classic_pivot', Math.max(0, above.length - 1) + Math.max(0, below.length - 1));
    if (above[0] != null) {
      raws.push({
        price: above[0],
        source: 'classic_pivot',
        label: `枢轴压力 ${above[0].toFixed(3)}`,
        evidenceId: `pivot:${tf}:r`,
        roles: ['resistance'],
      });
    }
    if (below[0] != null) {
      raws.push({
        price: below[0],
        source: 'classic_pivot',
        label: `枢轴支撑 ${below[0].toFixed(3)}`,
        evidenceId: `pivot:${tf}:s`,
        roles: ['support'],
      });
    }
    const lastBar = bars[bars.length - 1];
    if (lastBar && p.pp >= lastBar.low && p.pp <= lastBar.high) {
      raws.push({
        price: p.pp,
        source: 'classic_pivot',
        label: `枢轴 PP ${p.pp.toFixed(3)}`,
        evidenceId: `pivot:${tf}:pp`,
        roles: ['support', 'resistance'],
      });
    }
  }

  // 斐波那契：回撤最外 2 个 + 顺势扩展最外 1 个，且必须与主导波段方向一致
  const swingDir = levels.swing?.direction ?? null;
  const retr = [...levels.fibRetracements].sort(
    (a, b) => Math.abs(b.price - price) - Math.abs(a.price - price),
  );
  countOmitted('fibonacci', Math.max(0, retr.length - 2));
  for (const f of retr.slice(0, 2)) {
    raws.push({
      price: f.price,
      source: 'fibonacci',
      label: `斐波回撤 ${f.ratio} ${f.price.toFixed(3)}`,
      evidenceId: `fib:${tf}:retr:${f.ratio}`,
      roles: swingDir === 'up' ? ['support'] : ['resistance'],
    });
  }
  if (swingDir) {
    const ext = levels.fibExtensions
      .filter((f) => (swingDir === 'up' ? f.price > price : f.price < price))
      .sort((a, b) => Math.abs(b.price - price) - Math.abs(a.price - price));
    countOmitted('fibonacci_ext', Math.max(0, ext.length - 1));
    if (ext[0]) {
      raws.push({
        price: ext[0].price,
        source: 'fibonacci',
        label: `斐波扩展 ${ext[0].ratio} ${ext[0].price.toFixed(3)}`,
        evidenceId: `fib:${tf}:ext:${ext[0].ratio}`,
        roles: ['target'],
      });
    }
  }

  // 适配器执行位：单独归类，不与技术支撑压力混淆
  for (const a of adapterLevels ?? []) {
    raws.push({
      price: a.price,
      source: 'adapter',
      label: a.label,
      evidenceId: a.evidenceId,
      roles: ['entry_trigger', 'stop'],
    });
  }

  return { raws: raws.filter((r) => Number.isFinite(r.price) && r.price > 0), omitted };
}

// ===== 4.11.2 聚类、评分与上限 =====

/** 价位统一保留 3 位小数：candidateId 与编译出的规则必须同精度，否则会产出语义重复的条件 */
const roundPrice = (p: number): number => Math.round(p * 1000) / 1000;

/**
 * 聚类容差：max(2×tickSize, 0.35×ATR, 现价×0.20%)。
 *
 * ATR 系数取 0.35 而非更小值：盘中三分之一 ATR 以内的几个价位在实盘上就是同一档防守，
 * 分开成多个候选只会让计划挑出几条肉眼重合的辅助线。clusterLevels 的判据锚在 cur.low，
 * 簇宽被容差硬封顶，放大系数不会引发链式合并。
 */
export function clusterTolerance(
  price: number,
  atr: number | null,
  tickSize = 0.001,
  scale = 1,
): number {
  return Math.max(2 * tickSize, 0.35 * (atr ?? 0) * scale, price * 0.002 * scale);
}

/**
 * 各层聚类容差相对日线的倍数。
 *
 * 三层共用同一把日线 ATR 尺是为了让「距现价 N 个 ATR」在层间可比，但那把尺
 * 直接拿来当聚类容差是两回事：60 分钟级的位子彼此本就密集，用整整 0.35 个日线 ATR
 * 去合并会把一层的位子糊成两三条宽带，Phase 2 要的「精确到 60 分钟的触发点」
 * 就退化成了带子中点。反过来周线级的位子天然疏散，容差小了只会切出一堆挨着的重复位。
 */
const TOLERANCE_SCALE: Record<PlanPeriod, number> = { week: 1.5, day: 1, '60m': 0.4 };

interface Cluster {
  low: number;
  high: number;
  price: number;
  members: RawLevel[];
}

/** 先按价格排序再顺序合并落在容差内的相邻价位 */
function clusterLevels(raws: RawLevel[], tolerance: number): Cluster[] {
  const sorted = [...raws].sort((a, b) => a.price - b.price || a.evidenceId.localeCompare(b.evidenceId));
  const out: Cluster[] = [];
  for (const r of sorted) {
    const cur = out[out.length - 1];
    if (cur && r.price - cur.low <= tolerance) {
      cur.high = Math.max(cur.high, r.price);
      cur.members.push(r);
      cur.price = (cur.low + cur.high) / 2;
      continue;
    }
    out.push({ low: r.price, high: r.price, price: r.price, members: [r] });
  }
  return out;
}

/** 历史触碰次数：K 线高/低/收进入容差区即记一次，连续相邻 K 线只记 1 次 */
function historicalTouches(bars: KlineBar[], low: number, high: number): number {
  const win = bars.slice(-TOUCH_LOOKBACK);
  let count = 0;
  let prevHit = false;
  for (const b of win) {
    // 只需判 K 线区间与价格区是否相交：close 落在区内时该条件必然已成立，无须再单独判收盘
    const hit = b.low <= high && b.high >= low;
    if (hit && !prevHit) count += 1;
    prevHit = hit;
  }
  return count;
}

/** 归一到 0~1。NaN 归 0——放行 NaN 会一路污染 score 并让排序变成引擎相关的未定义顺序，破坏可复现性 */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function scoreCluster(
  c: Cluster,
  bars: KlineBar[],
  price: number,
  atr: number | null,
  period: PlanPeriod,
): { score: number; parts: CandidateLevel['scoreParts']; atrDistance: number | null; touches: number } {
  const structureImportance = Math.max(...c.members.map((m) => SOURCE_IMPORTANCE[m.source]));
  const touches = historicalTouches(bars, c.low, c.high);
  const historicalTouch = clamp01(touches / 6);

  const atrDistance = atr && atr > 0 ? (c.price - price) / atr : null;
  const reach = REACH_ATR[period];
  const distance =
    atrDistance == null ? 0.5 : clamp01(1 - Math.abs(atrDistance) / (reach * 1.5));

  // 共振：不同来源种类数（同一摆动事实不重复计权，故按 source 去重）
  const distinctSources = new Set(c.members.map((m) => m.source)).size;
  const confluence = clamp01((distinctSources - 1) / 2);

  // 时效：来源里含摆动/中枢这类「近期结构」的给高分
  const recency = c.members.some((m) => m.source === 'swing' || m.source === 'pivot_zone') ? 1 : 0.4;

  const parts = { structureImportance, historicalTouch, distance, confluence, recency };
  const score =
    W.structureImportance * structureImportance +
    W.historicalTouch * historicalTouch +
    W.distance * distance +
    W.confluence * confluence +
    W.recency * recency;
  return { score: Math.round(score * 1e6) / 1e6, parts, atrDistance, touches };
}

// ===== 4.11.3 条件展开白名单 =====

/** 价位角色 → 允许展开的条件（关系 + 用途 + 适用场景） */
const ROLE_CONDITIONS: Record<
  TradeLevelRole,
  Array<{
    relation: 'crossUp' | 'crossDown' | 'holdAbove' | 'holdBelow' | 'touch';
    text: string;
    suitableFor: Array<'trigger' | 'invalidation' | 'target'>;
  }>
> = {
  resistance: [
    { relation: 'holdAbove', text: '收盘有效站上', suitableFor: ['trigger'] },
    { relation: 'crossUp', text: '盘中上穿预警', suitableFor: ['trigger'] },
  ],
  // 支撑位的极性：求值层语义是「失效条件成立 ⇒ 计划失效」，
  // 「收盘守住支撑」成立恰恰说明计划按预期走，只能作触发侧确认；
  // 真正的失效是「收盘跌破」。价格常态在支撑上方，holdBelow 初始不成立，安全。
  //
  // 对称地，resistance 不能加 holdBelow 作失效：计划生效时价格本就在压力位下方，
  // 那条会立即满足导致秒失效；「突破失败后跌回」需要「曾突破」的状态前提，当前规则 DSL 表达不了。
  support: [
    { relation: 'holdAbove', text: '收盘守住', suitableFor: ['trigger'] },
    { relation: 'holdBelow', text: '收盘跌破', suitableFor: ['invalidation'] },
    { relation: 'crossDown', text: '盘中下穿风险', suitableFor: ['invalidation'] },
  ],
  entry_trigger: [
    { relation: 'crossUp', text: '上穿预警', suitableFor: ['trigger'] },
    { relation: 'holdAbove', text: '收盘确认', suitableFor: ['trigger'] },
  ],
  add_trigger: [
    { relation: 'crossUp', text: '上穿预警', suitableFor: ['trigger'] },
    { relation: 'holdAbove', text: '收盘确认', suitableFor: ['trigger'] },
  ],
  invalidation: [
    { relation: 'crossDown', text: '下穿预警', suitableFor: ['invalidation'] },
    { relation: 'holdBelow', text: '收盘失效', suitableFor: ['invalidation'] },
  ],
  stop: [
    { relation: 'crossDown', text: '下穿预警', suitableFor: ['invalidation'] },
    { relation: 'holdBelow', text: '收盘失效', suitableFor: ['invalidation'] },
  ],
  target: [
    { relation: 'touch', text: '触及', suitableFor: ['target'] },
    { relation: 'holdAbove', text: '收盘站上', suitableFor: ['target'] },
  ],
};

function mkCondition(
  base: { contextId: string; timeframe: KlinePeriod },
  purpose: CandidateConditionPurpose,
  rule: PlaybookRule,
  description: string,
  suitableFor: Array<'trigger' | 'invalidation' | 'target'>,
  fromLevelCandidateId: string | null,
  evidenceIds: string[],
  seq: number,
): CandidateCondition {
  return {
    candidateId: `cond:${purpose}:${seq}`,
    contextId: base.contextId,
    candidateModelVersion: CANDIDATE_MODEL_VERSION,
    purpose,
    rule,
    timeframe: base.timeframe,
    description,
    fromLevelCandidateId,
    suitableFor,
    evidenceIds,
    capability: PLAYBOOK_RULE_CAPABILITY[rule.kind] ?? 'live_only',
  };
}

/** 非价格条件：量价确认 / 结构确认 / 时间窗 / 闸门，各自限量 */
function buildNonPriceConditions(
  base: { contextId: string; timeframe: KlinePeriod },
  startSeq: number,
): CandidateCondition[] {
  const out: CandidateCondition[] = [];
  let seq = startSeq;
  const add = (
    purpose: CandidateConditionPurpose,
    rule: PlaybookRule,
    desc: string,
    suitableFor: Array<'trigger' | 'invalidation' | 'target'>,
  ): void => {
    if (out.filter((c) => c.purpose === purpose).length >= PURPOSE_CAP[purpose]) return;
    out.push(mkCondition(base, purpose, rule, desc, suitableFor, null, [], seq++));
  };

  // 量价确认（4 个）
  add('volume_confirm', { kind: 'amountRatio', days: 20, op: 'gte', value: 1.2 }, '成交额比 ≥ 1.20（突破确认量）', ['trigger']);
  add('volume_confirm', { kind: 'closeLocation', op: 'gte', value: 0.67 }, '收盘位置 ≥ 0.67（收在上三分之一）', ['trigger']);
  add('volume_confirm', { kind: 'amountRatio', days: 20, op: 'lte', value: 0.8 }, '成交额比 ≤ 0.80（回踩缩量）', ['trigger']);
  add('volume_confirm', { kind: 'closeLocation', op: 'lte', value: 0.33 }, '收盘位置 ≤ 0.33（收在下三分之一，风险）', ['invalidation']);

  // 结构确认（4 个）
  add('structure_confirm', { kind: 'ma', maType: 'sma', left: 'close', period: 20, relation: 'above' }, '收盘在 MA20 上方', ['trigger']);
  add('structure_confirm', { kind: 'ma', maType: 'sma', left: 'close', period: 20, relation: 'below' }, '收盘跌破 MA20', ['invalidation']);
  add('structure_confirm', { kind: 'macd', signal: 'goldCross' }, 'MACD 金叉', ['trigger']);
  add('structure_confirm', { kind: 'macd', signal: 'deadCross' }, 'MACD 死叉', ['invalidation']);

  // 时间窗：live_only，只此一条，数值与 risk.timeStopBars 共用 TIME_STOP_BARS。
  // 曾经并列产出 bars 与 bars*2 两条、还把后者叫「时间止损」，与 risk 字段的口径对不上。
  const bars = TIME_STOP_BARS;
  add('time_window', { kind: 'barsSincePlan', op: 'gte', value: bars }, `计划生效满 ${bars} 根日线仍未触发（时间止损）`, ['invalidation']);

  return out;
}

/**
 * 标出「当下就已成立」的条件，并把它们从失效用途里摘掉。
 *
 * 求值口径必须与盘中复核一致（evaluate.ts）：用最后一根**已收完**的 bar。
 * 差一根就会两边判不一样——目录说没成立、落库后第一次复核说成立，拦截等于漏网。
 *
 * planBars 传 0：候选阶段还没有计划，`barsSincePlan >= 10` 这类时间止损条件
 * 自然判不成立，不会被误摘（它确实是「将来才会发生」的事）。
 * entryPrice 传 0 同理——rules.ts 对 pnlPct 有 `entryPrice > 0` 的前置判断，
 * 会把这种上下文当「无持仓」直接判否，不会算出 Infinity 之类的假成立。
 */
function markAlreadySatisfied(
  conditions: CandidateCondition[],
  barsByPeriod: Map<PlanPeriod, KlineBar[]>,
  code: string,
): void {
  const seriesCache = new Map<PlanPeriod, { series: Series; i: number } | null>();
  const prep = (period: PlanPeriod): { series: Series; i: number } | null => {
    if (seriesCache.has(period)) return seriesCache.get(period) ?? null;
    const all = barsByPeriod.get(period) ?? [];
    const bars = isBarUnclosed(period, all[all.length - 1]?.time) ? all.slice(0, -1) : all;
    const built =
      bars.length > 0
        ? {
            series: buildSeries(code, bars, [
              { mode: 'all' as const, rules: conditions.filter((c) => c.timeframe === period).map((c) => c.rule) },
            ]),
            i: bars.length - 1,
          }
        : null;
    seriesCache.set(period, built);
    return built;
  };

  for (const c of conditions) {
    const ctx = prep(c.timeframe as PlanPeriod);
    // 取不到 K 线时一律按「未成立」处理：宁可放过一条，也不能因为没数据
    // 就把一批本可用的失效条件全摘掉，那会让整份计划无失效条件可选而降级成观察计划
    if (!ctx) continue;
    let ok = false;
    try {
      ok = evalRule(c.rule, ctx.series, ctx.i, { entryPrice: 0, heldBars: 0, planBars: 0 });
    } catch {
      ok = false;
    }
    if (!ok) continue;
    c.alreadySatisfied = true;
    c.suitableFor = c.suitableFor.filter((r) => r !== 'invalidation');
  }
}

// ===== 生成入口 =====

/** 目录内容哈希：只含影响语义的字段，不含 createdAt，保证同一 fixture 可复现 */
function computeCatalogHash(levels: CandidateLevel[], conditions: CandidateCondition[]): string {
  const payload = JSON.stringify({
    v: CANDIDATE_MODEL_VERSION,
    levels: levels.map((l) => [l.candidateId, l.low, l.high, l.sources, l.compatibleRoles, l.score]),
    conditions: conditions.map((c) => [c.candidateId, c.purpose, c.rule, c.suitableFor]),
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function buildCandidateCatalog(input: CatalogInput): CandidateCatalog {
  const warnings: string[] = [];
  // 三层共用同一个现价与同一把 ATR 尺：日线优先，缺日线才退到给得出现价的那层。
  // 各层用各自的 close 会让「距现价 N 个 ATR」在层间不可比，排序与裁剪就失去意义。
  const anchor =
    input.periods.find((p) => p.period === 'day' && p.levels.close > 0) ??
    input.periods.find((p) => p.levels.close > 0);
  const price = anchor?.levels.close ?? 0;
  const atr = anchor?.levels.atr ?? null;

  // 现价非法（取数失败时 computeLevels 会返回 close=0 的空壳）直接返回空目录：
  // 继续算下去容差会退化、评分会变 NaN，排序结果随引擎实现而变，catalogHash 不再可复现。
  if (!Number.isFinite(price) || price <= 0) {
    return {
      contextId: input.contextId,
      candidateModelVersion: CANDIDATE_MODEL_VERSION,
      catalogHash: 'invalid-price',
      levels: [],
      conditions: [],
      omittedCounts: {},
      warnings: [`现价无效（${price}），无法生成候选目录，只能给观察计划`],
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    };
  }

  const omitted: Record<string, number> = {};
  const bump = (k: string, n: number): void => {
    if (n > 0) omitted[k] = (omitted[k] ?? 0) + n;
  };

  const candidateLevels: CandidateLevel[] = [];
  // 按 PLAN_PERIODS 的顺序遍历而不是按入参顺序，保证 candidateId 编号可复现
  const byPeriod = new Map(input.periods.map((p) => [p.period, p]));
  for (const period of PLAN_PERIODS) {
    const pin = byPeriod.get(period);
    if (!pin) {
      warnings.push(`缺少 ${period} 层数据，该层无候选价位`);
      continue;
    }
    // 适配器执行位（涨跌停价等）只挂日线层：它是当日的执行边界，挂到周线层没有意义
    const { raws, omitted: omit } = collectRawLevels(
      pin,
      price,
      period === 'day' ? input.adapterLevels : [],
    );
    for (const [k, v] of Object.entries(omit)) bump(`${period}.${k}`, v);
    if (raws.length === 0) continue;

    const clusters = clusterLevels(
      raws,
      clusterTolerance(price, atr, undefined, TOLERANCE_SCALE[period]),
    );
    const scored = clusters.map((c) => ({
      cluster: c,
      ...scoreCluster(c, pin.bars, price, atr, period),
      sources: Array.from(new Set(c.members.map((m) => m.source))).sort() as CandidateLevelSource[],
      roles: Array.from(new Set(c.members.flatMap((m) => m.roles))).sort() as TradeLevelRole[],
      guaranteed: c.members.some((m) => m.guaranteed === true),
    }));

    // 排序：保底优先，其次总分降序，最后按价格保证稳定
    scored.sort(
      (a, b) =>
        Number(b.guaranteed) - Number(a.guaranteed) ||
        b.score - a.score ||
        a.cluster.price - b.cluster.price,
    );

    // 层内单侧上限 + 层内总上限
    let above = 0;
    let below = 0;
    const kept: typeof scored = [];
    for (const sc of scored) {
      if (kept.length >= LEVEL_CAP[period]) break;
      const isAbove = sc.cluster.price >= price;
      if (!sc.guaranteed) {
        if (isAbove && above >= SIDE_CAP[period]) continue;
        if (!isAbove && below >= SIDE_CAP[period]) continue;
      }
      if (isAbove) above += 1;
      else below += 1;
      kept.push(sc);
    }
    bump(`${period}.cap`, scored.length - kept.length);

    kept.forEach((sc, i) => {
      candidateLevels.push({
        // id 必须带周期：三层可能给出价格相同的位子，不带周期就会撞 id，
        // 而它们的 timeframe 不同（周线收盘守住 ≠ 60 分钟收盘守住），是两条不同的条件
        // 价格精度与下面 priceLevel 规则取值一致（都是 3 位），否则第 4 位不同的两个价位
        // 会得到不同 candidateId 却编译出完全相同的规则，白占条件配额
        candidateId: `lvl:${period}:${i}:${roundPrice(sc.cluster.price).toFixed(3)}`,
        contextId: input.contextId,
        candidateModelVersion: CANDIDATE_MODEL_VERSION,
        timeframe: period,
        low: sc.cluster.low,
        high: sc.cluster.high,
        price: sc.cluster.price,
        sources: sc.sources,
        compatibleRoles: sc.roles,
        score: sc.score,
        scoreParts: sc.parts,
        atrDistance: sc.atrDistance == null ? null : Math.round(sc.atrDistance * 100) / 100,
        label: sc.cluster.members.map((m) => m.label).join(' + '),
        description:
          `${sc.cluster.low.toFixed(3)}~${sc.cluster.high.toFixed(3)}，来源 ${sc.sources.join('/')}，` +
          `近${TOUCH_LOOKBACK}根${period}触碰 ${sc.touches} 次` +
          (sc.atrDistance != null ? `，距现价 ${sc.atrDistance.toFixed(2)} ATR` : ''),
        sourceEvidenceIds: Array.from(new Set(sc.cluster.members.map((m) => m.evidenceId))).sort(),
        guaranteed: sc.guaranteed,
      });
    });
  }

  if (candidateLevels.length === 0) {
    warnings.push('无可用候选价位来源，计划只能给观察结论');
  }

  // 价位条件：只按角色白名单展开，不做笛卡尔积。timeframe 跟随各自价位所属的层。
  //
  // 遍历顺序按「层内名次」轮转（周线第1名 → 日线第1名 → 60分钟第1名 → 各层第2名 …），
  // 而不是把一层铺完再铺下一层。原因见下面的 CONDITION_CAP 裁剪：
  // 裁剪是从尾部砍的，按层铺的话 21 个价位展开出的 70 多条条件会稳定地把最后一层
  // （60 分钟）整层剃光——实测 60m 层拿到 0 条条件，Phase 2 加这一层要的
  // 「盘中触发点」根本进不了目录，只剩一批没有任何条件引用的空价位。
  // 轮转之后每层砍掉的都是自己层内最靠后的低分位，三层都保得住头部。
  const byRank: CandidateLevel[][] = [];
  for (const period of PLAN_PERIODS) {
    candidateLevels
      .filter((l) => l.timeframe === period)
      .forEach((lv, rank) => {
        (byRank[rank] ??= []).push(lv);
      });
  }
  /** 按价位分组，裁剪时整组进出，避免只留下失效条件却没了触发条件的半截价位 */
  const groupsByLevel: CandidateCondition[][] = [];
  let seq = 0;
  for (const lv of byRank.flat()) {
    const base = { contextId: input.contextId, timeframe: lv.timeframe };
    const group: CandidateCondition[] = [];
    for (const role of lv.compatibleRoles) {
      for (const spec of ROLE_CONDITIONS[role] ?? []) {
        // 同一价位同一 relation 只保留一条，避免多角色重复展开
        if (group.some((c) => c.rule.kind === 'priceLevel' && c.rule.relation === spec.relation)) {
          continue;
        }
        group.push(
          mkCondition(
            base,
            'price_level',
            { kind: 'priceLevel', level: roundPrice(lv.price), relation: spec.relation },
            `${spec.text} ${lv.price.toFixed(3)}`,
            spec.suitableFor,
            lv.candidateId,
            lv.sourceEvidenceIds,
            seq++,
          ),
        );
      }
    }
    if (group.length > 0) groupsByLevel.push(group);
  }
  const priceConditions = groupsByLevel.flat();

  // 非价格条件只产一份，锚在日线。
  // 三层各复制一遍会让「MACD 金叉」这类条件占掉 3 倍配额，把价位条件挤出目录，
  // 而周线 MACD 金叉与 60 分钟 MACD 金叉对同一份计划的增量信息远不如多几个可交易的价位。
  const nonPrice = buildNonPriceConditions({ contextId: input.contextId, timeframe: 'day' }, seq);
  let conditions = [...priceConditions, ...nonPrice];
  if (conditions.length > CONDITION_CAP) {
    // 超总量时裁价位条件。按整个价位为单位裁（groupsByLevel 已按层内名次轮转排好），
    // 砍掉的就是各层名次最靠后的低分位，而不是某一层的全部。
    const budget = Math.max(0, CONDITION_CAP - nonPrice.length);
    const trimmedPrice: CandidateCondition[] = [];
    for (const g of groupsByLevel) {
      if (trimmedPrice.length + g.length > budget) break;
      trimmedPrice.push(...g);
    }
    conditions = [...trimmedPrice, ...nonPrice];
    bump('condition_cap', priceConditions.length - trimmedPrice.length);
  }

  // 必须在算 catalogHash 之前标记：suitableFor 参与哈希，
  // 「MA20 下方不可作失效条件」的目录与允许它的目录本就是两份不同的目录
  markAlreadySatisfied(conditions, new Map(input.periods.map((p) => [p.period, p.bars])), input.code);
  const alreadyTrue = conditions.filter((c) => c.alreadySatisfied).length;
  if (alreadyTrue > 0) {
    warnings.push(`${alreadyTrue} 条条件在建目录时已成立，已从失效用途中摘除（避免计划一落库即失效）`);
  }

  const liveOnly = conditions.filter((c) => c.capability === 'live_only').length;
  if (liveOnly > 0) {
    warnings.push(`含 ${liveOnly} 条实时专用条件（时间窗），不可进入历史回测 spec`);
  }

  return {
    contextId: input.contextId,
    candidateModelVersion: CANDIDATE_MODEL_VERSION,
    catalogHash: computeCatalogHash(candidateLevels, conditions),
    levels: candidateLevels,
    conditions,
    omittedCounts: omitted,
    warnings,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
}

export const CANDIDATE_LIMITS = {
  LEVEL_CAP,
  SIDE_CAP,
  CONDITION_CAP,
  PURPOSE_CAP,
  REACH_ATR,
  TOLERANCE_SCALE,
};
