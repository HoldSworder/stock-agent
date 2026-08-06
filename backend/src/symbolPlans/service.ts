import type {
  CandidateCatalog,
  CandidateCondition,
  CandidateLevel,
  PlanCondition,
  SymbolPlanAction,
  SymbolTechnicalContext,
  SymbolTradePlan,
  SymbolTradePlanProposal,
  TradeLevel,
  TradeLevelRole,
  TradeScenario,
} from '@stock-agent/shared';
import { sqlite } from '../db/client';
import { newId, nowIso } from '../util';
import * as repo from './repo';
import { syncPlanMarks } from './markSync';
import { recordForecasts } from './forecast';
import { PHASE_MODEL_VERSION, tighten } from './phase';
import { CANDIDATE_MODEL_VERSION } from './candidateCatalog';

// 计划编译与落库（计划 7.2 + R1 职责边界）。
// LLM 只提交 SymbolTradePlanProposal（摘要 + 候选 ID 组合）；
// 阶段/趋势/结构/风险/仓位/主动作等确定性字段全部由后端从证据填充，LLM 无从篡改。

/** 单条校验错误：给 LLM 结构化重试用（字段 + 错误码 + 可用候选） */
export interface ProposalIssue {
  field: string;
  code:
    | 'unknown_level_candidate'
    | 'duplicate_level_candidate'
    | 'unknown_condition_candidate'
    | 'purpose_mismatch'
    /** 被选作失效条件的候选在计划生成时就已成立，会产出一份出生即失效的计划 */
    | 'invalidation_already_true'
    | 'role_not_compatible'
    | 'catalog_mismatch'
    | 'catalog_expired'
    | 'missing_trigger'
    | 'missing_invalidation'
    | 'missing_summary'
    | 'price_out_of_range'
    | 'no_scenario';
  message: string;
  availableCandidateIds?: string[];
}

export class ProposalRejected extends Error {
  constructor(readonly issues: ProposalIssue[]) {
    super(`计划提案校验失败（${issues.length} 项）`);
  }
}

/** 价位合理性：不得偏离现价过远（防候选目录被污染或单位错乱） */
const MAX_PRICE_DEVIATION = 0.6;

export interface CompileInput {
  context: SymbolTechnicalContext;
  catalog: CandidateCatalog;
  proposal: SymbolTradePlanProposal;
  /** 由确定性风险服务算出，不由 LLM 提供 */
  risk: SymbolTradePlan['risk'];
  positionContext: SymbolTradePlan['positionContext'];
  execution: SymbolTradePlan['execution'];
  /** 已过外部闸门的标的动作与账户动作 */
  marketAction: SymbolPlanAction;
  primaryAction: SymbolPlanAction;
  assetSpecificRisks: string[];
  sessionId: string | null;
  runId: string | null;
  validFrom: string;
  expiresAt: string | null;
}

/**
 * 校验提案。全部问题一次收集完再抛，便于 LLM 一轮修正而不是反复试探。
 */
