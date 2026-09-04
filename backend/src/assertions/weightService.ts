import { and, desc, eq } from 'drizzle-orm';
import type { AssertionSource, KlineBar, KlinePeriod } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { getMeta, setMeta } from '../settings';
import { newId, nowIso, shanghaiToday } from '../util';
import { getKline } from '../market/eastmoney';
import { barsAfter } from './judge';
import { judgePlacebo, PLACEBO_PER_REAL } from './placebo';
import {
  bootstrapEdge,
  NEUTRAL_WEIGHT,
  WEIGHT_PROTOCOL_VERSION,
  weightOf,
  type PairedSample,
  type SourceWeight,
} from './weights';

// 权重的计算、落库与读取。
//
// 整条链路：已判定的价位记录 → 为每条造同距离的安慰剂对照 → 按日期分块配对 bootstrap
// → 增益下界 → 确定性映射成权重 → 平滑/滞回/熔断 → 落库留痕 → 供候选排序取用。
//
// 纪律：这里只算权重、不改任何候选。加权在 candidateCatalog 那侧生效，
// 且**只影响顺序不影响集合**，这样最坏情况下也只是把好的排后面，不会让某个价位凭空消失。

/** 只对这个周期的记录算权重。账本目前只冻结日线，拿日线成绩去权周线是没有依据的 */
const WEIGHT_PERIOD: KlinePeriod = 'day';

/**
 * 生效开关的内部键。**默认关闭**，也就是影子模式：权重照算照留痕，但不影响任何排序。
 *
 * 默认关而不是默认开，是因为首轮安慰剂对照的结论不支持加权——
 * 六套方法没有一套比「同样远近的随机价位」更强，最强的道氏反而弱 3.2 个百分点。
 * 在这种情况下打开权重，等于拿一个还没被证明存在的优势去改变排序。
 * 开关就绪，等前向数据显示出稳定增益再打开。
 */
const ENABLE_KEY = 'assertion_weight_enabled';

/** 取多少根线做安慰剂判定，与结算侧同量级 */
const BARS_LIMIT = 260;

/** 权重是否真的在影响排序。未显式打开就是影子模式 */
export function weightsEnabled(): boolean {
  return getMeta(ENABLE_KEY) === '1';
}

/** 一键开关。关掉后立刻回到中性，不必等下一次计算 */
export function setWeightsEnabled(on: boolean): void {
  setMeta(ENABLE_KEY, on ? '1' : '0');
}

/**
 * 当前生效的权重表。
 *
 * 任何异常都退回中性而不是抛错：这套权重是锦上添花，
 * 它坏掉时正确的行为是回到今天的排序，而不是让候选目录整个不可用。
 */
export function currentWeights(): Map<AssertionSource, number> {
  const m = new Map<AssertionSource, number>();
  // 影子模式下返回空表，候选目录会原样保留今天的顺序
  if (!weightsEnabled()) return m;
  try {
    const latest = db
      .select()
      .from(schema.assertionSourceWeights)
      .where(eq(schema.assertionSourceWeights.protocolVersion, WEIGHT_PROTOCOL_VERSION))
      .orderBy(desc(schema.assertionSourceWeights.asOf))
      .all();
    if (latest.length === 0) return m;
    const newest = latest[0].asOf;
    for (const r of latest) {
      if (r.asOf !== newest) break;
      m.set(r.source as AssertionSource, r.weight);
    }
  } catch {
    return new Map();
  }
  return m;
}

/** 上一次的权重，供平滑与滞回用 */
function previousWeights(beforeAsOf: string): Map<AssertionSource, number> {
  const m = new Map<AssertionSource, number>();
  const rows = db
    .select()
    .from(schema.assertionSourceWeights)
    .where(eq(schema.assertionSourceWeights.protocolVersion, WEIGHT_PROTOCOL_VERSION))
    .orderBy(desc(schema.assertionSourceWeights.asOf))
    .all()
    .filter((r) => r.asOf < beforeAsOf);
  if (rows.length === 0) return m;
  const newest = rows[0].asOf;
  for (const r of rows) {
    if (r.asOf !== newest) break;
    m.set(r.source as AssertionSource, r.weight);
  }
  return m;
}

/**
 * 重算权重并落库。
 *
 * @param asOf 基准日。只用该日之前已经判出结果的记录，避免拿当天还没走完的样本算权重
 */
