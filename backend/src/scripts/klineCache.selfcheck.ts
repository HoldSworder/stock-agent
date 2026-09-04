// 取数层自检（无框架，assert 断言）：日K缓存新鲜度 + 日线/分钟连续性自修正 + 成交量单位自校准
// + 除权日盘中临时 bar 参考价 + 缓存写入前的共用修正出口。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/klineCache.selfcheck.ts
import assert from 'node:assert/strict';
import type { KlineBar } from '@stock-agent/shared';
import { volumeUnitDivisor } from '../astock/market';
import { frontAdjustDaily, frontAdjustMinute } from '../datasource/adjust';
import {
  isFresh,
  isIntradayWindow,
  intradayOpenRef,
  dropsTrailingProvisional,
  mergeIntradayBar,
} from '../datasource/klineCache';
import { fetchDailyAdjusted } from '../datasource/scheduler';
import { KLINE_PROVIDERS_DAILY } from '../datasource/providers';

// 构造 Asia/Shanghai 指定时刻的 Date（UTC+8 固定偏移）
const sh = (iso: string): Date => new Date(`${iso}+08:00`);

// 1. 盘中写入 2 分钟前 → 新鲜
assert.equal(
  isFresh(sh('2026-08-03T10:28:00').toISOString(), sh('2026-08-03T10:30:00')),
  true,
  '盘中 2 分钟内的缓存应算新鲜',
);

// 2. 盘中写入 30 分钟前 → 过期（超过 10 分钟容忍）
assert.equal(
  isFresh(sh('2026-08-03T10:00:00').toISOString(), sh('2026-08-03T10:30:00')),
  false,
  '盘中超过 10 分钟应回源',
);

// 3. 收盘后当天写入 → 新鲜（当日数据已定格，多久都算数）
assert.equal(
  isFresh(sh('2026-08-03T15:10:00').toISOString(), sh('2026-08-03T21:00:00')),
  true,
  '收盘后当天写入的缓存应算新鲜',
);

// 4. 昨日收盘后写入，今日开盘前读取 → 仍可用（今天还没有新 bar）
assert.equal(
  isFresh(sh('2026-08-03T15:10:00').toISOString(), sh('2026-08-04T09:00:00')),
  true,
  '开盘前应可继续使用昨日收盘缓存',
);

// 5. 昨日写入，今日盘中读取 → 过期（必须补当日 bar，否则拿到的是昨天的线）
assert.equal(
  isFresh(sh('2026-08-03T15:10:00').toISOString(), sh('2026-08-04T10:30:00')),
  false,
  '盘中不得使用昨日缓存',
);

// 6. 昨日写入，今日午间休市读取 → 过期（11:30-13:00 非交易时段，但当日已有半天行情）
assert.equal(
  isFresh(sh('2026-08-03T15:10:00').toISOString(), sh('2026-08-04T12:00:00')),
  false,
  '开盘后即便处于午休也不得使用昨日缓存',
);

// 7. 盘中合成的临时 bar：收盘后（15:05，收盘回填之前）必须判不新鲜强制回源，
// 否则它会被当成当日完整日线返回，下游按完整日线口径解读半根 bar 的量价
assert.equal(
  isFresh(sh('2026-08-04T14:55:00').toISOString(), sh('2026-08-04T15:05:00'), true),
  false,
  '非交易时段遇到 provisional 行必须回源',
);
assert.equal(
  isFresh(sh('2026-08-04T14:55:00').toISOString(), sh('2026-08-04T15:05:00'), false),
  true,
  '同一时刻的正式收盘行仍应算新鲜（provisional 判据不得误伤正式行）',
);
// 8. 临时 bar 在盘中仍按 10 分钟容忍
assert.equal(
  isFresh(sh('2026-08-04T10:28:00').toISOString(), sh('2026-08-04T10:30:00'), true),
  true,
  '盘中 10 分钟内的临时 bar 可用',
);

// 9. 盘中增量闸门：开盘前/收盘后/周末一律不得写当日 bar（否则报价 price=昨收，等于伪造）
assert.equal(isIntradayWindow(sh('2026-08-04T09:00:00')), false, '09:00 不得追加当日 bar');
assert.equal(isIntradayWindow(sh('2026-08-04T09:29:00')), false, '09:29 不得追加当日 bar');
assert.equal(isIntradayWindow(sh('2026-08-04T10:00:00')), true, '盘中应允许追加');
assert.equal(isIntradayWindow(sh('2026-08-04T12:00:00')), true, '午休仍在开盘~收盘窗口内，允许追加');
assert.equal(isIntradayWindow(sh('2026-08-04T15:00:00')), false, '15:00 起交由收盘预热写正式行');
assert.equal(isIntradayWindow(sh('2026-08-08T10:00:00')), false, '非交易日（周六）不得追加');

