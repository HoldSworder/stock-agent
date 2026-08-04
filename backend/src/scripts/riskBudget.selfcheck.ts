// 风险预算反推仓位自检（无框架，assert 断言）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/riskBudget.selfcheck.ts
import assert from 'node:assert/strict';
import type { KlineBar } from '@stock-agent/shared';
import { atr, budgetForPhase, computeSizing, downGapP95 } from '../positions/riskBudget';

/** 造一段平稳日线：每日振幅固定 amp（元），无跳空 */
function flatBars(n: number, price: number, amp: number): KlineBar[] {
  return Array.from({ length: n }, (_, i) => ({
    time: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: price,
    high: price + amp / 2,
    low: price - amp / 2,
    close: price,
    volume: 1000,
    amount: 1000 * price,
  }));
}

// 1. ATR 就是平均真实波幅：固定振幅 0.4 元的平稳序列，ATR 应为 0.4
const bars = flatBars(60, 10, 0.4);
assert.equal(Math.round((atr(bars) ?? 0) * 100) / 100, 0.4, 'ATR 应等于固定振幅');
assert.equal(atr(flatBars(5, 10, 0.4)), null, '不足周期应返回 null');

// 2. 无跳空序列的向下跳空分位为 0
assert.equal(downGapP95(bars), 0, '无跳空序列不应吃掉仓位');

// 3. 主升档 ETF：结构止损 12% 主导（2×ATR=8% 更小），有效距离 12+0.2=12.2%
//    允许权重 = 2.5 / 12.2 = 20.5%，小于绝对上限 40% → 由风险预算决定
const bull = budgetForPhase('主升');
const etf = computeSizing(
  { assetType: 'etf', price: 10, stopDistancePct: 12, totalEquity: 1_000_000, currentShares: 30_000, bars },
  bull,
)!;
assert.equal(etf.gapBufferPct, 0, 'ETF 不应计跳空缓冲');
assert.equal(etf.effectiveLossPct, 12.2, '有效损失距离应为 结构止损 + 费用缓冲');
assert.equal(etf.allowedWeightPct, 20.5, '风险预算反推权重应为 2.5/12.2');
assert.ok(etf.allowedWeightPct < etf.absoluteCapPct, '本例应由风险预算而非绝对上限决定');
assert.equal(etf.allowedShares, 20_400, '100 万权益、10 元价、20.5% 权重 → 20400 股（整手向下取整）');
assert.equal(etf.reduceShares, 9_600, '持有 30000 股应提示减 9600 股');

// 4. 退潮档同一标的：预算 0.5% → 权重砍到约 1/5，仓位随阶段自动收紧
const bear = computeSizing(
  { assetType: 'etf', price: 10, stopDistancePct: 12, totalEquity: 1_000_000, currentShares: 30_000, bars },
  budgetForPhase('退潮'),
)!;
assert.ok(bear.allowedWeightPct < etf.allowedWeightPct / 4, '退潮档权重应显著低于主升档');
assert.ok(bear.reduceShares > etf.reduceShares, '退潮档应要求减更多');

// 5. 高波动标的自动少买：2×ATR 超过结构止损时由 ATR 距离接管
const wild = computeSizing(
  {
    assetType: 'stock',
    price: 10,
    stopDistancePct: 8,
    totalEquity: 1_000_000,
    currentShares: 0,
    bars: flatBars(60, 10, 1.2), // ATR=1.2 → 2×ATR=2.4 元 = 24%
  },
  bull,
)!;
assert.equal(wild.atrDistancePct, 24, '2×ATR 占价格 24%');
assert.equal(wild.effectiveLossPct, 24.2, 'ATR 距离大于结构止损时应由 ATR 接管');
assert.ok(wild.allowedWeightPct < 11, '高波动标的的允许仓位应被显著压低');

// 6. 个股跳空缓冲会进一步吃掉仓位（同参数下个股允许权重必须小于等于无跳空情形）
const gapped = [...flatBars(59, 10, 0.4)];
gapped.push({ time: '2026-03-01', open: 9, high: 9.2, low: 8.8, close: 9, volume: 1000, amount: 9000 });
const withGap = computeSizing(
  { assetType: 'stock', price: 10, stopDistancePct: 12, totalEquity: 1_000_000, currentShares: 0, bars: gapped },
  bull,
)!;
assert.ok(withGap.gapBufferPct > 0, '个股应计入向下跳空缓冲');
assert.ok(withGap.allowedWeightPct < etf.allowedWeightPct, '有跳空风险的个股允许仓位应更小');

// 7. 缺价格/成本等关键输入时不臆造仓位
assert.equal(
  computeSizing(
    { assetType: 'etf', price: 0, stopDistancePct: 12, totalEquity: 1_000_000, currentShares: 0 },
    bull,
  ),
  null,
  '无有效价格时应返回 null 而不是猜一个仓位',
);

// 8. 用户配置的单票固定上限只能收紧、不能被阶段档位放宽：
// 同一标的传入 fixedCapPct=10 后，允许权重不得超过 10%，且必须 ≤ 不带 fixedCapPct 的结果
const capped = computeSizing(
  {
    assetType: 'etf',
    price: 10,
    stopDistancePct: 12,
    totalEquity: 1_000_000,
    currentShares: 30_000,
    bars,
    fixedCapPct: 10,
  },
  bull,
)!;
assert.ok(capped.allowedWeightPct <= 10, '固定上限必须约束允许权重');
assert.ok(capped.allowedWeightPct <= etf.allowedWeightPct, '加了固定上限只能更紧');
assert.ok(capped.reduceShares > etf.reduceShares, '固定上限更紧时应要求减更多');

console.log('✅ 风险预算反推仓位自检通过');
