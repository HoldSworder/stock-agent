import { MACD, EMA, RSI, BollingerBands } from 'trading-signals';
import { kdjTongdaxin } from './kdj';
import type {
  KlineBar,
  KlinePeriod,
  StockIndicators,
  MacdReadout,
  KdjReadout,
  RsiReadout,
  BollReadout,
} from '@stock-agent/shared';
import { buildVolumeReadout } from '../symbolPlans/volumePrice';
import { isAShareTradingTime } from '../util';
import { getKline, getQuotes } from './eastmoney';

// S9 技术指标库：用 trading-signals（MIT，已用于 ATR）从日线衍生 MACD/KDJ/RSI/BOLL + 读数。
// 纯确定性、不自造算法轮子；读数（金叉/超买等）为规则化判断，不含主观预测。

/** 计算需要的最少日线根数（BOLL20/RSI24/MACD26 等取最大 + 余量） */
const MIN_BARS = 35;
const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * MACD 序列上的一个点。
 *
 * `index` 是它对应输入数组的下标，**必须带着走**：MACD 前二十几根未成型（EMA26 要凑够样本），
 * 所以序列长度短于输入，按序列自身下标去对齐 K 线会整体错位。
 * 背驰要按缠论笔切段比对柱面积，段的起止是 K 线下标，对齐错一根结论就变了。
 */
export interface MacdPoint {
  /** 对应输入 closes 的下标 */
  index: number;
  dif: number;
  dea: number;
  /** CN 口径柱值 =（DIF − DEA）× 2，与国内看盘软件一致 */
  bar: number;
}

/**
 * MACD（12,26,9）完整序列。
 *
 * 与 calcMacd 的分工：本函数给全序列（背驰要算柱面积），calcMacd 只取末两根算读数。
 * 两者共用这一份计算，避免出现第二份 MACD 实现——参数或口径要改时只改一处。
 */
export function calcMacdSeries(closes: number[]): MacdPoint[] {
  const macd = new MACD(new EMA(12), new EMA(26), new EMA(9));
  const out: MacdPoint[] = [];
  closes.forEach((c, i) => {
    const res = macd.add(c) as { macd: number; signal: number; histogram: number } | null;
    if (!res) return;
    out.push({ index: i, dif: res.macd, dea: res.signal, bar: (res.macd - res.signal) * 2 });
  });
  return out;
}

/** MACD（12,26,9）末根读数：金叉/死叉判断（CN 口径 DIF/DEA/MACD柱） */
export function calcMacd(closes: number[]): MacdReadout | null {
  const series = calcMacdSeries(closes);
  const last = series[series.length - 1];
  if (!last) return null;
  const prev = series[series.length - 2];
  const diff = last.dif - last.dea;
  const prevDiff = prev ? prev.dif - prev.dea : null;
  let state: MacdReadout['state'];
  if (prevDiff != null && prevDiff <= 0 && diff > 0) state = '金叉';
  else if (prevDiff != null && prevDiff >= 0 && diff < 0) state = '死叉';
  else state = diff >= 0 ? '多头' : '空头';
  return { dif: r2(last.dif), dea: r2(last.dea), bar: r2(last.bar), state };
}

/** RSI 6/12/24 */
function calcRsi(closes: number[]): RsiReadout | null {
  const mk = (n: number): number | null => {
    const rsi = new RSI(n);
    let v: number | null = null;
    for (const c of closes) {
      const res = rsi.add(c) as number | null;
      if (res != null) v = Number(res);
    }
    return v;
  };
  const rsi6 = mk(6);
  const rsi12 = mk(12);
  const rsi24 = mk(24);
  if (rsi6 == null || rsi12 == null || rsi24 == null) return null;
  const signal = rsi6 > 80 ? '超买' : rsi6 < 20 ? '超卖' : '中性';
  return { rsi6: r2(rsi6), rsi12: r2(rsi12), rsi24: r2(rsi24), signal };
}

/** KDJ（通达信 9,3,3）。与战法同一数列，80 是同一个数。 */
function calcKdj(bars: KlineBar[]): KdjReadout | null {
  const series = kdjTongdaxin(bars);
  const last = [...series].reverse().find((p) => p != null);
  if (!last) return null;
  const signal = last.k > 80 ? '超买' : last.k < 20 ? '超卖' : '中性';
  return { k: r2(last.k), d: r2(last.d), j: r2(last.j), signal };
}

/** BOLL（20,2）+ %B + 价格相对带位置 */
function calcBoll(closes: number[]): BollReadout | null {
  const boll = new BollingerBands(20, 2);
  let last: { upper: number; middle: number; lower: number } | null = null;
  for (const c of closes) {
    const res = boll.add(c) as { upper: number; middle: number; lower: number } | null;
    if (res) last = res;
  }
  if (!last) return null;
  const upper = Number(last.upper);
  const middle = Number(last.middle);
  const lower = Number(last.lower);
  const close = closes[closes.length - 1];
  const width = upper - lower;
  const pctB = width > 0 ? (close - lower) / width : 0.5;
  let pos: BollReadout['pos'];
  if (close > upper) pos = '上轨上方';
  else if (close >= middle) pos = '中上轨';
  else if (close >= lower) pos = '中下轨';
  else pos = '下轨下方';
  return { upper: r2(upper), mid: r2(middle), lower: r2(lower), pctB: r2(pctB), pos };
}