// 9b. 新鲜度判据必须排除法定节假日。只按星期与时钟判的话，国庆这种整周休市日
// 会被当成「盘中」，当天写入的缓存每 10 分钟就对全市场整体失效一次，
// 休市日反而把上游打满。10-01 是周四，落在 09:30-11:30 内。
assert.equal(
  isFresh(sh('2026-10-01T09:00:00').toISOString(), sh('2026-10-01T10:30:00')),
  true,
  '节假日不是交易日，当天写入的缓存不应按盘中 10 分钟窗口失效',
);
assert.equal(
  isFresh(sh('2026-08-04T09:00:00').toISOString(), sh('2026-08-04T10:30:00')),
  false,
  '真正的交易日仍须按 10 分钟窗口失效（节假日判据不得放宽正常盘中）',
);

// ===== 9c. 回源失败兜底：非交易时段的末根临时 bar 必须剔除 =====
// 临时 bar 的 high/low/close 由 max/min(参考价, 现价) 合成必然共线，
// 当成已收盘完整日线交给下游，会把「收盘位置」算成恒等于 1.0 或 0.0 的伪信号。
assert.equal(
  dropsTrailingProvisional({ provisional: 1 }, sh('2026-08-04T15:05:00')),
  true,
  '收盘后兜底返回缓存时必须剔除末根临时 bar',
);
assert.equal(
  dropsTrailingProvisional({ provisional: 1 }, sh('2026-08-04T10:30:00')),
  false,
  '盘中读取临时 bar 是既有行为，不得因本修复被改掉',
);
assert.equal(
  dropsTrailingProvisional({ provisional: 0 }, sh('2026-08-04T15:05:00')),
  false,
  '正式收盘行不得被误剔除',
);
assert.equal(dropsTrailingProvisional(undefined, sh('2026-08-04T15:05:00')), false, '空缓存不得报错');

// ===== 10. 日线连续性自修正（frontAdjustDaily）=====

/** 造一根日线；amount 缺省按 close×volume 估 */
const bar = (
  time: string,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 1000,
  amount?: number,
): KlineBar => ({ time, open, high, low, close, volume, amount: amount ?? close * volume });

