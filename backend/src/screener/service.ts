import type {
  ScreenEngineInfo,
  ScreenNlStrategy,
  ScreenRunDetail,
  ScreenStrategy,
  RunTrigger,
  ScreenProgressEvent,
  Horizon,
} from '@stock-agent/shared';
import { getMeta, setMeta } from '../settings';
import { DEFAULT_STRATEGY_ID, hasStrategy, listStrategies } from './strategy';
import {
  DEFAULT_NL_STRATEGY_ID,
  hasNlStrategy,
  listNlStrategies,
} from './nlStrategies';
import { DEFAULT_ENGINE, getEngine, hasEngine, listEngines } from './engines';
import { getRunDetail, getPickRowsForEval, listRuns, saveRun, updatePickEval } from './repo';
import { fetchMarketSnapshot } from './snapshot';

// 选股编排（多链路分发）：runScreen 解析默认值后按 engine 分发到具体链路（engines.ts），
// 链路产出候选后在此统一落库。当前内置 multifactor（三层漏斗）。
// 「默认策略 / 默认 TopN」是 multifactor 链路的页内配置（供收盘定时任务用），
// 用 setMeta/getMeta 存为模块本地 kv，不进全局设置页。

/** 页内默认配置的本地 kv 键（仅本模块读写，不在 SettingKey 枚举内） */
const META_STRATEGY = 'screener_default_strategy';
const META_TOP_N = 'screener_default_top_n';

function clampTopN(v: number | string | null | undefined): number {
  const n = Number(v) || 10;
  return Math.min(Math.max(Math.round(n), 3), 30);
}

/** 默认策略 id（页内配置 → 内置默认） */
function defaultStrategyId(): string {
  const m = (getMeta(META_STRATEGY) ?? '').trim();
  return m && hasStrategy(m) ? m : DEFAULT_STRATEGY_ID;
}

/** 默认输出数量（页内配置 → 10） */
function defaultTopN(): number {
  return clampTopN(getMeta(META_TOP_N));
}

function resolveStrategyId(id: string | null | undefined): string {
  const v = (id ?? '').trim();
  return v && hasStrategy(v) ? v : defaultStrategyId();
}

/** 自然语言选股链路的预设解析（与多因子策略口径互不相干） */
function resolveNlStrategyId(id: string | null | undefined): string {
  const v = (id ?? '').trim();
  return v && hasNlStrategy(v) ? v : DEFAULT_NL_STRATEGY_ID;
}

/** 读取页内默认配置（选股页展示与定时任务共用） */
export function getDefaults(): { strategyId: string; topN: number } {
  return { strategyId: defaultStrategyId(), topN: defaultTopN() };
}

/** 保存页内默认配置（仅接受合法策略 id 与 3-30 的数量） */
export function setDefaults(patch: { strategyId?: string; topN?: number }): {
  strategyId: string;
  topN: number;
} {
  if (patch.strategyId && hasStrategy(patch.strategyId)) {
    setMeta(META_STRATEGY, patch.strategyId);
  }
  if (patch.topN != null) {
    setMeta(META_TOP_N, String(clampTopN(patch.topN)));
  }
  return getDefaults();
}

export interface RunScreenOptions {
  /** 选股链路 id（缺省 multifactor） */
  engine?: string | null;
  strategyId?: string | null;
  context?: string | null;
  topN?: number | null;
  /** 是否调用 LLM 横向排序（默认 true；纯量化筛选传 false） */
  useLlm?: boolean;
  trigger: RunTrigger;
  taskName?: string | null;
  /** 持有视角：short 短线（默认）/ mid 中线下钻 */
  horizon?: Horizon;
  /** 限定候选池代码集合（如 ETF 成分股下钻 universe；为空走全市场） */
  universe?: string[] | null;
  /** universe 来源说明（落库展示，如「轮动 TopN 强赛道成分股」） */
  universeNote?: string | null;
  /** 进度回调（WS 手动选股传入；cron/agent 缺省即静默） */
  onProgress?: (e: ScreenProgressEvent) => void;
}

/** 执行一次选股：按 engine 分发到具体链路产出候选，统一落库并返回详情 */
export async function runScreen(opts: RunScreenOptions): Promise<ScreenRunDetail> {
  const engineId = (opts.engine ?? '').trim() || DEFAULT_ENGINE;
  if (!hasEngine(engineId)) throw new Error(`未知或未启用的选股链路：${engineId}`);
  const engine = getEngine(engineId);

  // 自然语言链路按 NL 预设解析 strategyId；其它链路按多因子策略解析
  const resolvedStrategyId =
    engine.info.id === 'nl'
      ? resolveNlStrategyId(opts.strategyId)
      : resolveStrategyId(opts.strategyId);

  const horizon: Horizon = opts.horizon === 'mid' ? 'mid' : 'short';
  const universe =
    opts.universe && opts.universe.length > 0
      ? Array.from(new Set(opts.universe.map((c) => c.trim()).filter(Boolean)))
      : null;

  const out = await engine.produce({
    strategyId: resolvedStrategyId,
    context: (opts.context ?? '').trim(),
    topN: opts.topN != null ? clampTopN(opts.topN) : defaultTopN(),
    useLlm: opts.useLlm !== false,
    trigger: opts.trigger,
    horizon,
    universe,
    onProgress: opts.onProgress,
  });

  const id = saveRun(
    {
      engine: engine.info.id,
      strategyId: out.strategyId,
      strategyName: out.strategyName,
      trigger: opts.trigger,
      marketCount: out.marketCount,
      filteredCount: out.filteredCount,
      topN: out.picks.length,
      context: out.context,
      marketView: out.marketView,
      selectionLogic: out.selectionLogic,
      portfolioRisk: out.portfolioRisk,
      runId: out.runId,
      horizon,
      universeNote: universe ? opts.universeNote ?? null : null,
    },
    out.picks,
  );

  const detail = getRunDetail(id);
  if (!detail) throw new Error('选股落库后读取失败');
  return detail;
}

/** T+N 轻量复盘：用最新快照价回填某次运行候选的区间收益 */
export async function evalRun(runId: string): Promise<{ updated: number }> {
  const rows = getPickRowsForEval(runId);
  if (rows.length === 0) return { updated: 0 };
  const snapshot = await fetchMarketSnapshot();
  const priceByCode = new Map(snapshot.map((r) => [r.code, r.price]));
  let updated = 0;
  for (const r of rows) {
    const latest = priceByCode.get(r.code);
    if (latest == null || latest <= 0 || r.price <= 0) continue;
    const ret = Math.round(((latest - r.price) / r.price) * 1000) / 10;
    updatePickEval(r.id, latest, ret);
    updated += 1;
  }
  return { updated };
}

/** 选股模块状态：链路清单 + 策略清单 + 页内默认配置 + 最近运行 */
export function status(): {
  engines: ScreenEngineInfo[];
  defaultEngine: string;
  strategies: ScreenStrategy[];
  nlStrategies: ScreenNlStrategy[];
  defaultStrategyId: string;
  defaultTopN: number;
  recentRuns: ReturnType<typeof listRuns>;
} {
  const d = getDefaults();
  return {
    engines: listEngines(),
    defaultEngine: DEFAULT_ENGINE,
    strategies: listStrategies(),
    nlStrategies: listNlStrategies(),
    defaultStrategyId: d.strategyId,
    defaultTopN: d.topN,
    recentRuns: listRuns(10),
  };
}

export { listRuns, getRunDetail, listStrategies, listNlStrategies, listEngines };
