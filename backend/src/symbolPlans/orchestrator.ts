import type {
  CandidateCatalog,
  SymbolPhaseReading,
  SymbolTechnicalContext,
  SymbolTradePlan,
  SymbolTradePlanProposal,
} from '@stock-agent/shared';
import { buildTechnicalContext, hardBlocksOf } from './technicalEvidence';
import { assembleRisk } from './risk';
import { resolveMarketAction, tighten, type PhaseCarryOver } from './phase';
import * as repo from './repo';
import {
  ProposalRejected,
  compileAndSavePlan,
  formatIssuesForRetry,
  saveDraftObservationPlan,
  validateProposal,
  type CompileInput,
} from './service';
import { listMarks } from '../symbolMarks/repo';
import { adapterFor, inferAssetType } from './adapters';

// 编排层：把「取证据 → 建候选 → 算风险 → 定动作」串起来，供 agent 工具与 HTTP 路由共用。
// 上下文缓存到内存：LLM 需要先取上下文、再取候选、最后提交提案，三次调用必须看到同一份快照。

interface CachedContext {
  context: SymbolTechnicalContext;
  catalog: CandidateCatalog;
  dayBars: Awaited<ReturnType<typeof buildTechnicalContext>>['dayBars'];
  risk: SymbolTradePlan['risk'];
  execution: SymbolTradePlan['execution'];
  marketAction: SymbolTradePlan['marketAction'];
  primaryAction: SymbolTradePlan['primaryAction'];
  actionReasons: string[];
  assetSpecificRisks: string[];
  expiresAt: number;
}

/** contextId → 快照。容量小、TTL 短，避免长期占内存 */
const CACHE = new Map<string, CachedContext>();
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 40;

function pruneCache(): void {
  const now = Date.now();
  for (const [k, v] of CACHE) if (v.expiresAt < now) CACHE.delete(k);
  while (CACHE.size > CACHE_MAX) {
    const oldest = CACHE.keys().next().value;
    if (oldest == null) break;
    CACHE.delete(oldest);
  }
}

export function getCachedContext(contextId: string): CachedContext | null {
  pruneCache();
  return CACHE.get(contextId) ?? null;
}

/**
 * 从上一版计划的证据快照里取回阶段滞回状态。
 * 快照结构历史上可能缺字段，取不到就回落成「只有 phase、无 pending」，
 * 等价于重新开始累计，不会误判迁移。
 */
function readPhaseCarryOver(plan: SymbolTradePlan | null): PhaseCarryOver | null {
  if (!plan) return null;
  const snap = plan.evidenceSnapshot as { phase?: Partial<SymbolPhaseReading> } | null;
  const p = snap?.phase;
  // 快照是历史落库的 JSON，字段类型不可信：lastBarTime 若不是字符串，
  // 同一根 bar 的判等会恒为假，一天内多次生成计划就能把滞回门槛刷过去
  return {
    phase: plan.marketPhase,
    pendingPhase: p?.pendingPhase ?? null,
    pendingBars: typeof p?.pendingBars === 'number' ? Math.max(0, Math.floor(p.pendingBars)) : 0,
    lastBarTime: typeof p?.lastBarTime === 'string' ? p.lastBarTime : null,
    tentative: p?.tentative === true,
  };
}

export interface PrepareInput {
  code: string;
  name?: string;
  secid?: string;
  /**
   * 账户权益与持股。可不传——不传时本函数自取实时持仓，
   * 因为调用方（agent 工具、HTTP 路由）都拿不到这两个值，依赖调用方传参等于永远算不出仓位。
   */
  totalEquity?: number;
  currentShares?: number;
}

/**
 * 板块闸门取数：只读板块广度快照（不现场重跑、不联网遍历成分）。
 * 取不到时返回 null 并给出显式说明——绝不能静默按「未知」放过，
 * 否则「板块已退幕收紧为退出」这条纪律看起来生效、实际从未生效。
 */
