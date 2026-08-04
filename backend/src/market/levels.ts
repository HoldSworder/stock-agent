import { ATR } from 'trading-signals';
import type {
  KlineBar,
  KlinePeriod,
  PriceLevels,
  FibLevel,
  SwingRange,
  PivotLevels,
  MaStructure,
} from '@stock-agent/shared';

// S10 点位测算库：从 K 线用确定性算法衍生「专业点位」——主导波段（摆动高低点）、
// 斐波那契回撤/扩展、ATR(14)、经典枢轴点、多周期均线结构。喂「多周期走势研判」agent，
// 补齐系统原本只有 MACD/KDJ/RSI/BOLL、缺乏支撑压力位/斐波那契的短板。
// 纯确定性、不造轮子（ATR 复用 trading-signals），读数为规则化判断、不含主观预测。

/** 摆动高低点回看窗口（取最近 N 根定主导波段），周期越大 N 越小即可覆盖更长时间。 */
const SWING_WINDOW = 60;
/** 计算 ATR(14) 所需最少根数（14 周期 + 余量） */
const MIN_ATR_BARS = 15;
/** 均线周期集合（数据充足才计算对应周期） */
const MA_PERIODS = [5, 10, 20, 60, 120, 250] as const;
/** 斐波那契回撤比例（波段内） */
const FIB_RETRACE = [0.236, 0.382, 0.5, 0.618, 0.786] as const;
/** 斐波那契扩展比例（顺势目标位） */
const FIB_EXTEND = [1.272, 1.618] as const;

const r2 = (n: number): number => Math.round(n * 100) / 100;
/**
 * ATR 专用精度。两位小数对低价标的（0.6 元的 ETF、低价股）相当于把波动量化掉 10%~25%，
 * 极低波动时甚至舍成 0，而聚类容差与风险距离都直接吃这个值，误差会一路传下去。
 */
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const pct = (r: number): string => `${r2(r * 100)}%`;

/**
 * 识别主导波段：取窗口内最高高点与最低低点，按二者出现先后定方向。
 * ponytail: 用「最高/最低 + 时间先后」的简单波段，够用于点位测算；
 * 若后续要更贴合结构性回调可升级为 ZigZag。
 */
function detectSwing(bars: KlineBar[]): SwingRange | null {
  if (bars.length < 2) return null;
  const win = bars.slice(-SWING_WINDOW);
  let hi = win[0];
  let lo = win[0];
  let hiIdx = 0;
  let loIdx = 0;
  win.forEach((b, i) => {
    if (b.high >= hi.high) {
      hi = b;
      hiIdx = i;
    }
    if (b.low <= lo.low) {
      lo = b;
      loIdx = i;
    }
  });
  if (hi.high <= lo.low) return null;
  // 低点在前=上行波段（回撤看支撑）；高点在前=下行波段（回撤看压力）
  const direction: SwingRange['direction'] = loIdx <= hiIdx ? 'up' : 'down';
  return {
    direction,
    high: r2(hi.high),
    low: r2(lo.low),
    highTime: hi.time,
    lowTime: lo.time,
  };
}

/** 据主导波段算斐波那契回撤位 */
function calcFibRetracements(swing: SwingRange): FibLevel[] {
  const range = swing.high - swing.low;
  return FIB_RETRACE.map((r) => ({
    ratio: pct(r),
    // 上行波段：从高点向下回撤；下行波段：从低点向上反弹
    price: r2(swing.direction === 'up' ? swing.high - range * r : swing.low + range * r),
  }));
}

/** 据主导波段算斐波那契扩展位（顺势目标，超出波段区间） */
function calcFibExtensions(swing: SwingRange): FibLevel[] {
  const range = swing.high - swing.low;
  return FIB_EXTEND.map((r) => ({
    ratio: pct(r),
    // 上行波段：低点上方 range×比例（目标向上）；下行波段：高点下方（目标向下）
    price: r2(swing.direction === 'up' ? swing.low + range * r : swing.high - range * r),
  }));
}

