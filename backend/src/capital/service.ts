import type { CapitalSeat, StockCapitalDetail } from '@stock-agent/shared';
import { getDragonTigerEntries } from '../market/datacenter';
import { getDragonSeats } from './data';

// S7 资金面服务层：龙虎榜只叫披露席位净额，只在上榜日有意义。
// 没有上榜写成「未披露」，不能写成资金没有方向。
// 纯只读、不下单、不调 LLM。两源独立容错：任一失败仍返回另一半。

/** 个股龙虎榜：没有上榜写成未披露。席位源失败不影响已披露的席位净额。 */
export async function getStockCapital(code: string, signal?: AbortSignal): Promise<StockCapitalDetail> {
  const [trendRes, seatsRes] = await Promise.allSettled([
    getDragonTigerEntries(code, 6),
    getDragonSeats(code, signal),
  ]);
  const trend = trendRes.status === 'fulfilled' ? trendRes.value : { name: code, entries: [] };
  const seats = seatsRes.status === 'fulfilled' ? seatsRes.value : null;
  const notes: string[] = [];
  if (!trend.entries.length) notes.push('未披露');
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
    lines.push('披露席位净额（新→旧，只在上榜日有意义）：');
    for (const e of d.recent) {
      lines.push(
        `  ${e.date} 涨跌${e.pct.toFixed(2)}% 净买入${e.net >= 0 ? '+' : ''}${e.net.toFixed(0)}万 换手${e.turnover.toFixed(2)}%` +
          (e.reason ? ` 原因:${e.reason}` : ''),
      );
    }
  } else {
    lines.push('未披露。');
  }
  if (d.seats) {
    lines.push(`最近一次席位拆分（${d.seats.date}${d.seats.reason ? `·${d.seats.reason}` : ''}）：`);
    if (d.seats.buys.length) lines.push(`  买方：${topSeats(d.seats.buys, 5)}`);
    if (d.seats.sells.length) lines.push(`  卖方：${topSeats(d.seats.sells, 5)}`);
  }
  return lines.join('\n');
}
