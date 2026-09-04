import { and, eq } from 'drizzle-orm';
import type { AssertionSource, KlineBar } from '@stock-agent/shared';
import { CANDIDATE_SOURCE_TO_ASSERTION } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { getKline } from '../market/eastmoney';
import { barsAfter, judgeLevel } from '../assertions/judge';
import { judgePlacebo, PLACEBO_PER_REAL } from '../assertions/placebo';
import {
  bootstrapEdge,
  MIN_BLOCKS,
  WEIGHT_MAX,
  WEIGHT_MIN,
  WEIGHT_PROTOCOL_VERSION,
  weightOf,
  type PairedSample,
} from '../assertions/weights';
import { recomputeWeights, currentWeights, weightsEnabled } from '../assertions/weightService';
import { buildCandidateCatalog } from '../symbolPlans/candidateCatalog';
import { computeChanStructure, computeDowStructure } from '../symbolPlans/structure';
import { computeLevels } from '../market/levels';
import { shanghaiToday } from '../util';

// 价位加权的体检。
//
// 这套权重会影响候选价位的呈现顺序，所以每一条依据都要经得起查：
// 安慰剂必须可复现、加权不许改动候选集合、前向验证不许偷看未来。
// 任何一条不成立，宁可不加权。

const problems: string[] = [];
function fail(msg: string): void {
  problems.push(msg);
  console.log(`  ✗ ${msg}`);
}
function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

const SOURCE_CN: Record<string, string> = {
  dow: '道氏前高前低',
  fib: '黄金分割',
  elliott: '波浪',
  pivot: '枢轴',
  ma: '均线',
  chan: '缠论中枢',
};
const cn = (s: string): string => SOURCE_CN[s] ?? s;

/** 1. 映射表必须穷尽候选来源，且不能把执行位当成技术价位 */
function checkSourceMap(): void {
  console.log('\n=== 来源映射 ===');
  const all = Object.keys(CANDIDATE_SOURCE_TO_ASSERTION);
  if (all.length === 0) fail('映射表是空的');
  const mapped = all.filter((k) => CANDIDATE_SOURCE_TO_ASSERTION[k as never] != null);
  if (CANDIDATE_SOURCE_TO_ASSERTION.adapter !== null) {
    fail('适配器执行位不是技术支撑压力，不该参与加权');
  } else {
    pass(`${all.length} 个候选来源已全部表态，其中 ${mapped.length} 个参与加权、适配器不参与`);
  }
}

/** 2. 安慰剂必须可复现：同输入同种子必得同结果，否则权重就是随机数 */
function checkPlaceboDeterminism(): void {
  console.log('\n=== 安慰剂可复现 ===');
  const bars: KlineBar[] = Array.from({ length: 30 }, (_, i) => ({
    time: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
    open: 10 + Math.sin(i) * 0.3,
    high: 10.3 + Math.sin(i) * 0.3,
    low: 9.7 + Math.sin(i) * 0.3,
    close: 10 + Math.sin(i + 1) * 0.3,
    volume: 1000,
    amount: 10000,
  }));
  const input = {
    id: 'fixed-seed-probe',
    code: '159516',
    period: 'day' as const,
    price: 10.4,
    close: 10,
    atr: 0.2,
    reactionBars: 5,
    dueDate: '2026-06-30',
    today: '2026-07-30',
    bars,
    otherRealPrices: [10.42],
  };
  const a = judgePlacebo(input);
  const b = judgePlacebo(input);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fail('同样的输入跑出了不同的对照结果，权重不可复现也不可审计');
  } else if (a.judged === 0) {
    fail('对照一条都没判出来，说明伪价位没被正常判定');
  } else {
    pass(`同输入同结果（每条真实价位配 ${PLACEBO_PER_REAL} 个伪价位，本次判出 ${a.judged} 个）`);
  }
  if (a.judgedClean > a.judged) {
    fail('排除真实结构后的样本反而变多了，敏感性分析口径有误');
  }
}