// ===== 9d. 盘中临时 bar 必须在已有当日行上累积，不能整行覆盖 =====
// K线弹窗 fresh=1 已把真实当日 OHLC 写进这一行；整行盖成 max/min(参考价, 现价)
// 会把真实最高/最低抹平，当日振幅与 ATR 被系统性低估。
{
  // amount 单位是元、volume 单位是手（1 手 = 100 股），故 amount = close × volume × 100。
  // 早先这里按 close × volume 估 amount，把两个量纲混在一起，正好掩盖了下面 9e 要锁的问题。
  const amt = (close: number, lots: number): number => close * lots * 100;
  const real = bar('2026-08-04', 10, 12, 9, 11, 5000, amt(11, 5000));
  const quote = bar('2026-08-04', 11, 11.5, 10.8, 11.5, 6000, amt(11.5, 6000));
  const merged = mergeIntradayBar(real, quote);
  assert.equal(merged.open, 10, '已有真实开盘价不得被报价参考价覆盖');
  assert.equal(merged.high, 12, '真实最高价必须保留（新价更低时不得下调）');
  assert.equal(merged.low, 9, '真实最低价必须保留');
  assert.equal(merged.close, 11.5, '收盘价应更新为最新报价');
  assert.equal(merged.volume, 6000, '当日累计量只增不减');

  // 新价创出新高/新低时要合并进去
  const breakout = mergeIntradayBar(real, bar('2026-08-04', 11, 13, 8.5, 13, 7000, amt(13, 7000)));
  assert.equal(breakout.high, 13, '新价创新高应更新最高价');
  assert.equal(breakout.low, 8.5, '新价创新低应更新最低价');

  // 无当日行时退化为纯合成（未预热/开盘第一轮）
  const synth = bar('2026-08-04', 11, 11.5, 10.8, 11.5, 6000, amt(11.5, 6000));
  assert.deepEqual(mergeIntradayBar(undefined, synth), synth, '无当日行时应原样使用合成 bar');

  // 除权/份额折算日：折算前写下的旧行停在旧价位，累积会把旧高点带进新价位的 bar，
  // 正是 intradayOpenRef 要避免的假 K，必须整行弃用重造
  const preSplit = bar('2026-07-10', 1.945, 1.95, 1.9, 1.92, 4000, 7700);
  const postSplit = bar('2026-07-10', 0.905, 0.91, 0.9, 0.905, 9000, 8145);
  assert.deepEqual(
    mergeIntradayBar(preSplit, postSplit),
    postSplit,
    '折算日的旧价位行必须整行弃用，不得把旧高点累积进来',
  );

  // 9e. volume 必须与合并后的 amount 同源重算，不能对 volume 自身取 max。
  // volume 不是上游给的累计量，而是 amount ÷ 现价 ÷ 每手股数估出来的：分母随价格变，
  // 价格上行时同一份成交额会推出更小的手数。对 volume 取 max 会把当日量能永久钉在
  // 「价格最低那一刻算出的最大估值」上，直接抬高量比与放量确认。
  const lowPrice = bar('2026-08-04', 9, 9, 9, 9, 10_000, amt(9, 10_000)); // 900 万元 → 9 元时 10000 手
  const highPrice = bar('2026-08-04', 9, 11, 9, 11, 0, 10_000_000); // 成交额涨到 1000 万，现价 11
  const rebased = mergeIntradayBar(lowPrice, highPrice);
  assert.equal(rebased.amount, 10_000_000, '成交额是真正的累计值，取 max');
  // 1000 万 ÷ 11 ÷ 100 ≈ 9091 手：比低价时算出的 10000 手更小，但这才是与 amount 一致的读数
  assert.equal(rebased.volume, Math.round(10_000_000 / 11 / 100), 'volume 必须按合并后的 amount 与最新价重算');
  assert.ok(rebased.volume < lowPrice.volume, '价格上行时估算手数应下降，不得被 max 钉住');
}

{
  // 复刻线上实例：159516 于 2026-07-10 做 1:2 份额折算，
  // 名义前复权的源仍留下 open 0.973 / 前收 1.945 = 0.5003 的假跳空
  const raw = [
    bar('2026-07-01', 1.975, 2.106, 1.947, 1.993, 4000),
    bar('2026-07-09', 1.805, 1.945, 1.777, 1.945, 5000),
    bar('2026-07-10', 0.973, 1.004, 0.903, 0.905, 9000),
    bar('2026-07-13', 0.873, 0.927, 0.854, 0.865, 8000),
  ];
  const fixed = frontAdjustDaily(raw);
  const f = 0.973 / 1.945;

  assert.equal(fixed.length, raw.length, '修正不得增删 bar');
  // 折算前的两根按因子缩放
  assert.ok(Math.abs(fixed[1].close - 1.945 * f) < 1e-9, `07-09 收盘应缩放为 ${1.945 * f}`);
  assert.ok(Math.abs(fixed[0].high - 2.106 * f) < 1e-9, '07-01 高点应缩放（2.106 → 约 1.054）');
  assert.ok(fixed[0].high > 1.05 && fixed[0].high < 1.06, `07-01 高点应落在 1.05~1.06，实际 ${fixed[0].high}`);
  // 折算当日及之后原样保留
  assert.deepEqual(fixed[2], raw[2], '折算当日及之后的 bar 不得改动');
  assert.deepEqual(fixed[3], raw[3], '折算之后的 bar 不得改动');
  // 跳空被抹平：修正后相邻日的开盘/前收比值回到正常量级
  const gap = fixed[2].open / fixed[1].close;
  assert.ok(Math.abs(gap - 1) < 0.05, `修正后 07-10 开盘相对前收应回到正常量级，实际比值 ${gap}`);
  // 成交量反向缩放（折算后份额变化，以份计的历史成交量需放大才可比），成交额不动
  assert.ok(Math.abs(fixed[1].volume - 5000 / f) < 1e-6, '历史成交量应按因子反向缩放');
  assert.equal(fixed[1].amount, raw[1].amount, '成交额与折算无关，不得改动');

  // 幂等：已连续的序列再跑一次是空转
  const twice = frontAdjustDaily(fixed);
  assert.deepEqual(twice, fixed, 'frontAdjustDaily 必须幂等');
}

