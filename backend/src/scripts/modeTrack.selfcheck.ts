// 主题优先站内跟踪引擎自检（无框架，assert 断言）。运行：
//   cd backend && npx tsx src/scripts/modeTrack.selfcheck.ts
// 两段：
//   A 合成数据（离线）——盯住回放逻辑里最易写错的三处：调仓相位、最短持有拦截换手、盈利保护触发；
//   B python 基准（需 a-stock-data sidecar）——拿回测留档的交易明细逐笔比对，因子链移植错就会失败。
// sidecar 不可达时 B 段跳过并提示，A 段仍然必须通过。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ThemeFirstSpec } from '@stock-agent/shared';
import type { FactorRow } from '../modes/factors';
import { adjustSplits } from '../modes/factors';
import { annotateThemes, family, replayThemeFirst, shortName, type UniverseSeries } from '../modes/themeFirst';
import { loadThemeFirstContext } from '../modes/tracker';

const MODE_ID = 'etf-mainline-theme-first-flat-leader';
/** python 回测窗口右端（mode/etf-mainline-factor-sweep 的 WIN），超出即无基准可比 */
const WINDOW_END = '2026-06-26';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');

// ===== A 段：合成数据 =====

const DATES = Array.from({ length: 20 }, (_, i) => `2025-02-${String(i + 1).padStart(2, '0')}`);

/**
 * 由收盘价 + 打分序列造因子行：均线压到很低，只留下要测的那条退出路径。
 * 打分显式给定而非由涨幅推导——打平时排序会退化到家族名字典序，会掩盖被测行为。
 */
function buildSeries(
  code: string,
  name: string,
  closes: number[],
  scores: number[],
): UniverseSeries {
  const floor = Math.min(...closes) * 0.5;
  const rows = new Map<string, FactorRow>();
  closes.forEach((c, i) => {
    const gain = scores[i];
    rows.set(DATES[i], {
      o: c,
      h: c,
      l: c,
      c,
      ma60: floor,
      ma120: floor,
      ma: { 20: floor, 30: floor, 60: floor, 120: floor },
      above60: true,
      above120: true,
      mom30: gain,
      mom60: gain,
      volRatio20: 1,
      amountRatio20: 1,
      mainlinePersist: 1,
      mainlineQualityScore: gain,
    });
  });
  return { code, name, rows };
}

const baseSpec: ThemeFirstSpec = {
  kind: 'themeFirst',
  themeKey: 'mainline_quality_score',
  leaderKey: 'mainline_quality_score',
  gates: { minThemeMembers: 1 },
  rebalanceDays: 4,
  minHoldDays: 8,
  themeTopExit: 3,
  protectGain: 0.15,
  protectDrawdown: 0.06,
  exitMa: 120,
  anchorDate: DATES[0],
};

function replay(spec: ThemeFirstSpec, universe: UniverseSeries[]) {
  annotateThemes(universe, DATES);
  return replayThemeFirst(spec, universe, DATES);
}

// family() 与名称截断：主题归类错了，后面整条主题层都会错位
assert.equal(family(shortName('半导体设备ETF国泰')), '半导体设备');
assert.equal(family(shortName('芯片ETF')), '芯片宽泛');
assert.equal(family(shortName('港美互联网LOF')), '港美互联网');
assert.equal(family(shortName('证券ETF')), '金融');

const FLAT = DATES.map(() => 100);
const ZERO = DATES.map(() => 0);

// A1 选主线主题的代表标的，且买入发生在锚点当天（idx 0 即调仓日）
{
  const strong = buildSeries(
    'AAA',
    '芯片',
    DATES.map((_, i) => 100 * 1.01 ** i),
    DATES.map((_, i) => 0.1 + 0.01 * i),
  );
  const weak = buildSeries('BBB', '证券', FLAT, ZERO);
  const r = replay(baseSpec, [strong, weak]);
  assert.equal(r.trades.length, 1, 'A1 应只有一笔（期末持有中）');
  assert.equal(r.trades[0].code, 'AAA');
  assert.equal(r.trades[0].entryDate, DATES[0]);
  assert.equal(r.trades[0].reason, '持有中');
  assert.deepEqual(r.days[0].events, [{ kind: 'enter', detail: '买入 芯片(AAA)：主题 芯片宽泛' }]);
}

