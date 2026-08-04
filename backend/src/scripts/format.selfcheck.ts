// 妙想响应清洗/格式化自检（无框架，assert 断言）。
// 运行：cd backend && npx tsx src/scripts/format.selfcheck.ts
import assert from 'node:assert/strict';
import { formatPositions, formatBalance, formatOrders, parsePositions } from '../miaoxiang/format';

// 构造含清仓项（count=0）与正常持仓的样例响应
const positionsResp = {
  code: '200',
  data: {
    totalAssets: 100000,
    availBalance: 40000,
    totalPosValue: 60000,
    totalProfit: 1234.5,
    posList: [
      // 正常持仓：成本 12.345（放大 3 位）、现价 13.500
      {
        secCode: '600519.SH',
        secName: '正常票',
        count: 500,
        availCount: 300,
        value: 6750,
        costPrice: 12345,
        costPriceDec: 3,
        price: 135,
        priceDec: 1,
        profit: 577.5,
        profitPct: 9.36,
        dayProfit: 100,
        posPct: 11.25,
      },
      // 已清仓：count=0，应被过滤
      { secCode: '000001.SZ', secName: '清仓票', count: 0, costPrice: 1000, costPriceDec: 2 },
    ],
  },
};

const positions = parsePositions(positionsResp);
assert.equal(positions.length, 1, '应过滤掉 count<=0 的清仓项');
assert.equal(positions[0].code, '600519', 'secCode 应归一为 6 位');
assert.ok(Math.abs(positions[0].avgCost - 12.345) < 1e-9, '成本价应按 costPriceDec 还原');
assert.ok(Math.abs(positions[0].price - 13.5) < 1e-9, '现价应按 priceDec 还原');

const posText = formatPositions(positionsResp);
assert.ok(posText.includes('持仓 1 只'), '文本应含持仓只数');
assert.ok(posText.includes('清仓票') === false, '文本不应含被过滤的清仓项');
assert.ok(posText.includes('posList') === false, '文本不应包含原始 JSON 键名');

// balance：金额还原展示
const balanceResp = {
  data: { totalAssets: 125680.5, availBalance: 23450, frozenMoney: 50, totalPosValue: 102230.5, totalPosPct: 81.3, initMoney: 100000 },
};
const balText = formatBalance(balanceResp);
assert.ok(balText.includes('总资产125680.50'), 'balance 应展示总资产');
assert.ok(balText.includes('仓位81.3%'), 'balance 应展示仓位');
assert.ok(balText.includes('data') === false, 'balance 文本不应含原始键名');

// orders：过滤废单/撤单失败，还原委托价
const ordersResp = {
  data: {
    orders: [
      { secCode: '600519', secName: '成交票', drt: 1, price: 18500, priceDec: 2, count: 100, tradeCount: 100, tradePrice: 18500, status: 4, time: 1742000120 },
      { secCode: '000001', secName: '废单票', drt: 2, price: 1000, priceDec: 2, count: 200, status: 9, time: 1742000120 },
    ],
  },
};
const ordText = formatOrders(ordersResp);
assert.ok(ordText.includes('有效委托 1 条'), '应仅保留 1 条有效委托');
assert.ok(ordText.includes('成交票'), '应含有效委托');
assert.ok(ordText.includes('废单票') === false, '应过滤废单');
assert.ok(ordText.includes('委托185×100'), '委托价应按 priceDec 还原');

// 空/异常响应不崩
assert.equal(parsePositions(null).length, 0, '空响应应返回空数组');
assert.ok(formatOrders({}).length > 0, '缺 orders 字段应有兜底文本');

console.log('format selfcheck passed');
