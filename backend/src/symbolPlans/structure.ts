import type {
  ChanFractal,
  ChanPivotZone,
  ChanSetup,
  ChanStructure,
  DowStructure,
  DowTrendState,
  KlineBar,
  KlinePeriod,
  SwingPoint,
} from '@stock-agent/shared';

// 价格结构证据（计划 4.3 / 4.4）。MVP 真正新增的技术计算：
// 确认摆动点 + 道氏状态机、K线包含处理 + 分型/简化笔/候选中枢。
// 结论一律引用具体 SwingPoint.id / ChanFractal.id，不给无锚点的文字。

/** 摆动检测窗口：极值需在左右各 SWING_LOOKBACK 根内最高/最低 */
const SWING_LOOKBACK = 3;

/**
 * 摆动点确认所需的右侧根数。必须 >= SWING_LOOKBACK：
 * 若小于窗口宽度，右窗口还没填满就标 confirmed，次日补进一根更极端的 bar 会让该点整个消失，
 * 而计划正是拿最近确认摆动点当结构止损锚（candidateCatalog 的 guaranteed 保底候选）。
 */
export const SWING_CONFIRM_BARS = SWING_LOOKBACK;

/** 结构算法版本，随参数调整递增，供历史计划绑定口径 */
export const STRUCTURE_MODEL_VERSION = 'structure-v1';

/**
 * 检测摆动高低点（ZigZag 简化版）。
 * 高点：high 在左右各 SWING_LOOKBACK 根内最大；低点对称。
 * confirmed：右侧已走出 SWING_CONFIRM_BARS 根，此后该点不会被新数据推翻。
 */
export function detectSwings(bars: KlineBar[], period: KlinePeriod): SwingPoint[] {
  const out: SwingPoint[] = [];
  const n = bars.length;
  for (let i = SWING_LOOKBACK; i < n - 1; i++) {
    const bar = bars[i];
    const left = bars.slice(Math.max(0, i - SWING_LOOKBACK), i);
    const right = bars.slice(i + 1, Math.min(n, i + 1 + SWING_LOOKBACK));
    if (right.length === 0) continue;
    const isHigh =
      left.every((b) => b.high <= bar.high) && right.every((b) => b.high <= bar.high);
    const isLow = left.every((b) => b.low >= bar.low) && right.every((b) => b.low >= bar.low);
    // 同一根同时是左右极值时按振幅方向取一侧，避免同点重复登记
    if (isHigh && !isLow) {
      out.push(mkSwing(period, 'high', bar, n - 1 - i >= SWING_CONFIRM_BARS));
    } else if (isLow && !isHigh) {
      out.push(mkSwing(period, 'low', bar, n - 1 - i >= SWING_CONFIRM_BARS));
    }
  }
  return dedupeAlternating(out);
}

function mkSwing(
  period: KlinePeriod,
  kind: 'high' | 'low',
  bar: KlineBar,
  confirmed: boolean,
): SwingPoint {
  return {
    id: `sw:${period}:${kind}:${bar.time}`,
    period,
    kind,
    time: bar.time,
    price: kind === 'high' ? bar.high : bar.low,
    confirmed,
  };
}

/**
 * 相邻同类摆动点只保留更极端的一个，保证高低交替。
 * 不交替的序列无法做道氏「更高高点 + 更高低点」判断。
 * 导出供波浪计数（market/elliott.ts）复用：按 confirmed 过滤会打断交替，过滤后必须重新去重。
 */
export function dedupeAlternating(points: SwingPoint[]): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || prev.kind !== p.kind) {
      out.push(p);
      continue;
    }
    const keepNew = p.kind === 'high' ? p.price > prev.price : p.price < prev.price;
    if (keepNew) out[out.length - 1] = p;
  }
  return out;
}

/**
 * 道氏结构判定（计划 4.3）。
 * 只用已确认摆动点判方向；未确认点可用于「突破待确认」这类过渡态描述。
 */
