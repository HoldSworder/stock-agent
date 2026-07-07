/**
 * 尾盘套利确定性卖点规则自检（无框架，assert 版）。
 * 仅依赖纯函数 evalWeipanExit（不触碰 DB / 原生模块），可直接：
 *   ./node_modules/.bin/tsx scripts/weipan-rules-selfcheck.ts
 * 覆盖：优先级（止损>止盈>移动止盈>尾盘了结）、各阈值边界、14:50 强制了结、不命中返回 null。
 */
import assert from 'node:assert';
import { evalWeipanExit, WEIPAN_FALLBACK_PROFILE as P } from '../src/weipan/rules';

const AM = 600; // 盘中（10:00），未到尾盘
const cost = 100;
const r = (price: number, dayHigh: number, minutes = AM) =>
  evalWeipanExit({ avgCost: cost, price, dayHigh, minutes }, P);

// 止损优先：跌破止损线即便当日曾冲高，也判止损（优先级最高）
assert.equal(r(96, 110)?.reason, 'stop_loss', '跌破止损线应判止损');
// 止损边界：恰好触线（<=）触发
assert.equal(r(97, 105)?.reason, 'stop_loss', '恰好跌到止损线应触发');

// 止盈：浮盈达标（且未跌破止损）
assert.equal(r(105.1, 106)?.reason, 'take_profit', '浮盈>=5% 应判止盈');
// 止盈优先于尾盘了结：即使到点，先止盈
assert.equal(r(106, 106, 890)?.reason, 'take_profit', '到点但达止盈，应优先止盈');

// 移动止盈（冲高回落）：浮盈未达止盈、确有冲高(高于成本)、回撤达阈值
const trail = r(100.8, 104);
assert.equal(trail?.reason, 'trailing', '冲高回落达阈值应判移动止盈');
assert.ok(trail!.drawdownPct >= P.intradayDrawdownPct, '回撤应达阈值');
// 移动止盈边界：回撤不足阈值不触发
assert.equal(r(100.5, 102), null, '回撤不足阈值不应触发');

// 尾盘了结：无其它触发但到点强制
assert.equal(r(101, 101, 890)?.reason, 'eod', '到 14:50 应尾盘了结');
assert.equal(r(101, 101, 889), null, '未到 14:50 不应了结');

// 不命中：盘中、浮盈未达、回撤不足、未破止损
assert.equal(r(101, 101, AM), null, '常态无信号应返回 null');
// 非法输入
assert.equal(evalWeipanExit({ avgCost: 0, price: 10, dayHigh: 10, minutes: AM }, P), null, '无成本应返回 null');

console.log('weipan rules self-check: 所有断言通过 ✅');
