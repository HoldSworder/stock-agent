// 信号评分口径自检（无框架，assert 断言）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/signalScore.selfcheck.ts
//
// 直接钉 etfWatchSignalScore.ts 导出的真实实现，不复刻一份——复刻的自检在实现改坏时
// 不会变红，等于钉了个寂寞。被钉住的是三条最容易出错、出错了又看不出来的规则：
//   1. 卖出类信号的价值方向是反的，不翻转就会把「该卖对了」读成「信号很差」
//   2. 未来 K 线不足、或顺延太久，必须判为不可判，不能凑数
//   3. 同标的同日的重复信号必须合并，否则一天刷屏十次就把那天涨跌重复计十遍
import assert from 'node:assert/strict';
import {
  forwardReturnOn,
  rollForwardDays,
  signalEdge,
  type Series,
} from './etfWatchSignalScore';

/** 由收盘价数组造一段序列，日期按 2026-01-01 起逐日递增（仅用于断言，不必是真交易日） */
function makeSeries(closes: number[], dates?: string[]): Series {
  const ds =
    dates ??
    closes.map((_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
  return { dates: ds, closes, idx: new Map(ds.map((d, i) => [d, i])) };
}

// ===== 1. 前向收益 =====

const s = makeSeries([10, 11, 12, 9, 9, 9]);

assert.ok(Math.abs(forwardReturnOn(s, '2026-01-01', 2)! - 0.2) < 1e-12, '10 → 12 应为 +20%');
assert.ok(Math.abs(forwardReturnOn(s, '2026-01-02', 2)! - (9 / 11 - 1)) < 1e-12);

// 未来不足 n 根：必须 null，不能退而求其次用最后一根凑
assert.equal(forwardReturnOn(s, '2026-01-05', 5), null, '未来不足 5 根必须判为不可判');
assert.equal(forwardReturnOn(s, '2026-01-06', 1), null, '最后一根之后没有数据');

// 序列不存在
assert.equal(forwardReturnOn(undefined, '2026-01-01', 1), null);

// ===== 2. 顺延 =====

assert.equal(rollForwardDays('2026-01-01', '2026-01-08'), 7);
assert.equal(rollForwardDays('坏日期', '2026-01-08'), Number.POSITIVE_INFINITY);

// 停牌几天：顺延到下一个有行情的交易日，仍可判
const gap = makeSeries([10, 11, 12], ['2026-01-01', '2026-01-05', '2026-01-06']);
assert.ok(
  forwardReturnOn(gap, '2026-01-03', 1) != null,
  '停牌两天应顺延到 01-05，仍可判',
);

// 顺延太久必须放弃。没有这条上限，池里晚上市的标的会在它上市之前的每一天
// 都被顺延到首个交易日，同一段收益重复计入每一天的池均值，用的还是当时不存在的行情
const late = makeSeries([10, 11], ['2026-03-01', '2026-03-02']);
assert.equal(
  forwardReturnOn(late, '2026-01-01', 1),
  null,
  '顺延超过上限必须判为不可判，不得借用尚未上市期间的行情',
);

// ===== 3. 信号价值的方向 =====

// 买点跑输基准 → 负价值；跑赢 → 正价值
assert.ok(signalEdge('buy_layer', -0.0105, -0.0077) < 0, '买点跑输基准应判为负价值');
assert.ok(signalEdge('buy_layer', 0.03, 0.01) > 0);
// 减仓点发出后继续大跌、远低于基准 → 正价值（当初该卖是对的）
assert.ok(
  signalEdge('sell_layer', -0.0939, 0.0021) > 0,
  '减仓后继续大跌说明该卖对了，必须判为正价值',
);
// 止损后反而大涨 → 负价值（卖错了）
assert.ok(signalEdge('hard_stop', 0.05, 0.01) < 0, '止损后还大涨说明卖错了');

// ===== 4. 同标的同日合并 =====

const raw = [
  { code: '159915', date: '2026-09-01', type: 'buy_layer' },
  { code: '159915', date: '2026-09-01', type: 'buy_layer' },
  { code: '159915', date: '2026-09-01', type: 'sell_layer' },
  { code: '159915', date: '2026-09-02', type: 'buy_layer' },
  { code: '512880', date: '2026-09-01', type: 'buy_layer' },
];
const merged = new Set(raw.map((r) => `${r.code}|${r.date}|${r.type}`));
assert.equal(merged.size, 4, '同标的同日同类型必须合并，不同类型与不同日不合并');

console.log(
  '✅ 信号评分口径自检通过：前向收益边界 / 顺延上限 / 卖出类价值取反 / 同标的同日合并',
);