export function computeDowStructure(bars: KlineBar[], period: KlinePeriod): DowStructure {
  const swings = detectSwings(bars, period);
  // 先筛已确认再做交替去重：反过来的话，一个尚未确认的更极端点会把前一个已确认点替换掉，
  // 随后又被 confirmed 过滤剔除，导致 lastConfirmedHighId 回退甚至变 null，方向随盘中数据抖动。
  const confirmed = dedupeAlternating(swings.filter((s) => s.confirmed));
  const highs = confirmed.filter((s) => s.kind === 'high');
  const lows = confirmed.filter((s) => s.kind === 'low');
  const rationale: string[] = [];

  const lastHigh = highs[highs.length - 1] ?? null;
  const prevHigh = highs[highs.length - 2] ?? null;
  const lastLow = lows[lows.length - 1] ?? null;
  const prevLow = lows[lows.length - 2] ?? null;

  if (!lastHigh || !lastLow) {
    return {
      period,
      state: 'range',
      transitionKind: null,
      swings,
      lastConfirmedHighId: lastHigh?.id ?? null,
      lastConfirmedLowId: lastLow?.id ?? null,
      rationale: ['已确认高低点不足，无法判定道氏方向，按震荡处理'],
    };
  }

  const higherHigh = prevHigh ? lastHigh.price > prevHigh.price : null;
  const higherLow = prevLow ? lastLow.price > prevLow.price : null;
  const lowerHigh = prevHigh ? lastHigh.price < prevHigh.price : null;
  const lowerLow = prevLow ? lastLow.price < prevLow.price : null;

  let state: DowTrendState = 'range';
  let transitionKind: DowStructure['transitionKind'] = null;

  if (higherHigh && higherLow) {
    state = 'uptrend';
    rationale.push(
      `更高高点（${prevHigh!.id} ${prevHigh!.price} → ${lastHigh.id} ${lastHigh.price}）`,
      `更高低点（${prevLow!.id} ${prevLow!.price} → ${lastLow.id} ${lastLow.price}）`,
    );
  } else if (lowerHigh && lowerLow) {
    state = 'downtrend';
    rationale.push(
      `更低高点（${prevHigh!.id} ${prevHigh!.price} → ${lastHigh.id} ${lastHigh.price}）`,
      `更低低点（${prevLow!.id} ${prevLow!.price} → ${lastLow.id} ${lastLow.price}）`,
    );
  } else if (higherLow && !higherHigh) {
    // 低点抬高但未突破前高：只能是转折观察，不得直接判上涨
    state = 'transition';
    transitionKind = 'higher_low';
    rationale.push(
      `低点抬高（${prevLow!.id} → ${lastLow.id}）但尚未突破前高 ${lastHigh.id} ${lastHigh.price}，属转折观察`,
    );
  } else if (higherHigh && !higherLow) {
    // 突破前高但尚未形成回踩低点：突破待确认
    state = 'transition';
    transitionKind = 'breakout_pending';
    rationale.push(
      `突破前高（${prevHigh!.id} → ${lastHigh.id}）但尚未形成更高的回踩低点，属突破待确认`,
    );
  } else {
    rationale.push(
      `高低点未形成一致方向（最近高点 ${lastHigh.id}、最近低点 ${lastLow.id}），按震荡处理`,
    );
  }

  return {
    period,
    state,
    transitionKind,
    swings,
    lastConfirmedHighId: lastHigh.id,
    lastConfirmedLowId: lastLow.id,
    rationale,
  };
}

// ===== 缠论简化结构（计划 4.4）=====

/**
 * K 线包含处理：后一根被前一根完全包含（或反之）时合并，方向沿用当前笔方向。
 * 这是固定算法，不做流派可选，版本记入 STRUCTURE_MODEL_VERSION。
 */