/** 3. 加权只许改顺序，不许改候选集合——这是整个设计的安全边界 */
async function checkSortOnlyInvariant(): Promise<void> {
  console.log('\n=== 加权不改候选集合 ===');
  const code = '159516';
  let bars: KlineBar[];
  try {
    bars = await getKline(code, 'day', 260);
  } catch (e) {
    fail(`取不到 K 线，无法验证不变量：${(e as Error).message}`);
    return;
  }
  const levels = computeLevels(code, bars, 'day');
  const build = (reliabilityWeights?: Map<AssertionSource, number>) =>
    buildCandidateCatalog({
      contextId: 'weights-selfcheck',
      code,
      reliabilityWeights,
      periods: [
        {
          period: 'day',
          bars,
          levels,
          dow: computeDowStructure(bars, 'day'),
          chan: computeChanStructure(bars, 'day'),
        },
      ],
      createdAt: '2026-08-03T07:00:00.000Z',
      expiresAt: '2026-08-04T07:00:00.000Z',
    });
  const weights = currentWeights();
  const cat = build();
  const ids = cat.levels.map((l) => l.candidateId).sort();
  const condIds = cat.conditions.map((c) => c.candidateId).sort();
  const hash = cat.catalogHash;

  // 把权重推到两个极端再建一次：集合、条件、指纹都必须一模一样，只有顺序可以变。
  // 取极端值是有意的——如果连最大可能的权重差都撼动不了候选集合，那就不是碰巧没变
  const probe = new Map<AssertionSource, number>(weights);
  probe.set('dow', WEIGHT_MAX);
  probe.set('chan', WEIGHT_MIN);
  const cat2 = build(probe);
  const ids2 = cat2.levels.map((l) => l.candidateId).sort();
  const condIds2 = cat2.conditions.map((c) => c.candidateId).sort();
  if (JSON.stringify(ids) !== JSON.stringify(ids2)) {
    fail('换了权重之后候选价位集合变了，加权已经进入决策链路');
  } else {
    pass(`${ids.length} 个候选价位逐一相等，加权没有增删任何一个`);
  }
  if (JSON.stringify(condIds) !== JSON.stringify(condIds2)) {
    fail('换了权重之后进 AI 计划的条件变了');
  } else {
    pass(`${condIds.length} 条计划条件逐一相等，进计划的东西没变`);
  }
  if (hash !== cat2.catalogHash) {
    fail('目录指纹随权重变化，会让下游误以为目录内容变了');
  } else {
    pass('目录指纹不受权重影响');
  }
  const order1 = cat.levels.map((l) => l.candidateId).join(',');
  const order2 = cat2.levels.map((l) => l.candidateId).join(',');
  console.log(
    order1 === order2
      ? '  · 本次顺序未变（当前权重差异不足以改变名次，属正常）'
      : '  · 呈现顺序已按可信度调整',
  );
}

/**
 * 4. 前向验证：把 K 线截断到切点当日，重新判一遍，绝不读库里的最终 outcome。
 *
 * 读库里的 outcome 等于拿之后的走势给当时打分——那个 outcome 是用完整行情结算出来的。
 * 训练段与留出段之间还要按观察期留空档（purge/embargo），
 * 否则切点前后的记录会共用同一段行情，留出段就不再是「没见过的数据」。
 */
async function checkWalkForward(): Promise<void> {
  console.log('\n=== 前向验证（截断重判，不读最终结果）===');
  const today = shanghaiToday();
  const rows = db
    .select()
    .from(schema.symbolAssertions)
    .where(
      and(eq(schema.symbolAssertions.kind, 'level'), eq(schema.symbolAssertions.period, 'day')),
    )
    .all()
    .filter(
      (r) =>
        r.price != null &&
        r.closeSnapshot != null &&
        r.atrSnapshot != null &&
        r.atrSnapshot > 0 &&
        r.direction != null,
    );
  if (rows.length === 0) {
    fail('账本里没有可用于前向验证的点位记录');
    return;
  }
  const days = [...new Set(rows.map((r) => r.asOf))].sort();
  if (days.length < 4) {
    console.log(`  · 只有 ${days.length} 个交易日，切不出训练段与留出段，跳过`);
    return;
  }
  // 切点取七成处，留出段是切点之后的记录
  const cut = days[Math.floor(days.length * 0.7)];
  const maxReaction = Math.max(...rows.map((r) => r.reactionBars ?? 5));
  // purge/embargo：切点后 maxReaction 天内的记录，其判定窗口与训练段重叠，两边都不要
  const embargoEnd = days.find((d, i) => i >= days.indexOf(cut) + maxReaction) ?? days.at(-1)!;
  const holdout = rows.filter((r) => r.asOf > embargoEnd);
  if (holdout.length === 0) {
    console.log('  · 留出段被空档吃光了，样本还不够做前向验证');
    return;
  }

  const barsOf = new Map<string, KlineBar[]>();
  for (const r of holdout) {
    const key = `${r.code}|${r.secid ?? ''}`;
    if (barsOf.has(key)) continue;
    try {
      barsOf.set(key, await getKline(r.secid ? '' : r.code, 'day', 260, r.secid ?? undefined));
    } catch {
      barsOf.set(key, []);
    }
  }

  const bySource = new Map<AssertionSource, PairedSample[]>();
  let leaked = 0;
  const realPricesOf = new Map<string, number[]>();
  for (const r of holdout) {
    const k = `${r.code}|${r.asOf}`;
    realPricesOf.set(k, [...(realPricesOf.get(k) ?? []), r.price!]);
  }
  for (const r of holdout) {
    const all = barsOf.get(`${r.code}|${r.secid ?? ''}`) ?? [];
    if (all.length === 0) continue;
    const bars = barsAfter(all, r.asOf);
    if (bars.length === 0) continue;
    // 重新判，不用 r.outcome
    const fresh = judgeLevel(
      bars,
      r.price!,
      r.direction as 'up' | 'down',
      r.atrSnapshot!,
      r.reactionBars ?? 5,
      r.dueDate,
      today,
    );
    if (fresh !== 'respected' && fresh !== 'violated') continue;
    if (fresh !== r.outcome) leaked += 1;
    const p = judgePlacebo({
      id: r.id,
      code: r.code,
      period: 'day',
      price: r.price!,
      close: r.closeSnapshot!,
      atr: r.atrSnapshot!,
      reactionBars: r.reactionBars ?? 5,
      dueDate: r.dueDate,
      today,
      bars,
      otherRealPrices: realPricesOf.get(`${r.code}|${r.asOf}`) ?? [],
    });
    if (p.judged === 0) continue;
    const src = r.source as AssertionSource;
    bySource.set(src, [
      ...(bySource.get(src) ?? []),
      { block: r.asOf, realHit: fresh === 'respected', placeboRate: p.hit / p.judged },
    ]);
  }

  console.log(
    `  留出段 ${holdout.length} 条（切点 ${cut}、空档 ${maxReaction} 天到 ${embargoEnd}），` +
      `重判与库里结果不一致 ${leaked} 条`,
  );
  console.log('  命中口径：价格没走到的不进分母；重判为「掉头了」算命中');
  console.log('\n  来源            样本  独立日  真实−安慰剂  下界    权重');
  for (const [source, samples] of [...bySource].sort((a, b) => b[1].length - a[1].length)) {
    const est = bootstrapEdge(samples);
    const w = weightOf(source, est);
    console.log(
      `  ${cn(source).padEnd(14)}${String(est.samples).padStart(4)}` +
        `${String(est.blocks).padStart(7)}` +
        `${`${(est.edge * 100).toFixed(1)}pp`.padStart(12)}` +
        `${`${(est.lower * 100).toFixed(1)}pp`.padStart(8)}` +
        `${w.weight.toFixed(2).padStart(8)}`,
    );
  }
  console.log(
    `\n  只有 ${days.length} 个交易日，切不出多个真正独立的窗口。` +
      '所以权重先跑影子模式：算出来、记下来、不生效，等前向数据显示稳定增益再打开。',
  );
}

