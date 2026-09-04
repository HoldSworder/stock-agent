import type { AssertionOutcome, KlineBar } from '@stock-agent/shared';
import { SWING_CONFIRM_BARS, detectSwings } from '../symbolPlans/structure';
import type { KlinePeriod } from '@stock-agent/shared';

// 断言判定。全部是纯函数，判定参数由调用方从落库记录里取（冻结值），
// 不读任何模块级可调参数——否则日后调参会改写历史成绩，纵向就没法比了。

/**
 * 判定一条点位断言，口径是**反应式**：
 * 价格摸到这条线之后有没有掉头，而不是这条线守没守住。
 *
 * 为什么不用「守住/跌破」的二元口径：那会把「假突破后迅速回落」判成未遵循，
 * 而假突破恰恰是这条线起了作用的典型表现——它拦住了价格，只是拦得不干净。
 * 反应式问的是「这个位子到底有没有用」，与你要的「后续走势有没有遵循」是同一个问题。
 *
 * - 触及后 reactionBars 根内，反向走出 >= atr 的幅度 → respected
 * - 触及了但窗口内没走出这个幅度（直接穿过去了）→ violated
 * - 到期都没触及 → untouched，**不计入分母**
 *
 * @param direction 期望的反应方向：up=触及后应向上反弹，down=触及后应向下受阻
 */
export function judgeLevel(
  bars: KlineBar[],
  price: number,
  direction: 'up' | 'down',
  atr: number,
  reactionBars: number,
  dueDate: string,
  today: string,
): AssertionOutcome | null {
  if (!(price > 0) || !(atr > 0) || bars.length === 0) return null;
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    /**
     * 触及必须发生在到期日之内，否则 20 天观察窗形同虚设。
     * 实测漏了这一句时，1819 条已判定断言里有 173 条（9.5%）是拿到期两个月后的
     * 一次触及来判的——「6 月那条压力位管不管用」被 8 月的走势回答了，
     * 这些本该判 untouched 的记录会同时污染分子与分母。
     * 反应窗口允许溢出到期日：踩点在最后一天触及，反应本来就要往后走几根才看得出来。
     */
    if (b.time.slice(0, 10) > dueDate) break;
    // 触及 = 这根 bar 的振幅包住了该价位。用 [low, high] 而不是收盘价：
    // 盘中摸到就算摸到了，只看收盘会漏掉「上影线打到压力位后被打回来」这种最典型的反应
    if (!(b.low <= price && b.high >= price)) continue;
    /**
     * 反应窗口必须从**触及那根之后**算起，绝不能含触及根本身。
     *
     * 价格是从下方涨上去碰到压力位的，那根 bar 的 low 必然在压力位下方；
     * 把它算进来，`price - min(low)` 天然就是正的，几乎每条压力位断言都会判 respected——
     * 自检里「触及后径直上穿」那个用例正是这么被误判成遵循的。支撑位镜像同理。
     * 代价是漏掉「同一根内摸到就掉头」的长影线反应：OHLC 看不出盘中先后，
     * 与其猜一个顺序，不如把这类算成没反应，宁可低估也不虚高。
     */
    const win = bars.slice(i + 1, i + 1 + Math.max(1, reactionBars));
    if (win.length === 0) {
      // 触及了但后面还没有 bar：到期就按没反应判，没到期继续等
      return today >= dueDate ? 'violated' : null;
    }
    const extreme = direction === 'up'
      ? Math.max(...win.map((x) => x.high))
      : Math.min(...win.map((x) => x.low));
    const move = direction === 'up' ? extreme - price : price - extreme;
    if (move >= atr) return 'respected';
    // 反应窗口还没走完就先别判：此刻说没反应，可能只是还没轮到
    if (win.length < Math.max(1, reactionBars)) return null;
    return 'violated';
  }
  return today >= dueDate ? 'untouched' : null;
}

/**
 * 判定一条时间断言：实际转折点是否落在预测窗口内。
 *
 * 用与生成断言时同一套 detectSwings 找实际转折，口径才对得上。
 * 容差按 bar 数给而不是日历天：跨长假时日历天会凭空多出好几天，
 * 而「走了几根 K 线」才是波浪时间投射真正的量纲。
 */
export function judgeTime(
  bars: KlineBar[],
  period: KlinePeriod,
  windowFrom: string,
  windowTo: string,
  toleranceBars: number,
  dueDate: string,
  today: string,
): AssertionOutcome | null {
  if (bars.length === 0) return null;
  const idxOf = (date: string): number => {
    // 取第一根不早于该日期的 bar；找不到说明窗口还在未来
    const i = bars.findIndex((b) => b.time.slice(0, 10) >= date);
    return i;
  };
  const fromIdx = idxOf(windowFrom);
  const toIdx = idxOf(windowTo);
  // 窗口尚未走到，且还没到期 → 继续等
  if (fromIdx < 0 || toIdx < 0) return today >= dueDate ? 'untouched' : null;

  const swings = detectSwings(bars, period).filter((s) => s.confirmed);
  if (swings.length === 0) {
    // 窗口已过完但一个确认转折都没有 → 判不出，别硬判
    return today >= dueDate ? 'unjudgeable' : null;
  }
  const lo = Math.max(0, fromIdx - Math.max(0, toleranceBars));
  const hi = Math.min(bars.length - 1, toIdx + Math.max(0, toleranceBars));
  const loTime = bars[lo].time.slice(0, 10);
  const hiTime = bars[hi].time.slice(0, 10);
  const inWindow = swings.some((s) => {
    const t = s.time.slice(0, 10);
    return t >= loTime && t <= hiTime;
  });
  if (inWindow) return 'respected';
  /**
   * 判「没转」之前必须等够确认根数。
   *
   * `detectSwings` 要右侧走出 SWING_CONFIRM_BARS 根才把一个点标成 confirmed。
   * 早先这里只要末根日期越过容差上界就判 violated——可恰好发生在窗口末尾的那个转折，
   * 此刻还差几根没确认、不在 swings 里，于是被记成「没转」。这是系统性低估：
   * 越是踩着窗口边缘命中的预测，越容易被判错。
   *
   * 所以要求容差上界之后**再走出 SWING_CONFIRM_BARS 根**才允许下判断，此前继续等。
   */
  const barsPastWindow = bars.filter((b) => b.time.slice(0, 10) > hiTime).length;
  if (barsPastWindow >= SWING_CONFIRM_BARS) return 'violated';
  // 到期日到了但确认根数还没走够：这条永远判不出来，别硬判成未命中
  return today >= dueDate ? 'unjudgeable' : null;
}

/**
 * 参与判定的 bar 区间：冻结当日那根不算。
 *
 * 断言是收盘后冻结的，当天那根 K 线早已走完——拿它判等于用已知结果打分。
 * 与 symbolPlans/forecast.ts 的 window() 同一条纪律，只是这里冻结时刻恒在收盘后，
 * 不需要它那个「盘前生成则含当日」的例外分支。
 */
export function barsAfter(bars: KlineBar[], asOf: string): KlineBar[] {
  return bars.filter((b) => b.time.slice(0, 10) > asOf);
}
