// 战法回测引擎自检（无框架，assert 断言，全程合成 K 线不触网）。
// 校验三件最容易错的事：规则严格求值、T+1 与次根成交、成本口径可手算复现。
// 运行：cd backend && pnpm exec tsx src/scripts/playbook.backtest.selfcheck.ts
import assert from 'node:assert/strict';
import type { KlineBar, PlaybookSpec } from '@stock-agent/shared';
import { mergeNames, runOnBars } from '../playbook/backtest';
import { buildSeries, evalRule } from '../playbook/rules';

/** 合成日线：只给收盘价，开盘价可单独指定（默认等于收盘） */
function bars(rows: Array<{ close: number; open?: number; volume?: number }>): KlineBar[] {
  return rows.map((r, i) => ({
    time: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: r.open ?? r.close,
    high: Math.max(r.open ?? r.close, r.close),
    low: Math.min(r.open ?? r.close, r.close),
    close: r.close,
    volume: r.volume ?? 1000,
    amount: 0,
  }));
}

const baseSpec: PlaybookSpec = {
  universe: { kind: 'codes', codes: ['600000'] },
  period: 'day',
  barLimit: 500,
  entry: { mode: 'all', rules: [] },
  exit: { mode: 'any', rules: [] },
  fill: 'nextOpen',
};

// ============ 1. 规则求值 ============

// 均线上穿：SMA3 在第 4 根被收盘价上穿
{
  const b = bars([{ close: 10 }, { close: 9 }, { close: 8 }, { close: 12 }]);
  const s = buildSeries('600000', b, [
    { mode: 'all', rules: [{ kind: 'ma', maType: 'sma', left: 'close', period: 3, relation: 'crossUp' }] },
  ]);
  const rule = { kind: 'ma', maType: 'sma', left: 'close', period: 3, relation: 'crossUp' } as const;
  // 第 3 根（下标 2）：close 8 < SMA3=9，未上穿
  assert.equal(evalRule(rule, s, 2), false, '未上穿时不应成立');
  // 第 4 根（下标 3）：close 12 > SMA3=(9+8+12)/3≈9.67，且上一根在下方 → 上穿
  assert.equal(evalRule(rule, s, 3), true, '上穿应成立');
  // 样本不足的前两根不应因缺值而误判成立
  assert.equal(evalRule(rule, s, 1), false, '样本不足应判 false');
}

// 量比：当根量 / 前 3 根均量
{
  const b = bars([
    { close: 10, volume: 100 },
    { close: 10, volume: 100 },
    { close: 10, volume: 100 },
    { close: 10, volume: 250 },
  ]);
  const s = buildSeries('600000', b, []);
  assert.equal(evalRule({ kind: 'volRatio', days: 3, op: 'gte', value: 2.5 }, s, 3), true);
  assert.equal(evalRule({ kind: 'volRatio', days: 3, op: 'gte', value: 2.6 }, s, 3), false);
  assert.equal(evalRule({ kind: 'volRatio', days: 3, op: 'gte', value: 1 }, s, 2), false, '窗口不足应 false');
}

// 创 3 日新高（收盘口径，窗口不含当根）
{
  const b = bars([{ close: 10 }, { close: 11 }, { close: 12 }, { close: 12.5 }, { close: 12 }]);
  const s = buildSeries('600000', b, []);
  assert.equal(evalRule({ kind: 'extreme', extreme: 'newHigh', days: 3 }, s, 3), true);
  assert.equal(evalRule({ kind: 'extreme', extreme: 'newHigh', days: 3 }, s, 4), false);
}

// 连续 2 根阳线
{
  const b = bars([{ close: 10 }, { close: 11 }, { close: 12 }, { close: 11 }]);
  const s = buildSeries('600000', b, []);
  assert.equal(evalRule({ kind: 'consecutive', dir: 'up', bars: 2 }, s, 2), true);
  assert.equal(evalRule({ kind: 'consecutive', dir: 'up', bars: 2 }, s, 3), false);
}

// 涨停：主板 10%，创业板 20%
{
  const b = bars([{ close: 10 }, { close: 11 }]);
  assert.equal(evalRule({ kind: 'limit', dir: 'up' }, buildSeries('600000', b, []), 1), true);
  assert.equal(evalRule({ kind: 'limit', dir: 'up' }, buildSeries('300001', b, []), 1), false);
}

