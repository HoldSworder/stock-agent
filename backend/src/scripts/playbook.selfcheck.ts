// 战法库 CRUD 自检（无框架，assert 断言）。
// 跑在临时 sqlite 上，不碰真实库。运行：cd backend && pnpm exec tsx src/scripts/playbook.selfcheck.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'playbook-selfcheck-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

// 先设好库路径再加载 db 相关模块（client.ts 在 import 期就打开 sqlite）
const { ensureSchema } = await import('../db/migrate');
const repo = await import('../playbook/repo');

ensureSchema();

// ---- 建 ----
const created = repo.createPlaybook({
  name: '缩量回踩 5 日线低吸',
  summary: '主升途中首次缩量回踩',
  category: '低吸',
  tags: '情绪周期, 龙头 ,',
  horizon: 'short',
  marketEnv: '主升,反弹',
  source: '某公众号',
  sourceUrl: '',
  pickMd: '## 选股\n- 5 日线上方',
  buyMd: '回踩不破 5 日线',
  sellMd: '跌破 5 日线',
  riskMd: '',
  notesMd: null,
  rating: 4,
  status: 'testing',
});
assert.ok(created.id, '应生成 id');
assert.equal(created.name, '缩量回踩 5 日线低吸');
assert.equal(created.rating, 4);
assert.equal(created.status, 'testing');
assert.equal(created.horizon, 'short');
assert.equal(created.sourceUrl, null, '空串应存为 null');
assert.equal(created.riskMd, null, '空串应存为 null');
assert.equal(created.notesMd, null);

// ---- 读回 ----
const got = repo.getPlaybook(created.id);
assert.ok(got, '应能按 id 读回');
assert.deepEqual(got, created, '读回内容应与创建返回一致');
assert.equal(repo.listPlaybooks().length, 1);

// ---- 非法值收敛 ----
const weird = repo.createPlaybook({
  name: '  边界值战法  ',
  rating: 99,
  // 故意传非法状态/周期，应回落
  status: 'nope' as never,
  horizon: 'forever' as never,
});
assert.equal(weird.name, '边界值战法', 'name 应 trim');
assert.equal(weird.rating, 5, '星级应夹到 0-5');
assert.equal(weird.status, 'collected', '非法状态应回落 collected');
assert.equal(weird.horizon, null, '非法周期应回落 null');

// ---- 改 ----
const updated = repo.updatePlaybook(created.id, {
  ...created,
  name: '缩量回踩 10 日线低吸',
  rating: 5,
  status: 'adopted',
});
assert.ok(updated, '更新应返回条目');
assert.equal(updated.name, '缩量回踩 10 日线低吸');
assert.equal(updated.rating, 5);
assert.equal(updated.status, 'adopted');
assert.equal(updated.createdAt, created.createdAt, 'createdAt 不应变');
assert.ok(updated.updatedAt >= created.updatedAt, 'updatedAt 不应回退');
assert.equal(repo.updatePlaybook('not-exist', { ...created }), null, '改不存在的应返回 null');

assert.equal(repo.listPlaybooks().length, 2);

// ---- 回测规则（JSON 列）与回测记录往返 ----
const spec = {
  universe: { kind: 'codes' as const, codes: ['600519'] },
  period: 'day' as const,
  barLimit: 300,
  entry: {
    mode: 'all' as const,
    rules: [{ kind: 'ma' as const, maType: 'sma' as const, left: 'close' as const, period: 5, relation: 'crossUp' as const }],
  },
  exit: { mode: 'any' as const, rules: [{ kind: 'pnlPct' as const, op: 'lte' as const, value: -5 }] },
  stopLossPct: 7,
  maxHoldBars: 10,
  fill: 'nextOpen' as const,
};
const withSpec = repo.setSpec(created.id, spec);
assert.ok(withSpec, 'setSpec 应返回条目');
assert.deepEqual(withSpec.spec, spec, '规则应原样读回');
assert.deepEqual(repo.getPlaybook(created.id)?.spec, spec);
assert.equal(repo.setSpec('not-exist', spec), null, '给不存在的战法存规则应返回 null');

const bt = repo.addBacktest(created.id, {
  label: '自检回测',
  source: 'system',
  range: '2025-01-02 ~ 2025-12-31',
  poolSize: 1,
  metrics: { returnPct: 12.3, trades: 4, winRatePct: 75 },
  trades: [
    {
      code: '600519',
      entryDate: '2025-03-03',
      entryPrice: 100,
      exitDate: '2025-03-10',
      exitPrice: 110,
      returnPct: 9.85,
      holdBars: 5,
      exitReason: '卖出规则',
    },
  ],
  equity: [{ date: '2025-03-03', equity: 1 }],
  notes: ['自检'],
  spec,
});
assert.deepEqual(repo.getBacktest(bt.id), bt, '回测记录应原样读回');
assert.equal(repo.listBacktests(created.id).length, 1);
// 列表项省掉大字段，避免列表接口塞满逐笔/曲线
assert.ok(!('trades' in repo.listBacktests(created.id)[0]), '列表项不应含 trades');
repo.removeBacktest(bt.id);
assert.equal(repo.listBacktests(created.id).length, 0);

// 删战法应连带清掉其回测记录，不留孤儿行
repo.addBacktest(created.id, { label: 'x', source: 'external', metrics: {}, trades: [], equity: [], notes: [], spec: null });

// ---- 删 ----
repo.removePlaybook(created.id);
assert.equal(repo.getPlaybook(created.id), null, '删除后应查不到');
assert.equal(repo.listPlaybooks().length, 1, '只应剩另一条');
assert.equal(repo.listBacktests(created.id).length, 0, '删战法应连带清掉回测记录');

rmSync(tmpDir, { recursive: true, force: true });
console.log('✓ 战法库 CRUD 自检通过');
