// 候选目录自检（无框架，assert 断言）。对应 Phase 0 的两条新失败检查：
// 1) 同一 fixture 两次生成除非语义时间字段外完全一致、catalogHash 相同、不超上限；
// 2) 条件只按角色白名单展开，不做笛卡尔积；实时专用条件被标记出来。
// 不碰网络与数据库。运行：cd backend && pnpm exec tsx src/scripts/symbolPlanCandidates.selfcheck.ts
import assert from 'node:assert/strict';
import type { KlineBar, PriceLevels, SymbolPlanHorizon } from '@stock-agent/shared';
import {
  CANDIDATE_LIMITS,
  CANDIDATE_MODEL_VERSION,
  buildCandidateCatalog,
  clusterTolerance,
  type CatalogInput,
} from '../symbolPlans/candidateCatalog';
import { pickStructuralStop } from '../symbolPlans/risk';
import { computeChanStructure, computeDowStructure } from '../symbolPlans/structure';

const dayAt = (i: number): string =>
  new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString().slice(0, 10);

function zigzag(pivots: number[], perLeg = 8): KlineBar[] {
  const bars: KlineBar[] = [];
  let idx = 0;
  for (let i = 1; i < pivots.length; i++) {
    for (let k = 1; k <= perLeg; k++) {
      const px = pivots[i - 1] + ((pivots[i] - pivots[i - 1]) * k) / perLeg;
      bars.push({
        time: dayAt(idx),
        open: px,
        high: px * 1.01,
        low: px * 0.99,
        close: px,
        volume: 1000,
        amount: px * 1000,
      });
      idx += 1;
    }
  }
  return bars;
}

const BARS = zigzag([100, 120, 70, 95, 80, 105], 8);
const CLOSE = BARS[BARS.length - 1].close;

/** 构造一份典型 PriceLevels（模拟 market/levels.ts 的产出，自检不打网络） */
const LEVELS: PriceLevels = {
  code: '159516',
  asOf: dayAt(39),
  close: CLOSE,
  period: 'day',
  swing: { direction: 'up', high: 120, low: 70, highTime: dayAt(8), lowTime: dayAt(16) },
  fibRetracements: [
    { ratio: '23.6%', price: 108.2 },
    { ratio: '38.2%', price: 100.9 },
    { ratio: '50.0%', price: 95 },
    { ratio: '61.8%', price: 89.1 },
    { ratio: '78.6%', price: 80.7 },
  ],
  fibExtensions: [
    { ratio: '127.2%', price: 133.6 },
    { ratio: '161.8%', price: 150.9 },
  ],
  atr: 3.2,
  atrPct: 3.1,
  pivot: { pp: 103, r1: 108, r2: 113, r3: 118, s1: 98, s2: 93, s3: 88 },
  ma: {
    values: [
      { period: 5, value: 101 },
      { period: 10, value: 98 },
      { period: 20, value: 94 },
      { period: 60, value: 92 },
      { period: 120, value: 88 },
      { period: 250, value: 85 },
    ],
    alignment: '多头排列',
    resistanceMa: { period: 5, value: 101 },
    supportMa: { period: 10, value: 98 },
  },
  note: 'fixture',
};

function mkInput(horizon: SymbolPlanHorizon, contextId = 'ctx-test-1'): CatalogInput {
  return {
    contextId,
    horizon,
    bars: BARS,
    timeframe: 'day',
    levels: LEVELS,
    dow: computeDowStructure(BARS, 'day'),
    chan: computeChanStructure(BARS, 'day'),
    adapterLevels: [{ price: CLOSE * 1.1, label: '涨停价', evidenceId: 'adapter:limitUp' }],
    createdAt: '2026-08-03T07:00:00.000Z',
    expiresAt: '2026-08-04T07:00:00.000Z',
  };
}

// ===== 1. 聚类容差公式 =====

assert.equal(
  clusterTolerance(100, 3.2, 0.001),
  Math.max(0.002, 0.35 * 3.2, 0.2),
  '容差应取 2×tick / 0.35×ATR / 现价×0.20% 三者最大',
);
assert.equal(clusterTolerance(1, null, 0.01), 0.02, 'ATR 缺失时不应把容差算成 0');

// ===== 2. 可复现性：两次生成完全一致 =====

{
  const a = buildCandidateCatalog(mkInput('next_session'));
  const b = buildCandidateCatalog(mkInput('next_session'));
  assert.equal(a.catalogHash, b.catalogHash, 'catalogHash 必须可复现');
  assert.deepEqual(
    a.levels.map((l) => l.candidateId),
    b.levels.map((l) => l.candidateId),
    '候选价位 ID 与顺序必须可复现',
  );
  assert.deepEqual(
    a.conditions.map((c) => c.candidateId),
    b.conditions.map((c) => c.candidateId),
    '候选条件 ID 与顺序必须可复现',
  );
  // createdAt 是非语义时间字段，不应影响哈希
  const c = buildCandidateCatalog({ ...mkInput('next_session'), createdAt: '2027-01-01T00:00:00.000Z' });
  assert.equal(a.catalogHash, c.catalogHash, 'createdAt 变化不得改变 catalogHash');
}

