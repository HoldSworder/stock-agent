import type {
  ScreenFilterStat,
  ScreenFunnelDiagnostics,
  ScreenNearMiss,
  ScreenSensitivityRow,
} from '@stock-agent/shared';
import type { SnapshotRow } from './snapshot';
import type { HardFilter } from './strategy';
import { isTradableAShare } from './filter';

// 选股漏斗诊断：把「被硬筛刷掉的那部分」留痕，回答三个问题——
// 每条门槛各拦掉多少、放宽某条能救回多少、哪些标的只差一条。
//
// 重要纪律（这是把它做出来的前提）：本模块产出的是只读研究统计，
// 绝不自动放宽任何生产门槛。看到「阈值放宽 25% 候选多 30 只且历史收益更好」就去改阈值，
// 是教科书级的过拟合路径——敏感性分析本身就是多重比较的温床。
// 任何据此产生的阈值改动，都必须换协议号并重新累积前向样本（见 strategy/promotionGate.ts）。

/** 一条可诊断的数值门槛 */
interface Condition {
  key: string;
  label: string;
  /** 门槛值 */
  threshold: number;
  /** 门槛方向：min = 实际值需 ≥ 门槛；max = 实际值需 ≤ 门槛 */
  dir: 'min' | 'max';
  /** 取实际值（缺失为 null，视为不通过——与 filter.ts 的 inRange 语义一致） */
  value: (r: SnapshotRow) => number | null;
  /** 可读描述 */
  desc: string;
}

/** 从策略硬筛配置里展开出全部生效的数值门槛 */
function conditionsOf(f: HardFilter): Condition[] {
  const list: Condition[] = [];
  const add = (
    key: string,
    label: string,
    threshold: number | null | undefined,
    dir: 'min' | 'max',
    value: (r: SnapshotRow) => number | null,
    unit: string,
  ): void => {
    if (threshold == null) return;
    list.push({
      key,
      label,
      threshold,
      dir,
      value,
      desc: `${label} ${dir === 'min' ? '≥' : '≤'} ${threshold}${unit}`,
    });
  };
  add('peMin', '市盈率下限', f.peMin, 'min', (r) => r.pe, '');
  add('peMax', '市盈率上限', f.peMax, 'max', (r) => r.pe, '');
  add('pbMin', '市净率下限', f.pbMin, 'min', (r) => r.pb, '');
  add('pbMax', '市净率上限', f.pbMax, 'max', (r) => r.pb, '');
  add('marketCapMinYi', '总市值下限', f.marketCapMinYi, 'min', (r) => r.marketCap, ' 亿');
  add('marketCapMaxYi', '总市值上限', f.marketCapMaxYi, 'max', (r) => r.marketCap, ' 亿');
  add('turnoverMin', '换手率下限', f.turnoverMin, 'min', (r) => r.turnoverRate, '%');
  add('turnoverMax', '换手率上限', f.turnoverMax, 'max', (r) => r.turnoverRate, '%');
  add('amountMinYi', '成交额下限', f.amountMinYi, 'min', (r) => r.amount, ' 亿');
  add('pctMin', '涨跌幅下限', f.pctMin, 'min', (r) => r.pct, '%');
  add('pctMax', '涨跌幅上限', f.pctMax, 'max', (r) => r.pct, '%');
  return list;
}

/** 单条门槛是否通过（缺失值一律不通过，与生产口径一致） */
function passes(c: Condition, r: SnapshotRow, threshold = c.threshold): boolean {
  const v = c.value(r);
  if (v == null) return false;
  return c.dir === 'min' ? v >= threshold : v <= threshold;
}

/**
 * 按相对比例放宽/收紧门槛：min 型放宽即调低，max 型放宽即调高。
 * 步长取 |threshold| 而非直接乘缩放因子——门槛为负时（如 pctMin = -3）乘法会把
 * 「放宽 25%」算成 -2.25，方向整个反过来。
 */
function shiftThreshold(c: Condition, delta: number): number {
  const step = Math.abs(c.threshold) * delta;
  return c.dir === 'min' ? c.threshold - step : c.threshold + step;
}

/** 敏感性扫描的相对档位（负=收紧，正=放宽） */
const DELTAS = [-0.5, -0.25, 0, 0.25, 0.5, 1];
/** 「差一点入选」清单长度 */
const NEAR_MISS_LIMIT = 20;

/**
 * 构建漏斗诊断。
 * @param snapshot 全市场（或 universe 收窄后）快照
 * @param f 策略硬筛配置
 * @param filteredCount 生产口径实际通过的只数（可能因兜底放宽而与 full 口径不同，原样透传）
 */
export function buildFunnelDiagnostics(
  snapshot: SnapshotRow[],
  f: HardFilter,
  filteredCount: number,
): ScreenFunnelDiagnostics {
  const tradable = snapshot.filter(isTradableAShare);
  const conds = conditionsOf(f);

  const filters: ScreenFilterStat[] = conds.map((c) => {
    let rejected = 0;
    let soleRejected = 0;
    for (const r of tradable) {
      if (passes(c, r)) continue;
      rejected += 1;
      // 只被这一条拦住 → 放宽它就能救回来
      if (conds.every((o) => o.key === c.key || passes(o, r))) soleRejected += 1;
    }
    return { key: c.key, label: c.label, threshold: c.desc, rejected, soleRejected };
  });

  const sensitivity: ScreenSensitivityRow[] = conds.map((c) => {
    // 门槛为 0 时任何相对比例仍是 0，六档会输出同一个数误导用户，直接标注不可扫描
    if (c.threshold === 0) {
      return {
        key: c.key,
        label: c.label,
        points: [],
        note: '门槛为 0，按比例缩放恒等于 0，无法做相对敏感性扫描',
      };
    }
    return {
      key: c.key,
      label: c.label,
      points: DELTAS.map((delta) => {
        const t = shiftThreshold(c, delta);
        let count = 0;
        for (const r of tradable) {
          if (!passes(c, r, t)) continue;
          if (conds.every((o) => o.key === c.key || passes(o, r))) count += 1;
        }
        return { delta, count };
      }),
    };
  });

  // 差一点入选：恰好只被一条门槛拦住，按相对差距升序
  const nearMisses: ScreenNearMiss[] = [];
  for (const r of tradable) {
    const failed = conds.filter((c) => !passes(c, r));
    if (failed.length !== 1) continue;
    const c = failed[0];
    const v = c.value(r);
    if (v == null) continue; // 数据缺失不算「差一点」，那是取数问题不是阈值问题
    const gapPct =
      c.threshold === 0 ? 100 : Math.abs(((v - c.threshold) / c.threshold) * 100);
    nearMisses.push({
      code: r.code,
      name: r.name,
      failedKey: c.key,
      failedLabel: c.label,
      actual: Math.round(v * 100) / 100,
      threshold: c.threshold,
      gapPct: Math.round(gapPct * 10) / 10,
    });
  }
  nearMisses.sort((a, b) => a.gapPct - b.gapPct);

  return {
    marketCount: snapshot.length,
    tradableCount: tradable.length,
    filteredCount,
    filters: filters.sort((a, b) => b.soleRejected - a.soleRejected),
    sensitivity,
    nearMisses: nearMisses.slice(0, NEAR_MISS_LIMIT),
    note:
      '只读研究统计，不会自动放宽任何生产门槛。敏感性与「差一点入选」是多重比较的温床：' +
      '看到放宽某条能多出一批候选就去改阈值，等同于在同一段历史上反复挑参数。' +
      '任何据此产生的阈值改动都必须换协议号，并重新累积前向样本后才谈成效。',
  };
}
