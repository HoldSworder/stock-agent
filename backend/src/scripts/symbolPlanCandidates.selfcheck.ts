// 候选目录自检（无框架，assert 断言）。对应 Phase 0 的两条新失败检查：
// 1) 同一 fixture 两次生成除非语义时间字段外完全一致、catalogHash 相同、不超上限；
// 2) 条件只按角色白名单展开，不做笛卡尔积；实时专用条件被标记出来。
// 不碰网络与数据库。运行：cd backend && pnpm exec tsx src/scripts/symbolPlanCandidates.selfcheck.ts
import assert from 'node:assert/strict';
import type { KlineBar, PlanPeriod, PriceLevels } from '@stock-agent/shared';
import { PLAN_PERIODS } from '@stock-agent/shared';
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

/**
 * 三层输入。自检里三层共用同一份 fixture K 线与点位，
 * 只为验证分层机制本身（配额、id 带周期、条件 timeframe 跟随），不追求各层数据真实不同。
 */
function mkInput(contextId = 'ctx-test-1', periods: readonly PlanPeriod[] = PLAN_PERIODS): CatalogInput {
  return {
    contextId,
    code: '600000',
    periods: periods.map((period) => ({
      period,
      bars: BARS,
      levels: { ...LEVELS, period },
      dow: computeDowStructure(BARS, period),
      chan: computeChanStructure(BARS, period),
    })),
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
  const a = buildCandidateCatalog(mkInput());
  const b = buildCandidateCatalog(mkInput());
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
  const c = buildCandidateCatalog({ ...mkInput(), createdAt: '2027-01-01T00:00:00.000Z' });
  assert.equal(a.catalogHash, c.catalogHash, 'createdAt 变化不得改变 catalogHash');
}

// ===== 3. 分层数量上限 =====

{
  const cat = buildCandidateCatalog(mkInput());
  // 层内上限
  for (const period of PLAN_PERIODS) {
    const n = cat.levels.filter((l) => l.timeframe === period).length;
    assert.ok(
      n <= CANDIDATE_LIMITS.LEVEL_CAP[period],
      `${period} 层价位数 ${n} 超层内上限 ${CANDIDATE_LIMITS.LEVEL_CAP[period]}`,
    );
  }
  assert.ok(
    cat.conditions.length <= CANDIDATE_LIMITS.CONDITION_CAP,
    `条件数 ${cat.conditions.length} 超总量上限 ${CANDIDATE_LIMITS.CONDITION_CAP}`,
  );
  // 分组限量
  for (const purpose of ['volume_confirm', 'structure_confirm', 'time_window', 'gate'] as const) {
    const n = cat.conditions.filter((c) => c.purpose === purpose).length;
    assert.ok(
      n <= CANDIDATE_LIMITS.PURPOSE_CAP[purpose],
      `${purpose} 数量 ${n} 超分组上限 ${CANDIDATE_LIMITS.PURPOSE_CAP[purpose]}`,
    );
  }
  assert.ok(cat.levels.length > 0, '应产出候选价位');
  assert.equal(cat.candidateModelVersion, CANDIDATE_MODEL_VERSION);
}

// ===== 3b. 分层本身：三层都要出货，id 带周期，条件 timeframe 跟随所属层 =====

{
  const cat = buildCandidateCatalog(mkInput());
  for (const period of PLAN_PERIODS) {
    assert.ok(
      cat.levels.some((l) => l.timeframe === period),
      `${period} 层应产出候选价位，否则分层等于没做`,
    );
  }
  // candidateId 必须带周期：三层给出同价位时不带周期就会撞 id
  for (const l of cat.levels) {
    assert.ok(
      l.candidateId.startsWith(`lvl:${l.timeframe}:`),
      `候选 id 必须带周期前缀，实际 ${l.candidateId}`,
    );
  }
  assert.equal(new Set(cat.levels.map((l) => l.candidateId)).size, cat.levels.length, 'candidateId 不得重复');

  // 价位条件的 timeframe 必须等于来源价位的层，否则周线位子会被按日线收盘去判
  const byId = new Map(cat.levels.map((l) => [l.candidateId, l]));
  for (const c of cat.conditions.filter((x) => x.purpose === 'price_level')) {
    const lv = byId.get(c.fromLevelCandidateId ?? '');
    assert.ok(lv, '价位条件必须能追溯到候选价位');
    assert.equal(c.timeframe, lv!.timeframe, `价位条件 ${c.candidateId} 的周期须跟随来源价位`);
  }

  // 非价格条件只产一份且锚在日线：三层各复制一遍会挤占价位条件的配额
  const nonPrice = cat.conditions.filter((c) => c.purpose !== 'price_level');
  assert.ok(nonPrice.length > 0, '应有非价格条件');
  assert.ok(
    nonPrice.every((c) => c.timeframe === 'day'),
    '非价格条件必须只锚日线一份，不得按周期复制',
  );
  const sigs = nonPrice.map((c) => JSON.stringify(c.rule));
  assert.equal(new Set(sigs).size, sigs.length, '非价格条件不得出现同规则的多周期副本');
}

// ===== 3d. 条件配额必须按层公平分摊，不得把某一层整层剃光 =====

{
  // 本 fixture 三层合计展开出的价位条件远超 CONDITION_CAP，必然触发裁剪。
  // 曾经的裁剪是「从 priceConditions 尾部砍」，而条件是按层顺序铺的，
  // 于是每次都稳定把最后一层（60m）整层砍光：60m 有 6 个候选价位却 0 条条件，
  // Phase 2 加这一层要的盘中触发点根本无法被引用，只剩一批装饰用的空价位。
  const cat = buildCandidateCatalog(mkInput());
  assert.ok(
    (cat.omittedCounts.condition_cap ?? 0) > 0,
    '本 fixture 应触发条件总量裁剪，否则这条断言测不到东西',
  );
  for (const period of PLAN_PERIODS) {
    const cs = cat.conditions.filter((c) => c.purpose === 'price_level' && c.timeframe === period);
    assert.ok(
      cs.some((c) => c.suitableFor.includes('trigger')),
      `${period} 层裁剪后必须仍有触发条件，否则该层的价位无法被任何情景引用`,
    );
    assert.ok(
      cs.some((c) => c.suitableFor.includes('invalidation')),
      `${period} 层裁剪后必须仍有失效条件`,
    );
  }
  // 层内按名次前缀保留：某个名次的价位有条件，它前面（分更高）的必须也有。
  // 否则说明裁剪切在了层的中间而不是尾部，砍掉的不是低分位。
  const hasCond = new Set(
    cat.conditions
      .filter((c) => c.purpose === 'price_level')
      .map((c) => c.fromLevelCandidateId ?? ''),
  );
  for (const period of PLAN_PERIODS) {
    const ranks = cat.levels
      .filter((l) => l.timeframe === period)
      .map((l) => ({ id: l.candidateId, rank: Number(l.candidateId.split(':')[2]) }))
      .sort((a, b) => a.rank - b.rank);
    let dropped = false;
    for (const r of ranks) {
      if (!hasCond.has(r.id)) dropped = true;
      else {
        assert.ok(!dropped, `${period} 层裁剪应从名次尾部开始，${r.id} 之前却有价位被裁`);
      }
    }
  }
}

// ===== 3c. 缺层只少那一层，不回退用别层数据顶替 =====

{
  const cat = buildCandidateCatalog(mkInput('ctx-partial', ['day']));
  assert.ok(cat.levels.length > 0, '只有日线时仍应出候选');
  assert.ok(
    cat.levels.every((l) => l.timeframe === 'day'),
    '缺失的层不得用日线数据冒充',
  );
  assert.ok(
    cat.warnings.some((w) => w.includes('week')),
    '缺层必须显式写进 warnings，不能静默少一层',
  );
}

// ===== 4. 截断必须计入 omittedCounts，不得静默 =====

{
  const cat = buildCandidateCatalog(mkInput());
  const totalOmitted = Object.values(cat.omittedCounts).reduce((s, n) => s + n, 0);
  assert.ok(totalOmitted > 0, '本 fixture 来源数远超上限，应有被裁记录');
  assert.ok(
    Object.keys(cat.omittedCounts).length > 0,
    'omittedCounts 必须按来源分项，便于定位被裁掉什么',
  );
}

// ===== 5. 条件只按白名单展开，不做笛卡尔积 =====

{
  const cat = buildCandidateCatalog(mkInput());
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

// ===== 5b. 价位条件的用途极性 =====
//
// 这一节不读 suitableFor 去自证「它和自己一致」，而是把每个 (角色, relation) 的
// 期望用途写死在断言里逐条比对。求值层的语义是「失效条件成立 ⇒ 计划失效」，
// 极性写反会让支撑守住时反而判计划失效，而编译层的用途护栏读的也是这份 suitableFor，
// 拦不住它——只有这一层独立断言能锁死。

{
  const cat = buildCandidateCatalog(mkInput());
  const levelRole = new Map(
    cat.levels.map((l) => [l.candidateId, l.compatibleRoles] as const),
  );
  /** (角色, relation) → 期望用途。未列出的组合视为不该被展开 */
  const EXPECT: Record<string, 'trigger' | 'invalidation' | 'target'> = {
    'resistance|holdAbove': 'trigger',
    'resistance|crossUp': 'trigger',
    'support|holdAbove': 'trigger',
    'support|holdBelow': 'invalidation',
    'support|crossDown': 'invalidation',
    'entry_trigger|crossUp': 'trigger',
    'entry_trigger|holdAbove': 'trigger',
    'add_trigger|crossUp': 'trigger',
    'add_trigger|holdAbove': 'trigger',
    'invalidation|crossDown': 'invalidation',
    'invalidation|holdBelow': 'invalidation',
    'stop|crossDown': 'invalidation',
    'stop|holdBelow': 'invalidation',
    'target|touch': 'target',
    'target|holdAbove': 'target',
  };
  // 同一价位同一 relation 只展开一条，由 compatibleRoles 里**第一个**列出该 relation
  // 的角色决定用途，断言必须按同样的口径找期望值
  let checked = 0;
  for (const c of cat.conditions.filter((x) => x.purpose === 'price_level')) {
    if (c.rule.kind !== 'priceLevel') continue;
    const roles = levelRole.get(c.fromLevelCandidateId ?? '') ?? [];
    const owner = roles.find((r) => EXPECT[`${r}|${c.rule.kind === 'priceLevel' ? c.rule.relation : ''}`]);
    if (!owner) continue;
    const key = `${owner}|${c.rule.relation}`;
    assert.deepEqual(
      c.suitableFor,
      [EXPECT[key]],
      `${key} 的用途必须是 ${EXPECT[key]}，实际 ${c.suitableFor.join('/')}`,
    );
    checked += 1;
  }
  assert.ok(checked > 0, '本 fixture 应覆盖到价位条件，否则极性断言等于没跑');

  // 防断言空转：支撑位必须真的产出「收盘跌破」这条失效条件，
  // 且「收盘守住」在任何情况下都不得被当成失效
  const supportBreak = cat.conditions.filter(
    (c) =>
      c.rule.kind === 'priceLevel' &&
      c.rule.relation === 'holdBelow' &&
      (levelRole.get(c.fromLevelCandidateId ?? '') ?? []).includes('support'),
  );
  assert.ok(supportBreak.length > 0, '支撑位必须展开「收盘跌破」作为失效条件');
  assert.ok(
    supportBreak.every((c) => c.suitableFor.includes('invalidation')),
    '支撑位的「收盘跌破」必须可作失效条件',
  );
  assert.ok(
    cat.conditions.every((c) => !(c.description.includes('收盘守住') && c.suitableFor.includes('invalidation'))),
    '「收盘守住」说明计划正按预期走，绝不能被标成失效条件',
  );

  // 压力位不得有任何失效条件：计划生效时价格本就在压力位下方，
  // 「收盘在压力位下方」会立即成立，计划刚生成就失效
  for (const c of cat.conditions.filter((x) => x.purpose === 'price_level')) {
    const roles = levelRole.get(c.fromLevelCandidateId ?? '') ?? [];
    if (roles.length === 1 && roles[0] === 'resistance') {
      assert.ok(
        !c.suitableFor.includes('invalidation'),
        `纯压力位不得展开失效条件（${c.description}），否则计划秒失效`,
      );
    }
  }
}

// ===== 6. 实时专用条件被正确标记 =====

{
  const cat = buildCandidateCatalog(mkInput());
  const live = cat.conditions.filter((c) => c.capability === 'live_only');
  assert.ok(live.length > 0, '应有时间窗类实时专用条件');
  for (const c of live) {
    assert.equal(c.rule.kind, 'barsSincePlan', '实时专用条件目前只应是 barsSincePlan');
  }
  // 时间窗只此一条，且数值必须与 risk.timeStopBars 同源。
  // 曾经并列产出 N 与 2N 两条、还把后者叫「时间止损」，与 risk 字段的口径对不上。
  assert.equal(live.length, 1, `时间窗条件应只有一条，实际 ${live.length} 条`);
  const { TIME_STOP_BARS } = await import('../symbolPlans/risk');
  assert.equal(
    live[0].rule.kind === 'barsSincePlan' ? live[0].rule.value : -1,
    TIME_STOP_BARS,
    '时间窗条件的根数必须复用 TIME_STOP_BARS，不能各写一套',
  );
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
  const input = mkInput();
  const cat = buildCandidateCatalog(input);
  const guaranteed = cat.levels.filter((l) => l.guaranteed);
  assert.ok(guaranteed.length > 0, '最近确认摆动点应作为保底候选保留');
  // 保底候选必须排在最前，避免被单侧上限挤掉
  assert.ok(cat.levels[0].guaranteed, '保底候选应优先排序');
}

// ===== 8. 每个候选都可追溯 =====

{
  const cat = buildCandidateCatalog(mkInput());
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
  const a = buildCandidateCatalog(mkInput('ctx-A'));
  const b = buildCandidateCatalog(mkInput('ctx-B'));
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
    code: '159516',
    periods: [{ period: 'day', bars: NEAR_BARS, levels: NEAR_LEVELS, dow: null, chan: null }],
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

// ===== 10b. 结构止损只锚日线及以上，不得被更近的 60 分钟级支撑抢走 =====
//
// 止损距离是反推仓位的分母。三层出货后离现价最近的支撑几乎总是 60 分钟级的，
// 若让它当止损，分母被压到极小、仓位放大好几倍，一根日内长阴同时打穿止损和仓位上限。
// 这条断言要求「存在一个比日线支撑更近的 60 分钟级支撑」时止损仍取日线那个，否则等于没测。

{
  const STOP_BARS = zigzag([1.0, 1.4, 1.2], 20);
  const STOP_CLOSE = STOP_BARS[STOP_BARS.length - 1].close;
  /** 日线支撑落在 1.10，60 分钟支撑落在 1.19——后者离现价近得多 */
  const mk = (period: PlanPeriod, support: number): PriceLevels => ({
    ...LEVELS,
    period,
    close: STOP_CLOSE,
    swing: { direction: 'up', high: 1.4, low: support, highTime: dayAt(20), lowTime: dayAt(0) },
    fibRetracements: [{ ratio: '50.0%', price: support }],
    fibExtensions: [],
    atr: 0.02,
    atrPct: 1.7,
    pivot: { pp: 1.5, r1: 1.55, r2: 1.6, r3: 1.65, s1: support, s2: support - 0.1, s3: support - 0.2 },
    ma: {
      values: [{ period: 20, value: support }],
      alignment: '多头排列',
      resistanceMa: null,
      supportMa: { period: 20, value: support },
    },
  });

  const cat = buildCandidateCatalog({
    contextId: 'ctx-stop',
    code: '600000',
    periods: [
      { period: 'week', bars: STOP_BARS, levels: mk('week', 1.02), dow: null, chan: null },
      { period: 'day', bars: STOP_BARS, levels: mk('day', 1.1), dow: null, chan: null },
      { period: '60m', bars: STOP_BARS, levels: mk('60m', 1.19), dow: null, chan: null },
    ],
    createdAt: '2026-08-04T07:00:00.000Z',
    expiresAt: '2026-08-05T07:00:00.000Z',
  });

  const isSupport = (l: (typeof cat.levels)[number]): boolean =>
    l.low < STOP_CLOSE &&
    l.compatibleRoles.some((r) => r === 'support' || r === 'invalidation' || r === 'stop');
  const near60 = cat.levels.filter((l) => l.timeframe === '60m' && isSupport(l));
  const nearDay = cat.levels.filter(
    (l) => (l.timeframe === 'day' || l.timeframe === 'week') && isSupport(l),
  );
  assert.ok(near60.length > 0 && nearDay.length > 0, 'fixture 须同时产出 60m 与日线级支撑，否则断言空转');
  const best60 = Math.max(...near60.map((l) => l.low));
  const bestDay = Math.max(...nearDay.map((l) => l.low));
  assert.ok(best60 > bestDay, `fixture 的 60m 支撑 ${best60} 必须比日线支撑 ${bestDay} 更靠近现价，否则测不出抢占`);

  const stop = pickStructuralStop(cat.levels, STOP_CLOSE);
  assert.equal(
    stop,
    bestDay,
    `结构止损必须锚在日线及以上（应为 ${bestDay}），实际取到 ${stop}；` +
      `取 60 分钟级支撑 ${best60} 会把止损距离压到 ${(((STOP_CLOSE - best60) / STOP_CLOSE) * 100).toFixed(2)}%，仓位被成倍放大`,
  );
}

// ===== 11. 全部 candidateId 必须真的出现在给 LLM 的文本里 =====
//
// 这是分层扩容后最容易被静默破坏的一条：format 层有 CATALOG_SOFT_LIMIT 字符软上限，
// 超了就从尾部按行裁。**被裁掉的候选 LLM 根本看不见，却仍会被 validateProposal
// 当作合法候选**——模型只能瞎猜 id，猜错被打回，两次后降级成观察计划，
// 表现为「明明有候选却总是给不出可执行计划」，且日志里查不到任何报错。
// 配额（LEVEL_CAP / CONDITION_CAP）一改，这条就会先炸。

{
  const { formatCandidates } = await import('../symbolPlans/format');
  const cat = buildCandidateCatalog(mkInput());
  for (const which of ['levels', 'conditions'] as const) {
    const text = formatCandidates(cat, which);
    const ids =
      which === 'levels'
        ? cat.levels.map((l) => l.candidateId)
        : cat.conditions.map((c) => c.candidateId);
    const missing = ids.filter((id) => !text.includes(id));
    assert.deepEqual(
      missing,
      [],
      `${which} 有 ${missing.length}/${ids.length} 个 candidateId 未出现在给 LLM 的文本中` +
        `（被软上限裁掉了）：${missing.slice(0, 5).join(',')}…。` +
        `请下调 candidateCatalog 的配额或上调 format 的 CATALOG_SOFT_LIMIT`,
    );
  }
}

// ===== 12. 当下已成立的条件不得留在失效用途里 =====
//
// 复刻线上实例（159516 v4）：标的本就在 MA20 下方，计划却把「收盘跌破 MA20」
// 当失效条件落了库，第一次复核当场判失效，界面上计划凭空消失；
// 收盘重算次日又挑中这份失效计划，每天产一份出生即失效的计划空转。

{
  /** 收在 MA20 下方的下跌 fixture：MA 类失效条件在这里当场成立 */
  const DOWN_BARS = zigzag([140, 100], 40);
  const downClose = DOWN_BARS[DOWN_BARS.length - 1].close;
  const cat = buildCandidateCatalog({
    contextId: 'ctx-already',
    code: '600000',
    periods: [
      {
        period: 'day',
        bars: DOWN_BARS,
        levels: { ...LEVELS, close: downClose, period: 'day' },
        dow: null,
        chan: null,
      },
    ],
    createdAt: '2026-08-04T07:00:00.000Z',
    expiresAt: '2026-08-05T07:00:00.000Z',
  });

  const below = cat.conditions.find((c) => c.description === '收盘跌破 MA20');
  assert.ok(below, 'fixture 应产出「收盘跌破 MA20」候选，否则本节断言空转');
  assert.equal(below.alreadySatisfied, true, '下跌 fixture 里「收盘跌破 MA20」当下已成立，必须被标记');
  assert.ok(
    !below.suitableFor.includes('invalidation'),
    '已成立的条件必须摘掉 invalidation 用途，否则模型仍能选它，落库即失效',
  );

  const above = cat.conditions.find((c) => c.description === '收盘在 MA20 上方');
  assert.ok(above, 'fixture 应同时产出「收盘在 MA20 上方」候选');
  assert.ok(!above.alreadySatisfied, '同一 fixture 里未成立的条件不得被误标记');
  assert.ok(
    above.suitableFor.includes('trigger'),
    '未成立条件的用途不得受影响',
  );

  // 时间止损靠 planBars 判定，候选阶段还没有计划，永远不能被判成「已成立」——
  // 若被误摘，decline 阶段常常只剩它一条失效条件，整份计划会直接降级成观察计划
  const timeStop = cat.conditions.find((c) => c.rule.kind === 'barsSincePlan');
  assert.ok(timeStop, 'fixture 应产出时间止损候选');
  assert.ok(!timeStop.alreadySatisfied, '时间止损在候选阶段不得被判成已成立');
  assert.ok(timeStop.suitableFor.includes('invalidation'), '时间止损必须保留失效用途');

  assert.ok(
    cat.warnings.some((w) => w.includes('已成立')),
    '摘掉用途必须写进 warnings，不能静默改变目录',
  );

  // 至少还得留下别的失效条件可选，否则拦截等于把 decline 阶段全逼进观察计划
  assert.ok(
    cat.conditions.some((c) => c.suitableFor.includes('invalidation')),
    '摘除后仍应有可用的失效条件（价位跌破类多为「将来才发生」，不该被一并摘掉）',
  );

  // 上升 fixture 里同一条件未成立，用途必须原样保留——不能一刀切把 MA 类失效条件砍死
  const up = buildCandidateCatalog(mkInput('ctx-up', ['day']));
  const upBelow = up.conditions.find((c) => c.description === '收盘跌破 MA20');
  assert.ok(upBelow, '上升 fixture 也应产出「收盘跌破 MA20」候选');
  assert.ok(!upBelow.alreadySatisfied, '现价在 MA20 上方时该条件未成立');
  assert.ok(
    upBelow.suitableFor.includes('invalidation'),
    '未成立的 MA 类条件必须仍可作失效条件',
  );
}

console.log(
  '✅ 候选目录自检通过（容差公式 · 可复现 catalogHash · 分层上限与三层出货 · 缺层不顶替 · 非价格条件不按周期复制 · omittedCounts 不静默 · 白名单非笛卡尔 · 用途极性 · 实时专用标记 · 保底候选 · 全量可追溯 · 近价位合并成带且止损取下沿 · 止损锚定日线不被60m抢占 · 全部 candidateId 对 LLM 可见 · 已成立条件摘掉失效用途且不误伤未成立条件）',
);
