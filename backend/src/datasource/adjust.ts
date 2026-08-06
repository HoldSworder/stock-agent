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
 * bar 内除权的判定幅度（`close_t / open_t`），只用于周/月线。
 *
 * 周线的 bar 横跨整周，除权发生在周中时（159516 是 2026-07-10 周五折算），
 * 该 bar 的 open 在折算前、close 在折算后，跳空被吸收进 bar 内部，
 * 跨 bar 的 `open_t / close_{t-1}` 完全看不到。后果是周线波段锚点取到折算前的高点，
 * 黄金分割回撤/扩展位整套失真（实测周线高点 2.11 vs 日线 1.05）。
 *
 * 阈值比 SPLIT_GAP 更严（0.55 而非 0.65）是有物理依据的：一周 5 个交易日按 ±10%
 * 涨跌停算，理论最大周跌幅约 -41%，达不到 -45%，故 `close/open < 0.55` 只可能是除权。
 *
 * ponytail: 只抓得住 1:2 及更激进的折算（比例 ≤ 0.5）；1:1.5 这种（0.667）抓不到。
 * bar 内无法还原折算发生的具体时点，故该 bar 自身只修 open/high（它们在折算前），
 * low/close 视为折算后不动——这是近似，要精确就得接折算公告按日期切分。
 */
const INTRABAR_SPLIT_GAP = 0.45;

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
export function frontAdjustDaily(
  bars: KlineBar[],
  label?: string,
  opts: { intrabar?: boolean } = {},
): KlineBar[] {
  if (bars.length < 2) return bars;

  // 每根 bar 各自的累乘因子：除权点之前的 bar 要把它之后所有除权因子都乘上
  const factors = new Array<number>(bars.length).fill(1);
  // bar 内除权（周/月线专用）：该 bar 自身的 open/high 也要缩放
  const selfFactors = new Array<number>(bars.length).fill(1);
  const hits: Array<{ time: string; ratio: number }> = [];
  let acc = 1;
  for (let i = bars.length - 1; i >= 0; i--) {
    const cur = bars[i];
    // 先看 bar 内：周/月线的除权多半发生在 bar 内部，跨 bar 看不到
    if (opts.intrabar === true && cur.open > 0 && cur.close > 0) {
      const inner = cur.close / cur.open;
      if (inner < 1 - INTRABAR_SPLIT_GAP) {
        selfFactors[i] = inner;
        acc *= inner;
        hits.push({ time: `${cur.time}(bar内)`, ratio: inner });
      }
    }
    if (i === 0) break;
    const prev = bars[i - 1];
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
  if (acc === 1 && selfFactors.every((f) => f === 1)) return bars;

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
    const self = selfFactors[i];
    if (f === 1 && self === 1) return b;
    // 两个因子必须叠乘：f 是该 bar 之后所有除权的累乘，self 是该 bar 内部那次除权。
    // bar 内除权只影响 open/high（它们在折算前），low/close 已是折算后价，只吃 f。
    // 漏乘 f 会让这根 bar 停在旧基准，和下一根之间重新出现假跳空——正是本函数要消除的东西。
    return {
      ...b,
      open: b.open * f * self,
      high: b.high * f * self,
      low: b.low * f,
      close: b.close * f,
      // 只除 f 不除 self：成交额不随除权变化，而 close 只乘了 f，
      // 除 f 才能保住「成交额 ≈ 收盘 × 成交量 × 100」这个恒等式
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
