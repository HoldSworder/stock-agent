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

// ---- 第4条：全量重刷的旧行清理必须带 secid ----
// 预热宇宙旧实现只传 6 位代码、一律 toSecid，清理也只按 code 过滤：
// 上证指数（1.000001，显式 secid）与同码个股（0.000001）互相连坐，指数历史每周被删空。
{
  cache.writeCachedDaily('000002', '1.000002', [bar('2026-08-01', 3500)], { adjBase: '2026-07-01' });
  cache.writeCachedDaily('000002', '0.000002', [bar('2026-08-01', 12)], { adjBase: '2026-07-01' });
  const r = await cache.prewarmDaily(
    [{ code: '000002', secid: '1.000002' }],
    async () => [bar('2026-08-01', 3600), bar('2026-08-03', 3620)],
    { full: true },
  );
  assert.equal(r.ok, 1, '显式 secid 的标的应能正常参与重刷');
  assert.equal(
    cache.readCachedDaily('000002', '0.000002', 10).length,
    1,
    '同码不同 secid 的标的不得被连坐删除',
  );
  const idx = cache.readCachedDaily('000002', '1.000002', 10);
  assert.equal(idx.length, 2, '本轮刷新的标的应换到新基准的两根');
  assert.equal(idx[0].adjBase, r.adjBase, '刷新后的行应是新基准');
}

// ---- 第5条：历史长度本就不足 limit 的标的也要能命中缓存 ----
// 旧判据 cached.length >= limit 让新上市几个月的标的（默认 limit=250）永久回源，
// 恰恰丢掉了「上游一慢就整块降级」的防护。回源返回数少于请求数即已触达历史起点。
{
  let calls = 0;
  const short = [bar('2026-08-01', 5), bar('2026-08-03', 5.2)];
  const out1 = await cache.getDailyCached('600007', '1.600007', 250, async () => {
    calls += 1;
    return short;
  });
  assert.equal(calls, 1, '首次读取应回源');
  assert.equal(out1.length, 2, '上游只有 2 根就是 2 根');
  const out2 = await cache.getDailyCached('600007', '1.600007', 250, async () => {
    throw new Error('历史不足 limit 的标的不应每次都回源');
  });
  assert.equal(out2.length, 2, '第二次应直接命中缓存');
}

// ---- 第5条的反面：上次「拿满」不能被当成「已到历史起点」，否则更大的 limit 会命中短缓存 ----
// 同一只标的在全仓被以差异极大的 limit 请求（盯盘 3 根 / regime 260 根 / ETF 500 根）。
// 若只记「上次拿到多少」而不记「上次要了多少」，则「要 60 拿到 60」会被误判成
// 「历史只有 60 根」，之后 200 根的请求永久命中 60 行的短缓存、静默返回被截断的历史——
// 而 MA120／回测这类消费方拿到短序列不会报错，只会算出偏短窗口的指标。
{
  const many = Array.from({ length: 60 }, (_, i) =>
    bar(`2026-05-${String((i % 28) + 1).padStart(2, '0')}`, 7 + i * 0.01),
  );
  // 首次以 limit=60 回源，上游给满 60 根（说明并未触达历史起点）
  await cache.getDailyCached('600009', '1.600009', 60, async () => many);
  let refetched = false;
  const deeper = await cache.getDailyCached('600009', '1.600009', 200, async () => {
    refetched = true;
    return many;
  });
  assert.ok(refetched, '上次拿满说明历史可能更长，更大的 limit 必须回源而不是命中短缓存');
  assert.ok(deeper.length > 0, '回源结果应正常返回');
}

// ---- 第1条：回源失败兜底不得把盘中临时 bar 当成完整日线交出去 ----
// 判据依赖「此刻是否在连续竞价中」，自检可能在任意时刻跑，故按当下时段分别断言。
{
  const inSession = cache.isFresh(new Date().toISOString(), new Date(), true);
  cache.writeCachedDaily('600008', '1.600008', [bar('2026-08-01', 10)]);
  cache.writeCachedDaily('600008', '1.600008', [bar('2026-08-03', 10.5)], { provisional: true });
  const out = await cache.getDailyCached(
    '600008',
    '1.600008',
    2,
    async () => {
      throw new Error('上游超时');
    },
    { fresh: true },
  );
  assert.equal(
    out.length,
    inSession ? 2 : 1,
    inSession
      ? '盘中兜底应保留临时 bar（既有行为）'
      : '非交易时段兜底必须剔除末根临时 bar，少一根完整日线好过多一根假的',
  );
}

rmSync(tmpDir, { recursive: true, force: true });
console.log(
  '✅ 日K缓存落库自检通过：secid 隔离 / 全量重刷失败标的保历史 / 重刷清理带 secid / 重刷根数 / 读出口幂等补修正 / fresh 强制回源与失败回退 / 短历史标的可命中缓存 / 兜底剔除临时bar',
);
