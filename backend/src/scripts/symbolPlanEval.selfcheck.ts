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
    horizon: 'next_session',
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
    },
    exitPlan: {
      firstTakeProfitLevelId: null,
      secondTakeProfitLevelId: null,
      trailingRule: null,
      reduceFractions: [],
      profitProtectionRule: null,
    },
    execution: {
      triggerMode: 'intraday_alert',
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
    ev.seenKey('159516', 'day', t, 1, 'b1'),
    ev.seenKey('159516', 'day', t, 1, 'b2'),
    '不同条件必须产生不同的去重键',
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
    isBarUnclosed(day, shAt(day, '11:35')),
    true,
    '11:35（午休）当天的日 K 仍未收完：按连续竞价时段判会把半根日 K 当成已收盘用',
  );
  assert.equal(isBarUnclosed(day, shAt(day, '10:00')), true, '盘中当日 K 未收完');
  assert.equal(isBarUnclosed(day, shAt(day, '14:59')), true, '14:59 当日 K 仍未收完');
  assert.equal(isBarUnclosed(day, shAt(day, '15:00')), false, '15:00 整点即视为已收完（两层口径统一）');
  assert.equal(isBarUnclosed(day, shAt(day, '16:00')), false, '收盘后当日 K 已收完');
  assert.equal(
    isBarUnclosed('2026-07-31', shAt(day, '11:35')),
    false,
    '最后一根 bar 不是今天（假日/停牌）时不得判未收完，否则每轮白切一根已收 bar',
  );
  assert.equal(isBarUnclosed(null, shAt(day, '11:35')), false, '无 bar 时不判未收完');
  // 分钟级 bar 走同一判据
  assert.equal(isBarUnclosed(`${day} 11:30`, shAt(day, '11:35')), true, '分钟 bar 同样按数据日期+时钟判');
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

rmSync(tmpDir, { recursive: true, force: true });
console.log(
  '✅ 分频求值自检通过（cadence 分类 · tick 不碰 buildSeries · 同 bar 只构建一次 · 与新 bar 数同阶非 tick 数 · 多计划复用序列 · 未预热不回放 · 缺 K 线不近似 · 失效优先 · 过期判定 · 周期去重 · 午休收完判定 · 定时入口预热接线）',
);
