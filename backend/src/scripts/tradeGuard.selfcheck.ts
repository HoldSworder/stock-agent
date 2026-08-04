// mx_trade 风控护栏自检（无框架，assert 断言）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/tradeGuard.selfcheck.ts
import assert from 'node:assert/strict';
import {
  MAX_TRADE_REJECTS,
  SINGLE_POS_CAP_PCT,
  guardMxTradeParams,
  isTradeRejectCapped,
  noteTradeReject,
} from '../miaoxiang/tradeGuard';

// 1. 奇数股数下取整到 100 倍（250 → 200）
const r1 = guardMxTradeParams({ side: 'sell', qty: 250, price: 10, useMarketPrice: false, limitUp: 11, limitDown: 9 });
assert.equal(r1.ok, true, '250 股取整后应放行');
assert.equal(r1.qty, 200, '250 应取整为 200');
assert.ok(r1.notes.some((n) => n.includes('100 整数倍')), '应记录取整说明');

// 2. 不足 100 股拒单（奇数小单）
const r2 = guardMxTradeParams({ side: 'sell', qty: 98, price: 10, useMarketPrice: false });
assert.equal(r2.ok, false, '98 股不足 100 应拒单');
assert.ok(r2.rejectReason?.includes('不足'), '拒单原因应说明不足 100');

// 3. 卖单价格量纲错乱（10 元的票报 898）→ 判为写错单位直接拒单，不得静默改成跌停价即成
const r3 = guardMxTradeParams({ side: 'sell', qty: 5900, price: 898, useMarketPrice: false, limitUp: 11, limitDown: 9 });
assert.equal(r3.ok, false, '远离涨跌停区间的价格应判量纲错乱拒单');
assert.ok(r3.rejectReason?.includes('量纲'), '拒单原因应指明量纲错乱');

// 4. 买单价格量纲错乱（0.5 远低于跌停）→ 同样拒单，不得改成涨停价即成买入
const r4 = guardMxTradeParams({ side: 'buy', qty: 100, price: 0.5, useMarketPrice: false, limitUp: 11, limitDown: 9 });
assert.equal(r4.ok, false, '买单价格量纲错乱应拒单，改成涨停价等于替用户下了没打算下的即成单');

// 4b. 贴边小幅越界（追价意图）仍按即成修正放行
const r4b = guardMxTradeParams({ side: 'buy', qty: 100, price: 11.5, useMarketPrice: false, limitUp: 11, limitDown: 9 });
assert.equal(r4b.ok, true, '小幅越界应视为追价意图，按即成修正放行');
assert.equal(r4b.price, 11, '小幅越界的买单应修正为涨停价');
const r4c = guardMxTradeParams({ side: 'sell', qty: 100, price: 8.5, useMarketPrice: false, limitUp: 11, limitDown: 9 });
assert.equal(r4c.ok, true);
assert.equal(r4c.price, 9, '小幅越界的卖单应修正为跌停价');

// 5. 买入超单票 30% 上限 → 数量下调
// 总资产 100 万，价 10 元，上限 30 万 = 30000 股；请求 37000 股应压回 30000
const r5 = guardMxTradeParams({ side: 'buy', qty: 37000, price: 10, useMarketPrice: false, limitUp: 11, limitDown: 9, totalAsset: 1_000_000 });
assert.equal(r5.ok, true);
assert.equal(r5.qty, 30000, `应压回 ${SINGLE_POS_CAP_PCT * 100}% 上限对应股数 30000`);
assert.ok(r5.notes.some((n) => n.includes('上限')), '应记录超配下调');

// 6. 市价单不改价
const r6 = guardMxTradeParams({ side: 'buy', qty: 300, useMarketPrice: true, limitUp: 11, limitDown: 9 });
assert.equal(r6.ok, true);
assert.equal(r6.price, undefined, '市价单价格应保持未定义');

