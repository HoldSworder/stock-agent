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
  PriceLevels,
  SymbolPlanHorizon,
  TradeLevelRole,
} from '@stock-agent/shared';
import { PLAYBOOK_RULE_CAPABILITY } from '@stock-agent/shared';

// 候选目录生成器（计划 4.11）。这是 R1 架构的阻塞级前置能力：
// LLM 只能从这里挑 ID，不允许自由填价格，所以「候选够不够用」直接决定计划质量。
// 全流程确定性：同一份 fixture 两次生成的 catalogHash / 候选ID / 排序必须完全一致。

/** 候选模型版本：聚类容差、评分权重、上限、白名单任一变化都要递增 */
export const CANDIDATE_MODEL_VERSION = 'candidate-v2';

/** 价位数量硬上限（4.11.2） */
const LEVEL_CAP: Record<SymbolPlanHorizon, number> = { next_session: 12, swing: 16 };
/** 单侧上限：原则上现价上下各不超过总量一半 */
const SIDE_CAP: Record<SymbolPlanHorizon, number> = { next_session: 6, swing: 8 };
/** 条件数量硬上限（4.11.3） */
const CONDITION_CAP: Record<SymbolPlanHorizon, number> = { next_session: 24, swing: 32 };
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

export interface CatalogInput {
  contextId: string;
  horizon: SymbolPlanHorizon;
  /** 主周期（日线）K 线，用于触碰次数与现价 */
  bars: KlineBar[];
  timeframe: KlinePeriod;
  /** 复用 market/levels.ts 的产出，不在此重算 ATR/枢轴/斐波/均线 */
  levels: PriceLevels;
  dow: DowStructure | null;
  chan: ChanStructure | null;
  /** 适配器给的执行位（涨跌停价、IOPV 闸门等），与技术支撑压力分开归类 */
  adapterLevels?: Array<{ price: number; label: string; evidenceId: string }>;
  /** 有效期（ISO），到期后 contextId 失效 */
  expiresAt: string;
  createdAt: string;
}

// ===== 4.11.1 原始候选来源 =====

