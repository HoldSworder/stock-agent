// 标的会话 prompt 注入自检（无框架，assert 断言）。
// 重点锁两件事：horizon 不能钉错车道（会让计划落到另一张卡片上）、普通会话不能被误注入。
// 跑在临时 sqlite 上，不碰真实库。运行：cd backend && pnpm exec tsx src/scripts/symbolPlanPrompt.selfcheck.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'symbolplanprompt-selfcheck-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

// 先设好库路径再加载 db 相关模块（client.ts 在 import 期就打开 sqlite）
const { ensureSchema } = await import('../db/migrate');
const { buildChatPrompt } = await import('../agent/chatPrompt');
const { PROMPT_KEYS, setPromptOverride } = await import('../agent/promptConfig');

ensureSchema();

// ---- 普通会话：原样透传，即使带了 planIntent ----
const plain = buildChatPrompt({ content: '大盘怎么看', planIntent: 'swing' });
assert.equal(plain, '大盘怎么看', '普通会话不应注入任何提示词');

// ---- 标的会话不带意图：只前置标的上下文，不带计划指令 ----
const symbolOnly = buildChatPrompt({ refCode: '600519', refName: '贵州茅台', content: '量能如何' });
assert.ok(symbolOnly.includes('600519 贵州茅台'), '应前置标的代码与名称');
assert.ok(symbolOnly.endsWith('量能如何'), '用户原文应在末尾');
assert.ok(!symbolOnly.includes('本轮任务'), '未点快捷按钮时不应注入计划指令');

// ---- 无名称：不该留下多余空格或 undefined ----
const noName = buildChatPrompt({ refCode: '159516', content: '看下' });
assert.ok(noName.includes('【当前跟踪标的】159516\n'), '无名称时代码后应直接换行');
assert.ok(!noName.includes('undefined'), '无名称时不应出现 undefined');

// ---- 两条车道各自钉死，互不串味 ----
for (const [horizon, other] of [
  ['next_session', 'swing'],
  ['swing', 'next_session'],
] as const) {
  const p = buildChatPrompt({ refCode: '600519', content: '生成计划', planIntent: horizon });
  assert.ok(p.includes(`horizon=${horizon}`), `${horizon} 应出现在指令中`);
  assert.ok(!p.includes(`horizon=${other}`), `${horizon} 的指令不应提到另一条车道 ${other}`);
  assert.ok(p.includes('save_symbol_trade_plan'), '指令必须要求落库');
  assert.ok(!/\{\w+\}/.test(p), `占位符应全部被替换，实际残留：${p.match(/\{\w+\}/g)?.join(',')}`);
  assert.ok(p.endsWith('生成计划'), '用户原文应仍在末尾');
}

// ---- 中文标签也要跟着车道走 ----
assert.ok(
  buildChatPrompt({ refCode: '600519', content: 'x', planIntent: 'swing' }).includes('1~4 周波段'),
  'swing 应填入中文标签',
);

// ---- 覆盖提示词后立即生效（提示词页改了要能马上用上） ----
setPromptOverride(PROMPT_KEYS.symbolPlanGenerate, { content: '自定义指令 horizon={horizon}' });
const overridden = buildChatPrompt({ refCode: '600519', content: 'x', planIntent: 'swing' });
assert.ok(overridden.includes('自定义指令 horizon=swing'), '覆盖后的指令应生效且占位符仍被替换');

rmSync(tmpDir, { recursive: true, force: true });
console.log('symbolPlanPrompt selfcheck passed');
