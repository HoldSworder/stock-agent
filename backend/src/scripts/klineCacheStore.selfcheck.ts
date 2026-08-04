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

rmSync(tmpDir, { recursive: true, force: true });
console.log('✅ 日K缓存落库自检通过：secid 隔离 / 全量重刷失败标的保历史 / 重刷根数');
