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
import type { Bar } from './factors';
import { computeRows, fetchBars } from './factors';
import { annotateThemes, replayThemeFirst, shortName, type UniverseSeries } from './themeFirst';
import { addEvents, clearEventsOn, getMode, orderedDaily, upsertDaily } from './repo';

// 站内声明式跟踪引擎（trackingMode=system）：纯 TS、纯只读取数，不下单、不调 python。
// 两种 spec：
//   - crossSection（默认）：横截面加权 z-score 选 TopN（可主题去重 + 退出规则过滤）；
//   - themeFirst：先选主线主题再买主题内代表标的，从 anchorDate 全量回放（见 themeFirst.ts）。
// 取数统一走 a-stock-data 的 mootdx 日线 + ETF 跟踪池，与 mode/ 下 python 回测同源，
// 否则站内复算的持仓/收益与回测口径对不上。白名单外策略仍走 external 推送。

const BENCH_CODE = '510300';

interface Series {
  code: string;
  name: string;
  theme: string;
  dates: string[];
  closes: number[];
  idx: Map<string, number>;
}

interface PoolBars {
  code: string;
  /** 已按 python load_pool 的 short() 截断，供 family() 归主题 */
  name: string;
  theme: string;
  bars: Bar[];
}

/** 取 ETF 跟踪池 + 基准 510300 的 mootdx 日线，并对齐到基准交易日轴（python 同款口径） */
async function loadPoolBars(): Promise<{
  pool: PoolBars[];
  benchClose: Map<string, number>;
  dates: string[];
}> {
  const benchBars = await fetchBars(BENCH_CODE);
  if (!benchBars.length) throw new Error(`基准 ${BENCH_CODE} 行情取数失败`);
  const benchClose = new Map(benchBars.map((b) => [b.d, b.c]));
  const dates = [...benchClose.keys()].sort();

  // 并发 4：池子几十只、每只一趟 sidecar 拿 800 根，串行往返太慢；
  // 并发再高会撞 sidecar 上游限流，得不偿失
  const items = listPool();
  const barsByIdx: Bar[][] = items.map(() => []);
  await mapLimit(
    items.map((_, i) => i),
    4,
    async (i) => {
      try {
        barsByIdx[i] = (await fetchBars(items[i].code)).filter((b) => benchClose.has(b.d));
      } catch {
        /* 单只取数失败按无数据处理，不打断整池 */
      }
    },
  );
  const pool: PoolBars[] = [];
  for (const [i, item] of items.entries()) {
    const bars = barsByIdx[i];
    if (bars.length < 130) continue;
    const name = shortName(item.name);
    pool.push({ code: item.code, name, theme: (item.tags ?? '').split(',')[0] || name, bars });
  }
  if (!pool.length) throw new Error('ETF 跟踪池行情全部取数失败');
  return { pool, benchClose, dates };
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
      if (supertrendDown(s, i, ex.period, ex.mult)) return true;
    }
    // rankDrop 由每日重选 TopN 隐式实现，无需单独处理
  }
  return false;
}

/** 极简 supertrend：用收盘近似 hl2，判定当前是否处于下行段 */
function supertrendDown(s: Series, i: number, period: number, mult: number): boolean {
  const c = s.closes;
  if (i < period + 2) return false;
  // ATR 用收盘绝对差近似
  const diffs: number[] = [];
  for (let k = i - period + 1; k <= i; k++) diffs.push(Math.abs(c[k] - c[k - 1]));
  const atr = mean(diffs);
  const upper = c[i] - mult * atr; // 简化下轨
  return c[i] < upper - atr; // 收盘明显跌破下轨视为下行
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
  map: Map<string, Series>;
  benchOf: BenchOf;
  goodDates: string[];
}

