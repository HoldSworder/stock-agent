import type { ScreenFactorKey } from '@stock-agent/shared';
import { getKline, getStockFundFlow } from '../market/eastmoney';
import type { ExtraFactorScores } from './scorer';

// 趋势 / 资金流因子（逐只历史，仅对已收窄的候选池调用，控制取数量）：
//  - trend：日K 衍生的多头排列(MA5/10/20)、距 20 日新高位置、近 5 日量能放大，反映右侧/起爆前形态。
//  - fundFlow：主力净流入的「持续性」（近 5 日净流入天数）与当日主力占比，反映资金面是否在持续吸筹。
// 仅 pre_breakout_catalyst 等显式启用这两个因子的策略才会触发，避免对全市场逐只取 K 线。

/** 单只候选的并发取数上限（控制对东财的瞬时压力） */
const FETCH_CONCURRENCY = 8;
/** 取多少日 K 线（>20 以算 MA20 与 20 日新高） */
const KLINE_DAYS = 25;
/** 取多少日资金流（算近 5 日净流入持续性 + 当日占比） */
const FUNDFLOW_DAYS = 6;
/** 中线趋势取多少根周 K（>60 以算周线 MA60，近 1.5 年） */
const WEEK_BARS = 80;

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

/** 由近端 K 线算趋势分 0-100（多头排列 + 距 20 日新高 + 量能放大） */
async function trendScore(code: string): Promise<number | null> {
  const bars = await getKline(code, 'day', KLINE_DAYS).catch(() => []);
  if (bars.length < 20) return null;
  const closes = bars.map((b) => b.close).filter((c) => c > 0);
  const highs = bars.map((b) => b.high).filter((h) => h > 0);
  const vols = bars.map((b) => b.volume).filter((v) => v > 0);
  if (closes.length < 20) return null;

  const last = closes[closes.length - 1];
  const ma = (n: number) => mean(closes.slice(-n));
  const ma5 = ma(5);
  const ma10 = ma(10);
  const ma20 = ma(20);

  // ① 多头排列：close>ma5>ma10>ma20 满足越多分越高（每档 25 分）
  let maScore = 0;
  if (last > ma5) maScore += 25;
  if (ma5 > ma10) maScore += 25;
  if (ma10 > ma20) maScore += 25;
  if (last > ma20) maScore += 25;

  // ② 距 20 日新高位置：越接近新高越高（0.9→50 分，1.0→100 分）
  const high20 = Math.max(...highs.slice(-20));
  const proximity = high20 > 0 ? last / high20 : 0;
  const highScore = clamp((proximity - 0.8) / 0.2 * 100); // 0.8 以下记 0，1.0 满分

  // ③ 量能放大：最新量 / 近 5 日均量（不含最新），理想 1.5-2.5 倍
  const recentVol = vols[vols.length - 1] ?? 0;
  const baseVol = mean(vols.slice(-6, -1));
  const ratio = baseVol > 0 ? recentVol / baseVol : 1;
  const volScore = ratio <= 1 ? clamp(ratio * 40) : clamp(40 + (ratio - 1) * 40);

  return clamp(Math.round(maScore * 0.5 + highScore * 0.3 + volScore * 0.2));
}

/**
 * 由周 K 算中线趋势分 0-100（中线「月线定方向、周线找买点」的规则化代理）：
 *  ① 周线多头排列：close>MA10>MA20>MA60（每档 20 分，共 80 分）——月线级别多头方向。
 *  ② 周线 MA10 上穿 MA20（近 3 周内金叉）：右侧确认买点，加 20 分。
 * 缺数据（不足 60 周）返回 null，由 scorer 记中性 50。
 */
async function midTrendScore(code: string): Promise<number | null> {
  const bars = await getKline(code, 'week', WEEK_BARS).catch(() => []);
  const closes = bars.map((b) => b.close).filter((c) => c > 0);
  if (closes.length < 60) return null;

  const last = closes[closes.length - 1];
  const wma = (n: number) => mean(closes.slice(-n));
  const ma10 = wma(10);
  const ma20 = wma(20);
  const ma60 = wma(60);

  // ① 周线多头排列（月线定方向）
  let score = 0;
  if (last > ma10) score += 20;
  if (ma10 > ma20) score += 20;
  if (ma20 > ma60) score += 20;
  if (last > ma60) score += 20;

  // ② 近 3 周内 MA10 上穿 MA20（周线金叉，右侧确认）
  const ma10Prev = mean(closes.slice(-13, -3));
  const ma20Prev = mean(closes.slice(-23, -3));
  if (ma10 > ma20 && ma10Prev <= ma20Prev) score += 20;

  return clamp(Math.round(score));
}

/** 由近 5 日主力资金流算资金面持续性分 0-100（净流入天数 + 当日主力占比） */
async function fundFlowScore(code: string): Promise<number | null> {
  const flow = await getStockFundFlow(code, FUNDFLOW_DAYS).catch(() => []);
  if (flow.length === 0) return null;
  const last5 = flow.slice(-5);
  // ① 近 5 日主力净流入为正的天数占比（持续性）
  const inflowDays = last5.filter((d) => d.main > 0).length;
  const continuity = (inflowDays / Math.max(1, last5.length)) * 100;
  // ② 当日主力占比（mainPct，-100~100），映射到 0-100
  const latest = flow[flow.length - 1];
  const pctScore = clamp(50 + latest.mainPct * 2);
  return clamp(Math.round(continuity * 0.6 + pctScore * 0.4));
}

/** 简单分批并发，避免一次性打爆东财接口 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}

/**
 * 为候选 code 列表补逐只历史因子分（限量取 K 线 / 资金流）。
 * 仅计算 `needed` 中声明的因子（trend 日线趋势 / fundFlow 资金流 / midTrend 周线中线趋势），
 * 避免短线策略多取一次周 K。best-effort：单只取数失败该因子缺省（scorer 记中性 50），不阻断选股。
 */
export async function enrichTrendFactors(
  codes: string[],
  needed: ScreenFactorKey[] = ['trend', 'fundFlow'],
): Promise<ExtraFactorScores> {
  const want = new Set(needed);
  const map: ExtraFactorScores = new Map();
  await mapWithConcurrency(codes, FETCH_CONCURRENCY, async (code) => {
    const [trend, fundFlow, midTrend] = await Promise.all([
      want.has('trend') ? trendScore(code) : Promise.resolve(null),
      want.has('fundFlow') ? fundFlowScore(code) : Promise.resolve(null),
      want.has('midTrend') ? midTrendScore(code) : Promise.resolve(null),
    ]);
    const entry: Partial<Record<ScreenFactorKey, number>> = {};
    if (trend != null) entry.trend = trend;
    if (fundFlow != null) entry.fundFlow = fundFlow;
    if (midTrend != null) entry.midTrend = midTrend;
    if (Object.keys(entry).length > 0) map.set(code, entry);
  });
  return map;
}
