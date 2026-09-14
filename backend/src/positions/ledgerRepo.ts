import { and, desc, eq, gte } from 'drizzle-orm';
import type { RealTradeGuess } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { guessTrades, type SnapshotRow } from './ledger';

// 清仓台账与按日持仓快照的只读查询。写入在 realPositions.ts 里跟随每次同步发生。

/** 已实现盈亏的一笔（券商原值，不可本地重算） */
export interface RealizedClose {
  closeDate: string;
  code: string;
  name: string;
  avgCost: number;
  closePrice: number;
  realizedPnl: number;
  realizedRate: number;
  holdDays: number;
}

/** 清仓台账，按日期倒序 */
export function listCloses(since?: string): RealizedClose[] {
  const rows = db
    .select()
    .from(schema.realPositionCloses)
    .where(
      since
        ? and(
            eq(schema.realPositionCloses.account, 'real'),
            gte(schema.realPositionCloses.closeDate, since),
          )
        : eq(schema.realPositionCloses.account, 'real'),
    )
    .orderBy(desc(schema.realPositionCloses.closeDate))
    .all();
  return rows.map((r) => ({
    closeDate: r.closeDate,
    code: r.code,
    name: r.name,
    avgCost: r.avgCost,
    closePrice: r.closePrice,
    realizedPnl: r.realizedPnl,
    realizedRate: r.realizedRate,
    holdDays: r.holdDays,
  }));
}

/**
 * 已实现盈亏汇总。
 *
 * 这是目前唯一能说「真实赚了多少」的数字，因为它来自券商原值。
 * 注意它只覆盖**清仓台账开始记录之后**完成的交易——之前的成交结果
 * 在库里已经不存在，追不回来。展示时必须带上起始日期，
 * 否则会被误读成账户全部历史战绩。
 */
export function summarizeCloses(since?: string): {
  from: string | null;
  count: number;
  totalPnl: number;
  winCount: number;
} {
  const rows = listCloses(since);
  const dates = rows.map((r) => r.closeDate).sort();
  return {
    from: dates[0] ?? null,
    count: rows.length,
    totalPnl: rows.reduce((s, r) => s + r.realizedPnl, 0),
    winCount: rows.filter((r) => r.realizedPnl > 0).length,
  };
}

/** 按日持仓快照原始行 */
export function listSnapshots(since?: string): SnapshotRow[] {
  const rows = db
    .select()
    .from(schema.realPositionSnapshots)
    .where(
      since
        ? and(
            eq(schema.realPositionSnapshots.account, 'real'),
            gte(schema.realPositionSnapshots.tradeDate, since),
          )
        : eq(schema.realPositionSnapshots.account, 'real'),
    )
    .all();
  return rows.map((r) => ({
    tradeDate: r.tradeDate,
    code: r.code,
    name: r.name,
    qty: r.qty,
    avgCost: r.avgCost,
    price: r.price,
  }));
}

/**
 * 反推出来的成交。用清仓台账把「数量归零」从猜测升级为确认，
 * 其余靠相邻两日快照差分，说不清的如实标出。
 */
export function listTradeGuesses(since?: string): RealTradeGuess[] {
  const closedByDate = new Map<string, Set<string>>();
  for (const c of listCloses(since)) {
    const s = closedByDate.get(c.closeDate) ?? new Set<string>();
    s.add(c.code);
    closedByDate.set(c.closeDate, s);
  }
  return guessTrades(listSnapshots(since), closedByDate).sort((a, b) =>
    a.tradeDate < b.tradeDate ? 1 : a.tradeDate > b.tradeDate ? -1 : 0,
  );
}
