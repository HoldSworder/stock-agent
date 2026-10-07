import type { Bar } from './factors';

// Supertrend(10,3)：
// 真实 TR → Wilder 平滑 ATR → HL2 ± mult×ATR 上下轨 → 轨道按「只收紧不放宽」滚动 →
// 收盘对当根最终轨道判断翻向。
//
// 上升段里昨天的下轨不高于今天的下轨时，不再因此把出场推迟到更晚。
// 名称保持 Supertrend(10,3)。这套口径改变持仓，MODE_ENGINE_VERSION 已升到 v3-2026.10。

/** 单根 TR：max(H-L, |H-前收|, |L-前收|)；首根无前收，退化为当根振幅 */
function trueRanges(bars: Bar[]): number[] {
  return bars.map((b, i) => {
    const prev = i ? bars[i - 1].c : b.c;
    return Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
  });
}

/**
 * Wilder 平滑 ATR。满 period 根后按 (前值×(n-1)+当根 TR)/n 递推。
 * 预热段用已有 TR 的均值，isSupertrendDown 在 i < period 时不认翻空。
 * @param trs 逐根真实波幅
 * @param period 平滑周期，Supertrend(10,3) 用 10
 */
function wilderAtr(trs: number[], period: number): number[] {
  const out: number[] = [];
  let atr = 0;
  for (let i = 0; i < trs.length; i += 1) {
    if (i < period) {
      atr = (atr * i + trs[i]) / (i + 1);
    } else {
      atr = (atr * (period - 1) + trs[i]) / period;
    }
    out.push(atr);
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
  const atr = wilderAtr(trueRanges(bars), period);

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
    // 收盘对当根最终轨道判断翻向。上升段昨天的下轨不高于今天时，不再把出场推迟到更晚。
    dir[i] = b.c > upper ? 1 : b.c < lower ? -1 : dir[i - 1];
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
