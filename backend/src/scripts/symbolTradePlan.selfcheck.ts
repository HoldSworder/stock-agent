// 标的交易计划存储与编译自检（无框架，assert 断言）。
// 覆盖 Phase 0 明确要求的失败检查：
// - LLM 传伪造价格/不存在候选ID 被拒，且不能修改后端阶段/仓位/主动作；
// - 新版本不删除旧版本标注（转 historical），保存失败不留半套辅助线；
// - 旧版 PlaybookSpec 仍可读、含 live_only 规则的 spec 被 assertRunnableSpec 拒绝。
// 跑在临时 sqlite 上。运行：cd backend && pnpm exec tsx src/scripts/symbolTradePlan.selfcheck.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CandidateCatalog,
  KlineBar,
  PriceLevels,
  SymbolTechnicalContext,
  SymbolTradePlanProposal,
  TradeLevelRole,
} from '@stock-agent/shared';

const tmpDir = mkdtempSync(join(tmpdir(), 'symbolplan-selfcheck-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

const { ensureSchema } = await import('../db/migrate');
const repo = await import('../symbolPlans/repo');
const svc = await import('../symbolPlans/service');
const marks = await import('../symbolPlans/markSync');
const { buildCandidateCatalog } = await import('../symbolPlans/candidateCatalog');
const { computeDowStructure, computeChanStructure } = await import('../symbolPlans/structure');
const { computePhase } = await import('../symbolPlans/phase');
const backtest = await import('../playbook/backtest');
// assert 签名的函数不能经解构调用（TS2775），故保留命名空间引用
const assertRunnableSpec: (s: unknown) => void = backtest.assertRunnableSpec as never;
const PlaybookBacktestError = backtest.PlaybookBacktestError;

ensureSchema();

// ===== fixture =====

const dayAt = (i: number): string =>
  new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString().slice(0, 10);

function zigzag(pivots: number[], perLeg = 8): KlineBar[] {
  const bars: KlineBar[] = [];
  let idx = 0;
  for (let i = 1; i < pivots.length; i++) {
    for (let k = 1; k <= perLeg; k++) {
      const px = pivots[i - 1] + ((pivots[i] - pivots[i - 1]) * k) / perLeg;
      bars.push({ time: dayAt(idx), open: px, high: px * 1.01, low: px * 0.99, close: px, volume: 1000, amount: px * 1000 });
      idx += 1;
    }
  }
  return bars;
}

const BARS = zigzag([100, 120, 70, 95, 80, 105], 8);
const CLOSE = BARS[BARS.length - 1].close;

const LEVELS: PriceLevels = {
  code: '159516',
  asOf: dayAt(39),
  close: CLOSE,
  period: 'day',
  swing: { direction: 'up', high: 120, low: 70, highTime: dayAt(8), lowTime: dayAt(16) },
  fibRetracements: [
    { ratio: '38.2%', price: CLOSE * 0.96 },
    { ratio: '61.8%', price: CLOSE * 0.9 },
  ],
  fibExtensions: [{ ratio: '127.2%', price: CLOSE * 1.2 }],
  atr: CLOSE * 0.03,
  atrPct: 3,
  pivot: {
    pp: CLOSE,
    r1: CLOSE * 1.03,
    r2: CLOSE * 1.06,
    r3: CLOSE * 1.09,
    s1: CLOSE * 0.97,
    s2: CLOSE * 0.94,
    s3: CLOSE * 0.91,
  },
  ma: {
    values: [
      { period: 20, value: CLOSE * 0.98 },
      { period: 60, value: CLOSE * 0.95 },
    ],
    alignment: '多头排列',
    resistanceMa: null,
    supportMa: { period: 20, value: CLOSE * 0.98 },
  },
  note: 'fixture',
};

const dow = computeDowStructure(BARS, 'day');
const chan = computeChanStructure(BARS, 'day');
const phase = computePhase({
  bars: BARS,
  completeBar: true,
  dow,
  volumePrice: null,
  ma: LEVELS.ma,
  atr: LEVELS.atr,
  prev: null,
});

const CONTEXT: SymbolTechnicalContext = {
  contextId: 'ctx-1',
  candidateModelVersion: 'candidate-v1',
  evidenceVersion: 'evidence-v1',
  code: '159516',
  name: '半导体设备ETF',
  assetType: 'etf',
  horizon: 'next_session',
  asOf: dayAt(39),
  dataStatus: 'complete',
  periods: [
    { meta: { asOf: dayAt(39), source: 'fixture', period: 'day', adjusted: true, completeBar: true, stale: false, warnings: [] }, close: CLOSE, ma20: CLOSE * 0.98, ma60: CLOSE * 0.95, atr: LEVELS.atr, atrPct: 3, macdState: null, barCount: BARS.length },
  ],
  dow,
  chan,
  volumePrice: null,
  phase,
  relativeStrength: [],
  breadth: null,
  benchmarks: [{ code: '000300', name: '沪深300', role: 'broad_market' }],
  executionQuality: [],
  eventRisks: [],
  positionContext: null,
  marketRegimePhase: '震荡',
  boardStage: null,
  candidateSummary: { levels: 0, conditions: 0, catalogHash: '' },
  activePlan: null,
  existingMarkCount: 0,
  warnings: [],
};

const CATALOG: CandidateCatalog = buildCandidateCatalog({
  contextId: 'ctx-1',
  horizon: 'next_session',
  bars: BARS,
  timeframe: 'day',
  levels: LEVELS,
  dow,
  chan,
  createdAt: '2026-08-03T07:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
});

const RISK = {
  structuralStop: CLOSE * 0.93,
  volatilityStop: CLOSE * 0.92,
  executionStop: CLOSE * 0.92,
  atrPct: 3,
  maxAccountRiskPct: 1,
  suggestedPositionPct: 12,
  timeStopBars: 5,
  gapRiskNote: null,
};
const EXECUTION = {
  triggerMode: 'close_confirmed' as const,
  chaseGuardAtr: 1.5,
  maxPremiumPct: 1,
  maxSpreadPct: null,
  nextReviewAt: '2026-08-04T07:00:00.000Z',
};

/** 从目录里挑一个可做入场触发的价位与一组条件，构造合法提案 */
function validProposal(): SymbolTradePlanProposal {
  // 各角色独立挑选，不做去重：同一候选兼任多个角色（摆动高点既是压力又是目标）是合法语义，
  // 校验层不得因此拒绝，图上的重合由 markSync 合并解决
  const pick = (role: TradeLevelRole, fallbackIdx: number) =>
    CATALOG.levels.find((l) => l.compatibleRoles.includes(role)) ?? CATALOG.levels[fallbackIdx];
  const entry = pick('resistance', 0);
  const stop = pick('support', 1);
  const target = pick('target', 2);
  const trig = CATALOG.conditions.find((c) => c.suitableFor.includes('trigger'))!;
  const inval = CATALOG.conditions.find((c) => c.suitableFor.includes('invalidation'))!;
  return {
    contextId: CATALOG.contextId,
    candidateModelVersion: CATALOG.candidateModelVersion,
    catalogHash: CATALOG.catalogHash,
    horizon: 'next_session',
    summary: '站上压力位后小仓试错，跌破支撑即退出',
    changes: ['首次生成'],
    levelSelections: [
      { candidateLevelId: entry.candidateId, role: 'resistance' as const },
      { candidateLevelId: stop.candidateId, role: 'support' as const },
      { candidateLevelId: target.candidateId, role: (target.compatibleRoles.includes('target') ? 'target' : target.compatibleRoles[0]) },
    ],
    scenarioSelections: [
      {
        rank: 'primary' as const,
        name: '突破确认后试仓',
        conditionCandidateIds: [trig.candidateId],
        invalidConditionCandidateIds: [inval.candidateId],
        targetCandidateLevelIds: [target.candidateId],
      },
    ],
  };
}

function mkCompileInput(proposal: SymbolTradePlanProposal) {
  return {
    context: CONTEXT,
    catalog: CATALOG,
    proposal,
    risk: RISK,
    positionContext: null,
    execution: EXECUTION,
    marketAction: 'probe' as const,
    primaryAction: 'probe' as const,
    assetSpecificRisks: ['折溢价需在 1% 内'],
    sessionId: null,
    runId: 'run-1',
    validFrom: '2026-08-04T01:30:00.000Z',
    expiresAt: '2026-08-04T07:00:00.000Z',
  };
}

// ===== 1. 合法提案可编译落库 =====

const plan1 = svc.compileAndSavePlan(mkCompileInput(validProposal()));
assert.equal(plan1.version, 1, '首个版本应为 1');
assert.equal(plan1.status, 'active');
assert.equal(plan1.marketPhase, phase.phase, '阶段必须来自后端证据');
assert.equal(plan1.trendState, dow.state, '趋势状态必须来自后端证据');
assert.equal(plan1.chanSetup, chan.setup, '结构候选必须来自后端证据');
assert.equal(plan1.primaryAction, 'probe', '主动作必须来自后端闸门结果');
assert.deepEqual(plan1.risk, RISK, '风险字段必须原样来自后端风险服务');
assert.ok(plan1.levels.length >= 2, '应编译出关键位');
assert.ok(plan1.scenarios.length === 1, '应编译出情景');
assert.ok(plan1.scenarios[0].conditions.length > 0 && plan1.scenarios[0].invalidConditions.length > 0);
assert.equal(plan1.candidateModelVersion, CATALOG.candidateModelVersion);
assert.equal(plan1.contextId, 'ctx-1');

// 标注已同步。画在同一高度的关键位合并成一条，所以标注数 = 不同价位数而非 level 数
const m1 = marks.listPlanMarks(plan1.id, 1);
const priceKeyOf = (lv: (typeof plan1.levels)[number]): string =>
  lv.zoneLow != null && lv.zoneHigh != null && lv.zoneHigh > lv.zoneLow
    ? `${lv.zoneLow}~${lv.zoneHigh}`
    : String(lv.price ?? lv.zoneLow ?? lv.zoneHigh);
const distinctPrices = new Set(plan1.levels.map(priceKeyOf));
assert.equal(m1.length, distinctPrices.size, '同一价位的多个角色必须合并成一条标注');
assert.ok(m1.length > 0, '应同步出标注');
// 落库的点位不得出现两条完全同高的线
const pointKeys = m1.map((m) => m.points);
assert.equal(new Set(pointKeys).size, pointKeys.length, '不得存在点位完全相同的两条标注');
// 区间型关键位要以「下沿 + 上沿」两个点落库，前端才能画成价格带而不是压成中点一根线
for (const lv of plan1.levels) {
  const mk = m1.find((m) => m.label.includes(lv.label))!;
  assert.ok(mk, `关键位 ${lv.label} 应出现在某条标注的标签里`);
  const pts = JSON.parse(mk.points) as Array<{ price: number }>;
  const isZone = lv.zoneLow != null && lv.zoneHigh != null && lv.zoneHigh > lv.zoneLow;
  assert.equal(pts.length, isZone ? 2 : 1, `${lv.label} 的标注点数与是否区间不符`);
  if (isZone) {
    assert.equal(pts[0].price, lv.zoneLow, '价格带第一个点应是下沿');
    assert.equal(pts[1].price, lv.zoneHigh, '价格带第二个点应是上沿');
  }
}
assert.ok(m1.every((m) => m.status === 'active'), '本版本标注应为 active');
assert.ok(m1.every((m) => m.semanticKey?.startsWith('plan.')), '计划标注必须带语义键');
assert.ok(m1.every((m) => m.planId === plan1.id && m.planVersion === 1));

// 事件已写
const ev1 = repo.listEvents(plan1.id);
assert.ok(ev1.some((e) => e.kind === 'created'), '应写 created 事件');
assert.ok(ev1.some((e) => e.kind === 'activated'), '应写 activated 事件');

// ===== 2. LLM 不能篡改确定性字段（提案里根本没有这些字段可传）=====

{
  // 构造一个「试图夹带」阶段与主动作的提案对象，编译结果必须仍取后端值
  const tainted = {
    ...validProposal(),
    marketPhase: 'uptrend',
    primaryAction: 'add',
    risk: { maxAccountRiskPct: 99 },
    levels: [{ price: 99999 }],
  } as unknown as SymbolTradePlanProposal;
  const p = svc.compileAndSavePlan(mkCompileInput(tainted));
  assert.equal(p.marketPhase, phase.phase, '夹带的 marketPhase 必须被忽略');
  assert.equal(p.primaryAction, 'probe', '夹带的 primaryAction 必须被忽略');
  assert.equal(p.risk.maxAccountRiskPct, RISK.maxAccountRiskPct, '夹带的 risk 必须被忽略');
  assert.ok(
    p.levels.every((l) => (l.price ?? l.zoneHigh ?? 0) < 99999),
    '夹带的自造价位必须被忽略',
  );
}

// ===== 3. 伪造候选 ID 被拒 =====

{
  const bad = { ...validProposal(), levelSelections: [{ candidateLevelId: 'lvl:fake', role: 'support' as const }] };
  assert.throws(
    () => svc.compileAndSavePlan(mkCompileInput(bad)),
    (e: unknown) => {
      assert.ok(e instanceof svc.ProposalRejected, '应抛 ProposalRejected');
      const codes = e.issues.map((i) => i.code);
      assert.ok(codes.includes('unknown_level_candidate'), '应报未知候选价位');
      const issue = e.issues.find((i) => i.code === 'unknown_level_candidate')!;
      assert.ok(issue.availableCandidateIds!.length > 0, '错误必须附可用候选 ID 供重试');
      return true;
    },
  );
}
{
  const p = validProposal();
  const bad = {
    ...p,
    scenarioSelections: [{ ...p.scenarioSelections[0], conditionCandidateIds: ['cond:fake'] }],
  };
  assert.throws(
    () => svc.compileAndSavePlan(mkCompileInput(bad)),
    (e: unknown) => e instanceof svc.ProposalRejected && e.issues.some((i) => i.code === 'unknown_condition_candidate'),
  );
}

// ===== 4. 角色不兼容 / 缺触发 / 缺失效 / catalogHash 不符 都被拒 =====

{
  // 完全相同的 (候选, 角色) 组合是无意义的重复条目，拒
  const p = validProposal();
  const dup = p.levelSelections![0];
  const bad = { ...p, levelSelections: [...p.levelSelections!, { ...dup }] };
  assert.ok(
    svc.validateProposal(mkCompileInput(bad)).some((i) => i.code === 'duplicate_level_candidate'),
    '同一候选 + 同一角色重复提交应被拒',
  );
}
{
  // 但同一候选兼任不同角色是合法语义（支撑 + 结构失效 / 压力 + 目标），不得拒——
  // 拒了会让模型二次失败后降级成没有可执行价位的观察计划。图上重合由 markSync 合并解决。
  const lv = CATALOG.levels.find((l) => l.compatibleRoles.length >= 2)!;
  const [roleA, roleB] = lv.compatibleRoles;
  const p = validProposal();
  const dualRole = {
    ...p,
    levelSelections: [
      { candidateLevelId: lv.candidateId, role: roleA },
      { candidateLevelId: lv.candidateId, role: roleB },
    ],
  };
  assert.equal(
    svc.validateProposal(mkCompileInput(dualRole)).length,
    0,
    '同一候选承担两个不同角色必须放行',
  );
  const dualPlan = svc.compileAndSavePlan(mkCompileInput(dualRole));
  assert.equal(dualPlan.levels.length, 2, '两个角色都应保留在计划里');
  const dualMarks = marks.listPlanMarks(dualPlan.id, dualPlan.version);
  assert.equal(dualMarks.length, 1, '同价位的两个角色在图上必须合并成一条线');
  assert.ok(
    dualMarks[0].label.includes(' / ') || lv.label === dualMarks[0].label,
    '合并后的标签应保留各角色的称呼',
  );
}
{
  const lv = CATALOG.levels.find((l) => !l.compatibleRoles.includes('target'))!;
  const p = validProposal();
  const bad = { ...p, levelSelections: [{ candidateLevelId: lv.candidateId, role: 'target' as const }] };
  const issues = svc.validateProposal(mkCompileInput(bad));
  assert.ok(issues.some((i) => i.code === 'role_not_compatible'), '不兼容角色应被拒');
}
{
  const p = validProposal();
  const bad = { ...p, scenarioSelections: [{ ...p.scenarioSelections[0], conditionCandidateIds: [] }] };
  assert.ok(
    svc.validateProposal(mkCompileInput(bad)).some((i) => i.code === 'missing_trigger'),
    '缺触发条件应被拒',
  );
}
{
  const p = validProposal();
  const bad = { ...p, scenarioSelections: [{ ...p.scenarioSelections[0], invalidConditionCandidateIds: [] }] };
  assert.ok(
    svc.validateProposal(mkCompileInput(bad)).some((i) => i.code === 'missing_invalidation'),
    '缺失效条件应被拒',
  );
}
{
  const bad = { ...validProposal(), catalogHash: 'deadbeef' };
  assert.ok(
    svc.validateProposal(mkCompileInput(bad)).some((i) => i.code === 'catalog_mismatch'),
    'catalogHash 不符应被拒（防跨快照混用）',
  );
}
{
  const bad = { ...validProposal(), summary: '  ' };
  assert.ok(
    svc.validateProposal(mkCompileInput(bad)).some((i) => i.code === 'missing_summary'),
    '缺 summary 应被拒',
  );
}

// ===== 5. 校验失败不留任何痕迹（无半套辅助线）=====

{
  const before = repo.listPlanHistory('159516', 100).length;
  const beforeMarks = marks.listPlanMarks(plan1.id).length;
  const bad = { ...validProposal(), levelSelections: [{ candidateLevelId: 'lvl:nope', role: 'support' as const }] };
  try {
    svc.compileAndSavePlan(mkCompileInput(bad));
  } catch {
    /* 预期抛错 */
  }
  assert.equal(repo.listPlanHistory('159516', 100).length, before, '校验失败不得新增计划');
  assert.equal(marks.listPlanMarks(plan1.id).length, beforeMarks, '校验失败不得新增/删除标注');
}

// ===== 6. 新版本不删旧标注，只转 historical；旧计划转 superseded =====

{
  const plan3 = svc.compileAndSavePlan(mkCompileInput(validProposal()));
  assert.ok(plan3.version > plan1.version, '重新生成应递增版本');

  // 旧版本计划标注仍在，但状态变 historical
  const oldMarks = marks.listPlanMarks(plan1.id, 1);
  assert.ok(oldMarks.length > 0, '旧版本标注不得被删除');
  assert.ok(
    oldMarks.every((m) => m.status === 'historical'),
    `旧版本标注应转 historical，实际 ${oldMarks.map((m) => m.status).join(',')}`,
  );

  // 旧计划状态
  const old = repo.getPlan(plan1.id)!;
  assert.equal(old.status, 'superseded', '旧计划应置 superseded 而非删除');

  // 当前生效计划是最新版本
  const active = repo.getActivePlan('159516', 'next_session')!;
  assert.equal(active.id, plan3.id, '最新版本应为当前生效计划');

  // 历史可完整回看
  const history = repo.listPlanHistory('159516', 100);
  assert.ok(history.length >= 3, `历史应保留全部版本，实际 ${history.length}`);
}

// ===== 7. 同一版本重复同步标注不产生重复线 =====

{
  const active = repo.getActivePlan('159516', 'next_session')!;
  const n1 = marks.listPlanMarks(active.id, active.version).length;
  marks.syncPlanMarks(active);
  marks.syncPlanMarks(active);
  const n2 = marks.listPlanMarks(active.id, active.version).length;
  assert.equal(n2, n1, `同版本重复同步不得产生重复线，${n1} → ${n2}`);
}

// ===== 8. 失效标注变灰保留，不删除 =====

{
  const active = repo.getActivePlan('159516', 'next_session')!;
  const changed = marks.invalidatePlanMarks(active.id, active.version);
  assert.ok(changed > 0, '应有标注被置失效');
  const after = marks.listPlanMarks(active.id, active.version);
  assert.ok(after.length > 0, '失效标注不得被删除');
  assert.ok(after.every((m) => m.status === 'invalid' && m.invalidatedAt), '失效标注须记状态与时间');
}

// ===== 9. 各周期渲染过滤 =====

assert.equal(marks.shouldRenderOnTimeframe('price_line', 'day', '60m'), true, '价位线可跨周期');
assert.equal(marks.shouldRenderOnTimeframe('point', 'day', '60m'), false, '点位只在所属周期');
assert.equal(marks.shouldRenderOnTimeframe('range', 'day', 'day'), true);
assert.equal(marks.shouldRenderOnTimeframe('trend_line', null, 'day'), true, '无周期信息的老数据放行');

// ===== 10. 降级观察计划：无价位无标注 =====

{
  const draft = svc.saveDraftObservationPlan({
    context: CONTEXT,
    horizon: 'next_session',
    risk: RISK,
    positionContext: null,
    execution: EXECUTION,
    marketAction: 'probe',
    primaryAction: 'probe',
    assetSpecificRisks: [],
    sessionId: null,
    runId: 'run-2',
    reason: '两次校验均未通过',
  });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.levels.length, 0, '观察计划不得含价位');
  assert.equal(draft.scenarios.length, 0, '观察计划不得含情景');
  assert.equal(draft.primaryAction, 'wait', '观察计划动作必须是等待');
  assert.equal(marks.listPlanMarks(draft.id).length, 0, '观察计划不得产生辅助线');
  assert.ok(draft.marketPhase === phase.phase, '观察计划仍保留后端确定性阶段');
}

// ===== 11. 结构化重试指引可读 =====

{
  const bad = { ...validProposal(), levelSelections: [{ candidateLevelId: 'lvl:x', role: 'support' as const }] };
  const issues = svc.validateProposal(mkCompileInput(bad));
  const text = svc.formatIssuesForRetry(issues);
  assert.ok(text.includes('unknown_level_candidate'), '重试指引应含错误码');
  assert.ok(text.includes('可用候选'), '重试指引应列出可用候选');
  assert.ok(text.includes('不要自造价位'), '重试指引应重申禁止自造价位');
}

// ===== 12. R18：旧版 spec 可读可回测，含 live_only 的被拒 =====

{
  // 旧形状 spec（只用原有规则）应通过校验
  assertRunnableSpec({
    universe: { kind: 'codes', codes: [{ code: '600519' }] },
    period: 'day',
    barLimit: 250,
    entry: { mode: 'all', rules: [{ kind: 'ma', maType: 'sma', left: 'close', period: 20, relation: 'crossUp' }] },
    exit: { mode: 'any', rules: [{ kind: 'macd', signal: 'deadCross' }] },
    stopLossPct: 8,
    takeProfitPct: null,
    maxHoldBars: null,
    fill: 'nextOpen',
    costs: null,
  } as never);

  // 新增的可回测规则也应通过
  assertRunnableSpec({
    universe: { kind: 'codes', codes: [{ code: '600519' }] },
    period: 'day',
    barLimit: 250,
    entry: { mode: 'all', rules: [{ kind: 'amountRatio', days: 20, op: 'gte', value: 1.2 }] },
    exit: { mode: 'any', rules: [{ kind: 'closeLocation', op: 'lte', value: 0.33 }] },
    stopLossPct: 8,
    takeProfitPct: null,
    maxHoldBars: null,
    fill: 'nextOpen',
    costs: null,
  } as never);

  // 含 live_only 规则必须明确报错，而不是静默判 false
  assert.throws(
    () =>
      assertRunnableSpec({
        universe: { kind: 'codes', codes: [{ code: '600519' }] },
        period: 'day',
        barLimit: 250,
        entry: { mode: 'all', rules: [{ kind: 'barsSincePlan', op: 'gte', value: 3 }] },
        exit: { mode: 'any', rules: [{ kind: 'macd', signal: 'deadCross' }] },
        stopLossPct: 8,
        takeProfitPct: null,
        maxHoldBars: null,
        fill: 'nextOpen',
        costs: null,
      } as never),
    (e: unknown) => {
      assert.ok(e instanceof PlaybookBacktestError, '应抛 PlaybookBacktestError');
      assert.ok(String(e.message).includes('不可回测'), `错误须说明不可回测，实际：${String(e.message)}`);
      return true;
    },
  );
}

// ===== 13. 风险情景动作只收紧不放大：marketAction=exit 时不得写成 reduce =====

{
  const p = validProposal();
  const withRisk = {
    ...p,
    scenarioSelections: [
      ...p.scenarioSelections,
      { ...p.scenarioSelections[0], rank: 'risk' as const, name: '风险情景' },
    ],
  };
  const input = { ...mkCompileInput(withRisk), marketAction: 'exit' as const, primaryAction: 'exit' as const };
  const plan = svc.compileAndSavePlan(input);
  const risky = plan.scenarios.find((s) => s.rank === 'risk')!;
  assert.equal(
    risky.action,
    'exit',
    `阶段/板块已把动作收成 exit 时，风险情景不得被放大成 reduce，实际 ${risky.action}`,
  );
  // marketAction 本身更激进时，风险情景仍应收紧到 reduce
  const mild = svc.compileAndSavePlan({ ...mkCompileInput(withRisk), marketAction: 'hold', primaryAction: 'hold' });
  assert.equal(mild.scenarios.find((s) => s.rank === 'risk')!.action, 'reduce', '风险情景默认收紧为减仓');
}

// ===== 14. 板块闸门端到端接线：快照 → 阶段动作 → 收紧标的动作 =====

{
  const breadthRepo = await import('../breadth/repo');
  const breadth = await import('../breadth/service');
  const orch = await import('../symbolPlans/orchestrator');
  const { resolveMarketAction } = await import('../symbolPlans/phase');

  // 造一个「曾居首、今日新高数腰斩且跌出榜首」的板块 → 退幕（exit_only）
  const BOARD = 'BK9999';
  breadthRepo.upsertSnapshots([
    { tradeDate: '2026-08-03', boardCode: BOARD, boardName: '自检板块', kind: 'concept', newHighCount: 30, consTotal: 100, ratio: 30, rank: 1, coreCodes: ['600519'] },
    { tradeDate: '2026-08-04', boardCode: BOARD, boardName: '自检板块', kind: 'concept', newHighCount: 2, consTotal: 100, ratio: 2, rank: 9, coreCodes: ['600519'] },
  ]);
  const hit = breadth.boardStageActionOf(BOARD);
  assert.equal(hit?.action, 'exit_only', `退幕板块的阶段动作应为 exit_only，实际 ${hit?.action}`);

  // 个股：由快照反查板块 → 拿到 exit_only（这一步过去无任何生产者，boardStage 恒为 null）
  const stock = await orch.resolveBoardStage({ code: '600519', name: '贵州茅台' });
  assert.equal(stock.boardStage, 'exit_only', '个股必须能反查到板块阶段动作');
  assert.equal(stock.warning, null, '取到板块时不应写未覆盖说明');

  // 端到端：上升持有 + 板块退幕 → 必须收成退出
  const gated = resolveMarketAction({
    phase: 'uptrend',
    hardBlocks: [],
    marketRegimePhase: '主升',
    boardStageAction: stock.boardStage,
  });
  assert.equal(gated.action, 'exit', '板块已退幕必须把上升持有收紧为退出');
  assert.ok(gated.reasons.some((r) => r.includes('板块已退幕')), '收紧须留痕');

  // ETF 无板块归属：必须显式标未覆盖，不得静默按未知放过
  const etf = await orch.resolveBoardStage({ code: '159516', name: '半导体设备ETF' });
  assert.equal(etf.boardStage, null, 'ETF 暂无板块归属');
  assert.ok(etf.warning?.includes('未覆盖'), 'ETF 必须显式说明板块闸门未覆盖');
}

// ===== 15. 字符预算裁剪：首行本身超限时至少保住首行 =====

{
  const { formatTechnicalContext } = await import('../symbolPlans/format');
  const snap = {
    context: { ...CONTEXT, name: '超长名称'.repeat(1000) },
    catalog: CATALOG,
    risk: RISK,
    execution: EXECUTION,
    marketAction: 'probe',
    primaryAction: 'probe',
    actionReasons: [],
  };
  const text = formatTechnicalContext(snap);
  assert.ok(text.includes(CONTEXT.code), '首行超长时也必须保住标的代码，不能只剩一行省略提示');
  assert.ok(text.includes('尾部截断'), '超长单行须显式说明被尾部截断');
  assert.ok(text.length <= 6000, `裁剪后仍须在硬上限内，实际 ${text.length}`);
}

// ===== 16. 账户未接入时不得沿用「已算定」口吻 =====

{
  const { formatTechnicalContext } = await import('../symbolPlans/format');
  const snap = {
    context: CONTEXT,
    catalog: CATALOG,
    risk: { ...RISK, suggestedPositionPct: null, executionStop: null },
    execution: EXECUTION,
    marketAction: 'probe',
    primaryAction: 'probe',
    actionReasons: [],
  };
  const text = formatTechnicalContext(snap);
  assert.ok(text.includes('建议仓位上限 未覆盖'), '仓位算不出时必须写「未覆盖」而不是「—」');
  assert.ok(
    text.includes('账户未接入或实时持仓取数失败'),
    '必须显式说明账户维度未覆盖，不能以「已算定」口吻喂给 LLM',
  );
  // 覆盖时仍应给出数值
  assert.ok(
    formatTechnicalContext({ ...snap, risk: RISK }).includes(`建议仓位上限 ${RISK.suggestedPositionPct.toFixed(2)}%`),
    '账户可用时应正常给出建议仓位上限',
  );
}

rmSync(tmpDir, { recursive: true, force: true });
console.log(
  '✅ 计划存储与编译自检通过（确定性字段不可篡改 · 伪造候选/角色/缺条件/跨快照被拒 · 失败零痕迹 · 版本递增且历史不删 · 同版本幂等 · 失效变灰保留 · 周期过滤 · draft 降级 · 重试指引 · 旧 spec 兼容与 live_only 拒绝 · 风险情景只收紧 · 板块闸门端到端接线 · 首行超限裁剪 · 账户未覆盖口吻）',
);
