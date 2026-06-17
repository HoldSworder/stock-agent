import { callAkshare } from '../market/akshare';
import type { CapitalSeat, CapitalSeatTag, DragonTigerSeats } from '@stock-agent/shared';

// S7 资金面：龙虎榜席位拆分（经 aktools/akshare 透传，免本地维护反爬）。
// 东财个股龙虎榜「净额趋势」走 datacenter 直连（datacenter.ts）；
// 「谁在买谁在卖」的席位明细 akshare 已封装为 stock_lhb_stock_detail_em，直接复用（DRY/YAGNI）。

type Rec = Record<string, unknown>;

const numOf = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** 营业部名 → 席位类型（游资/机构/北向/其他）：A 股游资追踪的关键辨识 */
function tagSeat(name: string): CapitalSeatTag {
  if (/机构专用/.test(name)) return '机构';
  if (/沪股通|深股通|陆股通/.test(name)) return '北向';
  if (!name || name === '-') return '其他';
  // 龙虎榜上榜营业部（非机构、非北向）以活跃游资席位为主，统一归「游资」
  return '游资';
}

/** akshare 记录数组归一化 */
function asRows(v: unknown): Rec[] {
  return Array.isArray(v) ? (v as Rec[]) : [];
}

/** 取个股最近一个有龙虎榜详情的交易日（YYYYMMDD），无则 null */
async function latestLhbDate(code: string, signal?: AbortSignal): Promise<string | null> {
  const rows = asRows(await callAkshare('stock_lhb_stock_detail_date_em', { symbol: code }, signal));
  let best = '';
  for (const r of rows) {
    const raw = String(r['交易日期'] ?? r['date'] ?? '').replace(/\D/g, '');
    if (raw.length === 8 && raw > best) best = raw;
  }
  return best || null;
}

/** 解析一侧（买入/卖出）席位明细，金额统一为万元 */
function parseSeats(rows: Rec[]): CapitalSeat[] {
  return rows.map((r) => {
    const name = String(r['交易营业部名称'] ?? r['营业部名称'] ?? '').trim();
    const buy = numOf(r['买入金额']) / 1e4;
    const sell = numOf(r['卖出金额']) / 1e4;
    return { name, buy, sell, net: buy - sell, tag: tagSeat(name) };
  });
}

/**
 * 个股最近一次龙虎榜席位拆分（买方/卖方前 N 席位 + 席位类型辨识）。
 * 无上榜记录返回 null；akshare 不可用时抛错由上层兜底。
 */
export async function getDragonSeats(code: string, signal?: AbortSignal): Promise<DragonTigerSeats | null> {
  const date = await latestLhbDate(code, signal);
  if (!date) return null;
  const [buyRows, sellRows] = await Promise.all([
    callAkshare('stock_lhb_stock_detail_em', { symbol: code, date, flag: '买入' }, signal).then(asRows),
    callAkshare('stock_lhb_stock_detail_em', { symbol: code, date, flag: '卖出' }, signal).then(asRows),
  ]);
  const buys = parseSeats(buyRows);
  const sells = parseSeats(sellRows);
  if (!buys.length && !sells.length) return null;
  const reason = String(buyRows[0]?.['类型'] ?? sellRows[0]?.['类型'] ?? '').trim();
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  return { date: iso, reason, buys, sells };
}
