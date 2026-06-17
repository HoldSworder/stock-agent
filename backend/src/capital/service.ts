import type { CapitalSeat, StockCapitalDetail } from '@stock-agent/shared';
import { getDragonTigerEntries } from '../market/datacenter';
import { getDragonSeats } from './data';

// S7 资金面服务层：龙虎榜资金面深挖 = 净额趋势（东财 datacenter）+ 最近一次席位拆分（akshare）。
// 纯只读、不下单、不调 LLM。两源独立容错：任一失败仍返回另一半。

/** 个股龙虎榜资金面合并视图（确定性只读；席位源失败不影响净额趋势） */
export async function getStockCapital(code: string, signal?: AbortSignal): Promise<StockCapitalDetail> {
  const [trendRes, seatsRes] = await Promise.allSettled([
    getDragonTigerEntries(code, 6),
    getDragonSeats(code, signal),
  ]);
  const trend = trendRes.status === 'fulfilled' ? trendRes.value : { name: code, entries: [] };
  const seats = seatsRes.status === 'fulfilled' ? seatsRes.value : null;
  const notes: string[] = [];
  if (!trend.entries.length) notes.push('近期无龙虎榜上榜记录');
  if (seatsRes.status === 'rejected') notes.push('席位拆分数据源暂不可用');
  return {
    code,
    name: trend.name,
    asOf: new Date().toISOString(),
    recent: trend.entries,
    seats,
    note: notes.join('；') || '龙虎榜资金面正常',
  };
}

/** 席位列表摘要（按净额绝对值排序取前 N） */
function topSeats(seats: CapitalSeat[], n: number): string {
  return seats
    .slice()
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    .slice(0, n)
    .map((s) => `${s.name}[${s.tag}] 净${s.net >= 0 ? '+' : ''}${s.net.toFixed(0)}万`)
    .join('；');
}

/** 龙虎榜资金面文本（注入游资分析师 / agent 的确定性底稿） */
export function formatCapitalForAgent(d: StockCapitalDetail): string {
  const lines: string[] = [`${d.name}(${d.code}) 龙虎榜资金面`];
  if (d.recent.length) {
    lines.push('净额趋势（新→旧）：');
    for (const e of d.recent) {
      lines.push(
        `  ${e.date} 涨跌${e.pct.toFixed(2)}% 净买入${e.net >= 0 ? '+' : ''}${e.net.toFixed(0)}万 换手${e.turnover.toFixed(2)}%` +
          (e.reason ? ` 原因:${e.reason}` : ''),
      );
    }
  } else {
    lines.push('近期无龙虎榜上榜记录。');
  }
  if (d.seats) {
    lines.push(`最近一次席位拆分（${d.seats.date}${d.seats.reason ? `·${d.seats.reason}` : ''}）：`);
    if (d.seats.buys.length) lines.push(`  买方：${topSeats(d.seats.buys, 5)}`);
    if (d.seats.sells.length) lines.push(`  卖方：${topSeats(d.seats.sells, 5)}`);
  }
  return lines.join('\n');
}