export function validateProposal(input: CompileInput): ProposalIssue[] {
  const { catalog, proposal, context } = input;
  const issues: ProposalIssue[] = [];

  if (!proposal.summary?.trim()) {
    issues.push({ field: 'summary', code: 'missing_summary', message: '缺少 summary' });
  }

  // 跨快照混用防护
  if (proposal.contextId !== catalog.contextId) {
    issues.push({
      field: 'contextId',
      code: 'catalog_mismatch',
      message: `contextId 不匹配：提案 ${proposal.contextId}，当前目录 ${catalog.contextId}`,
    });
  }
  if (proposal.catalogHash !== catalog.catalogHash) {
    issues.push({
      field: 'catalogHash',
      code: 'catalog_mismatch',
      message: `catalogHash 不匹配，候选目录已变化，请重新取候选后再提交`,
    });
  }
  if (proposal.candidateModelVersion !== catalog.candidateModelVersion) {
    issues.push({
      field: 'candidateModelVersion',
      code: 'catalog_mismatch',
      message: `候选模型版本不匹配：${proposal.candidateModelVersion} vs ${catalog.candidateModelVersion}`,
    });
  }
  if (catalog.expiresAt && catalog.expiresAt < nowIso()) {
    issues.push({
      field: 'contextId',
      code: 'catalog_expired',
      message: `候选目录已于 ${catalog.expiresAt} 过期，请重新生成技术上下文`,
    });
  }
  const levelById = new Map(catalog.levels.map((l) => [l.candidateId, l]));
  const condById = new Map(catalog.conditions.map((c) => [c.candidateId, c]));
  const price = context.periods[0]?.close ?? 0;

  // 价位选择
  //
  // 只拒绝「同一候选 + 同一角色」这种纯粹的重复条目。同一价位兼任多个角色是合法业务表达
  // （一个价带既是支撑、跌破它也就是结构失效；摆动高点既是压力也是第一目标），
  // 不能因为它们画在同一高度就拒掉整份提案——两次被拒会降级成没有可执行价位的观察计划。
  // 图上的重合由 markSync 按价位合并标注解决，不在这一层堵。
  const seenSelections = new Set<string>();
  proposal.levelSelections?.forEach((sel, i) => {
    const key = `${sel.candidateLevelId}|${sel.role}`;
    if (seenSelections.has(key)) {
      issues.push({
        field: `levelSelections[${i}]`,
        code: 'duplicate_level_candidate',
        message: `候选价位 ${sel.candidateLevelId} 已经以角色 ${sel.role} 选过一次，同一组合不要重复提交`,
      });
      return;
    }
    seenSelections.add(key);
    const cand = levelById.get(sel.candidateLevelId);
    if (!cand) {
      issues.push({
        field: `levelSelections[${i}].candidateLevelId`,
        code: 'unknown_level_candidate',
        message: `候选价位 ${sel.candidateLevelId} 不在当次目录内，禁止自造价位`,
        availableCandidateIds: catalog.levels.map((l) => l.candidateId),
      });
      return;
    }
    if (!cand.compatibleRoles.includes(sel.role)) {
      issues.push({
        field: `levelSelections[${i}].role`,
        code: 'role_not_compatible',
        message: `候选 ${sel.candidateLevelId} 不支持角色 ${sel.role}，可选：${cand.compatibleRoles.join('/')}`,
      });
    }
    if (price > 0 && Math.abs(cand.price - price) / price > MAX_PRICE_DEVIATION) {
      issues.push({
        field: `levelSelections[${i}]`,
        code: 'price_out_of_range',
        message: `候选价 ${cand.price} 偏离现价 ${price} 超过 ${MAX_PRICE_DEVIATION * 100}%`,
      });
    }
  });

  // 情景
  if (!proposal.scenarioSelections?.length) {
    issues.push({ field: 'scenarioSelections', code: 'no_scenario', message: '至少需要一个情景' });
  }
  proposal.scenarioSelections?.forEach((sc, i) => {
    const checkIds = (
      ids: string[],
      f: string,
      expect: 'trigger' | 'invalidation',
    ): CandidateCondition[] => {
      const out: CandidateCondition[] = [];
      for (const id of ids ?? []) {
        const c = condById.get(id);
        if (!c) {
          issues.push({
            field: `scenarioSelections[${i}].${f}`,
            code: 'unknown_condition_candidate',
            message: `候选条件 ${id} 不在当次目录内`,
            availableCandidateIds: catalog.conditions.map((x) => x.candidateId),
          });
          continue;
        }
        // 必须排在 purpose_mismatch 之前：目录已把已成立的条件从 suitableFor 摘掉，
        // 落到下面只会报「只适用于 trigger」，模型据此换一条同样已成立的条件继续撞墙。
        if (expect === 'invalidation' && c.alreadySatisfied) {
          issues.push({
            field: `scenarioSelections[${i}].${f}`,
            code: 'invalidation_already_true',
            message:
              `候选条件 ${id}「${c.description}」在计划生成时就已成立，不能当失效条件。` +
              '失效条件必须是「将来若发生则计划作废」的事；用已发生的事实做失效条件，' +
              '计划第一次复核就会判失效。请改选一条当前尚未成立的失效条件。',
            availableCandidateIds: catalog.conditions
              .filter((x) => x.suitableFor.includes('invalidation'))
              .map((x) => x.candidateId),
          });
          continue;
        }
        // 用途护栏：只防「LLM 把条件放错数组」。它读的仍是目录里的 suitableFor，
        // 所以防不了白名单本身极性写反——那一层由 candidateCatalog 的独立断言锁死。
        if (!c.suitableFor.includes(expect)) {
          issues.push({
            field: `scenarioSelections[${i}].${f}`,
            code: 'purpose_mismatch',
            message: `候选条件 ${id}「${c.description}」只适用于 ${c.suitableFor.join('/')}，不能当作${expect === 'trigger' ? '触发' : '失效'}条件`,
            availableCandidateIds: catalog.conditions
              .filter((x) => x.suitableFor.includes(expect))
              .map((x) => x.candidateId),
          });
          continue;
        }
        out.push(c);
      }
      return out;
    };
    const trig = checkIds(sc.conditionCandidateIds, 'conditionCandidateIds', 'trigger');
    const inval = checkIds(sc.invalidConditionCandidateIds, 'invalidConditionCandidateIds', 'invalidation');
    for (const id of sc.targetCandidateLevelIds ?? []) {
      if (!levelById.has(id)) {
        issues.push({
          field: `scenarioSelections[${i}].targetCandidateLevelIds`,
          code: 'unknown_level_candidate',
          message: `目标价位 ${id} 不在当次目录内`,
          availableCandidateIds: catalog.levels.map((l) => l.candidateId),
        });
      }
    }
    // 每个动作情景都必须有触发与失效条件（计划 7.2 第 6 条）
    if (trig.length === 0) {
      issues.push({
        field: `scenarioSelections[${i}].conditionCandidateIds`,
        code: 'missing_trigger',
        message: `情景「${sc.name || i}」缺少触发条件`,
      });
    }
    if (inval.length === 0) {
      issues.push({
        field: `scenarioSelections[${i}].invalidConditionCandidateIds`,
        code: 'missing_invalidation',
        message: `情景「${sc.name || i}」缺少失效条件`,
      });
    }
  });

  return issues;
}