// A2 最短持有拦截换手：第 4 日 BBB 已追平（打平后按家族名反超），但满 8 日才允许换
{
  const aaScore = DATES.map(() => 0.2);
  const bbScore = DATES.map((_, i) => 0.05 * i);
  const r = replay(baseSpec, [
    buildSeries('AAA', '芯片', FLAT, aaScore),
    buildSeries('BBB', '证券', FLAT, bbScore),
  ]);
  assert.equal(r.trades[0].code, 'AAA');
  assert.equal(r.trades[0].reason, '主线主题替换');
  assert.equal(r.trades[0].exitDate, DATES[8], `A2 换手应发生在第 8 日，实际 ${r.trades[0].exitDate}`);
  assert.equal(r.trades[1].code, 'BBB');
  assert.equal(r.trades[1].entryDate, DATES[8]);
}

// A3 盈利保护：浮盈超 15% 后自峰值回撤超 6%，在最近的调仓日了结
{
  // 第 8 日冲到 +40% 见顶，随后回落到 -10%（相对峰值），第 12 日为调仓日
  const px = DATES.map((_, i) => (i <= 8 ? 100 * (1 + 0.05 * i) : 140 * 0.9));
  const r = replay(baseSpec, [
    buildSeries('AAA', '芯片', px, DATES.map(() => 0.5)),
    buildSeries('BBB', '证券', FLAT, ZERO),
  ]);
  assert.equal(r.trades[0].reason, '盈利保护15%/6%');
  assert.equal(r.trades[0].exitDate, DATES[12], `A3 应在第 12 日了结，实际 ${r.trades[0].exitDate}`);
}

// A4 除权修正：中途 1 拆 2 的价格跳变要被前复权抹平
{
  const bars = [
    { d: '2025-01-01', o: 10, h: 10, l: 10, c: 10, v: 100, amt: 1000 },
    { d: '2025-01-02', o: 10, h: 10, l: 10, c: 10, v: 100, amt: 1000 },
    { d: '2025-01-03', o: 5, h: 5, l: 5, c: 5, v: 200, amt: 1000 },
  ];
  const out = adjustSplits(bars);
  assert.equal(out[0].c, 5, 'A4 拆股前的价格应被折半');
  assert.equal(out[2].c, 5);
  assert.equal(out[0].v, 200, 'A4 拆股前的成交量应被放大');
}

// A5 交易次数按完整回合计：A2 场景有一次换手（1 笔已平 + 1 笔持有中），
// 旧口径把买腿卖腿分别 +1，会把次数报成约两倍
{
  const r = replay(baseSpec, [
    buildSeries('AAA', '芯片', FLAT, DATES.map(() => 0.2)),
    buildSeries('BBB', '证券', FLAT, DATES.map((_, i) => 0.05 * i)),
  ]);
  assert.equal(r.trades.length, 2, 'A5 场景应为 2 个回合');
  assert.equal(r.tradeCount, r.trades.length, 'tradeCount 必须等于完整回合数');
}

// A6 持仓当日缺 bar（停牌/数据缺口）：净值沿用上一次有效估值，
// 不得塌回未计浮盈的 cash——那会在曲线上造出假回撤并污染 maxDrawdown
{
  const px = DATES.map((_, i) => 100 * 1.02 ** i);
  const strong = buildSeries('AAA', '芯片', px, DATES.map(() => 0.5));
  const weak = buildSeries('BBB', '证券', FLAT, ZERO);
  const full = replay(baseSpec, [strong, weak]);
  const holed = buildSeries('AAA', '芯片', px, DATES.map(() => 0.5));
  holed.rows.delete(DATES[5]); // 第 6 日停牌
  const r = replay(baseSpec, [holed, buildSeries('BBB', '证券', FLAT, ZERO)]);
  assert.ok(r.days[5].equity > 1.05, `缺 bar 当日不得塌回现金，实际 ${r.days[5].equity}`);
  assert.equal(r.days[5].equity, r.days[4].equity, '缺 bar 当日应沿用上一日估值');
  assert.ok(r.maxDrawdown >= full.maxDrawdown - 1e-9, '缺 bar 不得凭空放大最大回撤');
  void weak;
}