// ===== 3. 数量上限 =====

for (const horizon of ['next_session', 'swing'] as SymbolPlanHorizon[]) {
  const cat = buildCandidateCatalog(mkInput(horizon));
  assert.ok(
    cat.levels.length <= CANDIDATE_LIMITS.LEVEL_CAP[horizon],
    `${horizon} 价位数 ${cat.levels.length} 超上限 ${CANDIDATE_LIMITS.LEVEL_CAP[horizon]}`,
  );
  assert.ok(
    cat.conditions.length <= CANDIDATE_LIMITS.CONDITION_CAP[horizon],
    `${horizon} 条件数 ${cat.conditions.length} 超上限 ${CANDIDATE_LIMITS.CONDITION_CAP[horizon]}`,
  );
  // 分组限量
  for (const purpose of ['volume_confirm', 'structure_confirm', 'time_window', 'gate'] as const) {
    const n = cat.conditions.filter((c) => c.purpose === purpose).length;
    assert.ok(
      n <= CANDIDATE_LIMITS.PURPOSE_CAP[purpose],
      `${purpose} 数量 ${n} 超分组上限 ${CANDIDATE_LIMITS.PURPOSE_CAP[purpose]}`,
    );
  }
  assert.ok(cat.levels.length > 0, `${horizon} 应产出候选价位`);
  assert.equal(cat.candidateModelVersion, CANDIDATE_MODEL_VERSION);
}

// ===== 4. 截断必须计入 omittedCounts，不得静默 =====

{
  const cat = buildCandidateCatalog(mkInput('next_session'));
  const totalOmitted = Object.values(cat.omittedCounts).reduce((s, n) => s + n, 0);
  assert.ok(totalOmitted > 0, '本 fixture 来源数远超上限，应有被裁记录');
  assert.ok(
    Object.keys(cat.omittedCounts).length > 0,
    'omittedCounts 必须按来源分项，便于定位被裁掉什么',
  );
}

// ===== 5. 条件只按白名单展开，不做笛卡尔积 =====

{
  const cat = buildCandidateCatalog(mkInput('swing'));
  const priceConds = cat.conditions.filter((c) => c.purpose === 'price_level');
  // 每个价位最多 2 种 relation（白名单每角色 2 条，去重后同价位不会爆）
  const byLevel = new Map<string, Set<string>>();
  for (const c of priceConds) {
    assert.equal(c.rule.kind, 'priceLevel');
    const key = c.fromLevelCandidateId ?? '';
    if (!byLevel.has(key)) byLevel.set(key, new Set());
    const rel = c.rule.kind === 'priceLevel' ? c.rule.relation : '';
    assert.ok(!byLevel.get(key)!.has(rel), `同一价位同一 relation 不得重复展开：${key} ${rel}`);
    byLevel.get(key)!.add(rel);
  }
  // 笛卡尔积会是 价位数 × 5种relation；白名单下应远小于此
  const cartesian = cat.levels.length * 5;
  assert.ok(
    priceConds.length < cartesian,
    `价位条件 ${priceConds.length} 应显著小于笛卡尔积 ${cartesian}`,
  );
  // 每条价位条件都要能追溯到来源价位
  for (const c of priceConds) {
    assert.ok(c.fromLevelCandidateId, '价位条件必须标明来源候选价位');
    assert.ok(
      cat.levels.some((l) => l.candidateId === c.fromLevelCandidateId),
      '价位条件引用的候选价位必须在同一目录内',
    );
  }
}

// ===== 6. 实时专用条件被正确标记 =====

{
  const cat = buildCandidateCatalog(mkInput('next_session'));
  const live = cat.conditions.filter((c) => c.capability === 'live_only');
  assert.ok(live.length > 0, '应有时间窗类实时专用条件');
  for (const c of live) {
    assert.equal(c.rule.kind, 'barsSincePlan', '实时专用条件目前只应是 barsSincePlan');
  }
  assert.ok(
    cat.warnings.some((w) => w.includes('实时专用')),
    '含实时专用条件必须写入 warnings，提示不可进回测 spec',
  );
  // 其余条件必须可回测
  for (const c of cat.conditions.filter((x) => x.capability === 'backtest')) {
    assert.notEqual(c.rule.kind, 'barsSincePlan');
  }
}

// ===== 7. 保底候选不被上限裁掉 =====

