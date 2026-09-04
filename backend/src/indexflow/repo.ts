import { desc, inArray } from 'drizzle-orm';
import type { IndexFundFlowDay } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { nowIso } from '../util';
import { INDEX_FLOW_DEFS } from './defs';

// 指数资金流日快照读写。一天一指数一行，按 (secid, trade_date) 幂等 upsert。

/** 待写入的一行 */
export interface FlowRow {
  secid: string;
  tradeDate: string;
  main: number;
  pct: number;
  source: string;
}

/**
 * 整批写入。
 *
 * 走单个事务：一次任务里 10 个指数要么都进去要么都不进，
 * 避免半截写入在表里留下「只有大盘蓝筹有今天、中小盘没有」这种残缺组，
 * 那会让分组投票拿一半样本下判断。
 *
 * @returns 实际写入行数
 */
export function upsertRows(rows: FlowRow[]): number {
  if (rows.length === 0) return 0;
  const fetchedAt = nowIso();
  db.transaction((tx) => {
    for (const r of rows) {
      tx.insert(schema.indexFlowSnapshots)
        .values({ ...r, fetchedAt })
        .onConflictDoUpdate({
          target: [schema.indexFlowSnapshots.secid, schema.indexFlowSnapshots.tradeDate],
          set: { main: r.main, pct: r.pct, source: r.source, fetchedAt },
        })
        .run();
    }
  });
  return rows.length;
}

/** 某指数的历史读数，按交易日升序；只取登记在册的指数 */
export function loadSeries(limitPerIndex = 400): Map<string, Map<string, IndexFundFlowDay>> {
  const secids = INDEX_FLOW_DEFS.map((d) => d.secid);
  const rows = db
    .select()
    .from(schema.indexFlowSnapshots)
    .where(inArray(schema.indexFlowSnapshots.secid, secids))
    .orderBy(desc(schema.indexFlowSnapshots.tradeDate))
    .limit(limitPerIndex * secids.length)
    .all();
  const out = new Map<string, Map<string, IndexFundFlowDay>>();
  for (const r of rows) {
    let m = out.get(r.secid);
    if (!m) {
      m = new Map<string, IndexFundFlowDay>();
      out.set(r.secid, m);
    }
    m.set(r.tradeDate, { date: r.tradeDate, main: r.main, pct: r.pct });
  }
  return out;
}

/** 表内最新交易日；无记录返回 null */
export function latestTradeDate(): string | null {
  const row = db
    .select({ tradeDate: schema.indexFlowSnapshots.tradeDate })
    .from(schema.indexFlowSnapshots)
    .orderBy(desc(schema.indexFlowSnapshots.tradeDate))
    .limit(1)
    .get();
  return row?.tradeDate ?? null;
}

/** 最近一次抓取时间；无记录返回 null */
export function latestFetchedAt(): string | null {
  const row = db
    .select({ fetchedAt: schema.indexFlowSnapshots.fetchedAt })
    .from(schema.indexFlowSnapshots)
    .orderBy(desc(schema.indexFlowSnapshots.fetchedAt))
    .limit(1)
    .get();
  return row?.fetchedAt ?? null;
}
