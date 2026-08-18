import { and, eq, inArray } from 'drizzle-orm';
import type { SymbolMarkKind, SymbolTradePlan, TradeLevel, TradeLevelRole } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso } from '../util';

// 计划标注同步。纪律（计划第六节）：
// - 按 (planId, planVersion, semanticKey) 幂等同步，同一版本重复保存不产生重复线；
// - 新版本不删除历史线，只把旧版本标注置 historical；
// - 失效线不删除，置 invalid 并记 invalidatedAt，供历史图层查看。

/** 角色 → 标注形态与默认配色 */
const ROLE_STYLE: Record<TradeLevelRole, { kind: SymbolMarkKind; color: string; roleTag: string }> = {
  support: { kind: 'price_line', color: '#12b886', roleTag: 'support' },
  resistance: { kind: 'price_line', color: '#f0454a', roleTag: 'resistance' },
  entry_trigger: { kind: 'price_line', color: '#1f6feb', roleTag: 'entry' },
  add_trigger: { kind: 'price_line', color: '#1f6feb', roleTag: 'entry' },
  invalidation: { kind: 'price_line', color: '#ffb000', roleTag: 'stop' },
  stop: { kind: 'price_line', color: '#ffb000', roleTag: 'stop' },
  target: { kind: 'price_line', color: '#9b6dff', roleTag: 'target' },
};

/**
 * 角色展示优先级（数字小的优先）。同一价位兼任多个角色时，合并后的那条线按最高优先级角色着色：
 * 防守位漏看的代价最大，其次是入场触发，最后才是目标位。
 */
const ROLE_PRIORITY: Record<TradeLevelRole, number> = {
  stop: 0,
  invalidation: 1,
  entry_trigger: 2,
  add_trigger: 3,
  resistance: 4,
  support: 5,
  target: 6,
};

/** 语义键：同一计划内同角色同序号只对应一条线 */
export function semanticKeyOf(role: TradeLevelRole, index: number): string {
  return `plan.${role}.${index}`;
}

/** 价位的绘制取点：区间型两点（下沿 + 上沿），单价位一点 */
function pointsOf(lv: TradeLevel): Array<{ time: null; price: number }> | null {
  const isZone = lv.zoneLow != null && lv.zoneHigh != null && lv.zoneHigh > lv.zoneLow;
  const raw = isZone
    ? [lv.zoneLow, lv.zoneHigh]
    : [lv.price ?? lv.zoneLow ?? lv.zoneHigh];
  const prices = raw.filter((p): p is number => p != null && Number.isFinite(p) && p > 0);
  if (prices.length !== raw.length) return null;
  return prices.map((price) => ({ time: null, price }));
}

interface MergedMark {
  points: Array<{ time: null; price: number }>;
  /** 参与合并的价位，按角色优先级排序，第一个决定配色与语义键 */
  levels: TradeLevel[];
}

/**
 * 把画在同一高度的关键位合并成一条标注。
 *
 * 同一个候选价带兼任多个角色（支撑 + 结构失效、压力 + 第一目标）是合法的计划语义，
 * 但逐个 level 各画一条线会在图上产生完全重合、读图时无法区分的多条线。
 * 合并发生在这一层——不能反过来在提案校验层拒绝双角色，那会把合法计划打成观察计划。
 */
function mergeLevelsByPrice(levels: TradeLevel[]): MergedMark[] {
  const groups = new Map<string, MergedMark>();
  for (const lv of levels) {
    const points = pointsOf(lv);
    if (!points) continue;
    if (!ROLE_STYLE[lv.role]) continue;
    // 分组键 = 周期 + 最终绘制点位：画在同一位置的才合并，语义不同但位置不同的一律各画各的。
    // 必须带 timeframe——三层候选常给出价格相同的位子（周线压力位与日线压力位重合），
    // 不带周期就会被合成一条线，图表按周期过滤时它要么整条消失、要么在小周期图上冒出来。
    const key = `${lv.timeframe}|${points.map((p) => p.price.toFixed(4)).join('~')}`;
    const hit = groups.get(key);
    if (hit) hit.levels.push(lv);
    else groups.set(key, { points, levels: [lv] });
  }
  for (const g of groups.values()) {
    g.levels.sort((a, b) => ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role]);
  }
  return [...groups.values()];
}

