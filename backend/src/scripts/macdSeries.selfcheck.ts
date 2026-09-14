// MACD 序列自检：钉住两件事——重构没改变原读数，以及下标对齐是对的。
//
// 背景：calcMacd 原本自己迭代一遍 MACD 只取末两根。背驰需要完整柱序列，
// 于是抽出 calcMacdSeries 让两者共用。这类"抽公共函数"的重构最容易悄悄改变行为，
// 所以这里内联一份**原实现**逐点对比，而不是只看新实现"看起来对不对"。
//
// 第二件事更要紧：MACD 前二十几根未成型，序列长度短于输入。
// 背驰要按缠论笔切段比对柱面积，段的起止是 K 线下标；
// 若拿序列自身下标当 K 线下标，整段会错位二十几根，
// 算出来的"背驰"其实是拿两段无关区间在比——而且看起来完全正常。
//
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/macdSeries.selfcheck.ts
import { MACD, EMA } from 'trading-signals';
import type { MacdReadout } from '@stock-agent/shared';
import { calcMacd, calcMacdSeries } from '../market/indicators';

const line = (s: string): void => console.log(s);
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    line(`ok   ${name}`);
  } else {
    line(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** 重构前的原实现，逐字搬来做对照，不要"优化"它 */
function calcMacdLegacy(closes: number[]): MacdReadout | null {
  const macd = new MACD(new EMA(12), new EMA(26), new EMA(9));
  let prevDiff: number | null = null;
  let last: { dif: number; dea: number } | null = null;
  let prevHistDiff: number | null = null;
  for (const c of closes) {
    const res = macd.add(c) as { macd: number; signal: number; histogram: number } | null;
    if (!res) continue;
    if (last) prevDiff = prevHistDiff;
    prevHistDiff = res.macd - res.signal;
    last = { dif: res.macd, dea: res.signal };
  }
  if (!last) return null;
  const diff = last.dif - last.dea;
  let state: MacdReadout['state'];
  if (prevDiff != null && prevDiff <= 0 && diff > 0) state = '金叉';
  else if (prevDiff != null && prevDiff >= 0 && diff < 0) state = '死叉';
  else state = diff >= 0 ? '多头' : '空头';
  return { dif: r2(last.dif), dea: r2(last.dea), bar: r2(diff * 2), state };
}

/** 造一段有涨有跌、能触发金叉死叉的收盘序列（确定性，不用随机） */
function makeCloses(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    // 主趋势 + 两个不同周期的波动叠加，保证 DIF/DEA 会多次交叉
    const trend = 10 + i * 0.05;
    const wave = Math.sin(i / 7) * 1.2 + Math.sin(i / 23) * 2.4;
    out.push(Number((trend + wave).toFixed(3)));
  }
  return out;
}

function main(): void {
  line('=== MACD 序列自检 ===');
  line('');

  // --- 1. 重构等价性：多种长度下新旧实现读数必须完全一致 ---
  for (const n of [30, 60, 120, 260]) {
    const closes = makeCloses(n);
    const now = calcMacd(closes);
    const old = calcMacdLegacy(closes);
    check(
      `重构等价 n=${n}`,
      JSON.stringify(now) === JSON.stringify(old),
      `新 ${JSON.stringify(now)} vs 旧 ${JSON.stringify(old)}`,
    );
  }

  // --- 2. 样本不足时都返回 null，不要一个 null 一个 0 ---
  for (const n of [0, 1, 10, 25]) {
    const closes = makeCloses(n);
    const now = calcMacd(closes);
    const old = calcMacdLegacy(closes);
    check(`样本不足 n=${n} 两者一致`, now === null ? old === null : old !== null);
  }

  // --- 3. 下标对齐：序列点的 index 必须能索回原数组，且首点不是 0 ---
  const closes = makeCloses(260);
  const series = calcMacdSeries(closes);
  check('序列非空', series.length > 0);
  const first = series[0];
  check(
    '首个有效点的下标 > 0（MACD 需要预热，首点落在 0 说明对齐逻辑错了）',
    first != null && first.index > 0,
    `首点 index=${first?.index}`,
  );
  check(
    '序列长度 + 预热根数 = 输入长度',
    first != null && series.length + first.index === closes.length,
    `${series.length} + ${first?.index} vs ${closes.length}`,
  );
  check(
    'index 严格递增且步长为 1',
    series.every((p, i) => i === 0 || p.index === series[i - 1].index + 1),
  );
  check(
    '末点 index 指向最后一根 K 线',
    series[series.length - 1]?.index === closes.length - 1,
  );

  // --- 4. calcMacd 的读数就是序列末根 ---
  const readout = calcMacd(closes);
  const lastPoint = series[series.length - 1];
  check(
    'calcMacd 与序列末根一致',
    readout != null &&
      lastPoint != null &&
      readout.dif === r2(lastPoint.dif) &&
      readout.dea === r2(lastPoint.dea) &&
      readout.bar === r2(lastPoint.bar),
  );

  // --- 5. CN 口径：柱 =（DIF − DEA）× 2 ---
  check(
    'CN 口径柱值为 DIF-DEA 的两倍',
    series.every((p) => Math.abs(p.bar - (p.dif - p.dea) * 2) < 1e-9),
  );

  // --- 6. 金叉死叉能被触发（否则第 1 项的等价性检查形同虚设） ---
  const states = new Set<string>();
  for (let end = 30; end <= 260; end += 1) {
    const r = calcMacd(closes.slice(0, end));
    if (r) states.add(r.state);
  }
  check(
    '样本里出现过金叉与死叉（保证等价性检查覆盖到交叉分支）',
    states.has('金叉') && states.has('死叉'),
    `实际出现 ${[...states].join('/')}`,
  );

  line('');
  line(failed === 0 ? 'PASS MACD 序列自检通过' : `FAIL ${failed} 项不达标`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