/**
 * 从日线 bars 计算 MACD/KDJ/RSI/BOLL 全套读数（数据不足返回 null 段，never throw）。
 *
 * `opts.completeBar` 默认为 true：同步调用方喂的都是历史完整日线。
 * 只有实时链路（getStockIndicators）在盘中才需要显式传 false 并附上实时量比。
 */
export function computeIndicators(
  code: string,
  bars: KlineBar[],
  period: KlinePeriod = 'day',
  opts: { completeBar?: boolean; realtimeVolumeRatio?: number | null; turnoverRate?: number | null } = {},
): StockIndicators {
  const closes = bars.map((b) => b.close);
  const last = bars[bars.length - 1];
  const enough = bars.length >= MIN_BARS;
  const macd = enough ? calcMacd(closes) : null;
  const kdj = enough ? calcKdj(bars) : null;
  const rsi = enough ? calcRsi(closes) : null;
  const boll = enough ? calcBoll(closes) : null;
  // 量能读数的两套口径（20 日成交额中位数、东财实时量比）都是按日线标定的，
  // 换成周/月线就会拿「20 周中位数」冒充「20 日」，宁可不给
  const volume =
    period === 'day'
      ? buildVolumeReadout(bars, {
          completeBar: opts.completeBar !== false,
          realtimeRatio: opts.realtimeVolumeRatio ?? null,
          turnoverRate: opts.turnoverRate ?? null,
        })
      : null;
  return {
    code,
    asOf: last?.time ?? '',
    close: last?.close ?? 0,
    period,
    macd,
    kdj,
    rsi,
    boll,
    volume,
    note: enough ? '日线技术指标（规则化读数）' : '日线数据不足，指标暂不可用',
  };
}

/**
 * 取个股日线并计算技术指标（默认 60 根日线）。
 * 盘中日 K 未收完，额外拉一次实时报价取量比，让「是否放量」在盘中也有可比读数。
 */
export async function getStockIndicators(
  code: string,
  signal?: AbortSignal,
): Promise<StockIndicators> {
  void signal;
  const completeBar = !isAShareTradingTime();
  const [bars, quote] = await Promise.all([
    getKline(code, 'day', 60).catch(() => [] as KlineBar[]),
    completeBar
      ? Promise.resolve(null)
      : getQuotes([code])
          .then((qs) => qs[0] ?? null)
          .catch(() => null),
  ]);
  return computeIndicators(code, bars, 'day', {
    completeBar,
    realtimeVolumeRatio: quote?.volumeRatio ?? null,
    turnoverRate: quote?.turnoverRate ?? null,
  });
}

/** 技术指标文本（注入技术分析师 / agent 的确定性底稿） */
export function formatIndicatorsForAgent(ind: StockIndicators): string {
  const lines: string[] = [`技术指标（${ind.asOf || '—'}，日线，收盘 ${ind.close}）`];
  if (ind.macd) {
    lines.push(
      `MACD：DIF ${ind.macd.dif} / DEA ${ind.macd.dea} / 柱 ${ind.macd.bar}（${ind.macd.state}）`,
    );
  }
  if (ind.kdj) {
    lines.push(`KDJ：K ${ind.kdj.k} / D ${ind.kdj.d} / J ${ind.kdj.j}（${ind.kdj.signal}）`);
  }
  if (ind.rsi) {
    lines.push(
      `RSI：6日 ${ind.rsi.rsi6} / 12日 ${ind.rsi.rsi12} / 24日 ${ind.rsi.rsi24}（${ind.rsi.signal}）`,
    );
  }
  if (ind.boll) {
    lines.push(
      `BOLL：上 ${ind.boll.upper} / 中 ${ind.boll.mid} / 下 ${ind.boll.lower}，%B ${ind.boll.pctB}（${ind.boll.pos}）`,
    );
  }
  if (ind.volume) {
    const BASIS_TEXT: Record<typeof ind.volume.basis, string> = {
      realtime: '盘中实时量比',
      amount_median20: '当日成交额/前20日中位数',
      volume_median20: '当日成交量/前20日中位数（该源无成交额）',
    };
    const basis = BASIS_TEXT[ind.volume.basis];
    const turnover = ind.volume.turnoverRate != null ? `，换手 ${ind.volume.turnoverRate}%` : '';
    lines.push(`量能：${ind.volume.ratio} 倍（${ind.volume.label}，${basis}）${turnover}`);
  }
  if (lines.length === 1) lines.push(ind.note);
  return lines.join('\n');
}