{
  // 已正确复权（无跳空）的序列必须原样返回，避免误伤正常数据
  const ok = [
    bar('2026-08-01', 1.0, 1.02, 0.98, 1.0),
    bar('2026-08-03', 1.0, 1.05, 0.99, 1.04),
    bar('2026-08-04', 1.04, 1.08, 1.03, 1.06),
  ];
  assert.deepEqual(frontAdjustDaily(ok), ok, '无除权序列应原样返回');
}

{
  // 真实涨跌停跳空不得被误判为除权：一字跌停 -10% 与科创板 +20% 开盘
  const limitDown = [
    bar('2026-08-03', 10, 10.2, 9.9, 10),
    bar('2026-08-04', 9, 9, 9, 9),
  ];
  assert.deepEqual(frontAdjustDaily(limitDown), limitDown, '-10% 跌停开盘不得被当成除权');
  const limitUp = [
    bar('2026-08-03', 10, 10.2, 9.9, 10),
    bar('2026-08-04', 12, 12, 12, 12),
  ];
  assert.deepEqual(frontAdjustDaily(limitUp), limitUp, '+20% 涨停开盘不得被当成除权');

  // 按板别收紧的判据：主板一天最多跌 10%，跌 25% 只可能是除权。
  // 实测 000034（深市主板）2026-05-19 跳空 -25.5%，旧的一刀切阈值 0.35 漏判，
  // 导致此前历史价格整体高出 1.4 倍——拿它算「创新高」会系统性漏报。
  const mainBoardXr = [
    bar('2026-05-16', 33.37, 33.5, 33, 33.37),
    bar('2026-05-19', 24.86, 25, 24.5, 24.86),
  ];
  const fixedXr = frontAdjustDaily(mainBoardXr, undefined, { code: '000034' });
  assert.ok(
    Math.abs(fixedXr[0].close - 24.86) < 0.5,
    `主板 -25% 跳空必须判为除权并回缩历史，实际 ${fixedXr[0].close}`,
  );
  // 不传 code 时保持原行为（阈值 0.35），避免既有调用点静默变敏感
  assert.deepEqual(
    frontAdjustDaily(mainBoardXr),
    mainBoardXr,
    '不传 code 时沿用全市场最宽阈值，行为不变',
  );
  // 板别差异：-20% 在主板不可能（要判除权），在创业板是跌停（合法行情，不得判除权）
  const drop20 = [
    bar('2026-05-16', 10, 10.1, 9.9, 10),
    bar('2026-05-19', 8, 8.1, 7.9, 8),
  ];
  assert.notDeepEqual(
    frontAdjustDaily(drop20, undefined, { code: '600000' }),
    drop20,
    '主板 -20% 超过 ±10% 上限，必须判为除权',
  );
  assert.deepEqual(
    frontAdjustDaily(drop20, undefined, { code: '300750' }),
    drop20,
    '创业板 -20% 正好是跌停，属真实行情，不得当成除权',
  );
  // 主板跌停 -10% 仍不得误判（余量 2 个百分点）
  assert.deepEqual(
    frontAdjustDaily(limitDown, undefined, { code: '600000' }),
    limitDown,
    '主板 -10% 跌停不得被当成除权',
  );

  // 关键方向约束：创业板/科创板新股上市前 5 日无涨跌幅限制，次日开盘可以翻倍。
  // 除权只会让价格变低，故向上的大跳空一律不得修正，否则真实暴涨会被当成除权抹掉。
  const newListing = [
    bar('2026-08-03', 10, 20, 9, 18),
    bar('2026-08-04', 36, 40, 35, 38),
  ];
  assert.deepEqual(
    frontAdjustDaily(newListing),
    newListing,
    '新股上市次日开盘翻倍（r≈2）不得被当成除权',
  );
}

{
  // 连续两次除权：更早的 bar 要把两个因子都乘上
  const raw = [
    bar('2026-06-01', 4, 4, 4, 4),
    bar('2026-06-02', 2, 2, 2, 2), // 因子 0.5
    bar('2026-06-03', 1, 1, 1, 1), // 因子 0.5
  ];
  const fixed = frontAdjustDaily(raw);
  assert.equal(fixed[0].close, 1, '最早的 bar 应累乘两次 0.5：4 → 1');
  assert.equal(fixed[1].close, 1, '中间的 bar 应乘一次 0.5：2 → 1');
  assert.equal(fixed[2].close, 1, '最后一根不动');
}

