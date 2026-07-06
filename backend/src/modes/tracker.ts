import type {
  ModeExit,
  ModeHolding,
  ModeSignalAction,
  ModeSpec,
  ModeTrackResult,
  ResearchModeBacktestInput,
} from '@stock-agent/shared';
import { getKline } from '../market/eastmoney';
import { listUniverse } from './universeRepo';
import { addEvents, clearEventsOn, getMode, orderedDaily, upsertDaily } from './repo';

// 站内声明式跟踪引擎（trackingMode=system）：纯 TS、纯只读取数（getKline），不下单、不调 python。
// 给定模式 spec + 研究标的库，按横截面加权 z-score 选 TopN（可主题去重 + 退出规则过滤），
// 每个交易日算出当日应持仓、与上一快照比对生成 enter/exit 事件，并按关注以来累计收益/回撤前向跟踪。
// 仅支持站内可计算因子白名单（rs/动量/趋势质量/横截面排名）；白名单外策略走 external 推送。

const BENCH = { code: '000300', secid: '1.000300' };
const HISTORY = 320;

interface Series {
  code: string;
  name: string;
  theme: string;
  dates: string[];
  closes: number[];
  idx: Map<string, number>;
}

async function loadSeries(code: string, secid?: string): Promise<{ dates: string[]; closes: number[] } | null> {
  try {
    const bars = await getKline(code, 'day', HISTORY, secid);
    const dates: string[] = [];
    const closes: number[] = [];
    for (const b of bars) {
      if (Number.isFinite(b.close) && b.close > 0) {
        dates.push(b.time);
        closes.push(b.close);
      }
    }
    return dates.length ? { dates, closes } : null;
  } catch {
    return null;
  }
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
function holdingsAt(spec: ModeSpec, all: Series[], date: string, benchOf: BenchOf): ModeHolding[] {
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

/** 加载研究标的库行情 + 基准 + 覆盖度足够的交易日轴（供每日跟踪与历史重跑共用） */
async function loadContext(): Promise<TrackContext> {
  const universe = listUniverse();
  if (!universe.length) throw new Error('研究标的库为空，无法跟踪');
  const all: Series[] = [];
  const map = new Map<string, Series>();
  for (const u of universe) {
    const ser = await loadSeries(u.code);
    if (!ser) continue;
    const s: Series = {
      code: u.code,
      name: u.name,
      theme: (u.tags ?? '').split(',')[0] || u.code,
      dates: ser.dates,
      closes: ser.closes,
      idx: new Map(ser.dates.map((d, i) => [d, i])),
    };
    all.push(s);
    map.set(s.code, s);
  }
  if (!all.length) throw new Error('标的行情全部取数失败');

  const benchSer = await loadSeries(BENCH.code, BENCH.secid);
  const benchIdx = benchSer ? new Map(benchSer.dates.map((d, i) => [d, i])) : new Map<string, number>();
  const benchOf: BenchOf = (date) => (n) => {
    if (!benchSer) return null;
    const i = benchIdx.get(date);
    if (i === undefined || i - n < 0 || benchSer.closes[i - n] <= 0) return null;
    return benchSer.closes[i] / benchSer.closes[i - n] - 1;
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

/** 跑一只 system 模式的当日跟踪并落库；返回结果（无数据/无 spec 抛错由调用方兜底） */
export async function runModeTracking(modeId: string): Promise<ModeTrackResult> {
  const mode = getMode(modeId);
  if (!mode) throw new Error(`模式不存在：${modeId}`);
  if (mode.trackingMode !== 'system' || !mode.spec) {
    throw new Error(`模式 ${modeId} 非 system 跟踪或缺少 spec`);
  }
  const spec = mode.spec;
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

/** 按 spec 历史重跑回测，返回可写库的指标摘要（纯 TS，不依赖 python）。收益以百分比表达，与 README 口径一致。 */
export async function runModeBacktest(modeId: string): Promise<ResearchModeBacktestInput> {
  const mode = getMode(modeId);
  if (!mode) throw new Error(`模式不存在：${modeId}`);
  if (mode.trackingMode !== 'system' || !mode.spec) throw new Error(`模式 ${modeId} 非 system 跟踪或缺少 spec`);
  const spec = mode.spec;
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
