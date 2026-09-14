// 机会清单自检（无框架，assert 断言）。只测纯逻辑，不碰 DB、不取数。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/swingOpportunities.selfcheck.ts
//
// 钉住三件事：
//  1) 一只标的只出一条——日线和 60 分钟都有信号时合成，不显示成两个机会，
//     否则同一笔钱会被算两次，合计额度就形同虚设
//  2) 日线定动作、60 分钟只作提前提示
//  3) 1R 目标价按最不利的入场价算
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KlinePeriod, SwingGrade, SwingReading } from '@stock-agent/shared';

// opportunities 经 adviceStore 间接 import db/client，先把库指到临时文件
const tmpDir = mkdtempSync(join(tmpdir(), 'swing-opp-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

const { selectOpportunitySignals, firstRTargetOf } = await import('../swing/opportunities');

const reading = (
  code: string,
  period: KlinePeriod,
  grade: SwingGrade,
  opts: Partial<SwingReading> = {},
): SwingReading => ({
  code,
  name: `${code}ETF`,
  period,
  assetType: 'etf',
  track: '半导体',
  category: 'industry',
  isTrackProxy: true,
  peerCount: 3,
  grade,
  close: 10,
  divergenceStrength: 0.5,
  zone: { low: 9.8, high: 10.2 },
  initialStop: 9.5,
  chaseGuard: 10.5,
  atr14: 0.4,
  watchLevels: [],
  rationale: ['下跌力道衰减'],
  counterEvidence: [],
  barTime: '2026-09-11',
  unavailableReason: null,
  ...opts,
});

const empty = new Set<string>();

// ===== 一只标的只出一条 =====

const both = selectOpportunitySignals(
  [
    reading('512480', 'day', 'turn_confirmed_bottom'),
    reading('512480', '60m', 'risk_easing_bottom'),
  ],
  empty,
);
assert.equal(both.length, 1, '两个周期都有信号时必须合成一条，不能算成两个机会');
assert.equal(both[0].basis, 'day', '日线定动作');
assert.equal(both[0].main.period, 'day', '主判断取日线');
assert.ok(both[0].intraday != null, '60 分钟作为佐证附上');

// ===== 只有 60 分钟有信号：列出来，但标明日线还没确认 =====

const intraOnly = selectOpportunitySignals(
  [reading('515790', 'day', 'none'), reading('515790', '60m', 'turn_confirmed_bottom')],
  empty,
);
assert.equal(intraOnly.length, 1, '只有 60 分钟出信号也要列出来（两个周期并列都看）');
assert.equal(intraOnly[0].basis, 'intraday_only', '必须标明是只有 60 分钟出的');
assert.equal(intraOnly[0].intraday, null, '主判断已是 60 分钟，不再重复附一份');

// ===== 顶部信号不是买入机会 =====

assert.equal(
  selectOpportunitySignals([reading('512480', 'day', 'turn_confirmed_top')], empty).length,
  0,
  '顶部信号不得出现在买入机会清单里',
);
assert.equal(
  selectOpportunitySignals([reading('512480', 'day', 'none')], empty).length,
  0,
  '无信号不是机会',
);

// ===== 已持有的不进清单（它们在「手上这几只」那一段）=====

assert.equal(
  selectOpportunitySignals(
    [reading('512480', 'day', 'turn_confirmed_bottom')],
    new Set(['512480']),
  ).length,
  0,
  '已持有的不得重复出现在机会清单，否则会被当成两件事',
);

// ===== 个股不进：这套打法是赛道 ETF 轮动 =====

assert.equal(
  selectOpportunitySignals(
    [reading('600000', 'day', 'turn_confirmed_bottom', { assetType: 'stock' })],
    empty,
  ).length,
  0,
  '个股不进 ETF 赛道轮动的机会清单',
);

// ===== 判不了的不进：它不是机会，也不该显示成「暂无信号」=====

assert.equal(
  selectOpportunitySignals(
    [
      reading('512480', 'day', 'risk_easing_bottom', {
        unavailableReason: '只有 30 根K线，不够看出结构',
      }),
    ],
    empty,
  ).length,
  0,
  '数据不足判不了的不得进机会清单',
);

// ===== 排序：日线的排前面，各自按背驰强度降序 =====

const sorted = selectOpportunitySignals(
  [
    reading('A00001', '60m', 'turn_confirmed_bottom', { divergenceStrength: 0.99 }),
    reading('B00002', 'day', 'risk_easing_bottom', { divergenceStrength: 0.3 }),
    reading('C00003', 'day', 'turn_confirmed_bottom', { divergenceStrength: 0.8 }),
  ],
  empty,
);
assert.deepEqual(
  sorted.map((s) => s.main.code),
  ['C00003', 'B00002', 'A00001'],
  '日线的排前面（它们才可执行），各自按背驰强度降序；60 分钟的垫底',
);

// ===== 1R 目标价：按最不利的入场价算 =====

// 入场 10.2（区间上沿）、止损 9.5 → 风险 0.7 → 目标 10.9
assert.equal(firstRTargetOf(10.2, 9.5), 10.9, '1R = 入场 + （入场 − 止损）');
assert.equal(firstRTargetOf(10, 10), null, '止损不低于入场价时算不出 1R');
assert.equal(firstRTargetOf(10, 11), null, '止损高于入场价时算不出 1R');
assert.equal(firstRTargetOf(0, 9.5), null, '入场价无效时返回 null');

rmSync(tmpDir, { recursive: true, force: true });
console.log(
  '✅ 机会清单自检通过：两周期合成一条 / 日线定动作 / 已持有与个股不进 / 排序 / 1R 按最不利入场价',
);
