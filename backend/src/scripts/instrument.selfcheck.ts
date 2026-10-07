/**
 * 品种规则自检：涨跌幅、印花税、申报单位、1R。
 * 运行：cd backend && pnpm exec tsx src/scripts/instrument.selfcheck.ts
 */
import assert from 'node:assert/strict';
import {
  intrabarSplitRatio,
  isSealedLimit,
  limitPrice,
  limitRatio,
  oneRDistance,
  orderQtyError,
  roundOrderQty,
  sellStampBps,
  splitGapRatio,
  transferFeeBps,
} from '../market/instrument';

assert.equal(limitRatio('600000'), 0.1);
assert.equal(limitRatio('600000', { name: 'ST浦发' }), 0.05);
assert.equal(limitRatio('300001', { date: '2020-08-21' }), 0.1);
assert.equal(limitRatio('300001', { date: '2020-08-24' }), 0.2);
assert.equal(limitRatio('688001'), 0.2);
assert.equal(limitRatio('830001'), 0.3);
assert.equal(limitRatio('513180', { name: '恒生科技ETF' }), null);
assert.equal(limitRatio('159915', { name: '创业板ETF' }), 0.2);
assert.equal(limitRatio('159919', { name: '沪深300ETF' }), 0.1);
assert.equal(limitPrice(10, 0.1), 11);
assert.equal(isSealedLimit(11, 10, 0.1, 'up'), true);
assert.equal(isSealedLimit(10.9, 10, 0.1, 'up'), false);

assert.equal(sellStampBps('600000', '2023-08-27'), 10);
assert.equal(sellStampBps('600000', '2023-08-28'), 5);
assert.equal(sellStampBps('510300', '2020-01-01'), 0);
assert.equal(transferFeeBps('161005'), 0);
assert.equal(transferFeeBps('600000'), 0.1);

assert.equal(roundOrderQty('688001', 199, 'buy'), 0);
assert.equal(roundOrderQty('688001', 201, 'buy'), 201);
assert.equal(roundOrderQty('113050', 25, 'buy'), 20);
assert.equal(roundOrderQty('600000', 250, 'buy'), 200);
assert.equal(orderQtyError('688001', 100, 'buy'), '科创板买入至少 200 股，不足 200 不下单');

assert.equal(splitGapRatio('600000'), 0.12);
assert.equal(splitGapRatio('688001'), 0.23);
assert.equal(splitGapRatio('513100'), null);
assert.equal(intrabarSplitRatio('600000'), 0.55);
assert.equal(intrabarSplitRatio('300001'), 0.3);
assert.equal(intrabarSplitRatio('518880', '黄金ETF'), null);

assert.equal(oneRDistance(10.75, 9.5), 1.25);

console.log('instrument.selfcheck 全部通过');
