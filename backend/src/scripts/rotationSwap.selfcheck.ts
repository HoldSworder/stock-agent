// 换仓配对自检（无框架，assert 断言）。只测纯逻辑，不碰 DB、不取数。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/rotationSwap.selfcheck.ts
//
// 钉住的核心是**资金先后依赖**：
// 现金不够时买入必须等卖出到账。不写清这个，两条建议看起来能同时执行，
// 而账户里并没有那么多钱——到时候要么买不进，要么被迫市价卖。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RotationBoardCandidate, RotationBoardHolding } from '@stock-agent/shared';

// rotationBoard 在 import 期会经 db/client 打开 sqlite，先把库指到临时文件
const tmpDir = mkdtempSync(join(tmpdir(), 'rotation-swap-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

const { __testables } = await import('../swing/rotationBoard');
const { buildSwaps, isBottomSignal } = __testables;

const holding = (code: string, name: string, realPct: number): RotationBoardHolding => ({
  code,
  name,
  track: '半导体',
  realPct,
  holdRatePct: 12,
  grade: 'turn_confirmed_top',
  close: 1.5,
  structureLine: 1.4,
  structureBasis: '8月低点',
  distanceToLinePct: 6.7,
  action: 'exit_turn_confirmed',
  reason: '走势转向已确认',
  nextTrigger: '退出后等下一次底部信号',
  blockedReason: null,
});

const candidate = (code: string, name: string, close: number): RotationBoardCandidate => ({
  code,
  name,
  track: '光伏',
  peerCount: 4,
  isTrackProxy: true,
  grade: 'turn_confirmed_bottom',
  close,
  zone: { low: close * 0.98, high: close * 1.02 },
  initialStop: close * 0.95,
  rationale: ['下跌力道衰减'],
  counterEvidence: ['这一段还在走'],
});

// ===== 哪些定级算「该进的候选」 =====

assert.equal(isBottomSignal('risk_easing_bottom'), true, '一级底部信号算候选');
assert.equal(isBottomSignal('turn_confirmed_bottom'), true, '二级底部信号算候选');
assert.equal(isBottomSignal('risk_easing_top'), false, '顶部信号不是买入候选');
assert.equal(isBottomSignal('none'), false, '无信号不是候选');

// ===== 现金不够：必须先卖再买 =====

// 候选现价 10 元，买一手要 1000 元；现金只有 500 → 买不起，必须等卖出
const tight = buildSwaps(
  [holding('512480', '半导体ETF', 30)],
  [candidate('515790', '光伏ETF', 10)],
  { available: 500, totalAsset: 100_000, cashPct: 0.5 },
);
assert.equal(tight.length, 1);
assert.equal(tight[0].needsSaleFirst, true, '现金买不起一手时必须先卖再买');
assert.ok(tight[0].note.includes('先卖'), '说明里必须写清先卖再买');
// 卖出释放的钱 = 该仓位占总资产比例 × 总资产
assert.equal(tight[0].freedAmount, 30_000, '释放金额应按该仓位占总资产的比例算');

// ===== 现金够：可以直接买，但不等于该同时拿两只 =====

const flush = buildSwaps(
  [holding('512480', '半导体ETF', 30)],
  [candidate('515790', '光伏ETF', 10)],
  { available: 50_000, totalAsset: 100_000, cashPct: 50 },
);
assert.equal(flush[0].needsSaleFirst, false, '现金够买一手时不必等卖出');
assert.ok(
  flush[0].note.includes('不等于'),
  '现金够也要说清「买得起」不等于「该同时拿两只」，否则会顺手变成加仓',
);

// ===== 读不到账户现金：按最保守的「必须先卖」处理 =====

const unknown = buildSwaps(
  [holding('512480', '半导体ETF', 30)],
  [candidate('515790', '光伏ETF', 10)],
  null,
);
assert.equal(unknown[0].needsSaleFirst, true, '读不到现金时不得假设买得起');
assert.equal(unknown[0].freedAmount, 0, '读不到总资产时不得编一个释放金额');
assert.ok(unknown[0].note.includes('读不到'), '必须如实说明是因为读不到账户现金');

// ===== 一对一配对，不做组合优化 =====

// 两只该走、一个候选 → 只配一组，不把两只都塞给同一个候选
const twoOutOneIn = buildSwaps(
  [holding('512480', '半导体ETF', 30), holding('159740', '恒生科技ETF', 20)],
  [candidate('515790', '光伏ETF', 10)],
  { available: 0, totalAsset: 100_000, cashPct: 0 },
);
assert.equal(twoOutOneIn.length, 1, '配对数取两边的较小值，一次换仓只该动一只');
assert.equal(twoOutOneIn[0].out.code, '512480', '仓位大的先处理');

// 有该走的、没候选 → 不产生换仓（卖掉拿现金等着，不勉强换一只）
assert.equal(
  buildSwaps([holding('512480', '半导体ETF', 30)], [], null).length,
  0,
  '没有候选时不得硬凑一组换仓',
);

rmSync(tmpDir, { recursive: true, force: true });
console.log(
  '✅ 换仓配对自检通过：现金不够先卖再买 / 读不到现金按最保守处理 / 一对一不凑组 / 没候选不硬换',
);
