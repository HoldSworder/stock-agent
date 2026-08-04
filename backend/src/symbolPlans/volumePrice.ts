import type {
  KlineBar,
  KlinePeriod,
  VolumePricePattern,
  VolumePriceReading,
  VolumeReadout,
  VolumeState,
} from '@stock-agent/shared';

// 量价证据（计划 4.2）。这是 MVP 真正新增的三项技术计算之一：
// 成交额比与收盘位置。ATR/均线/枢轴/斐波/MACD 一律复用 market/levels.ts 与 market/indicators.ts，
// 本文件不得复制那些算法。

/** 比值 → 状态分级（阈值取自计划 4.2 表格） */
const THRESHOLDS: Array<[number, VolumeState]> = [
  [0.65, 'extreme_shrink'],
  [0.8, 'clear_shrink'],
  [0.9, 'mild_shrink'],
  [1.1, 'normal'],
  [1.35, 'mild_expand'],
  [1.7, 'clear_expand'],
];

export const VOLUME_STATE_LABEL: Record<VolumeState, string> = {
  extreme_shrink: '极度缩量',
  clear_shrink: '明显缩量',
  mild_shrink: '温和缩量',
  normal: '正常',
  mild_expand: '温和放量',
  clear_expand: '明显放量',
  extreme_expand: '极端放量',
};

/**
 * 实时量比（东财 f10）的分级阈值。
 *
 * 不能复用上面那张表：上表标的是「当日成交额 ÷ 前 20 日成交额中位数」，
 * 而量比是「当前每分钟均量 ÷ 前 5 日每分钟均量」，已按时间折算，市场习惯读法是
 * 1.5 起温和放量、2.5 起明显放量。共用一套边界会让盘中量比 1.4 就被报成「明显放量」。
 */
const REALTIME_THRESHOLDS: Array<[number, VolumeState]> = [
  [0.5, 'extreme_shrink'],
  [0.8, 'clear_shrink'],
  [0.95, 'mild_shrink'],
  [1.5, 'normal'],
  [2.5, 'mild_expand'],
  [5, 'clear_expand'],
];

function classifyBy(
  table: Array<[number, VolumeState]>,
  ratio: number | null,
): VolumeState | null {
  if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) return null;
  for (const [bound, state] of table) if (ratio < bound) return state;
  return 'extreme_expand';
}

export function classifyRatio(ratio: number | null): VolumeState | null {
  return classifyBy(THRESHOLDS, ratio);
}

/** 实时量比 → 七档定性（阈值见 REALTIME_THRESHOLDS） */
export function classifyRealtimeRatio(ratio: number | null): VolumeState | null {
  return classifyBy(REALTIME_THRESHOLDS, ratio);
}

/** 中位数；空数组返回 0。同时回吐有效样本数，供调用方判断是否够格下结论 */
export function medianWithCount(values: number[]): { value: number; count: number } {
  const arr = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (arr.length === 0) return { value: 0, count: 0 };
  const mid = Math.floor(arr.length / 2);
  const value = arr.length % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  return { value, count: arr.length };
}

/** 中位数；空数组返回 0 */
export function median(values: number[]): number {
  return medianWithCount(values).value;
}

/** 收盘位置 (close-low)/(high-low)；零振幅（一字板）返回 null 而非 0.5 */
export function closeLocationOf(bar: KlineBar): number | null {
  const range = bar.high - bar.low;
  return range > 0 ? (bar.close - bar.low) / range : null;
}

export interface VolumePriceInput {
  period: KlinePeriod;
  bars: KlineBar[];
  /** 最后一根是否已收完。未收完时不出「全天缩量/放量」结论（计划 4.1） */
  completeBar: boolean;
  /** 个股换手率（%），ETF 传 null */
  turnoverRate?: number | null;
  /** 分母窗口内是否跨过除权除息/份额拆分，跨过则成交量不可比 */
  volumeComparable?: boolean;
}

