// 底仓（中长线赛道轮动）持有与出场规则自检（无框架，assert 断言）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/swingCoreHolding.selfcheck.ts
//
// 钉住的是「底仓不能被试探仓那套规则洗下车」这件事：
//  - 一级顶部信号（力道衰减）不减仓
//  - 涨了很多也不减半、不按天数退出
//  - 结构线只上移，绝不因为价格下跌而放低
import assert from 'node:assert/strict';
import type { KlineBar, SwingWatchLevel } from '@stock-agent/shared';
import {
  archiveCoreHolding,
  evaluateCoreHolding,
  pickStructureLine,
  CORE_HOLDING_PARAMS,
} from '../swing/coreHolding';

const bar = (close: number, low = close * 0.99, high = close * 1.01): KlineBar => ({
  time: '2026-09-11',
  open: close,
  high,
  low,
  close,
  volume: 1_000_000,
  amount: 10_000_000,
});

const level = (price: number, side: 'below' | 'above', basis: string): SwingWatchLevel => ({
  price,
  side,
  distancePct: 1,
  basis,
});

// ===== 结构线的取法 =====

// 下方有多个低点时取**最近**那个，不取最低那个：
// 最低那个往往在几个月前，跌到那里这波早就结束了，拿它当线等于没有线
const levels = [
  level(9.5, 'below', '8月低点'),
  level(8.0, 'below', '4月低点'),
  level(11.0, 'above', '7月高点'),
];
assert.equal(pickStructureLine(levels, 10)?.price, 9.5, '结构线应取现价下方最近的低点');

// 下方没有低点时给不出结构线，调用方须如实说明而不是捏一个
assert.equal(pickStructureLine([level(11, 'above', '高点')], 10), null, '下方无低点时应返回 null');

const archived = archiveCoreHolding(levels, 10, '2026-09-01');
assert.ok(archived != null, '有下方低点时应能存档');
assert.equal(archived.structureLine, 9.5);

// ===== 一级顶部信号不减仓 =====

const tier1 = evaluateCoreHolding({
  state: archived,
  bar: bar(10.5),
  grade: 'risk_easing_top',
  watchLevels: levels,
  tradeDate: '2026-09-11',
});
assert.equal(tier1.action, 'hold', '一级顶部信号（力道衰减）不得让底仓减仓或退出');

// ===== 涨很多也不减半、不按天数退出 =====

const bigGain = evaluateCoreHolding({
  state: archived,
  bar: bar(18),
  grade: 'none',
  watchLevels: [level(16, 'below', '9月低点'), ...levels],
  tradeDate: '2026-09-11',
});
assert.equal(bigGain.action, 'hold', '涨幅再大也不是退出理由，主升浪的钱全在这一段');
assert.equal(CORE_HOLDING_PARAMS.reduceAtFirstR, false, '底仓不做 1R 减半');
assert.equal(CORE_HOLDING_PARAMS.timeStopTradeDays, null, '底仓不做时间退出');
assert.equal(CORE_HOLDING_PARAMS.reduceOnTier1Top, false, '底仓不因一级顶部信号减仓');

// ===== 结构线只上移 =====

// 走出更高的低点 → 抬线
assert.equal(bigGain.next.structureLine, 16, '出现更高的低点时结构线应上移');

// 价格跌回来、下方最近低点变低 → 线绝不放低。
// 这是仓库里真出过的那个 bug 的反向约束：ETF 持仓止损曾引用按现价生成的
// 新交易参考价，价格越跌线越低，于是止损永不触发
const pullback = evaluateCoreHolding({
  state: { structureLine: 16, structureBasis: '9月低点', archivedAt: '2026-09-11' },
  bar: bar(17),
  grade: 'none',
  watchLevels: [level(16.5, 'below', '更近的低点'), level(12, 'below', '更低的低点')],
  tradeDate: '2026-09-12',
});
assert.equal(pullback.next.structureLine, 16.5, '更高的低点可以抬线');
const deeperPullback = evaluateCoreHolding({
  state: { structureLine: 16.5, structureBasis: '更近的低点', archivedAt: '2026-09-12' },
  bar: bar(17),
  grade: 'none',
  watchLevels: [level(12, 'below', '更低的低点')],
  tradeDate: '2026-09-15',
});
assert.equal(deeperPullback.next.structureLine, 16.5, '下方只剩更低的低点时，结构线不得放低');
assert.equal(CORE_HOLDING_PARAMS.structureLineRatchetOnly, true);

// ===== 退出的两条依据 =====

// 收盘跌破结构线 → 退出
const broken = evaluateCoreHolding({
  state: { structureLine: 16.5, structureBasis: '更近的低点', archivedAt: '2026-09-12' },
  bar: bar(16.2),
  grade: 'none',
  watchLevels: [level(12, 'below', '更低的低点')],
  tradeDate: '2026-09-16',
});
assert.equal(broken.action, 'exit_structure_broken', '收盘跌破结构线应退出');

// 盘中插针到结构线下方、收盘又收回来 → 不退出。
// 被一根插针洗出八成仓的代价远大于多拿一天（这与试探仓用最低价判定刻意相反）
const wick = evaluateCoreHolding({
  state: { structureLine: 16.5, structureBasis: '更近的低点', archivedAt: '2026-09-12' },
  bar: bar(16.8, 16.0),
  grade: 'none',
  watchLevels: [level(12, 'below', '更低的低点')],
  tradeDate: '2026-09-16',
});
assert.equal(wick.action, 'hold', '盘中插针但收盘站回结构线上方，不算结构破坏');
assert.equal(CORE_HOLDING_PARAMS.breakJudgedByClose, true);

// 顶部二级确认 → 退出
const confirmed = evaluateCoreHolding({
  state: { structureLine: 16.5, structureBasis: '更近的低点', archivedAt: '2026-09-12' },
  bar: bar(17),
  grade: 'turn_confirmed_top',
  watchLevels: [level(16.5, 'below', '更近的低点')],
  tradeDate: '2026-09-16',
});
assert.equal(confirmed.action, 'exit_turn_confirmed', '顶部二级确认应退出');

// 跌破与顶部信号同时成立 → 按跌破处理（事实优先于判断）
const both = evaluateCoreHolding({
  state: { structureLine: 16.5, structureBasis: '更近的低点', archivedAt: '2026-09-12' },
  bar: bar(16.0),
  grade: 'turn_confirmed_top',
  watchLevels: [level(12, 'below', '更低的低点')],
  tradeDate: '2026-09-16',
});
assert.equal(both.action, 'exit_structure_broken', '两条同时成立时按已发生的事实（跌破）处理');

// ===== 数据不全不得假装检查过 =====

const noData = evaluateCoreHolding({
  state: { structureLine: 16.5, structureBasis: '更近的低点', archivedAt: '2026-09-12' },
  bar: { time: '2026-09-16', open: 0, high: 0, low: 0, close: 0, volume: 0, amount: 0 },
  grade: 'none',
  watchLevels: [],
  tradeDate: '2026-09-16',
});
assert.ok(noData.blockedReason != null, '数据不全时必须如实说明没法检查');
assert.equal(noData.next.structureLine, 16.5, '数据不全时不得改动存档的结构线');

// ===== 继续持有必须说清下一次盯什么 =====

assert.ok(tier1.nextTrigger.includes('跌破'), '继续持有时必须给出下一次会改变动作的条件');

console.log(
  '✅ 底仓规则自检通过：一级顶部不减仓 / 涨多不减半不按天退 / 结构线只上移 / 跌破按收盘 / 数据不全不假装',
);
