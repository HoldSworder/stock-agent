import type {
  ScreenEngineInfo,
  ScreenPick,
  RunTrigger,
  ScreenProgressEvent,
  ScreenFunnelDiagnostics,
  Horizon,
} from '@stock-agent/shared';
import { SCREEN_FACTOR_LABELS } from '@stock-agent/shared';
import {
  fetchMarketSnapshot,
  isDegenerateSnapshot,
  loadLastCloseSnapshot,
  saveLastCloseSnapshot,
  type SnapshotRow,
} from './snapshot';
import { hardFilter, type HardFilterMode } from './filter';
import { buildFunnelDiagnostics } from './diagnostics';
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
  /** 漏斗诊断（被硬筛刷掉的那部分去哪了；仅 multifactor 产出） */
  diagnostics?: ScreenFunnelDiagnostics | null;
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

/**
 * 显式留缺声明：seeds/cronTasks.ts 写给 LLM 的交易硬规则里包含「排除上市未满 30 个交易日的次新股」，
 * 但确定性代码层没有对应实现——东财 clist 快照没有上市日期字段，用代码段前缀去猜是伪实现。
 * 次新股的波动/流动性特征不适用现有因子口径（momentum/activity 会系统性给高分），
 * 所以这条规则未生效必须显式可见，不能静默不执行。补上上市日期数据源后删除本条。
 */
const UNIMPLEMENTED_RULE_NOTE =
  '⚠️ 次新股（上市不足 30 交易日）过滤因缺少上市日期数据源尚未生效，结果中可能混入次新股';

/** 把运行模式说明拼到文案前缀（marketView/selectionLogic），便于前端识别降级来源 */
function withModeNote(mode: string | null, text: string | null): string | null {
  if (!mode) return text;
  return text ? `（${mode}）${text}` : `（${mode}）`;
}

/**
 * 逐级硬筛兜底：full → skipVolumePrice → tradableOnly。
 * 返回首个非空结果及是否经过放宽（relaxed=true 表示未用 full 口径）。
 */
/**
 * 硬筛，以及「什么时候可以放宽」。
 *
 * 原先是逐级兜底：full → skipVolumePrice → tradableOnly，哪级出了结果用哪级，
 * 只把「已自动放宽」写进运行说明，不阻止出榜。这有个根本问题：
 * **自动放宽等于「你的条件没人满足，那我换个条件」**，出的榜不是这个策略的判断了。
 * 放量突破的全部含义就在那个成交额下限上，跳过它再出榜，出来的不是放量突破。
 *
 * 现在只区分两种情形：
 *
 * 1. 快照退化（盘前东财把当日量价置 0，且没有可用的收盘缓存）——
 *    此时跳过量价阈值是**对的**：那是数据没有，不是条件没人满足。
 * 2. 数据正常却一只都不满足——**今天真的没有符合这个策略的标的**。
 *    这时候的正确答案是把这句话说出来，而不是把门槛一路降到只剩「能交易」
 *    （降到那一级，剩下的就是全市场，跟没筛一样）。
 */