{
  const input = mkInput('next_session');
  const cat = buildCandidateCatalog(input);
  const guaranteed = cat.levels.filter((l) => l.guaranteed);
  assert.ok(guaranteed.length > 0, '最近确认摆动点应作为保底候选保留');
  // 保底候选必须排在最前，避免被单侧上限挤掉
  assert.ok(cat.levels[0].guaranteed, '保底候选应优先排序');
}

// ===== 8. 每个候选都可追溯 =====

{
  const cat = buildCandidateCatalog(mkInput('swing'));
  for (const l of cat.levels) {
    assert.ok(l.sourceEvidenceIds.length > 0, `候选 ${l.candidateId} 缺源证据 id`);
    assert.ok(l.low <= l.price && l.price <= l.high, '代表价必须落在价格区内');
    assert.ok(l.compatibleRoles.length > 0, '候选必须至少有一个可承担角色');
    assert.ok(l.score >= 0 && l.score <= 1, `评分应归一到 0~1，实际 ${l.score}`);
    const partSum = Object.values(l.scoreParts).every((v) => v >= 0 && v <= 1);
    assert.ok(partSum, '评分分项应各自归一到 0~1');
    assert.equal(l.contextId, 'ctx-test-1', '候选必须绑定 contextId 防跨快照混用');
  }
}

// ===== 9. contextId 不同则候选 ID 绑定不同上下文 =====

{
  const a = buildCandidateCatalog(mkInput('next_session', 'ctx-A'));
  const b = buildCandidateCatalog(mkInput('next_session', 'ctx-B'));
  assert.equal(a.catalogHash, b.catalogHash, '相同证据下 catalogHash 只取决于内容，不含 contextId');
  assert.notEqual(a.levels[0].contextId, b.levels[0].contextId, '候选须各自绑定所属 contextId');
}

// ===== 10. 近价位必须合并成一个价格带，止损取带的下沿 =====
// 复刻线上实例（半导体设备 ETF）：现价 0.622、ATR 0.06，
// 0.620 / 0.630 / 0.640 三个支撑来源曾各成一簇，在图上挤成一根看不清的粗线。

{
  const NEAR_BARS = zigzag([0.57, 1.06, 0.622], 20);
  const NEAR_CLOSE = NEAR_BARS[NEAR_BARS.length - 1].close;
  const NEAR_LEVELS: PriceLevels = {
    code: '159516',
    asOf: dayAt(39),
    close: NEAR_CLOSE,
    period: 'day',
    swing: { direction: 'up', high: 1.06, low: 0.57, highTime: dayAt(20), lowTime: dayAt(0) },
    fibRetracements: [
      { ratio: '50.0%', price: 0.815 },
      { ratio: '61.8%', price: 0.757 },
    ],
    fibExtensions: [{ ratio: '127.2%', price: 1.19 }],
    atr: 0.06,
    atrPct: 9.6,
    // pp 落在末根 K 线之外，避免额外插一条枢轴 PP 干扰断言
    pivot: { pp: 0.9, r1: 0.75, r2: 0.82, r3: 0.9, s1: 0.62, s2: 0.55, s3: 0.5 },
    ma: {
      values: [
        { period: 5, value: 0.7 },
        { period: 10, value: 0.63 },
        { period: 20, value: 0.64 },
        { period: 60, value: 0.8 },
      ],
      alignment: '空头排列',
      resistanceMa: { period: 5, value: 0.7 },
      supportMa: { period: 10, value: 0.63 },
    },
    note: 'fixture',
  };

  const cat = buildCandidateCatalog({
    contextId: 'ctx-near',
    horizon: 'swing',
    bars: NEAR_BARS,
    timeframe: 'day',
    levels: NEAR_LEVELS,
    dow: null,
    chan: null,
    createdAt: '2026-08-04T07:00:00.000Z',
    expiresAt: '2026-08-05T07:00:00.000Z',
  });

  const inBand = cat.levels.filter((l) => l.low <= 0.64 && l.high >= 0.62);
  assert.equal(inBand.length, 1, `0.620~0.640 内应只剩一个候选带，实际 ${inBand.length} 个`);
  assert.equal(inBand[0].low, 0.62, '价格带下沿应是最低的那个来源');
  assert.equal(inBand[0].high, 0.64, '价格带上沿应是最高的那个来源');
  assert.ok(inBand[0].high > inBand[0].low, '合并结果必须是带而不是单点，前端才画成区间');

  assert.equal(
    pickStructuralStop(cat.levels, NEAR_CLOSE),
    0.62,
    '结构止损必须取价格带下沿；取中点会让价格在带内正常震荡就被扫出局',
  );
}

console.log(
  '✅ 候选目录自检通过（容差公式 · 可复现 catalogHash · 分类/总量/分组上限 · omittedCounts 不静默 · 白名单非笛卡尔 · 实时专用标记 · 保底候选 · 全量可追溯 · 近价位合并成带且止损取下沿）',
);
