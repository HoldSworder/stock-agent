import { callAstock } from '../astock/client';

// 量价因子链（TS 移植）：与 mode/etf-mainline-factor-sweep 的 python 研究脚本同源同口径，
// 供站内 system 跟踪引擎复算 mode/ 里已回测过的策略。取数走 a-stock-data sidecar 的
// mootdx_kline（与 python 同一数据源），而非 eastmoney，否则因子数值与回测对不上。
// 只移植 mainline_quality_score 这条闭合依赖链与主题层门槛所需字段，不搬整个 factor-sweep。

/** 单根日线（除权修正后） */
export interface Bar {
  d: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  amt: number;
}

/** 单标的单日因子行；字段名与 python 侧 by[d] 的键一一对应 */
export interface FactorRow {
  o: number;
  h: number;
  l: number;
  c: number;
  ma60: number;
  ma120: number;
  /** 退出规则用的均线取值表 */
  ma: Record<20 | 30 | 60 | 120, number>;
  above60: boolean;
  above120: boolean;
  mom30: number;
  mom60: number;
  volRatio20: number;
  amountRatio20: number;
  mainlinePersist: number;
  mainlineQualityScore: number;
  // ---- 主题层回填（themeFirst.ts 写入）----
  themeBreadthAbove120?: number;
  themeAmountPower?: number;
}

/** python fetch()：mootdx 日线 + 除权修正 */
export async function fetchBars(code: string): Promise<Bar[]> {
  const raw = (await callAstock('mootdx_kline', { symbol: code, category: 4, offset: 800 })) as
    | Array<Record<string, unknown>>
    | null;
  // 非有限值一律返回 null，让整根 bar 被丢弃：以前统一折成 0，一根 close=0 的坏 bar
  // 会在 adjustSplits 里算出 r=0 并把它之前的全部历史价格乘 0 清零，而 loadPoolBars
  // 只看 bars.length 不会察觉，之后 ma/ret/above60/themePower 全部失真。
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const bars: Bar[] = [];
  for (const x of raw ?? []) {
    const d = String(x.datetime ?? '').slice(0, 10);
    const o = num(x.open);
    const h = num(x.high);
    const l = num(x.low);
    const c = num(x.close);
    const v = num(x.volume);
    // 成交额是选填字段（computeRows 会用 v×c 兜底），缺了不必丢整根
    const amt = num(x.amount) ?? 0;
    if (!d || o === null || h === null || l === null || c === null || v === null) continue;
    if (!(c > 0)) continue;
    bars.push({ d, o, h, l, c, v, amt });
  }
  bars.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return adjustSplits(bars);
}

/** python adjust_splits()：用相邻收盘的异常跳变（<0.65 或 >1.5）反推复权因子，前复权 */
export function adjustSplits(bars: Bar[]): Bar[] {
  const factor = bars.map(() => 1);
  for (let i = 1; i < bars.length; i++) {
    // 两侧收盘都必须为正且比值有限为正：r 为 0 / NaN / 负数时整段历史会被乘坏，
    // 宁可跳过这一次除权推断（顶多少复权一次），也不能污染前面所有 bar
    if (!(bars[i - 1].c > 0) || !(bars[i].c > 0)) continue;
    const r = bars[i].c / bars[i - 1].c;
    if (!Number.isFinite(r) || r <= 0) continue;
    if (r < 0.65 || r > 1.5) for (let j = 0; j < i; j++) factor[j] *= r;
  }
  for (let i = 0; i < bars.length; i++) {
    const f = factor[i];
    if (f === 1) continue;
    bars[i].o *= f;
    bars[i].h *= f;
    bars[i].l *= f;
    bars[i].c *= f;
    bars[i].v = f ? bars[i].v / f : bars[i].v;
  }
  return bars;
}

