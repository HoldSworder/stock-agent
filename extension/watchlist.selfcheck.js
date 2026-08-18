// 自选股面板分组逻辑自检（无框架，assert 断言）。
// 运行：node extension/watchlist.selfcheck.js
import assert from 'node:assert/strict';
import { UNGROUPED, groupsOf, groupFilter } from './watchlist.js';

const rows = [
  { code: '600519', tags: '核心,白酒' },
  { code: '300750', tags: '核心' },
  { code: '002472', tags: null }, // 批量添加时分组留空 → 后端落库 tags=null
  { code: '000001', tags: '  ' }, // 只有空白同样算未分组
];

// ---- 未分组标的必须有自己的 Tab ----
// 否则：存在任意一个分组时 activeGroup 恒为非空，未分组的行会被整体滤掉，在扩展里既看不到也删不掉。
const gs = groupsOf(rows);
assert.deepEqual(gs, ['核心', '白酒', UNGROUPED], '有未分组标的时应追加「未分组」伪分组');
assert.equal(gs[gs.length - 1], UNGROUPED, '「未分组」应排在真实分组之后');

// 全部都有分组时不应出现伪分组
assert.deepEqual(groupsOf(rows.slice(0, 2)), ['核心', '白酒']);

// ---- 过滤 ----
assert.deepEqual(
  groupFilter(rows, UNGROUPED).map((r) => r.code),
  ['002472', '000001'],
  '「未分组」应返回全部没有 tag 的行',
);
assert.deepEqual(groupFilter(rows, '核心').map((r) => r.code), ['600519', '300750']);
assert.deepEqual(groupFilter(rows, '白酒').map((r) => r.code), ['600519']);
assert.equal(groupFilter(rows, '').length, rows.length, '空分组名表示不过滤');

// 首个 Tab 默认选中的场景：只有未分组标的时，activeGroup 会落在伪分组上，仍须能看到它们
const onlyUngrouped = [{ code: '002472', tags: null }];
assert.deepEqual(groupsOf(onlyUngrouped), [UNGROUPED]);
assert.equal(groupFilter(onlyUngrouped, UNGROUPED).length, 1);

// 哨兵值不与同名真实分组冲突
const literal = [{ code: '600000', tags: '未分组' }];
assert.deepEqual(groupsOf(literal), ['未分组'], '真实的「未分组」分组不应被当成伪分组');
assert.equal(groupFilter(literal, UNGROUPED).length, 0);

console.log('✅ watchlist 分组自检通过：未分组伪分组 / 过滤 / 哨兵值不冲突');