function collectRawLevels(input: CatalogInput): { raws: RawLevel[]; omitted: Record<string, number> } {
  const { levels, dow, chan, bars } = input;
  const price = levels.close;
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
        evidenceId: `ext:high:${input.timeframe}`,
        roles: ['resistance', 'entry_trigger', 'target'],
      });
      raws.push({
        price: lo,
        source: 'prev_extreme',
        label: `前低 ${lo.toFixed(3)}`,
        evidenceId: `ext:low:${input.timeframe}`,
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
      evidenceId: `ma:${input.timeframe}:${m.period}`,
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
        evidenceId: `pivot:${input.timeframe}:r`,
        roles: ['resistance'],
      });
    }
    if (below[0] != null) {
      raws.push({
        price: below[0],
        source: 'classic_pivot',
        label: `枢轴支撑 ${below[0].toFixed(3)}`,
        evidenceId: `pivot:${input.timeframe}:s`,
        roles: ['support'],
      });
    }
    const lastBar = bars[bars.length - 1];
    if (lastBar && p.pp >= lastBar.low && p.pp <= lastBar.high) {
      raws.push({
        price: p.pp,
        source: 'classic_pivot',
        label: `枢轴 PP ${p.pp.toFixed(3)}`,
        evidenceId: `pivot:${input.timeframe}:pp`,
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
      evidenceId: `fib:retr:${f.ratio}`,
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
        evidenceId: `fib:ext:${ext[0].ratio}`,
        roles: ['target'],
      });
    }
  }

  // 适配器执行位：单独归类，不与技术支撑压力混淆
  for (const a of input.adapterLevels ?? []) {
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
export function clusterTolerance(price: number, atr: number | null, tickSize = 0.001): number {
  return Math.max(2 * tickSize, 0.35 * (atr ?? 0), price * 0.002);
}

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
  horizon: SymbolPlanHorizon,
): { score: number; parts: CandidateLevel['scoreParts']; atrDistance: number | null; touches: number } {
  const structureImportance = Math.max(...c.members.map((m) => SOURCE_IMPORTANCE[m.source]));
  const touches = historicalTouches(bars, c.low, c.high);
  const historicalTouch = clamp01(touches / 6);

  const atrDistance = atr && atr > 0 ? (c.price - price) / atr : null;
  // 计划期限内可触达范围：次日约 2×ATR，波段约 6×ATR，超出则降分
  const reach = horizon === 'next_session' ? 2 : 6;
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
  support: [
    { relation: 'holdAbove', text: '收盘保持上方', suitableFor: ['invalidation'] },
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
  horizon: SymbolPlanHorizon,
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

  // 时间窗（2 个）：live_only，仅用于计划有效期与时间止损
  const bars = horizon === 'next_session' ? 1 : 10;
  add('time_window', { kind: 'barsSincePlan', op: 'gte', value: bars }, `计划生效满 ${bars} 根仍未触发`, ['invalidation']);
  add('time_window', { kind: 'barsSincePlan', op: 'gte', value: bars * 2 }, `计划生效满 ${bars * 2} 根（时间止损）`, ['invalidation']);

  return out;
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
  const { horizon, bars, levels } = input;
  const price = levels.close;
  const warnings: string[] = [];

  // 现价非法（取数失败时 computeLevels 会返回 close=0 的空壳）直接返回空目录：
  // 继续算下去容差会退化、评分会变 NaN，排序结果随引擎实现而变，catalogHash 不再可复现。
  if (!Number.isFinite(price) || price <= 0) {
    return {
      contextId: input.contextId,
      candidateModelVersion: CANDIDATE_MODEL_VERSION,
      catalogHash: 'invalid-price',
      horizon,
      levels: [],
      conditions: [],
      omittedCounts: {},
      warnings: [`现价无效（${price}），无法生成候选目录，只能给观察计划`],
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    };
  }

  const { raws, omitted } = collectRawLevels(input);

  if (raws.length === 0) {
    warnings.push('无可用候选价位来源，计划只能给观察结论');
  }

  const tolerance = clusterTolerance(price, levels.atr);
  const clusters = clusterLevels(raws, tolerance);

  // 打分
  const scored = clusters.map((c) => {
    const s = scoreCluster(c, bars, price, levels.atr, horizon);
    const sources = Array.from(new Set(c.members.map((m) => m.source))).sort();
    const roles = Array.from(new Set(c.members.flatMap((m) => m.roles))).sort();
    return {
      cluster: c,
      ...s,
      sources: sources as CandidateLevelSource[],
      roles: roles as TradeLevelRole[],
      guaranteed: c.members.some((m) => m.guaranteed === true),
    };
  });

  // 排序：保底优先，其次总分降序，最后按价格保证稳定
  scored.sort(
    (a, b) =>
      Number(b.guaranteed) - Number(a.guaranteed) ||
      b.score - a.score ||
      a.cluster.price - b.cluster.price,
  );

  // 单侧上限 + 总上限
  const sideCap = SIDE_CAP[horizon];
  let above = 0;
  let below = 0;
  const kept: typeof scored = [];
  for (const s of scored) {
    if (kept.length >= LEVEL_CAP[horizon]) break;
    const isAbove = s.cluster.price >= price;
    if (!s.guaranteed) {
      if (isAbove && above >= sideCap) continue;
      if (!isAbove && below >= sideCap) continue;
    }
    if (isAbove) above += 1;
    else below += 1;
    kept.push(s);
  }
  const droppedByCap = scored.length - kept.length;
  if (droppedByCap > 0) omitted.cap = (omitted.cap ?? 0) + droppedByCap;

  const candidateLevels: CandidateLevel[] = kept.map((s, i) => ({
    // 与下面 priceLevel 规则的取值精度保持一致（都是 3 位），否则第 4 位不同的两个价位
    // 会得到不同 candidateId 却编译出完全相同的规则，白占条件配额
    candidateId: `lvl:${i}:${roundPrice(s.cluster.price).toFixed(3)}`,
    contextId: input.contextId,
    candidateModelVersion: CANDIDATE_MODEL_VERSION,
    timeframe: input.timeframe,
    low: s.cluster.low,
    high: s.cluster.high,
    price: s.cluster.price,
    sources: s.sources,
    compatibleRoles: s.roles,
    score: s.score,
    scoreParts: s.parts,
    atrDistance: s.atrDistance == null ? null : Math.round(s.atrDistance * 100) / 100,
    label: s.cluster.members.map((m) => m.label).join(' + '),
    description:
      `${s.cluster.low.toFixed(3)}~${s.cluster.high.toFixed(3)}，来源 ${s.sources.join('/')}，` +
      `近${TOUCH_LOOKBACK}根触碰 ${s.touches} 次` +
      (s.atrDistance != null ? `，距现价 ${s.atrDistance.toFixed(2)} ATR` : ''),
    sourceEvidenceIds: Array.from(new Set(s.cluster.members.map((m) => m.evidenceId))).sort(),
    guaranteed: s.guaranteed,
  }));

  // 价位条件：只按角色白名单展开，不做笛卡尔积
  const base = { contextId: input.contextId, timeframe: input.timeframe };
  const priceConditions: CandidateCondition[] = [];
  let seq = 0;
  for (const lv of candidateLevels) {
    for (const role of lv.compatibleRoles) {
      for (const spec of ROLE_CONDITIONS[role] ?? []) {
        const rule: PlaybookRule = {
          kind: 'priceLevel',
          level: roundPrice(lv.price),
          relation: spec.relation,
        };
        // 同一价位同一 relation 只保留一条，避免多角色重复展开
        if (
          priceConditions.some(
            (c) =>
              c.fromLevelCandidateId === lv.candidateId &&
              c.rule.kind === 'priceLevel' &&
              c.rule.relation === spec.relation,
          )
        ) {
          continue;
        }
        priceConditions.push(
          mkCondition(
            base,
            'price_level',
            rule,
            `${spec.text} ${lv.price.toFixed(3)}（${lv.label}）`,
            spec.suitableFor,
            lv.candidateId,
            lv.sourceEvidenceIds,
            seq++,
          ),
        );
      }
    }
  }

  const nonPrice = buildNonPriceConditions(base, horizon, seq);
  let conditions = [...priceConditions, ...nonPrice];
  if (conditions.length > CONDITION_CAP[horizon]) {
    // 超总量时先裁价位条件里靠后的（价位本身已按分数排序，靠后即低分）
    const overflow = conditions.length - CONDITION_CAP[horizon];
    const trimmedPrice = priceConditions.slice(0, Math.max(0, priceConditions.length - overflow));
    conditions = [...trimmedPrice, ...nonPrice];
    // 按实际裁掉的条数计，overflow 可能大于价位条件总数，直接用它会虚报
    omitted.condition_cap =
      (omitted.condition_cap ?? 0) + (priceConditions.length - trimmedPrice.length);
  }

  const liveOnly = conditions.filter((c) => c.capability === 'live_only').length;
  if (liveOnly > 0) {
    warnings.push(`含 ${liveOnly} 条实时专用条件（时间窗），不可进入历史回测 spec`);
  }

  return {
    contextId: input.contextId,
    candidateModelVersion: CANDIDATE_MODEL_VERSION,
    catalogHash: computeCatalogHash(candidateLevels, conditions),
    horizon,
    levels: candidateLevels,
    conditions,
    omittedCounts: omitted,
    warnings,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
}

export const CANDIDATE_LIMITS = { LEVEL_CAP, SIDE_CAP, CONDITION_CAP, PURPOSE_CAP };
