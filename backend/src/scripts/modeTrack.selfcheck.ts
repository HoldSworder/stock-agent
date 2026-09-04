// 主题优先站内跟踪引擎自检（无框架，assert 断言）。运行：
//   cd backend && ./node_modules/.bin/tsx src/scripts/modeTrack.selfcheck.ts
// 两段：
//   A 合成数据（离线）——盯住回放逻辑里最易写错的几处：调仓相位、最短持有拦截换手、盈利保护触发，
//     外加 supertrend 离场、除权守卫、缺数据语义、晋级门归因顺序这些「静默失效」型的坑；
//   B python 基准（需 a-stock-data sidecar）——拿回测留档的交易明细逐笔比对，因子链移植错就会失败；
//   C 决策快照区间收益（离线）——钉住「样本不足必须返回 null」，别再让 0 冒充零涨跌喂进 prompt。
// sidecar 不可达时 B 段跳过并提示，A、C 段仍然必须通过。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModeProtocolMark, ResearchModeDaily, ThemeFirstSpec } from '@stock-agent/shared';
import type { Bar, FactorRow } from '../modes/factors';
import { adjustSplits } from '../modes/factors';
import { annotateThemes, family, replayThemeFirst, shortName, type UniverseSeries } from '../modes/themeFirst';
import { isSupertrendDown, supertrendDirection } from '../modes/supertrend';
import {
  isRebalanceDay,
  loadThemeFirstContext,
  realizedReturn,
  turnoverCost,
  type Series,
} from '../modes/tracker';
import { dailyToTrades, evaluateModeGateFromDaily } from '../modes/gate';
import { RESEARCH_POOL_FALLBACK } from '../modes/researchPool';
import { modeProtocolOf, universeHashOf } from '../modes/protocol';
import { pctReturn } from '../decision/service';

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

// A7 除权守卫：坏 bar（close=0）不得把之前的全部历史价格乘 0 清零
{
  const bars: Bar[] = [
    { d: '2025-01-01', o: 10, h: 10, l: 10, c: 10, v: 100, amt: 1000 },
    { d: '2025-01-02', o: 10, h: 10, l: 10, c: 10, v: 100, amt: 1000 },
    { d: '2025-01-03', o: 0, h: 0, l: 0, c: 0, v: 0, amt: 0 },
    { d: '2025-01-04', o: 10, h: 10, l: 10, c: 10, v: 100, amt: 1000 },
  ];
  const out = adjustSplits(bars);
  assert.equal(out[0].c, 10, 'A7 坏 bar 不得把历史价格清零');
  assert.equal(out[1].c, 10);
  assert.equal(out[3].c, 10, 'A7 坏 bar 之后的价格也不得被反向放大');
}

