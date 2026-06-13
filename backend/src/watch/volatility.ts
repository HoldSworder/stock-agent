import { ATR } from 'trading-signals';
import { getKline } from '../market/eastmoney';

// 波动率归一化：用日线 ATR(14) 把「绝对百分比阈值」按个股自身波动性缩放。
// 高波动票放大触发阈值、低波动票收紧，避免「同样 3% 回撤」对所有标的一刀切。
// ATR 计算复用 trading-signals（MIT、零运行时依赖、经过验证），不自造轮子。

// 典型 A 股日 ATR% 基准（约 3%）：以此为 1.0 缩放基线。
const BASELINE_ATR_PCT = 3;
// 缩放系数夹紧区间，防止极端波动把阈值放大/缩小到失真。
const MIN_SCALE = 0.5;
const MAX_SCALE = 2;
// 计算 ATR 需要的最少日线根数（14 周期 + 余量）。
const MIN_BARS = 15;

interface AtrCacheEntry {
  /** 缓存所属交易日 YYYY-MM-DD（日线每日才变，按日缓存） */
  day: string;
  /** ATR%（ATR/最新收盘×100）；null 表示已算但数据不足 */
  atrPct: number | null;
}

const cache = new Map<string, AtrCacheEntry>();
const inflight = new Set<string>();

async function computeAtrPct(code: string): Promise<number | null> {
  const bars = await getKline(code, 'day', 30);
  if (bars.length < MIN_BARS) return null;
  const atr = new ATR(14);
  for (const b of bars) atr.add({ high: b.high, low: b.low, close: b.close });
  const res = atr.getResult();
  const last = bars[bars.length - 1].close;
  if (res == null || last <= 0) return null;
  return (Number(res) / last) * 100;
}

/**
 * 取该标的当日 ATR%。命中缓存即返回；未命中返回 undefined 并后台补算（不阻塞 tick），
 * 下一 tick 即可用。首个 tick 用 undefined 回退静态阈值，可接受。
 */
export function getAtrPct(code: string, day: string): number | undefined {
  const hit = cache.get(code);
  if (hit && hit.day === day) return hit.atrPct ?? undefined;
  if (!inflight.has(code)) {
    inflight.add(code);
    computeAtrPct(code)
      .then((v) => cache.set(code, { day, atrPct: v }))
      .catch(() => cache.set(code, { day, atrPct: null }))
      .finally(() => inflight.delete(code));
  }
  return undefined;
}

/**
 * 把 ATR% 映射为阈值缩放系数：以 BASELINE_ATR_PCT 为 1.0，高波动放大、低波动收紧，夹紧防失真。
 * 无 ATR 数据时返回 1（回退静态阈值）。
 */
export function volScale(atrPct: number | undefined): number {
  if (atrPct == null || atrPct <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, atrPct / BASELINE_ATR_PCT));
}