function applyHardFilterWithFallback(
  snapshot: SnapshotRow[],
  hardFilters: Parameters<typeof hardFilter>[1],
  degenerate: boolean,
): { filtered: SnapshotRow[]; relaxedMode: HardFilterMode | null } {
  const full = hardFilter(snapshot, hardFilters, 'full');
  if (full.length > 0) return { filtered: full, relaxedMode: null };

  if (degenerate) {
    const skipped = hardFilter(snapshot, hardFilters, 'skipVolumePrice');
    if (skipped.length > 0) return { filtered: skipped, relaxedMode: 'skipVolumePrice' };
  }

  return { filtered: [], relaxedMode: null };
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
        throw new Error('指定的标的范围与全市场数据没有交集（成分股可能停牌，或代码格式对不上）');
      }
      snapshot = scoped;
    }

    // 盘前退化处理：当日量价被东财置 0 时，优先复用最近一次有效行情缓存（通常即上一交易日收盘），
    // 让硬筛/打分照常生效；非退化则把本次快照写入缓存，供下个盘前窗口使用。
    let runMode: string | null = UNIMPLEMENTED_RULE_NOTE;
    // 退化 = 东财把当日量价置 0（盘前常见）。这个事实要留到硬筛那一步：
    // 只有这种「数据确实没有」的情形才允许跳过量价阈值，
    // 「条件没人满足」不许放宽（见 applyHardFilterWithFallback）。
    let degenerate = isDegenerateSnapshot(snapshot);
    if (degenerate) {
      const { rows: cached, staleNote } = loadLastCloseSnapshot();
      if (cached) {
        snapshot = cached;
        // 换成收盘快照后量价是齐的，不再算退化——此时量价阈值应当照常生效
        degenerate = false;
        runMode = `盘前模式：采用上一交易日收盘快照；${runMode}`;
      } else if (staleNote) {
        // 缓存过期时绝不能沉默降级：此刻用的是当日被置 0 的量价，硬筛会自动放宽，用户需要知道
        runMode = `盘前模式数据不全：${staleNote}，改用当日简化量价；${runMode}`;
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

    emit({ stage: 'filter', label: '规则硬筛', status: 'running' });
    const { filtered, relaxedMode } = applyHardFilterWithFallback(
      snapshot,
      def.hardFilters,
      degenerate,
    );
    if (filtered.length === 0) {
      // 「没有满足条件的」和「系统出错了」是两件事，必须说清是哪一件——
      // 否则人会去排查一个不存在的故障，或者反过来把故障当成「今天没机会」。
      throw new Error(
        `今天没有标的满足「${def.name}」的条件（全市场 ${snapshot.length} 只都不满足）。` +
          '这不是系统故障，是这套条件今天没人达标。' +
          '系统不会替你自动放宽：放宽之后出的榜就不是这个策略的判断了。',
      );
    }
    const relaxNote = '盘前当日量价取不到，本次跳过量价阈值（其余条件照常）';
    if (relaxedMode === 'skipVolumePrice') {
      runMode = runMode ? `${runMode}；${relaxNote}` : relaxNote;
    }
    emit({
      stage: 'filter',
      label: '规则硬筛',
      status: 'done',
      filteredCount: filtered.length,
      note: relaxedMode === 'skipVolumePrice' ? relaxNote : undefined,
    });

    emit({ stage: 'score', label: '多因子打分', status: 'running' });
    const theme = await buildThemeContext(input.context);
    const scored = scoreCandidates(filtered, def, theme).sort(
      (a, b) => b.screenScore - a.screenScore,
    );

    // 这一遍**不能**按 rankable 过滤：trend / fundFlow / midTrend / dragonRank
    // 是下面「二段增强」才注入的因子，此刻必然全是空值。
    // 在这里过滤会把所有用这些因子的策略整池剔空——真实数据下中线龙头 646 只
    // 会一只不剩（探测脚本 screenerMissing.probe.ts 就是这么抓到的）。
    // 这一遍只负责按分排序、收窄到 LLM_POOL_MAX，缺数的判定留到最终那一遍。
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
        // 分位基准固定为初筛行集：拿 40 只子集重算分位会让 screenScore 量纲在两次调用间漂移，
        // 最终落库的分数和刚才用于截断的分数就不是同一把尺
        pool = scoreCandidates(
          pool.map((c) => c.row),
          def,
          theme,
          extra,
          filtered,
        ).sort((a, b) => b.screenScore - a.screenScore);
      }
      emit({ stage: 'enrich', label: '趋势/资金/龙头二段增强', status: 'done', poolCount: pool.length });
    }

    // 缺数判定放在这里：所有因子该注入的都注入过了，此刻的空值才是真的取不到。
    // 拿半份数据算出来的分和拿全份算出来的分不是同一把尺，混在一张榜上比就是错的。
    // 剔掉多少条必须说出来，否则「今天榜怎么变短了」查不到原因。
    //
    // 整池被剔空是可能的，而且是对的：趋势因子权重 0.4 的中线策略在
    // 完全取不到趋势数据时不该出榜——那时候出的榜是拿剩下 0.6 凑的，不是它本来的判断。
    const dropped = pool.filter((c) => !c.rankable);
    pool = pool.filter((c) => c.rankable);
    if (dropped.length > 0) {
      const missNames = Array.from(
        new Set(dropped.flatMap((c) => c.missingFactors.map((k) => SCREEN_FACTOR_LABELS[k]))),
      );
      emit({
        stage: 'score',
        label: '缺数剔除',
        status: 'done',
        poolCount: pool.length,
        note:
          `${dropped.length} 只因取数不全未参与排名（缺：${missNames.join('、')}）` +
          (pool.length === 0 ? '——本次无结果，不是没选出来，是这些数据取不到' : ''),
      });
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
      // 能走到这里的一定有涨跌幅：scorer 把 pct 缺失的标成不可排名，上面已滤掉。
      // 这个断言是为了让规则被破坏时当场报错，而不是静默写一个 0 进库冒充平盘。
      if (c.row.pct == null) {
        throw new Error(`${c.row.code} 涨跌幅取不到却进了榜单，排名前置过滤漏了`);
      }
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
      // 漏斗诊断：把被硬筛刷掉的那部分留痕（只读研究统计，不自动放宽生产门槛）
      diagnostics: buildFunnelDiagnostics(snapshot, def.hardFilters, filtered.length),
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

// 「什么时候可以放宽硬筛」是这层唯一会悄悄改变策略含义的地方，单独导出供自检验证。
export { applyHardFilterWithFallback as __test__applyHardFilterWithFallback };