function toPlanCondition(c: CandidateCondition, required: boolean): PlanCondition {
  return {
    id: c.candidateId,
    rule: c.rule,
    timeframe: c.timeframe,
    description: c.description,
    required,
    evidenceIds: c.evidenceIds,
  };
}

/**
 * 主观概率归一：越界或非数一律丢弃，不夹逼到 0/100。
 * 夹逼会把「模型输出坏了」伪装成「模型很有把握」，而这个数本就没资格被抢救。
 */
function normalizeProbability(v: number | undefined): number | undefined {
  if (v == null || !Number.isFinite(v) || v < 0 || v > 100) return undefined;
  return Math.round(v);
}

function toTradeLevel(cand: CandidateLevel, role: TradeLevelRole, label: string | undefined): TradeLevel {
  const isZone = cand.high > cand.low;
  return {
    id: cand.candidateId,
    role,
    timeframe: cand.timeframe,
    price: isZone ? undefined : cand.price,
    zoneLow: isZone ? cand.low : undefined,
    zoneHigh: isZone ? cand.high : undefined,
    label: label?.trim() || cand.label,
    rationale: cand.description,
    evidenceIds: cand.sourceEvidenceIds,
    // 透传来源，供图上把「这条金色 0.618」与「这条计划触发线」认成同一条，详见 TradeLevel.sources
    sources: cand.sources,
  };
}

/**
 * 把提案编译成完整计划并在一个事务内落库 + 同步标注 + 写事件。
 * 任一步失败整体回滚，绝不留下「文字已更新但图上仍是旧线」或反之。
 */
