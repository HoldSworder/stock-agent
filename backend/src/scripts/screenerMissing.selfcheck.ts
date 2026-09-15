// 选股「不许为了凑出结果而静默降级」自检（无框架，assert 断言，不碰网络与数据库）。
//
// 两条同源的规则：
//   1. 取不到的因子不许按 50 分参与排名（第 1~5 节）
//   2. 硬筛不许为了凑出结果自动放宽（第 6 节）
// 都是同一个毛病的两种形态：宁可交一张凑出来的榜，也不肯说「今天没有」。
//
// 原先的行为：分位、题材、趋势、龙头等因子缺失一律记 50（中性）。
// 后果用算术说明最清楚——
//   甲股：五个因子齐全，分别 30/30/30/30/30 → 总分 30（真实弱势）
//   乙股：只取到一个因子 20 分，另四个缺失记 50 → 总分 0.2×20+0.8×50 = 44
// 乙股什么都没证明，却排在甲股前面 14 分。**榜单前列可能是数据缺口而非强势。**
//
// 还有一处更隐蔽：涨跌幅缺失经取数层的 num() 变成 0%，
// 而 dual_low 策略的动量理想值正是 0 → 缺失反而拿满分动量。

import assert from 'node:assert/strict';
import {
  scoreCandidates,
  __test__MAX_MISSING_WEIGHT,
  type ThemeContext,
} from '../screener/scorer';
import type { SnapshotRow } from '../screener/snapshot';
import type { ScreenStrategyDef } from '../screener/strategy';
import { __test__applyHardFilterWithFallback } from '../screener/engines';

/** 造一行快照。不传的字段即「取不到」 */
function row(p: Partial<SnapshotRow> & Pick<SnapshotRow, 'code'>): SnapshotRow {
  return {
    name: `测试${p.code}`,
    price: 10,
    pct: 1,
    amount: 5,
    turnoverRate: 3,
    volumeRatio: 1.2,
    pe: 20,
    pb: 2,
    marketCap: 100,
    industry: '半导体',
    ...p,
  };
}

const theme: ThemeContext = {
  industryHeat: new Map([['半导体', 70]]),
  keywords: [],
};

/**
 * 造一个只用指定因子的策略定义。
 *
 * 不用 `as ScreenStrategyDef` 强制转换：那会掩盖字段名写错
 * （第一版就把 hardFilters 写成了 hardFilter，编译器因为转换而没报）。
 */
function def(weights: ScreenStrategyDef['factorWeights']): ScreenStrategyDef {
  return {
    id: 'selfcheck',
    name: '自检用',
    description: '自检构造，不进策略库',
    factorWeights: weights,
    momentumIdeal: { ideal: 0, tolerance: 3 },
    activityIdeal: { ideal: 5, tolerance: 4 },
    hardFilters: {},
  };
}

// ===== 1. 缺失因子记 null，不记 50 =====
{
  const d = def({ size: 0.5, themeHeat: 0.5 });
  const rows = [
    row({ code: '000001' }),
    // 没有市值、没有行业 → size 与 themeHeat 都取不到
    row({ code: '000002', marketCap: null, industry: '' }),
  ];
  const scored = scoreCandidates(rows, d, theme);
  const bad = scored.find((s) => s.row.code === '000002')!;

  for (const f of bad.factors) {
    assert.equal(f.score, null, `${f.key} 取不到数，必须记 null 而不是 50`);
    assert.equal(f.weight, null, `${f.key} 取不到数时贡献也必须是 null`);
  }
  assert.deepEqual(bad.missingFactors.sort(), ['size', 'themeHeat']);
  assert.equal(bad.missingWeight, 1, '两个因子全缺，缺失权重应为 100%');
  assert.equal(bad.rankable, false, '数据全缺的不该参与排名');
}

// ===== 2. 真实弱势不该被数据缺口反超（原 bug 的算术复现）=====
//
// 这是整个工单的核心。若哪天有人把缺失又改回 50，这一条会立刻失败。
{
  const d = def({ size: 0.2, value: 0.2, liquidity: 0.2, activity: 0.2, themeHeat: 0.2 });

  // 甲：数据齐全但样样垫底（大市值、高估值、低流动性、冷门行业）
  const weakButComplete = row({
    code: '600001',
    marketCap: 9000,
    pe: 900,
    pb: 90,
    amount: 0.01,
    turnoverRate: 0.01,
    volumeRatio: 0.1,
    industry: '冷门',
  });
  // 乙：只有一个因子取到且也不高，其余全缺
  const mostlyMissing = row({
    code: '600002',
    marketCap: 5000,
    pe: null,
    pb: null,
    amount: null,
    turnoverRate: null,
    volumeRatio: null,
    industry: '',
  });
  // 丙：陪跑，让分位排名有对照
  const strong = row({ code: '600003', marketCap: 50, pe: 12, pb: 1, amount: 30 });

  const scored = scoreCandidates([weakButComplete, mostlyMissing, strong], d, theme);
  const a = scored.find((s) => s.row.code === '600001')!;
  const b = scored.find((s) => s.row.code === '600002')!;

  assert.equal(a.rankable, true, '数据齐全的弱势股应当参与排名——它是诚实的弱');
  assert.equal(
    b.rankable,
    false,
    `缺失权重 ${b.missingWeight} 超过上限 ${__test__MAX_MISSING_WEIGHT}，不该参与排名`,
  );
  // 关键：即使乙的分数算出来更高，它也不进榜。分数可以看，排名不能比。
  assert.ok(
    b.missingWeight > __test__MAX_MISSING_WEIGHT,
    '这个用例必须构造出「缺太多」的情形，否则它没在测想测的东西',
  );
}

