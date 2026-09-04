import { desc, eq, lt } from 'drizzle-orm';
import type {
  MarketRegimeBias,
  MarketRegimeFrequency,
  MarketRegimeHistoryItem,
  MarketRegimePhase,
  StrengthBreakdown,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { prevTradingDay } from '../market/calendar';
import { nowIso } from '../util';

// 大盘阶段日快照读写：一天一行（trade_date 唯一），upsert 幂等，
// 供「较昨日分数变动 / 阶段已持续天数」判定与历史趋势图。纯只读统计，不参与交易。

export interface RegimeSnapshot {
  tradeDate: string;
  phase: MarketRegimePhase;
  score: number;
  tomorrowBias: MarketRegimeBias;
  suggestedFrequency: MarketRegimeFrequency;
  positionRange: string;
  breakdown: StrengthBreakdown;
}

function parse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 写入/更新当日快照（按 trade_date upsert） */
export function upsertSnapshot(s: RegimeSnapshot): void {
  const now = nowIso();
  db.insert(schema.regimeSnapshots)
    .values({
      tradeDate: s.tradeDate,
      phase: s.phase,
      score: s.score,
      tomorrowBias: s.tomorrowBias,
      suggestedFrequency: s.suggestedFrequency,
      positionRange: s.positionRange,
      breakdown: JSON.stringify(s.breakdown),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.regimeSnapshots.tradeDate,
      set: {
        phase: s.phase,
        score: s.score,
        tomorrowBias: s.tomorrowBias,
        suggestedFrequency: s.suggestedFrequency,
        positionRange: s.positionRange,
        breakdown: JSON.stringify(s.breakdown),
        updatedAt: now,
      },
    })
    .run();
}

/** 取严格早于 tradeDate 的最近一条快照（判方向/连续用，无则 null） */
export function getPrevSnapshot(tradeDate: string): { phase: MarketRegimePhase; score: number } | null {
  const row = db
    .select({
      phase: schema.regimeSnapshots.phase,
      score: schema.regimeSnapshots.score,
      tradeDate: schema.regimeSnapshots.tradeDate,
    })
    .from(schema.regimeSnapshots)
    .where(lt(schema.regimeSnapshots.tradeDate, tradeDate))
    .orderBy(desc(schema.regimeSnapshots.tradeDate))
    .limit(1)
    .get();
  if (!row) return null;
  // 与情绪同一口径：不是上一交易日的行不当「昨天」用，否则会算出跨越数周的假环比
  if (row.tradeDate !== prevTradingDay(tradeDate)) return null;
  return { phase: row.phase as MarketRegimePhase, score: row.score };
}

/**
 * 统计「当前阶段已连续几个交易日」。
 *
 * 必须按**连续交易日**逐日回溯，不能数数据库行数。
 * 快照漏跑时表里是断续的（实测存在 8-28 / 8-20 / 8-18 / 8-07 这种间隔），
 * 数行数会把跨越三周的四条记录报成「已连续 4 天」，
 * 而这个数字直接用于判断趋势是否稳固。遇到缺口即停，是唯一诚实的做法。
 *
 * 无历史返回 1（今日为该阶段第 1 天）。
 */
export function countConsecutivePhase(tradeDate: string, phase: MarketRegimePhase, look = 40): number {
  const limit = Math.min(Math.max(look, 1), 250);
  const rows = db
    .select({ phase: schema.regimeSnapshots.phase, tradeDate: schema.regimeSnapshots.tradeDate })
    .from(schema.regimeSnapshots)
    .where(lt(schema.regimeSnapshots.tradeDate, tradeDate))
    .orderBy(desc(schema.regimeSnapshots.tradeDate))
    .limit(limit)
    .all();
  const phaseByDate = new Map(rows.map((r) => [r.tradeDate, r.phase as MarketRegimePhase]));
  let count = 1;
  let cursor = tradeDate;
  for (let i = 0; i < limit; i += 1) {
    cursor = prevTradingDay(cursor);
    // 那天压根没有快照 → 链条断了，不能跳过缺口继续往前接
    const p = phaseByDate.get(cursor);
    if (p == null || p !== phase) break;
    count += 1;
  }
  return count;
}

/** 最新一条快照（今日或最近一个交易日），供驾驶舱纯本地秒开展示；无则 null */
export function getLatestSnapshot(): (RegimeSnapshot & { updatedAt: string }) | null {
  const row = db
    .select()
    .from(schema.regimeSnapshots)
    .orderBy(desc(schema.regimeSnapshots.tradeDate))
    .limit(1)
    .get();
  if (!row) return null;
  return {
    tradeDate: row.tradeDate,
    phase: row.phase as MarketRegimePhase,
    score: row.score,
    tomorrowBias: row.tomorrowBias as MarketRegimeBias,
    suggestedFrequency: row.suggestedFrequency as MarketRegimeFrequency,
    positionRange: row.positionRange,
    breakdown: parse<StrengthBreakdown>(row.breakdown, { total: row.score, parts: [] }),
    updatedAt: row.updatedAt,
  };
}

/** 历史趋势（倒序最近 N 条） */
export function listHistory(limit = 60): MarketRegimeHistoryItem[] {
  const rows = db
    .select({
      tradeDate: schema.regimeSnapshots.tradeDate,
      phase: schema.regimeSnapshots.phase,
      score: schema.regimeSnapshots.score,
      tomorrowBias: schema.regimeSnapshots.tomorrowBias,
    })
    .from(schema.regimeSnapshots)
    .orderBy(desc(schema.regimeSnapshots.tradeDate))
    .limit(Math.min(Math.max(limit, 1), 250))
    .all();
  return rows.map((r) => ({
    tradeDate: r.tradeDate,
    phase: r.phase as MarketRegimePhase,
    score: r.score,
    tomorrowBias: r.tomorrowBias as MarketRegimeBias,
  }));
}

// parse 供未来扩展 payload 读取（当前 breakdown 已够用）
export { parse as parseJson };
