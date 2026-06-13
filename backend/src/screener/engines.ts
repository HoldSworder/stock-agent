import type { ScreenEngineInfo, ScreenPick, RunTrigger } from '@stock-agent/shared';
import { fetchMarketSnapshot } from './snapshot';
import { hardFilter } from './filter';
import { buildThemeContext, scoreCandidates, type ScoredRow } from './scorer';
import { rankCandidates } from './ranker';
import { diversifyByIndustry, ruleRiskTags } from './risk';
import { getStrategyDef } from './strategy';

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
}

export interface ScreenEngine {
  info: ScreenEngineInfo;
  produce(input: EngineRunInput): Promise<EngineOutput>;
}

/** LLM 横排候选池上限（控制 token；从打分 Top 截取） */
const LLM_POOL_MAX = 40;

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

    const snapshot = await fetchMarketSnapshot();
    if (snapshot.length === 0) throw new Error('全市场快照为空，选股中止');

    const filtered = hardFilter(snapshot, def.hardFilters);
    if (filtered.length === 0) throw new Error('硬筛后无候选，请放宽策略阈值或更换策略');

    const theme = await buildThemeContext(input.context);
    const scored = scoreCandidates(filtered, def, theme).sort(
      (a, b) => b.screenScore - a.screenScore,
    );

    const pool = scored.slice(0, LLM_POOL_MAX);
    const rank = input.useLlm
      ? await rankCandidates({
          def,
          context: input.context,
          topN: input.topN,
          candidates: pool,
          trigger: input.trigger,
        })
      : null;

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
      marketView: rank?.marketView ?? null,
      selectionLogic: rank?.selectionLogic ?? null,
      portfolioRisk: rank?.portfolioRisk ?? null,
      runId: rank?.runId ?? null,
      picks,
    };
  },
};

const ENGINES: ScreenEngine[] = [multifactor];
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
