import { createHash } from 'node:crypto';
import type {
  CandidateCatalog,
  ChanStructure,
  DowStructure,
  EvidenceMeta,
  KlineBar,
  KlinePeriod,
  PlanPeriod,
  PriceLevels,
  RelativeStrengthReading,
  SymbolBenchmark,
  SymbolTechnicalContext,
} from '@stock-agent/shared';
import { PLAN_PERIODS } from '@stock-agent/shared';
import { getKline, getQuotes } from '../market/eastmoney';
import { getPriceLevels } from '../market/levels';
import { computeDowStructure, computeChanStructure } from './structure';
import { computeVolumePrice, isVolumeComparable } from './volumePrice';
import { computePhase, PHASE_MODEL_VERSION, type PhaseCarryOver } from './phase';
import { buildCandidateCatalog, CANDIDATE_MODEL_VERSION } from './candidateCatalog';
import { adapterFor, inferAssetType } from './adapters';
import { isBarUnclosed } from './sessionClock';


// 证据聚合与编排层（计划四、4.1）。
// 纪律：不复制指标算法——ATR/枢轴/斐波/均线复用 market/levels.ts，MACD 等复用 market/indicators.ts，
// RS 复用 modes/factors.ts 的口径，本文件只做并发取数、分层降级与装配。

export const EVIDENCE_VERSION = 'evidence-v1';

/** 内部截止时间：单工具受 30s 超时约束，这里留足余量优先返回核心证据 */
const CORE_DEADLINE_MS = 14_000;
const ADAPTER_DEADLINE_MS = 8_000;

/** 数据窗口（4.1）：日线对齐 PREWARM_BARS=120 以命中缓存 */
const WINDOWS: Array<{ period: KlinePeriod; limit: number; core: boolean }> = [
  { period: 'day', limit: 120, core: true },
  { period: 'week', limit: 120, core: false },
  { period: '60m', limit: 320, core: false },
  { period: '15m', limit: 320, core: false },
];

