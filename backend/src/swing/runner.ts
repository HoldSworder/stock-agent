import { desc, eq } from 'drizzle-orm';
import type { KlineBar, KlinePeriod, SwingGrade, SwingTrackCategory } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { getKline } from '../datasource/scheduler';
import { newId, nowIso, shanghaiToday } from '../util';
import { getRegimeSummaryForCockpit } from '../regime/service';
import { collectSwingTargets, type SwingTarget } from './targets';
import { dropUnclosedBar, judgeSwing } from './judge';
import { ensureRuleVersion, isValidationEligible } from './ruleVersion';
import {
  advanceAdvices,
  countOpenAdvices,
  listOpenAdvices,
  openAdvice,
  usedBudgetPct,
} from './adviceStore';
import {
  LAYER_SPLIT,
  MAX_CONCURRENT_ADVICES,
  SINGLE_CAP_PCT,
  TOTAL_UNVERIFIED_CAP_PCT,
} from './sizing';
import { MIN_BARS_FOR_STRUCTURE } from './universe';

// 一轮扫描的编排：取数 → 定级 → 整批发布快照。
//
// 两个刻意的设计：
//
// 1) 快照**整批事务发布**，且带运行批次状态。
//    部分标的取数失败时保留上一份完整快照，并把失败清单一并存下来。
//    若用残缺榜单直接覆盖，页面会显示成「今天这些赛道没信号」——
//    而实际是「今天没取到数」，这两件事对使用者的含义完全相反。
//
// 2) 日线与 60 分钟线**都算、都存**。
//    2026-08-18 半导体那次回归表明：顶部形成之前日线的结构还停在上一段方向上，
//    只有 60 分钟线能给出提前提示；而日线噪声更少、更适合做主判断。
//    两者不能互相替代，所以各存一条，由页面并列展示。

/** 取多少根 K 线。260 根够算 ATR14 与多段结构，也不至于让取数变慢 */
const BARS_LIMIT = 260;

/** 同时取几个标的。分钟线不进缓存、每次都回源，并发开大容易被限流 */
const FETCH_CONCURRENCY = 3;

/**
 * 60 分钟线**只对这些标的取**，不是全量。
 *
 * 实测代价：521 个标的全量取两个周期是 1042 次请求，
 * 日线在生产有 SQLite 缓存所以便宜，但 60 分钟线完全不缓存、每次都回源，
 * 连续跑两轮就被数据源限流卡死（第一轮 82 秒，第二轮跑了 15 分钟没出来）。
 *
 * 而且这不只是性能问题：60 分钟线在这里的作用是**提前提示与交叉验证**，
 * 自选里几百只标的没必要个个都算分钟级结构——
 * 真正需要盯的是手上有仓位的、日线已经出信号的、以及作为赛道代表的那些。
 */
function needs60m(t: SwingTarget, dayHasSignal: boolean): boolean {
  return t.realPct > 0 || t.isTrackProxy || dayHasSignal;
}

/** 并发受限的 map，控制对行情源的瞬时压力 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const ret = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      ret[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return ret;
}

/**
 * 取一个标的一个周期的 K 线。
 *
 * 注意：getKline('60m') 内部还会额外取一次日线做前复权（见 datasource/scheduler），
 * 所以「每个标的只回源一次」目前做不到——要兑现得改调度层允许传入已取好的日线。
 */