// 单根/空序列不得抛错
assert.deepEqual(frontAdjustDaily([]), []);
assert.equal(frontAdjustDaily([bar('2026-08-04', 1, 1, 1, 1)]).length, 1);

// ===== 10b. bar 内除权检测（周/月线专用）=====
// 除权发生在周中时，周线那根 bar 的 open 在折算前、close 在折算后，
// 跨 bar 的「开盘/前收」看不到跳空。不补这条，周线波段锚点会取到折算前的高点，
// 黄金分割回撤/扩展整套失真（实测 159516 周线高点 2.11 vs 日线 1.05）。

{
  // 复刻 159516：折算周 open 1.755（折算前）、high 1.79、close 0.905（折算后）
  const weekly = [
    bar('2026-06-29', 1.7, 1.8, 1.68, 1.73, 5000),
    bar('2026-07-06', 1.755, 1.79, 0.9, 0.905, 9000),
    bar('2026-07-13', 0.873, 0.93, 0.85, 0.865, 8000),
  ];

  // 不开 intrabar：跨 bar 无跳空（1.755/1.73 ≈ 1.01），检测不到
  assert.deepEqual(frontAdjustDaily(weekly), weekly, '跨 bar 检测看不到 bar 内除权，应原样返回');

  // 开 intrabar：close/open = 0.5157 < 0.55，判定为除权
  const fixed = frontAdjustDaily(weekly, undefined, { intrabar: true });
  const f = 0.905 / 1.755;
  assert.ok(Math.abs(fixed[1].open - 1.755 * f) < 1e-9, '折算 bar 的 open 应缩放到折算后口径');
  assert.ok(Math.abs(fixed[1].high - 1.79 * f) < 1e-9, '折算 bar 的 high 应缩放（波段锚点靠它）');
  assert.equal(fixed[1].close, 0.905, '折算 bar 的 close 已是折算后价，不得再缩放');
  assert.equal(fixed[1].low, 0.9, '折算 bar 的 low 已是折算后价，不得再缩放');
  assert.ok(fixed[1].high < 1, `修正后 high 应落到 1 以下，实际 ${fixed[1].high}`);
  assert.ok(Math.abs(fixed[0].close - 1.73 * f) < 1e-9, '折算之前的 bar 应整根缩放');
  assert.deepEqual(fixed[2], weekly[2], '折算之后的 bar 不得改动');

  // 真实单周暴跌不得被误判：5 个交易日连续跌停理论上限约 -41%，达不到 -45% 阈值
  const crash = [
    bar('2026-06-29', 10, 10, 10, 10),
    bar('2026-07-06', 10, 10, 5.9, 5.9),
    bar('2026-07-13', 5.9, 6, 5.5, 5.6),
  ];
  assert.deepEqual(
    frontAdjustDaily(crash, undefined, { intrabar: true }),
    crash,
    '一周 -41% 是涨跌停可达的真实行情，不得判为除权',
  );
}

{
  // bar 内因子与跨 bar 因子叠加：两个必须叠乘。
  // 只应用 bar 内因子会让那根 bar 停在旧基准，与下一根之间重新出现假跳空——
  // 正是本函数要消除的东西，而热门 ETF 一年内做两次折算完全可能。
  const raw = [
    bar('w1', 4, 4.2, 3.9, 4),
    bar('w2', 4, 4.2, 1.9, 2), // bar 内 1:2
    bar('w3', 2, 2.1, 1.9, 2),
    bar('w4', 1, 1.05, 0.95, 1), // 跨 bar 1:2
  ];
  const fixed = frontAdjustDaily(raw, undefined, { intrabar: true });
  // w2 的 open/high 吃两次因子（0.25），low/close 只吃跨 bar 那次（0.5）
  assert.ok(Math.abs(fixed[1].open - 1) < 1e-9, `w2 open 应为 4×0.25=1，实际 ${fixed[1].open}`);
  assert.ok(Math.abs(fixed[1].high - 1.05) < 1e-9, `w2 high 应为 4.2×0.25，实际 ${fixed[1].high}`);
  assert.ok(Math.abs(fixed[1].close - 1) < 1e-9, `w2 close 应为 2×0.5=1，实际 ${fixed[1].close}`);
  assert.ok(Math.abs(fixed[0].close - 1) < 1e-9, 'w1 应吃满两次因子');
  // 最终诉求：修正后不得残留任何假跳空
  for (let i = 1; i < fixed.length; i++) {
    const gap = Math.abs(fixed[i].close / fixed[i - 1].close - 1);
    assert.ok(gap < 0.05, `修正后 ${fixed[i].time} 仍残留 ${(gap * 100).toFixed(1)}% 跳空`);
  }
  // 成交额不随除权变化，故 close×volume 必须守恒（volume 只除 f、不除 self）
  for (let i = 0; i < raw.length; i++) {
    assert.ok(
      Math.abs(fixed[i].close * fixed[i].volume - raw[i].close * raw[i].volume) < 1e-6,
      `${raw[i].time} 的「收盘 × 成交量」应守恒`,
    );
  }
}

