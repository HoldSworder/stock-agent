import type {
  CrossSectionSpec,
  ModeExit,
  ModeHolding,
  ModeSignalAction,
  ModeSpec,
  ModeTrackResult,
  ResearchModeBacktestInput,
  ThemeFirstSpec,
} from '@stock-agent/shared';
import { listPool } from '../etf/repo';
import { mapLimit } from '../datasource/klineCache';
import { sideCostBps } from '../backtest/costs';
import type { Bar } from './factors';
import { computeRows, fetchBars } from './factors';
import { annotateThemes, replayThemeFirst, shortName, type UniverseSeries } from './themeFirst';
import { addEvents, clearEventsOn, getMode, orderedDaily, upsertDaily } from './repo';
import { protocolKeyOf } from './gate';
import { isSupertrendDown, supertrendDirection } from './supertrend';
import {
  logModeProtocol,
  modeProtocolOf,
  type ModeProtocol,
  type ModeUniversePolicy,
} from './protocol';

// 站内声明式跟踪引擎（trackingMode=system）：纯 TS、纯只读取数，不下单、不调 python。
// 两种 spec：
//   - crossSection（默认）：横截面加权 z-score 选 TopN（可主题去重 + 退出规则过滤）；
//   - themeFirst：先选主线主题再买主题内代表标的，从 anchorDate 全量回放（见 themeFirst.ts）。
// 取数统一走 a-stock-data 的 mootdx 日线 + ETF 跟踪池，与 mode/ 下 python 回测同源，
// 否则站内复算的持仓/收益与回测口径对不上。白名单外策略仍走 external 推送。

const BENCH_CODE = '510300';

/** 回测轴前段跳过的交易日数（保证因子可算）。跟踪侧也用它对齐调仓相位 */
const WARMUP_DAYS = 120;

/** 导出仅为让自检能直接构造序列断言 realizedReturn 的缺数据语义，生产路径不从外部构造 */
export interface Series {
  code: string;
  name: string;
  theme: string;
  dates: string[];
  /** 已复权的完整 OHLCV。退出规则要真实高低价，单独维护 H/L/C 三个数组容易错位 */
  bars: Bar[];
  closes: number[];
  idx: Map<string, number>;
  /** supertrend 方向序列缓存，key = `${period}:${mult}`。回测逐日调用，不缓存会退化成 O(n²) */
  stCache: Map<string, number[]>;
}

interface PoolBars {
  code: string;
  /** 已按 python load_pool 的 short() 截断，供 family() 归主题 */
  name: string;
  theme: string;
  bars: Bar[];
}

/** 标的池条目（数据库跟踪池与研究基准池的公共形状） */
interface PoolItem {
  code: string;
  name: string;
  tags?: string | null;
}

/**
 * 取标的池 + 基准 510300 的 mootdx 日线，并对齐到基准交易日轴（python 同款口径）。
 * items 省略时用数据库 ETF 跟踪池（生产默认）；自检需要研究基准池时显式传入。
 */
async function loadPoolBars(items?: ReadonlyArray<PoolItem>): Promise<{
  pool: PoolBars[];
  /** 申报池全量条目（含今天取数失败的）：协议口径键必须建在它上面，不能建在 pool 上 */
  declared: ReadonlyArray<PoolItem>;
  benchClose: Map<string, number>;
  dates: string[];
}> {
  const benchBars = await fetchBars(BENCH_CODE);
  if (!benchBars.length) throw new Error(`基准 ${BENCH_CODE} 行情取数失败`);
  const benchClose = new Map(benchBars.map((b) => [b.d, b.c]));
  const dates = [...benchClose.keys()].sort();

  // 并发 4：池子几十只、每只一趟 sidecar 拿 800 根，串行往返太慢；
  // 并发再高会撞 sidecar 上游限流，得不偿失
  const poolItems: ReadonlyArray<PoolItem> = items ?? listPool();
  const barsByIdx: Bar[][] = poolItems.map(() => []);
  await mapLimit(
    poolItems.map((_, i) => i),
    4,
    async (i) => {
      try {
        barsByIdx[i] = (await fetchBars(poolItems[i].code)).filter((b) => benchClose.has(b.d));
      } catch {
        /* 单只取数失败按无数据处理，不打断整池 */
      }
    },
  );
  const pool: PoolBars[] = [];
  for (const [i, item] of poolItems.entries()) {
    const bars = barsByIdx[i];
    if (bars.length < 130) continue;
    const name = shortName(item.name);
    pool.push({ code: item.code, name, theme: (item.tags ?? '').split(',')[0] || name, bars });
  }
  if (!pool.length) throw new Error('ETF 跟踪池行情全部取数失败');
  return { pool, declared: poolItems, benchClose, dates };
}

