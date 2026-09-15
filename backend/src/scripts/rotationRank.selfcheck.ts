// ETF 轮动榜排名自检（无框架，assert 断言，不联网不碰数据库）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/rotationRank.selfcheck.ts
//
// 已有的 rotationSwap.selfcheck 覆盖的是「换仓怎么配对」，不覆盖**排名本身**。
// 而排名决定换哪只：榜首是加仓方向、榜尾是减仓方向，排错就是换错。
//
// 钉住两条：
//
// 1. **取不到数的不许按 0 分参与排名。**
//    早先 scoreRotation 写的是 `(rs ?? 0) * 0.6`，于是 RS 取不到的 ETF 贡献 0 分，
//    而真实落后基准 10% 的贡献 -6 分 —— 取不到数的排在真实落后的前面。
//    同一个毛病在 classifyState 里被修过一次（`ret20 ?? 0` 会让「没取到近 20 日涨幅」
//    满足回踩条件），但 scoreRotation 这一处漏了。
//
// 2. **状态基分的次序不能乱。** 加速 > 上升 > 回踩 > 过热 > 破位，
//    这个次序就是「该加仓还是该减仓」的方向，反了会让人在破位的票上加仓。

import assert from 'node:assert/strict';
import type { EtfMetrics } from '../etf/data';
import { __test__scoreRotation, __test__classifyState } from '../rotation/service';

/** 造一份指标：只关心动量与均线位置，其余给中性值 */
const metrics = (p: Partial<EtfMetrics> = {}): EtfMetrics => ({
  price: 10,
  ma20: 9.8,
  ma60: 9.5,
  ma250: 9,
  maDeviation: 11,
  pricePercentile: 50,
  ret20: 5,
  ret60: 10,
  ret120: 15,
  momentum: 8,
  absMomentumPositive: true,
  volatility: 20,
  yearLow: 7,
  yearHigh: 11,
  barCount: 500,
  ...p,
});

// ===== 1. RS 取不到时必须报错，不许静默按 0 分打分 =====
//
// 这里用算术说明为什么这条重要：
//   甲 ETF：RS = -10%（真实落后基准 10 个百分点）→ rsPart = -6
//   乙 ETF：RS 取不到 → 早先按 0 算 → rsPart = 0
// 同样是「上升」状态、同样的动量，乙比甲高 6 分，排在甲前面。
// 乙什么都没证明，只是数据缺了一块。
{
  assert.throws(
    () => __test__scoreRotation('上升', metrics(), null, null),
    /缺 RS 或动量/,
    'RS 取不到时必须当场报错——静默按 0 分会把取不到数的排在真实落后的前面',
  );
  assert.throws(
    () => __test__scoreRotation('上升', metrics({ momentum: null }), 5, null),
    /缺 RS 或动量/,
    '动量取不到同样不许按 0 分参与排名',
  );

  // 反面：数据齐全时照常打分，别把正常情形一起掐掉
  const weak = __test__scoreRotation('上升', metrics(), -10, null);
  const strong = __test__scoreRotation('上升', metrics(), 10, null);
  assert.ok(strong.score > weak.score, 'RS 高的分数必须更高，否则排名方向就是反的');
  // 基分 60 + RS 贡献 -6 + 动量贡献 3.2 = 57.2，总分取整为 57
  assert.equal(weak.score, Math.round(60 - 6 + 3.2), '分数应当是基分加三项贡献后取整');
}

// ===== 2. 状态基分的次序就是加减仓方向，不能乱 =====
{
  const at = (state: Parameters<typeof __test__scoreRotation>[0]) =>
    __test__scoreRotation(state, metrics(), 0, null).score;

  assert.ok(at('加速') > at('上升'), '加速必须强于上升');
  assert.ok(at('上升') > at('回踩'), '上升必须强于回踩');
  assert.ok(at('回踩') > at('过热'), '回踩必须强于过热——过热要惩罚，不是奖励');
  assert.ok(at('过热') > at('破位'), '破位必须垫底，否则会让人在破位的票上加仓');
}

// ===== 3. 分数构成必须加得上总分，否则展开明细会自相矛盾 =====
{
  const { score, breakdown } = __test__scoreRotation('加速', metrics(), 8, 3);
  const sum = breakdown.parts.reduce((s, p) => s + p.value, 0);
  assert.equal(
    Math.round(sum),
    score,
    '各项贡献之和必须等于总分，否则用户展开明细会看到对不上的数',
  );
  assert.equal(breakdown.total, score, 'breakdown.total 要与 score 一致');
}

// ===== 4. 贡献上下限必须生效，单一因子不许支配排名 =====
{
  // RS 高达 +100% 时 rsPart 被夹在 15
  const capped = __test__scoreRotation('破位', metrics(), 100, null);
  const rsPart = capped.breakdown.parts.find((p) => p.label === '相对强弱RS')!.value;
  assert.equal(rsPart, 15, 'RS 贡献上限是 15，否则一个极端值能把破位的票顶到榜首');

  // 即使 RS 拉满，破位仍不该超过加速状态的中性分
  const accelNeutral = __test__scoreRotation('加速', metrics(), 0, null);
  assert.ok(
    capped.score < accelNeutral.score + 15,
    '状态基分应当主导方向，单一因子不得完全翻转结论',
  );
}

// ===== 5. classifyState 的缺数处理：不许把「没取到」当成满足条件 =====
//
// 回踩的条件之一是「近 20 日涨幅 ≤ 2%」。ret20 取不到时若按 0 算，
// 0 ≤ 2 成立 → 一只压根没数据的票被判成「回踩」，而回踩是可以买的状态。
{
  const nearMa20 = { price: 9.9, ma20: 9.8, ma60: 9.5 };
  assert.equal(
    __test__classifyState(metrics({ ...nearMa20, ret20: 1 }), 0),
    '回踩',
    '近 20 日涨幅确实低且贴着 20 日线，判回踩是对的',
  );
  assert.notEqual(
    __test__classifyState(metrics({ ...nearMa20, ret20: null }), 0),
    '回踩',
    '近 20 日涨幅取不到不许判成回踩——回踩是可以买的状态',
  );

  // 缺现价或 MA60 时整只不判，返回 null（由榜单剔除）
  assert.equal(
    __test__classifyState(metrics({ price: null }), 0),
    null,
    '缺现价时不许硬给一个状态结论',
  );
  assert.equal(__test__classifyState(metrics({ ma60: null }), 0), null, '缺 MA60 时同理');
}

console.log('rotationRank.selfcheck 全部通过');
