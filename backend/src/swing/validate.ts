import { and, desc, eq } from 'drizzle-orm';
import type { KlineBar } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso, shanghaiToday } from '../util';
import { getKline } from '../datasource/scheduler';
import { judge } from '../symbolPlans/forecast';
import { bootstrapEdge, type PairedSample } from '../assertions/weights';
import { currentRuleVersion, VALIDATION_GATE } from './ruleVersion';
import { TIME_STOP_TRADE_DAYS } from './advice';
import { judgeSwing, dropUnclosedBar } from './judge';

// 阶段二：这套判断到底有没有用。
//
// 要回答的问题是：**出现信号那天入场，是不是真的比随便挑一天入场更好。**
//
// 这跟仓库里已有的那次安慰剂对照不是一回事，区别关键且必须说清：
// 那次检验的是「某条画出来的价位被碰到后会不会掉头」，对照组是**随机价位**
// （见 assertions/placebo.ts），结论是六套画线方法没一套强于随机。
// 而这里检验的是**方向性时序信号**，对照组必须是**随机的非信号日期**。
// 前者的结论不能外推到这里——但也不构成本方案有效的证据，所以才要单独做这件事。
//
// 三个防作弊设计，缺一个整套统计就没意义：
//  1) 样本只取规则定版之后的 live 数据（见 ruleVersion.isValidationEligible）。
//     否则调完参数拿旧数据给自己验收，胜率是编出来的。
//  2) 同代码同方向 20 个交易日内只算一个事件。连续几天反复触发是同一波行情，
//     当成多个独立样本会把有效样本量虚增几倍。
//  3) 重采样按**自然周**分块，不按交易日。同一周内的信号受同一波行情驱动，
//     按日分块会低估不确定性（bootstrapEdge 原本按日分块，是为价位类判断设计的）。

/** 每次统计最多回看多少根日线，够覆盖观察窗口与事件去重窗口 */
const BARS_LIMIT = 120;

/**
 * 自然周分块键：ISO 周（年 + 周序号）。
 *
 * **必须按 UTC 解析纯日期**，不能写成 `${date}T00:00:00+08:00`。
 * 那样构造出的 Date 其 UTC 时刻是前一天 16:00，getUTCDay() 取到的星期整体偏一天，
 * 结果周一和周三会被算进不同的周（自检抓到过：2026-09-07 判 W36、2026-09-09 判 W37）。
 * 这里只需要「这个日历日属于哪一周」，不涉及真实时刻，按 UTC 解析最干净。
 */