// ===== A8 Supertrend：这条离场规则曾因公式恒为 false 而从未触发过 =====
// 手工构造的 OHLC，可逐根手算：period=3、mult=1，ATR 是前缀窗口 TR 均值。
{
  const mk = (d: number, o: number, h: number, l: number, c: number): Bar => ({
    d: `2025-03-${String(d).padStart(2, '0')}`,
    o,
    h,
    l,
    c,
    v: 1000,
    amt: 1000,
  });

  // (a) 明确上升段：每根整体抬高，收盘从不跌破下轨 → 全程多头，不触发
  const up: Bar[] = Array.from({ length: 20 }, (_, i) =>
    mk(i + 1, 100 + i * 2, 101 + i * 2, 99 + i * 2, 100.5 + i * 2),
  );
  const upDir = supertrendDirection(up, 3, 1);
  assert.ok(
    upDir.slice(3).every((d) => d === 1),
    `A8a 明确上升段不得翻空，实际 ${upDir.join(',')}`,
  );
  assert.equal(isSupertrendDown(upDir, 19, 3), false, 'A8a 上升段末根不得判离场');

  // (b) 明确下跌段：先涨 10 根建立下轨，再连续暴跌 → 必须翻空
  const down: Bar[] = [
    ...Array.from({ length: 10 }, (_, i) => mk(i + 1, 100 + i, 101 + i, 99 + i, 100.5 + i)),
    ...Array.from({ length: 8 }, (_, i) =>
      mk(11 + i, 105 - i * 6, 105 - i * 6, 98 - i * 6, 99 - i * 6),
    ),
  ];
  const downDir = supertrendDirection(down, 3, 1);
  assert.equal(downDir[downDir.length - 1], -1, `A8b 明确下跌段必须翻空，实际 ${downDir.join(',')}`);
  assert.equal(isSupertrendDown(downDir, down.length - 1, 3), true, 'A8b 应触发离场');

  // (c) 跳空低开：整根跳到前一根下轨之下，当根即翻空
  const gap: Bar[] = [
    ...Array.from({ length: 10 }, (_, i) => mk(i + 1, 100 + i, 101 + i, 99 + i, 100.5 + i)),
    mk(11, 80, 81, 79, 79.5),
  ];
  const gapDir = supertrendDirection(gap, 3, 1);
  assert.equal(gapDir[10], -1, 'A8c 跳空跌穿下轨当根就应翻空');

  // (d) 平盘：全程同价，TR=0 → ATR=0，上下轨都等于收盘，严格 </> 都不成立 → 沿用初始多头
  const flat: Bar[] = Array.from({ length: 12 }, (_, i) => mk(i + 1, 100, 100, 100, 100));
  const flatDir = supertrendDirection(flat, 3, 1);
  assert.ok(flatDir.every((d) => d === 1), 'A8d 平盘不得翻向');

  // (e) 恰好触轨：收盘正好等于前一根下轨，严格 `<` 不成立 → 不翻空
  //     前 3 根同价 100（ATR=0、上下轨都为 100），第 4 根收盘恰好 100 → 相等不算跌破
  const touch: Bar[] = [
    mk(1, 100, 100, 100, 100),
    mk(2, 100, 100, 100, 100),
    mk(3, 100, 100, 100, 100),
    mk(4, 100, 100, 100, 100),
  ];
  const touchDir = supertrendDirection(touch, 3, 1);
  assert.equal(touchDir[3], 1, 'A8e 恰好触轨（相等）不得翻空');

  // (f) 不足周期：ATR 前缀窗口样本不满 period 时一律不认翻空。
  //     必须构造「预热期内 dir 已是 −1」的序列才算真断言——用 downDir 那种前 10 根单调上涨的
  //     序列，i=2 返回 false 只是因为 dir[2]=1，把预热闸门整个删掉也照样通过。
  const earlyCrash: Bar[] = [
    mk(1, 100, 100, 100, 100), // 首根：TR=0、上下轨都等于 100
    mk(2, 60, 60, 60, 60), // 直接跌穿下轨 → dir[1] 已翻空
    mk(3, 30, 30, 30, 30),
  ];
  const crashDir = supertrendDirection(earlyCrash, 3, 1);
  assert.equal(crashDir[2], -1, 'A8f 前置条件：预热期内 dir 必须已经是 −1，否则断言是永真的');
  assert.equal(
    isSupertrendDown(crashDir, 2, 3),
    false,
    'A8f dir 虽已翻空，但 i < period 仍在 ATR 预热期，不得判离场',
  );
  assert.equal(supertrendDirection([], 3, 1).length, 0, 'A8f 空序列不应报错');

  // (g) M1：翻向刻意用**前一根**最终轨道，比教科书 Supertrend 慢一根 bar。
  //     基准 mode/etf-mainline-offense/etf-mainline-offense-research.py：
  //     st[i] = 1 if close[i] > fu[i-1] else (-1 if close[i] < fl[i-1] else st[i-1])
  //     这里钉住这一根滞后：改用当根轨道会让 dir[4] 提前翻空，与研究留档对不上。
  const lag: Bar[] = [
    ...Array.from({ length: 4 }, (_, i) => mk(i + 1, 100 + i, 101 + i, 99 + i, 100.5 + i)),
    // 宽幅长上影：当根 finalLower≈101.92 已在收盘价 101.6 之上，但前一根 finalLower=101 还在其下
    mk(5, 110, 112, 101.5, 101.6),
    mk(6, 110, 112, 101.5, 101.6),
  ];
  const lagDir = supertrendDirection(lag, 3, 1);
  assert.equal(lagDir[4], 1, `A8g 用前一根轨道判向，当根不得翻空，实际 ${lagDir.join(',')}`);
  assert.equal(lagDir[5], -1, 'A8g 滞后恰好一根：下一根才认翻空');
}

