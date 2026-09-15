// 两套前复权口径的分歧窗口自检（无框架，assert 断言，不联网）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/adjustDivergence.selfcheck.ts
//
// 系统里有两套前复权，用在不同链路上：
//   实盘：datasource/adjust.ts 的 frontAdjustDaily —— 开盘价对前收向下跳空，阈值按板别 12%~33%
//   回测：modes/factors.ts 的 adjustSplits     —— 收盘价比值 < 0.65 或 > 1.5，双向
//
// 真实数据核对（adjustDivergence.probe.ts，20 只 ETF / 500 根日 K）：
// 实盘链路认出 6 次除权折算，比例都在 0.34~0.50，两套**全部一致**，残差 0.000%。
// 原因是 ETF 份额折算通常是腰斩级别，0.50 既超过任何板别阈值、也低于 0.65。
//
// 所以 ETF 上两套重合。**分歧在中间那一段**，这个文件就是把那一段钉出来：
//
//   除权后/除权前比值落在 (0.65, 0.88] 时 —— 例如 10 送 3 的 0.769 ——
//   实盘链路会修（23% 跳空 > 板别阈值），回测链路不会修（0.769 > 0.65）。
//
// 后果：回测里那一天看起来是**凭空 -23% 的暴跌**。送股不是下跌，
// 但回测的回撤统计、止损逻辑会当成真跌处理，于是同一只票同一段历史，
// 回测与实盘算出来的结论可以相反。
//
// **这个窗口目前打不到我们**，理由要写清楚，否则后人会误判风险等级：
// 回测池是 ETF 池（tracker.ts 用 etf/repo 的 listPool，协议里标的来源写着 db-etf-pool），
// 而 ETF 只做份额折算、不送股，折算又都是腰斩级——落在第 1 节那一档，两套都认。
// 送股（0.65~0.88 这一档）只发生在个股上。
//
// 所以现状是**潜在风险而非现存错误**。真正会引爆它的动作是：
// 把个股放进回测池（中线龙头那套赛道下钻迟早要这么干）。
//
// 这条目前不动：统一口径会让已定版的回测数字变化，按 ADR 0002 要人点头。
// 自检的作用是把窗口写死在这里，谁改了任一侧的阈值、或往回测池里加了个股，
// 都会先撞上这个文件，而不是等到某天回测里冒出一根假暴跌再回来查。

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
  const out = adjustSplits(toBars(structuredClone(raw)));
  return Math.abs(out[0].c - raw[0].close) > 1e-6;
};

// ===== 1. 腰斩级折算：两套都认（ETF 份额折算的真实情形）=====
//
// 真实数据里认出的 6 次折算比例是 0.34~0.50，落在这一档。
for (const ratio of [0.34, 0.4, 0.5]) {
  assert.equal(liveFixed(ratio), true, `比值 ${ratio} 实盘链路必须认出来`);
  assert.equal(backFixed(ratio), true, `比值 ${ratio} 回测链路必须认出来`);
}

// ===== 2. 分歧窗口：10 送 3 这一档，实盘修、回测不修 =====
//
// 10 送 3 → 除权后价 = 除权前 × 10/13 = 0.769。
// 实盘：跳空 23.1%，超过板别阈值 → 修。
// 回测：0.769 > 0.65 → 不修 → 回测里这天是凭空 -23% 的暴跌。
{
  const ratio = 10 / 13;
  assert.equal(
    liveFixed(ratio),
    true,
    `10 送 3（比值 ${ratio.toFixed(3)}，跳空 23%）实盘链路应当认出来`,
  );
  assert.equal(
    backFixed(ratio),
    false,
    '10 送 3 回测链路认不出来——这就是分歧窗口。' +
      '若哪天这里变成 true，说明有人统一了口径，' +
      '那么已定版的回测数字会随之变化，按 ADR 0002 需要显式确认',
  );
}

// ===== 3. 分歧窗口的两个边界 =====
//
// 把边界钉住，任一侧阈值被改动都会在这里显形。
{
  // 略低于 0.65：两套都认，不在分歧窗口里
  assert.equal(backFixed(0.64), true, '0.64 低于回测阈值 0.65，回测应当认');
  assert.equal(liveFixed(0.64), true, '0.64 跳空 36%，实盘也应当认');

  // 略高于 0.65：回测开始不认，分歧窗口由此起
  assert.equal(backFixed(0.66), false, '0.66 高于回测阈值，回测不认——分歧窗口的下边界');
  assert.equal(liveFixed(0.66), true, '0.66 跳空 34%，实盘仍认');

  // 小幅分红除权：两套都不认（这是对的，分红不是拆股，不该按拆股修）
  assert.equal(liveFixed(0.97), false, '3% 的小幅跳空两套都不该认成拆股');
  assert.equal(backFixed(0.97), false, '同上');
}

// ===== 4. 没有除权时两套都不动（防止误修正常行情）=====
{
  const flat = withSplit(1);
  const live = frontAdjustDaily(structuredClone(flat), undefined, { code: '600000' });
  const back = adjustSplits(toBars(structuredClone(flat)));
  assert.equal(live[0].close, flat[0].close, '没有跳空时实盘链路不得改动价格');
  assert.equal(back[0].c, flat[0].close, '没有跳空时回测链路不得改动价格');
}

console.log('adjustDivergence.selfcheck 全部通过（分歧窗口已钉在 0.65~0.88 一档）');
