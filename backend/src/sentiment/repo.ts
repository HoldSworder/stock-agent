import { desc, eq, lt } from 'drizzle-orm';
import type {
  SentimentComponents,
  SentimentHistoryItem,
  SentimentLevel,
  SentimentPhase,
  StrengthBreakdown,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { nowIso } from '../util';

// 情绪日快照读写：一天一行（trade_date 唯一），upsert 幂等，供方向判定与历史趋势。

export interface SentimentSnapshot {
  tradeDate: string;
  index: number;
  level: SentimentLevel;
  phase: SentimentPhase;
  activity: number | null;
  maxStreak: number | null;
  breakdown: StrengthBreakdown;
  components: SentimentComponents;
}

function parse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 写入/更新当日快照（按 trade_date upsert） */
export function upsertSnapshot(s: SentimentSnapshot): void {
  const now = nowIso();
  db.insert(schema.sentimentSnapshots)
    .values({
      tradeDate: s.tradeDate,
      indexScore: s.index,
      level: s.level,
      phase: s.phase,
      activity: s.activity,
      maxStreak: s.maxStreak,
      breakdown: JSON.stringify(s.breakdown),
      components: JSON.stringify(s.components),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.sentimentSnapshots.tradeDate,
      set: {
        indexScore: s.index,
        level: s.level,
        phase: s.phase,
        activity: s.activity,
        maxStreak: s.maxStreak,
        breakdown: JSON.stringify(s.breakdown),
        components: JSON.stringify(s.components),
        updatedAt: now,
      },
    })
    .run();
}

/** 取严格早于 tradeDate 的最近一条快照指数（判方向用，无则 null） */
export function getPrevIndex(tradeDate: string): number | null {
  const row = db
    .select({ indexScore: schema.sentimentSnapshots.indexScore })
    .from(schema.sentimentSnapshots)
    .where(lt(schema.sentimentSnapshots.tradeDate, tradeDate))
    .orderBy(desc(schema.sentimentSnapshots.tradeDate))
    .limit(1)
    .get();
  return row ? row.indexScore : null;
}

/** 取某交易日快照（无则 null） */
export function getSnapshot(tradeDate: string): SentimentSnapshot | null {
  const row = db
    .select()
    .from(schema.sentimentSnapshots)
    .where(eq(schema.sentimentSnapshots.tradeDate, tradeDate))
    .get();
  if (!row) return null;
  return {
    tradeDate: row.tradeDate,
    index: row.indexScore,
    level: row.level as SentimentLevel,
    phase: row.phase as SentimentPhase,
    activity: row.activity,
    maxStreak: row.maxStreak,
    breakdown: parse<StrengthBreakdown>(row.breakdown, { total: row.indexScore, parts: [] }),
    components: parse<SentimentComponents>(row.components, {} as SentimentComponents),
  };
}

/** 历史趋势（倒序最近 N 条） */
export function listHistory(limit = 60): SentimentHistoryItem[] {
  const rows = db
    .select({
      tradeDate: schema.sentimentSnapshots.tradeDate,
      indexScore: schema.sentimentSnapshots.indexScore,
      level: schema.sentimentSnapshots.level,
      phase: schema.sentimentSnapshots.phase,
    })
    .from(schema.sentimentSnapshots)
    .orderBy(desc(schema.sentimentSnapshots.tradeDate))
    .limit(Math.min(Math.max(limit, 1), 250))
    .all();
  return rows.map((r) => ({
    tradeDate: r.tradeDate,
    index: r.indexScore,
    level: r.level as SentimentLevel,
    phase: r.phase as SentimentPhase,
  }));
}
