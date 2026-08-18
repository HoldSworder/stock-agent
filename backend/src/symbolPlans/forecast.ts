import { and, eq, isNull, sql } from 'drizzle-orm';
import type { SymbolTradePlan, TradeScenario } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { getKline } from '../market/eastmoney';
import { newId, nowIso, shanghaiClock, shanghaiToday } from '../util';
import { getPlan } from './repo';

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

/**
 * 「这条记录永远判不了」的终止标记。写进 outcome 让它退出 pending 队列，
 * 但不计入校准分母（`calibrationOf` 的 settled 只数三种真实结局）——
 * 把取不到 K 线的旧记录算成 timeout 会凭空压低兑现率。
 */
const UNJUDGEABLE = 'unjudgeable';

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
  const planStop =
    plan.risk.executionStop ??
    plan.risk.structuralStop ??
    levelPrice(plan.levels.find((l) => l.role === 'stop' || l.role === 'invalidation')?.id ?? '');

  /**
   * 失效价必须按情景取，不能全计划共用一个。
   * 计划级止损是多头执行止损，恒在基准价下方；风险情景的目标也在下方，
   * 一旦止损落在「基准价与风险目标之间」（-6% 止损配 -12% 风险目标是常见组合），
   * 下跌必然先命中止损判 miss，风险情景永远不可能 hit——校准表被系统性压低，
   * 与本模块「如实反映模型准不准」的立项目的正好相反。
   * 该情景自己挑的 priceLevel 失效位才是它被证伪的价，取不到才回落计划级止损。
   *
   * 风险情景取不到自己的失效位时返回 null 而不是回落计划级止损：那正是上面要消除的组合
   * （止损 -6% 夹在基准价与风险目标 -12% 之间），套上去 judge 必然先命中更近的止损判 miss，
   * 系统性偏差原样重现。少一个失效位只是让这条记录改由 target 与 timeout 判定，不会误判。
   */
  const scenarioInvalidPrice = (sc: TradeScenario): number | null => {
    for (const c of sc.invalidConditions) {
      if (c.rule.kind === 'priceLevel' && Number.isFinite(c.rule.level)) return c.rule.level;
    }
    return sc.rank === 'risk' ? null : planStop;
  };

  const now = nowIso();
  let written = 0;
  for (const sc of plan.scenarios) {
    const pct = sc.subjectiveProbabilityPct;
    if (pct == null || !Number.isFinite(pct) || pct < 0 || pct > 100) continue;
    // 首项即第一目标（targetLevelIds 的契约），不能取「首个可解析项」——
    // 那样判定结果会随 LLM 的数组顺序漂移，同一份计划两次落库可以判出不同结局。
    const target = sc.targetLevelIds.length > 0 ? levelPrice(sc.targetLevelIds[0]) : null;
    // 没有可解析目标价的情景判不出 hit，只可能判 miss/timeout，记了就是给模型倒扣分
    if (target == null) continue;
    const invalidPrice = scenarioInvalidPrice(sc);
    db.insert(schema.symbolPlanForecasts)
      .values({
        id: newId(),
        planId: plan.id,
        planVersion: plan.version,
        code: plan.code,
        secid: plan.secid ?? null,
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
 * 同一根 bar 内既触目标又破失效时的取舍分两种：
 * - 两价位在基准价**异侧**：日线看不出盘中先后，判 miss——把「说不准」算成兑现是往高了修成绩单；
 * - **同侧**（如风险目标 -12% 配止损 -6%）：价格要走到远的那个必先经过近的那个，
 *   按「离基准价更近者先到」判即可，此时无条件让失效优先会让远端目标永远判不出 hit。
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
  const oppositeSides =
    target != null && invalid != null && (target - basePrice) * (invalid - basePrice) < 0;
  for (const b of window(bars, since)) {
    const invHit = invalid != null && reached(invalid, b);
    const tgtHit = target != null && reached(target, b);
    if (!invHit && !tgtHit) continue;
    if (invHit && !tgtHit) return 'miss';
    if (tgtHit && !invHit) return 'hit';
    if (oppositeSides) return 'miss';
    return Math.abs(target! - basePrice) <= Math.abs(invalid! - basePrice) ? 'hit' : 'miss';
  }
  return today >= dueDate ? 'timeout' : null;
}

/**
 * 参与判定的 bar 区间。
 *
 * 落库当日那根**默认不算**：报概率时那根已经在眼前，拿它判等于用已知结果打分。
 * 唯一例外是盘前（上海时间 09:30 前）生成的计划——那时当日行情整根都还没发生，
 * 排除它会把「当天就走到目标」的兑现全部漏掉，而这类计划正是盘前批量生成的主力。
 *
 * 「哪一天」必须与「是否盘前」同源取上海日期：since 是 UTC ISO，直接切前 10 位在
 * 上海 00:00–08:00 会取到前一天——那根 bar 记录预测时早已走完，正是本函数要排除的。
 */
function window<T extends { time: string }>(bars: T[], since: string): T[] {
  const at = new Date(since);
  const day = shanghaiToday(at);
  const beforeOpen = shanghaiClock(at) < '09:30';
  return bars.filter((b) => (beforeOpen ? b.time >= day : b.time > day));
}

/**
 * 核对全部到期或已走出结果的预测。挂在收盘后的模块定时上。
 * 取数失败的那一条跳过，下次再判——判不了就先不判，绝不拿缺数据当 timeout。
 */
export async function settleDueForecasts(): Promise<{
  checked: number;
  settled: Record<ForecastOutcome, number>;
  unjudgeable: number;
}> {
  const pending = listPending();
  const today = new Date().toISOString().slice(0, 10);
  const settled: Record<ForecastOutcome, number> = { hit: 0, miss: 0, timeout: 0 };
  let unjudgeable = 0;
  // 同一标的的多个情景（主/备选/风险）共用一条日线，按 code+secid 取一次即可。
  // 逐条取会把一份计划的三个情景变成三次重复回源。
  const barsOf = new Map<string, Array<{ time: string; high: number; low: number }> | null>();
  for (const f of pending) {
    // 旧记录没有 secid：只有在对应计划确实不是指数时，才敢单凭 code 取 K 线。
    // 指数与个股撞码（000300 会被解析成深市个股），猜错市场就是拿另一只标的的
    // OHLC 给这条预测判对错——那比不判更糟，所以直接终止这类记录并留下原因。
    const plan = f.secid ? null : getPlan(f.planId);
    const secid = f.secid ?? plan?.secid ?? null;
    if (!secid && plan?.assetType !== 'stock' && plan?.assetType !== 'etf') {
      db.update(schema.symbolPlanForecasts)
        .set({ outcome: UNJUDGEABLE, settledAt: nowIso(), settleNote: '缺 secid 且无法确认市场，拒绝按代码猜测' })
        .where(eq(schema.symbolPlanForecasts.id, f.id))
        .run();
      unjudgeable += 1;
      continue;
    }
    const key = `${f.code}|${secid ?? ''}`;
    if (!barsOf.has(key)) {
      try {
        barsOf.set(key, await getKline(f.code, 'day', 60, secid ?? undefined));
      } catch {
        barsOf.set(key, null);
      }
    }
    const bars = barsOf.get(key);
    // 空数组同样是「这次取不到数」：[] 是 truthy，放过去会让 window 为空、到期即判 timeout，
    // 把一次上游故障记成模型没走到目标
    if (!bars || bars.length === 0) continue;
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
  return { checked: pending.length, settled, unjudgeable };
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
      settled: sql<number>`sum(case when outcome in ('hit','miss','timeout') then 1 else 0 end)`,
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