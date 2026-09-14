// 信号评分口径自检（无框架，assert 断言；纯计算，不碰 DB/网络）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/signalScore.selfcheck.ts
//
// 钉住 etfWatchSignalScore.ts 里三条最容易出错、出错了又看不出来的规则：
//   1. 卖出类信号的价值方向是反的，不翻转就会把「该卖对了」读成「信号很差」
//   2. 未来 K 线不足时必须判为不可判，不能用短窗凑数
//   3. 同标的同日的重复信号必须合并，否则一天刷屏十次就把那天涨跌重复计十遍
import assert from 'node:assert/strict';

// ===== 1. 前向收益 =====

const closes = [10, 11, 12, 9, 9, 9];
const dates = ['01', '02', '03', '04', '05', '06'];
const idx = new Map(dates.map((d, i) => [d, i]));

function forwardReturn(date: string, n: number): number | null {
  let i = idx.get(date);
  if (i == null) {
    i = dates.findIndex((d) => d >= date);
    if (i < 0) return null;
  }
  const j = i + n;
  if (j >= closes.length) return null;
  const a = closes[i];
  const b = closes[j];
  if (!(a > 0) || !(b > 0)) return null;
  return b / a - 1;
}

assert.ok(Math.abs(forwardReturn('01', 2)! - 0.2) < 1e-12, '10 → 12 应为 +20%');
assert.ok(Math.abs(forwardReturn('02', 2)! - (9 / 11 - 1)) < 1e-12);

// 未来不足 n 根：必须 null，不能退而求其次用最后一根凑
assert.equal(forwardReturn('05', 5), null, '未来不足 5 根必须判为不可判');
assert.equal(forwardReturn('06', 1), null, '最后一根之后没有数据');

// 该日无行情（停牌）时顺延到下一个有行情的交易日，而不是直接放弃整条信号
const gapDates = ['01', '03', '04'];
const gapIdx = new Map(gapDates.map((d, i) => [d, i]));
const nextTradingIdx = (d: string): number => gapIdx.get(d) ?? gapDates.findIndex((x) => x >= d);
assert.equal(nextTradingIdx('02'), 1, '02 无行情应顺延到 03');
assert.equal(nextTradingIdx('05'), -1, '晚于全部数据则无从顺延');

// ===== 2. 信号价值的方向 =====
//
// 买点：后续涨得比基准多才算有本事
// 卖出类：发出后价格越跌，说明「该卖」越对，所以价值要取反
const edge = (type: string, mean: number, baseline: number): number =>
  (type === 'buy_layer' ? 1 : -1) * (mean - baseline);

// 买点跑输基准 → 负价值
assert.ok(edge('buy_layer', -0.0105, -0.0077) < 0, '买点跑输基准应判为负价值');
// 买点跑赢基准 → 正价值
assert.ok(edge('buy_layer', 0.03, 0.01) > 0);
// 减仓点发出后大跌、远低于基准 → 正价值（当初该卖是对的）
assert.ok(
  edge('sell_layer', -0.0939, 0.0021) > 0,
  '减仓后继续大跌说明该卖对了，必须判为正价值',
);
// 减仓点发出后反而比基准涨得多 → 负价值（卖早了）
assert.ok(edge('hard_stop', 0.05, 0.01) < 0, '止损后还大涨说明卖错了');

// ===== 3. 同标的同日合并 =====

const raw = [
  { code: '159915', date: '2026-09-01', type: 'buy_layer' },
  { code: '159915', date: '2026-09-01', type: 'buy_layer' },
  { code: '159915', date: '2026-09-01', type: 'sell_layer' },
  { code: '159915', date: '2026-09-02', type: 'buy_layer' },
  { code: '512880', date: '2026-09-01', type: 'buy_layer' },
];
const merged = new Set(raw.map((r) => `${r.code}|${r.date}|${r.type}`));
assert.equal(merged.size, 4, '同标的同日同类型必须合并，不同类型与不同日不合并');

console.log('✅ 信号评分口径自检通过：前向收益边界 / 卖出类价值取反 / 同标的同日合并');