/** 加载 ETF 跟踪池行情 + 基准 + 覆盖度足够的交易日轴（供每日跟踪与历史重跑共用） */
async function loadContext(): Promise<TrackContext> {
  const { pool, benchClose, dates: benchDates } = await loadPoolBars();
  const all: Series[] = [];
  const map = new Map<string, Series>();
  for (const p of pool) {
    const s: Series = {
      code: p.code,
      name: p.name,
      theme: p.theme,
      dates: p.bars.map((b) => b.d),
      closes: p.bars.map((b) => b.c),
      idx: new Map(p.bars.map((b, i) => [b.d, i])),
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
  return { all, map, benchOf, goodDates };
}

/** 一日实现收益：持有 prevHoldings 从 prevDate 到 date 的加权收益（按可得标的归一） */
function realizedReturn(
  prevHoldings: ModeHolding[],
  prevDate: string,
  date: string,
  map: Map<string, Series>,
): number {
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
  return wsum > 0 ? acc / wsum : 0;
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

/** 加载 themeFirst 引擎所需的因子序列与交易日轴（自 anchorDate 起算，保证调仓相位可复现） */
export async function loadThemeFirstContext(
  spec: ThemeFirstSpec,
): Promise<{ universe: UniverseSeries[]; dates: string[] }> {
  const { pool, benchClose, dates: benchDates } = await loadPoolBars();
  const universe: UniverseSeries[] = pool.map((p) => ({
    code: p.code,
    name: p.name,
    rows: computeRows(p.bars, benchClose),
  }));
  const dates = benchDates.filter((d) => d >= spec.anchorDate);
  if (dates.length < 2) throw new Error(`anchorDate ${spec.anchorDate} 之后无足够交易日`);
  annotateThemes(universe, dates);
  return { universe, dates };
}

/** themeFirst 的当日跟踪：从 anchorDate 全量回放，取末日切片作为今日快照 */
async function trackThemeFirst(modeId: string, spec: ThemeFirstSpec): Promise<ModeTrackResult> {
  const { universe, dates } = await loadThemeFirstContext(spec);
  const r = replayThemeFirst(spec, universe, dates);
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
  });
  clearEventsOn(modeId, last.date);
  addEvents(modeId, last.date, events);

  return { date: last.date, holdings, events, dayReturn, cumReturn, drawdown };
}

/** 跑一只 system 模式的当日跟踪并落库；返回结果（无数据/无 spec 抛错由调用方兜底） */
export async function runModeTracking(modeId: string): Promise<ModeTrackResult> {
  const spec = requireSpec(modeId);
  if (spec.kind === 'themeFirst') return trackThemeFirst(modeId, spec);
  const { all, map, benchOf, goodDates } = await loadContext();
  const today = goodDates[goodDates.length - 1];

  const holdings = holdingsAt(spec, all, today, benchOf);

  // 前向累计：取早于 today 的最近一条快照
  const prior = orderedDaily(modeId).filter((d) => d.date < today);
  const prev = prior.length ? prior[prior.length - 1] : null;
  const dayReturn = prev && prev.holdings.length ? realizedReturn(prev.holdings, prev.date, today, map) : 0;
  const cumReturn = prev ? (1 + (prev.cumReturn ?? 0)) * (1 + dayReturn) - 1 : 0;

  // 回撤：用历史 cumReturn + 今日 重建权益峰值
  const equities = [...prior.map((d) => 1 + (d.cumReturn ?? 0)), 1 + cumReturn];
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
    dayReturn: Math.round(dayReturn * 10000) / 10000,
    cumReturn: Math.round(cumReturn * 10000) / 10000,
    drawdown: Math.round(drawdown * 10000) / 10000,
  });
  clearEventsOn(modeId, today);
  addEvents(modeId, today, events);

  return { date: today, holdings, events, dayReturn, cumReturn, drawdown };
}

/** themeFirst 的历史重跑：与每日跟踪共用同一条回放路径，只是取全程指标 */
async function backtestThemeFirst(spec: ThemeFirstSpec): Promise<ResearchModeBacktestInput> {
  const { universe, dates } = await loadThemeFirstContext(spec);
  const r = replayThemeFirst(spec, universe, dates);
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
  };
}

/** 按 spec 历史重跑回测，返回可写库的指标摘要（纯 TS，不依赖 python）。收益以百分比表达，与 README 口径一致。 */
export async function runModeBacktest(modeId: string): Promise<ResearchModeBacktestInput> {
  const spec = requireSpec(modeId);
  if (spec.kind === 'themeFirst') return backtestThemeFirst(spec);
  const { all, map, benchOf, goodDates } = await loadContext();
  const axis = goodDates.slice(120); // 跳过前段，保证因子可算
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
      equity *= 1 + realizedReturn(holdings, axis[k - 1], date, map);
      peak = Math.max(peak, equity);
      maxDD = Math.min(maxDD, equity / peak - 1);
    }
    if (k - lastRebal >= spec.rebalanceDays || holdings.length === 0) {
      const next = holdingsAt(spec, all, date, benchOf);
      if (next.length) {
        const prevCodes = new Set(holdings.map((h) => h.code));
        const nextCodes = new Set(next.map((h) => h.code));
        for (const h of next) if (!prevCodes.has(h.code)) trades++;
        for (const h of holdings) if (!nextCodes.has(h.code)) trades++;
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
    poolSize: all.length,
    metrics: {
      return: pct(equity - 1),
      annualized: annualized === null ? undefined : pct(annualized),
      maxDrawdown: pct(maxDD),
      trades,
      avgPositions: spec.topN,
      maxPositions: spec.topN,
    },
    isRecommended: false,
  };
}
