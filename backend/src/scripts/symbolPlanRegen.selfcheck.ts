// 收盘后自动重算自检（无框架，assert 断言）。锁三件事：
// 1) 只挑「最新版本已失效/过期」的标的，历史失效版本与仍生效的计划都不能被挑中；
// 2) 单轮上限生效，超出的顺延而不是一口气全跑；
// 3) 重算失败保留旧计划、记一条事件说明，不留空窗。
// 不联网、不真调模型（gateway 被替身顶掉）。
// 运行：cd backend && pnpm exec tsx src/scripts/symbolPlanRegen.selfcheck.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SymbolPlanStatus, SymbolTradePlan } from '@stock-agent/shared';
import type { PlanCaller } from '../symbolPlans/regenerate';

const tmpDir = mkdtempSync(join(tmpdir(), 'symbolplanregen-selfcheck-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

const { ensureSchema } = await import('../db/migrate');
const repo = await import('../symbolPlans/repo');

ensureSchema();

/** gateway 替身：记录被调用的标的，并按 onCall 决定要不要真的落一份新计划 */
let calls: string[] = [];
let onCall: (code: string) => void = () => {};
const fakeCall: PlanCaller = async (opts) => {
  const code = (opts.taskName ?? '').match(/\d{6}/)?.[0] ?? '';
  calls.push(code);
  onCall(code);
  return { status: 'success', outputText: 'ok', runId: null, promptTokens: 0, completionTokens: 0 };
};

const { regenerateStalePlans } = await import('../symbolPlans/regenerate');

function mkPlan(code: string, version: number, status: SymbolPlanStatus): SymbolTradePlan {
  const now = new Date().toISOString();
  return {
    id: `${code}-v${version}`,
    version,
    code,
    name: `标的${code}`,
    assetType: 'etf',
    status,
    asOf: '2026-08-04',
    validFrom: now,
    expiresAt: null,
    dataStatus: 'complete',
    marketPhase: 'uptrend',
    trendState: 'uptrend',
    chanSetup: 'none',
    marketAction: 'probe',
    primaryAction: 'probe',
    summary: '摘要',
    changes: [],
    levels: [],
    scenarios: [],
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
    execution: { chaseGuardAtr: null, maxPremiumPct: null, maxSpreadPct: null, nextReviewAt: now },
    benchmarks: [],
    assetSpecificRisks: [],
    evidenceSnapshot: null,
    evidenceVersion: 'evidence-v1',
    phaseModelVersion: 'phase-v1',
    candidateModelVersion: 'candidate-v4',
    contextId: 'ctx',
    sessionId: null,
    runId: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ===== 1. 只挑最新版本失效/过期的标的 =====

{
  // A：v1 失效、v2 生效 —— 已经重算过了，不该再挑
  repo.insertPlan(mkPlan('100001', 1, 'invalid'));
  repo.insertPlan(mkPlan('100001', 2, 'active'));
  // B：v1 失效、v2 也失效 —— 只该算作一只，不是两只
  repo.insertPlan(mkPlan('100002', 1, 'invalid'));
  repo.insertPlan(mkPlan('100002', 2, 'invalid'));
  // C：最新版过期
  repo.insertPlan(mkPlan('100003', 1, 'expired'));
  // D：生效中，绝不能被重算——每天把有效计划推翻重来会让盯了一天的价位凭空换一批
  repo.insertPlan(mkPlan('100004', 1, 'active'));
  // E：已被顶替，属于历史，不该挑
  repo.insertPlan(mkPlan('100005', 1, 'superseded'));

  const stale = repo.listStalePlans();
  const codes = stale.map((p) => p.code).sort();
  assert.deepEqual(codes, ['100002', '100003'], `待重算标的应只有 100002/100003，实际 ${codes.join(',')}`);
  assert.equal(
    stale.filter((p) => p.code === '100002').length,
    1,
    '同一标的的多个历史失效版本只能算一只，否则一次收盘会把它重算好几遍',
  );
  assert.equal(stale.find((p) => p.code === '100002')?.version, 2, '应取最新版本那条');
}

// ===== 2. 成功路径：落了新版本就算成功，且不再记失败事件 =====

{
  calls = [];
  onCall = (code) => {
    if (code === '100002') repo.insertPlan(mkPlan(code, 3, 'active'));
  };
  const s = await regenerateStalePlans({ call: fakeCall });
  assert.deepEqual(calls.sort(), ['100002', '100003'], '两只待重算的都该被调用一次');
  assert.equal(s.regenerated, 1, '只有 100002 真的落了新版本');
  assert.equal(s.failed, 1, '100003 未落库应记为失败');

  // 成功的那只不该留失败事件
  assert.equal(
    repo.listEvents('100002-v2').filter((e) => e.note.includes('未产出新版本')).length,
    0,
    '成功重算的标的不该记失败事件',
  );
}

// ===== 3. 失败路径：旧计划原样保留，并留下可追查的说明 =====

{
  const old = repo.getPlan('100003-v1');
  assert.equal(old?.status, 'expired', '重算失败后旧计划必须原样保留，不得被删除或改状态');
  const notes = repo.listEvents('100003-v1').filter((e) => e.note.includes('未产出新版本'));
  assert.equal(notes.length, 1, '重算失败必须留一条事件说明，否则用户只看到计划一直不更新却查不到原因');
  assert.ok(notes[0].note.includes('手动'), '说明里应给出手动重试的出路');
}

// ===== 4. 单轮上限：超出的顺延，不一口气全跑 =====

{
  for (let i = 0; i < 12; i++) repo.insertPlan(mkPlan(`2000${String(i).padStart(2, '0')}`, 1, 'invalid'));
  calls = [];
  onCall = () => {};
  const s = await regenerateStalePlans({ call: fakeCall });
  assert.ok(s.stale >= 12, '应识别出全部待重算标的');
  assert.equal(calls.length, 8, `单轮最多跑 8 只，实际跑了 ${calls.length} 只`);
  assert.equal(s.deferred, s.stale - 8, '超出上限的必须计入顺延，而不是被静默丢弃');
}

rmSync(tmpDir, { recursive: true, force: true });
console.log(
  '✅ 收盘重算自检通过（只挑最新版失效/过期 · 生效计划不被推翻 · 同标的多历史失效版只算一只 · 落库才算成功 · 失败保留旧计划并留说明 · 单轮上限顺延）',
);