console.log('✅ A 段（合成数据）通过：主题选股 / 最短持有 / 盈利保护 / 除权修正 / 回合计数 / 缺bar估值');

// ===== B 段：与 python 回测留档逐笔比对 =====

interface ExpectedTrade {
  entryDate: string;
  exitDate: string;
  code: string;
  reason: string;
}

/** 从种子取 spec，保证自检与线上跑的是同一份参数 */
function readSpec(): ThemeFirstSpec {
  const seed = JSON.parse(
    readFileSync(resolve(repo, 'backend/src/seeds/research-modes-seed.json'), 'utf-8'),
  ) as Array<{ mode: { id: string; spec?: ThemeFirstSpec } }>;
  const spec = seed.find((e) => e.mode.id === MODE_ID)?.mode.spec;
  assert.ok(spec && spec.kind === 'themeFirst', `种子里缺少 ${MODE_ID} 的 themeFirst spec`);
  return spec;
}

/** 解析 python 落档的交易明细表 */
function readExpected(): ExpectedTrade[] {
  const md = readFileSync(
    resolve(repo, `mode/${MODE_ID}/backtest-data/trades_theme_first_flat_leader.md`),
    'utf-8',
  );
  return md
    .split('\n')
    .filter((l) => l.startsWith('| 20'))
    .map((l) => {
      const cells = l.split('|').map((c) => c.trim());
      return { entryDate: cells[1], exitDate: cells[2], code: cells[3], reason: cells[12] };
    });
}

const spec = readSpec();
const expected = readExpected();
assert.ok(expected.length > 0, '未解析到基准交易');

let live: Awaited<ReturnType<typeof loadThemeFirstContext>> | null = null;
try {
  live = await loadThemeFirstContext(spec);
} catch (e) {
  console.warn(`⚠️  B 段跳过：行情取数失败（${e instanceof Error ? e.message : e}）。`);
  console.warn('   需 a-stock-data sidecar 可达，配置见设置页 astockBaseUrl。');
}

if (live) {
  const axis = live.dates.filter((d) => d <= WINDOW_END);
  assert.ok(axis.length > 200, `窗口内交易日不足：${axis.length}`);
  const actual = replayThemeFirst(spec, live.universe, axis).trades;

  const rows = Math.max(expected.length, actual.length);
  const diffs: string[] = [];
  for (let i = 0; i < rows; i++) {
    const e = expected[i];
    const a = actual[i];
    // 期末未平仓时 python 记「持有中」并把统计日写成窗口末日，TS 侧 exitDate 为 null
    const aExit = a ? (a.exitDate ?? axis[axis.length - 1]) : '';
    if (!e || !a || e.entryDate !== a.entryDate || e.exitDate !== aExit || e.code !== a.code || e.reason !== a.reason) {
      diffs.push(
        `#${i + 1} 期望 ${e ? `${e.entryDate}→${e.exitDate} ${e.code} ${e.reason}` : '(无)'}` +
          ` / 实际 ${a ? `${a.entryDate}→${aExit} ${a.code} ${a.reason}` : '(无)'}`,
      );
    }
  }
  if (diffs.length) {
    console.error(`交易序列不一致（${diffs.length}/${rows} 笔）：`);
    for (const d of diffs) console.error('  ' + d);
  }
  assert.equal(diffs.length, 0, 'TS 回放与 python 回测的交易序列不一致');
  console.log(`✅ B 段通过：${actual.length} 笔交易与 python 回测逐笔一致（${axis[0]} ~ ${axis[axis.length - 1]}）`);
}