export async function recomputeWeights(asOf = shanghaiToday()): Promise<SourceWeight[]> {
  const rows = db
    .select()
    .from(schema.symbolAssertions)
    .where(
      and(
        eq(schema.symbolAssertions.kind, 'level'),
        eq(schema.symbolAssertions.period, WEIGHT_PERIOD),
      ),
    )
    .all()
    .filter(
      (r) =>
        (r.outcome === 'respected' || r.outcome === 'violated') &&
        r.asOf <= asOf &&
        r.price != null &&
        r.closeSnapshot != null &&
        r.atrSnapshot != null &&
        r.atrSnapshot > 0,
    );

  // 同一标的的 K 线取一次就够。安慰剂要和真实记录用**同一批 bar**，否则比的不是同一段行情
  const barsOf = new Map<string, KlineBar[]>();
  for (const r of rows) {
    const key = `${r.code}|${r.secid ?? ''}`;
    if (barsOf.has(key)) continue;
    try {
      const fetchCode = r.secid ? '' : r.code;
      barsOf.set(
        key,
        await getKline(fetchCode, WEIGHT_PERIOD, BARS_LIMIT, r.secid ?? undefined),
      );
    } catch {
      barsOf.set(key, []);
    }
  }

  // 同一天同一标的的其他真实价位，供安慰剂做敏感性分析时避开
  const realPricesOf = new Map<string, number[]>();
  for (const r of rows) {
    const k = `${r.code}|${r.asOf}`;
    const arr = realPricesOf.get(k) ?? [];
    arr.push(r.price!);
    realPricesOf.set(k, arr);
  }

  const bySource = new Map<AssertionSource, PairedSample[]>();
  for (const r of rows) {
    const all = barsOf.get(`${r.code}|${r.secid ?? ''}`) ?? [];
    if (all.length === 0) continue;
    const bars = barsAfter(all, r.asOf);
    if (bars.length === 0) continue;
    const p = judgePlacebo({
      id: r.id,
      code: r.code,
      period: WEIGHT_PERIOD,
      price: r.price!,
      close: r.closeSnapshot!,
      atr: r.atrSnapshot!,
      reactionBars: r.reactionBars ?? 5,
      dueDate: r.dueDate,
      today: asOf,
      bars,
      otherRealPrices: realPricesOf.get(`${r.code}|${r.asOf}`) ?? [],
    });
    // 一个伪价位都没判出来就没法配对，这条真实记录本轮不参与
    if (p.judged === 0) continue;
    const src = r.source as AssertionSource;
    const arr = bySource.get(src) ?? [];
    arr.push({
      // 分块键取记录日：同一天的判断受同一波行情驱动，重采样必须整块一起抽
      block: r.asOf,
      realHit: r.outcome === 'respected',
      placeboRate: p.hit / p.judged,
    });
    bySource.set(src, arr);
  }

  const prev = previousWeights(asOf);
  const out: SourceWeight[] = [];
  const now = nowIso();
  db.transaction(() => {
    for (const [source, samples] of bySource) {
      const est = bootstrapEdge(samples);
      const w = weightOf(source, est, prev.get(source));
      out.push(w);
      db.insert(schema.assertionSourceWeights)
        .values({
          id: newId(),
          asOf,
          protocolVersion: WEIGHT_PROTOCOL_VERSION,
          source,
          weight: w.weight,
          prevWeight: prev.get(source) ?? null,
          edge: est.edge,
          edgeLower: est.lower,
          blocks: est.blocks,
          samples: est.samples,
          reason: w.reason,
          createdAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
  });
  return out.sort((a, b) => b.weight - a.weight);
}

/**
 * 熔断：样本量比上一次骤降就把权重按回中性。
 *
 * 触发场景是取数故障或跟踪范围变动——此时统计的基础已经变了，
 * 继续沿用昨天的权重就是拿旧证据指挥今天的排序。
 */
export function tripBreakerIfSampleCollapsed(asOf = shanghaiToday()): string | null {
  const cur = db
    .select()
    .from(schema.assertionSourceWeights)
    .where(
      and(
        eq(schema.assertionSourceWeights.asOf, asOf),
        eq(schema.assertionSourceWeights.protocolVersion, WEIGHT_PROTOCOL_VERSION),
      ),
    )
    .all();
  if (cur.length === 0) return null;
  const prevRows = db
    .select()
    .from(schema.assertionSourceWeights)
    .where(eq(schema.assertionSourceWeights.protocolVersion, WEIGHT_PROTOCOL_VERSION))
    .orderBy(desc(schema.assertionSourceWeights.asOf))
    .all()
    .filter((r) => r.asOf < asOf);
  if (prevRows.length === 0) return null;
  const prevDay = prevRows[0].asOf;
  const prevTotal = prevRows
    .filter((r) => r.asOf === prevDay)
    .reduce((s, r) => s + (r.samples ?? 0), 0);
  const curTotal = cur.reduce((s, r) => s + (r.samples ?? 0), 0);
  // 样本掉到上一次的一半以下，视为统计基础异常
  if (prevTotal > 0 && curTotal < prevTotal * 0.5) {
    db.transaction(() => {
      for (const r of cur) {
        db.update(schema.assertionSourceWeights)
          .set({
            weight: NEUTRAL_WEIGHT,
            reason: `样本从 ${prevTotal} 条掉到 ${curTotal} 条，统计基础异常，本次回到不加权`,
          })
          .where(eq(schema.assertionSourceWeights.id, r.id))
          .run();
      }
    });
    return `样本骤降（${prevTotal} → ${curTotal}），已熔断回中性`;
  }
  return null;
}

/** 每条真实记录配几个伪价位，供报告说明用 */
export { PLACEBO_PER_REAL };
