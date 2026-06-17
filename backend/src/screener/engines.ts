import type {
  ScreenEngineInfo,
  ScreenPick,
  RunTrigger,
  ScreenProgressEvent,
  Horizon,
} from '@stock-agent/shared';
import {
  fetchMarketSnapshot,
  isDegenerateSnapshot,
  loadLastCloseSnapshot,
  saveLastCloseSnapshot,
  type SnapshotRow,
} from './snapshot';
import { hardFilter, type HardFilterMode } from './filter';
import { buildThemeContext, scoreCandidates, type ScoredRow } from './scorer';
import { rankCandidates } from './ranker';
import { diversifyByIndustry, ruleRiskTags } from './risk';
import { activeFactors, getStrategyDef } from './strategy';
import { enrichTrendFactors } from './trend';
import { enrichDragonFactors } from './dragon';
import { nlEngine } from './nlEngine';

// 选股链路（engine）注册表：选股页是「发现枢纽」，可承载多条选股链路。
// 当前内置 multifactor（三层漏斗多因子）。新增链路时：实现一个 ScreenEngine 注册到 ENGINES，
// 前端 Tab 由 listEngines() 驱动、service.runScreen 按 id 分发，现有调用零改动。

/** 引擎产出（不含落库；落库与默认值解析由 service 统一承接） */
export interface EngineOutput {
  strategyId: string;
  strategyName: string;
  marketCount: number;
  filteredCount: number;
  context: string | null;
  marketView: string | null;
  selectionLogic: string | null;
  portfolioRisk: string | null;
  runId: string | null;
  picks: ScreenPick[];
}

/** 引擎运行入参（service 解析默认值后传入） */
export interface EngineRunInput {
  /** 已解析的策略 id（multifactor 用；其它引擎可忽略） */
  strategyId: string;
  context: string;
  topN: number;
  useLlm: boolean;
  trigger: RunTrigger;
  /** 持有视角：short 短线（默认）/ mid 中线 */
  horizon?: Horizon;
  /** 限定候选池代码集合（ETF 成分股下钻 universe；为空走全市场） */
  universe?: string[] | null;
  /** 进度回调（逐阶段上报；缺省即静默，cron/agent 调用不传） */
  onProgress?: (e: ScreenProgressEvent) => void;
}

export interface ScreenEngine {
  info: ScreenEngineInfo;
  produce(input: EngineRunInput): Promise<EngineOutput>;
}

/** LLM 横排候选池上限（控制 token；从打分 Top 截取） */
const LLM_POOL_MAX = 40;

/** 把运行模式说明拼到文案前缀（marketView/selectionLogic），便于前端识别降级来源 */
function withModeNote(mode: string | null, text: string | null): string | null {
  if (!mode) return text;
  return text ? `（${mode}）${text}` : `（${mode}）`;
}

/**
 * 逐级硬筛兜底：full → skipVolumePrice → tradableOnly。
 * 返回首个非空结果及是否经过放宽（relaxed=true 表示未用 full 口径）。
 */
function applyHardFilterWithFallback(
  snapshot: SnapshotRow[],
  hardFilters: Parameters<typeof hardFilter>[1],
): { filtered: SnapshotRow[]; relaxed: boolean } {
  const modes: HardFilterMode[] = ['full', 'skipVolumePrice', 'tradableOnly'];
  for (const mode of modes) {
    const filtered = hardFilter(snapshot, hardFilters, mode);
    if (filtered.length > 0) return { filtered, relaxed: mode !== 'full' };
  }
  return { filtered: [], relaxed: true };
}