async function fetchOne(
  code: string,
  period: KlinePeriod,
): Promise<{ bars: KlineBar[] | null; error: string | null }> {
  try {
    const bars = await getKline(code, period, BARS_LIMIT);
    if (bars.length >= MIN_BARS_FOR_STRUCTURE) return { bars, error: null };
    return { bars: null, error: `${period} 只有 ${bars.length} 根` };
  } catch (e) {
    return { bars: null, error: `${period} ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 赛道类别 → 快照里存的分类。持仓与自选没有赛道，归为「我的」 */
function categoryOf(t: SwingTarget, repCategory: SwingTrackCategory | null): SwingTrackCategory {
  if (t.origin === 'position' || t.origin === 'watchlist') return 'own';
  return repCategory ?? 'own';
}

/**
 * 信号质量分，**只用于挑哪几只建仓**，不用于页面排序。
 *
 * 三个依据都是客观事实，不含主观打分：
 *  - 价格已走出反转确认（二级）比只有指标读数（一级）可靠
 *  - 力道衰减得越彻底，背驰越明显
 *  - 已经在持仓或自选里的，说明本来就在关注，优先于系统自己挑的赛道代表
 */
function qualityScore(
  row: typeof schema.swingSnapshots.$inferInsert,
  targets: SwingTarget[],
): number {
  let s = 0;
  if (row.grade === 'turn_confirmed_bottom') s += 100;
  s += (row.divergenceStrength ?? 0) * 50;
  const t = targets.find((x) => x.code === row.code);
  if (t && (t.origin === 'position' || t.origin === 'watchlist')) s += 20;
  return s;
}

export interface RunResult {
  runId: string;
  tradeDate: string;
  status: 'ok' | 'partial' | 'failed';
  targetCount: number;
  okCount: number;
  failures: Array<{ code: string; reason: string }>;
}

/**
 * 跑一轮扫描并发布快照。
 *
 * @param mode live 为正常运行；replay 为历史重放，其样本永久不得用于验收放行
 */
export async function runSwingScan(mode: 'live' | 'replay' = 'live'): Promise<RunResult> {
  const rule = ensureRuleVersion();
  const tradeDate = shanghaiToday();
  const runId = newId();
  const startedAt = nowIso();
  const marketPhase = getRegimeSummaryForCockpit()?.phase ?? null;

  const collected = await collectSwingTargets();
  const targets = collected.targets;
  const repCategoryByCode = new Map<string, SwingTrackCategory>(
    collected.representatives.map((r) => [r.code, r.category]),
  );

  // 先登记运行批次为 running：中途进程退出时能看出「这一轮没跑完」，
  // 而不是留下一份看起来正常的残缺快照
  db.insert(schema.swingRuns)
    .values({
      id: runId,
      tradeDate,
      ruleVersion: rule.version,
      mode,
      status: 'running',
      targetCount: targets.length,
      okCount: 0,
      failures: JSON.stringify(
        collected.failures.map((f) => ({ code: f.source, reason: f.reason })),
      ),
      dataAsOf: null,
      startedAt,
      finishedAt: null,
    })
    .run();

  const failures: Array<{ code: string; reason: string }> = collected.failures.map((f) => ({
    code: f.source,
    reason: f.reason,
  }));
  const rows: Array<typeof schema.swingSnapshots.$inferInsert> = [];
  let okCount = 0;
  let dataAsOf: string | null = null;

  /** 把一次定级结果转成待插入的行 */
  const toRow = (
    t: SwingTarget,
    period: KlinePeriod,
    bars: KlineBar[],
  ): typeof schema.swingSnapshots.$inferInsert => {
    // 传标的名进去：除权除息日的名字带 XD/XR/DR 前缀，那天不给结论
    const j = judgeSwing(bars, period, t.name);
    const last = bars[bars.length - 1];
    if (last && (dataAsOf == null || last.time > dataAsOf)) dataAsOf = last.time;
    return {
      id: newId(),
      runId,
      tradeDate,
      code: t.code,
      name: t.name,
      period,
      assetType: t.assetType,
      track: t.track,
      category: categoryOf(t, repCategoryByCode.get(t.code) ?? null),
      isTrackProxy: t.isTrackProxy,
      grade: j.grade,
      divergenceStrength: j.divergence?.strength ?? null,
      zoneLow: j.zone?.low ?? null,
      zoneHigh: j.zone?.high ?? null,
      initialStop: j.initialStop,
      atr14: j.atr14,
      close: last?.close ?? 0,
      watchLevels: JSON.stringify(j.watchLevels),
      // 依据、反证、无法判断的原因、追高线都一并存下来：
      // 复盘误报时需要知道当时到底看到了什么
      rationale: JSON.stringify({
        rationale: j.rationale,
        counterEvidence: j.counterEvidence,
        unavailableReason: j.unavailableReason,
        divergenceConfirmed: j.divergence?.confirmed ?? null,
        chaseGuard: j.chaseGuard,
        peerCount: t.peerCount,
        realPct: t.realPct,
        origin: t.origin,
      }),
      barTime: last?.time ?? null,
      marketPhase,
      ruleVersion: rule.version,
      ruleHash: rule.ruleHash,
      // 此刻还不知道整轮最终状态，先按完整成功判定；
      // 收尾时若整轮不是 ok 会把这一批统一改为不合格
      validationEligible: isValidationEligible({
        ruleVersion: rule.version,
        ruleHash: rule.ruleHash,
        mode,
        barTime: last?.time ?? null,
        tradeDate,
        runStatus: 'ok',
      }),
      createdAt: nowIso(),
    };
  };

  // --- 阶段一：全部标的取日线 ---
  const dayResults = await mapLimit(targets, FETCH_CONCURRENCY, async (t) => ({
    target: t,
    ...(await fetchOne(t.code, 'day')),
  }));

  const need60m: SwingTarget[] = [];
  for (const r of dayResults) {
    if (!r.bars) {
      failures.push({ code: r.target.code, reason: r.error ?? '未取到日线' });
      continue;
    }
    const row = toRow(r.target, 'day', dropUnclosedBar(r.bars));
    rows.push(row);
    okCount += 1;
    if (needs60m(r.target, row.grade !== 'none')) need60m.push(r.target);
  }

  // --- 阶段二：只对需要的标的取 60 分钟线 ---
  const m60Results = await mapLimit(need60m, FETCH_CONCURRENCY, async (t) => ({
    target: t,
    ...(await fetchOne(t.code, '60m')),
  }));
  for (const r of m60Results) {
    if (!r.bars) {
      // 60 分钟线取不到不算标的级失败——日线已经给出了主判断
      continue;
    }
    rows.push(toRow(r.target, '60m', dropUnclosedBar(r.bars)));
  }

  // --- 阶段三：推进已有建议持仓，并在够条件时建新的第一层 ---
  //
  // 顺序很重要：**先推进再新建**。
  // 反过来的话，今天刚建的仓会立刻被同一天的评估拿去判止损与时间退出，
  // 而它连一根 K 线都还没经历过。
  const dayBarByCode = new Map<string, KlineBar>();
  for (const r of dayResults) {
    if (r.bars) {
      const closed = dropUnclosedBar(r.bars);
      const last = closed[closed.length - 1];
      if (last) dayBarByCode.set(r.target.code, last);
    }
  }
  const gradeByCode = new Map<string, SwingGrade>();
  for (const row of rows) {
    // 建议持仓一律以日线定级推进：60 分钟线的结论会随盘中变动，
    // 拿它推进持仓会让同一笔建议一天内反复改口
    if (row.period !== 'day') continue;
    gradeByCode.set(row.code, row.grade as SwingGrade);
  }

  // 第二层的可加比例：按原计划的六成，但**必须再受剩余额度约束**。
  // 状态机本身不认识额度（它是纯函数），所以这个约束只能在这里加——
  // 漏了它，三条建议各加满第二层会突破 20% 的合计上限。
  const layer2ByCode = new Map<string, number>();
  for (const a of listOpenAdvices()) {
    const remaining = Math.max(0, TOTAL_UNVERIFIED_CAP_PCT - usedBudgetPct());
    // 第一层占四成，故整笔的总量是第一层 ÷ 0.4，第二层是其六成
    const plannedLayer2 = (a.targetPct / LAYER_SPLIT.layer1) * LAYER_SPLIT.layer2;
    const capped = Math.min(plannedLayer2, remaining, SINGLE_CAP_PCT - a.targetPct);
    layer2ByCode.set(a.code, Math.max(0, Math.round(capped * 10) / 10));
  }

  const advanceResult = advanceAdvices({
    barByCode: dayBarByCode,
    gradeByCode,
    layer2PctByCode: layer2ByCode,
    ruleVersion: rule.version,
    tradeDate,
  });
  for (const b of advanceResult.blocked) failures.push({ code: b.code, reason: b.reason });

  // 新建第一层：只对**日线的底部信号**、且价格已进入区间的标的。
  // 顶部信号不建仓（本模块只做多，顶部只用于减已有持仓）。
  // 总资产取不到时一律不建——不知道本金就算不出风险，那个百分比是假的。
  if (collected.totalEquity != null) {
    const candidates = rows
      .filter((row) => {
        if (row.period !== 'day') return false;
        if (row.grade !== 'risk_easing_bottom' && row.grade !== 'turn_confirmed_bottom') {
          return false;
        }
        if (row.zoneLow == null || row.zoneHigh == null || row.initialStop == null) return false;
        // 价格必须已经进入区间：区间是「跌到这里再分批」，没跌到就不该建
        const close = row.close ?? 0;
        return close >= row.zoneLow && close <= row.zoneHigh;
      })
      // 按信号质量排序后择优建仓，不按遍历顺序先到先得。
      // 排序只用于**挑哪几只建**，页面展示不排序（排序过的名单会被读成推荐）
      .sort((a, b) => qualityScore(b, targets) - qualityScore(a, targets));

    let opened = countOpenAdvices();
    for (const row of candidates) {
      if (opened >= MAX_CONCURRENT_ADVICES) break;
      const t = targets.find((x) => x.code === row.code);
      const bars = dayResults.find((r) => r.target.code === row.code)?.bars;
      if (!t || !bars || row.zoneLow == null || row.zoneHigh == null || row.initialStop == null) {
        continue;
      }
      const r = openAdvice({
        code: row.code,
        name: row.name,
        direction: 'long_bottom',
        zone: { low: row.zoneLow, high: row.zoneHigh },
        initialStop: row.initialStop,
        bars,
        assetType: t.assetType,
        totalEquity: collected.totalEquity,
        realPct: t.realPct,
        // ETF 盯盘的建议层暂未接入合并，先按 0 处理。
        // 接入前 swing 可能与它重复占仓，故合计上限压在 20% 有额外意义
        etfWatchPct: 0,
        ruleVersion: rule.version,
        tradeDate,
      });
      if (r.created) opened += 1;
    }
  }

  // 只有标的级失败才算 partial：来源级失败（如取不到自选表）已在 collected.failures 里，
  // 用 6 位代码区分两者
  const hasTargetFailure = failures.some((f) => /^\d{6}$/.test(f.code));
  const status: RunResult['status'] =
    okCount === 0 ? 'failed' : hasTargetFailure ? 'partial' : 'ok';

  // 整批事务：快照与运行状态一起落地。
  // 分两次写的话，进程在中间退出会留下「有快照但运行状态还是 running」
  db.transaction((tx) => {
    if (rows.length > 0) {
      const finalRows =
        status === 'ok' ? rows : rows.map((r) => ({ ...r, validationEligible: false }));
      for (const r of finalRows) tx.insert(schema.swingSnapshots).values(r).run();
    }
    tx.update(schema.swingRuns)
      .set({
        status,
        okCount,
        failures: JSON.stringify(failures),
        dataAsOf,
        finishedAt: nowIso(),
      })
      .where(eq(schema.swingRuns.id, runId))
      .run();
  });

  return { runId, tradeDate, status, targetCount: targets.length, okCount, failures };
}

/**
 * 一轮扫描超过这个时长仍是 running，就认定它死了。
 *
 * 为什么需要这条：进程被杀、或数据源限流导致取数悬挂时，
 * 那一轮会永久停在 running。僵尸批次会累积，更麻烦的是页面分不清
 * 「今天还没扫过」和「今天正在扫」——前者要提示手动扫，后者只需等。
 *
 * 40 分钟是按最坏情况定的：519 个标的、日线缓存全冷、分钟线不缓存时约需十几分钟，
 * 留两倍余量。正常走缓存只要半分钟。
 */
const RUN_STALE_MS = 40 * 60_000;

/** 把超时未完成的批次标为失败，避免僵尸记录堆积 */
function reapStaleRuns(): void {
  const stale = db
    .select()
    .from(schema.swingRuns)
    .where(eq(schema.swingRuns.status, 'running'))
    .all()
    .filter((r) => Date.now() - new Date(r.startedAt).getTime() > RUN_STALE_MS);
  for (const r of stale) {
    db.update(schema.swingRuns)
      .set({
        status: 'failed',
        finishedAt: nowIso(),
        failures: JSON.stringify([
          { code: '整轮', reason: '这一轮扫描太久没完成，已作废（可能是取行情太慢或中途断了）' },
        ]),
      })
      .where(eq(schema.swingRuns.id, r.id))
      .run();
  }
}

/**
 * 读最近一份可用快照。
 *
 * 优先取最近一份完整成功的；没有则退到最近一份部分成功的。
 * 无论取到哪份，都把运行状态一并返回——页面必须据此显示快照日期与失败标的，
 * 否则会把昨天的建议当成今天的。
 */
export function readLatestSnapshot(): {
  run: typeof schema.swingRuns.$inferSelect | null;
  rows: Array<typeof schema.swingSnapshots.$inferSelect>;
  /** 是否有一轮正在跑。页面据此区分「还没扫过」与「正在扫，等一下」 */
  running: boolean;
} {
  reapStaleRuns();
  const runs = db
    .select()
    .from(schema.swingRuns)
    .orderBy(desc(schema.swingRuns.startedAt))
    .limit(20)
    .all();
  const running = runs.some((r) => r.status === 'running');
  const run =
    runs.find((r) => r.status === 'ok') ?? runs.find((r) => r.status === 'partial') ?? null;
  if (!run) return { run: null, rows: [], running };
  const rows = db
    .select()
    .from(schema.swingSnapshots)
    .where(eq(schema.swingSnapshots.runId, run.id))
    .all();
  return { run, rows, running };
}