/** 回看窗口：前 20 个完整交易日（分母不含当根） */
const LOOKBACK = 20;

/** 分母窗口内至少需要的有效样本数。长期停牌标的可能只剩两三根，此时不得给出量能结论 */
const MIN_VALID_SAMPLES = 15;

/**
 * 量价读数。规则要点：
 * - 分母是前 LOOKBACK 根的中位数，且不含当根；
 * - 当根未收完时只给量比参考并写警告，不出放量/缩量确认结论；
 * - 成交量不可比（跨除权/拆分）时只用成交额，并写警告。
 */
export function computeVolumePrice(input: VolumePriceInput): VolumePriceReading {
  const { period, bars, completeBar } = input;
  const warnings: string[] = [];
  const last = bars[bars.length - 1];

  if (!last || bars.length < LOOKBACK + 1) {
    return {
      period,
      amountRatio20: null,
      volumeRatio20: null,
      amountState: null,
      closeLocation: null,
      turnoverRate: input.turnoverRate ?? null,
      pattern: null,
      verdict: '样本不足，无法给出量价结论',
      warnings: [`需要至少 ${LOOKBACK + 1} 根，实际 ${bars.length} 根`],
    };
  }

  // 分母窗口：当根之前的 LOOKBACK 根
  const win = bars.slice(-1 - LOOKBACK, -1);
  const amountMed = medianWithCount(win.map((b) => b.amount));
  const volumeMed = medianWithCount(win.map((b) => b.volume));

  // 有效样本不足时宁可不给比值，也不用两三根算出的中位数冒充 20 日口径
  const amountUsable = amountMed.count >= MIN_VALID_SAMPLES && amountMed.value > 0;
  if (!amountUsable && amountMed.count > 0) {
    warnings.push(
      `分母窗口内仅 ${amountMed.count}/${LOOKBACK} 根有成交额（疑似停牌），不足 ${MIN_VALID_SAMPLES} 根，量能结论降级`,
    );
  }
  const amountRatio20 = amountUsable && last.amount > 0 ? last.amount / amountMed.value : null;
  const volumeComparable = input.volumeComparable !== false;
  const volumeUsable = volumeMed.count >= MIN_VALID_SAMPLES && volumeMed.value > 0;
  const volumeRatio20 =
    volumeComparable && volumeUsable && last.volume > 0 ? last.volume / volumeMed.value : null;
  if (!volumeComparable) {
    warnings.push('窗口内跨除权除息或份额拆分，成交量不可比，只用成交额与换手率');
  }
  if (amountRatio20 == null && amountMed.count === 0) warnings.push('成交额数据缺失，量能结论降级');

  const closeLocation = closeLocationOf(last);
  const amountState = classifyRatio(amountRatio20);

  // 未收完的 bar 只报参考量比，不出确认性结论（避免拿半天量对比整天中位数）
  if (!completeBar) {
    warnings.push('当前 bar 未收完，量能仅作盘中参考，不构成放量/缩量确认');
    return {
      period,
      amountRatio20,
      volumeRatio20,
      amountState: null,
      closeLocation,
      turnoverRate: input.turnoverRate ?? null,
      pattern: null,
      verdict: amountRatio20 != null ? `盘中成交额已达中位数 ${amountRatio20.toFixed(2)} 倍（未收盘）` : '盘中量能待确认',
      warnings,
    };
  }

  const { pattern, verdict } = buildVerdict(bars, amountRatio20, amountState, closeLocation);
  return {
    period,
    amountRatio20,
    volumeRatio20,
    amountState,
    closeLocation,
    turnoverRate: input.turnoverRate ?? null,
    pattern,
    verdict,
    warnings,
  };
}

export interface VolumeReadoutInput {
  /** 当根日 K 是否已收完 */
  completeBar: boolean;
  /** 东财实时量比（f10），仅盘中需要；取不到传 null */
  realtimeRatio?: number | null;
  /** 换手率 %，ETF 与缺失传 null */
  turnoverRate?: number | null;
}