/** ATR(14) 绝对值（复用 trading-signals），数据不足返回 null */
function calcAtr(bars: KlineBar[]): number | null {
  if (bars.length < MIN_ATR_BARS) return null;
  const atr = new ATR(14);
  for (const b of bars) atr.add({ high: b.high, low: b.low, close: b.close });
  const res = atr.getResult();
  return res == null ? null : Number(res);
}

/** 经典枢轴点（据上一根 H/L/C） */
function calcPivot(bars: KlineBar[]): PivotLevels | null {
  const last = bars[bars.length - 1];
  if (!last) return null;
  const { high: h, low: l, close: c } = last;
  const pp = (h + l + c) / 3;
  return {
    pp: r2(pp),
    r1: r2(2 * pp - l),
    s1: r2(2 * pp - h),
    r2: r2(pp + (h - l)),
    s2: r2(pp - (h - l)),
    r3: r2(h + 2 * (pp - l)),
    s3: r2(l - 2 * (h - pp)),
  };
}

/** 简单移动平均（末 n 根收盘） */
function sma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  const slice = closes.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

/** 多周期均线结构 + 排列判定 + 最近支撑/压力均线 */
function calcMaStructure(closes: number[], close: number): MaStructure | null {
  const values: Array<{ period: number; value: number }> = [];
  for (const period of MA_PERIODS) {
    const v = sma(closes, period);
    if (v != null) values.push({ period, value: r2(v) });
  }
  if (values.length === 0) return null;
  // 排列：按周期升序，若均线值严格递减=多头，严格递增=空头，否则纠缠
  const byPeriod = [...values].sort((a, b) => a.period - b.period);
  let desc = true;
  let asc = true;
  for (let i = 1; i < byPeriod.length; i++) {
    if (byPeriod[i].value >= byPeriod[i - 1].value) desc = false;
    if (byPeriod[i].value <= byPeriod[i - 1].value) asc = false;
  }
  const alignment: MaStructure['alignment'] =
    byPeriod.length >= 2 && desc ? '多头排列' : byPeriod.length >= 2 && asc ? '空头排列' : '纠缠';
  // 最近上方压力均线（>现价里最小）/ 下方支撑均线（<现价里最大）
  const above = values.filter((v) => v.value > close).sort((a, b) => a.value - b.value);
  const below = values.filter((v) => v.value < close).sort((a, b) => b.value - a.value);
  return {
    values: byPeriod,
    alignment,
    resistanceMa: above[0] ?? null,
    supportMa: below[0] ?? null,
  };
}

/** 从 K 线 bars 计算全套点位（数据不足返回 null 段，never throw） */
export function computeLevels(
  code: string,
  bars: KlineBar[],
  period: KlinePeriod = 'day',
): PriceLevels {
  const last = bars[bars.length - 1];
  const closes = bars.map((b) => b.close);
  const close = last?.close ?? 0;
  const swing = detectSwing(bars);
  const atr = calcAtr(bars);
  return {
    code,
    asOf: last?.time ?? '',
    close: r2(close),
    period,
    swing,
    fibRetracements: swing ? calcFibRetracements(swing) : [],
    fibExtensions: swing ? calcFibExtensions(swing) : [],
    atr: atr == null ? null : r3(atr),
    atrPct: atr == null || close <= 0 ? null : r2((atr / close) * 100),
    pivot: calcPivot(bars),
    ma: calcMaStructure(closes, close),
    note: bars.length < MIN_ATR_BARS ? 'K 线数据不足，部分点位不可用' : '确定性点位测算（斐波那契/枢轴/均线/ATR）',
  };
}

/**
 * 取标的 K 线并计算点位。支持个股(6位)/板块(BKxxxx 自动解析)/大盘指数(显式 secid)。
 * 默认取 260 根以覆盖 MA250。
 */
export async function getPriceLevels(
  code: string,
  period: KlinePeriod = 'day',
  secid?: string,
): Promise<PriceLevels> {
  // 惰性导入：保持本模块纯算法可独立自检，取数（及其 db 依赖链）仅在实际拉线时加载
  const { getKline } = await import('./eastmoney');
  const bars = await getKline(code, period, 260, secid).catch(() => [] as KlineBar[]);
  return computeLevels(code, bars, period);
}

