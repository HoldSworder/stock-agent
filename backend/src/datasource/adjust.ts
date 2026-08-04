import type { KlineBar, KlinePeriod } from '@stock-agent/shared';

// K 线复权修正，两层：
// 1) frontAdjustDaily：日/周/月线自身的连续性修正。名义上前复权的源也会漏除权
//    （实测腾讯 qfq 不处理 ETF 份额折算），故用价格自身重建因子补上。
// 2) frontAdjustMinute：腾讯/新浪的分钟接口（mkline/getKLineData）返回「不复权」价，
//    除权/分红/份额折算当日会出现假跳空 → 算出假死叉，并扰动随后约 26~35 根 K 的 EMA。
//    以（已经过第 1 层修正的）日线复权收盘为锚，反推每日复权因子套到分钟线。
// 两层对已复权数据 factor≈1，幂等安全；故一律修正，无需关心命中源。
// 两层的 volume 口径必须一致（价格 ×f 则 volume ÷f）：否则（如只在日线缩放量、分钟不缩放）
// 跨折算日时同一段行情在日线上是放大后的量、在 30 分钟上是原始量，量价确认会得出相反结论。

const MINUTE_PERIODS: ReadonlySet<KlinePeriod> = new Set(['5m', '15m', '30m', '60m', '120m']);

export function isMinutePeriod(period: KlinePeriod): boolean {
  return MINUTE_PERIODS.has(period);
}

/** 取交易日（"YYYY-MM-DD HH:MM" → "YYYY-MM-DD"；日线本就 10 位） */
function dateOf(time: string): string {
  return time.slice(0, 10);
}

/**
 * 判定为除权/折算的「开盘相对前收」下跌幅度。
 *
 * 只认向下方向：分红、送股、份额折算都只会让价格变低（r < 1），r > 1 只有极罕见的缩股/份额合并。
 * 而向上的大跳空存在真实来源——创业板与科创板新股上市前 5 个交易日无涨跌幅限制，
 * 次日开盘相对首日收盘翻倍完全可能，若也做修正就会把真实暴涨当成除权抹掉。
 *
 * 0.35 的量级依据：常规交易日开盘价受涨跌幅限制（最宽是北交所 ±30%），
 * 故 r < 0.65 只可能是除权，能安全覆盖 1:2 及以上的份额折算。
 *
 * ponytail: 缩股/份额合并（r > 1）不会被修正，这类在 A 股 ETF 上基本不存在，
 * 真遇到需人工介入或改成接分红/折算公告数据源按公告因子复权。
 */
export const SPLIT_GAP = 0.35;

/**
 * 日/周/月线连续性自修正：用价格自身重建复权因子，补上数据源漏掉的除权。
 *
 * 实测背景：腾讯 fqkline 的 qfq 只处理个股分红送股，不处理 ETF 份额折算。
 * 159516 在 2026-07-10 做 1:2 折算，前复权序列里仍留着 -53.5% 的假跳空
 * （open 0.973 / 前收 1.945 = 0.5003），MA/MACD/ATR/摆动点/回测全部跟着漂。
 *
 * 做法：从后往前扫，`open_t / close_{t-1}` 偏离 1 超过 SPLIT_GAP 即认定为除权点，
 * 把该点之前的所有 bar 乘上累乘因子。价格四项等比缩放；volume 反向缩放
 * （折算后份额变化，以份计的历史成交量需同步放大才与当下可比）；amount 不动
 * （成交额与折算无关）。无除权点时原样返回，故对已正确复权的源是 no-op、幂等安全。
 *
 * ponytail: 阈值法只抓得住份额折算与大额分红这类量级的跳空，抓不住 r≈0.97 的小额分红；
 * 那点误差对 MA/ATR 可忽略。要做到精确就得接分红/折算公告数据源，按公告因子复权。
 *
 * @param label 传入即打印命中的除权点。只应由取数路径传（一次性事件）；
 *   读缓存出口那次是幂等兜底，每次读都打会随图表轮询刷屏，故不传。
 */