// A8h C1：口径键必须只随**申报池**变化，不随「今天取数成功的子集」抖动。
// 一只 ETF 瞬时取数失败就换 hash 的话，晋级门只回溯到第一次口径变更为止，
// MIN_TRADES/MIN_CLUSTERS 在反复截断下结构上永远攒不满。
{
  const declared = [
    { code: '159995', name: '芯片ETF' },
    { code: '515880', name: '通信ETF' },
    { code: '588000', name: '科创50ETF' },
  ];
  const spec: ThemeFirstSpec = { ...baseSpec };
  const full = modeProtocolOf(spec, declared, { policy: 'db-etf-pool', includedCount: 3 });
  const oneMissing = modeProtocolOf(spec, declared, { policy: 'db-etf-pool', includedCount: 2 });
  assert.equal(oneMissing.universeHash, full.universeHash, 'A8h 少取到一只不得改变 universeHash');
  assert.equal(
    oneMissing.protocolVersion,
    full.protocolVersion,
    'A8h 少取到一只不得改变 protocolVersion（否则晋级门样本被截断到当天）',
  );
  assert.equal(oneMissing.poolSize, 2, 'A8h 实际纳入数应落进 poolSize 这个非 key 元数据');
  // 申报池真的增删了，才允许换口径
  const added = modeProtocolOf(spec, [...declared, { code: '159819', name: '人工智能ETF' }], {
    policy: 'db-etf-pool',
  });
  assert.notEqual(added.universeHash, full.universeHash, 'A8h 申报池增删必须换 hash');

  // M4：池里混进个股就不能套 ETF 免印花税档（卖出侧会少扣 5bps，方向偏乐观）
  assert.equal(full.costBps.sellBps, full.costBps.buyBps, 'A8h 纯 ETF 池买卖单边费率相同（免印花税）');
  const mixed = modeProtocolOf(spec, [...declared, { code: '600519', name: '贵州茅台' }], {
    policy: 'db-etf-pool',
  });
  assert.equal(
    mixed.costBps.sellBps - mixed.costBps.buyBps,
    5,
    'A8h 混入个股后卖出侧必须多扣 5bps 印花税',
  );
  // 钉「有没有说清楚池子混了非场内基金」，不钉某一句固定措辞
  assert.ok(
    mixed.note.includes('非场内基金'),
    'A8h 池中混入非场内基金必须在 note 里标明（费用档会因此不同）',
  );
}

// A8i H1：跟踪侧的调仓相位必须与回测一致，非调仓日不得记换手成本。
// 每日重算 TopN 会把名次抖动当成真实换手，rebalanceDays=4 的 spec 成本拖累约为回测侧 4 倍，
// 而两者写进库的 protocolVersion 完全相同，会被晋级门与列表页当成可横向比较的证据。
{
  const axis = Array.from({ length: 100 }, (_, i) => 120 + i); // 对齐回测的 goodDates.slice(120)
  const rebalDays = axis.filter((i) => isRebalanceDay(i, 4));
  assert.equal(rebalDays.length, 25, `A8i rebalanceDays=4 时应每 4 日调一次，实际 ${rebalDays.length}/100`);
  assert.equal(isRebalanceDay(120, 4), true, 'A8i 轴起点必须是调仓日（与回测 lastRebal=-rebalanceDays 一致）');
  assert.equal(isRebalanceDay(121, 4), false, 'A8i 轴起点后一日不是调仓日');
  assert.equal(isRebalanceDay(124, 4), true, 'A8i 满 4 日后才是下一个调仓日');
  assert.equal(isRebalanceDay(130, 1), true, 'A8i rebalanceDays=1 时每天都调');
  // 非调仓日沿用前一日持仓，换手成本自然为 0
  const held = [{ code: 'AAA', name: 'A', weight: 0.5 }, { code: 'BBB', name: 'B', weight: 0.5 }];
  const costs = { buyBps: 4.6, sellBps: 4.6 };
  assert.equal(turnoverCost(held, held, costs), 0, 'A8i 持仓未变时换手成本必须为 0');
  assert.ok(
    turnoverCost(held, [{ code: 'CCC', name: 'C', weight: 1 }], costs) > 0,
    'A8i 真的换腿时才扣成本',
  );
}

