import { callAkshare } from './akshare';
import type { ChipSnapshot, StockChipDistribution } from '@stock-agent/shared';

// S8 筹码分布：经 aktools/akshare 透传东财筹码分布（stock_cyq_em），免本地维护反爬。
// 输出获利比例/平均成本/70·90 成本区间与集中度，判断套牢盘、锁筹/派发、主力成本。

type Rec = Record<string, unknown>;

const numOf = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

function toSnapshot(r: Rec): ChipSnapshot {
  return {
    date: String(r['日期'] ?? '').slice(0, 10),
    profitRatio: numOf(r['获利比例']),
    avgCost: numOf(r['平均成本']),
    cost90Low: numOf(r['90成本-低']),
    cost90High: numOf(r['90成本-高']),
    concentration90: numOf(r['90集中度']),
    cost70Low: numOf(r['70成本-低']),
    cost70High: numOf(r['70成本-高']),
    concentration70: numOf(r['70集中度']),
  };
}

/**
 * 个股筹码分布（东财，前复权与 K 线一致）。
 * akshare 返回近 90 日，按日期升序；取最新 + 近 recentDays 日趋势（新→旧）。
 */
export async function getChipDistribution(
  code: string,
  recentDays = 6,
  signal?: AbortSignal,
): Promise<StockChipDistribution> {
  const raw = await callAkshare('stock_cyq_em', { symbol: code, adjust: 'qfq' }, signal);
  const rows = Array.isArray(raw) ? (raw as Rec[]) : [];
  const snaps = rows.map(toSnapshot).filter((s) => s.date);
  if (!snaps.length) {
    return { code, asOf: new Date().toISOString(), latest: null, recent: [], note: '筹码分布数据不可用' };
  }
  // akshare 按日期升序，末尾为最新；取近 recentDays 反转为新→旧
  const recent = snaps.slice(-recentDays).reverse();
  return {
    code,
    asOf: new Date().toISOString(),
    latest: recent[0],
    recent,
    note: '东财筹码分布（前复权，近90日）',
  };
}

/** 筹码分布文本（注入技术分析师 / agent 的确定性底稿） */
export function formatChipForAgent(d: StockChipDistribution): string {
  if (!d.latest) return '筹码分布数据不可用。';
  const l = d.latest;
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const lines: string[] = [
    `筹码分布（${l.date}，东财前复权）`,
    `获利比例 ${pct(l.profitRatio)}（当前价上方获利盘占比，越低套牢盘越重）`,
    `平均成本 ${l.avgCost.toFixed(2)}`,
    `90%成本区间 [${l.cost90Low.toFixed(2)}, ${l.cost90High.toFixed(2)}]，集中度 ${pct(l.concentration90)}`,
    `70%成本区间 [${l.cost70Low.toFixed(2)}, ${l.cost70High.toFixed(2)}]，集中度 ${pct(l.concentration70)}（越小越集中=锁筹）`,
  ];
  // 趋势：获利比例与集中度变化（最旧→最新），判断派发/吸筹与筹码收敛
  if (d.recent.length >= 2) {
    const oldest = d.recent[d.recent.length - 1];
    const dProfit = l.profitRatio - oldest.profitRatio;
    const dConc = l.concentration70 - oldest.concentration70;
    lines.push(
      `近${d.recent.length}日：获利比例${dProfit >= 0 ? '上升' : '下降'} ${Math.abs(dProfit * 100).toFixed(1)}个百分点，` +
        `筹码${dConc <= 0 ? '趋于集中（锁筹/吸筹迹象）' : '趋于发散（派发/分歧迹象）'}`,
    );
  }
  return lines.join('\n');
}