export async function resolveBoardStage(
  identity: { code: string; name: string; secid?: string },
): Promise<{ boardStage: string | null; warning: string | null }> {
  const assetType = inferAssetType(identity.code, identity.secid);
  if (assetType !== 'stock') {
    return {
      boardStage: null,
      warning: `${assetType === 'etf' ? 'ETF' : '指数'}无板块归属（成分广度快照尚未按指数落库），板块闸门本次未覆盖`,
    };
  }
  const meta = await adapterFor('stock')
    .loadAssetMetadata(identity)
    .catch(() => null);
  if (!meta?.boardCode) {
    return { boardStage: null, warning: '该个股未映射到板块广度快照，板块闸门本次未覆盖' };
  }
  const { boardStageActionOf } = await import('../breadth/service');
  const hit = boardStageActionOf(meta.boardCode);
  if (!hit) {
    return {
      boardStage: null,
      warning: `板块 ${meta.boardName ?? meta.boardCode} 无当日广度快照，板块闸门本次未覆盖`,
    };
  }
  // 快照过期仍然采用：板块闸门的四个分支只会把动作调保守，过期数据最多导致过度收紧，
  // 不会放大风险；但必须留痕说明它是哪一天的口径。
  const ageDays = (Date.now() - new Date(`${hit.tradeDate}T15:00:00+08:00`).getTime()) / 86_400_000;
  const stale = !Number.isFinite(ageDays) || ageDays > 5;
  return {
    boardStage: hit.action,
    warning: stale ? `板块闸门用的是 ${hit.tradeDate} 的广度快照（已过期），只用于收紧动作` : null,
  };
}

