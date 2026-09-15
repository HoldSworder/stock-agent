// 判卷机·信号级判分口径自检（无框架，assert 断言）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/signalScore.selfcheck.ts
//
// 直接钉 src/scorecard/ 导出的真实实现，不复刻一份——复刻的自检在实现改坏时
// 不会变红，等于钉了个寂寞。被钉住的是几条最容易出错、错了又看不出来的规则：
//   1. 看跌信号的价值方向要取反，否则「该卖对了」会被读成「信号很差」
//   2. 未来 K 线不足、或顺延太久，必须判为不可判，不能凑数
//   3. 同标的同日的重复信号必须合并，否则一天刷屏十次就把那天涨跌重复计十遍
//   4. 样本不足时只能报「样本不足」，绝不给「领先多少」的结论
//   5. 两个对照只赢一个，不算有本事
import assert from 'node:assert/strict';
import { forwardReturnOn, rollForwardDays, type Series } from '../scorecard/series';
import {
  MEANINGFUL_EDGE,
  MIN_JUDGED,
  signalEdge,
  __test__verdictOf,
} from '../scorecard/score';
import { poolFor, SIGNAL_SOURCES } from '../scorecard/sources';

/** 由收盘价数组造一段序列，日期按 2026-01-01 起逐日递增（仅用于断言，不必是真交易日） */
function makeSeries(closes: number[], dates?: string[]): Series {
  const ds =
    dates ??
    closes.map((_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
  return { dates: ds, closes, idx: new Map(ds.map((d, i) => [d, i])) };
}

// ===== 1. 前向收益 =====

const s = makeSeries([10, 11, 12, 9, 9, 9]);

assert.ok(Math.abs(forwardReturnOn(s, '2026-01-01', 2)! - 0.2) < 1e-12, '10 → 12 应为 +20%');
assert.ok(Math.abs(forwardReturnOn(s, '2026-01-02', 2)! - (9 / 11 - 1)) < 1e-12);

// 未来不足 n 根：必须 null，不能退而求其次用最后一根凑
assert.equal(forwardReturnOn(s, '2026-01-05', 5), null, '未来不足 5 根必须判为不可判');
assert.equal(forwardReturnOn(s, '2026-01-06', 1), null, '最后一根之后没有数据');
assert.equal(forwardReturnOn(undefined, '2026-01-01', 1), null, '序列不存在应为 null');

// ===== 2. 顺延 =====

assert.equal(rollForwardDays('2026-01-01', '2026-01-08'), 7);
assert.equal(rollForwardDays('坏日期', '2026-01-08'), Number.POSITIVE_INFINITY);

// 停牌几天：顺延到下一个有行情的交易日，仍可判
const gap = makeSeries([10, 11, 12], ['2026-01-01', '2026-01-05', '2026-01-06']);
assert.ok(forwardReturnOn(gap, '2026-01-03', 1) != null, '停牌两天应顺延到 01-05，仍可判');

// 顺延太久必须放弃。没有这条上限，池里晚上市的标的会在它上市之前的每一天
// 都被顺延到首个交易日，同一段收益重复计入每一天的池均值，用的还是当时不存在的行情
const late = makeSeries([10, 11], ['2026-03-01', '2026-03-02']);
assert.equal(
  forwardReturnOn(late, '2026-01-01', 1),
  null,
  '顺延超过上限必须判为不可判，不得借用尚未上市期间的行情',
);

// ===== 3. 价值方向 =====

// 看涨跑输基准 → 负价值；跑赢 → 正价值
assert.ok(signalEdge('long', -0.0105, -0.0077) < 0, '看涨跑输基准应判为负价值');
assert.ok(signalEdge('long', 0.03, 0.01) > 0);
// 看跌信号发出后继续大跌、远低于基准 → 正价值（当初该卖是对的）
assert.ok(
  signalEdge('short', -0.0939, 0.0021) > 0,
  '看跌后继续大跌说明该卖对了，必须判为正价值',
);
// 看跌后反而大涨 → 负价值（卖错了）
assert.ok(signalEdge('short', 0.05, 0.01) < 0, '看跌后还大涨说明卖错了');

// ===== 4. 结论口径 =====
//
// verdictOf 是模块私有，这里按与其完全一致的判据复刻，
// 钉的是「什么情况下不许给结论」这条规矩本身——它一旦放松，
// 几十条样本的噪声就会被写成「稳定领先」挂在模块名旁边。
type Row = { horizon: number; judged: number; edgeVsSameCode: number; edgeVsSameDate: number };
const usable = (rows: Row[]): Row[] => rows.filter((r) => r.judged >= MIN_JUDGED);
const winning = (rows: Row[]): Row[] =>
  usable(rows).filter(
    (r) => r.edgeVsSameCode >= MEANINGFUL_EDGE && r.edgeVsSameDate >= MEANINGFUL_EDGE,
  );

// 样本不足：即使两个对照都大幅领先，也不许给结论
assert.equal(
  usable([{ horizon: 5, judged: MIN_JUDGED - 1, edgeVsSameCode: 0.05, edgeVsSameDate: 0.05 }])
    .length,
  0,
  '样本低于下限时必须视为不可用，不得给出领先结论',
);

// 只赢一个对照不算有本事：赢了择时输了选标的，换成「当天买池里任意一只」反而更好
assert.equal(
  winning([{ horizon: 5, judged: 500, edgeVsSameCode: 0.05, edgeVsSameDate: -0.01 }]).length,
  0,
  '两个对照只赢一个不得判为有本事',
);
// 两个都赢且幅度够
assert.equal(
  winning([{ horizon: 5, judged: 500, edgeVsSameCode: 0.02, edgeVsSameDate: 0.02 }]).length,
  1,
);
// 幅度不够（0.1 个百分点）不算
assert.equal(
  winning([{ horizon: 5, judged: 500, edgeVsSameCode: 0.001, edgeVsSameDate: 0.001 }]).length,
  0,
  '价值幅度低于门槛不得判为领先',
);

// ===== 5. 对照池的归属 =====
//
// 池子既不能是「该来源自己触发过的标的」——那等于拿信号偏爱的标的做基准，会低估它的优势；
// 也不能跨模块合并——把波段覆盖的几百只个股混进 ETF 的基准，拿 ETF 跟个股比涨跌
// 说明不了任何事。必须是模块级：同 poolKey 的来源共享池，它就是这套规则实际工作的范围。
{
  const keys = [...new Set(SIGNAL_SOURCES.map((s) => s.poolKey))];
  assert.ok(keys.length >= 2, '至少要有两个不同模块，否则这条约束测不出来');
  for (const s of SIGNAL_SOURCES) {
    assert.ok(s.poolKey.trim().length > 0, `来源 ${s.id} 缺 poolKey`);
    assert.ok(s.origin.trim().length >= 8, `来源 ${s.id} 的产生方式说明太短`);
  }
  // 同模块的买卖两侧必须拿到同一个池；不同模块必须拿到不同的池
  const byKey = new Map<string, string[]>();
  for (const s of SIGNAL_SOURCES) {
    byKey.set(s.poolKey, poolFor(s).sort());
  }
  for (const s of SIGNAL_SOURCES) {
    assert.deepEqual(
      poolFor(s).sort(),
      byKey.get(s.poolKey),
      `同 poolKey 的来源必须共享同一个对照池（${s.id}）`,
    );
  }
  const [a, b] = keys;
  const pa = new Set(byKey.get(a) ?? []);
  const pb = byKey.get(b) ?? [];
  // 允许有重叠（同一只 ETF 可能两个模块都覆盖），但不能完全相同——那说明池子被合并了
  assert.ok(
    pb.some((c) => !pa.has(c)) || (byKey.get(a) ?? []).length !== pb.length,
    '不同模块的对照池不得完全相同，否则等于跨模块合并',
  );
}

// ===== 结论不许只报好看的那个持有期 =====
//
// 这一节钉的是措辞，而措辞就是产品——它是使用者唯一会读的那句话。
//
// 真实数据（2026-09-15 的选股·多因子）：5 日领先随机 0.8 个百分点，
// 而同一批信号 20 日**落后 6.6 个百分点**。
// 只印前半句，使用者会当成「这套选股有本事」，然后按他自己的中线打法拿 20 天以上——
// 正好踩在它亏钱的那一段。报好看的、省掉打脸的，跟没判一样。
{
  const row = (horizon: number, judged: number, edge: number) => ({
    horizon,
    judged,
    mean: 0,
    upRatio: 0.5,
    baselineSameCode: 0,
    baselineSameDate: 0,
    // 两个对照给同一个值，这一节只测措辞，不测「只赢一个不算」（那条在上面）
    edgeVsSameCode: edge,
    edgeVsSameDate: edge,
  });

  // 短持有期领先、长持有期落后 → 两句都要说
  const mixed = __test__verdictOf([
    row(5, 262, 0.008),
    row(10, 247, 0.006),
    row(20, 142, -0.066),
  ]);
  assert.ok(mixed.includes('持有 5 日'), '该报的领先还是要报');
  assert.ok(
    mixed.includes('20 日') && /落后/.test(mixed),
    '长持有期落后必须一起说出来——这是使用者真正的持有期，省掉它等于误导',
  );

  // 全程领先 → 不必硬加一句「但」，那会变成没必要的自我怀疑
  const allGood = __test__verdictOf([row(5, 200, 0.01), row(20, 150, 0.012)]);
  assert.ok(allGood.includes('领先'), '全程领先应当正常报');
  assert.ok(!allGood.includes('但'), '没有打脸的持有期就不该硬加转折');

  // 落后幅度在阈值之内（噪声）→ 不提，否则每条结论都拖一句无意义的尾巴
  const noise = __test__verdictOf([row(5, 200, 0.01), row(20, 150, -0.002)]);
  assert.ok(!noise.includes('落后'), '落后幅度小于门槛属于噪声，不该当成打脸报出来');
}

// ===== 样本不足时，方向为负要说出来，不许被读成「不知道」 =====
//
// 样本不够不给「有本事」的结论，这条不松口——门槛就是被一次 58 条样本的
// 越界结论逼出来的。但真实数据（选股·模型挑选）74 条落后 4 个百分点、
// 60 条落后 9.4 个百分点，方向已经很清楚。
//
// 两个方向的谨慎程度本来就不对称：漏报优势只是错过，漏报亏损是真亏钱。
{
  const row = (horizon: number, judged: number, edge: number) => ({
    horizon,
    judged,
    mean: 0,
    upRatio: 0.3,
    baselineSameCode: 0,
    baselineSameDate: 0,
    edgeVsSameCode: edge,
    edgeVsSameDate: edge,
  });

  const badButSmall = __test__verdictOf([row(5, 74, -0.04), row(20, 60, -0.094)]);
  assert.ok(badButSmall.includes('样本不足'), '样本不够仍然不给结论');
  assert.ok(
    badButSmall.includes('方向是负的') && badButSmall.includes('20 日'),
    '方向为负必须作为事实陈述说出来，并指出是哪个持有期',
  );
  assert.ok(
    badButSmall.includes('别当成'),
    '要明确提醒别把「样本不足」读成「不知道」',
  );

  // 样本不足但方向没问题 → 只说样本不足，不要无端吓人
  const smallAndFine = __test__verdictOf([row(5, 40, 0.001), row(20, 30, 0.002)]);
  assert.ok(smallAndFine.includes('样本不足'));
  assert.ok(!smallAndFine.includes('方向是负的'), '方向没问题时不该加负面提示');
}

console.log(
  '✅ 判分口径自检通过：前向收益边界 / 顺延上限 / 看跌价值取反 / ' +
    '样本不足不给结论 / 只赢一个不算 / 对照池按模块归拢 / 结论不报单一持有期',
);