// ===== 11. 分钟前复权的量能口径必须与日线一致（M2）=====
{
  // 折算因子取整 0.5：日线 07-10 开盘 0.9725 / 前收 1.945 = 0.5，便于精确比对
  const rawDaily = [
    bar('2026-07-09', 1.805, 1.945, 1.777, 1.945, 5000),
    bar('2026-07-10', 0.9725, 1.004, 0.903, 0.905, 9000),
  ];
  const daily = frontAdjustDaily(rawDaily);
  assert.equal(daily[0].volume, 10000, '前提校验：日线折算前那根成交量应放大一倍');

  // 分钟线是不复权源：07-09 两根合计 5000 手，07-10 两根合计 9000 手
  const rawMinute = [
    bar('2026-07-09 14:30', 1.9, 1.95, 1.89, 1.94, 2000),
    bar('2026-07-09 15:00', 1.94, 1.95, 1.93, 1.945, 3000),
    bar('2026-07-10 14:30', 0.92, 0.93, 0.9, 0.91, 4000),
    bar('2026-07-10 15:00', 0.91, 0.91, 0.9, 0.905, 5000),
  ];
  const minute = frontAdjustMinute(rawMinute, daily);
  const volOn = (d: string): number =>
    minute.filter((b) => b.time.startsWith(d)).reduce((s, b) => s + b.volume, 0);

  assert.equal(
    volOn('2026-07-09'),
    daily[0].volume,
    `折算前分钟量应与日线同口径（应为 ${daily[0].volume}，实际 ${volOn('2026-07-09')}）`,
  );
  assert.equal(volOn('2026-07-10'), daily[1].volume, '折算当日 factor=1，分钟量应原样等于日线量');
  // 价格仍按同一因子正向缩放，量的缩放不得反过来影响价
  assert.ok(Math.abs(minute[1].close - 1.945 * 0.5) < 1e-9, '分钟收盘应按同一因子缩放');
}

// ===== 12. 除权日盘中临时 bar 的开盘参考价（M3）=====
{
  // 报价源在折算日给未除权昨收：必须弃用，否则造出 open/close 差一倍的假 K
  assert.equal(intradayOpenRef(1.945, 0.905), 0.905, '折算日的未除权昨收必须弃用，改取现价');
  // 正常波动/跌停不得误伤（-10% 远小于 SPLIT_GAP）
  assert.equal(intradayOpenRef(1.0, 0.9), 1.0, '跌停不得被当成除权而弃用昨收');
  assert.equal(intradayOpenRef(2.0, 1.4), 2.0, '-30% 仍在阈值内，昨收可用');
  // 向上大跳空是新股无涨跌幅限制的真实暴涨，昨收仍然可信
  assert.equal(intradayOpenRef(10, 25), 10, '向上翻倍不得弃用昨收');
  // 昨收缺失时退化为现价（不得填 0）
  assert.equal(intradayOpenRef(0, 1.2), 1.2, '昨收缺失应退化为现价');

  // 合成出的临时 bar 不再是假 K，且折算当天就能被 frontAdjustDaily 识别
  const price = 0.905;
  const ref = intradayOpenRef(1.945, price);
  const provisional = bar('2026-07-10', ref, Math.max(ref, price), Math.min(ref, price), price, 9000);
  assert.ok(
    Math.abs(provisional.close / provisional.open - 1) < 0.35,
    `临时 bar 不得留下 open/close 差一倍的假 K（open ${provisional.open} / close ${provisional.close}）`,
  );
  const fixed = frontAdjustDaily([bar('2026-07-09', 1.805, 1.945, 1.777, 1.945, 5000), provisional]);
  assert.ok(
    Math.abs(fixed[0].close - 1.945 * (price / 1.945)) < 1e-9,
    '折算当日（含盘中临时行）必须被识别，历史行应已缩放',
  );
}

