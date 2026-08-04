// 标的 K 线标注 + 标的专属会话自检（无框架，assert 断言）。
// 跑在临时 sqlite 上，不碰真实库。运行：cd backend && pnpm exec tsx src/scripts/symbolMarks.selfcheck.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'symbolmarks-selfcheck-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

// 先设好库路径再加载 db 相关模块（client.ts 在 import 期就打开 sqlite）
const { ensureSchema } = await import('../db/migrate');
const repo = await import('../symbolMarks/repo');
const chat = await import('../chat');

ensureSchema();

// ---- 四种形态各插一条 ----
const priceLine = repo.addMark({
  code: '600519',
  kind: 'price_line',
  label: '压力 1800',
  note: '前高密集成交区',
  points: [{ price: 1800 }],
});
const point = repo.addMark({
  code: '600519',
  kind: 'point',
  label: '主升起点',
  points: [{ time: '2026-07-10', price: 1520.5 }],
});
const range = repo.addMark({
  code: '600519',
  kind: 'range',
  label: '横盘区',
  points: [
    { time: '2026-06-01', price: 1400 },
    { time: '2026-06-28', price: 1500 },
  ],
});
const trend = repo.addMark({
  code: '600519',
  kind: 'trend_line',
  label: '上升趋势',
  points: [
    { time: '2026-05-06', price: 1300 },
    { time: '2026-07-31', price: 1750 },
  ],
});

// ---- 列表按 code 过滤 + points JSON 往返无损 ----
const list = repo.listMarks('600519');
assert.equal(list.length, 4, '该标的应有 4 条标注');
assert.equal(repo.listMarks('000001').length, 0, '其他标的不应串到本标的的标注');

const gotRange = list.find((m) => m.id === range.id);
assert.deepEqual(
  gotRange?.points,
  [
    { time: '2026-06-01', price: 1400 },
    { time: '2026-06-28', price: 1500 },
  ],
  'points JSON 往返应无损',
);
// 价位线不需要 time，规整后应显式为 null
assert.deepEqual(
  list.find((m) => m.id === priceLine.id)?.points,
  [{ time: null, price: 1800 }],
  '价位线点位应只保留 price',
);
assert.equal(point.kind, 'point');
assert.equal(trend.points.length, 2);

// ---- 非法入参被拒 ----
assert.throws(
  () => repo.addMark({ code: '600519', kind: 'bad' as never, label: 'x', points: [{ price: 1 }] }),
  repo.SymbolMarkError,
  '未知 kind 应被拒',
);
assert.throws(
  () => repo.addMark({ code: '600519', kind: 'range', label: 'x', points: [{ time: '2026-01-01', price: 1 }] }),
  repo.SymbolMarkError,
  'range 点数不足应被拒',
);
assert.throws(
  () => repo.addMark({ code: '600519', kind: 'point', label: 'x', points: [{ price: 1 }] }),
  repo.SymbolMarkError,
  'point 缺 time 应被拒',
);
assert.throws(
  () => repo.addMark({ code: '600519', kind: 'price_line', label: 'x', points: [{ time: '2026-01-01' }] }),
  repo.SymbolMarkError,
  '缺 price 应被拒',
);
assert.throws(
  () => repo.addMark({ code: '', kind: 'price_line', label: 'x', points: [{ price: 1 }] }),
  repo.SymbolMarkError,
  '缺 code 应被拒',
);

// ---- 同名覆盖：agent 更新结论时先撤旧 ----
assert.equal(repo.removeMarkByLabel('600519', '压力 1800'), 1, '同名标注应被撤销 1 条');
assert.equal(repo.listMarks('600519').length, 3, '撤销后应剩 3 条');
assert.equal(repo.removeMarkByLabel('600519', '不存在的标签'), 0, '无同名时应返回 0');

// ---- 删除 ----
assert.equal(repo.removeMark(point.id), 'ok', '删除已存在标注应返回 ok');
assert.equal(repo.removeMark(point.id), 'not_found', '重复删除应返回 not_found');
assert.equal(repo.listMarks('600519').length, 2, '删除后应剩 2 条');

// ---- 计划标注：不进 active 列表、且拒删（版本可追溯不能被模型逐条抹掉）----
{
  const planMark = repo.addMark({ code: '600519', kind: 'price_line', label: '计划止损', points: [{ price: 1200 }] });
  const { db, schema } = await import('../db/client');
  const { eq } = await import('drizzle-orm');
  db.update(schema.symbolMarks)
    .set({ planId: 'plan-1', planVersion: 1 })
    .where(eq(schema.symbolMarks.id, planMark.id))
    .run();
  assert.equal(repo.removeMark(planMark.id), 'plan_protected', '计划标注必须拒删');
  db.update(schema.symbolMarks)
    .set({ status: 'historical' })
    .where(eq(schema.symbolMarks.id, planMark.id))
    .run();
  assert.equal(
    repo.listMarks('600519').some((m) => m.id === planMark.id),
    false,
    '历史版本计划标注不得出现在默认列表里（否则模型会引用作废价位）',
  );
  assert.equal(
    repo.listMarks('600519', true).some((m) => m.id === planMark.id),
    true,
    '显式要求含历史时应能取到',
  );
}

// ---- 标的专属会话：同 code 幂等 ----
const s1 = chat.getOrCreateSymbolSession('600519', '贵州茅台');
const s2 = chat.getOrCreateSymbolSession('600519', '贵州茅台');
assert.equal(s1.id, s2.id, '同一标的应复用同一会话');
assert.equal(s1.title, '600519 贵州茅台', '标的会话标题应为「代码 名称」');
assert.notEqual(
  chat.getOrCreateSymbolSession('000001', '平安银行').id,
  s1.id,
  '不同标的应各自独立会话',
);
// 首次只有代码、名称后补时标题应刷新
const noName = chat.getOrCreateSymbolSession('300750');
assert.equal(noName.title, '300750');
assert.equal(chat.getOrCreateSymbolSession('300750', '宁德时代').title, '300750 宁德时代');

// ---- 空壳标的会话不被 pruneEmptySessions 清掉（前端先建后用） ----
const general = chat.createSession();
chat.pruneEmptySessions();
assert.equal(chat.getSession(s1.id)?.id, s1.id, '标的会话应豁免空壳清理');
assert.equal(chat.getSession(general.id), undefined, '通用空壳会话应被清理');

rmSync(tmpDir, { recursive: true, force: true });
console.log('✅ symbolMarks 自检通过（4 种形态往返 / 入参校验 / 同名覆盖 / 删除 / 标的会话幂等与豁免清理）');