/** 5. 全量算一次权重，看落库与护栏是否正常 */
async function checkRecompute(): Promise<void> {
  console.log('\n=== 全量重算（影子模式）===');
  const out = await recomputeWeights();
  if (out.length === 0) {
    fail('一个来源都没算出权重');
    return;
  }
  console.log(`  协议版本 ${WEIGHT_PROTOCOL_VERSION}，权重钳在 [${WEIGHT_MIN}, ${WEIGHT_MAX}]`);
  for (const w of out) {
    console.log(`  ${cn(w.source).padEnd(14)}${w.weight.toFixed(2)}  ${w.reason}`);
  }
  const bad = out.filter((w) => w.weight < WEIGHT_MIN - 1e-9 || w.weight > WEIGHT_MAX + 1e-9);
  if (bad.length > 0) fail(`${bad.length} 个来源的权重越过了钳位边界`);
  else pass('所有权重都在钳位范围内');
  const thin = out.filter((w) => w.estimate.blocks < MIN_BLOCKS && w.weight !== 1);
  if (thin.length > 0) fail(`${thin.length} 个来源样本不足 ${MIN_BLOCKS} 个日期却拿到了非中性权重`);
  else pass(`样本不足 ${MIN_BLOCKS} 个独立日期的一律中性`);
}

/** 6. 影子模式必须是默认状态：数据还不支持让权重真的改变排序 */
function checkShadowMode(): void {
  console.log('\n=== 生效开关 ===');
  if (weightsEnabled()) {
    fail('权重已在影响排序，但前向验证还没显示出稳定增益，应保持影子模式');
  } else {
    pass('影子模式：权重照算照留痕，不影响任何排序');
  }
  if (currentWeights().size !== 0) {
    fail('影子模式下仍然取到了非空权重表，候选排序会被影响');
  } else {
    pass('候选目录取到的是空权重表，排序与未加权时完全一致');
  }
}

async function main(): Promise<void> {
  console.log('价位加权体检');
  checkSourceMap();
  checkShadowMode();
  checkPlaceboDeterminism();
  await checkSortOnlyInvariant();
  await checkRecompute();
  await checkWalkForward();
  console.log(`\n问题 ${problems.length} 项`);
  if (problems.length > 0) {
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    '✅ 价位加权体检通过（映射穷尽 · 安慰剂可复现 · 加权不改候选集合 · 权重已钳位 · 前向验证不读最终结果）',
  );
}

void main();