export function compileAndSavePlan(input: CompileInput): SymbolTradePlan {
  const issues = validateProposal(input);
  if (issues.length > 0) throw new ProposalRejected(issues);

  const { context, catalog, proposal } = input;
  const levelById = new Map(catalog.levels.map((l) => [l.candidateId, l]));
  const condById = new Map(catalog.conditions.map((c) => [c.candidateId, c]));

  const levels: TradeLevel[] = (proposal.levelSelections ?? []).map((sel) =>
    toTradeLevel(levelById.get(sel.candidateLevelId)!, sel.role, sel.label),
  );

  const scenarios: TradeScenario[] = (proposal.scenarioSelections ?? []).map((sc, i) => ({
    id: `sc:${i}:${sc.rank}`,
    rank: sc.rank,
    name: sc.name || `${sc.rank} 情景`,
    // 情景动作由后端按标的动作给定，LLM 不得自定。
    // 风险情景必须走 tighten：exit 比 reduce 保守，阶段 decline 或板块 exit_only 已把动作收成 exit 时，
    // 直接写死 reduce 会把退出放大成减仓，违反「只收紧不放大」。
    action: sc.rank === 'risk' ? tighten(input.marketAction, 'reduce') : input.marketAction,
    conditions: (sc.conditionCandidateIds ?? [])
      .map((id) => condById.get(id))
      .filter((c): c is CandidateCondition => !!c)
      .map((c) => toPlanCondition(c, true)),
    invalidConditions: (sc.invalidConditionCandidateIds ?? [])
      .map((id) => condById.get(id))
      .filter((c): c is CandidateCondition => !!c)
      .map((c) => toPlanCondition(c, true)),
    targetLevelIds: sc.targetCandidateLevelIds ?? [],
    // 主观概率原样透传：它是全计划里唯一允许来自 LLM 的「数」，
    // 代价是必须处处按「只展示」对待——落库与核对见 forecast.ts，越界拦截见 symbolPlanProjection.selfcheck.ts
    subjectiveProbabilityPct: normalizeProbability(sc.subjectiveProbabilityPct),
    probabilityBasis: sc.probabilityBasis?.trim() || undefined,
  }));

  // 止盈计划从已选目标位派生，不由 LLM 填
  const targets = levels.filter((l) => l.role === 'target');
  const now = nowIso();
  // 版本号在下面的 immediate 事务里分配，见事务处注释
  const plan: SymbolTradePlan = {
    id: newId(),
    version: 0,
    code: context.code,
    name: context.name,
    assetType: context.assetType,
    status: 'active',
    asOf: context.asOf,
    validFrom: input.validFrom,
    expiresAt: input.expiresAt,
    dataStatus: context.dataStatus,
    marketPhase: context.phase.phase,
    trendState: context.dow?.state ?? 'range',
    chanSetup: context.chan?.setup ?? 'insufficient',
    marketAction: input.marketAction,
    primaryAction: input.primaryAction,
    summary: proposal.summary.trim(),
    changes: (proposal.changes ?? []).filter((c) => c.trim()),
    levels,
    scenarios,
    positionContext: input.positionContext,
    risk: input.risk,
    exitPlan: {
      firstTakeProfitLevelId: targets[0]?.id ?? null,
      secondTakeProfitLevelId: targets[1]?.id ?? null,
      trailingRule:
        targets.length > 0
          ? '剩余仓位以最近一个更高低点或 MA20 跟踪保护，保护线只上移不下调'
          : null,
      reduceFractions: targets.length >= 2 ? [1 / 3, 1 / 3] : targets.length === 1 ? [1 / 2] : [],
      profitProtectionRule: '达到第一目标后保护线上移至成本或最近结构低点，取更高者',
    },
    execution: input.execution,
    benchmarks: context.benchmarks,
    assetSpecificRisks: input.assetSpecificRisks,
    evidenceSnapshot: {
      contextId: context.contextId,
      phase: context.phase,
      dow: context.dow,
      chan: context.chan,
      volumePrice: context.volumePrice,
      relativeStrength: context.relativeStrength,
      breadth: context.breadth,
      catalogHash: catalog.catalogHash,
      omittedCounts: catalog.omittedCounts,
      warnings: [...context.warnings, ...catalog.warnings],
    },
    evidenceVersion: context.evidenceVersion,
    phaseModelVersion: PHASE_MODEL_VERSION,
    candidateModelVersion: CANDIDATE_MODEL_VERSION,
    contextId: context.contextId,
    sessionId: input.sessionId,
    runId: input.runId,
    createdAt: now,
    updatedAt: now,
  };

  // 事务：版本分配 + 计划 + 旧版本 supersede + 标注同步 + 事件，全成或全不成。
  //
  // 版本号必须在事务**内**取。放在事务外的话，dev 双开或多进程部署时两边可能读到同一个
  // max(version)，唯一索引 idx_symbol_plans_code_version 会兜住但其中一方直接抛错、计划丢失。
  // 走 immediate 而非默认的 deferred：deferred 要等第一条写语句才升级锁，
  // 「读版本号」这一步仍在共享锁下并发发生，等于没锁。
  const tx = sqlite.transaction(() => {
    plan.version = repo.nextVersion(plan.code);
    repo.insertPlan(plan);
    const superseded = repo.supersedeOthers(plan.code, plan.id);
    syncPlanMarks(plan);
    // 概率预测与计划同生共死：只落一半会让核对表出现判不了的无主记录
    recordForecasts(plan, context.periods.find((p) => p.meta.period === 'day')?.close ?? 0);
    repo.appendEvent({
      planId: plan.id,
      planVersion: plan.version,
      kind: 'created',
      note: `v${plan.version} 生成（阶段 ${plan.marketPhase}，动作 ${plan.primaryAction}，${levels.length} 条关键位）`,
    });
    repo.appendEvent({
      planId: plan.id,
      planVersion: plan.version,
      kind: 'activated',
      note: `生效区间 ${plan.validFrom} ~ ${plan.expiresAt ?? '未设定'}`,
    });
    for (const old of superseded) {
      repo.appendEvent({
        planId: old.id,
        planVersion: old.version,
        kind: 'superseded',
        note: `被 v${plan.version}（${plan.id}）替代`,
      });
    }
  });
  tx.immediate();

  return plan;
}

