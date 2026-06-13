import { desc, eq } from 'drizzle-orm';
import type { ScreenPick, ScreenRun, ScreenRunDetail, ScreenFactorScore } from '@stock-agent/shared';
import { db } from '../db/client';
import { screenPicks, screenRuns } from '../db/schema';
import { newId, nowIso } from '../util';

// 选股运行落库：一次运行写 screen_runs 1 行 + screen_picks N 行（事务）。
// JSON 列（factors/riskTags/watchItems/invalidators）在边界处序列化/反序列化。

type RunRow = typeof screenRuns.$inferSelect;
type PickRow = typeof screenPicks.$inferSelect;

function parseArr<T>(s: string | null): T[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function toRun(r: RunRow): ScreenRun {
  return {
    id: r.id,
    engine: r.engine,
    strategyId: r.strategyId,
    strategyName: r.strategyName,
    trigger: r.trigger as ScreenRun['trigger'],
    marketCount: r.marketCount,
    filteredCount: r.filteredCount,
    topN: r.topN,
    context: r.context,
    marketView: r.marketView,
    selectionLogic: r.selectionLogic,
    portfolioRisk: r.portfolioRisk,
    runId: r.runId,
    createdAt: r.createdAt,
  };
}

function toPick(r: PickRow): ScreenPick {
  return {
    rank: r.rank,
    code: r.code,
    name: r.name,
    price: r.price,
    pct: r.pct,
    industry: r.industry ?? '',
    screenScore: r.screenScore,
    factors: parseArr<ScreenFactorScore>(r.factors),
    thesis: r.thesis,
    riskTags: parseArr<string>(r.riskTags),
    confidence: r.confidence,
    watchItems: parseArr<string>(r.watchItems),
    invalidators: parseArr<string>(r.invalidators),
    evalPrice: r.evalPrice,
    evalAt: r.evalAt,
    evalReturn: r.evalReturn,
  };
}

/** 持久化一次选股运行（元信息 + 候选明细），返回落库的 run id */
export function saveRun(
  meta: Omit<ScreenRun, 'id' | 'createdAt'>,
  picks: ScreenPick[],
): string {
  const id = newId();
  const createdAt = nowIso();
  db.transaction((tx) => {
    tx.insert(screenRuns)
      .values({
        id,
        engine: meta.engine,
        strategyId: meta.strategyId,
        strategyName: meta.strategyName,
        trigger: meta.trigger,
        marketCount: meta.marketCount,
        filteredCount: meta.filteredCount,
        topN: meta.topN,
        context: meta.context,
        marketView: meta.marketView,
        selectionLogic: meta.selectionLogic,
        portfolioRisk: meta.portfolioRisk,
        runId: meta.runId,
        createdAt,
      })
      .run();
    for (const p of picks) {
      tx.insert(screenPicks)
        .values({
          id: newId(),
          runId: id,
          rank: p.rank,
          code: p.code,
          name: p.name,
          price: p.price,
          pct: p.pct,
          industry: p.industry,
          screenScore: p.screenScore,
          factors: JSON.stringify(p.factors),
          thesis: p.thesis,
          riskTags: JSON.stringify(p.riskTags),
          confidence: p.confidence,
          watchItems: JSON.stringify(p.watchItems),
          invalidators: JSON.stringify(p.invalidators),
          evalPrice: p.evalPrice ?? null,
          evalAt: p.evalAt ?? null,
          evalReturn: p.evalReturn ?? null,
          createdAt,
        })
        .run();
    }
  });
  return id;
}

/** 运行列表（倒序），仅元信息 */
export function listRuns(limit = 50): ScreenRun[] {
  return db
    .select()
    .from(screenRuns)
    .orderBy(desc(screenRuns.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200))
    .all()
    .map(toRun);
}

/** 运行详情（元信息 + 候选，按 rank 升序） */
export function getRunDetail(id: string): ScreenRunDetail | null {
  const run = db.select().from(screenRuns).where(eq(screenRuns.id, id)).get();
  if (!run) return null;
  const picks = db
    .select()
    .from(screenPicks)
    .where(eq(screenPicks.runId, id))
    .all()
    .map(toPick)
    .sort((a, b) => a.rank - b.rank);
  return { ...toRun(run), picks };
}

/** 取一次运行的全部候选行（含 id，供 T+N 复盘回填） */
export function getPickRowsForEval(runId: string): PickRow[] {
  return db.select().from(screenPicks).where(eq(screenPicks.runId, runId)).all();
}

/** 回填单只候选的 T+N 复盘结果 */
export function updatePickEval(
  pickId: string,
  evalPrice: number,
  evalReturn: number,
): void {
  db.update(screenPicks)
    .set({ evalPrice, evalReturn, evalAt: nowIso() })
    .where(eq(screenPicks.id, pickId))
    .run();
}
