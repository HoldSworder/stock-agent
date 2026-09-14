// 大盘仓位对照自检（无框架，assert 断言）。纯函数，不碰 DB、不取数。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/marketStance.selfcheck.ts
//
// 这一句直接决定加仓还是减仓，说反了就是让人反着做，所以措辞和方向都要钉死。
import assert from 'node:assert/strict';
import { comparePosition, parsePositionRange } from '../swing/marketStance';

// ===== 区间解析：只认 PHASE_META 里实际出现的写法，认不出就返回 null =====

assert.deepEqual(parsePositionRange('60-90%'), { low: 60, high: 90 }, '区间写法');
assert.deepEqual(parsePositionRange('30-60%'), { low: 30, high: 60 }, '区间写法');
assert.deepEqual(parsePositionRange('≤30%'), { low: 0, high: 30 }, '只有上限的写法');
assert.deepEqual(parsePositionRange('  60 - 90 % '), { low: 60, high: 90 }, '容忍空格');
assert.deepEqual(parsePositionRange('≥50%'), { low: 50, high: 100 }, '只有下限的写法');
// 解析不了时必须返回 null 而不是猜一个——猜错会把「该减仓」说成「还能加」
assert.equal(parsePositionRange('看情况'), null, '认不出的写法必须返回 null');
assert.equal(parsePositionRange(''), null, '空串返回 null');
assert.equal(parsePositionRange(null), null, 'null 返回 null');

// ===== 方向判断 =====

const over = comparePosition(95, { low: 60, high: 90 });
assert.equal(over.stance, 'over', '超过上限应判为偏重');
assert.ok(over.gapNote.includes('5'), '要说清超了几个点');
assert.ok(!over.gapNote.includes('还能加'), '偏重时不得出现「还能加」');

const inside = comparePosition(80, { low: 60, high: 90 });
assert.equal(inside.stance, 'inside', '区间内');
assert.ok(inside.gapNote.includes('10'), '区间内要说清还能加几个点');

const under = comparePosition(20, { low: 60, high: 90 });
assert.equal(under.stance, 'under', '低于下限应判为还能加');
assert.ok(under.gapNote.includes('40'), '至少要加到下限');

// 正好在边界上：算区间内，不算超
assert.equal(comparePosition(90, { low: 60, high: 90 }).stance, 'inside', '上沿算区间内');
assert.equal(comparePosition(60, { low: 60, high: 90 }).stance, 'inside', '下沿算区间内');
assert.ok(
  comparePosition(90, { low: 60, high: 90 }).gapNote.includes('上沿'),
  '正好在上沿时要说明白，不能显示成「还能加 0 个点」',
);

// ===== 读不到账户：绝不按空仓算 =====

const unknown = comparePosition(null, { low: 60, high: 90 });
assert.equal(unknown.stance, 'unknown', '读不到账户时不得给出方向');
assert.ok(unknown.gapNote.includes('不代表空仓'), '必须明说这不等于空仓');
assert.ok(!unknown.gapNote.includes('还能加'), '读不到账户时绝不能说还能加');

// 区间认不出时同样不给方向
assert.equal(comparePosition(80, null).stance, 'unknown', '区间认不出时不得给方向');

console.log('✅ 大盘仓位对照自检通过：区间解析 / 三种方向措辞 / 边界算区间内 / 读不到不当空仓');