/** 给 promise 套超时，超时按失败处理而不是一直等。定时器必须清理，否则每次建上下文都残留多个 handle */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms`)), ms);
  });
  return Promise.race([p, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface PeriodData {
  period: KlinePeriod;
  bars: KlineBar[];
  meta: EvidenceMeta;
}

/** 取单周期 K 线并生成 meta；失败返回 null 由调用方决定是否降级 */
async function loadPeriod(
  code: string,
  secid: string | undefined,
  period: KlinePeriod,
  limit: number,
): Promise<PeriodData | null> {
  const bars = await getKline(code, period, limit, secid);
  if (bars.length === 0) return null;
  const warnings: string[] = [];
  // 周线在降级到 mootdx 时可能拿到不复权数据（实测链尾），显式标注
  const adjusted = period !== 'week';
  if (!adjusted) {
    warnings.push('周线在数据源降级时可能为不复权，除权标的均线可能漂移');
  }
  if (bars.length < limit) {
    warnings.push(`请求 ${limit} 根，实得 ${bars.length} 根，按实际样本降级`);
  }
  // 收完判定必须与求值层同一 helper：午休时段同样属于「当日 K 未收完」，
  // 否则 11:35 会拿半天成交额去和 20 日中位数比，得出「全天放量/缩量」的假确认
  const completeBar = !isBarUnclosed(period, bars[bars.length - 1].time);
  if (!completeBar) warnings.push(`当前 ${period} K 未收完，量能与阶段结论按盘中口径降级`);
  return {
    period,
    bars,
    meta: {
      asOf: bars[bars.length - 1].time,
      source: 'kline-scheduler',
      period,
      adjusted,
      completeBar,
      stale: false,
      warnings,
    },
  };
}

/**
 * 相对强弱：复用 modes/factors.ts 的超额收益口径，扩到 5/20/60 三档。
 * ponytail: 只做「标的收益 - 基准收益」的简单超额，不引入 beta 回归；
 * 上限是未剔除 beta 差异，若后续要更严格可换成 factors.ts 的 alphaOf。
 */
async function computeRelativeStrength(
  bars: KlineBar[],
  benchmarks: SymbolBenchmark[],
): Promise<{ readings: RelativeStrengthReading[]; warnings: string[] }> {
  // 告警随返回值一起交出，不往外部数组 push：本函数被 withDeadline 包着，
  // 超时后底层 promise 仍在跑，那时再 push 已经晚于 dataStatus 判定与上下文装配，留痕会静默丢失
  const warnings: string[] = [];
  const out: RelativeStrengthReading[] = [];
  const retOf = (arr: KlineBar[], n: number): number | null => {
    if (arr.length <= n) return null;
    const from = arr[arr.length - 1 - n].close;
    const to = arr[arr.length - 1].close;
    return from > 0 ? ((to - from) / from) * 100 : null;
  };
  // secid 必传：指数与个股撞码，不传会被按个股规则解析到错误市场，静默取不到数
  const settled = await Promise.allSettled(
    benchmarks.map(async (b) => ({ b, bars: await getKline(b.code, 'day', 120, b.secid ?? undefined) })),
  );
  settled.forEach((s, i) => {
    if (s.status === 'rejected' || s.value.bars.length === 0) {
      // 取失败必须留痕，否则 LLM 看到的是「没有这项证据」而不是「这项证据取失败了」
      warnings.push(`相对强弱 vs ${benchmarks[i]?.name ?? '基准'} 取数失败，本项未覆盖`);
    }
  });
  for (const s of settled) {
    if (s.status !== 'fulfilled' || s.value.bars.length === 0) continue;
    const { b, bars: bb } = s.value;
    const diff = (n: number): number | null => {
      const a = retOf(bars, n);
      const c = retOf(bb, n);
      return a == null || c == null ? null : Math.round((a - c) * 100) / 100;
    };
    const rs5 = diff(5);
    const rs20 = diff(20);
    const rs60 = diff(60);
    // 趋势：短周期超额高于长周期视为改善
    let trend: RelativeStrengthReading['trend'] = 'unknown';
    if (rs5 != null && rs20 != null) {
      trend = rs5 > rs20 + 0.5 ? 'improving' : rs5 < rs20 - 0.5 ? 'deteriorating' : 'flat';
    }
    out.push({ benchmarkCode: b.code, benchmarkName: b.name, role: b.role, rs5, rs20, rs60, trend });
  }
  return { readings: out, warnings };
}

/** 执行硬阻断的事件 kind，多处引用，提成常量避免改字面量时漏改导致闸门失效 */
export const HARD_BLOCK_KIND = '执行硬阻断';

/** 警告条数超过此值视为证据质量已明显下降，整体标 degraded */
const DEGRADED_WARNING_THRESHOLD = 3;

/** 数据状态判定（拆开写，避免三层嵌套三元） */
function resolveDataStatus(input: {
  coreMissing: boolean;
  completeBar: boolean;
  warningCount: number;
}): SymbolTechnicalContext['dataStatus'] {
  if (input.coreMissing) return 'degraded';
  if (input.warningCount > DEGRADED_WARNING_THRESHOLD) return 'degraded';
  if (!input.completeBar) return 'provisional';
  return 'complete';
}

export interface BuildContextInput {
  code: string;
  name?: string;
  secid?: string;
  /** 上一版计划的阶段滞回状态。必须整体传入，只给 phase 会让滞回永远停在第 1 根 */
  prevPhase?: PhaseCarryOver | null;
  /** 已有计划与标注数，只放摘要 */
  activePlan?: SymbolTechnicalContext['activePlan'];
  existingMarkCount?: number;
  positionContext?: SymbolTechnicalContext['positionContext'];
  marketRegimePhase?: string | null;
  boardStage?: string | null;
}

export interface BuiltContext {
  context: SymbolTechnicalContext;
  catalog: CandidateCatalog;
  /** 主周期 K 线，供风险与求值层复用，不进 LLM 上下文 */
  dayBars: KlineBar[];
}

/**
 * 名称回源。调用方没给 name 时用一次实时行情补齐——名称直接决定 ST 判定，
 * 而 ST 判定决定涨跌幅上限（5% vs 10%），错了就会给出一个不存在的涨停价。
 * 取不到返回 null，由调用方按最保守口径处理，不拿代码冒充名称。
 */
async function lookupName(code: string): Promise<string | null> {
  try {
    const [q] = await getQuotes([code]);
    const name = q?.name?.trim();
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/** contextId：绑定标的 + 数据时点，跨快照混用时能被检出 */
function makeContextId(code: string, asOf: string): string {
  const h = createHash('sha1').update(`${code}|${asOf}|${EVIDENCE_VERSION}`).digest('hex');
  return `ctx:${code}:${h.slice(0, 12)}`;
}

/**
 * 装配技术上下文 + 候选目录。
 * 核心证据（日线、结构、量价、ATR）缺失即 degraded；适配器证据缺失只进 warnings。
 */
export async function buildTechnicalContext(input: BuildContextInput): Promise<BuiltContext> {
  const { code } = input;
  const secid = input.secid;
  const assetType = inferAssetType(code, secid);
  const adapter = adapterFor(assetType);
  const warnings: string[] = [];

  // 1. 多周期 K 线并发取（4.1：Promise.allSettled，单项失败不拖垮整份）
  const klineSettled = await Promise.allSettled(
    WINDOWS.map((w) =>
      withDeadline(loadPeriod(code, secid, w.period, w.limit), CORE_DEADLINE_MS, `${w.period} K线`),
    ),
  );
  const periods: PeriodData[] = [];
  klineSettled.forEach((s, i) => {
    const w = WINDOWS[i];
    if (s.status === 'fulfilled' && s.value) {
      periods.push(s.value);
      return;
    }
    const reason = s.status === 'rejected' ? String(s.reason).slice(0, 80) : '返回空数据';
    warnings.push(`${w.period} K线获取失败（${reason}）${w.core ? '，核心证据缺失' : '，该周期证据缺省'}`);
  });

  const dayData = periods.find((p) => p.period === 'day') ?? null;
  if (!dayData) {
    throw new Error(`核心证据缺失：${code} 日线不可用，无法生成计划`);
  }
  const dayBars = dayData.bars;
  // name 缺省时回源取一次：identity.name 回落成 6 位代码会让 ST 正则永不命中，
  // 涨停价按 10% 算出一个不存在的价位喂给 LLM，硬阻断也按 10% 判——
  // ST 股封在 ±5% 时「涨停买入不可成交」这条阻断整个失效。
  const resolvedName = input.name?.trim() || (await lookupName(code));
  if (!resolvedName) {
    warnings.push(
      '取不到标的名称，无法判定是否 ST：涨跌幅上限按代码段上限处理，不产出涨停价候选，' +
        '若该股实为 ST（±5%），「涨停买入不可成交」这条硬阻断会漏报',
    );
  }
  const identity = { code, name: resolvedName ?? code, secid, nameUnknown: !resolvedName };

  // 2. 点位测算复用 levels.ts（含 ATR/枢轴/斐波/均线），不重算。
  //    三层各算一份：候选目录要分周期出位子，用日线的枢轴/斐波去冒充周线级别的位子是错的。
  const levelsByPeriod = new Map<PlanPeriod, PriceLevels>();
  await Promise.all(
    PLAN_PERIODS.map(async (period) => {
      const raw = await withDeadline(
        getPriceLevels(code, period, secid),
        CORE_DEADLINE_MS,
        `${period} 点位测算`,
      ).catch((e: unknown) => {
        warnings.push(`${period} 点位测算失败（${String(e).slice(0, 60)}），该层候选价位缺省`);
        return null;
      });
      // getPriceLevels 内部吞掉取数错误后返回 close=0 / asOf='' 的空壳，永远 truthy，
      // 因此判空必须看内容——否则会拿空壳去建候选目录，而不是走观察计划兜底。
      if (raw && raw.close > 0 && raw.asOf !== '') levelsByPeriod.set(period, raw);
      else if (raw) warnings.push(`${period} 点位测算返回空数据（上游取数失败），该层无候选价位`);
    }),
  );
  const levels = levelsByPeriod.get('day') ?? null;
  if (!levels) {
    warnings.push('日线点位测算不可用，无候选价位，只能生成观察计划');
  }

  // 3. 结构与量价（新增的确定性计算）
  //    60m 优先做缠论（次级别结构），无 60m 时退回日线并标注
  const structBase = periods.find((p) => p.period === '60m') ?? dayData;
  if (structBase.period !== '60m') {
    warnings.push('缺少 60 分钟数据，缠论结构退回日线口径');
  }
  const dow = computeDowStructure(dayBars, 'day');
  const chan = computeChanStructure(structBase.bars, structBase.period);
  /** 各层自己的道氏/缠论结构，供候选目录分层取摆动点与中枢。缺该层 K 线就整层缺省 */
  const structByPeriod = new Map<PlanPeriod, { dow: DowStructure | null; chan: ChanStructure | null }>();
  for (const period of PLAN_PERIODS) {
    const pd = periods.find((x) => x.period === period);
    if (!pd) continue;
    structByPeriod.set(period, {
      dow: computeDowStructure(pd.bars, period),
      chan: computeChanStructure(pd.bars, period),
    });
  }
  const volumePrice = computeVolumePrice({
    period: 'day',
    bars: dayBars,
    completeBar: dayData.meta.completeBar,
    // 必须实测而不是硬编码 true：本源不给成交额时 pickBasis 会回退成交量口径
    // （腾讯 fqkline 日线正是这种源），10 送 10 或 ETF 1:2 折算后成交量翻倍，
    // 会得出「极端放量 / 突破获量能确认」的假结论并一路影响 computePhase。
    volumeComparable: isVolumeComparable(dayBars),
  });
  // computeVolumePrice 自己会把「成交量不可比」写进 volumePrice.warnings，
  // 但那串只跟着量价读数走；这里再登记一条，让它进入计划级 warnings 与 dataStatus 计数
  warnings.push(...volumePrice.warnings.filter((w) => w.includes('不可比')));

  // 4. 阶段（带滞回）
  const phase = computePhase({
    bars: dayBars,
    completeBar: dayData.meta.completeBar,
    dow,
    volumePrice,
    ma: levels?.ma ?? null,
    atr: levels?.atr ?? null,
    prev: input.prevPhase ?? null,
  });

  // 5. 适配器证据并发取，全部可缺省
  const benchmarks = await adapter.resolveBenchmarks(identity).catch(() => [] as SymbolBenchmark[]);
  const [breadthR, execR, eventR, blocksR, rsR] = await Promise.allSettled([
    withDeadline(adapter.loadBreadthEvidence(identity), ADAPTER_DEADLINE_MS, '广度'),
    withDeadline(adapter.loadExecutionQuality(identity, dayBars), ADAPTER_DEADLINE_MS, '执行质量'),
    withDeadline(adapter.loadEventRisks(identity), ADAPTER_DEADLINE_MS, '事件风险'),
    withDeadline(adapter.hardBlocks(identity, dayBars), ADAPTER_DEADLINE_MS, '硬阻断'),
    withDeadline(computeRelativeStrength(dayBars, benchmarks), ADAPTER_DEADLINE_MS, '相对强弱'),
  ]);
  const breadth = breadthR.status === 'fulfilled' ? breadthR.value : null;
  if (breadthR.status === 'rejected') warnings.push('广度证据获取失败，本项未覆盖');
  const executionQuality = execR.status === 'fulfilled' ? execR.value : [];
  if (execR.status === 'rejected') warnings.push('执行质量获取失败，本项未覆盖');
  const eventRisks = eventR.status === 'fulfilled' ? eventR.value : [];
  if (eventR.status === 'rejected') warnings.push('事件风险获取失败，本项未覆盖');
  // 硬阻断必须 fail-closed：空数组等于「无阻断、可下单」，取数失败时按不可执行处理，
  // 否则涨停/停牌的票会因为一次 8 秒超时被判成可执行。
  const hardBlocks = blocksR.status === 'fulfilled' ? blocksR.value : ['硬阻断校验失败，按不可执行处理'];
  if (blocksR.status === 'rejected') warnings.push('涨跌停/停牌校验失败，动作已保守收紧');
  const relativeStrength = rsR.status === 'fulfilled' ? rsR.value.readings : [];
  if (rsR.status === 'fulfilled') warnings.push(...rsR.value.warnings);
  else warnings.push('相对强弱获取失败，本项未覆盖');
  if (breadth?.missing) warnings.push(breadth.note);

  // 6. 数据状态
  // periods 至少含日线（前面缺日线已抛错），真正的核心缺口是点位测算不可用
  const dataStatus = resolveDataStatus({
    coreMissing: !levels,
    completeBar: dayData.meta.completeBar,
    warningCount: warnings.length,
  });

  const asOf = dayData.meta.asOf;
  const contextId = makeContextId(code, asOf);

  // 7. 候选目录
  const adapterLevels: Array<{ price: number; label: string; evidenceId: string }> = [];
  const meta = await adapter.loadAssetMetadata(identity).catch(() => null);
  // 涨停价基准根按当根是否收完选：盘中最后一根还在动，基准是倒数第二根（昨收）；
  // 而 closeRegenerate 在 15:30 跑时最后一根已是今天收完的 bar，此时基准就是它——
  // 仍取倒数第二根算出的是**今天**的涨停价而非下一交易日的，偏差可达一个完整涨跌幅，
  // 而这个价位是以 entry_trigger / stop 角色进候选目录的。
  const limitBaseBar = dayData.meta.completeBar
    ? dayBars[dayBars.length - 1]
    : dayBars[dayBars.length - 2];
  // 上限不可信（主板个股但名称未知，5% 与 10% 分不清）时不产出这条候选：
  // 它以 entry_trigger / stop 角色进目录，猜错就是给 LLM 一个不存在的价位当触发线
  if (meta && meta.limitPct > 0 && !meta.limitPctUncertain && limitBaseBar) {
    const up = limitBaseBar.close * (1 + meta.limitPct / 100);
    adapterLevels.push({
      price: Math.round(up * 1000) / 1000,
      label: `涨停价 ${up.toFixed(3)}`,
      evidenceId: 'adapter:limitUp',
    });
  }

  const catalog = levels
    ? buildCandidateCatalog({
        contextId,
        code,
        periods: PLAN_PERIODS.flatMap((period) => {
          const lv = levelsByPeriod.get(period);
          const pd = periods.find((x) => x.period === period);
          if (!lv || !pd) return [];
          const st = structByPeriod.get(period);
          return [{ period, bars: pd.bars, levels: lv, dow: st?.dow ?? null, chan: st?.chan ?? null }];
        }),
        adapterLevels,
        createdAt: new Date().toISOString(),
        // 候选目录 1 天有效：合并车道后同一份计划里既有 60 分钟级触发也有周线级目标，
        // 给 3 天会让短周期那部分的位子早已失真却仍能被引用
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
    : {
        contextId,
        candidateModelVersion: CANDIDATE_MODEL_VERSION,
        catalogHash: 'no-levels',
        levels: [],
        conditions: [],
        omittedCounts: {},
        warnings: ['点位测算不可用，无候选价位，只能生成观察计划'],
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      };

  // 8. 每周期一行读数（不回原始 K 线数组，控制在 preview 截断线内）
  const periodReadings: SymbolTechnicalContext['periods'] = periods.map((p) => {
    const closes = p.bars.map((b) => b.close);
    const sma = (n: number): number | null => {
      if (closes.length < n) return null;
      const s = closes.slice(-n).reduce((a, b) => a + b, 0) / n;
      return Math.round(s * 1000) / 1000;
    };
    return {
      meta: p.meta,
      close: p.bars[p.bars.length - 1].close,
      ma20: sma(20),
      ma60: sma(60),
      atr: p.period === 'day' ? levels?.atr ?? null : null,
      atrPct: p.period === 'day' ? levels?.atrPct ?? null : null,
      macdState: null,
      barCount: p.bars.length,
    };
  });

  const context: SymbolTechnicalContext = {
    contextId,
    candidateModelVersion: CANDIDATE_MODEL_VERSION,
    evidenceVersion: EVIDENCE_VERSION,
    code,
    name: resolvedName ?? code,
    assetType,
    secid: secid ?? null,
    asOf,
    dataStatus,
    periods: periodReadings,
    dow,
    chan,
    volumePrice,
    phase,
    relativeStrength,
    breadth,
    benchmarks,
    executionQuality,
    eventRisks: [
      ...eventRisks,
      ...hardBlocks.map((b) => ({ kind: HARD_BLOCK_KIND, date: null, note: b })),
    ],
    positionContext: input.positionContext ?? null,
    marketRegimePhase: input.marketRegimePhase ?? null,
    boardStage: input.boardStage ?? null,
    candidateSummary: {
      levels: catalog.levels.length,
      conditions: catalog.conditions.length,
      catalogHash: catalog.catalogHash,
    },
    activePlan: input.activePlan ?? null,
    existingMarkCount: input.existingMarkCount ?? 0,
    warnings: [...warnings, ...volumePrice.warnings, ...dayData.meta.warnings],
  };

  return { context, catalog, dayBars };
}

/** 供工具层复用：本次上下文的硬阻断列表 */
export function hardBlocksOf(context: SymbolTechnicalContext): string[] {
  return context.eventRisks.filter((e) => e.kind === HARD_BLOCK_KIND).map((e) => e.note);
}


