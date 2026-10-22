// 日线复权两套链路必须是同一句：跳空超过该品种涨跌幅极限才调整。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/adjustDivergence.selfcheck.ts
//
// 实盘看开盘/前收，回测看相邻收盘。本文件让开盘和收盘同步跳空，比的是门槛而不是取数位置。
// ±10% 用 12%（比值低于 0.88 才认）。不再使用 0.65 / 1.5。

import assert from 'node:assert/strict';
import { frontAdjustDaily } from '../datasource/adjust';
import { adjustSplits } from '../modes/factors';
import type { KlineBar } from '@stock-agent/shared';

/**
 * 造一段日 K：前半段价格 base，在第 half 根上按 ratio 除权（当天开盘就跳空到低价）。
 *
 * 除权当天开盘 = 前收 × ratio，这是两套算法各自的判据所看的地方：
 * 实盘看开盘/前收，回测看收盘/前收。所以这里让开盘与收盘同步跳空，
 * 两套都能看到同样的证据，比的是**阈值**而不是取数口径。
 */
function withSplit(ratio: number, n = 40, half = 20, base = 10): KlineBar[] {
  const bars: KlineBar[] = [];
  for (let i = 0; i < n; i++) {
    const p = i < half ? base : base * ratio;
    bars.push({
      time: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: p,
      high: p * 1.01,
      low: p * 0.99,
      close: p,
      volume: 10_000,
      amount: p * 10_000,
    });
  }
  return bars;
}

const toBars = (ks: KlineBar[]) =>
  ks.map((b) => ({
    d: b.time,
    o: b.open,
    h: b.high,
    l: b.low,
    c: b.close,
    v: b.volume,
    amt: b.amount ?? b.close * b.volume,
  }));

/** 某套算法有没有认出这次除权：认出了，除权前的价会被压低 */
const liveFixed = (ratio: number): boolean => {
  const raw = withSplit(ratio);
  const out = frontAdjustDaily(structuredClone(raw), undefined, { code: '600000' });
  return Math.abs(out[0].close - raw[0].close) > 1e-6;
};
const backFixed = (ratio: number): boolean => {
  const raw = withSplit(ratio);
  const out = adjustSplits(toBars(structuredClone(raw)), '600000');
  return Math.abs(out[0].c - raw[0].close) > 1e-6;
};

// ===== 1. 腰斩级折算：两套都认（ETF 份额折算的真实情形）=====
//
// 真实数据里认出的 6 次折算比例是 0.34~0.50，落在这一档。
for (const ratio of [0.34, 0.4, 0.5]) {
  assert.equal(liveFixed(ratio), true, `比值 ${ratio} 实盘链路必须认出来`);
  assert.equal(backFixed(ratio), true, `比值 ${ratio} 回测链路必须认出来`);
}

// ===== 2. 10 送 3：两套都认。不再把 0.769 留成回测里的假暴跌 =====
{
  const ratio = 10 / 13;
  assert.equal(liveFixed(ratio), true, `10 送 3（比值 ${ratio.toFixed(3)}）实盘应当认`);
  assert.equal(backFixed(ratio), true, '10 送 3 回测也应当认，和实盘同一条门槛');
}

// ===== 3. 门槛边界：低于 0.88 认，小额分红不认 =====
{
  assert.equal(backFixed(0.87), true, '跳空超过 12% 时回测应当认');
  assert.equal(liveFixed(0.87), true, '跳空超过 12% 时实盘应当认');
  assert.equal(backFixed(0.89), false, '没超过 12% 时回测不认');
  assert.equal(liveFixed(0.89), false, '没超过 12% 时实盘不认');
  assert.equal(liveFixed(0.97), false, '3% 的现金分红不放大量，也不当折算');
  assert.equal(backFixed(0.97), false, '同上');
}

// ===== 4. 没有除权时两套都不动（防止误修正常行情）=====
{
  const flat = withSplit(1);
  const live = frontAdjustDaily(structuredClone(flat), undefined, { code: '600000' });
  const back = adjustSplits(toBars(structuredClone(flat)), '600000');
  assert.equal(live[0].close, flat[0].close, '没有跳空时实盘链路不得改动价格');
  assert.equal(back[0].c, flat[0].close, '没有跳空时回测链路不得改动价格');
}

console.log('adjustDivergence.selfcheck 全部通过（两套复权同一条门槛）');
