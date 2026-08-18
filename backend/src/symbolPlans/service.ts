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
import { nextTradingClose } from './sessionClock';

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
    /** 被选作触发条件的候选在计划生成时就已成立，会产出一份出生即触发的计划 */
    | 'trigger_already_true'
    /** 触发条件的极性与情景动作相反（如「收盘跌破支撑」配加仓） */
    | 'trigger_polarity_mismatch'
    /** 穿越型条件的方向已错过（现价已在价位另一侧），该事件不原路走回去就永不成立 */
    | 'condition_direction_missed'
    | 'role_not_compatible'
    | 'catalog_mismatch'
    | 'catalog_expired'
    | 'missing_trigger'
    | 'missing_invalidation'
    | 'missing_summary'
    | 'price_out_of_range'
    /** 情景目标价位没出现在 levelSelections 里，落库后解析不出价，预测永远判不出 hit */
    | 'target_not_selected'
    /** 买入类计划的入场价不高于止损价，按它算「单笔最大亏损」会得到负数 */
    | 'entry_below_stop'
    /** 指数类标的暂不支持保存交易计划（全链路按 code 定位，与个股撞码） */
    | 'asset_not_tradable'
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

  // 指数不落交易计划：计划表、求值、标注、会话全链路都按 code 定位，而指数与个股撞码
  // （000300 会被解析成深市个股），于是会拿另一只标的的 OHLC 判触及与失效。
  // secid 列已备好通路，等全链路都改成按 secid 取数后再放开。
  if (context.assetType === 'index') {
    issues.push({
      field: 'contextId',
      code: 'asset_not_tradable',
      message:
        '指数类标的暂不支持保存交易计划或预测：指数代码与个股撞码，求值时会取到另一只标的的行情。' +
        '请改为分析对应的 ETF，或只做技术研判不落计划。',
    });
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

  const selectedLevelIds = new Set(
    (proposal.levelSelections ?? [])
      .filter((s) => levelById.has(s.candidateLevelId))
      .map((s) => s.candidateLevelId),
  );

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
        // 同样必须排在 purpose_mismatch 之前：目录已把这类条件的 suitableFor 摘空，
        // 落到下面只会报「只适用于 」，模型看不出真正的原因。
        if (c.directionMissed) {
          issues.push({
            field: `scenarioSelections[${i}].${f}`,
            code: 'condition_direction_missed',
            message:
              `候选条件 ${id}「${c.description}」的穿越方向已经错过：现价已在该价位的另一侧，` +
              '这个事件要成立得先原路走回去再穿一次。当失效条件等于没有保护，当触发条件则会让整份计划永远无法触发。' +
              '请改选一条方向仍成立的条件。',
            availableCandidateIds: catalog.conditions
              .filter((x) => x.suitableFor.includes(expect))
              .map((x) => x.candidateId),
          });
          continue;
        }
        // 必须排在 purpose_mismatch 之前：目录已把已成立的条件从 suitableFor 摘掉，
        // 落到下面只会报「只适用于 trigger」，模型据此换一条同样已成立的条件继续撞墙。
        //
        // 触发侧同样要拦。看跌关系改成双用途之后，一条已成立的看跌条件（如价位在现价上方的
        // holdBelow，它恒为真）不再被摘空，而是变成一条合法的触发条件——计划一落库、
        // 第一次复核就判触发，风险路径凭空启动。已成立的事实两个用途都当不了。
        if (c.alreadySatisfied) {
          issues.push({
            field: `scenarioSelections[${i}].${f}`,
            code: expect === 'invalidation' ? 'invalidation_already_true' : 'trigger_already_true',
            message:
              expect === 'invalidation'
                ? `候选条件 ${id}「${c.description}」在计划生成时就已成立，不能当失效条件。` +
                  '失效条件必须是「将来若发生则计划作废」的事；用已发生的事实做失效条件，' +
                  '计划第一次复核就会判失效。请改选一条当前尚未成立的失效条件。'
                : `候选条件 ${id}「${c.description}」在计划生成时就已成立，不能当触发条件。` +
                  '触发条件必须是「将来若发生则动手」的事；用已发生的事实做触发条件，' +
                  '计划第一次复核就会判触发。请改选一条当前尚未成立的触发条件。',
            availableCandidateIds: catalog.conditions
              .filter((x) => x.suitableFor.includes(expect))
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
    issues.push(...checkTriggerPolarity(sc, trig, i, input.marketAction));
    for (const id of sc.targetCandidateLevelIds ?? []) {
      if (!levelById.has(id)) {
        issues.push({
          field: `scenarioSelections[${i}].targetCandidateLevelIds`,
          code: 'unknown_level_candidate',
          message: `目标价位 ${id} 不在当次目录内`,
          availableCandidateIds: catalog.levels.map((l) => l.candidateId),
        });
        continue;
      }
      // 目标必须同时出现在 levelSelections 里：计划只存 levels 里的价位，
      // 没被选进去的 id 落库后在 plan.levels 里查不到，预测记录解析不出目标价，永远判不出 hit。
      if (!selectedLevelIds.has(id)) {
        issues.push({
          field: `scenarioSelections[${i}].targetCandidateLevelIds`,
          code: 'target_not_selected',
          message:
            `目标价位 ${id} 没有出现在 levelSelections 里。` +
            '请先把它以 role="target" 选进 levelSelections，再在情景里引用——' +
            '否则计划里根本没有这个价位，事后无法判定目标是否兑现。',
          availableCandidateIds: Array.from(selectedLevelIds),
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

  issues.push(...checkEntryAboveStop(input));

  return issues;
}

/** 条件的方向极性。目录用不到的 kind 一律返回 null（中性），不做牵强的猜测 */
function polarityOf(rule: CandidateCondition['rule']): 'bullish' | 'bearish' | null {
  switch (rule.kind) {
    case 'priceLevel':
      if (rule.relation === 'crossUp' || rule.relation === 'holdAbove') return 'bullish';
      if (rule.relation === 'crossDown' || rule.relation === 'holdBelow') return 'bearish';
      return null;
    case 'ma':
      if (rule.relation === 'above' || rule.relation === 'crossUp') return 'bullish';
      return 'bearish';
    case 'macd':
      if (rule.signal === 'goldCross' || rule.signal === 'barAbove0') return 'bullish';
      return 'bearish';
    case 'closeLocation':
      if (rule.op === 'gt' || rule.op === 'gte') return 'bullish';
      if (rule.op === 'lt' || rule.op === 'lte') return 'bearish';
      return null;
    default:
      return null;
  }
}

/**
 * 触发条件的极性必须与情景动作一致。
 *
 * 看跌关系改成双用途（trigger + invalidation）之后，「收盘跌破支撑」在结构上可以合法地
 * 写进任何情景的触发数组——包括 rank='primary'、action='add' 的加仓情景，
 * 而那正是「跌破支撑就加仓」这种全程无人拦截的反向指令。改动前它不含 trigger、
 * 物理上进不了触发数组，双用途把这唯一的结构性护栏一并拆掉了，只能在这里补回来。
 *
 * 情景动作的算法必须与 compileAndSavePlan 一致（风险情景走 tighten），否则校验的是另一份计划。
 */
function checkTriggerPolarity(
  sc: { rank: TradeScenario['rank']; name?: string },
  trig: CandidateCondition[],
  i: number,
  marketAction: SymbolPlanAction,
): ProposalIssue[] {
  const action = sc.rank === 'risk' ? tighten(marketAction, 'reduce') : marketAction;
  const forbidden: 'bullish' | 'bearish' | null =
    action === 'add' || action === 'probe'
      ? 'bearish'
      : action === 'reduce' || action === 'exit'
        ? 'bullish'
        : null;
  if (!forbidden) return [];
  return trig
    .filter((c) => polarityOf(c.rule) === forbidden)
    .map((c) => ({
      field: `scenarioSelections[${i}].conditionCandidateIds`,
      code: 'trigger_polarity_mismatch' as const,
      message:
        `情景「${sc.name || i}」的动作是 ${action}，触发条件 ${c.candidateId}「${c.description}」` +
        `却是${forbidden === 'bearish' ? '看跌' : '看多'}的。` +
        `${forbidden === 'bearish' ? '买入类动作要等的是转强信号，跌破/死叉只能作失效条件或风险情景的触发' : '减仓类动作要等的是转弱信号，站上/金叉不该触发减仓'}。` +
        '请改选一条方向一致的触发条件，或把这条放进 invalidConditionCandidateIds。',
    }));
}

/**
 * 买入类计划必须满足「入场价 > 止损价」。
 *
 * 不校验的话，`(entry - stop) × 股数` 会算出负数的「单笔最大亏损」，
 * 界面上就成了一份「买入还能赚风险预算」的计划；`rescaleSharesToEntry` 也会因风险距离为负
 * 反推出被放大的股数。这类提案本身就是选错了角色（把压力位当止损、或把止损挂在入场上方），
 * 给校验码让 LLM 重提比事后收紧仓位更准。
 */
function checkEntryAboveStop(input: CompileInput): ProposalIssue[] {
  const BUY_ACTIONS: SymbolPlanAction[] = ['add', 'probe'];
  if (!BUY_ACTIONS.includes(input.primaryAction) && !BUY_ACTIONS.includes(input.marketAction)) {
    return [];
  }
  const levelById = new Map(input.catalog.levels.map((l) => [l.candidateId, l]));
  /** 区间价位取对买入更不利的一侧：入场取高、止损取低，宁可算出更小的仓位 */
  const priceOf = (id: string, side: 'high' | 'low'): number | null => {
    const l = levelById.get(id);
    if (!l) return null;
    const v = side === 'high' ? l.high : l.low;
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const entries: number[] = [];
  const stops: number[] = [];
  for (const sel of input.proposal.levelSelections ?? []) {
    if (sel.role === 'entry_trigger' || sel.role === 'add_trigger') {
      const p = priceOf(sel.candidateLevelId, 'high');
      if (p != null) entries.push(p);
    }
    if (sel.role === 'stop' || sel.role === 'invalidation') {
      const p = priceOf(sel.candidateLevelId, 'low');
      if (p != null) stops.push(p);
    }
  }
  if (entries.length === 0 || stops.length === 0) return [];
  const entry = Math.min(...entries);
  const stop = Math.max(...stops);
  if (entry > stop) return [];
  return [
    {
      field: 'levelSelections',
      code: 'entry_below_stop',
      message:
        `买入类计划的入场价 ${entry.toFixed(3)} 不高于止损价 ${stop.toFixed(3)}，` +
        '按它算出的「单笔最大亏损」会是负数，仓位也会被反推放大。' +
        '请把止损改选到入场价下方的支撑/结构失效位，或把入场触发位改到止损上方。',
    },
  ];
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
    secid: context.secid,
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
    secid: context.secid,
    status: 'draft',
    asOf: context.asOf,
    validFrom: now,
    // 观察计划必须有到期日：draft 在 PLAN_LIVE_STATUSES 内，expiresAt=null 时它既不会被判过期、
    // 也进不了 listStalePlans 的重算队列，收盘重算从此永远不再认领这个标的，
    // 只能靠用户手动点「生成计划」——一次降级等于把该标的踢出自动流水线。
    expiresAt: nextTradingClose(new Date(now)),
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