// ===== 13. 缓存写入前的共用修正出口（H2）=====
// 预热/收盘回填/全量重刷与按需回源都调 fetchDailyAdjusted，故只需验证这一出口已带修正。
// 不做真实取数：临时插一个 provider 返回带假跳空的原始序列（sourceId 借用恒启用的 'local'，
// 未在 registry 注册的 id 会被 isSourceEnabled 判禁用而跳过）。
{
  const raw = [
    bar('2026-07-09', 1.805, 1.945, 1.777, 1.945, 5000),
    bar('2026-07-10', 0.973, 1.004, 0.903, 0.905, 9000),
  ];
  KLINE_PROVIDERS_DAILY.unshift({ sourceId: 'local', fn: async () => raw.map((b) => ({ ...b })) });
  try {
    const out = await fetchDailyAdjusted('159516', '1.159516', 2, { quiet: true });
    const gap = out[1].open / out[0].close;
    assert.ok(
      Math.abs(gap - 1) < 0.05,
      `写入缓存的序列不得含假跳空（开盘/前收 = ${gap}，说明共用出口漏了 frontAdjustDaily）`,
    );
    assert.ok(out[0].volume > 5000, '折算前的成交量应已放大（修正确实生效，而非恰好无跳空）');
  } finally {
    KLINE_PROVIDERS_DAILY.shift();
  }
}

// ===== 14. mootdx volume 单位自校准 =====
// sidecar 背后轮换多个通达信节点，同一标的相隔几分钟可能一次给「手」一次给「股」，
// 故不能写死系数，必须按响应用自带 amount 反推。

{
  /** 造一根「vol 用手」的 bar：amount = 均价 × vol × 100 */
  const inHand = (close: number, vol: number): KlineBar => ({
    time: '2026-08-03',
    open: close,
    high: close,
    low: close,
    close,
    volume: vol,
    amount: close * vol * 100,
  });
  /** 造一根「vol 用股」的 bar：amount = 均价 × vol */
  const inShare = (close: number, vol: number): KlineBar => ({
    ...inHand(close, vol),
    amount: close * vol,
  });
  // 末根一律不参与判定（当日未收盘那根口径与结算后不一致），故要多造一根垫在最后
  const tail = inHand(1, 1);

  assert.equal(
    volumeUnitDivisor([inHand(0.6, 1000), inHand(0.6, 2000), inHand(0.6, 3000), tail]),
    1,
    'vol 已是手时不得换算',
  );
  assert.equal(
    volumeUnitDivisor([inShare(0.6, 1000), inShare(0.6, 2000), inShare(0.6, 3000), tail]),
    100,
    'vol 是股时应除 100 换算成手',
  );
  // 样本不足不猜，按默认「手」处理
  assert.equal(volumeUnitDivisor([inShare(0.6, 1000), tail]), 1, '样本不足时不得猜单位');
  // 缺成交额无法反推，同样按默认处理
  assert.equal(
    volumeUnitDivisor([
      { ...inHand(0.6, 1000), amount: 0 },
      { ...inHand(0.6, 2000), amount: 0 },
      { ...inHand(0.6, 3000), amount: 0 },
      tail,
    ]),
    1,
    '无成交额时不得猜单位',
  );
  // 末根不参与判定：唯一的「股」样本在末根时，判定应落到其余的「手」样本上
  assert.equal(
    volumeUnitDivisor([inHand(0.6, 1000), inHand(0.6, 2000), inHand(0.6, 3000), inShare(0.6, 4000)]),
    1,
    '当日未结算那根不得参与单位判定',
  );
}

console.log(
  '✅ 取数层自检通过（缓存新鲜度含节假日 · 盘中增量闸门 · 兜底剔除临时bar · 临时bar累积不覆盖 · 日线连续性自修正与幂等 · 分钟量能同口径 · 除权日临时bar参考价 · 缓存写入前共用修正出口 · mootdx 成交量单位自校准）',
);