/**
 * 校验失败二次重试仍不通过时的降级：落一份只含后端确定性字段的观察计划。
 * 不含未通过校验的价位、情景与标注，因此绝不会留下半套辅助线。
 */
export function saveDraftObservationPlan(input: {
  context: SymbolTechnicalContext;
  risk: SymbolTradePlan['risk'];
  positionContext: SymbolTradePlan['positionContext'];
  execution: SymbolTradePlan['execution'];
  marketAction: SymbolPlanAction;
  primaryAction: SymbolPlanAction;
  assetSpecificRisks: string[];
  sessionId: string | null;
  runId: string | null;
  reason: string;
}): SymbolTradePlan {
  const { context } = input;
  const now = nowIso();
  // 与 compileAndSavePlan 同理，版本号在 immediate 事务内分配
  const plan: SymbolTradePlan = {
    id: newId(),
    version: 0,
    code: context.code,
    name: context.name,
    assetType: context.assetType,
    status: 'draft',
    asOf: context.asOf,
    validFrom: now,
    expiresAt: null,
    dataStatus: context.dataStatus,
    marketPhase: context.phase.phase,
    trendState: context.dow?.state ?? 'range',
    chanSetup: context.chan?.setup ?? 'insufficient',
    marketAction: input.marketAction,
    // 观察计划一律等待，不给可执行动作
    primaryAction: 'wait',
    summary: `观察计划（未产出可执行价位）：${input.reason}`,
    changes: [],
    levels: [],
    scenarios: [],
    positionContext: input.positionContext,
    risk: input.risk,
    exitPlan: {
      firstTakeProfitLevelId: null,
      secondTakeProfitLevelId: null,
      trailingRule: null,
      reduceFractions: [],
      profitProtectionRule: null,
    },
    execution: input.execution,
    benchmarks: context.benchmarks,
    assetSpecificRisks: input.assetSpecificRisks,
    evidenceSnapshot: { contextId: context.contextId, phase: context.phase, warnings: context.warnings },
    evidenceVersion: context.evidenceVersion,
    phaseModelVersion: PHASE_MODEL_VERSION,
    candidateModelVersion: CANDIDATE_MODEL_VERSION,
    contextId: context.contextId,
    sessionId: input.sessionId,
    runId: input.runId,
    createdAt: now,
    updatedAt: now,
  };

  const tx = sqlite.transaction(() => {
    plan.version = repo.nextVersion(plan.code);
    repo.insertPlan(plan);
    // 必须同样 supersede 旧版本并同步标注：否则旧 active 计划仍在 LIVE_STATUSES 里被盘中引擎继续求值，
    // 图上也还挂着上一版的辅助线，而正文已经变成「未产出可执行价位」。
    const superseded = repo.supersedeOthers(plan.code, plan.id);
    // levels 为空时 syncPlanMarks 只做 historize、不插入新线，正是观察计划需要的效果
    syncPlanMarks(plan);
    repo.appendEvent({
      planId: plan.id,
      planVersion: plan.version,
      kind: 'created',
      note: `降级为观察计划：${input.reason}`,
    });
    for (const old of superseded) {
      repo.appendEvent({
        planId: old.id,
        planVersion: old.version,
        kind: 'superseded',
        note: `被观察计划 v${plan.version}（${plan.id}）替代`,
      });
    }
  });
  tx.immediate();
  return plan;
}

/** 结构化错误 → 给 LLM 的可读重试指引 */
export function formatIssuesForRetry(issues: ProposalIssue[]): string {
  const lines = issues.map((it) => {
    const avail = it.availableCandidateIds?.length
      ? `\n  可用候选：${it.availableCandidateIds.slice(0, 30).join(', ')}`
      : '';
    return `- [${it.code}] ${it.field}：${it.message}${avail}`;
  });
  return (
    `提案未通过校验，请只修正以下问题后重新提交一次（不要改动其他字段，也不要自造价位）：\n${lines.join('\n')}`
  );
}
