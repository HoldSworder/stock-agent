// 主线阶段状态机 + 核心股跨日延续自检（无框架，assert 断言）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/breadthStage.selfcheck.ts
import assert from 'node:assert/strict';
import {
  assessPersistence,
  competitiveRanks,
  shouldKeepFadedBoard,
  stageAction,
  takeWithFading,
} from '../breadth/service';
import type { BoardBreadthSnapshotRow } from '../breadth/repo';

const hist = (
  rows: Array<{ date: string; count: number; rank: number; core: string[] }>,
): BoardBreadthSnapshotRow[] =>
  rows.map((r) => ({
    tradeDate: r.date,
    boardCode: 'BK0001',
    boardName: '半导体',
    kind: 'concept' as const,
    newHighCount: r.count,
    consTotal: 100,
    ratio: r.count,
    rank: r.rank,
    coreCodes: r.core,
  }));

const CORE_A = ['000001', '000002', '000003', '000004', '000005'];
const CORE_B = ['600001', '600002', '600003', '600004', '600005'];

// 1. 达标 + 稳居榜首 + 核心股完全延续 → 主升，允许追领涨
const advancing = assessPersistence(1, 20, 20, hist([
  { date: '2026-08-01', count: 18, rank: 1, core: CORE_A },
  { date: '2026-07-31', count: 16, rank: 1, core: CORE_A },
]), CORE_A);
assert.equal(advancing.stage, 'advancing', '同一批核心股连续居首应确认为主升');
assert.equal(advancing.action, 'lead', '主升应允许追领涨');
assert.equal(advancing.continuity.overlap, 1, '核心股完全一致时重叠率应为 1');

// 2. 新高数与排名完全一样，但核心股换了一批 → 拒绝确认为主升。
// 该板块此前已居榜首（wasMainline），确认失败后落到分歧而非重新酝酿：它的领涨时刻已经过去，
// 只是靠换一批股维持住了数量，这时只减不加比放行试仓更贴近实际风险。
const rotated = assessPersistence(1, 20, 20, hist([
  { date: '2026-08-01', count: 18, rank: 1, core: CORE_A },
  { date: '2026-07-31', count: 16, rank: 1, core: CORE_A },
]), CORE_B);
assert.equal(rotated.continuity.overlap, 0, '核心股全换时重叠率应为 0');
assert.notEqual(rotated.stage, 'advancing', '核心股换血不得确认为主升（这是本次改造的核心防线）');
assert.equal(rotated.action, 'hold_only', '曾居首但确认失败应落到分歧，只减不加');

// 2b. 从未居首的板块首次达标 → 酝酿，只允许试仓
const brewing = assessPersistence(3, 12, 12, hist([
  { date: '2026-08-01', count: 11, rank: 4, core: CORE_A },
]), CORE_A);
assert.equal(brewing.stage, 'brewing', '首次达标且从未居首应为酝酿');
assert.equal(brewing.action, 'probe', '酝酿只允许试仓');

// 3. 历史快照没有 coreCodes（改造前的旧行）→ 延续度未知，不阻断确认
const legacy = assessPersistence(1, 20, 20, hist([
  { date: '2026-08-01', count: 18, rank: 1, core: [] },
  { date: '2026-07-31', count: 16, rank: 1, core: [] },
]), CORE_A);
assert.equal(legacy.continuity.overlap, null, '历史行无核心股时重叠率应为未知');
assert.equal(legacy.stage, 'advancing', '延续度未知不应阻断确认，否则改造当天主线会集体消失');

// 4. 曾居首、如今新高数腰斩 → 退幕，只退出
const faded = assessPersistence(1, 8, 8, hist([
  { date: '2026-08-01', count: 20, rank: 1, core: CORE_A },
]), CORE_A);
assert.equal(faded.stage, 'fading', '新高数腰斩应进入退幕');
assert.equal(faded.action, 'exit_only', '退幕只允许退出');