// 7. 缺涨跌停时仅取整、不改价
const r7 = guardMxTradeParams({ side: 'sell', qty: 550, price: 898, useMarketPrice: false });
assert.equal(r7.ok, true);
assert.equal(r7.qty, 500, '缺涨跌停仍应取整');
assert.equal(r7.price, 898, '缺涨跌停不修正价格');

// 8. 合法单不产生多余修正
const r8 = guardMxTradeParams({ side: 'buy', qty: 2000, price: 10, useMarketPrice: false, limitUp: 11, limitDown: 9, totalAsset: 1_000_000 });
assert.equal(r8.ok, true);
assert.equal(r8.qty, 2000);
assert.equal(r8.price, 10);
assert.equal(r8.notes.length, 0, '合法单不应有修正说明');

// 9. 单票上限按「已有持仓 + 本单」累计判定：同一标的分多次小额买入不得累积突破 30%
// 总资产 100 万、上限 30 万；已持有 25 万时，请求买 6 万（6000 股 × 10）只应放行剩余 5 万 = 5000 股
const r9 = guardMxTradeParams({
  side: 'buy',
  qty: 6000,
  price: 10,
  useMarketPrice: false,
  limitUp: 11,
  limitDown: 9,
  totalAsset: 1_000_000,
  currentPositionValue: 250_000,
});
assert.equal(r9.ok, true);
assert.equal(r9.qty, 5000, '应只放行补到上限所需的 5000 股');
assert.ok(r9.notes.some((n) => n.includes('已持有')), '应说明已有持仓参与了上限计算');

// 9b. 已达上限后再买，剩余预算不足 1 手 → 拒单
const r9b = guardMxTradeParams({
  side: 'buy',
  qty: 1000,
  price: 10,
  useMarketPrice: false,
  totalAsset: 1_000_000,
  currentPositionValue: 300_000,
});
assert.equal(r9b.ok, false, '已达单票上限应拒单');
assert.ok(r9b.rejectReason?.includes('已持有'), '拒单原因应说明已达上限');

// 9c. 不传持仓市值时退化为只看本单金额（向后兼容，行为同修复前）
const r9c = guardMxTradeParams({ side: 'buy', qty: 37000, price: 10, useMarketPrice: false, totalAsset: 1_000_000 });
assert.equal(r9c.qty, 30000, '未提供持仓市值时应退化为只看本单金额');

// 10. 非有限数量直接拒单：floorLot(NaN) 得 NaN，不拦会一路放行到 qty:NaN
for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
  const r10 = guardMxTradeParams({ side: 'buy', qty: bad, price: 10, useMarketPrice: false });
  assert.equal(r10.ok, false, `qty=${bad} 应拒单`);
  assert.equal(r10.qty, 0, '拒单时数量应为 0，不得回传 NaN');
}

// 11. 拒单熔断：同 run 同方向同标的累计到上限即熔断；换 run / 换方向 / 换标的互不影响
assert.equal(isTradeRejectCapped('run-a', 'sell', '600206'), false, '未拒单前不应熔断');
for (let i = 1; i < MAX_TRADE_REJECTS; i++) {
  assert.equal(noteTradeReject('run-a', 'sell', '600206'), i, `第 ${i} 次拒单计数应为 ${i}`);
  assert.equal(isTradeRejectCapped('run-a', 'sell', '600206'), false, '未达上限不应熔断');
}
assert.equal(noteTradeReject('run-a', 'sell', '600206'), MAX_TRADE_REJECTS, '应累计到上限');
assert.equal(isTradeRejectCapped('run-a', 'sell', '600206'), true, '达上限应熔断');
assert.equal(isTradeRejectCapped('run-a', 'buy', '600206'), false, '反方向不应被熔断');
assert.equal(isTradeRejectCapped('run-a', 'sell', '002218'), false, '别的标的不应被熔断');
assert.equal(isTradeRejectCapped('run-b', 'sell', '600206'), false, '别的 run 不应被熔断');

console.log('tradeGuard selfcheck passed');
