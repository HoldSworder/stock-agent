// 真实持仓同步自检（无框架，assert 断言，不联网不碰数据库）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/realPositionSync.selfcheck.ts
//
// 钉住的是这一层「弄错了会让人亏钱」的部分：**盈亏率**。
//
// 它不是一个展示数字：`positions/discipline.ts` 的 `holdPct = p.holdRate * 100`
// 直接决定止损与止盈判不判。所以归一化算错一次，等于纪律体检整套失效。
//
// 最危险的一条是报价缺失：现价会退回成本价（这个回退本身是对的，0 价会让市值变 0），
// 但那一刻 holdProfit 与 holdRate 恒为 0，**一只该止损的票会以「持有 0.00%」
// 的样子躺在体检报告里**，止损线与止盈线都永远碰不到。

import assert from 'node:assert/strict';
import { __test__normalize } from '../realPositions';
import { evaluateDiscipline } from '../positions/discipline';

type Holding = Parameters<typeof __test__normalize>[0];
type Quote = NonNullable<Parameters<typeof __test__normalize>[1]>;

/** 造一行账本持仓：成本 10 元、1 万股 */
const holding = (p: Partial<Holding> = {}): Holding => ({
  code: '512880',
  name: '证券ETF',
  market: '1',
  count: 10_000,
  cost: 10,
  holdDays: 30,
  rawPrice: 10,
  rawHoldProfit: 0,
  rawHoldRate: 0,
  ...p,
});

const TOTAL = 200_000;

// ===== 1. 有报价时盈亏率按现价算 =====
{
  // 现价 9 元、成本 10 元 → 亏 10%
  const p = __test__normalize(holding(), { price: 9, prevClose: 9.5 } as Quote, TOTAL);

  assert.equal(p.price, 9, '有实时报价就该用实时价');
  assert.equal(p.priceIsCostFallback, false, '有报价时不得标成成本价顶替');
  assert.equal(p.holdProfit, -10_000, '1 万股每股亏 1 元 = 亏 1 万');
  assert.equal(Math.round(p.holdRate * 10000) / 10000, -0.1, '成本 10 跌到 9 就是 -10%');
  assert.equal(p.marketValue, 90_000, '市值按现价算');
  assert.equal(p.positionRate, 90_000 / TOTAL, '仓位占比 = 市值 / 总资产');
  // 非当日建仓：当日盈亏按昨收算
  assert.equal(p.todayProfit, 10_000 * (9 - 9.5), '持有多日时当日盈亏以昨收为基准');
}

// ===== 2. 报价缺失 → 必须标出来，不能装作不亏不赚 =====
//
// 这是整个文件的核心。下面用算术说明后果：
// 成本 10 元、实际现价已跌到 8 元（亏 20%，远超 12% 的 ETF 止损线）。
// 报价取不到时现价退回 10 元，holdRate 算出来是 0 —— 不是 -20%。
// 止损判断 `holdPct <= -12` 拿 0 去比，结论是「没破」。**该走的没人告诉你。**
{
  for (const q of [undefined, { price: 0, prevClose: 0 } as Quote]) {
    const p = __test__normalize(holding(), q, TOTAL);

    assert.equal(p.price, 10, '报价取不到时退回成本价（0 价会让市值变 0，这个回退是对的）');
    assert.equal(
      p.priceIsCostFallback,
      true,
      '但必须标出来——不标的话 holdRate 恒为 0，止损与止盈永不触发',
    );
    // 这两个 0 是「算不出来」而不是「真的不亏不赚」，标志位就是用来区分这件事的
    assert.equal(p.holdProfit, 0);
    assert.equal(p.holdRate, 0);
  }
}

// ===== 3. 纪律体检遇到报价缺失必须说「判不了」，不许报 healthy =====
{
  const portfolio = {
    asOf: new Date().toISOString(),
    sourceDate: '2026-09-15',
    source: '自检构造',
    cash: 0,
    positionCount: 1,
    totalMarketValue: 100_000,
    fundMarketValue: 0,
    totalAsset: TOTAL,
    totalHoldProfit: 0,
    totalTodayProfit: 0,
    positions: [__test__normalize(holding(), undefined, TOTAL)],
    funds: [],
    closedToday: [],
  };

  const report = await evaluateDiscipline(portfolio);
  const item = report.items[0];

  assert.notEqual(
    item.status,
    'healthy',
    '现价取不到不等于健康——报 healthy 会让一只该止损的票躺在报告里',
  );
  assert.equal(item.status, 'price_unavailable', '要明确说是「判不了」这一种');
  assert.ok(
    item.flags.some((f) => f.kind === 'price_unavailable' && f.severity === 'high'),
    '判不了要按高优先级提示，别埋在低优先级里',
  );
  assert.ok(
    item.advice.includes('判不了') || item.advice.includes('没法判'),
    '建议里要直说判不了，并让人自己去券商看一眼',
  );
  // 不许因为判不了就顺带报出止损或止盈：那两个结论是拿假的 0 算出来的
  assert.ok(
    !item.flags.some((f) => f.kind === 'stop_loss' || f.kind === 'take_profit'),
    '现价不可信时不得给止损/止盈结论——那是拿假的 0% 比出来的',
  );
}

// ===== 4. 仓位超配仍要照判：它只看市值占比，跟现价准不准无关 =====
{
  // 单票占到 80%，远超 ETF 的 40% 上限
  const big = __test__normalize(holding({ count: 16_000 }), undefined, TOTAL);
  assert.equal(big.priceIsCostFallback, true);
  assert.equal(big.positionRate, 0.8, '仓位占比按成本市值算得出来');

  const report = await evaluateDiscipline({
    asOf: new Date().toISOString(),
    sourceDate: '2026-09-15',
    source: '自检构造',
    cash: 0,
    positionCount: 1,
    totalMarketValue: 160_000,
    fundMarketValue: 0,
    totalAsset: TOTAL,
    totalHoldProfit: 0,
    totalTodayProfit: 0,
    positions: [big],
    funds: [],
    closedToday: [],
  });
  assert.ok(
    report.items[0].flags.some((f) => f.kind === 'overweight'),
    '超配与现价无关，报价缺失时这条仍必须报出来',
  );
}

// ===== 5. 当日建仓的当日盈亏以买入价为基准，不用昨收 =====
//
// 用昨收会把买入之前的日内涨跌算进你的当日盈亏，
// 并经总当日盈亏扩散到当日收益率与贡献排序里。
{
  const today = __test__normalize(
    holding({ holdDays: 0, cost: 10 }),
    { price: 10.5, prevClose: 9 } as Quote,
    TOTAL,
  );
  assert.equal(
    today.todayProfit,
    10_000 * (10.5 - 10),
    '当日建仓：当日盈亏 = 现价 − 买入价，不能用昨收',
  );
  assert.equal(
    Math.round(today.todayRate * 1000) / 1000,
    0.05,
    '当日建仓的当日收益率以成本为分母',
  );

  // 对照：同样的价，持有多日时基准是昨收，两者结论必须不同
  const held = __test__normalize(
    holding({ holdDays: 5 }),
    { price: 10.5, prevClose: 9 } as Quote,
    TOTAL,
  );
  assert.notEqual(held.todayProfit, today.todayProfit, '当日建仓与持有多日不该算出同一个当日盈亏');
  assert.equal(held.todayProfit, 10_000 * (10.5 - 9));
}

console.log('realPositionSync.selfcheck 全部通过');