// A9 realizedReturn：持仓行情全缺时必须返回 null，不能用 0 冒充「当日持平」
{
  const mkSeries = (code: string, dates: string[], closes: number[]): Series => ({
    code,
    name: code,
    theme: code,
    dates,
    bars: dates.map((d, i) => ({ d, o: closes[i], h: closes[i], l: closes[i], c: closes[i], v: 1, amt: 1 })),
    closes,
    idx: new Map(dates.map((d, i) => [d, i])),
    stCache: new Map(),
  });
  const map = new Map([['AAA', mkSeries('AAA', ['2025-03-01', '2025-03-02'], [100, 110])]]);
  const got = realizedReturn([{ code: 'AAA', name: 'A', weight: 1 }], '2025-03-01', '2025-03-02', map);
  assert.ok(got != null && Math.abs(got - 0.1) < 1e-9, `A9 正常应算出 +10%，实际 ${got}`);
  assert.equal(
    realizedReturn([{ code: 'BBB', name: 'B', weight: 1 }], '2025-03-01', '2025-03-02', map),
    null,
    'A9 持仓全部取不到行情必须返回 null，而不是 0',
  );
}

// A10 晋级门归因顺序：当日收益属于**上一日**持仓，且必须先归因再关回合
{
  const day = (date: string, code: string | null, dayReturn: number | null): ResearchModeDaily => ({
    modeId: 'm',
    date,
    source: 'system',
    holdings: code ? [{ code, name: code, weight: 1 }] : [],
    signal: [],
    dayReturn,
    cumReturn: null,
    drawdown: null,
  });
  // D1 买 A；D2 A 赚 10%（属于 D1 的持仓 A）后换成 B；D3 B 亏 5%（属于 D2 的持仓 B）后清仓
  const trades = dailyToTrades([
    day('2025-03-01', 'A', null),
    day('2025-03-02', 'B', 0.1),
    day('2025-03-03', null, -0.05),
  ]);
  assert.equal(trades.length, 2, 'A10 应还原出 A、B 两个回合');
  assert.equal(trades[0].entryDate, '2025-03-01');
  assert.ok(
    Math.abs(trades[0].netPnl - 0.1) < 1e-9,
    `A10 卖出腿必须拿到最后一段收益，实际 ${trades[0].netPnl}`,
  );
  assert.equal(trades[1].entryDate, '2025-03-02');
  assert.ok(
    Math.abs(trades[1].netPnl - -0.05) < 1e-9,
    `A10 当日新买入的标的不得背上买入前一天的涨跌，实际 ${trades[1].netPnl}`,
  );
}

// A11 晋级门按协议分段：换了引擎/标的池/成本口径之后，旧口径样本不得混进当前统计
{
  const mark = (engineVersion: string, universeHash: string): ModeProtocolMark => ({
    protocolVersion: `${engineVersion}|themeFirst|univ=db-etf-pool:${universeHash}:2|cost=b25/s25bps`,
    engineVersion,
    universePolicy: 'db-etf-pool',
    universeHash,
    poolSize: 2,
    costBps: { buyBps: 25, sellBps: 25 },
    sameAsResearchPool: true,
  });
  const day = (
    date: string,
    code: string | null,
    dayReturn: number | null,
    protocol: ModeProtocolMark | null,
  ): ResearchModeDaily => ({
    modeId: 'm',
    date,
    source: 'system',
    holdings: code ? [{ code, name: code, weight: 1 }] : [],
    signal: [],
    dayReturn,
    cumReturn: null,
    drawdown: null,
    protocol,
  });
  const v1 = null; // 加列之前的历史行
  const v2 = mark('v2-2026.08', 'aaaa');
  // 前两个回合出自旧引擎（各 +50%），后一个回合出自 v2（-10%）
  const days = [
    day('2025-01-01', 'A', null, v1),
    day('2025-01-02', 'B', 0.5, v1),
    day('2025-01-03', 'C', 0.5, v2),
    day('2025-01-04', null, -0.1, v2),
  ];
  const seg = evaluateModeGateFromDaily(days, 0);
  assert.equal(seg.trades, 1, 'A11 只应统计最新协议区段里的回合，旧口径样本不得混算');
  assert.ok(
    Math.abs(seg.totalNetPnl - -0.1) < 1e-9,
    `A11 统计的应是 v2 区段那笔 -10%，实际 ${seg.totalNetPnl}`,
  );
  // 钉「有没有交代被排除的样本数」，不钉措辞——文案会随去术语化调整
  assert.ok(
    /(\d+)\s*个交易日/.test(seg.note) && seg.note.includes('最新规则版本'),
    'A11 必须在结论里说明有多少旧口径样本被排除',
  );

  // 全程同协议时不得误切：整段都算
  const same = evaluateModeGateFromDaily(
    [
      day('2025-01-01', 'A', null, v2),
      day('2025-01-02', 'B', 0.5, v2),
      day('2025-01-03', null, -0.1, v2),
    ],
    0,
  );
  assert.equal(same.trades, 2, 'A11 同协议全程必须完整统计');

  // 只有成本口径变了也要切段：同版本同池但费率不同，收益不可比
  const cheaper: ModeProtocolMark = { ...mark('v2-2026.08', 'aaaa'), costBps: { buyBps: 0, sellBps: 0 } };
  const costSwitch = evaluateModeGateFromDaily(
    [
      day('2025-01-01', 'A', null, cheaper),
      day('2025-01-02', 'B', 0.5, cheaper),
      day('2025-01-03', null, -0.1, v2),
    ],
    0,
  );
  assert.equal(costSwitch.trades, 0, 'A11 成本口径变更同样要切段（切点之后尚无完整回合）');
}

