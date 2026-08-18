// 计划条件分频求值自检（无框架，assert 断言）。对应 R19 的可验收约束：
// - tick 级只做纯价格比较，绝不调 buildSeries；
// - 技术条件按新 bar 求值一次，同一 bar 内不重复报「刚触发」；
// - buildSeries 调用次数与新 bar 数同阶，而非 quote tick 数同阶；
// - 多个活跃计划复用同一序列缓存。
// 不碰网络，跑在临时 sqlite 上。运行：cd backend && pnpm exec tsx src/scripts/symbolPlanEval.selfcheck.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KlineBar, KlinePeriod, PlanCondition, SymbolTradePlan } from '@stock-agent/shared';

const tmpDir = mkdtempSync(join(tmpdir(), 'symbolplaneval-selfcheck-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

const { ensureSchema } = await import('../db/migrate');
const ev = await import('../symbolPlans/evaluate');
const repo = await import('../symbolPlans/repo');
const { isBarUnclosed } = await import('../symbolPlans/sessionClock');

ensureSchema();

const dayAt = (i: number): string =>
  new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString().slice(0, 10);

function ramp(from: number, to: number, n: number): KlineBar[] {
  const bars: KlineBar[] = [];
  for (let k = 1; k <= n; k++) {
    const px = from + ((to - from) * k) / n;
    bars.push({ time: dayAt(k - 1), open: px, high: px * 1.01, low: px * 0.99, close: px, volume: 1000, amount: px * 1000 });
  }
  return bars;
}

const BARS = ramp(90, 110, 60);
const LAST = BARS[BARS.length - 1].close;

function cond(id: string, rule: PlanCondition['rule'], timeframe: KlinePeriod = 'day'): PlanCondition {
  return { id, rule, timeframe, description: `${id}`, required: true, evidenceIds: [] };
}

function mkPlan(over: Partial<SymbolTradePlan> = {}): SymbolTradePlan {
  return {
    id: 'plan-1',
    version: 1,
    code: '159516',
    name: 'ETF',
    assetType: 'etf',
    secid: '0.159516',
    status: 'active',
    asOf: dayAt(59),
    validFrom: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    dataStatus: 'complete',
    marketPhase: 'uptrend',
    trendState: 'uptrend',
    chanSetup: 'none',
    marketAction: 'probe',
    primaryAction: 'probe',
    summary: 's',
    changes: [],
    levels: [],
    scenarios: [
      {
        id: 'sc1',
        rank: 'primary',
        name: '突破试仓',
        action: 'probe',
        // 一个 tick 级（上穿）+ 一个 bar 级（收盘在 MA20 上方）
        conditions: [
          cond('c-tick', { kind: 'priceLevel', level: LAST * 0.999, relation: 'crossUp' }),
          cond('c-bar', { kind: 'ma', maType: 'sma', left: 'close', period: 20, relation: 'above' }),
        ],
        invalidConditions: [
          cond('c-inval', { kind: 'priceLevel', level: LAST * 0.8, relation: 'holdBelow' }),
        ],
        targetLevelIds: [],
      },
    ],
    positionContext: null,
    risk: {
      structuralStop: null,
      volatilityStop: null,
      executionStop: null,
      atrPct: null,
      maxAccountRiskPct: 1,
      suggestedPositionPct: null,
      timeStopBars: null,
      gapRiskNote: null,
      allowedShares: null,
      reduceShares: null,
      effectiveLossPct: null,
      sizingBasisPrice: null,
    },
    exitPlan: {
      firstTakeProfitLevelId: null,
      secondTakeProfitLevelId: null,
      trailingRule: null,
      reduceFractions: [],
      profitProtectionRule: null,
    },
    execution: {
      chaseGuardAtr: null,
      maxPremiumPct: null,
      maxSpreadPct: null,
      nextReviewAt: '2026-08-04T00:00:00.000Z',
    },
    benchmarks: [],
    assetSpecificRisks: [],
    evidenceSnapshot: null,
    evidenceVersion: 'evidence-v1',
    phaseModelVersion: 'phase-v1',
    candidateModelVersion: 'candidate-v1',
    contextId: 'ctx-1',
    sessionId: null,
    runId: null,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    ...over,
  };
}

// ===== 1. cadence 分类 =====

assert.equal(
  ev.cadenceOf(cond('x', { kind: 'priceLevel', level: 10, relation: 'crossUp' })),
  'tick',
  '价格穿越应走 tick',
);
assert.equal(
  ev.cadenceOf(cond('x', { kind: 'priceLevel', level: 10, relation: 'touch' })),
  'tick',
  '触及应走 tick',
);
assert.equal(
  ev.cadenceOf(cond('x', { kind: 'priceLevel', level: 10, relation: 'holdAbove' })),
  'bar',
  '收盘口径的 holdAbove 必须走 bar，不能在 tick 里判',
);
assert.equal(
  ev.cadenceOf(cond('x', { kind: 'ma', maType: 'sma', left: 'close', period: 20, relation: 'above' })),
  'bar',
  '均线条件必须走 bar',
);
assert.equal(
  ev.cadenceOf(cond('x', { kind: 'amountRatio', days: 20, op: 'gte', value: 1.2 })),
  'bar',
  '量价条件必须走 bar',
);
assert.equal(
  ev.cadenceOf(cond('x', { kind: 'macd', signal: 'goldCross' })),
  'bar',
  'MACD 条件必须走 bar',
);

// ===== 2. tick 级求值不碰 buildSeries =====

{
  ev.resetEvaluatorState();
  const c = cond('t', { kind: 'priceLevel', level: 100, relation: 'crossUp' });
  assert.equal(ev.evalTickCondition(c, { price: 101, prevPrice: 99 }), true, '上穿应命中');
  assert.equal(ev.evalTickCondition(c, { price: 101, prevPrice: 100.5 }), false, '未从下方穿越不算');
  assert.equal(ev.evalTickCondition(c, { price: 99, prevPrice: 98 }), false, '未越过不算');
  assert.equal(ev.evalTickCondition(c, { price: 101, prevPrice: null }), false, '无前值时穿越不成立');
  const down = cond('d', { kind: 'priceLevel', level: 100, relation: 'crossDown' });
  assert.equal(ev.evalTickCondition(down, { price: 99, prevPrice: 101 }), true, '下穿应命中');
  const touch = cond('h', { kind: 'priceLevel', level: 100, relation: 'touch' });
  assert.equal(ev.evalTickCondition(touch, { price: 101, prevPrice: 99 }), true, '跨越即触及');
  // 非价格规则不应被 tick 求值
  assert.equal(
    ev.evalTickCondition(cond('m', { kind: 'macd', signal: 'goldCross' }), { price: 1, prevPrice: 0 }),
    false,
    '非价格规则在 tick 通道必须返回 false，不得偷偷计算',
  );
  assert.equal(
    ev.seriesBuildCounter.count,
    0,
    `tick 级求值不得触发 buildSeries，实际 ${ev.seriesBuildCounter.count} 次`,
  );
}

// ===== 2b. 去重键必须含 conditionId：否则同一 bar 只有第一个条件能报 justHit =====

{
  ev.resetEvaluatorState();
  ev.primeEvaluator([], () => null); // 置 primed，但不登记任何键
  // 两个都会满足的 bar 级条件：早先去重键只按 bar 维度，第二个永远拿不到 justHit
  const plan = mkPlan({
    scenarios: [
      {
        id: 'sc1', rank: 'primary', name: 'x', action: 'probe',
        conditions: [
          cond('b1', { kind: 'ma', maType: 'sma', left: 'close', period: 20, relation: 'above' }),
          cond('b2', { kind: 'closeLocation', op: 'gte', value: 0 }),
        ],
        invalidConditions: [], targetLevelIds: [],
      },
    ],
  });
  const map = new Map<KlinePeriod, KlineBar[]>([['day', BARS]]);
  const r = ev.evaluatePlan({ plan, barsByPeriod: map });
  const hit = r.conditions.filter((c) => c.cadence === 'bar' && c.satisfied);
  assert.equal(hit.length, 2, `本 fixture 应有 2 个 bar 级条件同时满足，实际 ${hit.length}`);
  assert.ok(
    hit.every((c) => c.justHit),
    '同一根 bar 上的每个满足条件都应各自报 justHit，去重键不能只按 bar 维度',
  );
  const t = BARS[BARS.length - 1].time;
  assert.notEqual(
    ev.seenKey('plan-1', '159516', 'day', t, 1, 'b1'),
    ev.seenKey('plan-1', '159516', 'day', t, 1, 'b2'),
    '不同条件必须产生不同的去重键',
  );
  assert.notEqual(
    ev.seenKey('plan-a', '159516', 'day', t, 1, 'b1'),
    ev.seenKey('plan-b', '159516', 'day', t, 1, 'b1'),
    '两条期限车道可能版本号相同、条件 id 也相同，去重键必须含 planId 才不会互相抑制',
  );
}

// ===== 2c. 序列缓存键必须含规则指纹：规则不同的计划不得复用缺指标的序列 =====

{
  ev.resetEvaluatorState();
  const map = new Map<KlinePeriod, KlineBar[]>([['day', BARS]]);
  // 计划 A 只用均线
  const planA = mkPlan({
    id: 'plan-ma',
    scenarios: [
      {
        id: 's', rank: 'primary', name: 'a', action: 'probe',
        conditions: [cond('ma', { kind: 'ma', maType: 'sma', left: 'close', period: 20, relation: 'above' })],
        invalidConditions: [], targetLevelIds: [],
      },
    ],
  });
  // 计划 B 用 MACD——若复用 A 的序列会拿到空 macd 数组，条件被静默判 false
  const planB = mkPlan({
    id: 'plan-macd',
    scenarios: [
      {
        id: 's', rank: 'primary', name: 'b', action: 'probe',
        conditions: [cond('macd', { kind: 'macd', signal: 'barAbove0' })],
        invalidConditions: [], targetLevelIds: [],
      },
    ],
  });
  ev.evaluatePlan({ plan: planA, barsByPeriod: map, force: true });
  const before = ev.seriesBuildCounter.count;
  const rb = ev.evaluatePlan({ plan: planB, barsByPeriod: map, force: true });
  assert.ok(
    ev.seriesBuildCounter.count > before,
    '规则集不同必须重建序列，否则会拿到缺指标的缓存',
  );
  assert.equal(
    rb.conditions.find((c) => c.conditionId === 'macd')?.satisfied,
    true,
    '单边上行 fixture 的 MACD 柱应为正；若为 false 说明拿到了缺 macd 的序列',
  );
}

// ===== 2d. 序列缓存键必须含 bar 数：切掉未收完那根后不得命中同 lastBarTime 的旧缓存 =====

{
  ev.resetEvaluatorState();
  const plan = mkPlan();
  // 收盘态：整段 bar，末根为 BARS[n-1]
  ev.evaluatePlan({
    plan,
    barsByPeriod: new Map<KlinePeriod, KlineBar[]>([['day', BARS]]),
    force: true,
  });
  const afterClosed = ev.seriesBuildCounter.count;
  // 次日盘中：取数窗口定长会滑窗，末根换成未收完的新 bar、最老一根被挤掉。
  // 切片后末根仍是 BARS[n-1]（与上面那份缓存同 lastBarTime），但少了一根。
  // 只按 lastBarTime 做键会命中旧缓存，而调用方按 length-1 取值就错位到前一根 bar 上。
  const intradayBars = [...BARS.slice(1), { ...BARS[BARS.length - 1], time: '2026-01-01 15:00' }];
  ev.evaluatePlan({
    plan,
    barsByPeriod: new Map<KlinePeriod, KlineBar[]>([['day', intradayBars]]),
    force: true,
    lastBarClosed: false,
  });
  assert.ok(
    ev.seriesBuildCounter.count > afterClosed,
    '数组长度不同必须重建序列，否则调用方按 length-1 取值会错位一根 bar',
  );
}

// ===== 3. bar 级求值：同一 bar 只算一次序列 =====

{
  ev.resetEvaluatorState();
  const plan = mkPlan();
  const map = new Map<KlinePeriod, KlineBar[]>([['day', BARS]]);
  // 连续 5 轮（模拟 10 秒轮询里多次进入），序列只应构建 1 次
  for (let i = 0; i < 5; i++) {
    ev.evaluatePlan({ plan, barsByPeriod: map, tick: { price: LAST, prevPrice: LAST * 0.99 } });
  }
  assert.equal(
    ev.seriesBuildCounter.count,
    1,
    `同一 bar 多轮求值只应构建 1 次序列，实际 ${ev.seriesBuildCounter.count} 次`,
  );
}

// ===== 4. buildSeries 次数与新 bar 数同阶，而非 tick 数同阶 =====

{
  ev.resetEvaluatorState();
  const plan = mkPlan();
  const TICKS_PER_BAR = 20;
  const NEW_BARS = 4;
  for (let b = 0; b < NEW_BARS; b++) {
    // 每根新 bar：追加一根，然后模拟 20 次 tick 轮询
    const bars = [...BARS, ...ramp(LAST, LAST * (1 + 0.01 * (b + 1)), b + 1)];
    const map = new Map<KlinePeriod, KlineBar[]>([['day', bars]]);
    for (let t = 0; t < TICKS_PER_BAR; t++) {
      ev.evaluatePlan({ plan, barsByPeriod: map, tick: { price: LAST, prevPrice: LAST } });
    }
  }
  assert.equal(
    ev.seriesBuildCounter.count,
    NEW_BARS,
    `buildSeries 应与新 bar 数(${NEW_BARS})同阶，而非 tick 数(${NEW_BARS * TICKS_PER_BAR})，实际 ${ev.seriesBuildCounter.count}`,
  );
  assert.ok(
    ev.seriesBuildCounter.count < NEW_BARS * TICKS_PER_BAR,
    '绝不能每 tick 重建序列',
  );
}

// ===== 5. 多个活跃计划复用同一序列 =====

{
  ev.resetEvaluatorState();
  const map = new Map<KlinePeriod, KlineBar[]>([['day', BARS]]);
  for (const v of [1, 2, 3]) {
    ev.evaluatePlan({ plan: mkPlan({ id: `plan-${v}`, version: v }), barsByPeriod: map, force: true });
  }
  assert.equal(
    ev.seriesBuildCounter.count,
    1,
    `同标的同周期同 bar 的多个计划应复用序列，实际构建 ${ev.seriesBuildCounter.count} 次`,
  );
}

// ===== 6. 未预热首轮不报「刚触发」，避免重启回放旧信号 =====

{
  ev.resetEvaluatorState();
  const plan = mkPlan();
  const map = new Map<KlinePeriod, KlineBar[]>([['day', BARS]]);
  const r1 = ev.evaluatePlan({ plan, barsByPeriod: map });
  const barStates = r1.conditions.filter((c) => c.cadence === 'bar');
  assert.ok(barStates.length > 0, '应有 bar 级条件');
  assert.ok(
    barStates.every((c) => !c.justHit),
    '未预热时首轮不得报刚触发（否则重启会回放旧信号）',
  );
  assert.ok(!ev.isPrimed(), '此时应仍未预热');

  ev.primeEvaluator([plan], () => BARS[BARS.length - 1].time);
  assert.ok(ev.isPrimed(), '预热后状态应置位');
}

// ===== 7. 缺 K 线的周期按未满足处理并写明 =====

{
  ev.resetEvaluatorState();
  const plan = mkPlan({
    scenarios: [
      {
        id: 'sc1',
        rank: 'primary',
        name: 'x',
        action: 'probe',
        conditions: [cond('c60', { kind: 'macd', signal: 'goldCross' }, '60m')],
        invalidConditions: [cond('ci', { kind: 'macd', signal: 'deadCross' }, '60m')],
        targetLevelIds: [],
      },
    ],
  });
  const r = ev.evaluatePlan({ plan, barsByPeriod: new Map(), force: true });
  assert.ok(
    r.conditions.every((c) => !c.satisfied),
    '缺 K 线时条件必须按未满足处理，不得近似',
  );
  assert.ok(
    r.conditions.some((c) => c.detail.includes('缺失')),
    '缺 K 线必须在 detail 里写明',
  );
}

// ===== 7b. 未收完的最后一根不参与 bar 级判定 =====

{
  ev.resetEvaluatorState();
  const plan = mkPlan();
  const map = new Map<KlinePeriod, KlineBar[]>([['day', BARS]]);
  const closedTime = BARS[BARS.length - 2].time;
  const r = ev.evaluatePlan({ plan, barsByPeriod: map, lastBarClosed: false, force: true });
  const barState = r.conditions.find((c) => c.cadence === 'bar');
  assert.ok(
    barState?.detail.includes(closedTime),
    `未收完时应改用最后一根已收 bar(${closedTime}) 求值，实际 detail=${barState?.detail}`,
  );
}

// ===== 7c. 情景条件全为非必选时不得空真触发 =====

{
  ev.resetEvaluatorState();
  const plan = mkPlan({
    scenarios: [
      {
        id: 'sc1', rank: 'primary', name: 'x', action: 'probe',
        conditions: [
          { ...cond('opt', { kind: 'ma', maType: 'sma', left: 'close', period: 20, relation: 'above' }), required: false },
        ],
        invalidConditions: [], targetLevelIds: [],
      },
    ],
  });
  const r = ev.evaluatePlan({ plan, barsByPeriod: new Map([['day', BARS]]), force: true });
  assert.equal(r.triggered, false, '必选条件为空时 every 恒真，不得据此误报触发');
}

// ===== 8. 失效优先于触发 =====

{
  ev.resetEvaluatorState();
  // 触发条件与失效条件同时成立时，状态应为 invalid
  const plan = mkPlan({
    scenarios: [
      {
        id: 'sc1',
        rank: 'primary',
        name: 'x',
        action: 'probe',
        conditions: [cond('t', { kind: 'ma', maType: 'sma', left: 'close', period: 20, relation: 'above' })],
        invalidConditions: [cond('i', { kind: 'closeLocation', op: 'gte', value: 0 })],
        targetLevelIds: [],
      },
    ],
  });
  const r = ev.evaluatePlan({ plan, barsByPeriod: new Map([['day', BARS]]), force: true });
  assert.equal(r.triggered, true, '触发条件应成立');
  assert.equal(r.invalidated, true, '失效条件应成立');
  assert.equal(r.status, 'invalid', '同时命中时必须按防守处理（失效优先）');
  assert.equal(r.needsNewVersion, true, '失效后需要新版本');
}

// ===== 9. 过期判定 =====

{
  ev.resetEvaluatorState();
  const plan = mkPlan({ expiresAt: '2020-01-01T00:00:00.000Z' });
  const r = ev.evaluatePlan({ plan, barsByPeriod: new Map([['day', BARS]]), force: true });
  assert.equal(r.expired, true, '超过有效期应判过期');
  assert.equal(r.needsNewVersion, true, '过期后需要新版本');
}

// ===== 10. periodsOf 去重 =====

{
  const plan = mkPlan({
    scenarios: [
      {
        id: 'sc1',
        rank: 'primary',
        name: 'x',
        action: 'probe',
        conditions: [cond('a', { kind: 'macd', signal: 'goldCross' }, 'day'), cond('b', { kind: 'macd', signal: 'goldCross' }, '60m')],
        invalidConditions: [cond('c', { kind: 'macd', signal: 'deadCross' }, 'day')],
        targetLevelIds: [],
      },
    ],
  });
  const ps = ev.periodsOf(plan).sort();
  assert.deepEqual(ps, ['60m', 'day'], `应去重返回涉及的周期，实际 ${ps.join(',')}`);
}

// ===== 11. 收完判定：必须覆盖午休，且 15:00 整点两层结论一致 =====

{
  /** 造一个「上海时间为 YYYY-MM-DD HH:mm」的时刻 */
  const shAt = (date: string, hm: string): Date => new Date(`${date}T${hm}:00+08:00`);
  const day = '2026-08-04'; // 周二

  assert.equal(
    isBarUnclosed('day', day, shAt(day, '11:35')),
    true,
    '11:35（午休）当天的日 K 仍未收完：按连续竞价时段判会把半根日 K 当成已收盘用',
  );
  assert.equal(isBarUnclosed('day', day, shAt(day, '10:00')), true, '盘中当日 K 未收完');
  assert.equal(isBarUnclosed('day', day, shAt(day, '14:59')), true, '14:59 当日 K 仍未收完');
  assert.equal(isBarUnclosed('day', day, shAt(day, '15:00')), false, '15:00 整点即视为已收完（两层口径统一）');
  assert.equal(isBarUnclosed('day', day, shAt(day, '16:00')), false, '收盘后当日 K 已收完');
  assert.equal(
    isBarUnclosed('day', '2026-07-31', shAt(day, '11:35')),
    false,
    '最后一根 bar 不是今天（假日/停牌）时不得判未收完，否则每轮白切一根已收 bar',
  );
  assert.equal(isBarUnclosed('day', null, shAt(day, '11:35')), false, '无 bar 时不判未收完');

  // 分钟级：时间戳是 bar 的**结束**时刻（实测东财 60m 为 10:30/11:30/14:00/15:00），
  // 判据是「现在有没有到那个结束时刻」，不能沿用日线的「今天且早于 15:00」。
  assert.equal(
    isBarUnclosed('60m', `${day} 10:30`, shAt(day, '11:35')),
    false,
    '11:35 时 10:30 那根 60m 早已收完，按日线口径会白丢一根',
  );
  assert.equal(isBarUnclosed('60m', `${day} 11:30`, shAt(day, '11:00')), true, '未到结束时刻即未收完');
  assert.equal(isBarUnclosed('15m', `${day} 11:00`, shAt(day, '10:50')), true, '15m 同理按结束时刻判');
  assert.equal(
    isBarUnclosed('60m', `${day} 15:00`, shAt(day, '15:00')),
    false,
    '到点即收完，与日线 15:00 口径一致',
  );

  // 周线：时间戳是本周**目前最后一个交易日**，不是周五，故只能判它落在哪一周
  const mon = '2026-08-03';
  const tue = '2026-08-04';
  const fri = '2026-08-07';
  assert.equal(
    isBarUnclosed('week', tue, shAt(tue, '16:00')),
    true,
    '周二收盘后本周的周 K 仍在走，按旧口径（日期==今天则未收完）周三看它就成了已收完',
  );
  assert.equal(isBarUnclosed('week', mon, shAt(fri, '10:00')), true, '周五盘中本周周 K 未收完');
  assert.equal(isBarUnclosed('week', mon, shAt(fri, '15:00')), false, '周五收盘本周周 K 收完');
  assert.equal(
    isBarUnclosed('week', '2026-07-31', shAt(tue, '10:00')),
    false,
    '上周的周 K 已收完',
  );

  // 月线：同月一律按未收完处理，除非当天正好是月末自然日且已收盘
  assert.equal(isBarUnclosed('month', tue, shAt(tue, '16:00')), true, '月中本月月 K 未收完');
  assert.equal(
    isBarUnclosed('month', '2026-08-31', shAt('2026-08-31', '15:00')),
    false,
    '月末收盘后本月月 K 收完',
  );
  assert.equal(isBarUnclosed('month', '2026-07-31', shAt(tue, '10:00')), false, '上月月 K 已收完');
}

// ===== 11b. 收完判定必须逐周期算：一根未收完的周 K 不得连带切掉日线 =====

{
  ev.resetEvaluatorState();
  // 条件跨 day 与 week 两个周期。周中求值时周 K 恒未收完，
  // 早先 lastBarClosed 是跨周期取「或」的单个布尔量，会把日线最后一根也一并切掉。
  const plan = mkPlan({ id: 'plan-mixed-period' });
  // 取 bar 级那条（c-bar），再复制一份改成周线
  const dayCond = plan.scenarios[0].conditions.find((c) => c.id === 'c-bar')!;
  const weekCond = { ...JSON.parse(JSON.stringify(dayCond)), id: 'c-week', timeframe: 'week' as const };
  plan.scenarios[0].conditions.push(weekCond);

  const now = new Date('2026-08-04T16:00:00+08:00'); // 周二收盘后：日线已收完、周线未收完
  const dayBars = BARS.map((b, i) => ({ ...b, time: i === BARS.length - 1 ? '2026-08-04' : b.time }));
  const weekBars = BARS.map((b, i) => ({ ...b, time: i === BARS.length - 1 ? '2026-08-04' : b.time }));
  const r = ev.evaluatePlan({
    plan,
    barsByPeriod: new Map<KlinePeriod, KlineBar[]>([
      ['day', dayBars],
      ['week', weekBars],
    ]),
    force: true,
    now,
  });
  const dayRes = r.conditions.find((c) => c.conditionId === 'c-bar');
  const weekRes = r.conditions.find((c) => c.conditionId === 'c-week');
  assert.ok(
    dayRes?.detail.includes('2026-08-04'),
    `日线已收完应用最后一根求值，实际 detail=${dayRes?.detail}`,
  );
  assert.ok(
    !weekRes?.detail.includes('2026-08-04'),
    `周线未收完必须退回上一根，实际 detail=${weekRes?.detail}`,
  );
}

// ===== 12. 生产入口必须预热：不预热则一条 condition_hit 都产不出 =====

{
  ev.resetEvaluatorState();
  const plan = mkPlan({ id: 'plan-wire', status: 'active' });
  repo.insertPlan(plan);
  const hits = (): number =>
    repo.listEvents(plan.id).filter((e) => e.kind === 'condition_hit').length;
  /** 注入 fixture 取数，驱动真实调用链而不联网 */
  const loader = (bars: KlineBar[]) => async () => bars;

  // 未预热时直接求值（等价于本次修复前 primed 恒为 false 的服务进程）：一条事件都不该写
  await ev.evaluatePlanById(plan.id, { readOnly: false, loadBars: loader(BARS) });
  assert.ok(!ev.isPrimed(), '单份求值不负责预热');
  assert.equal(hits(), 0, '未预热时不得产生 condition_hit（否则重启会回放旧信号）');

  // 定时任务入口：首轮自动预热并登记当前已收 bar，仍不报触发
  await ev.evaluateAllLivePlans({ loadBars: loader(BARS) });
  assert.ok(ev.isPrimed(), 'evaluateAllLivePlans 必须在首轮前完成预热，否则 justHit 永远为 false');
  assert.equal(hits(), 0, '预热轮只登记不触发');

  // 新 bar 收出后，同一入口必须真的写出 condition_hit（事件流接线的最终验收）
  const nextBars = [...BARS, { ...BARS[BARS.length - 1], time: dayAt(60) }];
  await ev.evaluateAllLivePlans({ loadBars: loader(nextBars) });
  assert.ok(hits() > 0, '预热后新 bar 必须写出 condition_hit，计划详情页的条件时间线才不会永远为空');

  // 引擎已预热后新生成的计划，首轮同样不得把生成前就已收出的 bar 报成「刚命中」
  const later = mkPlan({ id: 'plan-new', status: 'active', code: '159518' });
  repo.insertPlan(later);
  await ev.evaluateAllLivePlans({ loadBars: loader(nextBars) });
  assert.equal(
    repo.listEvents(later.id).filter((e) => e.kind === 'condition_hit').length,
    0,
    '新计划首轮只登记不触发（预热须按计划版本补，不能只做全局一次）',
  );
}

// ===== 13. 规则语义必须按 relation/signal 判，不能按 kind =====

{
  const { semanticsOf } = await import('@stock-agent/shared');
  assert.equal(semanticsOf({ kind: 'macd', signal: 'goldCross' }), 'event', 'MACD 金叉是事件');
  assert.equal(
    semanticsOf({ kind: 'macd', signal: 'barAbove0' }),
    'state',
    'MACD 柱在零轴上方是可持续状态；按 kind 建表会把它误锁存成永久成立',
  );
  assert.equal(
    semanticsOf({ kind: 'ma', maType: 'sma', left: 'close', period: 20, relation: 'above' }),
    'state',
    '收盘在 MA20 上方是状态',
  );
  assert.equal(
    semanticsOf({ kind: 'ma', maType: 'sma', left: 'close', period: 20, relation: 'crossUp' }),
    'event',
    '均线上穿是事件',
  );
  assert.equal(semanticsOf({ kind: 'priceLevel', level: 1, relation: 'crossUp' }), 'event');
  assert.equal(semanticsOf({ kind: 'priceLevel', level: 1, relation: 'touch' }), 'event');
  assert.equal(
    semanticsOf({ kind: 'priceLevel', level: 1, relation: 'holdAbove' }),
    'state',
    'holdAbove 是收盘状态，锁存了就再也判不出跌破',
  );
}

// ===== 14. 事件类条件锁存：不在同一根 bar 上发生也要能凑齐 =====

{
  ev.resetEvaluatorState();
  const LEVEL = LAST * 0.999;
  // 「上穿」只在跨越那一笔为真，「收盘在 MA20 上方」一直为真。
  // 两者若必须同时成立，不锁存就永远凑不齐——这正是本机制要解决的场景。
  const plan = mkPlan({
    id: 'plan-latch',
    code: '159599',
    scenarios: [
      {
        id: 'sc1', rank: 'primary', name: 'x', action: 'probe',
        conditions: [
          cond('ev-cross', { kind: 'priceLevel', level: LEVEL, relation: 'crossUp' }),
          cond('st-ma', { kind: 'ma', maType: 'sma', left: 'close', period: 20, relation: 'above' }),
        ],
        invalidConditions: [cond('inv', { kind: 'priceLevel', level: 1, relation: 'holdBelow' })],
        targetLevelIds: [],
      },
    ],
  });
  repo.insertPlan(plan);
  ev.primeEvaluator([], () => null); // 置 primed 但不登记键

  const day = new Map<KlinePeriod, KlineBar[]>([['day', BARS]]);
  const r1 = ev.evaluatePlan({
    plan,
    barsByPeriod: day,
    tick: { price: LEVEL * 1.01, prevPrice: LEVEL * 0.99 },
  });
  const cross1 = r1.conditions.find((c) => c.conditionId === 'ev-cross');
  assert.equal(cross1?.satisfied, true, '上穿那一笔应命中');
  assert.equal(cross1?.justHit, true, '首次命中应报 justHit');
  ev.applyEvaluation(plan, r1);
  assert.ok(
    repo.listLatchedConditionIds(plan.id).has('ev-cross'),
    '事件类条件首次命中后必须落库锁存',
  );
  assert.ok(
    !repo.listLatchedConditionIds(plan.id).has('st-ma'),
    '状态类条件不得锁存，否则跌破后再也判不出来',
  );

  // 下一轮：价格已远离上穿位，事件本身不再成立
  const r2 = ev.evaluatePlan({
    plan,
    barsByPeriod: day,
    tick: { price: LEVEL * 1.05, prevPrice: LEVEL * 1.04 },
  });
  const cross2 = r2.conditions.find((c) => c.conditionId === 'ev-cross');
  assert.equal(
    cross2?.satisfied,
    true,
    '已锁存的事件在后续轮次必须仍视为满足，否则跨 bar 的多条件组合永远凑不齐',
  );
  assert.equal(cross2?.justHit, false, '锁存后不得重复报 justHit');
  assert.equal(r2.triggered, true, '事件锁存 + 状态条件同时成立，情景应判触发');

  // 再次真的上穿：不得产生第二条 condition_hit
  const hitsBefore = repo.listEvents(plan.id).filter((e) => e.kind === 'condition_hit').length;
  const r3 = ev.evaluatePlan({
    plan,
    barsByPeriod: day,
    tick: { price: LEVEL * 1.01, prevPrice: LEVEL * 0.99 },
  });
  ev.applyEvaluation(plan, r3);
  assert.equal(
    repo.listEvents(plan.id).filter((e) => e.kind === 'condition_hit').length,
    hitsBefore,
    '同一事件条件反复命中只应写一条 condition_hit',
  );
}

// ===== 15. 终态不可复活 =====

{
  ev.resetEvaluatorState();
  const plan = mkPlan({
    id: 'plan-terminal',
    status: 'invalid',
    scenarios: [
      {
        id: 'sc1', rank: 'primary', name: 'x', action: 'probe',
        conditions: [cond('t', { kind: 'ma', maType: 'sma', left: 'close', period: 20, relation: 'above' })],
        // 失效条件此刻不成立（价格已回升）
        invalidConditions: [cond('i', { kind: 'priceLevel', level: 1, relation: 'holdBelow' })],
        targetLevelIds: [],
      },
    ],
  });
  const r = ev.evaluatePlan({ plan, barsByPeriod: new Map([['day', BARS]]), force: true });
  assert.equal(r.triggered, true, '触发条件本身确实成立');
  assert.equal(
    r.status,
    'invalid',
    '已判失效的计划不得因失效条件（状态类）恢复而被重新激活成 triggered',
  );
}

// ===== 16. planBars：按日线实际收盘时刻计数 =====

{
  const shAt = (date: string, hm: string): Date => new Date(`${date}T${hm}:00+08:00`);
  const bars = (dates: string[]): KlineBar[] =>
    dates.map((d) => ({ time: d, open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 }));
  const three = bars(['2026-08-03', '2026-08-04', '2026-08-05']);

  // 8/4 盘中 10:00 生成：当天那根还没收完，不计；次日之后才开始计
  assert.equal(
    ev.countPlanBars('2026-08-04T02:00:00.000Z', three.slice(0, 2), shAt('2026-08-04', '10:00')),
    0,
    '盘中生成时当根未收完，不得计入',
  );
  assert.equal(
    ev.countPlanBars('2026-08-04T02:00:00.000Z', three, shAt('2026-08-05', '16:00')),
    2,
    '盘中生成后走过 8/4、8/5 两根收盘，应为 2 根',
  );
  // 8/4 收盘后 16:00 生成：8/4 那根在生成前就已收完，不能算成生效后的第 1 根
  assert.equal(
    ev.countPlanBars('2026-08-04T08:00:00.000Z', three.slice(0, 2), shAt('2026-08-04', '16:00')),
    0,
    '15:00 后生成时当天那根已收完，按日期比会凭空多算一根',
  );
  assert.equal(
    ev.countPlanBars('2026-08-04T08:00:00.000Z', three, shAt('2026-08-05', '16:00')),
    1,
    '收盘后生成，次日收盘才算第 1 根',
  );
}

// ===== 17. planBars 必须真的传进求值：时间止损不能是摆设 =====

{
  ev.resetEvaluatorState();
  const plan = mkPlan({
    id: 'plan-timestop',
    code: '159600',
    validFrom: '2026-01-01T00:00:00.000Z',
    scenarios: [
      {
        id: 'sc1', rank: 'primary', name: 'x', action: 'probe',
        conditions: [cond('never', { kind: 'priceLevel', level: 1e9, relation: 'holdAbove' })],
        invalidConditions: [cond('timestop', { kind: 'barsSincePlan', op: 'gte', value: 3 })],
        targetLevelIds: [],
      },
    ],
  });
  repo.insertPlan(plan);
  ev.primeEvaluator([], () => null);
  const r = await ev.evaluatePlanById(plan.id, { readOnly: true, loadBars: async () => BARS });
  assert.equal(
    r?.conditions.find((c) => c.conditionId === 'timestop')?.satisfied,
    true,
    'validFrom 之后已走过远超 3 根日线，barsSincePlan 必须成立；恒 false 说明 planBars 没接上',
  );
}

// ===== 18. 预热某周期取数失败：恢复那一轮只登记不触发 =====

{
  ev.resetEvaluatorState();
  const plan = mkPlan({ id: 'plan-prime-fail', code: '159601', status: 'active' });
  repo.insertPlan(plan);
  const hits = (): number =>
    repo.listEvents(plan.id).filter((e) => e.kind === 'condition_hit').length;

  let failNext = true;
  const loader = async (): Promise<KlineBar[]> => {
    if (failNext) throw new Error('模拟取数失败');
    return BARS;
  };
  // 第 1 轮：预热取数失败，该周期不得被标记为已预热
  await ev.evaluateAllLivePlans({ loadBars: loader });
  assert.equal(hits(), 0, '取数失败轮不该有事件');

  // 第 2 轮：取数恢复。这一轮必须只登记不触发——
  // 修复前该计划已被整体标记已预热，恢复轮会把生成前就已收出的 bar 报成刚命中
  failNext = false;
  await ev.evaluateAllLivePlans({ loadBars: loader });
  assert.equal(
    hits(),
    0,
    '预热失败后的首个成功轮必须只登记不触发，否则回放计划生成前的旧信号',
  );

  // 第 3 轮：真的收出新 bar 才允许触发
  const nextBars = [...BARS, { ...BARS[BARS.length - 1], time: dayAt(60) }];
  await ev.evaluateAllLivePlans({ loadBars: async () => nextBars });
  assert.ok(hits() > 0, '预热完成后新 bar 必须能正常触发');
}

// ===== 18. 盘中 tick 命中必须回写进事件流与锁存 =====
//
// 盯盘轮询里 tick 条件命中原先只产一条告警，计划的事件流与锁存完全不知情：
// 计划详情查不到「今天上穿过」，而「穿了又跌回去」的日内上穿到收盘那根 bar 上
// 根本看不出来，等于这次触发被彻底丢掉。

{
  ev.resetEvaluatorState();
  const LEVEL = LAST * 0.999;
  const plan = mkPlan({
    id: 'plan-tickwb',
    code: '159620',
    scenarios: [
      {
        id: 'sc',
        rank: 'primary',
        name: '主路径',
        action: 'probe',
        targetLevelIds: [],
        conditions: [cond('c-cross', { kind: 'priceLevel', level: LEVEL, relation: 'crossUp' })],
        invalidConditions: [cond('c-inv', { kind: 'priceLevel', level: LEVEL * 0.5, relation: 'crossDown' })],
      },
    ],
  });
  repo.insertPlan(plan);

  const hitEvents = (): number =>
    repo.listEvents(plan.id).filter((e) => e.kind === 'condition_hit' && e.conditionId === 'c-cross').length;

  const wrote = ev.recordTickHit({
    planId: plan.id,
    planVersion: plan.version,
    conditionId: 'c-cross',
    note: '上穿命中',
  });
  assert.equal(wrote, true, '首次 tick 命中必须回写');
  assert.equal(hitEvents(), 1, 'tick 命中必须落一条 condition_hit 事件');
  assert.ok(repo.listLatchedConditionIds(plan.id).has('c-cross'), 'tick 命中必须同时锁存');

  // 10 秒一轮的轮询会反复命中，去重必须靠唯一索引兜住
  for (let i = 0; i < 5; i++) {
    assert.equal(
      ev.recordTickHit({ planId: plan.id, planVersion: plan.version, conditionId: 'c-cross', note: '重复命中' }),
      false,
      '同一条件的重复 tick 命中不得重复写事件',
    );
  }
  assert.equal(hitEvents(), 1, `重复命中后事件仍应只有 1 条，实际 ${hitEvents()} 条`);

  // 关键：价格跌回穿越点下方（bar 级已判不出上穿）时，下一轮 bar 级求值
  // 必须凭锁存认这条已满足，否则日内那次上穿等于白发生
  const backBelow = [...BARS, { ...BARS[BARS.length - 1], time: dayAt(60), close: LEVEL * 0.9, open: LEVEL * 0.9, high: LEVEL * 0.95, low: LEVEL * 0.85 }];
  const res = ev.evaluatePlan({
    plan,
    barsByPeriod: new Map([['day', backBelow]]),
    lastBarClosed: true,
    force: true,
  });
  const st = res.conditions.find((c) => c.conditionId === 'c-cross');
  assert.ok(st?.satisfied, '价格跌回穿越点下方后，日内那次上穿仍应凭锁存算作已满足');
}

// ===== 19. 双用途条件不得产出重复命中与重复事件（第二轮 M3）=====
//
// 同一条件同时出现在某风险情景的触发与失效数组里是双用途之后的合法形状。
// 索引键不含用途时两边会互相覆盖；triggeredScenarios 不去重时前端会把同一条风险路径
// 渲染两遍；conditions 里两条同 conditionId 的记录对状态型规则（holdBelow）没有锁存兜底，
// applyEvaluation 会写两条重复的 condition_hit。

{
  ev.resetEvaluatorState();
  // 价位远在现价上方，「收盘跌破」是状态型规则且当下恒为真——没有事件锁存兜底，
  // 重复事件只能靠写入侧按 conditionId 去重
  const dual = cond('c-dual', { kind: 'priceLevel', level: LAST * 2, relation: 'holdBelow' });
  const plan = mkPlan({
    id: 'plan-dual',
    code: '159888',
    expiresAt: '2099-01-01T00:00:00.000Z',
    scenarios: [
      {
        id: 'sc-risk',
        rank: 'risk',
        name: '跌破减仓',
        action: 'reduce',
        targetLevelIds: [],
        // 同一条件既是这条风险路径的触发，也是它自己的失效条件
        conditions: [dual],
        invalidConditions: [dual],
      },
    ],
  });
  repo.insertPlan(plan);

  // 先预热，让下一根新 bar 能报出 justHit
  await ev.evaluateAllLivePlans({ loadBars: async () => BARS });
  const nextBars = [...BARS, { ...BARS[BARS.length - 1], time: dayAt(60) }];
  const res = ev.evaluatePlan({
    plan,
    barsByPeriod: new Map([['day', nextBars]]),
    lastBarClosed: true,
  });

  assert.equal(res.triggered, true, '前置条件：该条件当下成立，风险路径应判触发');
  assert.equal(
    res.triggeredScenarios.length,
    1,
    `同一情景两个用途都命中时只能记一次，实际 ${res.triggeredScenarios.length} 次（前端会渲染两遍）`,
  );
  assert.equal(
    res.conditions.filter((c) => c.conditionId === 'c-dual' && c.justHit).length,
    2,
    '前置条件：触发副本与失效副本都应报出刚命中，否则去重断言空转',
  );

  ev.applyEvaluation(plan, res);
  const hits = repo
    .listEvents(plan.id)
    .filter((e) => e.kind === 'condition_hit' && e.conditionId === 'c-dual');
  assert.equal(hits.length, 1, `同一次命中只能写一条 condition_hit，实际 ${hits.length} 条`);

  // 风险路径已启动 → 有效期必须被收紧，否则它状态停在 triggered（live），
  // 既不失效也进不了收盘重算队列，会一直挂到 28 天有效期满（第二轮 H1）
  assert.equal(res.needsNewVersion, true, '风险路径已启动的计划必须被判为需要新版本');
  const after = repo.getPlan(plan.id)!;
  assert.ok(
    after.expiresAt != null && after.expiresAt < '2099-01-01T00:00:00.000Z',
    `风险路径启动后有效期必须被收紧，实际仍是 ${after.expiresAt}`,
  );
  assert.ok(
    repo.listEvents(plan.id).some((e) => e.note.includes('风险路径已启动')),
    '收紧有效期必须留痕，否则用户看到计划提前过期查不到原因',
  );
}

rmSync(tmpDir, { recursive: true, force: true });
console.log(
  '✅ 分频求值自检通过（cadence 分类 · tick 不碰 buildSeries · 同 bar 只构建一次 · 与新 bar 数同阶非 tick 数 · 多计划复用序列 · 未预热不回放 · 缺 K 线不近似 · 失效优先 · 过期判定 · 周期去重 · 午休收完判定 · 定时入口预热接线 · 规则语义按 relation 判 · 事件锁存跨 bar 生效 · 终态不复活 · planBars 按实际收盘计数 · 预热失败恢复轮不回放 · tick 命中回写事件流与锁存且去重 · 双用途条件不重复命中不重复写事件 · 风险路径启动后收紧有效期）',
);