// ===== 3. 涨跌幅缺失不许拿满分动量 =====
//
// dual_low 类策略的动量理想值是 0（要的是横盘整理的票）。
// 缺失若被填成 0%，理想点曲线给它 100 分 —— 取不到数反而成了最优。
{
  const d = def({ momentum: 1 });
  const scored = scoreCandidates(
    [row({ code: '000003', pct: 0 }), row({ code: '000004', pct: null })],
    d,
    theme,
  );
  const real = scored.find((s) => s.row.code === '000003')!;
  const miss = scored.find((s) => s.row.code === '000004')!;

  assert.equal(real.factors[0].score, 100, '真的平盘，理想值 0 → 满分，这是对的');
  assert.equal(miss.factors[0].score, null, '涨跌幅取不到不许当成平盘拿满分');
  assert.equal(miss.rankable, false, '涨跌幅取不到的不该进榜——落库那列不允许空值');
}

// ===== 4. 权重在取到数的因子之间归一，不白占也不摊薄 =====
//
// 两种错法都要排除：
//   缺失按中性摊进去 → 抬高数据不全的标的（原 bug）
//   缺失白占权重     → 等于按 0 分惩罚一次取数故障，把好票误杀
{
  const d = def({ size: 0.5, momentum: 0.5 });
  const rows = [
    row({ code: '000005', marketCap: 50, pct: 0 }),
    row({ code: '000006', marketCap: 500, pct: 0 }),
    // 市值缺失，但动量满分
    row({ code: '000007', marketCap: null, pct: 0 }),
  ];
  const scored = scoreCandidates(rows, d, theme);
  const miss = scored.find((s) => s.row.code === '000007')!;

  assert.equal(miss.missingWeight, 0.5, '缺一个等权因子，缺失权重应为 50%');
  assert.ok(
    miss.missingWeight > __test__MAX_MISSING_WEIGHT,
    '缺一半超过 1/3 上限，这条用例应当落在「不可排名」一侧',
  );
  assert.equal(miss.rankable, false, '缺一半不该参与排名');
  // 动量满分且是唯一可用因子 → 归一后总分就是 100，不是 50（被缺失摊薄的错法）
  assert.equal(miss.screenScore, 100, '唯一可用因子满分，归一后总分应为 100 而非被摊薄');
}

// ===== 5. 数据齐全的一律可排名，别把正常票误杀 =====
{
  const d = def({ size: 0.34, value: 0.33, liquidity: 0.33 });
  const scored = scoreCandidates([row({ code: '000008' }), row({ code: '000009' })], d, theme);
  for (const s of scored) {
    assert.equal(s.missingWeight, 0, `${s.row.code} 数据齐全，缺失权重应为 0`);
    assert.deepEqual(s.missingFactors, [], `${s.row.code} 数据齐全，不该有缺失因子`);
    assert.equal(s.rankable, true, `${s.row.code} 数据齐全必须可排名`);
    assert.ok(s.screenScore > 0, `${s.row.code} 应当算出一个真实分数`);
  }
}

// ===== 6. 硬筛不许为了凑出结果自动放宽 =====
//
// 原先是逐级兜底：full → skipVolumePrice → tradableOnly，哪级出结果用哪级，
// 只把「已自动放宽」写进运行说明，不阻止出榜。
//
// 问题在于：**自动放宽等于「你的条件没人满足，那我换个条件」**。
// 放量突破的全部含义就在那个成交额下限上，跳过它再出榜，出来的不是放量突破；
// 降到 tradableOnly 只剩「能不能交易」，那就是全市场，跟没筛一样。
//
// 唯一该放宽的情形是数据确实没有：盘前东财把当日量价置 0 且没有收盘缓存可用。
// 那是「取不到」，不是「没人达标」。
{
  const d = def({ momentum: 1 });
  void d; // 这一节只测硬筛，不用打分

  // 只有大票，且成交额都低于阈值
  const rows = [
    row({ code: '600011', amount: 0.1, marketCap: 100 }),
    row({ code: '600012', amount: 0.2, marketCap: 200 }),
  ];
  const needBigAmount = { amountMinYi: 100 };

  // 数据正常却没人达标 → 空结果，不放宽
  const normal = __test__applyHardFilterWithFallback(rows, needBigAmount, false);
  assert.equal(
    normal.filtered.length,
    0,
    '数据正常却没人满足成交额下限时，必须返回空——放宽之后出的榜不是这个策略的判断',
  );
  assert.equal(normal.relaxedMode, null, '数据正常时不许放宽');

  // 快照退化（量价取不到）→ 允许跳过量价阈值，其余条件照常
  const degenerate = __test__applyHardFilterWithFallback(rows, needBigAmount, true);
  assert.equal(
    degenerate.filtered.length,
    2,
    '快照退化时量价取不到，跳过量价阈值是对的——那是数据没有，不是条件没人满足',
  );
  assert.equal(degenerate.relaxedMode, 'skipVolumePrice', '要说明放宽到了哪一级');

  // 即使退化，非量价的条件也不许放宽：市值下限 1 万亿谁都不满足
  const stillStrict = __test__applyHardFilterWithFallback(
    rows,
    { amountMinYi: 100, marketCapMinYi: 1_000_000 },
    true,
  );
  assert.equal(
    stillStrict.filtered.length,
    0,
    '退化只该放宽量价阈值，市值这类与当日行情无关的条件必须继续生效',
  );

  // 有人达标时就走完整条件，不该误报放宽
  const ok = __test__applyHardFilterWithFallback(rows, { amountMinYi: 0.05 }, true);
  assert.equal(ok.filtered.length, 2);
  assert.equal(ok.relaxedMode, null, '完整条件就有结果时不该标成已放宽');
}

console.log('screenerMissing.selfcheck 全部通过');