console.log(
  '✅ A 段（合成数据）通过：主题选股 / 最短持有 / 盈利保护 / 除权修正与守卫 / 回合计数 / 缺bar估值 / ' +
    'Supertrend 七场景（含预热闸门与一根滞后）/ 协议口径键只随申报池变 / 混池成本档 / ' +
    '调仓相位与换手成本 / 缺数据返回 null / 晋级门归因顺序 / 晋级门协议分段',
);

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

// B 段固定用**研究时的 55 只内置池**，不用数据库跟踪池：
// 本段验证的是「因子链与回放逻辑的移植正确性」，而生产池会随用户增删漂移
// （实测当前 53 只，比研究池少 159695 通信嘉实、516120 化工富国，后者会改变通信主题分
// 并让 2025-09-16 那笔换仓消失），池差异会被误读成移植错误。
// 反过来也不该把这两只补进数据库跟踪池——那会改变用户实际关注池的语义，且被其它模块共用。
assert.equal(RESEARCH_POOL_FALLBACK.length, 55, '研究基准池应为 55 只');

let live: Awaited<ReturnType<typeof loadThemeFirstContext>> | null = null;
try {
  live = await loadThemeFirstContext(spec, { pool: RESEARCH_POOL_FALLBACK });
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
  console.log(
    `✅ B 段通过：${actual.length} 笔交易与 python 回测逐笔一致` +
      `（${axis[0]} ~ ${axis[axis.length - 1]}，研究基准池 ${live.universe.length}/${RESEARCH_POOL_FALLBACK.length} 只，` +
      `hash ${universeHashOf(live.universe)}）`,
  );
}

// ===== C 段：决策快照区间收益（离线） =====
{
  // 旧实现在 closes.length <= n 时返回 0，而取数恰好 60 根、n=60 正好落进这个分支，
  // 于是「相对沪深300：近60日 +0.00%」是一条伪造的事实。样本不足必须是 null（渲染「—」）。
  const closes60 = Array.from({ length: 60 }, (_, i) => 100 + i);
  assert.equal(pctReturn(closes60, 60), null, 'C1 恰好 60 根时算不出 60 日收益，必须返回 null 而不是 0');
  assert.equal(pctReturn(closes60, 61), null, 'C1 样本更少同样返回 null');

  const closes61 = Array.from({ length: 61 }, (_, i) => (i === 0 ? 100 : 200));
  assert.equal(pctReturn(closes61, 60), 100, 'C2 多一根基准即可算出：200/100-1 = +100%');

  // 基准价 ≤ 0（坏 bar 或停牌填 0）会算出 ±Infinity/NaN，同样按缺失处理
  assert.equal(pctReturn([0, 10, 20], 2), null, 'C3 基准价为 0 时必须返回 null');
  assert.equal(pctReturn([], 1), null, 'C3 空序列返回 null');
}

console.log('✅ C 段通过：区间收益样本不足/基准价非法一律返回 null');