// 5. 曾居首、如今跌出榜首但仍达标 → 退幕（跌出榜首本身即宽度退潮）
const dropped = assessPersistence(4, 18, 18, hist([
  { date: '2026-08-01', count: 20, rank: 1, core: CORE_A },
]), CORE_A);
assert.equal(dropped.stage, 'fading', '跌出榜首应进入退幕');

// 6. 未达数量级地板 → 不入场景
const weak = assessPersistence(9, 3, 3, [], []);
assert.equal(weak.stage, 'none');
assert.equal(weak.action, 'none');

// 6b. 昨日核心股大面积消失（昨 5 只 → 今仅剩 1 只，且这只在昨日名单里）：
// 留存率必须读出 0.2 而不是旧口径 min() 分母下的 1.0，否则主线退潮时反而读出「核心股完全延续」
const shrunk = assessPersistence(1, 20, 20, hist([
  { date: '2026-08-03', count: 18, rank: 1, core: CORE_A },
]), [CORE_A[0]]);
assert.equal(shrunk.continuity.prevCount, 5, '分母应为昨日核心股只数');
assert.equal(shrunk.continuity.overlap, 0.2, '同一批股大面积消失时留存率必须显著下降');

// 6c. hist[0] 不是上一交易日（收盘快照漏跑，拿到的是更早的名单）→ 延续度按未知处理，
// 不得把跨了好几天的名单当成「昨日核心股」比对
const stalePrev = assessPersistence(
  1,
  20,
  20,
  hist([{ date: '2026-07-28', count: 18, rank: 1, core: CORE_A }]),
  CORE_A,
  '2026-08-04',
);
assert.equal(stalePrev.continuity.overlap, null, '上一份快照不是上一交易日时留存率应为未知');
const freshPrev = assessPersistence(
  1,
  20,
  20,
  hist([{ date: '2026-08-03', count: 18, rank: 1, core: CORE_A }]),
  CORE_A,
  '2026-08-04',
);
assert.equal(freshPrev.continuity.overlap, 1, '上一交易日快照存在时应正常算留存率');

// 6d. 昨日居首 30 只、今日新高归零：这是最该报警的退潮形态。
// 它必须①被判 fading、②仍留在榜内参与落库、③不被 Top N 截断抹掉。
// 旧口径 filter(newHighCount > 0) 会把这条整行丢弃，于是 judge 的 fading 分支永远拿不到当日记录，
// 次日 hist[0] 还会变成两天前的行导致延续性判定失真。
const zeroedHist = hist([{ date: '2026-08-03', count: 30, rank: 1, core: CORE_A }]);
assert.equal(shouldKeepFadedBoard(zeroedHist), true, '曾居榜首的板块归零后必须保留进榜');
assert.equal(
  shouldKeepFadedBoard(hist([{ date: '2026-08-03', count: 4, rank: 37, core: [] }])),
  false,
  '从未居首的普通零值板块仍应排除，否则全市场几百个零值板块会灌爆响应',
);
const zeroed = assessPersistence(41, 0, 0, zeroedHist, [], '2026-08-04', ['2026-08-03']);
assert.equal(zeroed.stage, 'fading', '昨日居首、今日归零必须判退幕');
assert.equal(zeroed.action, 'exit_only', '退幕只允许退出，持仓者需要看到这条');
assert.equal(zeroed.delta, -30, '归零板块的「较昨」必须算得出来（这正是退潮幅度证据）');
// 展示/落库截取不得把它切掉：排在第 50 位（超出 Top40）时仍要在结果里
const listed = [
  ...Array.from({ length: 49 }, () => ({ stage: 'brewing' as const, tag: 'other' })),
  { stage: 'fading' as const, tag: 'faded' },
];
assert.equal(
  takeWithFading(listed, 40).some((it) => it.tag === 'faded'),
  true,
  '退幕板块排在 Top N 之外时必须被补回，否则退出提示会被截断抹掉',
);

