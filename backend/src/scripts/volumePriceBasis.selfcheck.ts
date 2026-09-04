// 量能口径选择自检（无框架，assert 断言，纯离线）。
//
// 钉住两条容易被静默改坏的规则：
//  1) 腾讯 fqkline 日线（日线链首选源）恒不返回成交额，此时形态判定必须走成交量口径并显式标注，
//     不能像修复前那样让放量下跌/放量滞涨/突破确认/健康回踩四条判据长期恒为 null；
//  2) 「本源不给成交额」才回退成交量；「窗口内成交额样本不足」（疑似停牌）必须降级，不许换口径复活读数。
//
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/volumePriceBasis.selfcheck.ts
import assert from 'node:assert/strict';
import type { KlineBar } from '@stock-agent/shared';
import { buildVolumeReadout, computeVolumePrice } from '../symbolPlans/volumePrice';

/** 前 20 根等量基线（volume=1000），amount 由 withAmount 决定；末根由调用方给定 */
function series(last: KlineBar, withAmount: boolean): KlineBar[] {
  const bars: KlineBar[] = [];
  for (let i = 1; i <= 20; i++) {
    const close = 10;
    bars.push({
      time: `2026-07-${String(i).padStart(2, '0')}`,
      open: close,
      high: 10.2,
      low: 9.8,
      close,
      volume: 1000,
      amount: withAmount ? close * 1000 * 100 : 0,
    });
  }
  bars.push(last);
  return bars;
}

/** 放量下跌的末根：量比 2.0、收阴、收盘位置 ≤0.33 */
const heavyDown = (volume: number, amount: number): KlineBar => ({
  time: '2026-07-21',
  open: 10,
  high: 10.1,
  low: 9,
  close: 9.2,
  volume,
  amount,
});

// ===== 1. 本源无成交额（腾讯日线）：形态判定必须照常出结论，且文案标明成交量口径 =====
{
  const vp = computeVolumePrice({
    period: 'day',
    bars: series(heavyDown(2000, 0), false),
    completeBar: true,
  });
  assert.equal(vp.amountRatio20, null, '本源无成交额时成交额比确实为 null');
  assert.equal(vp.basis?.source, 'volume', '应回退到成交量口径');
  assert.equal(vp.basis?.ratio, 2, '成交量比 = 2000 / 1000');
  assert.equal(vp.pattern, 'heavy_down', '成交量口径下四条形态判据必须照常生效，不得恒为 null');
  assert.ok(vp.verdict.includes('成交量比'), '文案必须写「成交量比」而不是冒充成交额');
  // 钉的是「有没有讲清楚这个数是拿什么算的」，不是某一句固定措辞——
  // 文案会随去术语化调整，钉死原句只会让自检在改文案时误报
  assert.ok(
    vp.verdict.includes('没有成交额') || vp.verdict.includes('本源无成交额'),
    '必须显式标注口径来源，避免使用者误读',
  );
  assert.ok(!vp.verdict.includes('成交额比'), '不得同时出现「成交额比」字样造成歧义');

  // warnings 必须随读数一起交给消费方，不能在 buildVolumeReadout 里被丢弃
  const readout = buildVolumeReadout(series(heavyDown(2000, 0), false), { completeBar: true });
  assert.equal(readout?.basis, 'volume_median20');
  assert.ok(
    readout?.warnings?.some((w) => w.includes('改用成交量') || w.includes('回退')),
    '口径回退提示必须进入 VolumeReadout.warnings',
  );
}

// ===== 2. 成交额齐全时仍优先成交额口径（不受复权影响，更稳） =====
{
  const vp = computeVolumePrice({
    period: 'day',
    bars: series(heavyDown(2000, 10 * 2000 * 100), true),
    completeBar: true,
  });
  assert.equal(vp.basis?.source, 'amount', '有成交额时不得改用成交量口径');
  assert.equal(vp.pattern, 'heavy_down');
  assert.ok(vp.verdict.includes('成交额比'));
  assert.equal(buildVolumeReadout(series(heavyDown(2000, 10 * 2000 * 100), true), { completeBar: true })?.basis, 'amount_median20');
}

// ===== 3. 成交额样本不足（疑似停牌）：必须降级，不许换成成交量口径复活 =====
{
  const bars = series(heavyDown(2000, 0), false);
  // 窗口内只有 3 根有成交额：count>0 但 < MIN_VALID_SAMPLES，属于「该降级」而非「本源不给」
  for (const i of [0, 1, 2]) bars[i].amount = bars[i].close * bars[i].volume * 100;
  const vp = computeVolumePrice({ period: 'day', bars, completeBar: true });
  assert.equal(vp.amountRatio20, null);
  assert.equal(vp.basis, null, '成交额样本不足时不得回退成交量，必须降级');
  assert.equal(vp.pattern, null, '降级场景不得给出形态结论');
  assert.equal(vp.verdict, '量能数据不足');
  assert.ok(
    vp.warnings.some((w) => w.includes('疑似停牌')),
    '样本不足必须写明疑似停牌并降级',
  );
  assert.equal(buildVolumeReadout(bars, { completeBar: true }), null, '降级场景不得给出量能读数');
}

// ===== 4. 突破确认在成交量口径下同样成立（四条判据都要能被成交量口径触发） =====
{
  const bars = series(
    { time: '2026-07-21', open: 10, high: 10.6, low: 10, close: 10.5, volume: 1300, amount: 0 },
    false,
  );
  const vp = computeVolumePrice({ period: 'day', bars, completeBar: true });
  assert.equal(vp.pattern, 'breakout_confirmed');
  assert.ok(vp.verdict.includes('成交量比'));
}

console.log('volumePriceBasis.selfcheck 全部通过');
