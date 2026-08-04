// K 线 volume 单位不变式自检（无框架，assert 断言，纯离线：不碰网络与数据库）。
//
// 钉住的不变式：KlineBar.volume 一律是「手」。
//  - 新浪、mootdx 返回「股」→ 各自解析层必须 ÷ SHARES_PER_LOT；
//  - 腾讯、东财 f56 返回「手」→ 不许再除。
// 混单位不会报错，只会让量比/成交量中位数整体差 100 倍，靠人眼发现不了，故用断言把守。
//
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/klineVolumeUnit.selfcheck.ts
import assert from 'node:assert/strict';
import { SHARES_PER_LOT, type KlineBar } from '@stock-agent/shared';
import { toTencentBar } from '../market/tencent';
import { toSinaBar } from '../market/sina';
import { mapMootdxBars, volumeUnitDivisor } from '../astock/market';

/**
 * 用「成交额 ÷ 均价 ÷ volume」反推 volume 单位。≈1 是股、≈100 是手。
 * 这是单位问题唯一的客观判据（价格与成交额的单位是确定的），不依赖任何源的自述。
 */
function unitOf(bar: KlineBar): 'lot' | 'share' | 'unknown' {
  const avg = (bar.high + bar.low + bar.close) / 3;
  if (!(avg > 0) || !(bar.volume > 0) || !(bar.amount > 0)) return 'unknown';
  const ratio = bar.amount / avg / bar.volume;
  if (ratio > 30 && ratio < 300) return 'lot';
  if (ratio > 0.3 && ratio < 3) return 'share';
  return 'unknown';
}

// ===== 0. 判据本身必须真能失败 =====
// 若 unitOf 退化成恒返回 'lot'，下面所有断言都会变成摆设，故先反向验证它认得出「股」。
{
  const asShare: KlineBar = { time: '2026-08-03', open: 10, high: 10, low: 10, close: 10, volume: 1000, amount: 10_000 };
  assert.equal(unitOf(asShare), 'share', '判据必须认得出未归一的「股」，否则整份自检失效');
  assert.equal(unitOf({ ...asShare, volume: 10 }), 'lot');
}

// ===== 1. 腾讯：日线只有 6 列（实测），volume 已是「手」不得再除 =====
{
  // 2026-08-04 实测 fqkline/get 原样返回：date/open/close/high/low/volume，无第 7 列
  const row = ['2026-08-04', '1350.06', '1328.36', '1350.94', '1328.36', '37450'];
  const bar = toTencentBar(row, false);
  assert.equal(bar.volume, 37450, '腾讯 volume 是「手」，解析层不得做任何换算');
  assert.equal(bar.amount, 0, '腾讯日线本源不返回成交额，必须显式为 0 而非凑数');
  assert.equal(row.length, 6, 'fixture 必须保持实测的 6 列形状，别顺手补一列不存在的成交额');
}
{
  // 分钟线第 8 列为成交额（元）：归一后应被判为「手」口径
  const row = ['202608041030', '10.00', '10.20', '10.30', '9.90', '1000', '0.00', '1010000'];
  const bar = toTencentBar(row, true);
  assert.equal(bar.volume, 1000);
  assert.equal(bar.time, '2026-08-04 10:30', '分钟 time 必须展开到分钟，否则同日多根会被折叠去重');
  assert.equal(unitOf(bar), 'lot', '腾讯分钟线量额自洽应落在「手」量级');
}

// ===== 2. 新浪：本源给「股」，必须 ÷ SHARES_PER_LOT =====
{
  // 2026-08-04 对账用的真实量：新浪 08-03 给 9301253966（股），mootdx 同日给 93012544 手
  const bar = toSinaBar({ day: '2026-08-03', open: '10', high: '10.2', low: '9.9', close: '10', volume: '9301253966' }, false);
  assert.equal(bar.volume, 9301253966 / SHARES_PER_LOT, '新浪 volume 必须除以 SHARES_PER_LOT 归一为「手」');
  assert.ok(Math.abs(bar.volume - 93012544) / 93012544 < 0.01, '归一后应与 mootdx 同日「手」量级对齐（1% 内）');
  assert.equal(bar.amount, 0, '新浪日线不返回成交额');
  // 分钟线走同一映射，换算同样生效（mootdx 是分钟链首选源，分钟口径若分叉会整体差 100 倍）
  const min = toSinaBar({ day: '2026-08-03 14:00:00', open: '10', high: '10.2', low: '9.9', close: '10', volume: '500000' }, true);
  assert.equal(min.volume, 5000, '新浪分钟线同样要归一');
  assert.equal(min.time, '2026-08-03 14:00');
}

// ===== 3. mootdx：单位自校准（同一标的相邻请求会在「股」「手」间跳，只能反推） =====
{
  /** 造一行 mootdx 响应：unit='share' 时 amount = 均价 × vol，'lot' 时 ×100 */
  const row = (date: string, close: number, vol: number, unit: 'share' | 'lot'): Record<string, unknown> => ({
    date,
    open: close,
    high: close,
    low: close,
    close,
    vol,
    amount: unit === 'share' ? close * vol : close * vol * SHARES_PER_LOT,
  });
  // 末根一律不参与判定（当日未收盘那根口径与结算后不一致），故多垫一根
  const tail = row('2026-08-04', 10, 1000, 'lot');

  const asShare = ['2026-08-01', '2026-08-02', '2026-08-03'].map((d) => row(d, 10, 100_000, 'share'));
  const lots = mapMootdxBars([...asShare, tail], { intraday: false, limit: 10 });
  assert.equal(lots[0].volume, 1000, '「股」口径必须被归一为「手」');
  assert.ok(
    lots.slice(0, -1).every((b) => unitOf(b) === 'lot'),
    '归一后每根都应落在「手」量级',
  );

  const asLot = ['2026-08-01', '2026-08-02', '2026-08-03'].map((d) => row(d, 10, 1000, 'lot'));
  const kept = mapMootdxBars([...asLot, tail], { intraday: false, limit: 10 });
  assert.equal(kept[0].volume, 1000, '本源已给「手」时不得再除，否则量级掉 100 倍');

  // 除数只有 1 与 SHARES_PER_LOT 两档，判不出来时按「手」放行（会 console.warn 留痕）
  assert.equal(volumeUnitDivisor([...asShare, tail].map(toBarLike)), SHARES_PER_LOT);
  assert.equal(volumeUnitDivisor([...asLot, tail].map(toBarLike)), 1);
  assert.equal(
    volumeUnitDivisor([...asShare.map((r) => ({ ...r, amount: 0 })), tail].map(toBarLike)),
    1,
    '无成交额无法反推时按「手」放行（不猜），并由 warn 留痕',
  );

  // 升序 + 截尾：limit 生效且不破坏时间序
  const cut = mapMootdxBars([tail, ...asShare], { intraday: false, limit: 2 });
  assert.deepEqual(cut.map((b) => b.time), ['2026-08-03', '2026-08-04'], '必须按时间升序并保留最后 limit 根');
}

/** mootdx 原始行 → KlineBar 形状（仅供 volumeUnitDivisor 直测，不做单位换算） */
function toBarLike(r: Record<string, unknown>): KlineBar {
  return {
    time: String(r.date),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.vol),
    amount: Number(r.amount),
  };
}

console.log('klineVolumeUnit.selfcheck 全部通过');
