import type { SnapshotRow } from './snapshot';
import type { HardFilter } from './strategy';

// L1 规则硬筛：A 股板块/状态过滤（强制）+ 策略 YAML 风格的硬阈值过滤。

/**
 * A 股可交易性过滤（强制，独立于策略）：
 * - 剔除科创板（688 开头）与北交所（8/4 开头）：用户无交易权限。
 * - 剔除 ST / *ST / 退市（名称含 ST 或 退）。
 * 仅保留主板（60/00）+ 创业板（30）。
 */
export function isTradableAShare(row: SnapshotRow): boolean {
  const { code, name } = row;
  if (/^688/.test(code)) return false; // 科创板
  if (/^(8|4)/.test(code)) return false; // 北交所
  // 仅沪市主板 60 / 深市主板 00 / 创业板 30
  if (!/^(60|00|30)/.test(code)) return false;
  const n = name.toUpperCase();
  if (n.includes('ST') || name.includes('退')) return false;
  return true;
}

function inRange(v: number | null, min?: number | null, max?: number | null): boolean {
  if (min != null) {
    if (v == null) return false; // 有下限要求但数据缺失 → 不通过
    if (v < min) return false;
  }
  if (max != null) {
    if (v == null) return false;
    if (v > max) return false;
  }
  return true;
}

/**
 * 硬筛模式（盘前兜底用）：
 * - full：可交易性 + 全部静态/量价阈值（现状）。
 * - skipVolumePrice：仅保留可交易性 + 静态阈值（pe/pb/marketCap），跳过当日量价阈值
 *   （amount/turnover/pct）。用于盘前量价退化、又无收盘缓存时不至于剔空。
 * - tradableOnly：仅可交易性，作为最终兜底。
 */
export type HardFilterMode = 'full' | 'skipVolumePrice' | 'tradableOnly';

/** 应用策略硬阈值 */
function passHardFilter(row: SnapshotRow, f: HardFilter, mode: HardFilterMode): boolean {
  if (!inRange(row.pe, f.peMin, f.peMax)) return false;
  if (!inRange(row.pb, f.pbMin, f.pbMax)) return false;
  if (!inRange(row.marketCap, f.marketCapMinYi, f.marketCapMaxYi)) return false;
  // 量价阈值（当日盘中口径，盘前退化时跳过）
  if (mode === 'full') {
    if (!inRange(row.turnoverRate, f.turnoverMin, f.turnoverMax)) return false;
    // 成交额与涨跌幅：**取不到就不放行**。
    // 策略写了「成交额至少 5 亿」，而这只的成交额取不到，我们无从知道它够不够——
    // 早先缺失被当成 0 会误杀，当成通过会放进一只根本没验证过流动性的票。
    // 两者之中「不放行」是对的：硬筛的意思就是「没满足就别进来」。
    if (f.amountMinYi != null && (row.amount == null || row.amount < f.amountMinYi)) return false;
    if (f.pctMin != null && (row.pct == null || row.pct < f.pctMin)) return false;
    if (f.pctMax != null && (row.pct == null || row.pct > f.pctMax)) return false;
  }
  return true;
}

/** L1 硬筛：可交易性 + 按模式应用阈值，返回候选子集（mode 缺省 full，保持现有行为） */
export function hardFilter(
  rows: SnapshotRow[],
  f: HardFilter,
  mode: HardFilterMode = 'full',
): SnapshotRow[] {
  if (mode === 'tradableOnly') return rows.filter((r) => isTradableAShare(r));
  return rows.filter((r) => isTradableAShare(r) && passHardFilter(r, f, mode));
}
