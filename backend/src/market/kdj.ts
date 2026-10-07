import type { KlineBar } from '@stock-agent/shared';

/**
 * 通达信 KDJ(9,3,3)：RSV 的 K/D 用 1/3 权重递推，初值 50。
 * 指标页和战法共用这一句。页面上的 80 和规则里的 80 是同一个数。
 * @param bars K 线
 * @param n RSV 窗口，默认 9
 */
export function kdjTongdaxin(
  bars: Array<Pick<KlineBar, 'high' | 'low' | 'close'>>,
  n = 9,
): Array<{ k: number; d: number; j: number } | null> {
  const out: Array<{ k: number; d: number; j: number } | null> = [];
  let k = 50;
  let d = 50;
  for (let i = 0; i < bars.length; i += 1) {
    if (i < n - 1) {
      out.push(null);
      continue;
    }
    const win = bars.slice(i - n + 1, i + 1);
    const hh = Math.max(...win.map((b) => b.high));
    const ll = Math.min(...win.map((b) => b.low));
    const rsv = hh > ll ? ((bars[i].close - ll) / (hh - ll)) * 100 : k;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    out.push({ k, d, j: 3 * k - 2 * d });
  }
  return out;
}
