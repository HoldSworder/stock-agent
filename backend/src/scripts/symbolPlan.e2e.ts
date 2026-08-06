// 端到端验收：对个股 / 境内行业 ETF / 跨境 ETF 三类标的，走真实取数装配技术上下文与候选目录，
// 再用「从候选里挑」的方式提交一份计划，验证全链路可用与字符预算达标。
//
// 一律跑在临时 sqlite 上：提交计划会 supersedeOthers 把这三只标的的 active 计划全部作废、
// 标注转 historical，而清理只能把新建的置 expired、恢复不了被顶掉的旧计划——
// 跑一次验收就静默作废用户真实计划。真实取数与临时库不冲突。
// 运行：cd backend && pnpm exec tsx src/scripts/symbolPlan.e2e.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SymbolTradePlanProposal, TradeLevelRole } from '@stock-agent/shared';

const tmpDir = mkdtempSync(join(tmpdir(), 'symbolplan-e2e-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

// 必须在设好 DATABASE_PATH 之后再加载 db 相关模块（client.ts 在 import 期就打开 sqlite）
const { ensureSchema } = await import('../db/migrate');
const { prepareContext, submitProposal, ProposalRejected } = await import('../symbolPlans/orchestrator');
const { formatCandidates, formatTechnicalContext } = await import('../symbolPlans/format');
const repo = await import('../symbolPlans/repo');
const { listPlanMarks } = await import('../symbolPlans/markSync');
const { evaluatePlanById } = await import('../symbolPlans/evaluate');

ensureSchema();

const TARGETS: Array<{ code: string; name: string; kind: string }> = [
  { code: '600519', name: '贵州茅台', kind: '个股' },
  { code: '159516', name: '半导体设备ETF', kind: '境内行业ETF' },
  { code: '513180', name: '恒生科技指数ETF', kind: '跨境ETF' },
];

const created: string[] = [];
let failures = 0;

for (const t of TARGETS) {
  console.log(`\n===== ${t.kind}：${t.code} ${t.name} =====`);
  try {
    const snap = await prepareContext({ code: t.code, name: t.name });
    const c = snap.context;

    console.log(
      `资产类型 ${c.assetType}｜数据状态 ${c.dataStatus}｜阶段 ${c.phase.phase}｜` +
        `趋势 ${c.dow?.state}｜缠论 ${c.chan?.setup}｜周期数 ${c.periods.length}`,
    );
    console.log(`候选：价位 ${snap.catalog.levels.length} 个 / 条件 ${snap.catalog.conditions.length} 个`);
    // 板块闸门与账户维度必须能看出「取到了」还是「未覆盖」，不允许静默为空
    console.log(
      `外部闸门：大盘 ${c.marketRegimePhase ?? '未知'}｜板块 ${c.boardStage ?? '未覆盖'}｜` +
        `账户 ${c.positionContext ? `${c.positionContext.state}（权重 ${c.positionContext.currentWeightPct}%）` : '未接入/取数失败'}`,
    );
    console.log(
      `后端算定：市场动作 ${snap.marketAction}｜账户动作 ${snap.primaryAction}｜` +
        `结构止损 ${snap.risk.structuralStop ?? '—'}｜建议仓位 ${snap.risk.suggestedPositionPct ?? '—'}%`,
    );

    // 字符预算（计划 7.1 硬上限 6000）
    const ctxText = formatTechnicalContext(snap);
    const lvlText = formatCandidates(snap.catalog, 'levels');
    const condText = formatCandidates(snap.catalog, 'conditions');
    console.log(`字符数：上下文 ${ctxText.length}｜候选价位 ${lvlText.length}｜候选条件 ${condText.length}`);
    assert.ok(ctxText.length <= 6000, `技术上下文 ${ctxText.length} 字符超 6000 硬上限`);
    assert.ok(lvlText.length <= 6000, `候选价位 ${lvlText.length} 字符超 6000 硬上限`);
    assert.ok(condText.length <= 6000, `候选条件 ${condText.length} 字符超 6000 硬上限`);
    assert.ok(!ctxText.includes('"open"'), '技术上下文不得包含原始 K 线');

    assert.ok(c.periods.length >= 1, '至少要有日线读数');
    assert.ok(c.contextId.startsWith('ctx:'), 'contextId 格式应正确');

    if (snap.catalog.levels.length === 0) {
      console.log('⚠️ 无候选价位（点位测算不可用），跳过提交，符合「只能给观察计划」的设计');
      continue;
    }

    // 从候选里挑：一个压力/入场、一个支撑/失效、一个目标
    const pick = (roles: TradeLevelRole[]) =>
      snap.catalog.levels.find((l) => l.compatibleRoles.some((r) => roles.includes(r)));
    const entry = pick(['resistance', 'entry_trigger']);
    const stop = pick(['support', 'invalidation', 'stop']);
    const target = pick(['target']);
    const trig = snap.catalog.conditions.find((x) => x.suitableFor.includes('trigger'));
    const inval = snap.catalog.conditions.find((x) => x.suitableFor.includes('invalidation'));
    if (!entry || !stop || !trig || !inval) {
      console.log(
        `⚠️ 候选不足（entry=${!!entry} stop=${!!stop} trig=${!!trig} inval=${!!inval}），跳过提交`,
      );
      continue;
    }

    const selections: SymbolTradePlanProposal['levelSelections'] = [
      { candidateLevelId: entry.candidateId, role: entry.compatibleRoles.includes('resistance') ? 'resistance' : 'entry_trigger' },
      { candidateLevelId: stop.candidateId, role: stop.compatibleRoles.includes('support') ? 'support' : 'invalidation' },
    ];
    if (target) selections.push({ candidateLevelId: target.candidateId, role: 'target' });

    const proposal: SymbolTradePlanProposal = {
      contextId: c.contextId,
      candidateModelVersion: snap.catalog.candidateModelVersion,
      catalogHash: snap.catalog.catalogHash,
      summary: `端到端验收计划：阶段 ${c.phase.phase}，按后端算定动作 ${snap.primaryAction} 执行`,
      changes: ['端到端验收生成'],
      levelSelections: selections,
      scenarioSelections: [
        {
          rank: 'primary',
          name: '主路径',
          conditionCandidateIds: [trig.candidateId],
          invalidConditionCandidateIds: [inval.candidateId],
          targetCandidateLevelIds: target ? [target.candidateId] : [],
        },
      ],
    };

    const plan = submitProposal(proposal, { runId: 'e2e' });
    created.push(plan.id);
    console.log(
      `✅ 计划 v${plan.version} 已落库：${plan.levels.length} 条关键位、${plan.scenarios.length} 个情景`,
    );

    // 确定性字段必须来自后端
    assert.equal(plan.marketPhase, c.phase.phase, '阶段必须来自后端证据');
    assert.equal(plan.primaryAction, snap.primaryAction, '账户动作必须来自后端闸门');
    assert.deepEqual(plan.risk, snap.risk, '风险字段必须原样来自后端');

    // 标注已同步。画在同一高度的关键位由 markSync 合并成一条，故标注数 = 不同价位数
    const ms = listPlanMarks(plan.id, plan.version);
    const priceKeyOf = (lv: (typeof plan.levels)[number]): string =>
      lv.zoneLow != null && lv.zoneHigh != null && lv.zoneHigh > lv.zoneLow
        ? `${lv.zoneLow}~${lv.zoneHigh}`
        : String(lv.price ?? lv.zoneLow ?? lv.zoneHigh);
    assert.equal(
      ms.length,
      new Set(plan.levels.map(priceKeyOf)).size,
      '同一价位的多个角色应合并成一条标注，不同价位各一条',
    );
    console.log(`标注已同步 ${ms.length} 条（语义键 ${ms.map((m) => m.semanticKey).join(', ')}）`);

    // 求值一次（真实行情）
    const ev = await evaluatePlanById(plan.id);
    assert.ok(ev, '应能求值');
    const tickN = ev!.conditions.filter((x) => x.cadence === 'tick').length;
    const barN = ev!.conditions.filter((x) => x.cadence === 'bar').length;
    console.log(`求值：${ev!.summary}（tick 级 ${tickN} 条 / bar 级 ${barN} 条）`);

    // 伪造候选必须被拒
    try {
      submitProposal({ ...proposal, levelSelections: [{ candidateLevelId: 'lvl:fake', role: 'support' }] });
      throw new Error('伪造候选竟然通过了校验');
    } catch (e) {
      assert.ok(e instanceof ProposalRejected, '伪造候选应被 ProposalRejected 拒绝');
      console.log('✅ 伪造候选被正确拒绝');
    }
  } catch (e) {
    failures += 1;
    console.error(`❌ ${t.kind} ${t.code} 失败：`, e instanceof Error ? e.message : e);
  }
}

// 清理：把本次生成的计划置为 expired（临时库整体会被删掉，这一步只为验证清理路径本身可用）
for (const id of created) {
  repo.updateStatus(id, 'expired');
  // planVersion 必须取真实版本号：0 不是任何计划存在过的版本，事件会挂在不存在的版本上
  const version = repo.getPlan(id)?.version;
  if (version != null) {
    repo.appendEvent({ planId: id, planVersion: version, kind: 'expired', note: '端到端验收后自动清理' });
  }
}
console.log(`\n已把本次生成的 ${created.length} 份计划置为 expired（临时库位于 ${tmpDir}，稍后整体删除）`);

rmSync(tmpDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n❌ 端到端验收失败 ${failures} 项`);
  process.exit(1);
}
console.log('\n✅ 三类标的端到端验收通过');
