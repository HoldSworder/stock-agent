import { desc, eq, inArray } from 'drizzle-orm';
import type { BoardBreadthHistoryItem, BoardKind } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso } from '../util';

// 板块新高宽度日快照读写：按 (trade_date, board_code) upsert 幂等，
// 供「连续达标天数 / 居榜首天数 / 环比变化」等持续性判定与历史趋势。

export interface BoardBreadthSnapshotInput {
  tradeDate: string;
  boardCode: string;
  boardName: string;
  kind: BoardKind;
  newHighCount: number;
  consTotal: number;
  ratio: number;
  rank: number;
}

/** 批量 upsert 当日各板块快照（同 (date, code) 覆盖） */
export function upsertSnapshots(rows: BoardBreadthSnapshotInput[]): void {
  if (rows.length === 0) return;
  const now = nowIso();
  db.transaction((tx) => {
    for (const r of rows) {
      tx
        .insert(schema.boardNewHighSnapshots)
        .values({
          id: newId(),
          tradeDate: r.tradeDate,
          boardCode: r.boardCode,
          boardName: r.boardName,
          kind: r.kind,
          newHighCount: r.newHighCount,
          consTotal: r.consTotal,
          ratio: r.ratio,
          rank: r.rank,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.boardNewHighSnapshots.tradeDate, schema.boardNewHighSnapshots.boardCode],
          set: {
            boardName: r.boardName,
            kind: r.kind,
            newHighCount: r.newHighCount,
            consTotal: r.consTotal,
            ratio: r.ratio,
            rank: r.rank,
            updatedAt: now,
          },
        })
        .run();
    }
  });
}

/** 单条历史行（供持续性判定，按 boardCode 分组使用） */
export interface BoardBreadthSnapshotRow extends BoardBreadthSnapshotInput {}

/**
 * 取最近 `dateLimit` 个交易日（严格早于 beforeDate）的全部板块快照，按交易日倒序。
 * 服务层据此按 boardCode 分组算「连续达标 / 居榜首 / 环比」。
 */
export function listRecentSnapshots(beforeDate: string, dateLimit = 6): BoardBreadthSnapshotRow[] {
  const recentDates = db
    .selectDistinct({ d: schema.boardNewHighSnapshots.tradeDate })
    .from(schema.boardNewHighSnapshots)
    .orderBy(desc(schema.boardNewHighSnapshots.tradeDate))
    .all()
    .map((r) => r.d)
    .filter((d) => d < beforeDate)
    .slice(0, dateLimit);

  if (recentDates.length === 0) return [];
  return db
    .select()
    .from(schema.boardNewHighSnapshots)
    .where(inArray(schema.boardNewHighSnapshots.tradeDate, recentDates))
    .all()
    .map((row) => ({
      tradeDate: row.tradeDate,
      boardCode: row.boardCode,
      boardName: row.boardName,
      kind: row.kind as BoardKind,
      newHighCount: row.newHighCount,
      consTotal: row.consTotal,
      ratio: row.ratio,
      rank: row.rank,
    }));
}

/** 某板块的历史趋势（倒序最近 N 条），供前端持续性展示 */
export function listHistoryByBoard(boardCode: string, limit = 30): BoardBreadthHistoryItem[] {
  return db
    .select({
      tradeDate: schema.boardNewHighSnapshots.tradeDate,
      boardCode: schema.boardNewHighSnapshots.boardCode,
      boardName: schema.boardNewHighSnapshots.boardName,
      newHighCount: schema.boardNewHighSnapshots.newHighCount,
      rank: schema.boardNewHighSnapshots.rank,
    })
    .from(schema.boardNewHighSnapshots)
    .where(eq(schema.boardNewHighSnapshots.boardCode, boardCode))
    .orderBy(desc(schema.boardNewHighSnapshots.tradeDate))
    .limit(Math.min(Math.max(limit, 1), 120))
    .all();
}