// ============ 2. 成交口径 + 成本（可手算复现） ============
{
  // d0..d1 铺垫；d1 单根涨 6% 触发买入信号 → d2 开盘 107 成交
  // 持有上限 2 根 → d4（heldBars=2）确认卖出 → d5 开盘 117.7 成交，毛收益正好 +10%
  const b = bars([
    { close: 100 },
    { close: 106 },
    { close: 106, open: 107 },
    { close: 106 },
    { close: 106 },
    { close: 118, open: 117.7 },
  ]);
  const spec: PlaybookSpec = {
    ...baseSpec,
    entry: { mode: 'all', rules: [{ kind: 'pctChange', days: 1, op: 'gte', value: 5 }] },
    exit: { mode: 'any', rules: [] },
    maxHoldBars: 2,
  };
  const trades = runOnBars('600000', b, spec);
  assert.equal(trades.length, 1, '应恰好成交一笔');
  const t = trades[0];
  assert.equal(t.entryPrice, 107, '应按次根开盘价买入');
  assert.equal(t.exitPrice, 117.7, '应按次根开盘价卖出');
  assert.equal(t.exitReason, '持有上限');
  assert.equal(t.holdBars, 3, '下标 2 买、下标 5 卖，持有 3 根');

  // 手算：买入费率 (2.5+0.1+2)bps，卖出费率 (2.5+0.1+2+5)bps，
  // 名义本金 10 万时佣金 25 元 > 最低 5 元，故最低佣金不额外摊费。
  const gross = 117.7 / 107;
  const expect = (gross * (1 - 0.00096) - 0.00046 - 1) * 100;
  assert.ok(Math.abs(t.returnPct - expect) < 1e-6, `净收益应为 ${expect.toFixed(4)}%，实得 ${t.returnPct}`);
  assert.ok(t.returnPct < 10, '扣成本后应低于 10% 毛收益');
}

// ============ 3. T+1：买入当根不确认卖出 ============
{
  const b = bars([
    { close: 100 },
    { close: 106 },
    { close: 106, open: 107 },
    { close: 108, open: 108 },
    { close: 109, open: 109 },
  ]);
  const spec: PlaybookSpec = {
    ...baseSpec,
    entry: { mode: 'all', rules: [{ kind: 'pctChange', days: 1, op: 'gte', value: 5 }] },
    // 永真卖出条件：若无 T+1 门槛会在买入当根就确认卖出
    exit: { mode: 'any', rules: [{ kind: 'pnlPct', op: 'lte', value: 1000 }] },
  };
  const trades = runOnBars('600000', b, spec);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].holdBars, 2, '永真卖出条件下最短持有 2 根（买入当根不卖 + 次根成交）');
  assert.equal(trades[0].exitReason, '卖出规则');
}

// ============ 4. 无买入信号则零成交；数据结束仍持仓要平掉 ============
{
  const flat = bars([{ close: 10 }, { close: 10 }, { close: 10 }, { close: 10 }]);
  const spec: PlaybookSpec = {
    ...baseSpec,
    entry: { mode: 'all', rules: [{ kind: 'pctChange', days: 1, op: 'gte', value: 5 }] },
    exit: { mode: 'any', rules: [{ kind: 'pnlPct', op: 'lte', value: -5 }] },
  };
  assert.equal(runOnBars('600000', flat, spec).length, 0, '无信号不应有成交');

  const rising = bars([{ close: 100 }, { close: 106 }, { close: 106, open: 107 }, { close: 120 }]);
  const held = runOnBars('600000', rising, spec);
  assert.equal(held.length, 1);
  assert.equal(held[0].exitReason, '数据结束平仓', '末根仍持仓应按收盘平掉');
}

// ============ 5. 标的名称补齐后能落到逐笔成交 ============
{
  const universe: Array<{ code: string; name?: string }> = [
    { code: '600000' },
    { code: '000001', name: '自选里已有的名字' },
    { code: '999999' },
  ];
  mergeNames(universe, new Map([['600000', '浦发银行'], ['000001', '平安银行']]));
  assert.equal(universe[0].name, '浦发银行', '缺名标的应补上');
  assert.equal(universe[1].name, '自选里已有的名字', '已有名称不应被覆盖');
  assert.equal(universe[2].name, undefined, '查不到名称应留空，不应写入空串');

  const b = bars([{ close: 100 }, { close: 106 }, { close: 106, open: 107 }, { close: 120 }]);
  const spec: PlaybookSpec = {
    ...baseSpec,
    entry: { mode: 'all', rules: [{ kind: 'pctChange', days: 1, op: 'gte', value: 5 }] },
    exit: { mode: 'any', rules: [] },
    maxHoldBars: 1,
  };
  const trades = runOnBars('600000', b, spec, undefined, universe[0].name);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].name, '浦发银行', '逐笔成交应带标的名称');
}

console.log('✓ 战法回测引擎自检通过');
