import type { Bar } from './factors';

// Supertrend（对齐 mode/etf-mainline-offense 的既有研究口径）：
// 真实 TR → SMA 平滑 ATR → HL2 ± mult×ATR 上下轨 → 轨道按「只收紧不放宽」滚动 →
// 收盘与**前一根最终轨道**严格比较翻向。
//
// ⚠️ 刻意的非标准变体：教科书 Supertrend 用**当根**最终轨道判翻向，这里用 finalBand[i−1]，
// 比标准松一根 bar（上升段 finalLower 单调抬升，故离场阈值恒不高于标准值，离场只会更晚）。
// 保留这一根滞后是为了与研究基准逐笔一致——基准来源
// mode/etf-mainline-offense/etf-mainline-offense-research.py 的 Supertrend(10,3) 段：
//   st[i] = 1 if closes[i] > fu[i-1] else (-1 if closes[i] < fl[i-1] else st[i-1])
// 改成当根轨道会让站内跟踪与该研究留档的交易序列对不上，属于口径变更、必须换 MODE_ENGINE_VERSION。
//
// 为什么不用「close - mult×平均价差」那种简化式：旧实现把下轨定义成当根收盘减去若干倍
// 收盘绝对差均值，再要求收盘跌破它，代入后恒等于 0 < -(mult+1)·atr，永远不成立，
// 这道离场规则从未触发过。这里必须用真实 OHLC 的 TR 与滚动轨道，才可能真的翻空。

/** 单根 TR：max(H-L, |H-前收|, |L-前收|)；首根无前收，退化为当根振幅 */
function trueRanges(bars: Bar[]): number[] {
  return bars.map((b, i) => {
    const prev = i ? bars[i - 1].c : b.c;
    return Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
  });
}

/** 前缀窗口 SMA（不足周期按已有长度取均值，与 python sma() 同款） */
function smaPrefix(xs: number[], n: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i];
    if (i >= n) sum -= xs[i - n];
    out.push(sum / Math.min(i + 1, n));
  }
  return out;
}

/**
 * 逐根 Supertrend 方向：1 = 多头段，-1 = 空头段。
 * 翻向严格用 `<` / `>`：恰好触轨（相等）沿用前一根方向，避免噪声反复翻。
 */
export function supertrendDirection(bars: Bar[], period: number, mult: number): number[] {
  const n = bars.length;
  const dir = new Array<number>(n).fill(1);
  if (!n || !(period >= 1) || !(mult > 0)) return dir;
  const atr = smaPrefix(trueRanges(bars), period);

  let prevUpper = 0;
  let prevLower = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const hl2 = (b.h + b.l) / 2;
    const rawUpper = hl2 + mult * atr[i];
    const rawLower = hl2 - mult * atr[i];
    if (i === 0) {
      prevUpper = rawUpper;
      prevLower = rawLower;
      dir[0] = 1;
      continue;
    }
    const prevClose = bars[i - 1].c;
    // 轨道只在「更紧」或价格已穿越时才更新，否则沿用上一根，形成跟随止损效果
    const upper = rawUpper < prevUpper || prevClose > prevUpper ? rawUpper : prevUpper;
    const lower = rawLower > prevLower || prevClose < prevLower ? rawLower : prevLower;
    // 刻意用 prevUpper/prevLower（= finalBand[i−1]）而非当根 upper/lower：见文件头基准说明
    dir[i] = b.c > prevUpper ? 1 : b.c < prevLower ? -1 : dir[i - 1];
    prevUpper = upper;
    prevLower = lower;
  }
  return dir;
}

/**
 * 判定第 i 根是否处于 Supertrend 空头段。
 * 前 period 根 ATR 仍在预热（前缀窗口均值样本不足），一律不认翻空——
 * 宁可漏掉一次离场，也不用半个窗口的 ATR 造出假信号。
 */
export function isSupertrendDown(dir: number[], i: number, period: number): boolean {
  return i >= period && dir[i] === -1;
}