/**
 * 「是否放量」的单一显式读数：收盘后走 20 日成交额中位数口径，盘中走实时量比口径。
 *
 * 盘中拿不到实时量比时返回 null 而不是退回半天成交额比整天中位数——
 * 那个数在 10:00 必然显示缩量，是会误导人的假读数。
 */
export function buildVolumeReadout(
  bars: KlineBar[],
  input: VolumeReadoutInput,
): VolumeReadout | null {
  const turnoverRate = input.turnoverRate ?? null;
  if (input.completeBar) {
    const vp = computeVolumePrice({ period: 'day', bars, completeBar: true, turnoverRate });
    const state = vp.amountState;
    if (vp.amountRatio20 == null || state == null) return null;
    return {
      ratio: Math.round(vp.amountRatio20 * 100) / 100,
      basis: 'amount_median20',
      state,
      label: VOLUME_STATE_LABEL[state],
      turnoverRate: vp.turnoverRate,
    };
  }
  const realtimeRatio = input.realtimeRatio ?? null;
  const state = classifyRealtimeRatio(realtimeRatio);
  // 显式判空而不是靠「state 非空蕴含 ratio 有效」做类型断言：
  // 那个不变式藏在 classifyRealtimeRatio 里，将来改它的空值语义这里会静默变成 NaN
  if (state == null || realtimeRatio == null) return null;
  return {
    ratio: Math.round(realtimeRatio * 100) / 100,
    basis: 'realtime',
    state,
    label: VOLUME_STATE_LABEL[state],
    turnoverRate,
  };
}

/**
 * 量价定性结论（计划 4.2 四条判据）。
 * 「放量下跌」优先判为风险而非资金进场；「放量滞涨」需未突破前高且收盘位置偏低。
 */
function buildVerdict(
  bars: KlineBar[],
  ratio: number | null,
  state: VolumeState | null,
  closeLoc: number | null,
): { pattern: VolumePricePattern; verdict: string } {
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (ratio == null || state == null) return { pattern: null, verdict: '量能数据不足' };

  const ratioText = `成交额比 ${ratio.toFixed(2)}（${VOLUME_STATE_LABEL[state]}）`;
  const locText = closeLoc != null ? `，收盘位置 ${closeLoc.toFixed(2)}` : '';
  const expanded = ratio >= 1.35;
  const down = prev ? last.close < prev.close : false;

  // 前高：不含当根的近 LOOKBACK 根最高收盘。窗口必须跟 LOOKBACK 联动，
  // 否则调整 LOOKBACK 后「突破前高」会静默换成另一套口径。
  const prevHigh = Math.max(...bars.slice(-(LOOKBACK + 1), -1).map((b) => b.close));

  if (expanded && down && closeLoc != null && closeLoc <= 0.33) {
    return {
      pattern: 'heavy_down',
      verdict: `${ratioText}${locText}：放量下跌，优先判为风险而非资金进场`,
    };
  }
  if (expanded && last.close <= prevHigh && closeLoc != null && closeLoc <= 0.5) {
    return {
      pattern: 'stall_on_volume',
      verdict: `${ratioText}${locText}：放量滞涨，未突破前高且收盘偏低`,
    };
  }
  if (ratio >= 1.2 && last.close > prevHigh && closeLoc != null && closeLoc >= 0.67) {
    return { pattern: 'breakout_confirmed', verdict: `${ratioText}${locText}：突破获量能确认` };
  }
  // 与 classifyRatio 的 clear_shrink 用同一边界（< 0.8），避免标签与结论各用一套阈值
  if (ratio < 0.8 && down) {
    return {
      pattern: 'healthy_pullback',
      verdict: `${ratioText}${locText}：回踩缩量，若结构支撑不破属健康回踩`,
    };
  }
  return { pattern: null, verdict: `${ratioText}${locText}` };
}