/** multifactor：全市场快照 → 规则硬筛 → 多因子打分 → LLM 横排 → 组合去集中 → TopN */
const multifactor: ScreenEngine = {
  info: {
    id: 'multifactor',
    name: '多因子漏斗',
    description:
      '全市场快照 → 规则硬筛(剔科创/北交/ST) → 多因子打分(估值/流动性/市值/动量/活跃度/题材热度) → LLM 横向排序 → 组合行业去集中。',
    enabled: true,
  },
  async produce(input) {
    const def = getStrategyDef(input.strategyId);
    const emit = input.onProgress ?? (() => {});

    emit({ stage: 'snapshot', label: '全市场快照', status: 'running' });
    let snapshot = await fetchMarketSnapshot();
    if (snapshot.length === 0) throw new Error('全市场快照为空，选股中止');

    // universe 限定（ETF 成分股下钻）：对全市场快照取交集，把选股域收窄到强赛道成分股内。
    // universe 为空则维持全市场，行为不变。
    if (input.universe && input.universe.length > 0) {
      const allow = new Set(input.universe);
      const scoped = snapshot.filter((r) => allow.has(r.code));
      if (scoped.length === 0) {
        throw new Error('下钻 universe 与全市场快照无交集（成分股可能停牌或代码口径不符）');
      }
      snapshot = scoped;
    }

    // 盘前退化处理：当日量价被东财置 0 时，优先复用最近一次有效行情缓存（通常即上一交易日收盘），
    // 让硬筛/打分照常生效；非退化则把本次快照写入缓存，供下个盘前窗口使用。
    let runMode: string | null = null;
    if (isDegenerateSnapshot(snapshot)) {
      const cached = loadLastCloseSnapshot();
      if (cached) {
        snapshot = cached;
        runMode = '盘前模式：采用上一交易日收盘快照';
      }
    } else {
      saveLastCloseSnapshot(snapshot);
    }
    emit({
      stage: 'snapshot',
      label: '全市场快照',
      status: 'done',
      marketCount: snapshot.length,
      note: runMode ?? undefined,
    });

    // 逐级硬筛兜底：full → skipVolumePrice → tradableOnly，仍为空才判定全市场异常。
    emit({ stage: 'filter', label: '规则硬筛', status: 'running' });
    const { filtered, relaxed } = applyHardFilterWithFallback(snapshot, def.hardFilters);
    if (filtered.length === 0) throw new Error('硬筛后无候选，请放宽策略阈值或更换策略');
    if (relaxed) {
      const relaxNote = '已自动放宽硬筛阈值';
      runMode = runMode ? `${runMode}；${relaxNote}` : relaxNote;
    }
    emit({
      stage: 'filter',
      label: '规则硬筛',
      status: 'done',
      filteredCount: filtered.length,
      note: relaxed ? '已自动放宽硬筛阈值' : undefined,
    });

    emit({ stage: 'score', label: '多因子打分', status: 'running' });
    const theme = await buildThemeContext(input.context);
    const scored = scoreCandidates(filtered, def, theme).sort(
      (a, b) => b.screenScore - a.screenScore,
    );

    let pool = scored.slice(0, LLM_POOL_MAX);
    emit({ stage: 'score', label: '多因子打分', status: 'done', poolCount: pool.length });

    // 二段增强：策略若启用 trend / fundFlow（逐只历史因子）或 dragonRank（涨停池因子），
    // 仅对收窄后的候选池限量取 K 线/资金流/涨停池补分并重打分（避免对全市场逐只取数）。
    // 其它策略零额外取数、行为不变。
    const factors = activeFactors(def);
    const histFactors = factors.filter(
      (k) => k === 'trend' || k === 'fundFlow' || k === 'midTrend',
    );
    const needsTrend = histFactors.length > 0;
    const needsDragon = factors.some((k) => k === 'dragonRank');
    if ((needsTrend || needsDragon) && pool.length > 0) {
      emit({ stage: 'enrich', label: '趋势/资金/龙头二段增强', status: 'running', poolCount: pool.length });
      const codes = pool.map((c) => c.row.code);
      const [trendExtra, dragonExtra] = await Promise.all([
        needsTrend ? enrichTrendFactors(codes, histFactors).catch(() => null) : Promise.resolve(null),
        needsDragon ? enrichDragonFactors(codes).catch(() => null) : Promise.resolve(null),
      ]);
      // 合并两份补充表（同 code 合并因子）
      const extra: typeof trendExtra = new Map();
      for (const src of [trendExtra, dragonExtra]) {
        if (!src) continue;
        for (const [code, vals] of src) extra!.set(code, { ...extra!.get(code), ...vals });
      }
      if (extra && extra.size > 0) {
        pool = scoreCandidates(
          pool.map((c) => c.row),
          def,
          theme,
          extra,
        ).sort((a, b) => b.screenScore - a.screenScore);
      }
      emit({ stage: 'enrich', label: '趋势/资金/龙头二段增强', status: 'done', poolCount: pool.length });
    }
    if (input.useLlm) {
      emit({ stage: 'rank', label: 'LLM 横向排序', status: 'running', poolCount: pool.length });
    }
    const rank = input.useLlm
      ? await rankCandidates({
          def,
          context: input.context,
          topN: input.topN,
          candidates: pool,
          trigger: input.trigger,
        })
      : null;
    if (input.useLlm) {
      emit({ stage: 'rank', label: 'LLM 横向排序', status: 'done', poolCount: pool.length });
    }

    // 合并排序：LLM 顺序优先，未覆盖者按确定性分补齐
    let ordered: ScoredRow[] = pool;
    if (rank && rank.order.length > 0) {
      const byCode = new Map(pool.map((c) => [c.row.code, c]));
      const head = rank.order.map((c) => byCode.get(c)).filter((x): x is ScoredRow => !!x);
      const headCodes = new Set(head.map((c) => c.row.code));
      const tail = pool.filter((c) => !headCodes.has(c.row.code));
      ordered = [...head, ...tail];
    }

    const finalRows = diversifyByIndustry(ordered, input.topN);

    const picks: ScreenPick[] = finalRows.map((c, i) => {
      const llm = rank?.byCode.get(c.row.code);
      const riskTags = Array.from(new Set([...(llm?.riskTags ?? []), ...ruleRiskTags(c.row)]));
      return {
        rank: i + 1,
        code: c.row.code,
        name: c.row.name,
        price: c.row.price,
        pct: c.row.pct,
        industry: c.row.industry,
        screenScore: c.screenScore,
        factors: c.factors,
        thesis: llm?.thesis ?? null,
        riskTags,
        confidence: llm?.confidence ?? null,
        watchItems: llm?.watchItems ?? [],
        invalidators: llm?.invalidators ?? [],
        evalPrice: null,
        evalAt: null,
        evalReturn: null,
      };
    });

    return {
      strategyId: def.id,
      strategyName: def.name,
      marketCount: snapshot.length,
      filteredCount: filtered.length,
      context: input.context || null,
      marketView: withModeNote(runMode, rank?.marketView ?? null),
      selectionLogic: withModeNote(runMode, rank?.selectionLogic ?? null),
      portfolioRisk: rank?.portfolioRisk ?? null,
      runId: rank?.runId ?? null,
      picks,
    };
  },
};

const ENGINES: ScreenEngine[] = [multifactor, nlEngine];
const BY_ID = new Map(ENGINES.map((e) => [e.info.id, e]));

/** 默认链路 id */
export const DEFAULT_ENGINE = 'multifactor';

/** 全部链路元信息（前端 Tab 驱动） */
export function listEngines(): ScreenEngineInfo[] {
  return ENGINES.map((e) => e.info);
}

/** 是否为已注册且可用的链路 id */
export function hasEngine(id: string): boolean {
  return BY_ID.get(id)?.info.enabled ?? false;
}

/** 取链路；未知/未启用回退默认 */
export function getEngine(id: string | null | undefined): ScreenEngine {
  return (id && BY_ID.get(id)) || BY_ID.get(DEFAULT_ENGINE)!;
}