export function mergeContainedBars(bars: KlineBar[]): KlineBar[] {
  if (bars.length === 0) return [];
  const out: KlineBar[] = [{ ...bars[0] }];
  // 初始方向由第一对非包含 K 线播种；在此之前遇到包含关系不合并，避免凭空猜方向
  let dir: 'up' | 'down' | null = null;
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prev = out[out.length - 1];
    const prevContainsCur = prev.high >= cur.high && prev.low <= cur.low;
    const curContainsPrev = cur.high >= prev.high && cur.low <= prev.low;
    if (!prevContainsCur && !curContainsPrev) {
      dir = cur.high > prev.high ? 'up' : 'down';
      out.push({ ...cur });
      continue;
    }
    // 方向尚未确立时不合并，原样入列，等后续非包含 K 线定方向
    if (dir === null) {
      out.push({ ...cur });
      continue;
    }
    // 包含关系：按当前方向取极值合并，时间与量沿用较新一根
    const merged: KlineBar = {
      ...cur,
      high: dir === 'up' ? Math.max(prev.high, cur.high) : Math.min(prev.high, cur.high),
      low: dir === 'up' ? Math.max(prev.low, cur.low) : Math.min(prev.low, cur.low),
      volume: prev.volume + cur.volume,
      amount: prev.amount + cur.amount,
    };
    out[out.length - 1] = merged;
  }
  return out;
}

/** 顶/底分型：合并后 K 线三根一组，中间那根高点最高（顶）或低点最低（底） */
export function detectFractals(merged: KlineBar[]): ChanFractal[] {
  const out: ChanFractal[] = [];
  for (let i = 1; i < merged.length - 1; i++) {
    const a = merged[i - 1];
    const b = merged[i];
    const c = merged[i + 1];
    if (b.high > a.high && b.high > c.high) {
      out.push({ id: `fr:top:${b.time}`, kind: 'top', time: b.time, price: b.high });
    } else if (b.low < a.low && b.low < c.low) {
      out.push({ id: `fr:bottom:${b.time}`, kind: 'bottom', time: b.time, price: b.low });
    }
  }
  // 相邻同类分型只留更极端的，保证顶底交替
  const alt: ChanFractal[] = [];
  for (const f of out) {
    const prev = alt[alt.length - 1];
    if (!prev || prev.kind !== f.kind) {
      alt.push(f);
      continue;
    }
    const keepNew = f.kind === 'top' ? f.price > prev.price : f.price < prev.price;
    if (keepNew) alt[alt.length - 1] = f;
  }
  return alt;
}

/** 简化笔：交替分型顺次连线 */
function buildStrokes(fractals: ChanFractal[]): ChanStructure['strokes'] {
  const out: ChanStructure['strokes'] = [];
  for (let i = 1; i < fractals.length; i++) {
    const from = fractals[i - 1];
    const to = fractals[i];
    out.push({
      id: `st:${from.time}:${to.time}`,
      fromFractalId: from.id,
      toFractalId: to.id,
      dir: to.kind === 'top' ? 'up' : 'down',
    });
  }
  return out;
}

/**
 * 候选中枢：连续三段笔的共同重叠区。
 * 只保留当前有效且距现价最近的一个（计划 4.11.1 的入选约束）。
 */
export function detectPivots(fractals: ChanFractal[], lastPrice: number): ChanPivotZone[] {
  const zones: ChanPivotZone[] = [];
  for (let i = 0; i + 3 < fractals.length; i++) {
    const seg = fractals.slice(i, i + 4);
    const prices = seg.map((f) => f.price);
    const low = Math.max(Math.min(prices[0], prices[1]), Math.min(prices[2], prices[3]));
    const high = Math.min(Math.max(prices[0], prices[1]), Math.max(prices[2], prices[3]));
    if (high <= low) continue; // 无共同重叠，不构成中枢
    zones.push({
      id: `pv:${seg[0].time}:${seg[3].time}`,
      low,
      high,
      startTime: seg[0].time,
      endTime: seg[3].time,
      active: lastPrice >= low && lastPrice <= high,
    });
  }
  if (zones.length === 0) return [];
  // 只保留最近成形的一个：越靠后的分型段越贴近当前结构。
  // 早先按「距现价最近」取会把几个月前的失效中枢挑出来当支撑压力，权重还很高。
  return [zones[zones.length - 1]];
}

/**
 * 缠论简化结构。买卖点一律输出 candidate 语义；
 * 样本或结构不足返回 insufficient，禁止强行标点（计划 4.4）。
 */
