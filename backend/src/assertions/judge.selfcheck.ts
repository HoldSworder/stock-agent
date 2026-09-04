// 断言判定的 assert 自检。运行：cd backend && ./node_modules/.bin/tsx src/assertions/judge.selfcheck.ts
//
// 判定口径是整套统计的命根子：判错一类，攒出来的遵循率就是废数，
// 而它又恰恰是最容易被后续「顺手优化」改坏的地方。这里用构造走势把四种结局钉死。

import type { KlineBar } from '@stock-agent/shared';
import { barsAfter, judgeLevel, judgeTime } from './judge';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`自检失败：${msg}`);
};

/** 造一根 bar */
function bar(time: string, low: number, high: number, close = (low + high) / 2): KlineBar {
  return { time, open: close, close, high, low, volume: 1000, amount: 10000 };
}

/** 造 n 根横盘 bar，价格锚在 base 附近 */
function flat(from: number, n: number, base: number): KlineBar[] {
  return Array.from({ length: n }, (_, i) =>
    bar(`2026-09-${String(from + i).padStart(2, '0')}`, base - 0.05, base + 0.05, base),
  );
}

const ATR = 1;
const REACTION = 5;
const DUE = '2026-09-30';
const TODAY = '2026-10-01';

// ===== 点位断言 =====

// 触及压力位 100 后回落 1.5 ATR → 遵循
{
  const bars = [
    bar('2026-09-01', 98, 100.2), // 触及 100
    bar('2026-09-02', 98.4, 99),
    bar('2026-09-03', 98.2, 98.8),
    bar('2026-09-04', 98.0, 98.5), // 已回落 >1ATR
    ...flat(5, 3, 98),
  ];
  const r = judgeLevel(bars, 100, 'down', ATR, REACTION, DUE, TODAY);
  assert(r === 'respected', `触及压力后回落 1.5ATR 应判 respected，实际 ${r}`);
}

// 触及压力位 100 后径直上穿、窗口内不回头 → 未遵循
{
  const bars = [
    bar('2026-09-01', 99, 100.2),
    bar('2026-09-02', 100.1, 101),
    bar('2026-09-03', 100.8, 102),
    bar('2026-09-04', 101.5, 103),
    bar('2026-09-05', 102.5, 104),
    bar('2026-09-06', 103.5, 105),
    bar('2026-09-07', 104.5, 106),
  ];
  const r = judgeLevel(bars, 100, 'down', ATR, REACTION, DUE, TODAY);
  assert(r === 'violated', `触及压力后直接穿过应判 violated，实际 ${r}`);
}

// 触及支撑位 100 后反弹 → 遵循（方向相反的镜像用例）
{
  const bars = [
    bar('2026-09-01', 99.8, 101),
    bar('2026-09-02', 100.5, 101.5),
    bar('2026-09-03', 101, 102),
    ...flat(4, 4, 102),
  ];
  const r = judgeLevel(bars, 100, 'up', ATR, REACTION, DUE, TODAY);
  assert(r === 'respected', `触及支撑后反弹 1ATR 应判 respected，实际 ${r}`);
}

// 价格压根没走到该位 → untouched，且必须与 violated 区分开：
// 混为一谈会让远端位子被系统性判差，遵循率整体失真
{
  const bars = flat(1, 10, 90);
  const r = judgeLevel(bars, 100, 'down', ATR, REACTION, DUE, TODAY);
  assert(r === 'untouched', `未触及应判 untouched，实际 ${r}`);
}

// 未触及且还没到期 → 继续等，不能提前判死
{
  const bars = flat(1, 5, 90);
  const r = judgeLevel(bars, 100, 'down', ATR, REACTION, DUE, '2026-09-10');
  assert(r === null, `未到期未触及应继续等（null），实际 ${r}`);
}

// 触及了但反应窗口还没走完 → 继续等。
// 此刻判 violated 等于「还没轮到反应就说它没反应」
{
  const bars = [bar('2026-09-01', 98, 100.2), bar('2026-09-02', 99.5, 100.1)];
  const r = judgeLevel(bars, 100, 'down', ATR, REACTION, DUE, TODAY);
  assert(r === null, `反应窗口未走完应继续等（null），实际 ${r}`);
}

