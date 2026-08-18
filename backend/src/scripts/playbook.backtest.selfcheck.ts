// 战法回测引擎自检（无框架，assert 断言，全程合成 K 线不触网）。
// 校验三件最容易错的事：规则严格求值、T+1 与次根成交、成本口径可手算复现。
// 运行：cd backend && pnpm exec tsx src/scripts/playbook.backtest.selfcheck.ts
import assert from 'node:assert/strict';
import type { KlineBar, PlaybookSpec } from '@stock-agent/shared';
import { combineEquity, mergeNames, runOnBars, type SymbolRun } from '../playbook/backtest';
import { buildSeries, evalRule } from '../playbook/rules';
import { PlaybookSpecError, validatePlaybookSpec } from '../playbook/validate';

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

// ============ 6. 指标预热：不足样本一律 null，不得用垃圾值开仓 ============
{
  // EMA 自播种，第 1 根就有数值；ema3 在前 2 根必须判 null，否则 `close above ema3` 会在预热期开仓
  const b = bars([{ close: 10 }, { close: 20 }, { close: 30 }, { close: 40 }]);
  const s = buildSeries('600000', b, [
    { mode: 'all', rules: [{ kind: 'ma', maType: 'ema', left: 'close', period: 3, relation: 'above' }] },
  ]);
  const rule = { kind: 'ma', maType: 'ema', left: 'close', period: 3, relation: 'above' } as const;
  assert.equal(evalRule(rule, s, 0), false, 'EMA 第 1 根必须判不足样本，不能等于当根收盘价');
  assert.equal(evalRule(rule, s, 1), false, 'EMA 预热期一律 false');
  assert.equal(evalRule(rule, s, 2), true, 'EMA 满周期后正常求值');

  // MACD：DEA 的 EMA(9) 也要吃满才认交叉，第 26 根附近的金叉建立在 dea≈dif 的无意义信号线上
  const rise = bars(Array.from({ length: 60 }, (_, i) => ({ close: 100 + i })));
  const ms = buildSeries('600000', rise, [
    { mode: 'all', rules: [{ kind: 'macd', signal: 'goldCross' }] },
  ]);
  for (let i = 0; i < 26 + 9; i++) {
    assert.equal(ms.macd[i], null, `MACD 第 ${i} 根应判预热未完成`);
  }
  assert.ok(ms.macd[26 + 9] != null, 'MACD 满 26+9 根后应出值');

  // KDJ：国内 1/3 递推口径，全程单调上涨时 K 应逼近 100 且 K>D（国际口径的 SMA 平滑读数不同）
  const ks = buildSeries('600000', rise, [{ mode: 'all', rules: [{ kind: 'kdj', signal: 'kAbove', value: 80 }] }]);
  assert.equal(ks.kdj[7], null, 'KDJ 不足 9 根应为 null');
  assert.ok(ks.kdj[8] != null, 'KDJ 第 9 根起出值');
  const lastK = ks.kdj[rise.length - 1]!;
  assert.ok(lastK.k > 80 && lastK.k <= 100, `单边上涨 K 应高位，实际 ${lastK.k}`);
  assert.ok(lastK.k > lastK.d, '单边上涨 K 应在 D 上方');
  assert.ok(Math.abs(lastK.j - (3 * lastK.k - 2 * lastK.d)) < 1e-9, 'J = 3K - 2D');
}

