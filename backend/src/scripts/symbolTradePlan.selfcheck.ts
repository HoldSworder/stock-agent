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
  CandidateCondition,
  KlineBar,
  PriceLevels,
  SymbolTechnicalContext,
  SymbolTradePlan,
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

/**
 * 相对今天的日期。
 *
 * 广度快照的 fixture **必须**用它而不是 dayAt 那种固定纪元：adapters.ts 是拿
 * `Date.now()` 跟 tradeDate 比、超过 5 个自然日就判过期并写 warning。
 * 写死日期的话自检只在写它的那几天是绿的，之后永久变红——实测就发生过，
 * 硬编码的 2026-08-04 到 8/26 已经 22 天，「取到板块时不应写未覆盖说明」这条挂了。
 */
const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

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
  volumePrice: null,
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
  secid: '0.159516',
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
  code: '600000',
  periods: [{ period: 'day', bars: BARS, levels: LEVELS, dow, chan }],
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
  allowedShares: 2400,
  reduceShares: 0,
  effectiveLossPct: 8.2,
  sizingBasisPrice: CLOSE,
};
const EXECUTION = {
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

// ===== 0. 持有时长口径：界面分栏与「这条线是明天的事还是几个月的事」直接挂钩 =====

{
  const { planSpanOf } = await import('@stock-agent/shared');
  assert.equal(planSpanOf('week'), 'long', '周线级价位是数周到数月的仓位安排');
  assert.equal(planSpanOf('month'), 'long', '比周线更粗的一律中长期');
  assert.equal(planSpanOf('day'), 'short', '日线级动作应在本周内完成');
  assert.equal(planSpanOf('60m'), 'short');
  assert.equal(planSpanOf('15m'), 'short', '比日线更细的一律短期');
}

// ===== 0.1 条件待办进度：必要条件置顶 + 只数触发条件 =====

{
  const { planConditionProgress } = await import('@stock-agent/shared');
  const mk = (id: string, required: boolean) =>
    ({ id, required, description: id, timeframe: 'day', evidenceIds: [], rule: {} }) as never;
  const conds = [mk('可选A', false), mk('必要B', true), mk('可选C', false)];
  const hit = new Set(['可选A']);
  const r = planConditionProgress(conds, (id) => hit.has(id));
  assert.deepEqual(
    r.ordered.map((c) => c.id),
    ['必要B', '可选A', '可选C'],
    '必要条件必须置顶，否则 required 字段在界面上等于不存在',
  );
  assert.equal(r.total, 3);
  assert.equal(r.done, 1, '只有命中的才算已满足');
  assert.deepEqual(r.missing.map((c) => c.id), ['必要B', '可选C'], '还差的条目也要保持置顶后的顺序');
  // 未复核时全部算未满足，不得乐观地当成已满足
  const none = planConditionProgress(conds, () => undefined);
  assert.equal(none.done, 0, '尚未复核时不得把条件当成已满足');
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

// 价位来源必须原样透传：丢了它，图上的黄金分割虚线与计划线就认不成同一条，
// 面板也无从说明「这条触发线是怎么来的」——LLM 还能用自定义 label 把候选标签里的来源覆盖掉
{
  const byId = new Map(CATALOG.levels.map((l) => [l.candidateId, l]));
  for (const lv of plan1.levels) {
    assert.deepEqual(
      lv.sources,
      byId.get(lv.id)!.sources,
      `价位 ${lv.id} 的来源必须原样来自候选目录`,
    );
  }
  assert.ok(
    plan1.levels.some((l) => (l.sources?.length ?? 0) > 0),
    '至少应有一个价位带上来源，否则这条断言等于没测',
  );
}

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
// 用途护栏：只适用于触发的条件被放进失效数组必须被拒，反之亦然。
// 缺这层的话，白名单一旦极性写错就会直接落进计划——LLM 还被 suitableFor 主动引导着放错。
{
  const p = validProposal();
  const trigOnly = CATALOG.conditions.find(
    (c) => c.suitableFor.includes('trigger') && !c.suitableFor.includes('invalidation'),
  )!;
  const invalOnly = CATALOG.conditions.find(
    (c) => c.suitableFor.includes('invalidation') && !c.suitableFor.includes('trigger'),
  )!;
  assert.ok(trigOnly && invalOnly, 'fixture 应同时含单一用途的触发条件与失效条件');

  const asInval = {
    ...p,
    scenarioSelections: [
      { ...p.scenarioSelections[0], invalidConditionCandidateIds: [trigOnly.candidateId] },
    ],
  };
  assert.ok(
    svc.validateProposal(mkCompileInput(asInval)).some((i) => i.code === 'purpose_mismatch'),
    '把只适用于触发的条件当失效条件必须被拒',
  );

  const asTrig = {
    ...p,
    scenarioSelections: [
      { ...p.scenarioSelections[0], conditionCandidateIds: [invalOnly.candidateId] },
    ],
  };
  assert.ok(
    svc.validateProposal(mkCompileInput(asTrig)).some((i) => i.code === 'purpose_mismatch'),
    '把只适用于失效的条件当触发条件必须被拒',
  );

  // 合法组合不得被误伤
  assert.ok(
    !svc.validateProposal(mkCompileInput(p)).some((i) => i.code === 'purpose_mismatch'),
    '用途正确的提案不得被护栏误杀',
  );
}
// 出生即失效拦截：当下已成立的条件不能当失效条件。
// 缺这层的话（线上 159516 v4 的原样），计划落库后第一次复核就判失效，
// 界面上表现为计划凭空消失，收盘重算次日又挑中它，每天空转一份。
{
  const p = validProposal();
  const already = CATALOG.conditions.find((c) => c.alreadySatisfied);
  assert.ok(already, 'fixture 应含至少一条当下已成立的条件，否则本节断言空转');
  const bad = {
    ...p,
    scenarioSelections: [
      { ...p.scenarioSelections[0], invalidConditionCandidateIds: [already.candidateId] },
    ],
  };
  const issues = svc.validateProposal(mkCompileInput(bad));
  assert.ok(
    issues.some((i) => i.code === 'invalidation_already_true'),
    `已成立的条件当失效条件必须被拒，实际问题码：${issues.map((i) => i.code).join(',') || '（无）'}`,
  );
  // 必须报专用码而不是笼统的 purpose_mismatch：后者的提示是「该条件只适用于 trigger」，
  // 模型据此换一条同样已成立的条件继续撞墙，两次重试用完就降级成观察计划
  const it = issues.find((i) => i.code === 'invalidation_already_true')!;
  assert.ok(it.message.includes('尚未成立'), '拒绝理由须说明失效条件应当尚未成立');
  assert.ok(
    (it.availableCandidateIds ?? []).length > 0,
    '必须回传仍可用的失效候选，否则模型无从修正',
  );
  assert.ok(
    !svc.validateProposal(mkCompileInput(p)).some((i) => i.code === 'invalidation_already_true'),
    '合法提案不得被这条护栏误杀',
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
  const active = repo.getActivePlan('159516')!;
  assert.equal(active.id, plan3.id, '最新版本应为当前生效计划');

  // 历史可完整回看
  const history = repo.listPlanHistory('159516', 100);
  assert.ok(history.length >= 3, `历史应保留全部版本，实际 ${history.length}`);
}

// ===== 7. 同一版本重复同步标注不产生重复线 =====

{
  const active = repo.getActivePlan('159516')!;
  const n1 = marks.listPlanMarks(active.id, active.version).length;
  marks.syncPlanMarks(active);
  marks.syncPlanMarks(active);
  const n2 = marks.listPlanMarks(active.id, active.version).length;
  assert.equal(n2, n1, `同版本重复同步不得产生重复线，${n1} → ${n2}`);
}

// ===== 8. 失效标注变灰保留，不删除 =====

{
  const active = repo.getActivePlan('159516')!;
  const changed = marks.invalidatePlanMarks(active.id, active.version);
  assert.ok(changed > 0, '应有标注被置失效');
  const after = marks.listPlanMarks(active.id, active.version);
  assert.ok(after.length > 0, '失效标注不得被删除');
  assert.ok(after.every((m) => m.status === 'invalid' && m.invalidatedAt), '失效标注须记状态与时间');
}

// ===== 9. 各周期渲染过滤 =====
//
// 曾断言 markSync.shouldRenderOnTimeframe「价位线可跨周期」。该函数与实际渲染依据
// shared 的 isPlanLineVisible 相互矛盾且生产无调用方，断言等于把废弃规则锁成契约，
// 已随函数一并删除。可见性口径的唯一来源是 isPlanLineVisible。

// ===== 10. 降级观察计划：无价位无标注 =====

{
  const draft = svc.saveDraftObservationPlan({
    context: CONTEXT,
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
  // 必须有到期日：draft 在 PLAN_LIVE_STATUSES 内，expiresAt=null 时它既判不了过期、
  // 也进不了 listStalePlans 的重算队列，收盘重算从此永远不再认领这个标的（第 12 条）
  assert.ok(draft.expiresAt, '观察计划必须带到期日，否则该标的被永久踢出自动重算流水线');
  assert.ok(draft.expiresAt > draft.validFrom, '到期日必须晚于生效时刻');
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
  // 旧形状 spec（只用原有规则）应通过校验。
  // codes 必须是字符串数组：生产侧 backtest.ts 直接 `codes.map(c => c.trim())`，
  // 早先这里写成 [{ code }] 只是被 `as never` 盖住了，真跑会在 trim 上崩。
  assertRunnableSpec({
    universe: { kind: 'codes', codes: ['600519'] },
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
    universe: { kind: 'codes', codes: ['600519'] },
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
        universe: { kind: 'codes', codes: ['600519'] },
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
    // 日期必须相对今天：快照超过 5 个自然日会被判过期，写死日期的自检过几天就永久变红
    { tradeDate: daysAgo(2), boardCode: BOARD, boardName: '自检板块', kind: 'concept', newHighCount: 30, consTotal: 100, ratio: 30, rank: 1, coreCodes: ['600519'] },
    { tradeDate: daysAgo(1), boardCode: BOARD, boardName: '自检板块', kind: 'concept', newHighCount: 2, consTotal: 100, ratio: 2, rank: 9, coreCodes: ['600519'] },
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

// ===== 14.5 情景主观概率：透传 + 落库待校准 + 越界丢弃 =====

{
  const { listForecasts } = await import('../symbolPlans/forecast');
  const p = validProposal();
  const withProb = {
    ...p,
    scenarioSelections: [
      {
        ...p.scenarioSelections[0],
        subjectiveProbabilityPct: 65,
        probabilityBasis: '周线多头排列且量能配合',
      },
    ],
  };
  const plan = svc.compileAndSavePlan(mkCompileInput(withProb));
  assert.equal(plan.scenarios[0].subjectiveProbabilityPct, 65, '主观概率必须原样透传');
  assert.equal(plan.scenarios[0].probabilityBasis, '周线多头排列且量能配合');

  const rows = listForecasts(plan.id);
  assert.equal(rows.length, 1, '报了概率的情景必须落一条预测记录，否则这个数永远没机会变准');
  assert.equal(rows[0].probabilityPct, 65);
  assert.equal(rows[0].outcome, null, '刚落库的预测不得带结果');
  assert.ok(rows[0].basePrice > 0, '判定基准价必须落库冻结');

  // 越界值一律丢弃而不是夹逼：夹到 100 会把「模型输出坏了」伪装成「模型很有把握」
  const insane = {
    ...p,
    scenarioSelections: [{ ...p.scenarioSelections[0], subjectiveProbabilityPct: 480 }],
  };
  const plan2 = svc.compileAndSavePlan(mkCompileInput(insane));
  assert.equal(plan2.scenarios[0].subjectiveProbabilityPct, undefined, '越界概率必须丢弃');
  assert.equal(listForecasts(plan2.id).length, 0, '没有有效概率就不该落预测记录');
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

// ===== 17. 风险情景可表达（第 1 条）=====
//
// 目录里若没有 suitableFor 含 trigger 的看跌条件，rank='risk' 情景在结构上就无法表达：
// 每个情景都必填触发条件，LLM 把「收盘跌破支撑」放进风险情景触发数组必被 purpose_mismatch
// 打回，两次即降级观察计划，减仓/清仓车道整体失效。

{
  const bearish = CATALOG.conditions.find(
    (c) =>
      c.suitableFor.includes('trigger') &&
      c.rule.kind === 'priceLevel' &&
      (c.rule.relation === 'holdBelow' || c.rule.relation === 'crossDown'),
  );
  assert.ok(bearish, '目录必须含可作触发的看跌价位条件，否则风险情景填不出触发数组');

  const p = validProposal();
  const risky: SymbolTradePlanProposal = {
    ...p,
    scenarioSelections: [
      ...p.scenarioSelections,
      {
        rank: 'risk' as const,
        name: '跌破支撑减仓',
        // 同一个事实：作风险情景的触发，也作多头计划的失效
        conditionCandidateIds: [bearish.candidateId],
        invalidConditionCandidateIds: [bearish.candidateId],
        targetCandidateLevelIds: p.scenarioSelections[0].targetCandidateLevelIds,
      },
    ],
  };
  const issues = svc.validateProposal(mkCompileInput(risky));
  assert.deepEqual(
    issues.filter((it) => it.code === 'purpose_mismatch'),
    [],
    '看跌条件作风险情景触发条件不得被 purpose_mismatch 拒绝',
  );
  // 风险情景动作是 reduce，看跌触发与它同向，极性护栏不得误伤
  assert.deepEqual(
    issues.filter((it) => it.code === 'trigger_polarity_mismatch'),
    [],
    '风险情景（reduce）配看跌触发条件方向一致，极性护栏不得误伤',
  );
}

// ===== 17b. 已成立的条件不得作为触发条件被接受（第二轮 H2）=====
//
// 看跌关系改成双用途之后，目录侧只摘 invalidation 会把「当下就已成立」的看跌条件
// 降级成一条合法的触发条件（最典型的是价位在现价上方的 holdBelow，它恒为真），
// 计划一落库、第一次复核就判触发，风险路径凭空启动。
// 这里直接把「摘漏了」的目录状态喂进校验层，锁住编译侧这道兜底。

{
  const p = validProposal();
  const bearishAlready: CandidateCondition = {
    candidateId: 'cond:price_level:already-bearish',
    contextId: CATALOG.contextId,
    candidateModelVersion: CATALOG.candidateModelVersion,
    purpose: 'price_level',
    // 价位远在现价上方，「收盘跌破」当下恒为真
    rule: { kind: 'priceLevel', level: CLOSE * 2, relation: 'holdBelow' },
    timeframe: 'day',
    description: '收盘跌破（价位在现价上方，当下已成立）',
    fromLevelCandidateId: null,
    suitableFor: ['trigger', 'invalidation'],
    evidenceIds: [],
    capability: 'backtest',
    alreadySatisfied: true,
  };
  // 只加条件、不改 catalogHash：模拟目录侧摘漏了用途的情形，校验层必须自己拦住
  const catalog = { ...CATALOG, conditions: [...CATALOG.conditions, bearishAlready] };
  const bad: SymbolTradePlanProposal = {
    ...p,
    scenarioSelections: [
      { ...p.scenarioSelections[0], conditionCandidateIds: [bearishAlready.candidateId] },
    ],
  };
  const issues = svc.validateProposal({ ...mkCompileInput(bad), catalog });
  const it = issues.find((x) => x.code === 'trigger_already_true');
  assert.ok(
    it,
    `已成立的看跌条件当触发条件必须被拒，实际问题码：${issues.map((x) => x.code).join(',') || '（无）'}`,
  );
  assert.ok(it.message.includes('尚未成立'), '拒绝理由须说明触发条件应当尚未成立');
  assert.ok(
    (it.availableCandidateIds ?? []).length > 0,
    '必须回传仍可用的触发候选，否则模型无从修正',
  );
  assert.deepEqual(
    svc.validateProposal(mkCompileInput(p)).filter((x) => x.code === 'trigger_already_true'),
    [],
    '合法提案不得被这条护栏误杀',
  );
}

// ===== 17c. 触发条件极性必须与情景动作一致（第二轮 M1）=====
//
// 双用途拆掉了「看跌条件物理上进不了触发数组」这道唯一的结构性护栏：
// 现在 rank='primary'、action='add' 的情景可以合法地写「收盘跌破支撑 → 加仓」，全程无人拦截。

{
  const p = validProposal();
  const bearish = CATALOG.conditions.find(
    (c) =>
      c.suitableFor.includes('trigger') &&
      c.rule.kind === 'priceLevel' &&
      (c.rule.relation === 'holdBelow' || c.rule.relation === 'crossDown'),
  )!;
  assert.ok(bearish, 'fixture 应含可作触发的看跌条件，否则本节断言空转');
  const bad: SymbolTradePlanProposal = {
    ...p,
    scenarioSelections: [
      { ...p.scenarioSelections[0], rank: 'primary' as const, conditionCandidateIds: [bearish.candidateId] },
    ],
  };
  // marketAction=add：主情景动作即加仓，「收盘跌破」与它反向
  const issues = svc.validateProposal({ ...mkCompileInput(bad), marketAction: 'add', primaryAction: 'add' });
  assert.ok(
    issues.some((x) => x.code === 'trigger_polarity_mismatch'),
    `买入类情景配看跌触发条件必须被拒，实际问题码：${issues.map((x) => x.code).join(',') || '（无）'}`,
  );

  // 反向同样要拦：减仓情景不得由「收盘站上/金叉」这类看多条件触发
  const bullish = CATALOG.conditions.find(
    (c) =>
      c.suitableFor.includes('trigger') &&
      !c.alreadySatisfied &&
      c.rule.kind === 'priceLevel' &&
      (c.rule.relation === 'holdAbove' || c.rule.relation === 'crossUp'),
  )!;
  assert.ok(bullish, 'fixture 应含可作触发的看多条件，否则本节断言空转');
  const bad2: SymbolTradePlanProposal = {
    ...p,
    scenarioSelections: [
      { ...p.scenarioSelections[0], rank: 'primary' as const, conditionCandidateIds: [bullish.candidateId] },
    ],
  };
  assert.ok(
    svc
      .validateProposal({ ...mkCompileInput(bad2), marketAction: 'exit', primaryAction: 'exit' })
      .some((x) => x.code === 'trigger_polarity_mismatch'),
    '减仓/清仓情景配看多触发条件必须被拒',
  );

  // 方向一致的组合不得被误伤
  assert.deepEqual(
    svc
      .validateProposal({ ...mkCompileInput(bad2), marketAction: 'add', primaryAction: 'add' })
      .filter((x) => x.code === 'trigger_polarity_mismatch'),
    [],
    '买入类情景配看多触发条件必须放行',
  );
}

// ===== 18. 目标价位必须出现在 levelSelections 里（第 4 条）=====

{
  const p = validProposal();
  const selected = new Set(p.levelSelections.map((s) => s.candidateLevelId));
  const orphan = CATALOG.levels.find((l) => !selected.has(l.candidateId));
  assert.ok(orphan, 'fixture 应有未被选中的候选价位，否则本节断言空转');
  const bad: SymbolTradePlanProposal = {
    ...p,
    scenarioSelections: [
      { ...p.scenarioSelections[0], targetCandidateLevelIds: [orphan.candidateId] },
    ],
  };
  const issues = svc.validateProposal(mkCompileInput(bad));
  assert.ok(
    issues.some((it) => it.code === 'target_not_selected'),
    '目标价位没进 levelSelections 时必须拒绝：落库后 plan.levels 里查不到它，预测永远判不出 hit',
  );
}

// ===== 19. 买入类计划必须 entry > stop（第 20 条）=====

{
  const p = validProposal();
  const sorted = [...CATALOG.levels].sort((a, b) => a.price - b.price);
  const low = sorted[0];
  const high = sorted[sorted.length - 1];
  assert.ok(low && high && high.price > low.price, 'fixture 应有高低两个价位，否则本节断言空转');
  // 故意把入场挂在低位、止损挂在高位：按它算「单笔最大亏损」会得到负数
  const inverted: SymbolTradePlanProposal = {
    ...p,
    levelSelections: [
      { candidateLevelId: low.candidateId, role: 'entry_trigger' as const },
      { candidateLevelId: high.candidateId, role: 'stop' as const },
      ...p.levelSelections.filter(
        (s) => s.candidateLevelId !== low.candidateId && s.candidateLevelId !== high.candidateId,
      ),
    ],
  };
  const issues = svc.validateProposal(mkCompileInput(inverted));
  assert.ok(
    issues.some((it) => it.code === 'entry_below_stop'),
    '入场价不高于止损价的买入类计划必须被拒，否则会算出负数的单笔最大亏损',
  );
  // 正常提案不得被这条误伤
  assert.deepEqual(
    svc.validateProposal(mkCompileInput(p)).filter((it) => it.code === 'entry_below_stop'),
    [],
    '合法提案不得被 entry>stop 校验误伤',
  );
}

// ===== 20. 指数不得保存交易计划（第 7 条）=====

{
  const issues = svc.validateProposal({
    ...mkCompileInput(validProposal()),
    context: { ...CONTEXT, assetType: 'index' as const },
  });
  assert.ok(
    issues.some((it) => it.code === 'asset_not_tradable'),
    '指数类标的必须被拒：全链路按 code 定位，000300 会取到同码个股的行情',
  );
  assert.ok(
    issues.find((it) => it.code === 'asset_not_tradable')?.message.includes('撞码'),
    '拒绝原因必须写清楚，否则 LLM 只会换个姿势重试',
  );
}

// ===== 21. secid 全链路落库（第 7 条）=====

{
  const plan = repo.getLatestPlan('159516');
  assert.ok(plan, 'fixture 应已落过计划');
  assert.equal(plan.secid, CONTEXT.secid, '计划必须落 secid，否则求值只能按 code 取 K 线');
  const { listForecasts } = await import('../symbolPlans/forecast');
  const rows = listForecasts(plan.id);
  for (const r of rows) {
    assert.equal(r.secid, CONTEXT.secid, '预测记录必须带 secid，结算才不会猜市场');
  }
}

// ===== 22. 风险情景失效条件命中 → 触发 reduce 而非整份失效（第 8 条）=====

{
  const { evaluatePlan } = await import('../symbolPlans/evaluate');
  const base: SymbolTradePlan = {
    ...repo.getLatestPlan('159516')!,
    expiresAt: null,
    status: 'active',
    scenarios: [
      {
        id: 'sc:0:risk',
        rank: 'risk' as const,
        name: '跌破支撑减仓',
        action: 'reduce' as const,
        // 触发条件恒不满足（价位远在上方），只让失效条件成立
        conditions: [
          {
            id: 'c-trig',
            rule: { kind: 'priceLevel' as const, level: CLOSE * 5, relation: 'holdAbove' as const },
            timeframe: 'day' as const,
            description: '恒不成立的触发条件',
            required: true,
            evidenceIds: [],
          },
        ],
        invalidConditions: [
          {
            id: 'c-inval',
            rule: { kind: 'priceLevel' as const, level: CLOSE * 1.5, relation: 'holdBelow' as const },
            timeframe: 'day' as const,
            description: '收盘跌破（当前必然成立）',
            required: true,
            evidenceIds: [],
          },
        ],
        targetLevelIds: [],
      },
    ],
  };
  const ev = evaluatePlan({ plan: base, barsByPeriod: new Map([['day', BARS]]), force: true });
  assert.equal(
    ev.invalidated,
    false,
    '风险情景的失效条件命中不得把整份计划判失效——那样价格真跌下来时用户看到的是作废计划而非减仓指令',
  );
  assert.equal(ev.triggered, true, '风险情景失效条件命中应判为触发（风险路径已启动）');
  const hit = ev.triggeredScenarios.find((s) => s.rank === 'risk');
  assert.ok(hit, '必须带上命中的情景，前端才能显示「触发的是风险路径」');
  assert.equal(hit.scenarioId, 'sc:0:risk');
  assert.equal(hit.via, 'invalidation', '需区分「风险情景失效条件命中」与「主路径触发条件命中」');
  assert.equal(hit.action, 'reduce', '前端要据此显示动作');
  // 风险路径启动后必须要求新版本：状态停在 triggered（live），既不失效也进不了 listStalePlans，
  // 不特判的话那份计划的多头情景会在盘中引擎里一直求值到 28 天有效期满
  assert.equal(
    ev.needsNewVersion,
    true,
    '风险路径已启动的计划必须被判为需要新版本，否则支撑跌破后它还要挂近一个月',
  );

  // 非风险情景的失效条件命中仍必须判整份失效
  const primary: SymbolTradePlan = {
    ...base,
    scenarios: [{ ...base.scenarios[0], id: 'sc:0:primary', rank: 'primary' as const, action: 'probe' as const }],
  };
  const ev2 = evaluatePlan({ plan: primary, barsByPeriod: new Map([['day', BARS]]), force: true });
  assert.equal(ev2.invalidated, true, '主路径情景的失效条件命中仍应判整份计划失效');
}

// ===== 23. 预测判定：失效价按情景取 + 同侧按远近判（第 3 条）=====

{
  const { judge } = await import('../symbolPlans/forecast');
  const since = '2026-02-01T07:00:00.000Z';
  const base = 100;
  // 风险情景常见组合：止损 -6%、风险目标 -12%，两者同在基准价下方。
  // 一律「失效优先」会让下跌必然先命中止损判 miss，风险情景永远不可能 hit。
  // 同侧时按「谁离基准价更近先到谁」判：走到 88 必先经过 94，所以这里确实是 miss，
  // 但换成该情景自己挑的失效位（在基准价上方）时就能正常判出 hit。
  const dropBar = [{ time: '2026-02-02', high: 101, low: 87 }];
  assert.equal(
    judge(dropBar, since, base, 88, 94, '2026-03-01', '2026-02-04'),
    'miss',
    '同侧且失效价更近时按「先到近的」判落空',
  );
  assert.equal(
    judge(dropBar, since, base, 88, 105, '2026-03-01', '2026-02-04'),
    'hit',
    '失效位在基准价上方（该情景被证伪的价）时，下跌到风险目标必须判兑现',
  );
  // 异侧且同一根内都命中：日线看不出先后，保守判落空
  assert.equal(
    judge([{ time: '2026-02-02', high: 106, low: 87 }], since, base, 88, 105, '2026-03-01', '2026-02-04'),
    'miss',
    '异侧且同根都命中时必须保守判落空',
  );

  // 窗口日界必须按上海日期取，与「是否盘前」同源（第二轮 H3）。
  // 上海 08-08 00:30 = UTC 08-07T16:30：按 UTC 切片会取到 08-07，且时钟判为盘前，
  // 于是 08-07 那根**记录预测时早已全部走完**的 bar 会进窗口，等于拿已知结果打分。
  const afterMidnightSh = '2026-08-07T16:30:00.000Z';
  const doneBar = [{ time: '2026-08-07', high: 200, low: 50 }];
  assert.equal(
    judge(doneBar, afterMidnightSh, 100, 110, 90, '2026-09-01', '2026-08-08'),
    null,
    '上海 00:30 生成的预测不得把前一交易日那根已走完的 bar 算进窗口',
  );
  // 真·盘前（上海 08:00 = UTC 00:00）仍必须含当日那根，否则「当天就走到目标」的兑现全漏
  assert.equal(
    judge(doneBar, '2026-08-07T00:00:00.000Z', 100, 110, 90, '2026-09-01', '2026-08-08'),
    'miss',
    '盘前生成的预测必须把当日 bar 算进窗口',
  );
}

// ===== 23b. 风险情景取不到自己的失效位时不得套用多头止损（第二轮 M2）=====
//
// planStop 是多头执行止损、恒在基准价下方；风险目标也在下方且更远，
// 套上去 judge 必然先命中更近的止损判 miss，风险情景永远不可能 hit——
// 正是 scenarioInvalidPrice 立项要消除的系统性偏差。取不到就该不填，只靠 target 与 timeout 判。

{
  const { listForecasts } = await import('../symbolPlans/forecast');
  const p = validProposal();
  // 失效条件挑一条非 priceLevel 的（MA 类），触发条件挑看跌的，与 reduce 动作同向
  const maInval = CATALOG.conditions.find(
    (c) => c.rule.kind === 'ma' && c.suitableFor.includes('invalidation') && !c.alreadySatisfied,
  );
  const bearishTrig = CATALOG.conditions.find(
    (c) =>
      c.suitableFor.includes('trigger') &&
      c.rule.kind === 'priceLevel' &&
      (c.rule.relation === 'holdBelow' || c.rule.relation === 'crossDown'),
  );
  assert.ok(maInval && bearishTrig, 'fixture 应含 MA 类失效条件与看跌触发条件，否则本节断言空转');

  const risky: SymbolTradePlanProposal = {
    ...p,
    scenarioSelections: [
      {
        rank: 'risk' as const,
        name: '跌破减仓',
        conditionCandidateIds: [bearishTrig.candidateId],
        invalidConditionCandidateIds: [maInval.candidateId],
        targetCandidateLevelIds: p.scenarioSelections[0].targetCandidateLevelIds,
        subjectiveProbabilityPct: 40,
      },
    ],
  };
  assert.deepEqual(svc.validateProposal(mkCompileInput(risky)), [], '本节提案本身必须合法');
  const plan = svc.compileAndSavePlan(mkCompileInput(risky));
  const rows = listForecasts(plan.id);
  assert.equal(rows.length, 1, '报了概率的风险情景应落一条预测记录');
  assert.equal(
    rows[0].invalidPrice,
    null,
    '风险情景取不到自己的 priceLevel 失效位时必须留空，套用多头止损会让它永远判不出 hit',
  );
  assert.ok((plan.risk.executionStop ?? 0) > 0, '前置条件：计划级止损确实存在，否则本节断言空转');
}

// ===== 24. 名称未知不得把普通主板股判成涨停（第二轮 H4）=====
//
// lookupName 只要 getQuotes 抖一次就返回 null。此时按最保守的 5% 算，
// 一只 +4.6% 的普通主板股会拿到「涨停不可成交」这条硬阻断、整份计划被锁成等待，
// 还会经 meta.limitPct 生成一个 close×1.05 的假涨停价以 entry_trigger/stop 角色进候选目录。

{
  const { stockAdapter } = await import('../symbolPlans/adapters');
  const two = (prev: number, last: number): KlineBar[] => [
    { time: dayAt(0), open: prev, high: prev, low: prev, close: prev, volume: 1000, amount: prev * 1000 },
    { time: dayAt(1), open: last, high: last, low: last, close: last, volume: 1000, amount: last * 1000 },
  ];
  const unknown = { code: '600000', name: '600000', nameUnknown: true };

  assert.deepEqual(
    await stockAdapter.hardBlocks(unknown, two(10, 10.46)),
    [],
    '名称取不到时 +4.6% 的普通主板股不得被判成涨停——硬阻断非空会把整份计划锁成等待',
  );
  assert.ok(
    (await stockAdapter.hardBlocks(unknown, two(10, 10.96))).some((b) => b.includes('涨停')),
    '真到主板上限时仍必须给出涨停阻断',
  );
  assert.ok(
    (await stockAdapter.hardBlocks({ code: '600000', name: '*ST自检' }, two(10, 10.46))).some((b) =>
      b.includes('涨停'),
    ),
    '名称已知是 ST 时 +4.6% 必须照 5% 判涨停',
  );

  const meta = await stockAdapter.loadAssetMetadata(unknown);
  assert.equal(meta.limitPctUncertain, true, '主板个股名称未知时必须显式声明上限不可信');
  assert.equal(meta.limitPct, 10, '不可信时按代码段上限，不再拿 5% 反推');
  assert.equal(
    (await stockAdapter.loadAssetMetadata({ code: '300001', name: '300001', nameUnknown: true }))
      .limitPctUncertain,
    false,
    '创业板没有 ST 制度，代码段就定死了上限，不受名称影响',
  );
}

// ===== 失效计划回落读取不得污染业务判定 =====
//
// 面板要能看见失效计划（否则计划一失效界面整片空白，看不到原因也看不到内容），
// 但 regenerate 靠 getActivePlan 判断「是否真落库了新版本」——
// 若那里也回落到失效版，一次失败的重算会被记成成功，旧计划被悄悄留下。
// 放在文件末尾：这里会把 159516 的生效计划改成 invalid，之后不能再有依赖它的断言。

{
  const live = repo.getActivePlan('159516')!;
  assert.ok(live, 'fixture 应有生效计划，否则本节断言空转');
  repo.updateStatus(live.id, 'invalid');

  assert.equal(repo.getActivePlan('159516'), null, '判失效后 getActivePlan 必须返回 null');
  const latest = repo.getLatestPlan('159516');
  assert.ok(latest, 'getLatestPlan 必须仍能取到失效计划供界面展示失效原因');
  assert.equal(latest.id, live.id, 'getLatestPlan 应取最新一版而非更早的历史版本');
  assert.equal(latest.status, 'invalid', 'getLatestPlan 不得改写状态');
}

rmSync(tmpDir, { recursive: true, force: true });
console.log(
  '✅ 计划存储与编译自检通过（确定性字段不可篡改 · 伪造候选/角色/缺条件/跨快照被拒 · 出生即失效/即触发被拒 · 触发极性须与动作一致 · 失败零痕迹 · 版本递增且历史不删 · 同版本幂等 · 失效变灰保留 · draft 降级带到期日 · 重试指引 · 旧 spec 兼容与 live_only 拒绝 · 风险情景可表达且只收紧 · 目标须入选 · 买入 entry>stop · 指数拒保存 · secid 全链路 · 风险路径触发而非整份失效 · 预测失效价按情景取且风险情景不套多头止损 · 预测窗口按上海日界 · 名称未知不误判涨停 · 板块闸门端到端接线 · 首行超限裁剪 · 账户未覆盖口吻 · 失效回落不污染 getActivePlan）',
);
