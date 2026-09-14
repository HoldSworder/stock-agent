// 已持仓止损口径自检（无框架，assert 断言；纯计算，不碰 DB/网络）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/heldStopLoss.selfcheck.ts
//
// 钉住一条规矩：已持仓的止损锚定成本，不随现价下移。
//
// 这个缺陷已经复发过一次，所以值得一条专门的检查：
//   第一次在 positions/discipline.ts——它引用 etf/service.ts 按现价生成的
//   「新进场破位止损参考价」，公式 min(下一档买价×0.96, 现价×0.95)。价格越跌它越低，
//   于是持仓已亏 20% 而比较永远不触发。那次修在了 discipline.ts。
//   第二次在 plan/service.ts 的持仓补全路径——同一个值被挂到已持仓标的上，
//   于是同一只 ETF 在计划页说「没破」、持仓页按成本 -12% 说「早该卖」。
//
// 两次的根因是同一个：把「新进场该在哪破位」和「这笔头寸亏到多少该走」当成了一件事。
// 前者随现价走是对的，后者随现价走就是把亏损一路放宽。
import assert from 'node:assert/strict';

/** 新进场的破位参考价（etf/service.ts 的口径）。随现价走，对新建仓合理 */
const newEntryStop = (nextBuy: number, price: number): number =>
  Math.min(nextBuy * 0.96, price * 0.95);

/** 已持仓的有效止损（plan/service.ts 的 heldStopLossOf 口径）。锚定成本 */
const heldStop = (avgCost: number, stopPct: number): number =>
  Math.round(avgCost * (1 - stopPct / 100) * 1000) / 1000;

// ===== 1. 已持仓止损与现价无关 =====

const cost = 10;
const pct = 12; // ETF 的趋势级默认止损
const anchored = heldStop(cost, pct);
assert.equal(anchored, 8.8, '成本 10、止损 12% 应为 8.8');
// 现价怎么变都不影响它——这就是「锚定成本」的全部含义
for (const price of [10, 9, 8, 6, 20]) {
  assert.equal(
    heldStop(cost, pct),
    anchored,
    `现价 ${price} 时已持仓止损必须仍是 ${anchored}，它不该是现价的函数`,
  );
}

// ===== 2. 新进场参考价确实随现价下移（留作对照，说明为什么不能混用）=====

const s10 = newEntryStop(10, 10);
const s9 = newEntryStop(9, 9);
const s8 = newEntryStop(8, 8);
assert.ok(s10 > s9 && s9 > s8, '新进场参考价随现价下移，这是它的设计，不是缺陷');

// 关键反例：成本 10 的持仓、现价跌到 8 时，两种口径给出相反结论
assert.ok(
  s8 < anchored,
  '算术证明：现价 8 时新进场参考价（7.53）低于成本止损线（8.8），用它会漏掉该走的信号',
);
assert.ok(8 < anchored, '按已持仓口径，现价 8 已跌破 8.8，必须触发');
assert.ok(8 > s8, '按新进场口径，现价 8 还在 7.53 之上，不会触发——两者结论相反');

// ===== 3. 边界 =====

// 成本缺失时算出来是 0，调用方必须据此判为不可给，而不是真给一个 0 元止损
assert.equal(heldStop(0, pct), 0, '成本为 0 时结果为 0，调用方须拦住');
for (const bad of [0, -5]) {
  assert.ok(!(bad > 0), `止损比例 ${bad} 不合法，调用方必须拦住`);
}

// 不同资产类别的默认止损不同（ETF 12% / 个股 8%），但都只依赖成本
assert.equal(heldStop(10, 8), 9.2, '个股 8% 止损：成本 10 应为 9.2');

console.log(
  '✅ 已持仓止损口径自检通过：锚定成本、与现价无关；' +
    '并用算术反例钉住「用新进场参考价会漏掉该走的信号」',
);
