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

/** 应用策略硬阈值 */
function passHardFilter(row: SnapshotRow, f: HardFilter): boolean {
  if (!inRange(row.pe, f.peMin, f.peMax)) return false;
  if (!inRange(row.pb, f.pbMin, f.pbMax)) return false;
  if (!inRange(row.turnoverRate, f.turnoverMin, f.turnoverMax)) return false;
  if (!inRange(row.marketCap, f.marketCapMinYi, f.marketCapMaxYi)) return false;
  // 成交额下限（amount 始终有值）
  if (f.amountMinYi != null && row.amount < f.amountMinYi) return false;
  // 涨跌幅区间（pct 始终有值）
  if (f.pctMin != null && row.pct < f.pctMin) return false;
  if (f.pctMax != null && row.pct > f.pctMax) return false;
  return true;
}

/** L1 硬筛：可交易性 + 策略阈值，返回候选子集 */
export function hardFilter(rows: SnapshotRow[], f: HardFilter): SnapshotRow[] {
  return rows.filter((r) => isTradableAShare(r) && passHardFilter(r, f));
}
