import type {
  KlineBar,
  KlinePeriod,
  VolumeBasisReading,
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

/**
 * 疑似除权/份额折算的跳空幅度门槛。与 datasource/adjust.ts 的 SPLIT_GAP 同源口径：
 * 单日向下 30% 以上的开盘跳空，A 股跌幅限制下不可能由真实交易产生。
 */
const SPLIT_GAP = 0.3;

/**
 * 分母窗口内成交量是否可比。
 *
 * 必须实测：`pickBasis` 在本源不给成交额时会回退成交量口径（腾讯 fqkline 日线正是这种源），
 * 而 10 送 10 或 ETF 1:2 折算后成交量直接翻倍，会算出「极端放量 / 突破获量能确认」的
 * 假结论，并一路影响阶段判定与仓位。判据取「向下大跳空」——已做前复权的源不会留下这个跳空，
 * 于是结果为可比，正是想要的效果。
 *
 * @param bars 日线，取末尾 LOOKBACK+1 根（与量比分母同一窗口）
 */
export function isVolumeComparable(bars: KlineBar[], lookback = LOOKBACK): boolean {
  const win = bars.slice(-(lookback + 1));
  for (let i = 1; i < win.length; i += 1) {
    const prevClose = win[i - 1].close;
    if (!(prevClose > 0)) continue;
    // 用 open 与 low 双判：折算当日的开盘价与最低价都会同步下移，
    // 只看 close 会被「折算后当天大涨」掩盖过去
    const ratio = Math.min(win[i].open, win[i].low) / prevClose;
    if (Number.isFinite(ratio) && ratio < 1 - SPLIT_GAP) return false;
  }
  return true;
}

/** 分母窗口内至少需要的有效样本数。长期停牌标的可能只剩两三根，此时不得给出量能结论 */
const MIN_VALID_SAMPLES = 15;

/**
 * 选定形态判定所用的量能口径：成交额优先，本源根本不给成交额时回退成交量。
 *
 * 只在 `amountSampleCount === 0`（本源整个窗口都没有成交额，如腾讯 fqkline 日线、新浪）时回退。
 * 若成交额有样本但不足 MIN_VALID_SAMPLES（疑似停牌），那是**该降级**的场景，
 * 换成成交量口径等于把一条本应降级的结论复活，故此时返回 null。
 */
function pickBasis(
  amountRatio: number | null,
  amountSampleCount: number,
  volumeRatio: number | null,
): VolumeBasisReading | null {
  if (amountRatio != null) {
    const state = classifyRatio(amountRatio);
    if (state) return { ratio: amountRatio, source: 'amount', state };
  }
  if (amountSampleCount > 0 || volumeRatio == null) return null;
  const state = classifyRatio(volumeRatio);
  return state ? { ratio: volumeRatio, source: 'volume', state } : null;
}

/** 口径标注文案：成交量口径必须显式写出来，否则使用者会误读成成交额 */
function basisText(basis: VolumeBasisReading): string {
  return basis.source === 'amount'
    ? `成交额比 ${basis.ratio.toFixed(2)}（${VOLUME_STATE_LABEL[basis.state]}）`
    : `成交量比 ${basis.ratio.toFixed(2)}（${VOLUME_STATE_LABEL[basis.state]}，本源无成交额，成交量口径）`;
}

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
      basis: null,
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

  const closeLocation = closeLocationOf(last);
  const amountState = classifyRatio(amountRatio20);
  const basis = pickBasis(amountRatio20, amountMed.count, volumeRatio20);
  if (amountRatio20 == null && amountMed.count === 0) {
    warnings.push(
      basis != null
        ? '本源不返回成交额（腾讯 fqkline 日线 / 新浪），量能判定已回退「成交量」口径'
        : '成交额数据缺失且成交量口径也不可用，量能结论降级',
    );
  }

  // 未收完的 bar 只报参考量比，不出确认性结论（避免拿半天量对比整天中位数）
  if (!completeBar) {
    warnings.push('当前 bar 未收完，量能仅作盘中参考，不构成放量/缩量确认');
    return {
      period,
      amountRatio20,
      volumeRatio20,
      amountState: null,
      basis,
      closeLocation,
      turnoverRate: input.turnoverRate ?? null,
      pattern: null,
      verdict:
        basis != null
          ? `盘中${basis.source === 'amount' ? '成交额' : '成交量（本源无成交额）'}已达中位数 ${basis.ratio.toFixed(2)} 倍（未收盘）`
          : '盘中量能待确认',
      warnings,
    };
  }

  const { pattern, verdict } = buildVerdict(bars, basis, closeLocation);
  return {
    period,
    amountRatio20,
    volumeRatio20,
    amountState,
    basis,
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
 * 「是否放量」的单一显式读数：收盘后走 20 日成交额中位数口径（本源不给成交额时回退成交量口径，
 * basis 与 warnings 会显式标注），盘中走实时量比口径。
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
    const vp = computeVolumePrice({
      period: 'day',
      bars,
      completeBar: true,
      turnoverRate,
      // 与 technicalEvidence 同口径：不实测的话默认按可比处理，本源不给成交额时
      // pickBasis 会回退成交量口径，10 送 10 或份额折算后照样读出「极端放量」
      volumeComparable: isVolumeComparable(bars),
    });
    // 口径选择已收敛到 computeVolumePrice 的 basis（成交额优先、本源无成交额才回退成交量），
    // 这里不再自行拼一套，避免读数与形态判定各用一个口径
    const picked = vp.basis;
    if (!picked) return null;
    return {
      ratio: Math.round(picked.ratio * 100) / 100,
      basis: picked.source === 'amount' ? 'amount_median20' : 'volume_median20',
      state: picked.state,
      label: VOLUME_STATE_LABEL[picked.state],
      turnoverRate: vp.turnoverRate,
      ...(vp.warnings.length > 0 ? { warnings: vp.warnings } : {}),
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
 *
 * 吃的是 pickBasis 选定的口径而非只吃成交额：腾讯日线（日线链首选源）恒不返回成交额，
 * 只认成交额会让这四条判据长期恒为 null。文案里会标注实际口径。
 */
function buildVerdict(
  bars: KlineBar[],
  basis: VolumeBasisReading | null,
  closeLoc: number | null,
): { pattern: VolumePricePattern; verdict: string } {
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (basis == null) return { pattern: null, verdict: '量能数据不足' };
  const ratio = basis.ratio;

  const ratioText = basisText(basis);
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
