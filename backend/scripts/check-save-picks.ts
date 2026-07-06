import assert from 'node:assert/strict';
import { ensureSchema } from '../src/db/migrate';
import { saveAgentPicks, getRunDetail } from '../src/screener/service';

// 最小断言自检：saveAgentPicks 把 agent 选出标的落到选股历史（无交易）。
// 用法（隔离 DB，勿污染开发库）：DATABASE_PATH=/tmp/check-save-picks.sqlite pnpm --filter ./backend exec tsx scripts/check-save-picks.ts

ensureSchema();

const detail = saveAgentPicks({
  picks: [
    { code: '600519', name: '贵州茅台', price: 1680.5, pct: 3.2, thesis: '主线·白酒' },
    { code: '300750', name: '宁德时代', price: 245.8, pct: 5.1 },
    { code: '002594', name: '比亚迪', price: 312.0 },
    { code: '', name: '空码', price: 10 }, // 空代码：service 过滤
    { code: '000001', name: '无价', price: 0 }, // 现价非正：service 过滤
  ],
  context: '白酒、电池',
  trigger: 'cron',
});

assert.equal(detail.picks.length, 3, '应只记录 3 条合法标的');
assert.deepEqual(
  detail.picks.map((p) => [p.rank, p.code, p.price]),
  [
    [1, '600519', 1680.5],
    [2, '300750', 245.8],
    [3, '002594', 312.0],
  ],
  'rank 按顺序、price 原样落库',
);
assert.equal(detail.strategyName, '尾盘动能套利');
assert.equal(detail.context, '白酒、电池');

const reread = getRunDetail(detail.id);
assert.ok(reread && reread.picks.length === 3, 'getRunDetail 应能读回 3 条');

console.log('OK: saveAgentPicks 记录 3 只到选股历史，非法/无价标的已过滤');
