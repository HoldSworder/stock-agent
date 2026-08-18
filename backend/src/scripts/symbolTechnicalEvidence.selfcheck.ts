// 标的技术证据层自检（无框架，assert 断言）。用手工构造的固定 fixture 验证：
// 道氏四态、量价分母口径、未收完 bar 的降级、缠论 L2>L1 与 insufficient 纪律。
// 不碰网络与数据库。运行：cd backend && pnpm exec tsx src/scripts/symbolTechnicalEvidence.selfcheck.ts
import assert from 'node:assert/strict';
import type { KlineBar } from '@stock-agent/shared';
import {
  buildVolumeReadout,
  classifyRatio,
  classifyRealtimeRatio,
  closeLocationOf,
  computeVolumePrice,
  median,
} from '../symbolPlans/volumePrice';
import {
  computeChanStructure,
  computeDowStructure,
  detectFractals,
  detectSwings,
  mergeContainedBars,
} from '../symbolPlans/structure';

/** 造一根 bar；amount 缺省按 close×volume 估 */
function bar(
  time: string,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 1000,
  amount?: number,
): KlineBar {
  return { time, open, high, low, close, volume, amount: amount ?? close * volume };
}

/** 从固定基准日顺序取日期，避免手工拼接跨月出现非法日期 */
function dayAt(index: number): string {
  const base = Date.UTC(2026, 0, 5); // 2026-01-05
  return new Date(base + index * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 造一段折线走势：按给定转折价位依次线性插值，每段 perLeg 根。
 * 用于稳定复现「更高高点 / 更低低点」这类结构，避免随机数据导致自检时好时坏。
 */
function zigzag(pivots: number[], perLeg = 5): KlineBar[] {
  const bars: KlineBar[] = [];
  let idx = 0;
  for (let i = 1; i < pivots.length; i++) {
    const from = pivots[i - 1];
    const to = pivots[i];
    for (let k = 1; k <= perLeg; k++) {
      const px = from + ((to - from) * k) / perLeg;
      bars.push(bar(dayAt(idx), px, px * 1.01, px * 0.99, px));
      idx += 1;
    }
  }
  return bars;
}

// ===== 1. 基础工具 =====

assert.equal(median([]), 0, '空数组中位数应为 0');
assert.equal(median([3, 1, 2]), 2, '奇数个取中值');
assert.equal(median([4, 1, 2, 3]), 2.5, '偶数个取两中值均值');
assert.equal(median([0, -5, 2, 4]), 3, '非正数应被剔除后再取中位数');

assert.equal(classifyRatio(0.5), 'extreme_shrink');
assert.equal(classifyRatio(0.7), 'clear_shrink');
assert.equal(classifyRatio(0.85), 'mild_shrink');
assert.equal(classifyRatio(1.0), 'normal');
assert.equal(classifyRatio(1.2), 'mild_expand');
assert.equal(classifyRatio(1.5), 'clear_expand');
assert.equal(classifyRatio(2.0), 'extreme_expand');
assert.equal(classifyRatio(null), null, '缺值不应被归类');
assert.equal(classifyRatio(0), null, '零比值不应被归类');

// 实时量比另有一套阈值：1.0 是正常，1.5 起才算温和放量
assert.equal(classifyRealtimeRatio(0.4), 'extreme_shrink');
assert.equal(classifyRealtimeRatio(1.0), 'normal');
assert.equal(classifyRealtimeRatio(1.4), 'normal', '量比 1.4 不得按收盘阈值报成放量');
assert.equal(classifyRealtimeRatio(2.0), 'mild_expand');
assert.equal(classifyRealtimeRatio(3.0), 'clear_expand');
assert.equal(classifyRealtimeRatio(6.0), 'extreme_expand');
assert.equal(classifyRealtimeRatio(null), null, '缺值不应被归类');

assert.equal(closeLocationOf(bar('d', 10, 12, 8, 11)), 0.75, '收盘位置计算');
assert.equal(
  closeLocationOf(bar('d', 10, 10, 10, 10)),
  null,
  '零振幅（一字板）应返回 null，不得默认 0.5',
);

// ===== 2. 量价：分母不含当日 =====

{
  // 前 20 根成交额均为 100，当根 200 → 比值应为 2.0（若把当根算进分母则会小于 2）
  const bars: KlineBar[] = [];
  for (let i = 1; i <= 20; i++) bars.push(bar(`2026-07-${String(i).padStart(2, '0')}`, 10, 10.5, 9.5, 10, 10, 100));
  bars.push(bar('2026-07-21', 10, 11, 9.8, 10.9, 20, 200));
  const vp = computeVolumePrice({ period: 'day', bars, completeBar: true });
  assert.equal(vp.amountRatio20, 2, `分母必须排除当日，期望 2，实际 ${vp.amountRatio20}`);
  assert.equal(vp.amountState, 'extreme_expand');
}

// ===== 3. 量价：未收完 bar 不出确认结论 =====

{
  const bars: KlineBar[] = [];
  for (let i = 1; i <= 20; i++) bars.push(bar(`2026-07-${String(i).padStart(2, '0')}`, 10, 10.5, 9.5, 10, 10, 100));
  bars.push(bar('2026-07-21', 10, 11, 9.8, 10.9, 20, 200));
  const vp = computeVolumePrice({ period: 'day', bars, completeBar: false });
  assert.equal(vp.amountState, null, '未收完的 bar 不得给出放量/缩量确认状态');
  assert.ok(
    vp.warnings.some((w) => w.includes('未收完')),
    '未收完必须写入 warnings',
  );
  assert.ok(vp.amountRatio20 != null, '未收完仍可给盘中参考比值');
}

// ===== 4. 量价：样本不足与成交量不可比 =====

{
  const few = [bar('2026-07-01', 10, 10.5, 9.5, 10)];
  const vp = computeVolumePrice({ period: 'day', bars: few, completeBar: true });
  assert.equal(vp.amountRatio20, null, '样本不足应返回 null 而非近似值');
  assert.ok(vp.warnings.length > 0, '样本不足必须写警告');
}
{
  const bars: KlineBar[] = [];
  for (let i = 1; i <= 20; i++) bars.push(bar(`2026-07-${String(i).padStart(2, '0')}`, 10, 10.5, 9.5, 10, 10, 100));
  bars.push(bar('2026-07-21', 10, 11, 9.8, 10.9, 20, 200));
  const vp = computeVolumePrice({ period: 'day', bars, completeBar: true, volumeComparable: false });
  assert.equal(vp.volumeRatio20, null, '成交量不可比时不得给出量比');
  assert.ok(vp.amountRatio20 != null, '成交量不可比时仍应给成交额比');
  assert.ok(
    vp.warnings.some((w) => w.includes('不可比')),
    '成交量不可比必须写警告',
  );
}

// ===== 4a. 可比性必须实测，不能硬编码 true（第 11 条）=====
//
// 本源不给成交额时 pickBasis 会回退成交量口径（腾讯 fqkline 日线正是这种源），
// 10 送 10 或 ETF 1:2 折算后成交量翻倍，会得出「极端放量 / 突破获量能确认」的假结论
// 并一路影响阶段判定与仓位。

{
  const { isVolumeComparable } = await import('../symbolPlans/volumePrice');
  const clean: KlineBar[] = [];
  for (let i = 1; i <= 21; i++) {
    clean.push(bar(`2026-07-${String(i).padStart(2, '0')}`, 10, 10.5, 9.5, 10, 10, 100));
  }
  assert.equal(isVolumeComparable(clean), true, '无跳空序列必须判为可比，否则量能结论会被无故砍掉');

  // 10 送 10：次日开盘价与最低价一起腰斩，成交量翻倍
  const split = [...clean.slice(0, 20)];
  split.push(bar('2026-07-21', 5, 5.3, 4.9, 5.1, 20, 102));
  assert.equal(
    isVolumeComparable(split),
    false,
    '窗口内出现除权级向下跳空时必须判为不可比，否则成交量翻倍会被读成极端放量',
  );

  // 正常跌停（-10%）不得被误判成除权
  const limitDown = [...clean.slice(0, 20)];
  limitDown.push(bar('2026-07-21', 9.1, 9.2, 9.0, 9.0, 12, 108));
  assert.equal(isVolumeComparable(limitDown), true, '常规大跌不得被误判成除权，否则量能结论天天被砍');
}

// ===== 4b. 量能读数：两套口径各用各的阈值 =====

{
  /** 前 20 根成交额固定 100，当根按倍数放大，便于精确控制比值 */
  const barsWithRatio = (ratio: number): KlineBar[] => {
    const bars: KlineBar[] = [];
    for (let i = 1; i <= 20; i++) {
      bars.push(bar(`2026-07-${String(i).padStart(2, '0')}`, 10, 10.5, 9.5, 10, 10, 100));
    }
    bars.push(bar('2026-07-21', 10, 11, 9.8, 10.9, 10 * ratio, 100 * ratio));
    return bars;
  };

  // 收盘口径：数值与 computeVolumePrice 的 amountRatio20 一致
  const closed = buildVolumeReadout(barsWithRatio(1.4), { completeBar: true });
  const vp = computeVolumePrice({ period: 'day', bars: barsWithRatio(1.4), completeBar: true });
  assert.ok(closed, '收盘且样本充足时必须给出量能读数');
  assert.equal(closed.ratio, vp.amountRatio20, '收盘口径的数值必须就是 amountRatio20');
  assert.equal(closed.basis, 'amount_median20');

  // 同一个 1.4：收盘口径是明显放量，盘中量比口径只是正常。两套阈值不得被合并。
  assert.equal(closed.state, 'clear_expand', '成交额比 1.4 在收盘口径下是明显放量');
  const live = buildVolumeReadout(barsWithRatio(1.4), { completeBar: false, realtimeRatio: 1.4 });
  assert.ok(live, '盘中有实时量比时应给出读数');
  assert.equal(live.basis, 'realtime');
  assert.equal(live.state, 'normal', '量比 1.4 在盘中口径下只是正常，不得套用收盘阈值');
  assert.equal(live.ratio, 1.4, '盘中读数取实时量比而非当日成交额比');

  // 盘中拿不到实时量比时宁可不给，也不能拿半天成交额比整天中位数冒充
  assert.equal(
    buildVolumeReadout(barsWithRatio(1.4), { completeBar: false, realtimeRatio: null }),
    null,
    '盘中无实时量比必须返回 null，不得退回未收完的成交额比',
  );

  // 样本不足时同样不给读数
  assert.equal(
    buildVolumeReadout([bar('2026-07-01', 10, 10.5, 9.5, 10)], { completeBar: true }),
    null,
    '样本不足不得给出量能读数',
  );

  // 成交额缺失（新浪等日线源 amount 恒为 0）时回退到成交量口径，而不是不给读数
  const noAmount = barsWithRatio(1.4).map((b) => ({ ...b, amount: 0 }));
  const fallback = buildVolumeReadout(noAmount, { completeBar: true });
  assert.ok(fallback, '成交额缺失时应回退到成交量口径而非返回 null');
  assert.equal(fallback.basis, 'volume_median20', '回退口径必须显式标注');
  assert.equal(fallback.ratio, 1.4, '回退后取成交量比值');
  assert.equal(fallback.state, 'clear_expand', '回退口径沿用收盘阈值');

  // 回退成交量口径时可比性必须实测（第二轮 M4）：本源不给成交额、窗口内又刚做过 10 送 10 时，
  // 硬编码可比会把翻倍的成交量读成「极端放量」，而这正是 buildVolumeReadout 的公共读数入口
  const splitNoAmount = noAmount.map((b, i) =>
    // 最后一根做 10 送 10：开盘与最低同步腰斩，成交量翻倍
    i === noAmount.length - 1
      ? { ...b, open: b.open / 2, low: b.low / 2, high: b.high / 2, close: b.close / 2, volume: b.volume * 2 }
      : b,
  );
  assert.equal(
    buildVolumeReadout(splitNoAmount, { completeBar: true }),
    null,
    '窗口内跨除权且本源无成交额时不得给出量能读数，否则翻倍的成交量会被读成极端放量',
  );

  // 成交额与成交量都不可用时才返回 null
  assert.equal(
    buildVolumeReadout(
      barsWithRatio(1.4).map((b) => ({ ...b, amount: 0, volume: 0 })),
      { completeBar: true },
    ),
    null,
    '量额俱缺时不得编数',
  );
}

// ===== 5. 道氏：四种状态 =====

{
  // 下跌：更低高点 + 更低低点
  const bars = zigzag([100, 90, 96, 82, 88, 74]);
  const dow = computeDowStructure(bars, 'day');
  assert.equal(dow.state, 'downtrend', `更低高点+更低低点应判下跌，实际 ${dow.state}`);
  assert.ok(
    dow.rationale.some((r) => r.includes('更低高点')) && dow.rationale.some((r) => r.includes('更低低点')),
    '下跌判定须同时引用更低高点与更低低点',
  );
  assert.ok(
    dow.rationale.every((r) => !r.includes('undefined')),
    '判定依据不得出现 undefined 锚点',
  );
}
{
  // 上涨：更高高点 + 更高低点
  const bars = zigzag([80, 92, 86, 100, 94, 110]);
  const dow = computeDowStructure(bars, 'day');
  assert.equal(dow.state, 'uptrend', `更高高点+更高低点应判上涨，实际 ${dow.state}`);
  assert.ok(dow.lastConfirmedHighId?.startsWith('sw:day:high:'), '应给出最近确认高点 id');
  assert.ok(dow.lastConfirmedLowId?.startsWith('sw:day:low:'), '应给出最近确认低点 id');
}
{
  // 转折观察：低点抬高但未突破前高
  const bars = zigzag([100, 70, 95, 80, 92]);
  const dow = computeDowStructure(bars, 'day');
  assert.equal(
    dow.state,
    'transition',
    `低点抬高但未突破前高只能判转折观察，实际 ${dow.state}`,
  );
  assert.ok(
    dow.rationale.some((r) => r.includes('转折观察') || r.includes('突破待确认')),
    '过渡态须说明是转折观察或突破待确认',
  );
}
{
  // 样本不足：无确认高低点时按震荡而非猜方向
  const dow = computeDowStructure(zigzag([100, 101], 2), 'day');
  assert.equal(dow.state, 'range', '确认点不足应按震荡处理');
}

// ===== 6. 摆动点确认语义 =====

{
  const bars = zigzag([80, 100, 90, 110]);
  const swings = detectSwings(bars, 'day');
  assert.ok(swings.length >= 2, '应检出多个摆动点');
  // 高低必须交替
  for (let i = 1; i < swings.length; i++) {
    assert.notEqual(swings[i].kind, swings[i - 1].kind, '摆动点必须高低交替');
  }
  // 越靠右的点越可能未确认
  const unconfirmed = swings.filter((s) => !s.confirmed);
  assert.ok(
    unconfirmed.every((u) => swings.indexOf(u) >= swings.length - 2),
    '未确认点只应出现在序列尾部',
  );
}

// ===== 7. 缠论：包含处理与分型 =====

{
  // 方向由前两根非包含 K 线播种后，被包含的那根才合并
  const bars = [
    bar('d1', 9, 10, 8, 9.5), // 与 d2 非包含，播种方向=up
    bar('d2', 10, 13, 9, 12),
    bar('d3', 11, 12, 10, 11.5), // 被 d2 完全包含 → 合并
    bar('d4', 12, 16, 11.5, 15),
  ];
  const merged = mergeContainedBars(bars);
  assert.equal(merged.length, 3, `被包含的一根应被合并，期望 3 根，实际 ${merged.length}`);
}
{
  // 方向尚未确立时不得凭空按 up 合并：开头就出现包含关系时原样保留，等后续定方向
  const bars = [bar('d1', 10, 12, 8, 11), bar('d2', 10.5, 11, 9, 10), bar('d3', 11, 14, 10.5, 13)];
  const merged = mergeContainedBars(bars);
  assert.equal(merged.length, 3, '首对即包含关系时不得猜方向合并');
}
{
  const merged = mergeContainedBars(zigzag([80, 100, 85, 105, 90]));
  const fr = detectFractals(merged);
  for (let i = 1; i < fr.length; i++) {
    assert.notEqual(fr[i].kind, fr[i - 1].kind, '分型必须顶底交替');
  }
}

// ===== 8. 缠论：insufficient 纪律与二买 L2>L1 =====

{
  const chan = computeChanStructure(zigzag([100, 105], 5), 'day');
  assert.equal(chan.setup, 'insufficient', '样本不足必须返回 insufficient，禁止强行标点');
}
{
  // 分型不足 4 个时必须退回 insufficient，而不是拿 3 个分型硬凑买点
  const chan = computeChanStructure(zigzag([110, 70, 95, 80, 93], 9), 'day');
  assert.equal(chan.setup, 'insufficient', '分型不足 4 个必须返回 insufficient');
  assert.ok(
    chan.rationale.some((r) => r.includes('分型')),
    'insufficient 须说明是分型不足',
  );
}
{
  // L1=70 → H1=95 → L2=80（L2 > L1）应构成二买候选。
  // 需要 5 段才凑够 4 个分型（前置 top@120 + bottom/top/bottom），否则先被 insufficient 拦住。
  const bars = zigzag([100, 120, 70, 95, 80, 105], 8);
  const chan = computeChanStructure(bars, 'day');
  assert.equal(chan.setup, 'second_buy_candidate', `L2 > L1 应判二买候选，实际 ${chan.setup}`);
  assert.ok(
    chan.rationale.some((r) => r.includes('L2 > L1')),
    '二买候选必须写明 L2 > L1 的依据',
  );
  assert.ok(
    chan.rationale.some((r) => r.includes('fr:bottom:') && r.includes('fr:top:')),
    '二买依据必须引用具体分型 id，不能只给文字',
  );
}
{
  // L2 < L1（低点继续下移）不得判成二买
  const bars = zigzag([100, 120, 80, 95, 70, 90], 8);
  const chan = computeChanStructure(bars, 'day');
  assert.notEqual(chan.setup, 'second_buy_candidate', 'L2 < L1 不得判为二买候选');
}
{
  // 所有输出必须保留 candidate / none / insufficient 语义，禁止出现确定性买点
  for (const pivots of [
    [100, 120, 70, 95, 80, 105],
    [100, 80, 110, 90, 120, 100],
    [120, 100, 115, 85, 105, 75],
  ]) {
    const setup = computeChanStructure(zigzag(pivots, 8), 'day').setup;
    assert.ok(
      setup === 'none' || setup === 'insufficient' || setup.endsWith('_candidate'),
      `缠论结果必须是 none / insufficient / *_candidate，实际 ${setup}`,
    );
  }
}

// ===== 9. 确定性：同一 fixture 两次计算完全一致 =====

{
  const bars = zigzag([80, 100, 90, 112, 98, 120]);
  const a = JSON.stringify(computeDowStructure(bars, 'day'));
  const b = JSON.stringify(computeDowStructure(bars, 'day'));
  assert.equal(a, b, '道氏结构必须完全可复现');
  const c = JSON.stringify(computeChanStructure(bars, 'day'));
  const d = JSON.stringify(computeChanStructure(bars, 'day'));
  assert.equal(c, d, '缠论结构必须完全可复现');
}

console.log(
  '✅ 技术证据层自检通过（量价分母/未收完降级/不可比降级 · 道氏四态与锚点引用 · 摆动交替与确认语义 · 包含处理/分型交替 · insufficient 纪律与 L2>L1 · 可复现性）',
);
