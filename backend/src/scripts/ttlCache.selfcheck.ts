// 通用响应级 TTL 缓存自检（无框架，assert 断言）。纯内存，不碰库。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/ttlCache.selfcheck.ts
import assert from 'node:assert/strict';
import { cached, inspect, reset } from '../lib/ttlCache';

// ---- 命中 / 并发去重 ----
reset();
let calls = 0;
const load = async () => {
  calls += 1;
  return calls;
};
assert.equal(await cached('k', 10_000, load), 1);
assert.equal(await cached('k', 10_000, load), 1, '未过期应直接命中缓存');
assert.equal(calls, 1, 'loader 只应被调用一次');

reset();
calls = 0;
const [a, b] = await Promise.all([cached('k', 10_000, load), cached('k', 10_000, load)]);
assert.equal(a, b);
assert.equal(calls, 1, '并发同 key 应复用同一 Promise');
assert.equal(inspect().inflight, 0, 'inflight 必须在结束后清理，否则永久钉住一条 Promise');

// ---- 条数上限：key 空间不封闭（concepts:stocks:${用户输入} 之类），必须有上界 ----
reset();
const { maxEntries } = inspect();
for (let i = 0; i < maxEntries + 50; i++) {
  await cached(`concepts:stocks:user-input-${i}`, 1, async () => i);
}
assert.ok(
  inspect().entries <= maxEntries,
  `缓存条数应被 MAX_ENTRIES 压住，实际 ${inspect().entries} > ${maxEntries}`,
);

// ---- serve-stale：过期旧值在 maxStaleMs 内回退，超龄则抛错 ----
reset();
await cached('stale', 1, async () => 'fresh');
await new Promise((r) => setTimeout(r, 5)); // 让它过期
const boom = async () => {
  throw new Error('上游挂了');
};
assert.equal(await cached('stale', 1, boom), 'fresh', '上游失败应回退上次成功值');
// maxStaleMs=0：不接受任何过期回退，必须显性报错而不是静默返回陈旧盘面
await assert.rejects(
  () => cached('stale', 1, boom, { maxStaleMs: 0 }),
  /上游挂了/,
  '超龄的旧值不得冒充新数据，应把上游错误抛出',
);
// 无旧值时一律抛出
reset();
await assert.rejects(() => cached('none', 1, boom), /上游挂了/);

console.log('✅ ttlCache 自检通过：命中 / 并发去重 / 条数上限 / serve-stale 超龄保护');