function mean(a: number[]): number {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
function smaAt(closes: number[], i: number, n: number): number | null {
  if (i - n + 1 < 0) return null;
  return mean(closes.slice(i - n + 1, i + 1));
}
function retAt(closes: number[], i: number, n: number): number | null {
  if (i - n < 0 || closes[i - n] <= 0) return null;
  return closes[i] / closes[i - n] - 1;
}
function stdev(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
}

/** 因子原始值（横截面 z-score 前）。bench 为对齐到同日的基准收益查询函数。 */
function factorRaw(
  name: string,
  s: Series,
  i: number,
  benchRet: (n: number) => number | null,
): number | null {
  const c = s.closes;
  const mom = name.match(/^mom(\d+)$/);
  if (mom) return retAt(c, i, Number(mom[1]));
  if (name === 'rs90' || name === 'rs60') {
    const n = name === 'rs90' ? 90 : 60;
    const own = retAt(c, i, n);
    const b = benchRet(n);
    if (own === null || b === null) return null;
    return own - b;
  }
  if (name === 'trendQuality' || name === 'crossRank') {
    const m30 = retAt(c, i, 30);
    const ma20 = smaAt(c, i, 20);
    const ma60 = smaAt(c, i, 60);
    if (m30 === null || ma20 === null || ma60 === null) return null;
    const rets = c.slice(Math.max(0, i - 19), i + 1).map((v, k, arr) => (k === 0 ? 0 : v / arr[k - 1] - 1));
    const vol = stdev(rets.slice(1));
    return m30 + 0.15 * Math.max(ma20 / ma60 - 1, 0) + 0.15 * Math.max(c[i] / ma60 - 1, 0) - 0.15 * vol;
  }
  return null;
}

/** 退出规则：true 表示该标的当前触发退出，应被剔除候选 */
function exitTriggered(exits: ModeExit[] | undefined, s: Series, i: number): boolean {
  if (!exits?.length) return false;
  const c = s.closes;
  for (const ex of exits) {
    if (ex.type === 'belowMaDrawdown') {
      const ma = smaAt(c, i, ex.ma);
      if (ma === null) continue;
      const lookback = c.slice(Math.max(0, i - 59), i + 1);
      const hi = Math.max(...lookback);
      if (c[i] < ma && hi > 0 && c[i] / hi - 1 <= -ex.drawdownPct / 100) return true;
    } else if (ex.type === 'supertrend') {
      if (isSupertrendDown(supertrendOf(s, ex.period, ex.mult), i, ex.period)) return true;
    }
    // rankDrop 由每日重选 TopN 隐式实现，无需单独处理
  }
  return false;
}

/** 按 period:mult 缓存整条方向序列，逐日查询降到 O(1)（回测每天都要问一次） */
function supertrendOf(s: Series, period: number, mult: number): number[] {
  const key = `${period}:${mult}`;
  let dir = s.stCache.get(key);
  if (!dir) {
    dir = supertrendDirection(s.bars, period, mult);
    s.stCache.set(key, dir);
  }
  return dir;
}

/** 在某交易日计算应持仓（横截面加权 z-score 选 TopN，主题去重 + 退出过滤） */
function holdingsAt(spec: CrossSectionSpec, all: Series[], date: string, benchOf: BenchOf): ModeHolding[] {
  const scored: Array<{ s: Series; score: number }> = [];
  // 先算各因子在全池的原始值，便于 z-score
  const rawByFactor = new Map<string, Map<string, number>>();
  for (const f of spec.selectorFactors) rawByFactor.set(f.name, new Map());
  for (const s of all) {
    const i = s.idx.get(date);
    if (i === undefined) continue;
    if (exitTriggered(spec.exits, s, i)) continue;
    const benchRet = benchOf(date);
    let ok = true;
    for (const f of spec.selectorFactors) {
      const v = factorRaw(f.name, s, i, benchRet);
      if (v === null) {
        ok = false;
        break;
      }
      rawByFactor.get(f.name)!.set(s.code, v);
    }
    if (ok) scored.push({ s, score: 0 });
  }
  if (!scored.length) return [];
  // z-score 各因子后加权
  for (const f of spec.selectorFactors) {
    const m = rawByFactor.get(f.name)!;
    const vals = scored.map((x) => m.get(x.s.code) ?? 0);
    const mu = mean(vals);
    const sd = stdev(vals) || 1e-9;
    for (const x of scored) x.score += f.weight * (((m.get(x.s.code) ?? mu) - mu) / sd);
  }
  scored.sort((a, b) => b.score - a.score);
  const picked: Series[] = [];
  const seenTheme = new Set<string>();
  for (const x of scored) {
    if (spec.dedupTheme) {
      if (seenTheme.has(x.s.theme)) continue;
      seenTheme.add(x.s.theme);
    }
    picked.push(x.s);
    if (picked.length >= spec.topN) break;
  }
  const weights =
    spec.weights && spec.weights.length === picked.length
      ? spec.weights
      : picked.map(() => 1 / Math.max(picked.length, 1));
  return picked.map((s, k) => ({ code: s.code, name: s.name, weight: Math.round(weights[k] * 1000) / 1000 }));
}

type BenchOf = (date: string) => (n: number) => number | null;

interface TrackContext {
  all: Series[];
  /** 申报池全量条目（协议口径键的输入） */
  declared: ReadonlyArray<PoolItem>;
  map: Map<string, Series>;
  benchOf: BenchOf;
  goodDates: string[];
}

/** 加载 ETF 跟踪池行情 + 基准 + 覆盖度足够的交易日轴（供每日跟踪与历史重跑共用） */
async function loadContext(): Promise<TrackContext> {
  const { pool, declared, benchClose, dates: benchDates } = await loadPoolBars();
  const all: Series[] = [];
  const map = new Map<string, Series>();
  for (const p of pool) {
    const s: Series = {
      code: p.code,
      name: p.name,
      theme: p.theme,
      dates: p.bars.map((b) => b.d),
      bars: p.bars,
      closes: p.bars.map((b) => b.c),
      idx: new Map(p.bars.map((b, i) => [b.d, i])),
      stCache: new Map(),
    };
    all.push(s);
    map.set(s.code, s);
  }

  const benchIdx = new Map(benchDates.map((d, i) => [d, i]));
  const benchOf: BenchOf = (date) => (n) => {
    const i = benchIdx.get(date);
    if (i === undefined || i - n < 0) return null;
    const prev = benchClose.get(benchDates[i - n]) ?? 0;
    const cur = benchClose.get(benchDates[i]) ?? 0;
    return prev > 0 ? cur / prev - 1 : null;
  };

  const coverage = new Map<string, number>();
  for (const s of all) for (const d of s.dates) coverage.set(d, (coverage.get(d) ?? 0) + 1);
  const minCover = Math.min(3, all.length);
  const goodDates = [...coverage.entries()].filter(([, c]) => c >= minCover).map(([d]) => d).sort();
  if (!goodDates.length) throw new Error('无足够覆盖的交易日');
  return { all, declared, map, benchOf, goodDates };
}

/**
 * 一日实现收益：持有 prevHoldings 从 prevDate 到 date 的加权收益（按可得标的归一）。
 * 全部持仓都取不到行情时返回 null 而非 0——0 会被 cumReturn 当成「当日持平」乘进累计收益，
 * 与真实的「数据缺失」无法区分，缺一天数据就等于凭空断言了一天零涨跌。
 */
export function realizedReturn(
  prevHoldings: ModeHolding[],
  prevDate: string,
  date: string,
  map: Map<string, Series>,
): number | null {
  let acc = 0;
  let wsum = 0;
  for (const h of prevHoldings) {
    const s = map.get(h.code);
    if (!s) continue;
    const i0 = s.idx.get(prevDate);
    const i1 = s.idx.get(date);
    if (i0 === undefined || i1 === undefined || s.closes[i0] <= 0) continue;
    acc += h.weight * (s.closes[i1] / s.closes[i0] - 1);
    wsum += h.weight;
  }
  return wsum > 0 ? acc / wsum : null;
}

/**
 * 今天是不是调仓日。跟踪与回测共用同一相位：在 goodDates 上跳过 WARMUP_DAYS 根预热后，
 * 每 rebalanceDays 换一次腿。跟踪侧不这样判就会每天重算 TopN，把名次抖动记成真实换手。
 * @param axisIdx today 在 goodDates 里的下标；-1（找不到）按调仓日处理，宁可多算一次
 */
export function isRebalanceDay(axisIdx: number, rebalanceDays: number): boolean {
  if (axisIdx < 0 || !(rebalanceDays >= 1)) return true;
  return (axisIdx - WARMUP_DAYS) % rebalanceDays === 0;
}

/** 换手成本（小数）：卖掉 exited 权重、买进 entered 权重各扣一次单边费率 */
export function turnoverCost(
  prev: ModeHolding[],
  next: ModeHolding[],
  costs: { buyBps: number; sellBps: number },
): number {
  const prevW = new Map(prev.map((h) => [h.code, h.weight]));
  const nextW = new Map(next.map((h) => [h.code, h.weight]));
  let sold = 0;
  let bought = 0;
  for (const [code, w] of prevW) sold += Math.max(0, w - (nextW.get(code) ?? 0));
  for (const [code, w] of nextW) bought += Math.max(0, w - (prevW.get(code) ?? 0));
  return (sold * costs.sellBps + bought * costs.buyBps) / 10000;
}

/** 取 system 模式的 spec，非 system / 缺 spec 直接抛错 */
function requireSpec(modeId: string): ModeSpec {
  const mode = getMode(modeId);
  if (!mode) throw new Error(`模式不存在：${modeId}`);
  if (mode.trackingMode !== 'system' || !mode.spec) {
    throw new Error(`模式 ${modeId} 非 system 跟踪或缺少 spec`);
  }
  return mode.spec;
}

/**
 * 加载 themeFirst 引擎所需的因子序列与交易日轴（自 anchorDate 起算，保证调仓相位可复现）。
 * opts.pool 用于把标的池换成 mode/ 下研究脚本的内置池：自检要验证的是「因子链与回放逻辑
 * 移植是否正确」，用会漂移的生产跟踪池会让池差异伪装成移植错误。生产路径不传，行为不变。
 */
export async function loadThemeFirstContext(
  spec: ThemeFirstSpec,
  opts: { pool?: ReadonlyArray<PoolItem> } = {},
): Promise<{ universe: UniverseSeries[]; declared: ReadonlyArray<PoolItem>; dates: string[] }> {
  const { pool, declared, benchClose, dates: benchDates } = await loadPoolBars(opts.pool);
  const universe: UniverseSeries[] = pool.map((p) => ({
    code: p.code,
    name: p.name,
    rows: computeRows(p.bars, benchClose),
  }));
  const dates = benchDates.filter((d) => d >= spec.anchorDate);
  if (dates.length < 2) throw new Error(`anchorDate ${spec.anchorDate} 之后无足够交易日`);
  annotateThemes(universe, dates);
  return { universe, declared, dates };
}

/**
 * 由**申报池**算协议标记，打日志留痕并随当日快照落库。
 * includedCount 传今天实际纳入的标的数，只当元数据；口径键必须只随申报池变化，
 * 否则一只 ETF 瞬时取数失败就换 hash，晋级门样本会被截断到当天。
 * 成本档不再写死 ETF 免税档，交给 modeProtocolOf 按池内品种判定（池里混进个股要计印花税）。
 */
function protocolFor(
  modeId: string | undefined,
  spec: ModeSpec,
  declared: ReadonlyArray<{ code: string; name: string }>,
  includedCount: number,
  policy: ModeUniversePolicy,
): ModeProtocol {
  const p = modeProtocolOf(spec, declared, { modeId, policy, includedCount });
  if (modeId) logModeProtocol(modeId, p);
  return p;
}

/** themeFirst 的当日跟踪：从 anchorDate 全量回放，取末日切片作为今日快照 */
async function trackThemeFirst(modeId: string, spec: ThemeFirstSpec): Promise<ModeTrackResult> {
  const { universe, declared, dates } = await loadThemeFirstContext(spec);
  const protocol = protocolFor(modeId, spec, declared, universe.length, 'db-etf-pool');
  const r = replayThemeFirst(spec, universe, dates, protocol.costBps);
  const last = r.days[r.days.length - 1];
  const prevEquity = r.days.length > 1 ? r.days[r.days.length - 2].equity : 1;

  const holdings: ModeHolding[] = last.holding
    ? [{ code: last.holding.code, name: last.holding.name, weight: 1 }]
    : [];
  const dayReturn = prevEquity > 0 ? last.equity / prevEquity - 1 : 0;
  const cumReturn = last.equity - 1;
  const peak = Math.max(...r.days.map((d) => d.equity), 1);
  const drawdown = peak > 0 ? last.equity / peak - 1 : 0;
  const events = last.events;

  const signal: ModeSignalAction[] = events.map((e) => ({ kind: e.kind, code: '', note: e.detail }));
  upsertDaily(modeId, 'system', {
    date: last.date,
    holdings,
    signal,
    dayReturn: Math.round(dayReturn * 10000) / 10000,
    cumReturn: Math.round(cumReturn * 10000) / 10000,
    drawdown: Math.round(drawdown * 10000) / 10000,
    protocol,
  });
  clearEventsOn(modeId, last.date);
  addEvents(modeId, last.date, events);

  return { date: last.date, holdings, events, dayReturn, cumReturn, drawdown };
}

/** 跑一只 system 模式的当日跟踪并落库；返回结果（无数据/无 spec 抛错由调用方兜底） */
export async function runModeTracking(modeId: string): Promise<ModeTrackResult> {
  const spec = requireSpec(modeId);
  if (spec.kind === 'themeFirst') return trackThemeFirst(modeId, spec);
  const { all, declared, map, benchOf, goodDates } = await loadContext();
  const protocol = protocolFor(modeId, spec, declared, all.length, 'db-etf-pool');
  const today = goodDates[goodDates.length - 1];

  // 前向累计：取早于 today 的最近一条快照
  const prior = orderedDaily(modeId).filter((d) => d.date < today);
  const prev = prior.length ? prior[prior.length - 1] : null;

  // 调仓相位必须与回测一致：回测在 goodDates.slice(WARMUP_DAYS) 上每 rebalanceDays 换一次腿，
  // 跟踪侧若每天重算 TopN，名次抖动会天天记一笔换手成本（rebalanceDays=4 时成本拖累约 4 倍），
  // 而两条曲线的 protocolVersion 相同，会被晋级门与列表页当成可横向比较的证据。
  const rebalance =
    isRebalanceDay(goodDates.indexOf(today), spec.rebalanceDays) || !prev?.holdings.length;
  const holdings = rebalance ? holdingsAt(spec, all, today, benchOf) : prev!.holdings;

  // 持仓行情缺失时 realizedReturn 返回 null：当日快照的 dayReturn 留空，cumReturn 沿用前值，
  // 不用 0 冒充「持平」
  const rawDayReturn =
    prev && prev.holdings.length ? realizedReturn(prev.holdings, prev.date, today, map) : 0;
  const dayReturn =
    rawDayReturn === null
      ? null
      : rawDayReturn - (prev ? turnoverCost(prev.holdings, holdings, protocol.costBps) : 0);
  const cumReturn = prev
    ? (1 + (prev.cumReturn ?? 0)) * (1 + (dayReturn ?? 0)) - 1
    : 0;

  // 回撤：峰值只在**同协议区段**内取。换代当天 cumReturn 会把新旧口径接在一条曲线上
  // （旧行是零成本口径、系统性偏高），拿旧峰值算今天的回撤会系统性偏大。
  const key = protocolKeyOf(protocol);
  const sameSeg: number[] = [];
  for (let i = prior.length - 1; i >= 0 && protocolKeyOf(prior[i].protocol) === key; i--) {
    sameSeg.push(1 + (prior[i].cumReturn ?? 0));
  }
  const equities = [...sameSeg, 1 + cumReturn];
  const peak = Math.max(...equities);
  const drawdown = peak > 0 ? (1 + cumReturn) / peak - 1 : 0;

  // 事件：与 prev 持仓比对
  const prevCodes = new Set((prev?.holdings ?? []).map((h) => h.code));
  const nowCodes = new Set(holdings.map((h) => h.code));
  const events: ModeTrackResult['events'] = [];
  for (const h of holdings) if (!prevCodes.has(h.code)) events.push({ kind: 'enter', detail: `买入 ${h.name}(${h.code})` });
  for (const h of prev?.holdings ?? []) if (!nowCodes.has(h.code)) events.push({ kind: 'exit', detail: `卖出 ${h.name}(${h.code})` });

  // 落库（按 (modeId,date) 幂等；事件先清当日再写，重跑不重复）
  const signal: ModeSignalAction[] = events.map((e) => ({
    kind: e.kind,
    code: '',
    note: e.detail,
  }));
  upsertDaily(modeId, 'system', {
    date: today,
    holdings,
    signal,
    dayReturn: dayReturn === null ? undefined : Math.round(dayReturn * 10000) / 10000,
    cumReturn: Math.round(cumReturn * 10000) / 10000,
    drawdown: Math.round(drawdown * 10000) / 10000,
    protocol,
  });
  clearEventsOn(modeId, today);
  addEvents(modeId, today, events);

  return { date: today, holdings, events, dayReturn: dayReturn ?? 0, cumReturn, drawdown };
}

/** themeFirst 的历史重跑：与每日跟踪共用同一条回放路径，只是取全程指标 */
async function backtestThemeFirst(
  modeId: string,
  spec: ThemeFirstSpec,
): Promise<ResearchModeBacktestInput> {
  const { universe, declared, dates } = await loadThemeFirstContext(spec);
  const protocol = protocolFor(modeId, spec, declared, universe.length, 'db-etf-pool');
  const r = replayThemeFirst(spec, universe, dates, protocol.costBps);
  const pct = (v: number): number => Math.round(v * 1000) / 10;
  // 非复利（等权）累计收益：逐日收益等权求和，去掉复利的路径依赖偏差
  let flat = 0;
  for (let i = 1; i < r.days.length; i++) {
    const prev = r.days[i - 1].equity;
    if (prev > 0) flat += r.days[i].equity / prev - 1;
  }
  const years = r.days.length / 244;
  const annualized = years > 0 ? Math.pow(Math.max(r.equity, 1e-9), 1 / years) - 1 : null;
  return {
    label: `系统重跑 ${dates[dates.length - 1]}`,
    range: `${dates[0]} ~ ${dates[dates.length - 1]}`,
    poolSize: universe.length,
    metrics: {
      return: pct(r.equity - 1),
      flatReturn: pct(flat),
      annualized: annualized === null ? undefined : pct(annualized),
      maxDrawdown: pct(r.maxDrawdown),
      trades: r.tradeCount,
      avgPositions: Math.round(r.heldRatio * 100) / 100,
      maxPositions: 1,
    },
    isRecommended: false,
    protocol: protocol.protocolVersion,
    engineVersion: protocol.engineVersion,
  };
}

/** 按 spec 历史重跑回测，返回可写库的指标摘要（纯 TS，不依赖 python）。收益以百分比表达，与 README 口径一致。 */
export async function runModeBacktest(modeId: string): Promise<ResearchModeBacktestInput> {
  const spec = requireSpec(modeId);
  if (spec.kind === 'themeFirst') return backtestThemeFirst(modeId, spec);
  const { all, declared, map, benchOf, goodDates } = await loadContext();
  const protocol = protocolFor(modeId, spec, declared, all.length, 'db-etf-pool');
  const axis = goodDates.slice(WARMUP_DAYS); // 跳过前段，保证因子可算
  if (axis.length < 30) throw new Error('可回测交易日不足');

  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  let trades = 0;
  let holdings: ModeHolding[] = [];
  let lastRebal = -spec.rebalanceDays;
  for (let k = 0; k < axis.length; k++) {
    const date = axis[k];
    if (k > 0 && holdings.length) {
      // 缺数据的一天不当作零涨跌乘进权益，直接跳过（曲线在该日持平但不伪造事实）
      const day = realizedReturn(holdings, axis[k - 1], date, map);
      if (day !== null) {
        equity *= 1 + day;
        peak = Math.max(peak, equity);
        maxDD = Math.min(maxDD, equity / peak - 1);
      }
    }
    if (k - lastRebal >= spec.rebalanceDays || holdings.length === 0) {
      const next = holdingsAt(spec, all, date, benchOf);
      if (next.length) {
        const prevCodes = new Set(holdings.map((h) => h.code));
        const nextCodes = new Set(next.map((h) => h.code));
        for (const h of next) if (!prevCodes.has(h.code)) trades++;
        for (const h of holdings) if (!nextCodes.has(h.code)) trades++;
        // 换手要扣费：零成本重跑会让 rebalanceDays 小的 spec 系统性高估收益，
        // 而这些指标又要落库、在列表页按收益横向排序
        equity *= 1 - turnoverCost(holdings, next, protocol.costBps);
        peak = Math.max(peak, equity);
        maxDD = Math.min(maxDD, equity / peak - 1);
        holdings = next;
        lastRebal = k;
      }
    }
  }
  const years = axis.length / 244;
  const annualized = years > 0 ? Math.pow(Math.max(equity, 1e-9), 1 / years) - 1 : null;
  const pct = (v: number): number => Math.round(v * 1000) / 10; // 小数→百分比1位
  return {
    label: `系统重跑 ${axis[axis.length - 1]}`,
    range: `${axis[0]} ~ ${axis[axis.length - 1]}`,
    poolSize: protocol.poolSize,
    metrics: {
      return: pct(equity - 1),
      annualized: annualized === null ? undefined : pct(annualized),
      maxDrawdown: pct(maxDD),
      trades,
      avgPositions: spec.topN,
      maxPositions: spec.topN,
    },
    isRecommended: false,
    protocol: protocol.protocolVersion,
    engineVersion: protocol.engineVersion,
  };
}