// ============ 7. spec 运行时校验：非法窗口参数必须被拒，不能跑出假曲线 ============
{
  const bad: PlaybookSpec = {
    ...baseSpec,
    // days=0 时 `i < 0` 恒不成立、`bars.slice(i,i)` 为空、Math.max() 得 -Infinity，
    // 于是每根 bar 都判「创新高」，产出一条每日开仓的假曲线
    entry: { mode: 'all', rules: [{ kind: 'extreme', extreme: 'newHigh', days: 0 }] },
    exit: { mode: 'any', rules: [] },
    maxHoldBars: 2,
  };
  assert.throws(() => validatePlaybookSpec(bad), PlaybookSpecError, 'days=0 必须被拒');
  assert.throws(
    () => validatePlaybookSpec({ ...baseSpec, barLimit: 0 } as PlaybookSpec),
    PlaybookSpecError,
    'barLimit=0 必须被拒',
  );
  assert.throws(
    () => validatePlaybookSpec({ ...baseSpec, entry: { mode: 'all', rules: [{ kind: 'rsi', period: -3, op: 'gt', value: 50 }] } } as PlaybookSpec),
    PlaybookSpecError,
    '负周期必须被拒',
  );
  const ok: PlaybookSpec = {
    ...baseSpec,
    entry: { mode: 'all', rules: [{ kind: 'extreme', extreme: 'newHigh', days: 20 }] },
    exit: { mode: 'any', rules: [{ kind: 'pnlPct', op: 'lte', value: -5 }] },
  };
  assert.equal(validatePlaybookSpec(ok), ok, '合法 spec 应原样透传');

  // 生产代码用 `?.` 容忍 universe/entry/exit 整体缺失（resolveUniverse 有默认值、
  // assertRunnableSpec 明确放行「没有 exit 字段、只配止损」的 spec），schema 不得先把它判 400
  const noExit = { period: 'day', barLimit: 500, fill: 'nextOpen', entry: ok.entry, stopLossPct: 5 };
  assert.equal(validatePlaybookSpec(noExit), noExit, '缺 exit 字段（只配止损）的 spec 必须放行');
  const bare = { period: 'day', barLimit: 500, fill: 'nextOpen' };
  assert.equal(validatePlaybookSpec(bare), bare, '缺 universe/entry/exit 交给 assertRunnableSpec 报人话');

  // codes 先 trim 再校验值域：resolveUniverse 本来就 trim，历史脏数据不该被判非法
  const padded = { ...ok, universe: { kind: 'codes', codes: [' 600000', '000001\n'] } };
  assert.equal(validatePlaybookSpec(padded), padded, '带空白的代码应先 trim 再校验');
  assert.throws(
    () => validatePlaybookSpec({ ...ok, universe: { kind: 'codes', codes: ['60000'] } } as PlaybookSpec),
    PlaybookSpecError,
    '5 位代码仍必须被拒',
  );

  // 止损/止盈 0：UI 的 :min="0" 放行、后端判空用 `!= null` 把 0 当已启用，schema 不能单方面拒
  const zeroStop = { ...ok, stopLossPct: 0, takeProfitPct: 0 };
  assert.equal(validatePlaybookSpec(zeroStop), zeroStop, '止损/止盈填 0 必须与 UI、后端语义一致地放行');
  assert.throws(
    () => validatePlaybookSpec({ ...ok, stopLossPct: -1 } as PlaybookSpec),
    PlaybookSpecError,
    '负止损仍必须被拒',
  );
}

// ============ 8. 组合权益合成：新标的入池不得造出假回撤 ============
{
  // 每只标的的 equityByDate 都从它自己第一根 bar 起算、初值 1。
  // 直接对「当日有数据的标的」的权益取平均，会在 B 首次出现数据那天把均值从 2.0 拉到 1.5，
  // 凭空造出 −25% 的单日回撤，而 maxDrawdownPct 正是从这条曲线取的。
  const run = (code: string, pairs: Array<[string, number]>): SymbolRun => ({
    code,
    trades: [],
    equityByDate: new Map(pairs),
    badEntryPrice: false,
  });
  const a = run('AAA', [['2026-01-01', 1], ['2026-01-02', 2], ['2026-01-03', 2], ['2026-01-04', 2]]);
  const b = run('BBB', [['2026-01-03', 1], ['2026-01-04', 1.1]]);
  const eq = combineEquity([a, b]);
  assert.deepEqual(eq.map((p) => p.date), ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
  assert.equal(eq[0].equity, 1, '首日无前值可比，权益应为 1');
  assert.equal(eq[1].equity, 2, 'A 单只翻倍，组合权益应为 2');
  assert.equal(eq[2].equity, 2, 'B 入池当天不得把组合权益拉回 1.5');
  // B 从次日起才贡献收益：(0% + 10%) / 2 = +5%
  assert.ok(Math.abs(eq[3].equity - 2.1) < 1e-9, `B 入池次日应按等权收益计入，实际 ${eq[3].equity}`);
  let peak = 1;
  let maxDD = 0;
  for (const p of eq) {
    peak = Math.max(peak, p.equity);
    maxDD = Math.min(maxDD, p.equity / peak - 1);
  }
  assert.equal(maxDD, 0, '全程无下跌，最大回撤必须为 0');

  // 中途缺数据（停牌）按上一可得值延续，不得当成「权益归 1」
  const holed = run('CCC', [['2026-01-01', 1], ['2026-01-03', 1.2]]);
  const steady = run('DDD', [['2026-01-01', 1], ['2026-01-02', 1], ['2026-01-03', 1]]);
  const eqHoled = combineEquity([holed, steady]);
  assert.equal(eqHoled[1].equity, 1, '停牌当日只按有数据的标的算收益，权益不动');
  assert.ok(Math.abs(eqHoled[2].equity - 1.1) < 1e-9, `跨缺口那天记一次跨缺口涨跌，实际 ${eqHoled[2].equity}`);
}

console.log('✓ 战法回测引擎自检通过');
