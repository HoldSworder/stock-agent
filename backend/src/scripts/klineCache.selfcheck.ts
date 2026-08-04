// 日K缓存新鲜度判定自检（无框架，assert 断言）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/klineCache.selfcheck.ts
import assert from 'node:assert/strict';
import { isFresh, isIntradayWindow } from '../datasource/klineCache';

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

console.log('✅ klineCache 新鲜度判定自检通过');
