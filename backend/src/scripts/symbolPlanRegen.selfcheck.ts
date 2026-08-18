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
const { CANDIDATE_MODEL_VERSION } = await import('../symbolPlans/candidateCatalog');

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

function mkPlan(
  code: string,
  version: number,
  status: SymbolPlanStatus,
  candidateModelVersion: string = CANDIDATE_MODEL_VERSION,
): SymbolTradePlan {
  const now = new Date().toISOString();
  return {
    id: `${code}-v${version}`,
    version,
    code,
    name: `标的${code}`,
    assetType: 'etf',
    secid: `0.${code}`,
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
    candidateModelVersion,
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

// ===== 5. 候选模型版本过期：active 计划被派生为 stale，但保持可见、不删历史（第 12 条）=====

{
  repo.insertPlan(mkPlan('300001', 1, 'active', 'candidate-v1'));
  const before = repo.getActivePlan('300001');
  assert.equal(before?.version, 1, '前置条件：这份旧口径计划当前是生效的');

  const moved = repo.expireOutdatedCandidateModelPlans(CANDIDATE_MODEL_VERSION);
  assert.deepEqual(
    moved.map((m) => m.code),
    ['300001'],
    '只有候选模型版本过期的生效计划应被派生为待重算，当前口径的计划不许被动',
  );

  const after = repo.getPlan('300001-v1');
  assert.equal(after?.status, 'expired', '旧口径计划应置为 expired：停止执行但不删除、不回退为可执行');
  assert.equal(repo.getActivePlan('300001'), null, '置过期后不应再被当成生效计划求值');
  assert.ok(
    repo.listStalePlans().some((p) => p.code === '300001'),
    '旧口径计划必须进入收盘重算队列，否则口径变了却永远没人重算',
  );
  assert.ok(
    repo.listEvents('300001-v1').some((e) => e.note.includes('候选模型版本')),
    '必须留一条事件说明为什么过期，否则用户看到计划无故失效查不到原因',
  );
  // 幂等：再跑一次不该重复处理（它已经不在生效状态里）
  assert.equal(
    repo.expireOutdatedCandidateModelPlans(CANDIDATE_MODEL_VERSION).length,
    0,
    '同一份计划不该被反复置过期并反复写事件',
  );
}

// ===== 6. 观察计划必须带到期日，否则永远进不了重算队列（第 12 条）=====

{
  const { nextTradingClose } = await import('../symbolPlans/sessionClock');
  // 周五 10:00（2026-08-07 是周五）生成，下一交易日收盘应落在周一而不是周六
  const fri = new Date('2026-08-07T02:00:00.000Z');
  assert.equal(
    nextTradingClose(fri).slice(0, 10),
    '2026-08-07',
    '收盘前生成时「下一交易日收盘」仍指当天收盘',
  );
  const friAfterClose = new Date('2026-08-07T08:00:00.000Z');
  assert.equal(
    nextTradingClose(friAfterClose).slice(0, 10),
    '2026-08-10',
    '周五收盘后必须跳到下周一，给出周六等于给了一个不开市的复核时点',
  );
}

// ===== 7. 候选口径升版必须分批，不得让全部计划同时消失（第二轮 C1）=====
//
// 升版本那一轮库里所有生效计划都不是当前口径。一次性全打成 expired 的话
// getActivePlan 全返回 null、listLivePlans 也不再包含它们，而本轮只重建得了 MAX_PER_RUN 只，
// 跟踪 N 只标的就要 ceil(N/8) 个交易日才恢复，期间界面上一律「尚无交易计划」。

{
  // 清掉前面几节遗留的队列，本节才能精确观察名额分配
  for (const p of repo.listStalePlans()) repo.updateStatus(p.id, 'superseded');
  assert.equal(repo.listStalePlans().length, 0, '前置条件：待重算队列已清空');

  const codes: string[] = [];
  for (let i = 0; i < 12; i++) {
    const code = `4000${String(i).padStart(2, '0')}`;
    codes.push(code);
    repo.insertPlan(mkPlan(code, 1, 'active', 'candidate-v1'));
  }
  calls = [];
  onCall = () => {};
  const s = await regenerateStalePlans({ call: fakeCall });

  assert.ok(s.outdated <= 8, `单轮最多把 8 只换口径，实际 ${s.outdated} 只`);
  assert.equal(s.outdated, 8, '名额空着就该用满，否则换口径要拖更多个交易日');
  const stillLive = codes.filter((c) => repo.getActivePlan(c) != null);
  assert.equal(
    stillLive.length,
    codes.length - s.outdated,
    `没轮到的旧口径计划必须保持生效，实际只剩 ${stillLive.length} 只可见`,
  );
  assert.ok(
    stillLive.length > 0,
    '绝不能一轮把全部计划打成过期：那会让用户在轮到自己之前一直看到「尚无交易计划」',
  );
}

// ===== 8. 生效但已过有效期的计划必须进队列（第二轮 H1）=====
//
// 风险路径启动后计划状态停在 triggered（仍是 live），只有有效期被收紧到当场收盘。
// 队列若只认 invalid/expired，那份多头情景已被行情否掉的计划会一直求值到 28 天满。

{
  repo.insertPlan({ ...mkPlan('500001', 1, 'triggered'), expiresAt: '2020-01-01T00:00:00.000Z' });
  assert.ok(
    repo.listStalePlans().some((p) => p.code === '500001'),
    '状态仍是 live 但已过有效期的计划必须进重算队列',
  );
  // 有效期未到的 triggered 计划不得被误伤：主路径刚触发的计划正在执行中
  repo.insertPlan({ ...mkPlan('500002', 1, 'triggered'), expiresAt: '2099-01-01T00:00:00.000Z' });
  assert.ok(
    !repo.listStalePlans().some((p) => p.code === '500002'),
    '有效期内的触发计划不得被当成待重算，否则刚触发就被推翻重来',
  );
}

// ===== 9. 指数类计划必须退出队列，不得每轮空烧一次 agent 调用（第二轮 M5）=====
//
// 指数生成不出新版本（validateProposal 拒、fallbackDraft 也返回 null），
// 而失败即原样留在 expired，两条入队条件永久满足：每轮认领一次、占一个名额、追加一条失败事件。

{
  repo.insertPlan({ ...mkPlan('000300', 1, 'expired'), assetType: 'index' });
  repo.insertPlan({ ...mkPlan('BK9999', 1, 'expired'), assetType: 'index' });
  calls = [];
  onCall = () => {};
  const s = await regenerateStalePlans({ call: fakeCall });
  assert.equal(s.retired, 2, '两份指数类计划都应被退出队列');
  assert.ok(!calls.includes('000300'), '指数类计划不得被认领重算，那是每轮白烧一次 agent 调用');
  assert.equal(repo.getPlan('000300-v1')?.status, 'superseded', '退出队列须落一个终态，否则下轮又被挑中');
  assert.ok(
    repo.listEvents('000300-v1').some((e) => e.note.includes('不支持交易计划')),
    '退出队列必须留一条说明，否则用户看到计划无故变历史查不到原因',
  );
  assert.ok(
    !repo.listStalePlans().some((p) => p.code === '000300'),
    '退出后不得再出现在队列里',
  );
}

rmSync(tmpDir, { recursive: true, force: true });
console.log(
  '✅ 收盘重算自检通过（只挑最新版失效/过期 · 生效计划不被推翻 · 同标的多历史失效版只算一只 · 落库才算成功 · 失败保留旧计划并留说明 · 单轮上限顺延 · 候选口径过期派生 stale 且分批不清空 · 过期但未改状态的计划进队列 · 指数类计划退出队列 · 交易日历复核时点）',
);
