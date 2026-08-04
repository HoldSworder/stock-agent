// 驾驶舱关注标的自检（无框架，assert 断言）。
// 跑在临时 sqlite 上，不碰真实库。运行：cd backend && pnpm exec tsx src/scripts/cockpitFocus.selfcheck.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'cockpitfocus-selfcheck-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

// 先设好库路径再加载 db 相关模块（client.ts 在 import 期就打开 sqlite）
const { ensureSchema } = await import('../db/migrate');
const focus = await import('../cockpit/focus');

ensureSchema();

// ---- 增 ----
focus.addFocus({ code: '600519', name: '贵州茅台' });
focus.addFocus({ code: '300750', name: '宁德时代', note: '主线跟踪' });
let list = focus.listFocus();
assert.equal(list.length, 2, '应有 2 只关注标的');
assert.equal(list.find((i) => i.code === '300750')?.note, '主线跟踪');

// ---- 幂等：重复 add 不产生重复行，只刷新名称/备注，加入时间不变 ----
const createdAtBefore = list.find((i) => i.code === '600519')!.createdAt;
focus.addFocus({ code: '600519', name: '贵州茅台', note: '重复添加' });
list = focus.listFocus();
assert.equal(list.length, 2, '重复添加不应新增行');
const maotai = list.find((i) => i.code === '600519')!;
assert.equal(maotai.note, '重复添加');
assert.equal(maotai.createdAt, createdAtBefore, '重复添加不应重置加入时间');

// ---- 幂等：不带备注地重复添加不得抹掉已有备注（前端不填备注时传的就是 null）----
focus.addFocus({ code: '600519', name: '贵州茅台', note: null });
assert.equal(
  focus.listFocus().find((i) => i.code === '600519')?.note,
  '重复添加',
  '未带备注的重复添加不应清空已有备注',
);

// ---- 改备注 ----
focus.updateFocus('600519', { note: '等回踩' });
assert.equal(focus.listFocus().find((i) => i.code === '600519')?.note, '等回踩');
// 空 patch 不应报错也不应改动
focus.updateFocus('600519', {});
assert.equal(focus.listFocus().find((i) => i.code === '600519')?.note, '等回踩');

// ---- 排序：sortOrder 小的在前 ----
focus.updateFocus('300750', { sortOrder: -1 });
assert.equal(focus.listFocus()[0].code, '300750', 'sortOrder 小的应排在最前');

// ---- 删 ----
focus.removeFocus('300750');
list = focus.listFocus();
assert.equal(list.length, 1);
assert.equal(list[0].code, '600519');

rmSync(tmpDir, { recursive: true, force: true });
console.log('✅ cockpitFocus 自检通过：增（幂等）/ 改备注 / 排序 / 删除');