/** python sma()：不足窗口时按已有长度取均值（非 NaN 前缀） */
function sma(xs: number[], n: number): number[] {
  const out: number[] = [];
  let s = 0;
  const q: number[] = [];
  for (const x of xs) {
    q.push(x);
    s += x;
    if (q.length > n) s -= q.shift() as number;
    out.push(s / q.length);
  }
  return out;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/**
 * 逐日计算因子行。bars 需已按日期升序，且只保留基准也有的交易日（与 python 对齐）。
 * benchClose 为基准（510300）日期→收盘映射。
 */
export function computeRows(bars: Bar[], benchClose: Map<string, number>): Map<string, FactorRow> {
  const closes = bars.map((b) => b.c);
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);
  const vols = bars.map((b) => b.v);
  const amounts = bars.map((b) => b.amt || b.v * b.c);
  const benchCloses = bars.map((b) => benchClose.get(b.d) ?? 0);

  const ma20 = sma(closes, 20);
  const ma30 = sma(closes, 30);
  const ma60 = sma(closes, 60);
  const ma120 = sma(closes, 120);
  const vma20 = sma(vols, 20);
  const ama20 = sma(amounts, 20);

  const trs = bars.map((b, i) => {
    const prev = i ? closes[i - 1] : b.c;
    return Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
  });
  const atr20 = sma(trs, 20);

  // 价量趋势 PVT：累计 (涨跌幅 × 成交量)
  const pvt: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    pvt.push(closes[i - 1] ? pvt[i - 1] + (closes[i] / closes[i - 1] - 1) * vols[i] : pvt[i - 1]);
  }

  const rows = new Map<string, FactorRow>();
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const ret = (n: number): number =>
      i >= n && closes[i - n] ? closes[i] / closes[i - n] - 1 : 0;
    const bret = (n: number): number =>
      i >= n && benchCloses[i - n] ? benchCloses[i] / benchCloses[i - n] - 1 : 0;
    const rs = benchCloses[i] ? closes[i] / benchCloses[i] : 0;
    const rsret = (n: number): number => {
      if (i < n) return 0;
      const prevBench = benchCloses[i - n];
      const prevRs = prevBench ? closes[i - n] / prevBench : 0;
      return prevRs ? rs / prevRs - 1 : 0;
    };
    /** 对基准回归得到的超额收益：ret(n) - beta·bret(n) */
    const alphaOf = (n: number): number => {
      if (i < n) return 0;
      const asset: number[] = [];
      const bench: number[] = [];
      // 两侧都有效才成对入列：分别 push 会在某侧缺值时错位，slice(-m) 把不同日期的收益率配成对算协方差
      for (let j = i - n + 1; j <= i; j++) {
        if (!closes[j - 1] || !benchCloses[j - 1]) continue;
        asset.push(closes[j] / closes[j - 1] - 1);
        bench.push(benchCloses[j] / benchCloses[j - 1] - 1);
      }
      const m = asset.length;
      if (m < 2) return ret(n) - bret(n);
      const a = asset;
      const bn = bench;
      const ma = sum(a) / m;
      const mb = sum(bn) / m;
      let cov = 0;
      let varB = 0;
      for (let k = 0; k < m; k++) {
        cov += (a[k] - ma) * (bn[k] - mb);
        varB += (bn[k] - mb) ** 2;
      }
      cov /= m - 1;
      varB /= m - 1;
      const beta = varB ? cov / varB : 1;
      return ret(n) - beta * bret(n);
    };

    const slope2060 = ma60[i] ? ma20[i] / ma60[i] - 1 : 0;
    const distMa60 = ma60[i] ? b.c / ma60[i] - 1 : 0;
    const atrPct = b.c ? atr20[i] / b.c : 0;
    const gapPct = i && closes[i - 1] ? b.o / closes[i - 1] - 1 : 0;
    const bodyPct = b.o ? (b.c - b.o) / b.o : 0;
    const upperShadowPct = b.c ? (b.h - Math.max(b.o, b.c)) / b.c : 0;
    const lowerShadowPct = b.c ? (Math.min(b.o, b.c) - b.l) / b.c : 0;
    const obvBase20 = sum(vols.slice(Math.max(0, i - 19), i + 1)) || 1;
    const pvtSlope20 = i >= 20 ? (pvt[i] - pvt[i - 20]) / obvBase20 : 0;

    // mom30_trend_quality_smooth 及其派生（py 461 / 568 / 504 / 531+535 / 522）
    const smooth =
      ret(30) + 0.15 * Math.max(0, slope2060) + 0.15 * Math.max(0, distMa60) - 0.15 * atrPct;
    const pvtConfirm = smooth + 0.1 * pvtSlope20;
    const gapMomentum =
      smooth +
      0.08 * Math.max(0, gapPct) +
      0.05 * Math.max(0, bodyPct) -
      0.08 * Math.max(0, upperShadowPct - lowerShadowPct);
    const rs30TrendQuality =
      rsret(30) + 0.15 * Math.max(0, slope2060) + 0.1 * Math.max(0, distMa60) - 0.15 * atrPct;
    const momRsQuality = 0.55 * smooth + 0.45 * rs30TrendQuality;
    const alphaTrendQuality =
      alphaOf(30) + 0.15 * Math.max(0, slope2060) + 0.1 * Math.max(0, distMa60) - 0.15 * atrPct;

    rows.set(b.d, {
      o: b.o,
      h: b.h,
      l: b.l,
      c: b.c,
      ma60: ma60[i],
      ma120: ma120[i],
      ma: { 20: ma20[i], 30: ma30[i], 60: ma60[i], 120: ma120[i] },
      above60: b.c > ma60[i],
      above120: b.c > ma120[i],
      mom30: ret(30),
      mom60: ret(60),
      volRatio20: vma20[i] ? b.v / vma20[i] : 1,
      amountRatio20: ama20[i] ? amounts[i] / ama20[i] : 1,
      // py 713-718
      mainlinePersist:
        0.4 * ret(60) +
        0.25 * ret(90) +
        0.2 * Math.max(0, slope2060) +
        0.15 * Math.max(0, ma120[i] ? b.c / ma120[i] - 1 : 0),
      // py 747-753
      mainlineQualityScore:
        0.5 * smooth + 0.18 * pvtConfirm + 0.14 * gapMomentum + 0.1 * momRsQuality + 0.08 * alphaTrendQuality,
    });
  }
  return rows;
}

/**
 * 已移植的打分因子白名单：spec 的 themeKey/leaderKey 只能取这些键。
 * 用 Map 而非普通对象：key 来自外部 spec，普通对象上 'constructor'/'toString' 会命中原型链上的函数，
 * 绕过下面「未实现的因子直接抛错」的保护。
 */
const SCORE_KEYS = new Map<string, (r: FactorRow) => number>([
  ['mainline_quality_score', (r) => r.mainlineQualityScore],
  ['mainline_persist', (r) => r.mainlinePersist],
  ['mom30', (r) => r.mom30],
  ['mom60', (r) => r.mom60],
]);

/** 按因子名取值；未移植的因子名直接抛错，避免静默按 0 处理 */
export function scoreOf(row: FactorRow, key: string): number {
  const f = SCORE_KEYS.get(key);
  if (!f) throw new Error(`站内引擎未实现因子 ${key}（已支持：${[...SCORE_KEYS.keys()].join(' / ')}）`);
  return f(row);
}