export function computeChanStructure(bars: KlineBar[], period: KlinePeriod): ChanStructure {
  const rationale: string[] = [];
  if (bars.length < 30) {
    return {
      period,
      setup: 'insufficient',
      fractals: [],
      strokes: [],
      pivots: [],
      rationale: [`样本 ${bars.length} 根不足 30 根，结构判定不成立`],
    };
  }
  const merged = mergeContainedBars(bars);
  const fractals = detectFractals(merged);
  const strokes = buildStrokes(fractals);
  const lastPrice = bars[bars.length - 1].close;
  const pivots = detectPivots(fractals, lastPrice);

  if (fractals.length < 4) {
    return {
      period,
      setup: 'insufficient',
      fractals,
      strokes,
      pivots,
      rationale: [`有效分型仅 ${fractals.length} 个，不足以判定买卖点候选`],
    };
  }

  const setup = classifySetup(fractals, pivots, lastPrice, rationale);
  return { period, setup, fractals, strokes, pivots, rationale };
}

/**
 * 买卖点候选判定。二买要求 L1 → H1 → L2 且 L2 > L1（计划 4.4 明确条款）；
 * 三买要求向上离开中枢后回踩不重新进入中枢。
 */
function classifySetup(
  fractals: ChanFractal[],
  pivots: ChanPivotZone[],
  lastPrice: number,
  rationale: string[],
): ChanSetup {
  const bottoms = fractals.filter((f) => f.kind === 'bottom');
  const tops = fractals.filter((f) => f.kind === 'top');
  const pivot = pivots[0] ?? null;

  // 三买：中枢存在、现价在中枢上方、且最近一个底分型未回到中枢内
  if (pivot && lastPrice > pivot.high) {
    const lastBottom = bottoms[bottoms.length - 1];
    if (lastBottom && lastBottom.price > pivot.high) {
      rationale.push(
        `向上离开候选中枢 ${pivot.id}（${pivot.low.toFixed(3)}~${pivot.high.toFixed(3)}），` +
          `回踩低点 ${lastBottom.id} ${lastBottom.price.toFixed(3)} 未重回中枢，构成三买候选`,
      );
      return 'third_buy_candidate';
    }
  }

  // 最后一个分型：买卖点候选必须是「当前正在成立」的形态。
  // 否则 L1→H1→L2→H2 且 H2<H1（已走出更低高点）时仍会报二买，把被后续走势否定的形态当成候选。
  const lastFractal = fractals[fractals.length - 1];

  // 二买：L1 → H1 → L2 且 L2 > L1，且 L2 必须是最新分型
  if (bottoms.length >= 2 && tops.length >= 1) {
    const l2 = bottoms[bottoms.length - 1];
    const l1 = bottoms[bottoms.length - 2];
    const h1 = tops.filter((t) => t.time > l1.time && t.time < l2.time).pop();
    if (h1 && l2.price > l1.price && lastFractal?.id === l2.id) {
      rationale.push(
        `L1 ${l1.id} ${l1.price.toFixed(3)} → H1 ${h1.id} ${h1.price.toFixed(3)} → ` +
          `L2 ${l2.id} ${l2.price.toFixed(3)}，满足 L2 > L1，构成二买候选`,
      );
      return 'second_buy_candidate';
    }
  }

  // 二卖：H1 → L1 → H2 且 H2 < H1，且 H2 必须是最新分型
  if (tops.length >= 2 && bottoms.length >= 1) {
    const h2 = tops[tops.length - 1];
    const h1 = tops[tops.length - 2];
    const l1 = bottoms.filter((b) => b.time > h1.time && b.time < h2.time).pop();
    if (l1 && h2.price < h1.price && lastFractal?.id === h2.id) {
      rationale.push(
        `H1 ${h1.id} ${h1.price.toFixed(3)} → L1 ${l1.id} → H2 ${h2.id} ${h2.price.toFixed(3)}，` +
          `H2 < H1，构成二卖候选`,
      );
      return 'second_sell_candidate';
    }
  }

  rationale.push('未形成明确买卖点候选结构');
  return 'none';
}
