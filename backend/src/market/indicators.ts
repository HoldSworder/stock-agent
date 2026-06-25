import { MACD, EMA, RSI, BollingerBands, StochasticOscillator } from 'trading-signals';
import type {
  KlineBar,
  KlinePeriod,
  StockIndicators,
  MacdReadout,
  KdjReadout,
  RsiReadout,
  BollReadout,
} from '@stock-agent/shared';
import { getKline } from './eastmoney';

// S9 技术指标库：用 trading-signals（MIT，已用于 ATR）从日线衍生 MACD/KDJ/RSI/BOLL + 读数。
// 纯确定性、不自造算法轮子；读数（金叉/超买等）为规则化判断，不含主观预测。

/** 计算需要的最少日线根数（BOLL20/RSI24/MACD26 等取最大 + 余量） */
const MIN_BARS = 35;
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** MACD（12,26,9）：迭代喂收盘，捕获末两根用于金叉/死叉判断（CN 口径 DIF/DEA/MACD柱） */
export function calcMacd(closes: number[]): MacdReadout | null {
  const macd = new MACD(new EMA(12), new EMA(26), new EMA(9));
  let prevDiff: number | null = null;
  let last: { dif: number; dea: number } | null = null;
  let prevHistDiff: number | null = null;
  for (const c of closes) {
    const res = macd.add(c) as { macd: number; signal: number; histogram: number } | null;
    if (!res) continue;
    if (last) prevDiff = prevHistDiff;
    prevHistDiff = res.macd - res.signal;
    last = { dif: res.macd, dea: res.signal };
  }
  if (!last) return null;
  const diff = last.dif - last.dea;
  let state: MacdReadout['state'];
  if (prevDiff != null && prevDiff <= 0 && diff > 0) state = '金叉';
  else if (prevDiff != null && prevDiff >= 0 && diff < 0) state = '死叉';
  else state = diff >= 0 ? '多头' : '空头';
  return { dif: r2(last.dif), dea: r2(last.dea), bar: r2(diff * 2), state };
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

/** KDJ（9,3,3）：基于随机指标 %K/%D，J=3K-2D */
function calcKdj(bars: KlineBar[]): KdjReadout | null {
  const stoch = new StochasticOscillator(9, 3, 3);
  let last: { stochK: number; stochD: number } | null = null;
  for (const b of bars) {
    const res = stoch.add({ high: b.high, low: b.low, close: b.close }) as
      | { stochK: number; stochD: number }
      | null;
    if (res) last = res;
  }
  if (!last) return null;
  const k = Number(last.stochK);
  const d = Number(last.stochD);
  const j = 3 * k - 2 * d;
  const signal = k > 80 ? '超买' : k < 20 ? '超卖' : '中性';
  return { k: r2(k), d: r2(d), j: r2(j), signal };
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

/** 从日线 bars 计算 MACD/KDJ/RSI/BOLL 全套读数（数据不足返回 null 段，never throw） */
export function computeIndicators(
  code: string,
  bars: KlineBar[],
  period: KlinePeriod = 'day',
): StockIndicators {
  const closes = bars.map((b) => b.close);
  const last = bars[bars.length - 1];
  const enough = bars.length >= MIN_BARS;
  const macd = enough ? calcMacd(closes) : null;
  const kdj = enough ? calcKdj(bars) : null;
  const rsi = enough ? calcRsi(closes) : null;
  const boll = enough ? calcBoll(closes) : null;
  return {
    code,
    asOf: last?.time ?? '',
    close: last?.close ?? 0,
    period,
    macd,
    kdj,
    rsi,
    boll,
    note: enough ? '日线技术指标（规则化读数）' : '日线数据不足，指标暂不可用',
  };
}

/** 取个股日线并计算技术指标（默认 60 根日线） */
export async function getStockIndicators(
  code: string,
  signal?: AbortSignal,
): Promise<StockIndicators> {
  void signal;
  const bars = await getKline(code, 'day', 60).catch(() => [] as KlineBar[]);
  return computeIndicators(code, bars, 'day');
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
  if (lines.length === 1) lines.push(ind.note);
  return lines.join('\n');
}
