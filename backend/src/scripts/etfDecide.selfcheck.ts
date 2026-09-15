// ETF 操作建议的卖点来源自检（无框架，assert 断言）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/etfDecide.selfcheck.ts
//
// 钉住一件事：**卖点只来自趋势走弱，不来自「涨得多」**。
// 原先「现价在近两年区间的位置 > 80」会直接判成 reduce、文案写「已进入高估分位」，
// 于是一只走在主升浪里的赛道 ETF 越涨越被劝减仓——中线主升浪的钱全在这一段。
import assert from 'node:assert/strict';
import type { EtfMetrics } from '../etf/data';
import { decide } from '../etf/service';

/** 造一份指标：只关心区间位置与动量，其余给中性值 */
const metrics = (zonePos: number, momentum: number): EtfMetrics => ({
  price: 10,
  ma20: 9.8,
  ma60: 9.5,
  ma250: 9,
  maDeviation: 11,
  pricePercentile: zonePos,
  ret20: momentum,
  ret60: momentum,
  ret120: momentum,
  momentum,
  absMomentumPositive: momentum > 0,
  volatility: 20,
  yearLow: 7,
  yearHigh: 11,
  barCount: 500,
});

// 1) 区间高位 + 趋势向上 = 主升浪途中，必须继续持有/顺势加，且不给卖点
const highAndStrong = decide(metrics(95, 12), 0, null);
assert.notEqual(highAndStrong.action, 'reduce', '区间高位不得单独触发减仓');
assert.notEqual(highAndStrong.action, 'avoid', '趋势向上时不得判为规避');
assert.equal(highAndStrong.action, 'add', '区间高位且趋势延续应顺势持有/加仓');
assert.equal(highAndStrong.sellTrigger, null, '位置高不是卖出理由，不该给卖点');

// 2) 趋势走弱才给卖点
const weak = decide(metrics(60, -8), 0, null);
assert.equal(weak.action, 'avoid', '绝对动量转负应判为规避');
assert.ok(weak.sellTrigger != null, '趋势走弱时应给出减仓参考价');

// 3) 区间低位 + 趋势向上 = 买入区（这条没变，防止改动把买点一起改坏）
const lowAndStrong = decide(metrics(10, 6), 0, null);
assert.equal(lowAndStrong.action, 'buy', '区间低位且趋势向上应为买入区');

// 4) 文案不得把位置说成估值：这个指标只是位置，不是贵或便宜
const allNotes = [...highAndStrong.notes, ...weak.notes, ...lowAndStrong.notes].join('|');
for (const banned of ['低估', '高估', '估值']) {
  assert.ok(!allNotes.includes(banned), `要点文案不得出现「${banned}」：${allNotes}`);
}

// 5) 新交易的止损是按现价生成的，价格越低它越低——正因如此它绝不能当持仓有效止损。
//    这里如实钉住它的性质，持仓止损的锚定成本在 disciplineStop.selfcheck.ts 里钉
const atHigh = decide(metrics(50, 5), 0, null);
assert.ok(atHigh.stopLoss != null, '新进场应给破位止损参考价');
assert.ok(
  atHigh.stopLoss.note?.includes('新进场'),
  '止损文案须表明它是新进场参考价，避免被当成持仓有效止损',
);

// ===== 5) 没有真实依据就不给精确买入价与止损价 =====
//
// 原先的兜底是 `现价 * 0.985`，标签写「回踩支撑」——那不是支撑位，
// 是「现价往下 1.5%」，一个凭空生成的数字穿着技术分析的外衣。
// 止损同理：`现价 * 0.95` 标成「破位止损参考价」，可那里并没有位可破。
//
// 触发条件是历史 K 线不足：不足 60 根时年线必然算不出来，
// 新上市的 ETF 拿到的全是这类假位。
{
  /** 新上市：只有 30 根日 K，年线算不出来 */
  const freshly: EtfMetrics = {
    ...metrics(50, 5),
    ma250: null,
    maDeviation: null,
    barCount: 30,
  };

  const d = decide(freshly, 0, null);
  assert.equal(
    d.buyTrigger,
    null,
    '没有网格水位也没有年线时不得给买入价——编出来的位不是支撑位',
  );
  assert.equal(d.stopLoss, null, '买入价都没有依据，止损价更不该给');
  assert.ok(
    d.notes.some((n) => n.includes('不足 60 根') && n.includes('不给买入价')),
    '要说明为什么没给价，否则「今天怎么没价」查不到原因',
  );

  // 止盈可以给（它是「涨到目标就走」的规则，不依赖支撑阻力位），但标签要说实话
  assert.ok(d.takeProfit != null, '止盈是百分比规则，不依赖网格，应当照给');
  assert.ok(
    d.takeProfit.note?.includes('没有网格水位'),
    '没有网格时的止盈标签必须讲明它只是「现价 +8%」，不是阻力位',
  );

  // 反面：年线算得出来时照常给价，别把正常情形一起掐掉
  const normal = decide({ ...metrics(50, 5), barCount: 500 }, 0, null);
  assert.ok(normal.buyTrigger != null, '有年线时应当照常给买入价');
  assert.ok(normal.stopLoss != null, '有年线时应当照常给止损价');
  assert.ok(
    normal.buyTrigger.note?.includes('年线'),
    '依据来自年线就要写年线，别继续沿用含糊的「回踩支撑」',
  );
}

console.log(
  '✅ ETF 建议自检通过：卖点只来自趋势走弱 / 区间高位不减仓 / 文案不冒充估值 / 无依据不给精确价',
);