// 6e. 环比 delta / 腰斩判据必须与 continuity 共用同一个新鲜度口径：
// hist[0] 不是上一交易日时，拿三天前的数字当「较昨」用会误报退潮（收盘快照漏跑是常态）
const staleDelta = assessPersistence(
  1,
  20,
  20,
  hist([{ date: '2026-07-28', count: 60, rank: 1, core: CORE_A }]),
  CORE_A,
  '2026-08-04',
);
assert.equal(staleDelta.delta, null, '上一份快照不是上一交易日时不得给出「较昨」环比');
assert.notEqual(
  staleDelta.stage,
  'fading',
  '不能拿三天前的 60 只跟今天的 20 只比来判腰斩退潮',
);

// 6f. 连续达标天数按 distinct 交易日对齐：某天该板块缺席（未入榜）时序列必须断开，
// 不能把缺席日前后两天直接接起来报成连续
const gapHist = hist([
  { date: '2026-08-03', count: 20, rank: 1, core: CORE_A }, // 达标
  // 2026-07-31 该板块缺席（无行）
  { date: '2026-07-30', count: 20, rank: 1, core: CORE_A }, // 达标
]);
const gapDates = ['2026-08-03', '2026-07-31', '2026-07-30'];
assert.equal(
  assessPersistence(1, 20, 20, gapHist, CORE_A, '2026-08-04', gapDates).streakDays,
  2,
  '缺席日必须按未达标断开连续段（今日 + 08-03 共 2 日）',
);
assert.equal(
  assessPersistence(1, 20, 20, gapHist, CORE_A, '2026-08-04').streakDays,
  3,
  '不传交易日序列时退回按 hist 逐行计算（自检构造数据的旧行为）',
);

// 6g. 竞争排名：新高数并列即同名次（1,1,3），否则「并列第一但占比低 0.1pt」的板块拿 rank=2，
// 在 TOP_RANK=1 口径下一天都不计入 topDays，PERSIST_TOP_DAYS>=3 永远无法满足
assert.deepEqual(competitiveRanks([30, 30, 25, 20, 20, 20, 18]), [1, 1, 3, 4, 4, 4, 7]);
// 但并列第一不能无限扩：超过 3 个即当日无明确主线，整组降到 TOP_RANK 之外。
// 否则 rank=1 的独占语义被悄悄放宽成「所有并列第一」，wasMainline 命中面变宽，
// 次日它们只要掉出并列第一或环比腰斩就被判 fading → exit_only（标的计划的板块闸门）
assert.deepEqual(
  competitiveRanks([20, 20, 20, 20, 18]),
  [2, 2, 2, 2, 5],
  '并列第一超过 3 个视为无主线，谁都不给 isTop',
);
assert.deepEqual(
  competitiveRanks([20, 20, 20, 18]),
  [1, 1, 1, 4],
  '并列第一不超过 3 个时仍按并列同名次',
);
assert.deepEqual(competitiveRanks([]), [], '空排名池不得抛错');
const tied = assessPersistence(1, 30, 20, hist([
  { date: '2026-08-03', count: 28, rank: 1, core: CORE_A },
  { date: '2026-07-31', count: 26, rank: 1, core: CORE_A },
]), CORE_A);
assert.equal(tied.topDays, 3, '并列第一应与第一名同样计入居首天数');
assert.equal(tied.stage, 'advancing', '并列第一不得因序号靠后而无法确认主线');

// 7. 硬路由不存在「放大仓位」的出口：任何阶段都不会返回超出自身许可的动作
assert.deepEqual(
  (['none', 'brewing', 'advancing', 'diverging', 'fading'] as const).map(stageAction),
  ['none', 'probe', 'lead', 'hold_only', 'exit_only'],
  '阶段→动作映射必须保持「只收紧」的单调关系',
);

console.log('✅ 主线阶段状态机与核心股延续自检通过');