/** 点位文本（注入走势研判 / 技术分析师 agent 的确定性底稿） */
export function formatLevelsForAgent(lv: PriceLevels): string {
  const periodLabel: Record<string, string> = {
    day: '日线',
    week: '周线',
    month: '月线',
    '5m': '5分钟',
    '15m': '15分钟',
    '30m': '30分钟',
    '60m': '60分钟',
    '120m': '120分钟',
  };
  const lines: string[] = [
    `点位测算（${lv.asOf || '—'}，${periodLabel[lv.period] ?? lv.period}，收盘 ${lv.close}）`,
  ];
  if (lv.swing) {
    const dir = lv.swing.direction === 'up' ? '上行波段（回撤看支撑）' : '下行波段（反弹看压力）';
    lines.push(`主导波段：${dir}，高 ${lv.swing.high}(${lv.swing.highTime}) / 低 ${lv.swing.low}(${lv.swing.lowTime})`);
  }
  if (lv.fibRetracements.length) {
    lines.push(`斐波那契回撤：${lv.fibRetracements.map((f) => `${f.ratio}→${f.price}`).join(' / ')}`);
  }
  if (lv.fibExtensions.length) {
    lines.push(`斐波那契扩展(目标)：${lv.fibExtensions.map((f) => `${f.ratio}→${f.price}`).join(' / ')}`);
  }
  if (lv.atr != null) {
    lines.push(`ATR(14)：${lv.atr}（波动率 ${lv.atrPct}%），可作止损/目标步长参考`);
  }
  if (lv.pivot) {
    const p = lv.pivot;
    lines.push(`枢轴点：PP ${p.pp}｜压力 R1 ${p.r1} / R2 ${p.r2} / R3 ${p.r3}｜支撑 S1 ${p.s1} / S2 ${p.s2} / S3 ${p.s3}`);
  }
  if (lv.ma) {
    lines.push(
      `均线结构（${lv.ma.alignment}）：${lv.ma.values.map((v) => `MA${v.period} ${v.value}`).join(' / ')}`,
    );
    const res = lv.ma.resistanceMa ? `MA${lv.ma.resistanceMa.period} ${lv.ma.resistanceMa.value}` : '无（价在所有均线上方）';
    const sup = lv.ma.supportMa ? `MA${lv.ma.supportMa.period} ${lv.ma.supportMa.value}` : '无（价在所有均线下方）';
    lines.push(`最近压力均线：${res}；最近支撑均线：${sup}`);
  }
  if (lines.length === 1) lines.push(lv.note);
  return lines.join('\n');
}

// ===== assert 自检（`tsx backend/src/market/levels.ts` 直接运行）=====
// 构造已知上行波段（低 10 → 高 20），断言 61.8% 回撤位与 ATR 数量级正确。
if (process.argv[1] && /levels\.ts$/.test(process.argv[1])) {
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(`自检失败：${msg}`);
  };
  // 20 根线性上行：low=10 → high=20，close 收在 19
  const bars: KlineBar[] = Array.from({ length: 20 }, (_, i) => {
    const base = 10 + (10 * i) / 19;
    return { time: `2026-01-${String(i + 1).padStart(2, '0')}`, open: base, close: base, high: base + 0.2, low: base - 0.2, volume: 1000, amount: 10000 };
  });
  const lv = computeLevels('TEST', bars, 'day');
  assert(lv.swing?.direction === 'up', `波段方向应为 up，实际 ${lv.swing?.direction}`);
  const fib618 = lv.fibRetracements.find((f) => f.ratio === '61.8%');
  // 上行波段 61.8% 回撤 = high(≈20.2) - range×0.618，应落在 14~16 区间
  assert(!!fib618 && fib618.price > 13 && fib618.price < 17, `61.8% 回撤位异常：${fib618?.price}`);
  assert(lv.atr != null && lv.atr > 0 && lv.atr < 2, `ATR 数量级异常：${lv.atr}`);
  assert(lv.pivot != null, 'pivot 应可计算');
  // eslint-disable-next-line no-console
  console.log('levels.ts 自检通过：', JSON.stringify({ swing: lv.swing, fib618, atr: lv.atr }));
}
