import { and, eq, isNull, sql } from 'drizzle-orm';
import type { SymbolTradePlan } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { getKline } from '../market/eastmoney';
import { newId, nowIso } from '../util';

// 情景概率的落库与自动核对（计划 S5）。
//
// 模型报的概率是未经校准的主观数，界面已经这么标注。但只标注不记录，它就永远
// 只是个主观数——攒不出「模型报 70% 时实际兑现多少」这张表，也就永远没机会变准。
// 这里做的全部事情就是：生成计划时把预测冻结落库，到期后按实际走势判定 hit/miss/timeout。
//
// 纪律：本模块只写 symbol_plan_forecasts，绝不回写计划、仓位或告警。
// 概率一旦流进那些链路，事后就分不清某次超配是模型看错了还是这个数本身没根。

/** 预测的观察窗口（自然日）。超过这么久还没走到目标或失效，就判 timeout */
const HORIZON_DAYS = 20;

export type ForecastOutcome = 'hit' | 'miss' | 'timeout';

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 把计划各情景的主观概率冻结落库。必须在 compileAndSavePlan 的事务内调用，
 * 保证「计划落库」与「预测记录」同时成立——只落一半会让核对表出现无主记录。
 *
 * 目标价与失效价在这里取值并冻结，不存 levelId：计划改版后价位会变，
 * 事后拿新价去判旧预测，判出来的对错跟当初报概率时说的根本不是一回事。
 *
 * @returns 实际写入的条数（没报概率的情景不写，不拿 0 或 50 冒充）
 */
export function recordForecasts(plan: SymbolTradePlan, basePrice: number): number {
  if (!(basePrice > 0)) return 0;
  const levelPrice = (id: string): number | null => {
    const l = plan.levels.find((x) => x.id === id);
    return l?.price ?? l?.zoneHigh ?? l?.zoneLow ?? null;
  };
  const invalidPrice =
    plan.risk.executionStop ??
    plan.risk.structuralStop ??
    levelPrice(plan.levels.find((l) => l.role === 'stop' || l.role === 'invalidation')?.id ?? '');

  const now = nowIso();
  let written = 0;
  for (const sc of plan.scenarios) {
    const pct = sc.subjectiveProbabilityPct;
    if (pct == null || !Number.isFinite(pct) || pct < 0 || pct > 100) continue;
    const target = sc.targetLevelIds.map(levelPrice).find((p): p is number => p != null) ?? null;
    // 目标与失效都没有的情景无法判定对错，记了也永远 settle 不掉
    if (target == null && invalidPrice == null) continue;
    db.insert(schema.symbolPlanForecasts)
      .values({
        id: newId(),
        planId: plan.id,
        planVersion: plan.version,
        code: plan.code,
        scenarioId: sc.id,
        scenarioRank: sc.rank,
        probabilityPct: pct,
        probabilityBasis: sc.probabilityBasis ?? null,
        targetPrice: target,
        invalidPrice,
        basePrice,
        dueDate: addDays(now, HORIZON_DAYS),
        outcome: null,
        settledAt: null,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
    written += 1;
  }
  return written;
}

/** 未判定的预测 */
function listPending() {
  return db
    .select()
    .from(schema.symbolPlanForecasts)
    .where(isNull(schema.symbolPlanForecasts.outcome))
    .all();
}

/**
 * 按日线判定一条预测：目标价与失效价谁先被触及。
 *
 * 方向必须按「价位在基准价的哪一侧」判，不能一律按向上突破算。风险情景的目标价本就在
 * 基准价下方，若照 `high >= target` 判，记录当天的第一根 bar 就满足，风险情景会 100% 判兑现——
 * 校准表被系统性抬高，而这张表存在的唯一意义就是如实反映模型报的数准不准。
 *
 * 同一根 bar 内既触目标又破失效时判 miss——日线看不出盘中先后，
 * 而把「说不准」算成兑现，同样是把成绩单往高了修。
 */
export function judge(
  bars: Array<{ time: string; high: number; low: number }>,
  since: string,
  basePrice: number,
  target: number | null,
  invalid: number | null,
  dueDate: string,
  today: string,
): ForecastOutcome | null {
  /** 价位在基准价上方就看最高价能否触及，下方则看最低价 */
  const reached = (level: number, b: { high: number; low: number }): boolean =>
    level >= basePrice ? b.high >= level : b.low <= level;
  const window = bars.filter((b) => b.time > since.slice(0, 10));
  for (const b of window) {
    if (invalid != null && reached(invalid, b)) return 'miss';
    if (target != null && reached(target, b)) return 'hit';
  }
  return today >= dueDate ? 'timeout' : null;
}

/**
 * 核对全部到期或已走出结果的预测。挂在收盘后的模块定时上。
 * 取数失败的那一条跳过，下次再判——判不了就先不判，绝不拿缺数据当 timeout。
 */
export async function settleDueForecasts(): Promise<{
  checked: number;
  settled: Record<ForecastOutcome, number>;
}> {
  const pending = listPending();
  const today = new Date().toISOString().slice(0, 10);
  const settled: Record<ForecastOutcome, number> = { hit: 0, miss: 0, timeout: 0 };
  // 同一标的的多个情景（主/备选/风险）共用一条日线，按 code 取一次即可。
  // 逐条取会把一份计划的三个情景变成三次重复回源。
  const barsOf = new Map<string, Array<{ time: string; high: number; low: number }> | null>();
  for (const f of pending) {
    if (!barsOf.has(f.code)) {
      try {
        barsOf.set(f.code, await getKline(f.code, 'day', 60));
      } catch {
        barsOf.set(f.code, null);
      }
    }
    const bars = barsOf.get(f.code);
    if (!bars) continue;
    const outcome = judge(
      bars,
      f.createdAt,
      f.basePrice,
      f.targetPrice,
      f.invalidPrice,
      f.dueDate,
      today,
    );
    if (!outcome) continue;
    db.update(schema.symbolPlanForecasts)
      .set({ outcome, settledAt: nowIso() })
      .where(eq(schema.symbolPlanForecasts.id, f.id))
      .run();
    settled[outcome] += 1;
  }
  return { checked: pending.length, settled };
}

/**
 * 校准摘要：某个概率档位历史上记录过多少次、兑现多少次。
 * 样本不够时界面只显示「已记录 N 次」，不显示兑现率——十来个样本算出的比率
 * 比模型报的原数更容易骗人。
 */
export function calibrationOf(pct: number): { recorded: number; hit: number; settled: number } {
  const lo = Math.floor(pct / 10) * 10;
  const rows = db
    .select({
      recorded: sql<number>`count(*)`,
      settled: sql<number>`sum(case when outcome is not null then 1 else 0 end)`,
      hit: sql<number>`sum(case when outcome = 'hit' then 1 else 0 end)`,
    })
    .from(schema.symbolPlanForecasts)
    .where(
      and(
        sql`${schema.symbolPlanForecasts.probabilityPct} >= ${lo}`,
        sql`${schema.symbolPlanForecasts.probabilityPct} < ${lo + 10}`,
      ),
    )
    .get();
  return {
    recorded: Number(rows?.recorded ?? 0),
    settled: Number(rows?.settled ?? 0),
    hit: Number(rows?.hit ?? 0),
  };
}

/** 供自检与调试 */
export function listForecasts(planId: string) {
  return db
    .select()
    .from(schema.symbolPlanForecasts)
    .where(eq(schema.symbolPlanForecasts.planId, planId))
    .all();
}