/**
 * 把计划的 levels 同步成 K 线标注。
 * 必须在调用方的事务内执行，保证「计划落库」与「图上线」同时成功或同时不发生。
 */
export function syncPlanMarks(plan: SymbolTradePlan): { inserted: number; historized: number } {
  // 1. 同标的其他计划的标注转 historical（不删）。
  //    期限车道合并后不再按 horizon 过滤：一个标的只有一份生效计划，
  //    遗留的 next_session / swing 老计划的线也要在这里一起归档，
  //    否则它们会连同被 supersedeOthers 置为 superseded 的计划一起，把陈旧的线永远挂在图上。
  //    symbol_marks 无 code 列，故先取该标的的计划 id 集合再按 planId 过滤。
  const sameLanePlanIds = db
    .select({ id: schema.symbolTradePlans.id })
    .from(schema.symbolTradePlans)
    .where(eq(schema.symbolTradePlans.code, plan.code))
    .all()
    .map((r) => r.id)
    .filter((id) => id !== plan.id);

  const historized =
    sameLanePlanIds.length > 0
      ? db
          .update(schema.symbolMarks)
          .set({ status: 'historical' })
          .where(
            and(
              eq(schema.symbolMarks.code, plan.code),
              inArray(schema.symbolMarks.planId, sameLanePlanIds),
              eq(schema.symbolMarks.status, 'active'),
            ),
          )
          .run()
      : { changes: 0 };

  // 2. 幂等：先清掉本版本已写入的标注，再重写（同一版本重复保存不产生重复线）
  db.delete(schema.symbolMarks)
    .where(
      and(
        eq(schema.symbolMarks.planId, plan.id),
        eq(schema.symbolMarks.planVersion, plan.version),
      ),
    )
    .run();

  // 3. 写入本版本标注
  let inserted = 0;
  const now = nowIso();
  mergeLevelsByPrice(plan.levels).forEach((g, i) => {
    const primary = g.levels[0];
    const style = ROLE_STYLE[primary.role];
    // 合并后的标签把各角色都列出来，避免「支撑 + 结构失效」只剩一个称呼
    const label = Array.from(new Set(g.levels.map((l) => l.label))).join(' / ');
    const rationale = Array.from(new Set(g.levels.map((l) => l.rationale))).join('；');
    db.insert(schema.symbolMarks)
      .values({
        id: newId(),
        code: plan.code,
        kind: style.kind,
        label,
        note: `${rationale}（计划 v${plan.version}）`,
        points: JSON.stringify(g.points),
        color: style.color,
        sessionId: plan.sessionId,
        runId: plan.runId,
        createdAt: now,
        semanticKey: semanticKeyOf(primary.role, i),
        timeframe: primary.timeframe,
        role: style.roleTag,
        planId: plan.id,
        planVersion: plan.version,
        status: 'active',
        invalidatedAt: null,
      })
      .run();
    inserted += 1;
  });

  return { inserted, historized: Number(historized.changes ?? 0) };
}

/** 计划失效：其标注置 invalid 并记时间，不删除 */
export function invalidatePlanMarks(planId: string, planVersion: number): number {
  const res = db
    .update(schema.symbolMarks)
    .set({ status: 'invalid', invalidatedAt: nowIso() })
    .where(
      and(eq(schema.symbolMarks.planId, planId), eq(schema.symbolMarks.planVersion, planVersion)),
    )
    .run();
  return Number(res.changes ?? 0);
}

/** 供自检与调试：读某计划版本的标注 */
export function listPlanMarks(planId: string, planVersion?: number) {
  const where =
    planVersion == null
      ? eq(schema.symbolMarks.planId, planId)
      : and(eq(schema.symbolMarks.planId, planId), eq(schema.symbolMarks.planVersion, planVersion));
  return db.select().from(schema.symbolMarks).where(where).all();
}

// 这里曾有一个 shouldRenderOnTimeframe：价位线一律跨周期展示。
// 它与实际渲染依据 shared 的 isPlanLineVisible 相互矛盾（后者按角色与周期决定可见性），
// 生产无任何调用方，只被自检断言锁着，等于把一条废弃规则当成契约在维护。已删除。

export type { TradeLevel };