/** 实时持仓取数上限 */
const ACCOUNT_DEADLINE_MS = 8_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`实时持仓取数超过 ${ms}ms`)), ms);
  });
  return Promise.race([p, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 账户侧读数：权益 + 该标的持股。取不到时必须能被下游区分出「未接入/取数失败」 */
interface AccountReading {
  totalEquity: number;
  currentShares: number;
  position: { qty: number; avgCost: number; positionRate: number; holdRate: number } | null;
  warning: string | null;
}

/**
 * 取一次实时持仓填账户维度。与 positions/discipline.ts 同一数据源（fetchRealPositions 的 totalAsset）。
 * 不落快照（persistSnapshot=false）：这里只是读一眼账户，不该顺手改持仓历史。
 */
async function loadAccount(code: string, input: PrepareInput): Promise<AccountReading> {
  if (input.totalEquity != null && input.totalEquity > 0) {
    return {
      totalEquity: input.totalEquity,
      currentShares: input.currentShares ?? 0,
      position: null,
      warning: null,
    };
  }
  try {
    const { fetchRealPositions } = await import('../realPositions');
    // 必须设上限：本函数挂在 agent 工具的 30s 预算里，持仓源卡住不能把整份上下文拖死
    const pf = await withTimeout(fetchRealPositions(false), ACCOUNT_DEADLINE_MS);
    const p = pf.positions.find((x) => x.code === code) ?? null;
    if (!(pf.totalAsset > 0)) {
      return { totalEquity: 0, currentShares: 0, position: null, warning: '账户总资产为 0 或未接入，仓位建议未覆盖' };
    }
    return {
      totalEquity: pf.totalAsset,
      currentShares: p?.qty ?? 0,
      position: p
        ? { qty: p.qty, avgCost: p.avgCost, positionRate: p.positionRate, holdRate: p.holdRate }
        : null,
      warning: null,
    };
  } catch (e) {
    return {
      totalEquity: 0,
      currentShares: 0,
      position: null,
      warning: `实时持仓取数失败（${e instanceof Error ? e.message : String(e)}），仓位建议与执行止损未覆盖`,
    };
  }
}

/**
 * 账户持仓上下文。allowedWeightPct 直接取风险服务算出的建议仓位上限，不另算一份。
 * 账户不可用时返回 null——不能造一个 state='none' 的假上下文，
 * 那会让「无持仓时把 reduce/exit 收紧成 wait」在账户取数失败时误触发。
 */
function buildPositionContext(acc: AccountReading, risk: SymbolTradePlan['risk']): SymbolTechnicalContext['positionContext'] {
  if (!(acc.totalEquity > 0)) return null;
  const p = acc.position;
  const warnings: string[] = [];
  // 数据源只给持仓股数，不给「可卖股数」；T+1 下当日买入部分实际不可卖，故显式标注而不是假装等值
  if (p) warnings.push('数据源未提供可卖股数，可用数按持仓股数处理（当日买入部分实际不可卖）');
  // 调用方直接传股数（未走持仓源）时拿不到实际权重。0 会让「超上限先降至上限」这条收紧规则失效，
  // 属于静默放大，必须留痕
  if (!p && acc.currentShares > 0) {
    warnings.push('调用方仅提供持股数、未提供当前权重，「超风险预算上限」检查本次未覆盖');
  }
  return {
    state: p || acc.currentShares > 0 ? 'holding' : 'none',
    quantity: p?.qty ?? acc.currentShares,
    availableQuantity: p?.qty ?? acc.currentShares,
    avgCost: p?.avgCost ?? null,
    currentWeightPct: p?.positionRate ?? 0,
    unrealizedPnlPct: p?.holdRate ?? null,
    allowedWeightPct: risk.suggestedPositionPct,
    concentrationWarnings: warnings,
  };
}

/**
 * 取证据 + 建候选 + 算风险 + 定动作，并缓存快照。
 * 阶段/动作/风险全部在这里由代码算定，LLM 之后只能挑候选 ID。
 */
export async function prepareContext(input: PrepareInput): Promise<CachedContext> {
  const active = repo.getActivePlan(input.code);
  const existingMarks = listMarks(input.code).length;

  // 大盘阶段：读已有快照（不触发重算，避免拖慢工具）。取不到按未知处理，
  // riskBudget 会回落震荡档取紧，不会因缺这一层而放大风险。
  let marketRegimePhase: string | null = null;
  try {
    const regime = await import('../regime/service');
    marketRegimePhase = regime.getRegimeSummaryForCockpit()?.phase ?? null;
  } catch {
    /* 快照不可用时保持 null */
  }

  const identity = { code: input.code, name: input.name ?? input.code, secid: input.secid };
  // 板块闸门与账户读数并发取，各自失败只降级本项
  const [board, account] = await Promise.all([
    resolveBoardStage(identity),
    loadAccount(input.code, input),
  ]);

  const built = await buildTechnicalContext({
    code: input.code,
    name: input.name,
    secid: input.secid,
    boardStage: board.boardStage,
    // 必须把整份滞回状态回传：只给 phase 会让 pendingBars 永远停在 1，
    // requiredBars=2 的四个阶段（筑底/修复/上升/加速）就永远无法迁移。
    prevPhase: readPhaseCarryOver(active),
    activePlan: active ? { id: active.id, version: active.version, status: active.status } : null,
    existingMarkCount: existingMarks,
    marketRegimePhase,
  });

  const { risk, execution } = assembleRisk({
    context: built.context,
    catalog: built.catalog,
    dayBars: built.dayBars,
    totalEquity: account.totalEquity,
    currentShares: account.currentShares,
  });

  // 账户上下文依赖 risk 里的建议仓位上限，故在算完风险后回填。
  // 未覆盖的项一律写进 warnings，让 format 层能改用「未覆盖」口吻而不是「已算定」。
  built.context.positionContext = buildPositionContext(account, risk);
  for (const w of [board.warning, account.warning]) if (w) built.context.warnings.push(w);

  // 标的客观动作（阶段默认 → 外部闸门收紧）
  const gated = resolveMarketAction({
    phase: built.context.phase.phase,
    hardBlocks: hardBlocksOf(built.context),
    marketRegimePhase,
    boardStageAction: built.context.boardStage,
  });

  // 账户动作：在标的动作上再按持仓与风险预算收紧
  const reasons = [...gated.reasons];
  let primaryAction = gated.action;
  const pos = built.context.positionContext;
  if (pos) {
    if (pos.state === 'none' && (primaryAction === 'reduce' || primaryAction === 'exit')) {
      // 无仓用户的「减仓/退出」等价于不参与
      primaryAction = 'wait';
      reasons.push('当前无持仓，减仓/退出等价于不参与，收紧为等待');
    }
    if (
      pos.allowedWeightPct != null &&
      pos.currentWeightPct > pos.allowedWeightPct &&
      primaryAction !== 'exit'
    ) {
      primaryAction = tighten(primaryAction, 'reduce');
      reasons.push(
        `当前权重 ${pos.currentWeightPct.toFixed(1)}% 超风险预算上限 ${pos.allowedWeightPct.toFixed(1)}%，先降至上限`,
      );
    }
  }
  // 数据降级时不给可执行动作。
  // 标的动作也要一起收紧：情景动作是从 marketAction 派生的，只收 primaryAction 会产出
  // 一份顶部写「等待」、情景里却仍写「触发后 add/probe」的自相矛盾计划。
  // degraded 是证据质量问题（与账户维度无关），两边同源同因，必须同口径。
  let marketAction = gated.action;
  if (built.context.dataStatus === 'degraded') {
    marketAction = tighten(marketAction, 'wait');
    primaryAction = tighten(primaryAction, 'wait');
    reasons.push('关键数据没取全，标的动作与情景动作一并收紧为等待');
  }

  const assetSpecificRisks = [
    ...built.context.executionQuality.filter((q) => q.missing).map((q) => `${q.key}：${q.value}`),
    ...built.context.eventRisks.filter((e) => e.kind !== '执行硬阻断').map((e) => `${e.kind}：${e.note}`),
  ];

  const snapshot: CachedContext = {
    ...built,
    risk,
    execution,
    marketAction,
    primaryAction,
    actionReasons: reasons,
    assetSpecificRisks,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  pruneCache();
  CACHE.set(built.context.contextId, snapshot);
  return snapshot;
}

/** 提案 → 计划。校验失败抛 ProposalRejected，由调用方决定重试或降级 */
export function submitProposal(
  proposal: SymbolTradePlanProposal,
  opts: { sessionId?: string | null; runId?: string | null } = {},
): SymbolTradePlan {
  const snap = getCachedContext(proposal.contextId);
  if (!snap) {
    throw new ProposalRejected([
      {
        field: 'contextId',
        code: 'catalog_expired',
        message: `上下文 ${proposal.contextId} 已过期或不存在，请重新调用技术上下文工具`,
      },
    ]);
  }
  const validFrom = new Date().toISOString();
  // 计划有效期固定 4 周。合并车道前次日计划只给 2 天，波段给 28 天；
  // 现在一份计划同时装着 60 分钟级触发与周线级目标，按短的算会让周线部分刚生效就过期，
  // 短周期那部分的过时风险改由时间止损（TIME_STOP_BARS 根日线）与每日复核兜住。
  const expiresAt = new Date(Date.now() + 28 * 86_400_000).toISOString();

  const compileInput: CompileInput = {
    context: snap.context,
    catalog: snap.catalog,
    proposal,
    risk: snap.risk,
    positionContext: snap.context.positionContext,
    execution: snap.execution,
    marketAction: snap.marketAction,
    primaryAction: snap.primaryAction,
    assetSpecificRisks: snap.assetSpecificRisks,
    sessionId: opts.sessionId ?? null,
    runId: opts.runId ?? null,
    validFrom,
    expiresAt,
  };
  return compileAndSavePlan(compileInput);
}

/** 二次失败后的降级：落观察计划 */
export function fallbackDraft(
  contextId: string,
  reason: string,
  opts: { sessionId?: string | null; runId?: string | null } = {},
): SymbolTradePlan | null {
  const snap = getCachedContext(contextId);
  if (!snap) return null;
  // 指数不落任何计划，观察计划也不例外：降级路径若放行，validateProposal 的拒绝就形同虚设
  // （被拒两次后照样在计划表里留下一份按 code 定位的指数计划）
  if (snap.context.assetType === 'index') return null;
  return saveDraftObservationPlan({
    context: snap.context,
    risk: snap.risk,
    positionContext: snap.context.positionContext,
    execution: snap.execution,
    marketAction: snap.marketAction,
    primaryAction: snap.primaryAction,
    assetSpecificRisks: snap.assetSpecificRisks,
    sessionId: opts.sessionId ?? null,
    runId: opts.runId ?? null,
    reason,
  });
}

export { ProposalRejected, formatIssuesForRetry, validateProposal };