export function weekKey(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  // 移到该 ISO 周的周四，周序号按周四所属年份计算
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 可复现伪随机，与 weights.ts / placebo.ts 同一套实现 */
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
 * 从快照里挑出可进入验收的真实信号事件，并做去重。
 *
 * 只收二级信号：一级只说明力道在衰减，永远只拿试探仓、不参与放大资格的判定。
 */
export function collectEvents(direction: 'bottom' | 'top'): Array<{
  code: string;
  tradeDate: string;
  barTime: string;
  close: number;
  atr14: number;
}> {
  const cur = currentRuleVersion();
  if (!cur) return [];
  const grade = direction === 'bottom' ? 'turn_confirmed_bottom' : 'turn_confirmed_top';
  const rows = db
    .select()
    .from(schema.swingSnapshots)
    .where(
      and(
        eq(schema.swingSnapshots.ruleVersion, cur.version),
        eq(schema.swingSnapshots.ruleHash, cur.ruleHash),
        eq(schema.swingSnapshots.grade, grade),
        eq(schema.swingSnapshots.period, 'day'),
        eq(schema.swingSnapshots.validationEligible, true),
      ),
    )
    .orderBy(schema.swingSnapshots.tradeDate)
    .all();

  // 同代码同方向 20 个交易日内只算一个事件。
  // 用日历天近似交易日（20 个交易日约 28 个日历天）——
  // 近似偏保守：宁可少算几个事件，也不要把同一波行情当成多个独立样本
  const dedupeDays = Math.ceil(VALIDATION_GATE.eventDedupeTradeDays * 1.4);
  const lastByCode = new Map<string, string>();
  const out: Array<{
    code: string;
    tradeDate: string;
    barTime: string;
    close: number;
    atr14: number;
  }> = [];
  for (const r of rows) {
    if (r.atr14 == null || !(r.atr14 > 0) || !(r.close > 0) || !r.barTime) continue;
    const prev = lastByCode.get(r.code);
    if (prev) {
      const gap = (new Date(r.tradeDate).getTime() - new Date(prev).getTime()) / 86400_000;
      if (gap < dedupeDays) continue;
    }
    lastByCode.set(r.code, r.tradeDate);
    out.push({
      code: r.code,
      tradeDate: r.tradeDate,
      barTime: r.barTime,
      close: r.close,
      atr14: r.atr14,
    });
  }
  return out;
}

/**
 * 为一个真实事件挑对照日。
 *
 * 对照日的四个条件，每一个都在防一种把结论做漂亮的方式：
 *  - 同一只标的：不同标的的波动天差地别，跨标的比等于比波动率
 *  - 当天不成立同向信号：否则对照组里混进了信号日，两组的差异被抹平
 *  - 距事件日前后各 20 个交易日以外：否则对照日落在同一波行情里
 *  - 观察窗口完整：距数据末尾不足 20 个交易日的日子，结果还没走完
 */
function pickControlDates(
  bars: KlineBar[],
  eventDate: string,
  direction: 'bottom' | 'top',
  count: number,
  rnd: () => number,
): number[] {
  const observe = VALIDATION_GATE.observeTradeDays;
  const excludeSpan = VALIDATION_GATE.eventDedupeTradeDays;
  const eventIdx = bars.findIndex((b) => b.time.slice(0, 10) === eventDate);
  const candidates: number[] = [];
  for (let i = 60; i < bars.length - observe; i += 1) {
    if (eventIdx >= 0 && Math.abs(i - eventIdx) <= excludeSpan) continue;
    // 当天不能自己也是同向信号日
    const sub = bars.slice(0, i + 1);
    const j = judgeSwing(sub, 'day');
    const isSignal =
      direction === 'bottom'
        ? j.grade === 'turn_confirmed_bottom' || j.grade === 'risk_easing_bottom'
        : j.grade === 'turn_confirmed_top' || j.grade === 'risk_easing_top';
    if (isSignal) continue;
    candidates.push(i);
  }
  // 固定种子的随机抽取，保证同输入同结果
  const picked: number[] = [];
  const pool = [...candidates];
  while (picked.length < count && pool.length > 0) {
    const k = Math.floor(rnd() * pool.length);
    picked.push(pool[k]);
    pool.splice(k, 1);
  }
  return picked;
}

/**
 * 放大考试和真实出场用同一套。
 * 区间上沿买入的 1R 是 1.25 倍 ATR（区间 0.75 + 止损 0.5）。
 * 达到 1R 算走出预期，跌到存档止损算失效。第 10 个交易日仍没到 1R 按时间退出。
 * 不用 2 倍 ATR 对 1 倍 ATR。观察从信号的下一根开始，信号当天不计入。
 * 对照是随机非信号日，和信号同一口径。
 */
function judgeSample(
  bars: KlineBar[],
  fromIndex: number,
  basePrice: number,
  atr14: number,
  direction: 'bottom' | 'top',
): { outcome: 'hit' | 'miss' | 'timeout'; target: number; invalid: number } {
  const up = direction === 'bottom';
  const oneR = 1.25 * atr14;
  const target = up ? basePrice + oneR : basePrice - oneR;
  const invalid = up ? basePrice - oneR : basePrice + oneR;
  const window = bars.slice(fromIndex + 1, fromIndex + 1 + TIME_STOP_TRADE_DAYS);
  if (window.length === 0) return { outcome: 'timeout', target, invalid };
  const since = `${bars[fromIndex].time.slice(0, 10)}T15:00:00+08:00`;
  const dueDate = window[window.length - 1].time.slice(0, 10);
  const res = judge(
    window.map((b) => ({ time: b.time, high: b.high, low: b.low })),
    since,
    basePrice,
    target,
    invalid,
    dueDate,
    shanghaiToday(),
  );
  // null 表示还没到期也没触及任何一边：观察窗口未走完，按未结算处理
  if (res == null) return { outcome: 'timeout', target, invalid };
  return { outcome: res, target, invalid };
}

export interface ValidateResult {
  direction: 'bottom' | 'top';
  verdict: 'passed' | 'rejected' | 'insufficient';
  eventCount: number;
  tradeDateCount: number;
  blockCount: number;
  realRate: number;
  controlRate: number;
  edge: number;
  edgeLower: number;
  shortfalls: string[];
}

/**
 * 跑一个方向的验收。
 *
 * 样本不够时返回 insufficient 而不是 rejected——「还没检验够」和「检验过不合格」
 * 是两件不同的事，混为一谈会让人以为规则已经被否决了。
 */
export async function validateDirection(
  direction: 'bottom' | 'top',
): Promise<ValidateResult> {
  const cur = currentRuleVersion();
  const shortfalls: string[] = [];
  if (!cur) {
    return {
      direction,
      verdict: 'insufficient',
      eventCount: 0,
      tradeDateCount: 0,
      blockCount: 0,
      realRate: 0,
      controlRate: 0,
      edge: 0,
      edgeLower: 0,
      shortfalls: ['规则还没定版'],
    };
  }

  const events = collectEvents(direction);
  const rnd = seeded(20260907);
  const paired: PairedSample[] = [];
  const sampleRows: Array<typeof schema.swingValidationSamples.$inferInsert> = [];
  const tradeDates = new Set<string>();
  const blocks = new Set<string>();
  const tracks = new Set<string>();
  const codeCount = new Map<string, number>();
  let realHits = 0;
  let controlHitSum = 0;
  let settled = 0;

  for (const ev of events) {
    let bars: KlineBar[];
    try {
      bars = dropUnclosedBar(await getKline(ev.code, 'day', BARS_LIMIT));
    } catch {
      continue;
    }
    const idx = bars.findIndex((b) => b.time.slice(0, 10) === ev.tradeDate);
    if (idx < 0) continue;

    const real = judgeSample(bars, idx, ev.close, ev.atr14, direction);
    // 观察窗口还没走完的事件不计入分母：它既不是命中也不是未命中，
    // 硬算成失败会把结论压低，算成成功则是往高了修
    if (real.outcome === 'timeout' && idx + VALIDATION_GATE.observeTradeDays >= bars.length) {
      continue;
    }
    const eventKey = `${ev.code}:${ev.tradeDate}:${direction}`;
    const block = weekKey(ev.tradeDate);

    // 对照日
    const controlIdx = pickControlDates(
      bars,
      ev.tradeDate,
      direction,
      VALIDATION_GATE.controlsPerEvent,
      rnd,
    );
    if (controlIdx.length === 0) continue;
    let ctrlHit = 0;
    for (const ci of controlIdx) {
      const c = judgeSample(bars, ci, bars[ci].close, ev.atr14, direction);
      if (c.outcome === 'hit') ctrlHit += 1;
      sampleRows.push({
        id: newId(),
        ruleVersion: cur.version,
        ruleHash: cur.ruleHash,
        code: ev.code,
        direction,
        kind: 'control',
        eventKey,
        blockKey: block,
        tradeDate: bars[ci].time.slice(0, 10),
        barTime: bars[ci].time,
        basePrice: bars[ci].close,
        atr14: ev.atr14,
        targetPrice: c.target,
        invalidPrice: c.invalid,
        marketPhase: null,
        track: '',
        outcome: c.outcome,
        settledAt: nowIso(),
        createdAt: nowIso(),
      });
    }
    const controlRate = ctrlHit / controlIdx.length;

    sampleRows.push({
      id: newId(),
      ruleVersion: cur.version,
      ruleHash: cur.ruleHash,
      code: ev.code,
      direction,
      kind: 'real',
      eventKey,
      blockKey: block,
      tradeDate: ev.tradeDate,
      barTime: ev.barTime,
      basePrice: ev.close,
      atr14: ev.atr14,
      targetPrice: real.target,
      invalidPrice: real.invalid,
      marketPhase: null,
      track: '',
      outcome: real.outcome,
      settledAt: nowIso(),
      createdAt: nowIso(),
    });

    paired.push({ block, realHit: real.outcome === 'hit', placeboRate: controlRate });
    if (real.outcome === 'hit') realHits += 1;
    controlHitSum += controlRate;
    settled += 1;
    tradeDates.add(ev.tradeDate);
    blocks.add(block);
    codeCount.set(ev.code, (codeCount.get(ev.code) ?? 0) + 1);
  }

  // 落库：先清掉本版本旧样本再写，避免重复统计
  db.transaction((tx) => {
    tx.delete(schema.swingValidationSamples)
      .where(
        and(
          eq(schema.swingValidationSamples.ruleVersion, cur.version),
          eq(schema.swingValidationSamples.direction, direction),
        ),
      )
      .run();
    for (const r of sampleRows) tx.insert(schema.swingValidationSamples).values(r).run();
  });

  const est = bootstrapEdge(paired, VALIDATION_GATE.bootstrapIterations);
  const realRate = settled > 0 ? (realHits / settled) * 100 : 0;
  const controlRate = settled > 0 ? (controlHitSum / settled) * 100 : 0;
  const edgePoints = est.edge * 100;
  const edgeLowerPoints = est.lower * 100;

  // 逐条对门槛，缺什么说什么。用「还差多少」而不是布尔值，
  // 是为了页面能如实告诉使用者现在到哪一步了
  if (settled < VALIDATION_GATE.minEventsPerDirection) {
    shortfalls.push(
      `独立信号次数 ${settled}，还需要 ${VALIDATION_GATE.minEventsPerDirection - settled} 次`,
    );
  }
  if (tradeDates.size < VALIDATION_GATE.minTradeDatesPerDirection) {
    shortfalls.push(
      `信号分布在 ${tradeDates.size} 个交易日，需要至少 ${VALIDATION_GATE.minTradeDatesPerDirection} 个`,
    );
  }
  if (blocks.size < VALIDATION_GATE.minBlocksPerDirection) {
    shortfalls.push(
      `信号分布在 ${blocks.size} 周，需要至少 ${VALIDATION_GATE.minBlocksPerDirection} 周`,
    );
  }
  const maxShare = settled > 0 ? Math.max(...[...codeCount.values()]) / settled : 0;
  if (settled > 0 && maxShare > VALIDATION_GATE.maxSingleCodeSharePct / 100) {
    shortfalls.push(
      `样本过于集中在单只标的（占 ${(maxShare * 100).toFixed(0)}%，上限 ${VALIDATION_GATE.maxSingleCodeSharePct}%）`,
    );
  }
  const sampleEnough = shortfalls.length === 0;

  if (sampleEnough) {
    // 45% 只说明旧考试赔率，不能单独当作试探仓有正期望。
    if (edgePoints < VALIDATION_GATE.minEdgePoints) {
      shortfalls.push(
        `比随便挑日子只强 ${edgePoints.toFixed(1)} 个百分点，要求至少 ${VALIDATION_GATE.minEdgePoints} 个`,
      );
    }
    if (edgeLowerPoints < VALIDATION_GATE.minEdgeLowerPoints) {
      shortfalls.push(
        `保守估计只强 ${edgeLowerPoints.toFixed(1)} 个百分点，要求至少 ${VALIDATION_GATE.minEdgeLowerPoints} 个`,
      );
    }
  }

  const verdict: ValidateResult['verdict'] = !sampleEnough
    ? 'insufficient'
    : shortfalls.length === 0
      ? 'passed'
      : 'rejected';

  const result: ValidateResult = {
    direction,
    verdict,
    eventCount: settled,
    tradeDateCount: tradeDates.size,
    blockCount: blocks.size,
    realRate,
    controlRate,
    edge: edgePoints,
    edgeLower: edgeLowerPoints,
    shortfalls,
  };

  db.insert(schema.swingValidationResults)
    .values({
      id: newId(),
      ruleVersion: cur.version,
      ruleHash: cur.ruleHash,
      direction,
      verdict,
      eventCount: settled,
      tradeDateCount: tradeDates.size,
      blockCount: blocks.size,
      realRate,
      controlRate,
      edge: edgePoints,
      edgeLower: edgeLowerPoints,
      shortfalls: JSON.stringify(shortfalls),
      computedAt: nowIso(),
    })
    .run();

  void tracks;
  return result;
}

/** 跑两个方向的验收 */
export async function runValidation(): Promise<ValidateResult[]> {
  return [await validateDirection('bottom'), await validateDirection('top')];
}

/** 最近一次验收结果 */
export function latestResults(): Array<typeof schema.swingValidationResults.$inferSelect> {
  const cur = currentRuleVersion();
  if (!cur) return [];
  return (['bottom', 'top'] as const)
    .map(
      (d) =>
        db
          .select()
          .from(schema.swingValidationResults)
          .where(
            and(
              eq(schema.swingValidationResults.ruleVersion, cur.version),
              eq(schema.swingValidationResults.direction, d),
            ),
          )
          .orderBy(desc(schema.swingValidationResults.computedAt))
          .limit(1)
          .all()[0],
    )
    .filter((x): x is NonNullable<typeof x> => x != null);
}