// ATR 越大越难判遵循：同一段走势，把 ATR 提到 5 就够不到反应阈值
{
  const bars = [
    bar('2026-09-01', 98, 100.2),
    bar('2026-09-02', 98.4, 99),
    bar('2026-09-03', 98.2, 98.8),
    bar('2026-09-04', 98.0, 98.5),
    bar('2026-09-05', 98.0, 98.5),
    bar('2026-09-06', 98.0, 98.5),
    bar('2026-09-07', 98.0, 98.5),
  ];
  assert(
    judgeLevel(bars, 100, 'down', 5, REACTION, DUE, TODAY) === 'violated',
    'ATR 放大到够不着时应判 violated',
  );
  assert(
    judgeLevel(bars, 100, 'down', 1, REACTION, DUE, TODAY) === 'respected',
    '同一段走势小 ATR 应判 respected（证明判定确实吃 ATR 快照）',
  );
}

// 到期之后才触及 → 仍判 untouched。漏了这条截断，20 天观察窗就没有意义：
// 实测曾有 9.5% 的记录是拿到期两个月后的一次触及判出来的
{
  const bars = [
    ...flat(1, 8, 90), // 到期前一直够不着 100
    bar('2026-09-20', 98, 101), // 到期后才触及
    bar('2026-09-21', 96, 98),
    bar('2026-09-22', 95, 97),
    bar('2026-09-23', 94, 96),
    bar('2026-09-24', 93, 95),
    bar('2026-09-25', 92, 94),
  ];
  const r = judgeLevel(bars, 100, 'down', ATR, REACTION, '2026-09-10', TODAY);
  assert(r === 'untouched', `到期后才触及应判 untouched，实际 ${r}`);
  // 同一段走势把到期日放宽到触及之后，就该正常判出反应
  const loose = judgeLevel(bars, 100, 'down', ATR, REACTION, '2026-09-30', TODAY);
  assert(loose === 'respected', `到期日覆盖触及时应正常判定，实际 ${loose}`);
}

// ===== 时间断言 =====

// 构造一段先涨后跌、在 09-10 附近出现确认高点的走势
const swingSeries: KlineBar[] = [
  ...Array.from({ length: 9 }, (_, i) => bar(`2026-09-${String(i + 1).padStart(2, '0')}`, 90 + i, 91 + i, 90.5 + i)),
  bar('2026-09-10', 99, 101, 100), // 高点
  ...Array.from({ length: 10 }, (_, i) => bar(`2026-09-${String(i + 11).padStart(2, '0')}`, 97 - i, 98 - i, 97.5 - i)),
];

// 预测窗口正好罩住实际转折 → 遵循
{
  const r = judgeTime(swingSeries, 'day', '2026-09-09', '2026-09-11', 3, DUE, TODAY);
  assert(r === 'respected', `转折落在窗口内应判 respected，实际 ${r}`);
}

// 预测窗口远离实际转折且窗口已过完 → 未遵循
{
  const r = judgeTime(swingSeries, 'day', '2026-09-01', '2026-09-02', 0, DUE, TODAY);
  assert(r === 'violated', `转折不在窗口内且窗口已过应判 violated，实际 ${r}`);
}

// 容差能救回边缘情况：窗口差两天，给 3 根容差就该判遵循
{
  const tight = judgeTime(swingSeries, 'day', '2026-09-06', '2026-09-07', 0, DUE, TODAY);
  const loose = judgeTime(swingSeries, 'day', '2026-09-06', '2026-09-07', 3, DUE, TODAY);
  assert(tight === 'violated' && loose === 'respected', `容差应能改变判定，实际 ${tight} / ${loose}`);
}

// ===== 判定窗口 =====

// 冻结当日那根不参与判定：它在冻结时早已走完，拿它判等于用已知结果打分
{
  const bars = [bar('2026-09-01', 98, 100.5), bar('2026-09-02', 97, 98)];
  assert(barsAfter(bars, '2026-09-01').length === 1, '冻结当日的 bar 必须排除');
  assert(barsAfter(bars, '2026-09-01')[0].time === '2026-09-02', '应只留冻结日之后的 bar');
  // 若不排除当日，这条压力位断言会因为当天那根上影线直接判出结果
  assert(
    judgeLevel(barsAfter(bars, '2026-09-01'), 100, 'down', ATR, REACTION, DUE, TODAY) === 'untouched',
    '排除当日后不应再触及',
  );
}

// eslint-disable-next-line no-console
console.log(
  '✅ assertions/judge 自检通过（反应式遵循/未遵循 · 支撑压力镜像 · 未触及不混入未遵循 · ' +
    '反应窗未走完不提前判 · 判定吃冻结 ATR · 时间落窗与容差 · 冻结当日 bar 排除）',
);
