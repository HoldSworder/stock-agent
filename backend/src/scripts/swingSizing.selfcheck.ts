// 仓位与额度自检。这块直接决定拿多少钱去赌，所以断言要能证伪，不能只看代码顺眼。
//
// 最要紧的是第 6 组「反向验算」：不看代码怎么写的，直接拿结果算
// 「真按这个仓位买入、真跌到止损，会亏总资产的百分之几」，
// 必须不超过 0.25%。这一条守住了，即便前面的公式被改错，也不会悄悄放大风险。
//
// 另外三道上限必须**各自**被验证为生效。只测一个总结果的话，
// 某道上限失效（比如合计额度没扣）在多数场景下看不出来——
// 只有当它恰好是最紧的那道时才暴露，而那种场景不常出现。
//
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/swingSizing.selfcheck.ts
import type { KlineBar } from '@stock-agent/shared';
import {
  computeSwingSizing,
  splitLayers,
  SINGLE_CAP_PCT,
  TOTAL_UNVERIFIED_CAP_PCT,
  SINGLE_TRADE_RISK_PCT,
  LAYER_SPLIT,
} from '../swing/sizing';

const line = (s: string): void => console.log(s);
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) line(`ok   ${name}`);
  else {
    line(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
}

/** 造一段低波动 K 线：ATR 小，风险上限就不会成为最紧的那道，便于隔离测试其他上限 */
function calmBars(price: number, n = 60): KlineBar[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 5) + i * 86400_000);
    const c = price * (1 + Math.sin(i / 9) * 0.004);
    return {
      time: d.toISOString().slice(0, 10),
      open: c,
      close: c,
      high: c * 1.004,
      low: c * 0.996,
      volume: 1_000_000,
      amount: c * 1_000_000,
    };
  });
}

/** 造一段高波动 K 线：让 ATR 撑大有效止损距离，从而让风险上限成为最紧的一道 */
function wildBars(price: number, n = 60): KlineBar[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 5) + i * 86400_000);
    const c = price * (1 + Math.sin(i / 3) * 0.06);
    return {
      time: d.toISOString().slice(0, 10),
      open: c,
      close: c,
      high: c * 1.05,
      low: c * 0.95,
      volume: 1_000_000,
      amount: c * 1_000_000,
    };
  });
}

const EQUITY = 500_000;

