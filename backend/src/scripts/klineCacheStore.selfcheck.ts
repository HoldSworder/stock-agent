// 日K缓存落库自检（无框架，assert 断言）。跑在临时 sqlite 上，不碰真实库。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/klineCacheStore.selfcheck.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KlineBar } from '@stock-agent/shared';

const tmpDir = mkdtempSync(join(tmpdir(), 'klinecache-selfcheck-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

const { ensureSchema } = await import('../db/migrate');
const cache = await import('../datasource/klineCache');

ensureSchema();

const bar = (time: string, close: number): KlineBar => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 100,
  amount: 100 * close,
});

// ---- 第1条：同码不同 secid（上证指数 1.000001 / 平安银行 0.000001）必须互不覆盖 ----
cache.writeCachedDaily('000001', '1.000001', [bar('2026-08-03', 3500)]);
cache.writeCachedDaily('000001', '0.000001', [bar('2026-08-03', 12)]);
assert.equal(
  cache.readCachedDaily('000001', '1.000001', 5)[0].close,
  3500,
  '指数行不得被同码个股覆盖',
);
assert.equal(
  cache.readCachedDaily('000001', '0.000001', 5)[0].close,
  12,
  '个股行不得被同码指数覆盖',
);

// ---- 第3条：全量重刷时，本轮取数失败的标的必须保留旧历史 ----
cache.writeCachedDaily('600000', '1.600000', [bar('2026-08-01', 10), bar('2026-08-03', 11)], {
  adjBase: '2026-07-01',
});
cache.writeCachedDaily('600001', '1.600001', [bar('2026-08-01', 20), bar('2026-08-03', 21)], {
  adjBase: '2026-07-01',
});
const res = await cache.prewarmDaily(
  ['600000', '600001'],
  async (code) => {
    if (code === '600001') throw new Error('模拟取数失败');
    return [bar('2026-08-01', 10.5), bar('2026-08-03', 11.5)];
  },
  { full: true },
);
assert.equal(res.ok, 1);
assert.equal(res.failed, 1);
assert.equal(
  cache.readCachedDaily('600001', '1.600001', 10).length,
  2,
  '取数失败的标的历史不得被基准清理删空（等下一轮重试）',
);
const refreshed = cache.readCachedDaily('600000', '1.600000', 10);
assert.equal(refreshed.length, 2, '成功标的应只剩新基准那一批');
assert.equal(refreshed[0].adjBase, res.adjBase, '成功标的的行应已换到新基准');

// ---- 全量重刷抓取根数按保留天数折算，不能复用预热的 120 根 ----
let askedLimit = 0;
await cache.prewarmDaily(
  ['600002'],
  async (_code, _secid, limit) => {
    askedLimit = limit;
    return [bar('2026-08-03', 5)];
  },
  { full: true },
);
assert.ok(askedLimit > 240, `全量重刷抓取根数应按 keepDays 折算，实际 ${askedLimit}`);

// ---- 读缓存出口必须补一次幂等的连续性修正 ----
// 写入路径已修正过，但收盘回填只覆盖最近 PREWARM_BARS 根：折算后更早的历史仍停在折算前价位，
// 而 adj_base 没变、最新行又新鲜不触发回源，limit 超过预热深度的读取就会看到假跳空。
{
  const split = [bar('2026-08-01', 2), bar('2026-08-03', 1)]; // 相邻两日腰斩 = 1:2 折算
  cache.writeCachedDaily('600003', '1.600003', split);
  const out = await cache.getDailyCached('600003', '1.600003', 2, async () => {
    throw new Error('不应触发回源：缓存已新鲜');
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].close, 1, '折算前的历史行必须被缩放到折算后口径');
  assert.equal(out[1].close, 1, '折算后的行不应被改动');
  assert.equal(out[0].volume, 200, '价格缩半则历史成交量同步放大一倍，与日线口径一致');
}

// ---- 无除权时读出口不得改动任何值（修正必须幂等、不能误伤正常序列）----
{
  const flat = [bar('2026-08-01', 10), bar('2026-08-03', 10.5)];
  cache.writeCachedDaily('600004', '1.600004', flat);
  const out = await cache.getDailyCached('600004', '1.600004', 2, async () => {
    throw new Error('不应触发回源');
  });
  assert.deepEqual(
    out.map((b) => [b.close, b.volume]),
    [
      [10, 100],
      [10.5, 100],
    ],
    '正常序列经读出口后必须逐字不变',
  );
}

// ---- fresh=true 必须无视新鲜度直接回源（前台 K 线弹窗靠它拿实时当日 bar）----
// 缓存窗口 10 分钟、弹窗 10 秒一刷，开关失效就等于盯着一根不动的当日线。
{
  cache.writeCachedDaily('600005', '1.600005', [bar('2026-08-01', 10), bar('2026-08-03', 11)]);
  let calls = 0;
  const out = await cache.getDailyCached(
    '600005',
    '1.600005',
    2,
    async () => {
      calls += 1;
      return [bar('2026-08-01', 10), bar('2026-08-03', 12)];
    },
    { fresh: true },
  );
  assert.equal(calls, 1, '缓存再新鲜，fresh=true 也必须回源一次');
  assert.equal(out[1].close, 12, '应返回回源到的新值而非旧缓存');
}

// ---- fresh=true 回源失败仍要回退旧缓存 ----
// 否则上游一抖，正在看的图就整块白掉——这正是缓存模块本要消灭的降级。
{
  cache.writeCachedDaily('600006', '1.600006', [bar('2026-08-01', 20), bar('2026-08-03', 21)]);
  const out = await cache.getDailyCached(
    '600006',
    '1.600006',
    2,
    async () => {
      throw new Error('上游超时');
    },
    { fresh: true },
  );
  assert.deepEqual(
    out.map((b) => b.close),
    [20, 21],
    'fresh 回源失败时必须回退旧缓存，不得抛错',
  );
}

rmSync(tmpDir, { recursive: true, force: true });
console.log(
  '✅ 日K缓存落库自检通过：secid 隔离 / 全量重刷失败标的保历史 / 重刷根数 / 读出口幂等补修正 / fresh 强制回源与失败回退',
);