export function frontAdjustDaily(bars: KlineBar[], label?: string): KlineBar[] {
  if (bars.length < 2) return bars;

  // 每根 bar 各自的累乘因子：除权点之前的 bar 要把它之后所有除权因子都乘上
  const factors = new Array<number>(bars.length).fill(1);
  const hits: Array<{ time: string; ratio: number }> = [];
  let acc = 1;
  for (let i = bars.length - 1; i >= 1; i--) {
    const prev = bars[i - 1];
    const cur = bars[i];
    if (prev.close > 0 && cur.open > 0) {
      const r = cur.open / prev.close;
      // 只修向下跳空，见 SPLIT_GAP 注释：向上的大跳空可能是新股上市初期的真实暴涨
      if (r < 1 - SPLIT_GAP) {
        acc *= r;
        hits.push({ time: cur.time, ratio: r });
      }
    }
    factors[i - 1] = acc;
  }
  if (acc === 1) return bars;

  if (label) {
    // hits 是按倒序扫出来的，输出时按时间正序更好读
    for (const h of [...hits].reverse()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[kline] ${label} ${h.time} 检测到除权/折算（开盘/前收 = ${h.ratio.toFixed(4)}），已对之前的 K 线做前复权修正`,
      );
    }
  }

  return bars.map((b, i) => {
    const f = factors[i];
    if (f === 1) return b;
    return {
      ...b,
      open: b.open * f,
      high: b.high * f,
      low: b.low * f,
      close: b.close * f,
      volume: b.volume / f,
    };
  });
}

/**
 * 以日线前复权收盘为锚，对分钟 K 线做前复权。
 * 同一交易日 factor = 日线复权收盘 / 分钟当日最后一根（收盘）；
 * 日线缺失某交易日则沿用上一个因子（升序前向填充）。空输入/无锚点时原样返回（best-effort）。
 * 价格四项 ×factor、volume ÷factor（与 frontAdjustDaily 同口径，否则两个周期的量能不可比）；
 * amount 不动（成交额与复权无关）。
 *
 * ponytail: 这里的 factor 是连续值，源侧 qfq 里的现金分红也会体现进去（典型 f≈0.97），
 * 而日线只在跳空超过 SPLIT_GAP 时才缩放量，故非折算区间两层的量存在个位数百分比差。
 * 量比取同窗口中位数，这点差异基本抵消；要严格对齐需改成只对 |f-1| > SPLIT_GAP 的日期缩放量。
 */
export function frontAdjustMinute(minute: KlineBar[], daily: KlineBar[]): KlineBar[] {
  if (minute.length === 0 || daily.length === 0) return minute;

  const adjClose = new Map<string, number>();
  for (const b of daily) adjClose.set(dateOf(b.time), b.close);

  // 分钟当日最后一根收盘（输入升序，后值覆盖即当日最后）
  const rawLast = new Map<string, number>();
  for (const b of minute) rawLast.set(dateOf(b.time), b.close);

  const dates = [...new Set(minute.map((b) => dateOf(b.time)))].sort();
  const factor = new Map<string, number>();
  let lastF = 1;
  for (const d of dates) {
    const ad = adjClose.get(d);
    const rl = rawLast.get(d);
    // 必须 ad>0：日线锚某日收盘为 0（部分源当日未定格的脏数据）会算出 factor=0，
    // 进而把当日所有分钟 bar 价格清零、污染 MACD。遇到非正收盘则沿用上一因子。
    if (ad != null && ad > 0 && rl != null && rl > 0) lastF = ad / rl;
    factor.set(d, lastF);
  }

  return minute.map((b) => {
    const f = factor.get(dateOf(b.time)) ?? 1;
    if (f === 1) return b;
    return {
      ...b,
      open: b.open * f,
      close: b.close * f,
      high: b.high * f,
      low: b.low * f,
      volume: b.volume / f,
    };
  });
}