function main(): void {
  line('=== 仓位与额度自检 ===');
  line(
    `上限：单标的 ${SINGLE_CAP_PCT}%、未验证合计 ${TOTAL_UNVERIFIED_CAP_PCT}%、` +
      `单次最多亏总资产 ${SINGLE_TRADE_RISK_PCT}%`,
  );
  line('');

  // --- 1. 给不出建议的情形必须返回 null，而不是 0 ---
  // 「算不出来」和「算出来是 0」对使用者是两件事：前者要显示无法判断，后者是不该买
  const base = {
    assetType: 'etf' as const,
    entryPrice: 1,
    initialStop: 0.97,
    totalEquity: EQUITY,
    bars: calmBars(1),
    realPct: 0,
    etfWatchPct: 0,
    usedByOthersPct: 0,
  };
  check('总资产为 0 时返回 null（不退化成固定比例）', computeSwingSizing({ ...base, totalEquity: 0 }) === null);
  check('总资产为负时返回 null', computeSwingSizing({ ...base, totalEquity: -1 }) === null);
  check('缺止损时返回 null', computeSwingSizing({ ...base, initialStop: 0 }) === null);
  check(
    '止损方向反了（止损高于入场价）返回 null',
    computeSwingSizing({ ...base, initialStop: 1.05 }) === null,
    '底部信号的止损必须在入场价下方，反了说明上游算错，不能硬算',
  );

  // --- 2. 单标的上限生效 ---
  const single = computeSwingSizing(base);
  check('正常情形能给出建议', single != null);
  if (single) {
    line(`     单标的场景：允许 ${single.allowedPct}%，约束项 ${single.binding}，${single.note}`);
    check('不超过单标的上限', single.allowedPct <= SINGLE_CAP_PCT, `${single.allowedPct}%`);
  }

  // --- 3. 风险上限生效：高波动标的即便止损很近，也会被 ATR 撑大的有效距离压住仓位 ---
  const wild = computeSwingSizing({ ...base, bars: wildBars(1) });
  check('高波动标的能给出建议', wild != null);
  if (wild && single) {
    line(`     高波动场景：允许 ${wild.allowedPct}%，约束项 ${wild.binding}，${wild.note}`);
    check(
      '波动越大仓位越小',
      wild.allowedPct < single.allowedPct,
      `高波动 ${wild.allowedPct}% vs 低波动 ${single.allowedPct}%`,
    );
    check('高波动场景由风险上限约束', wild.binding === 'risk', `实际 ${wild.binding}`);
  }

  // --- 4. 止损越远、仓位越小（单调性）---
  const stops = [0.99, 0.97, 0.94, 0.9, 0.85];
  const byStop = stops.map((s) => ({
    stop: s,
    pct: computeSwingSizing({ ...base, initialStop: s })?.allowedPct ?? -1,
  }));
  line(`     止损距离与仓位：${byStop.map((x) => `${x.stop}→${x.pct}%`).join('  ')}`);
  check(
    '止损越远仓位单调不增',
    byStop.every((x, i) => i === 0 || x.pct <= byStop[i - 1].pct),
    byStop.map((x) => x.pct).join(','),
  );

  // --- 5. 合计额度上限生效，且未执行的建议也占额度 ---
  const nearlyFull = computeSwingSizing({ ...base, usedByOthersPct: TOTAL_UNVERIFIED_CAP_PCT - 3 });
  check('合计额度快用尽时仓位被压到剩余额度', nearlyFull != null && nearlyFull.allowedPct <= 3, `${nearlyFull?.allowedPct}%`);
  if (nearlyFull) {
    check('此时约束项标为合计额度', nearlyFull.binding === 'total', `实际 ${nearlyFull.binding}`);
  }
  const full = computeSwingSizing({ ...base, usedByOthersPct: TOTAL_UNVERIFIED_CAP_PCT });
  check('合计额度用尽时增量为 0', full != null && full.allowedPct === 0, `${full?.allowedPct}%`);
  const over = computeSwingSizing({ ...base, usedByOthersPct: TOTAL_UNVERIFIED_CAP_PCT + 5 });
  check('额度超用时增量仍为 0 而非负数', over != null && over.allowedPct === 0, `${over?.allowedPct}%`);

  // --- 6. 唯一合并公式：取真实持仓与 ETF 盯盘目标的较大者去扣 ---
  const cases: Array<{ real: number; etf: number; name: string }> = [
    { real: 4, etf: 0, name: '只有真实持仓' },
    { real: 0, etf: 4, name: '只有 ETF 盯盘建议' },
    { real: 4, etf: 6, name: 'ETF 盯盘目标更高' },
    { real: 7, etf: 3, name: '真实持仓更高' },
  ];
  const noHold = computeSwingSizing(base)?.allowedPct ?? 0;
  for (const c of cases) {
    const r = computeSwingSizing({ ...base, realPct: c.real, etfWatchPct: c.etf });
    const expected = Math.max(0, Math.round((noHold - Math.max(c.real, c.etf)) * 10) / 10);
    check(
      `${c.name}：按较大者 ${Math.max(c.real, c.etf)}% 扣减`,
      r != null && Math.abs(r.allowedPct - expected) < 0.15,
      `实际 ${r?.allowedPct}%，期望约 ${expected}%（无持仓时为 ${noHold}%）`,
    );
  }
  const held = computeSwingSizing({ ...base, realPct: SINGLE_CAP_PCT + 2 });
  check(
    '真实持仓已超目标时不再提示加仓',
    held != null && held.allowedPct === 0 && held.binding === 'already_held',
    `${held?.allowedPct}% / ${held?.binding}`,
  );
  const etfHeld = computeSwingSizing({ ...base, etfWatchPct: SINGLE_CAP_PCT + 2 });
  check(
    'ETF 盯盘已建议到上限时 swing 让路，不再加',
    etfHeld != null && etfHeld.allowedPct === 0,
    `${etfHeld?.allowedPct}%`,
  );

  // --- 7. 反向验算：真按这个仓位买、真跌到止损，亏损不超过 0.25% 总资产 ---
  // 这一条不看公式怎么写，直接从结果倒推实际风险，是整份自检里最硬的一条
  line('');
  line('     反向验算实际风险：');
  for (const stop of [0.99, 0.97, 0.94, 0.9]) {
    for (const bars of [calmBars(1), wildBars(1)]) {
      const r = computeSwingSizing({ ...base, initialStop: stop, bars });
      if (!r) continue;
      const positionValue = (r.allowedPct / 100) * EQUITY;
      const lossIfStopped = positionValue * ((1 - stop) / 1);
      const lossPctOfEquity = (lossIfStopped / EQUITY) * 100;
      const tag = bars === calmBars(1) ? '低波动' : '高波动';
      line(
        `       止损 ${stop}（跌 ${((1 - stop) * 100).toFixed(0)}%）仓位 ${r.allowedPct}% → 实际亏总资产 ${lossPctOfEquity.toFixed(3)}%`,
      );
      check(
        `实际风险不超上限（止损 ${stop}）`,
        lossPctOfEquity <= SINGLE_TRADE_RISK_PCT + 0.001,
        `实际 ${lossPctOfEquity.toFixed(3)}% > 上限 ${SINGLE_TRADE_RISK_PCT}%（${tag}）`,
      );
    }
  }

  // --- 8. 两层拆分 ---
  const { layer1Pct, layer2Pct } = splitLayers(10);
  check('第一层占四成', Math.abs(layer1Pct - 10 * LAYER_SPLIT.layer1) < 0.05, `${layer1Pct}%`);
  check('第二层占六成', Math.abs(layer2Pct - 10 * LAYER_SPLIT.layer2) < 0.05, `${layer2Pct}%`);
  check('两层合计等于总量', Math.abs(layer1Pct + layer2Pct - 10) < 0.05);
  const zeroSplit = splitLayers(0);
  check('总量为 0 时两层都是 0', zeroSplit.layer1Pct === 0 && zeroSplit.layer2Pct === 0);

  // --- 9. 说明文字必须给出上限来由 ---
  const explained = computeSwingSizing(base);
  check('给出上限来由的说明', explained != null && explained.note.length > 0, explained?.note);

  line('');
  line(failed === 0 ? 'PASS 仓位自检通过' : `FAIL ${failed} 项不达标`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
