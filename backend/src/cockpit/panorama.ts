import { desc, sql } from 'drizzle-orm';
import type {
  CockpitPanorama,
  CockpitPanoramaLive,
  MarketRegimePhase,
  PanoramaAccount,
  PanoramaBlock,
  PanoramaCanTrade,
  PanoramaDisciplineSummary,
  PanoramaDragonRead,
  PanoramaEquityPoint,
  PanoramaEtfWatch,
  PanoramaFocus,
  PanoramaHealthCell,
  PanoramaLane,
  PanoramaPlanAction,
  PanoramaRotationItem,
  PanoramaSentimentNow,
  PanoramaSentimentPoint,
  PanoramaStockWatch,
  PanoramaTodo,
  SentimentComponents,
  BoardMainlineStage,
  BoardStageAction,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { nowIso, shanghaiClock, shanghaiToday } from '../util';
import { isTradingDay, prevTradingDay } from '../market/calendar';
import { getRegimeSummaryForCockpit } from '../regime/service';
import { budgetForPhase } from '../positions/riskBudget';
import { computePlanFulfillment, getTodayDetail } from '../plan/service';
import { getLatestSnapshotDate, listRecentSnapshots, listSnapshotsByDate } from '../breadth/repo';
import { assessPersistence, stageAction, STAGE_ACTION_LABEL, STAGE_LABEL } from '../breadth/service';
import { getCacheStats } from '../datasource/klineCache';
import { listSources } from '../datasource/registry';
import { evaluateDiscipline } from '../positions/discipline';
import { fetchRealPositions } from '../realPositions';
import { buildRotationOverview } from '../rotation/service';
import { buildDragonOverview } from '../dragon/service';
import { countEtfAlertsToday, listEtfAlerts, listLayerStates } from '../etfwatch/store';
import { getEtfWatchStatus } from '../etfwatch/engine';
import { countAlertsToday, listAlerts } from '../watch/store';
import { getWatchStatus } from '../watch/engine';
import { listModuleJobs } from '../scheduling/moduleScheduler';
import { getUsageSummary } from '../usage';

// 驾驶舱「今日全景」统一读模型：所有总览数字只从这里出，避免同一指标在多个页面各算各的。
//
// 分两层加载，因为「秒开」和「实时」是互相冲突的目标：
//   秒开层 buildPanorama()：纯本地 DB/内存，无任何网络调用，首屏立刻可见。
//   实时层 buildPanoramaLive()：真实持仓、ETF 轮动、龙虎读数等需要外部取数的块，前端并行请求后补位。
// 两层都用 PanoramaBlock 信封（status/note）：取不到数就明说为什么，绝不静默让区块消失。

const TREND_DAYS = 30;
const EQUITY_DAYS = 120;
/** 各清单在驾驶舱的展示上限（密度控制：一屏给结论，明细去下钻页） */
const LIST_CAP = 5;

function ok<T>(data: T): PanoramaBlock<T> {
  return { status: 'ok', data, note: '' };
}
function empty<T>(note: string): PanoramaBlock<T> {
  return { status: 'empty', data: null, note };
}
function failed<T>(e: unknown, what: string): PanoramaBlock<T> {
  return {
    status: 'error',
    data: null,
    note: `${what}取数失败：${e instanceof Error ? e.message : String(e)}`,
  };
}

/** 把任意同步 builder 包成 block，异常自动转为 error 态 */
function guard<T>(what: string, fn: () => PanoramaBlock<T>): PanoramaBlock<T> {
  try {
    return fn();
  } catch (e) {
    return failed(e, what);
  }
}

// ===== 秒开层各块 =====

/** 第1层：情绪当前读数（直读收盘快照，不触发重算） */
function buildSentimentNow(): PanoramaBlock<PanoramaSentimentNow> {
  const rows = db
    .select()
    .from(schema.sentimentSnapshots)
    .orderBy(desc(schema.sentimentSnapshots.tradeDate))
    .limit(2)
    .all();
  if (rows.length === 0) {
    return empty('尚无情绪快照（到调度页启用「情绪收盘快照」，次日起可用）');
  }
  const cur = rows[0];
  const prev = rows[1];
  const delta = prev ? Math.round((cur.indexScore - prev.indexScore) * 10) / 10 : null;
  // advice 未落库，按水位档给确定性白话建议（与情绪页同口径的方向性表述）
  const advice =
    cur.indexScore >= 70
      ? '情绪高位：兑现优先，不追新高'
      : cur.indexScore >= 55
        ? '情绪活跃：可正常出手，回踩买入优于追涨'
        : cur.indexScore >= 40
          ? '情绪平稳：控制仓位，只做最强主线'
          : '情绪低迷：以防守为主，等待转暖信号';
  return ok({
    tradeDate: cur.tradeDate,
    index: Math.round(cur.indexScore * 10) / 10,
    level: cur.level,
    phase: cur.phase,
    delta,
    advice,
  });
}

/** 逐日情绪 + 大盘阶段（一个交易日一个点，hover 可读涨跌停/炸板/红绿家数） */
function buildSentimentTrend(): PanoramaBlock<PanoramaSentimentPoint[]> {
  const sent = db
    .select()
    .from(schema.sentimentSnapshots)
    .orderBy(desc(schema.sentimentSnapshots.tradeDate))
    .limit(TREND_DAYS)
    .all();
  const regimes = new Map(
    db
      .select()
      .from(schema.regimeSnapshots)
      .orderBy(desc(schema.regimeSnapshots.tradeDate))
      .limit(TREND_DAYS)
      .all()
      .map((r) => [r.tradeDate, r]),
  );
  if (sent.length === 0) {
    return empty('尚无情绪快照（到调度页启用「情绪收盘快照」，次日起累积）');
  }
  const points: PanoramaSentimentPoint[] = sent
    .map((s) => {
      let c: SentimentComponents | null = null;
      try {
        c = JSON.parse(s.components) as SentimentComponents;
      } catch {
        c = null;
      }
      const r = regimes.get(s.tradeDate);
      return {
        date: s.tradeDate,
        sentiment: s.indexScore,
        regimeScore: r?.score ?? null,
        phase: (r?.phase as MarketRegimePhase | undefined) ?? null,
        limitUp: c?.limitUp ?? null,
        limitDown: c?.limitDown ?? null,
        brokenRate: c?.brokenRate ?? null,
        advancers: c?.up ?? null,
        decliners: c?.down ?? null,
      };
    })
    .reverse();
  return ok(points);
}

/**
 * 主线生命周期泳道：把最新一份宽度快照按阶段分组。
 * ponytail: 只画「当前阶段的横截面」，不画每个板块的阶段迁移轨迹——
 * 后者要对每个交易日逐板块重算一遍持续性，成本与收益不成比例。升级路径是把 stage 直接落进快照行。
 */
function buildLanes(): PanoramaBlock<PanoramaLane[]> {
  const date = getLatestSnapshotDate();
  if (!date) {
    return empty('尚无板块宽度快照（到调度页启用「板块新高宽度收盘快照」，次日起可用）');
  }
  const rows = listSnapshotsByDate(date);
  if (rows.length === 0) return empty(`${date} 无板块宽度数据`);
  const hist = listRecentSnapshots(date, 5);
  const byBoard = new Map<string, typeof hist>();
  for (const h of hist) {
    const arr = byBoard.get(h.boardCode) ?? [];
    arr.push(h);
    byBoard.set(h.boardCode, arr);
  }
  for (const arr of byBoard.values()) arr.sort((a, b) => (a.tradeDate < b.tradeDate ? 1 : -1));

  const order: BoardMainlineStage[] = ['advancing', 'brewing', 'diverging', 'fading'];
  const lanes = new Map<BoardMainlineStage, PanoramaLane>();
  for (const stage of order) {
    // 泳道动作直接由阶段唯一决定（stageAction 的硬路由）。原先在循环里按每个板块回写，
    // 泳道动作会变成「该阶段最后遍历到的那个板块」的动作，而 items 随后又按新高数重排，
    // focus 结论带就会把 B 板块的动作安到 A 板块头上。
    lanes.set(stage, { stage, action: stageAction(stage) as BoardStageAction, items: [] });
  }
  for (const r of rows) {
    const p = assessPersistence(
      r.rank,
      r.newHighCount,
      r.ratio,
      byBoard.get(r.boardCode) ?? [],
      r.coreCodes,
      date,
    );
    const lane = lanes.get(p.stage);
    if (!lane) continue; // stage=none 不入泳道
    lane.items.push({
      board: r.boardName,
      boardCode: r.boardCode,
      newHighCount: r.newHighCount,
      topDays: p.topDays,
      etf: null,
    });
  }
  for (const lane of lanes.values()) {
    lane.items.sort((a, b) => b.newHighCount - a.newHighCount);
    lane.items = lane.items.slice(0, 8);
  }
  return ok([...lanes.values()]);
}

/** 计划项的触发价文本：买入看 buyTrigger，减/卖看 sellTrigger，缺失退回止损位 */
function triggerText(it: {
  direction: string;
  buyTrigger: { value: number } | null;
  sellTrigger: { value: number } | null;
  stopLoss: { value: number } | null;
}): string {
  const isBuy = it.direction === 'buy' || it.direction === 'add';
  const t = isBuy ? it.buyTrigger : it.sellTrigger;
  if (t) return `${isBuy ? '触发' : '离场'} ${t.value}`;
  if (it.stopLoss) return `止损 ${it.stopLoss.value}`;
  return '—';
}

/** 第2层：今日计划的具体操作清单（哪只、什么价、什么动作、到哪一步了） */
function buildPlanActions(): PanoramaBlock<PanoramaPlanAction[]> {
  const detail = getTodayDetail();
  if (!detail) return empty('今日暂无计划（盘前生成任务未运行）');
  if (detail.items.length === 0) return empty('今日计划无标的');
  // 待触发优先、其次已触发，已完成/失效排后；同组按置信度降序
  const rank: Record<string, number> = { pending: 0, triggered: 1, done: 2, invalid: 3 };
  const items = [...detail.items]
    .sort(
      (a, b) =>
        (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || (b.confidence ?? 0) - (a.confidence ?? 0),
    )
    .slice(0, LIST_CAP)
    .map((it) => ({
      code: it.code,
      name: it.name,
      direction: it.direction,
      // 按方向取对应触发价：买入看 buyTrigger，减/卖看 sellTrigger，都没有则退回止损位
      trigger: triggerText(it),
      status: it.status,
      confidence: it.confidence ?? null,
      assetType: it.assetType,
    }));
  return ok(items);
}

/** 第3层：ETF 多周期盯盘（层级 + 最近动作建议）。这是实际买卖扳机，必须上一屏。 */
function buildEtfWatch(): PanoramaBlock<PanoramaEtfWatch> {
  const states = listLayerStates();
  const alerts = listEtfAlerts(30, false);
  const lastByCode = new Map<string, (typeof alerts)[number]>();
  for (const a of alerts) if (!lastByCode.has(a.code)) lastByCode.set(a.code, a);

  const status = getEtfWatchStatus();
  if (states.length === 0 && alerts.length === 0) {
    return empty(
      status.enabled ? 'ETF 盯盘已启用但尚无分层记录（等待首次信号）' : 'ETF 多周期盯盘未启用',
    );
  }
  const items = states
    .map((s) => {
      const last = lastByCode.get(s.code);
      return {
        code: s.code,
        name: s.name,
        heldLayers: s.heldLayers as number[],
        trendStage: s.trendStage ?? null,
        lastAction: last?.instruction?.action ?? last?.verdict ?? last?.signalType ?? null,
        lastAt: last?.createdAt ?? null,
      };
    })
    .sort((a, b) => b.heldLayers.length - a.heldLayers.length)
    .slice(0, LIST_CAP);
  return ok({ running: status.running, alertsToday: countEtfAlertsToday(), items });
}

/** 第3层：个股盯盘（仅建议未成交的告警在自动成交流里看不见，必须单列） */
function buildStockWatch(): PanoramaBlock<PanoramaStockWatch> {
  const status = getWatchStatus();
  const alerts = listAlerts(20)
    .filter((a) => a.shouldAlert)
    .slice(0, LIST_CAP)
    .map((a) => ({
      code: a.code,
      name: a.name,
      severity: a.severity,
      advice: a.adviceText || a.detail,
      at: a.createdAt,
    }));
  if (!status.enabled && alerts.length === 0) return empty('实时盯盘未启用');
  return ok({
    running: status.running,
    inSession: status.inSession,
    alertsToday: countAlertsToday(),
    lastSignalCount: status.lastSignalCount,
    alerts,
  });
}

/** 账户逐日表现：由日终归因的当日贡献累乘成净值曲线（同时供日历热力使用） */
function buildEquity(): PanoramaBlock<PanoramaEquityPoint[]> {
  const rows = db
    .select({
      date: schema.positionAttributions.date,
      contribution: sql<number>`sum(${schema.positionAttributions.contribution})`,
    })
    .from(schema.positionAttributions)
    .groupBy(schema.positionAttributions.date)
    .orderBy(desc(schema.positionAttributions.date))
    .limit(EQUITY_DAYS)
    .all();
  if (rows.length === 0) {
    return empty('尚无日终归因数据（到调度页启用「持仓归因收盘快照」，次日起累积）');
  }
  let nav = 1;
  const points = rows
    .slice()
    .reverse()
    .map((r) => {
      const dayPct = Math.round((r.contribution ?? 0) * 10000) / 100;
      nav *= 1 + (r.contribution ?? 0);
      return { date: r.date, dayPct, nav: Math.round(nav * 10000) / 10000 };
    });
  return ok(points);
}

/** 系统健康矩阵：数据源 + 日K缓存 + 快照新鲜度 + 定时/花费/盯盘引擎，一格一色替代散落各页的降级文案 */
function buildHealth(): PanoramaBlock<PanoramaHealthCell[]> {
  // 新鲜度基准取「最近一个已收盘的交易日」而不是自然日：拿自然日比，周末与节假日必然全黄，
  // 会把用户训练成「黄灯是常态」，真出问题时反而看不见。收盘前的当日快照本就还没产出，
  // 故当日未收盘时也以上一交易日为准。
  const now = new Date();
  const today = shanghaiToday(now);
  const closed = isTradingDay(now) && shanghaiClock(now) >= '15:00';
  const freshDate = closed ? today : prevTradingDay(today);
  const cells: PanoramaHealthCell[] = [];

  const sources = listSources();
  const enabled = sources.filter((s) => s.enabled);
  const notReady = enabled.filter((s) => !s.ready);
  cells.push({
    key: 'datasource',
    label: '数据源',
    status: notReady.length === 0 ? 'ok' : notReady.length < 3 ? 'warn' : 'down',
    detail:
      notReady.length === 0
        ? `${enabled.length} 个启用 · 凭据均已就绪`
        : `${notReady.length}/${enabled.length} 个待配置：${notReady.slice(0, 3).map((s) => s.name).join('、')}`,
  });

  const kc = getCacheStats();
  cells.push({
    key: 'kline',
    label: '日K缓存',
    status: kc.codeCount === 0 ? 'down' : (kc.latestDate ?? '') >= freshDate ? 'ok' : 'warn',
    detail:
      kc.codeCount === 0
        ? '尚未预热（到数据源页点「立即预热」或启用 09:10 定时）'
        : `覆盖 ${kc.codeCount} 只 · 最新 ${kc.latestDate ?? '—'} · 复权基准 ${kc.adjBase || '—'}`,
  });

  const snapshotAge = (
    key: string,
    label: string,
    latest: string | null,
    hint: string,
  ): PanoramaHealthCell => ({
    key,
    label,
    status: latest == null ? 'down' : latest >= freshDate ? 'ok' : 'warn',
    detail:
      latest == null
        ? hint
        : `最新 ${latest}${latest >= freshDate ? '' : `（滞后于最近交易日 ${freshDate}）`}`,
  });

  cells.push(
    snapshotAge('breadth', '板块宽度', getLatestSnapshotDate(), '尚无快照，到调度页启用收盘快照'),
  );
  cells.push(
    snapshotAge(
      'sentiment',
      '市场情绪',
      db
        .select({ d: schema.sentimentSnapshots.tradeDate })
        .from(schema.sentimentSnapshots)
        .orderBy(desc(schema.sentimentSnapshots.tradeDate))
        .limit(1)
        .get()?.d ?? null,
      '尚无快照，到调度页启用情绪收盘快照',
    ),
  );
  cells.push(
    snapshotAge(
      'regime',
      '大盘阶段',
      db
        .select({ d: schema.regimeSnapshots.tradeDate })
        .from(schema.regimeSnapshots)
        .orderBy(desc(schema.regimeSnapshots.tradeDate))
        .limit(1)
        .get()?.d ?? null,
      '尚无快照，到调度页启用大盘阶段收盘快照',
    ),
  );

  // 盯盘引擎：两个引擎各自的启用/运行态合成一格（关着不算故障，只是提示）
  const w = getWatchStatus();
  const ew = getEtfWatchStatus();
  const engineOn = [w.enabled ? '个股盯盘' : null, ew.enabled ? 'ETF盯盘' : null].filter(Boolean);
  cells.push({
    key: 'watch-engine',
    label: '盯盘引擎',
    status: engineOn.length === 0 ? 'warn' : w.enabled && !w.running ? 'down' : 'ok',
    detail:
      engineOn.length === 0
        ? '两个盯盘引擎均未启用'
        : `${engineOn.join(' + ')} 已启用 · 今日告警 ${countAlertsToday() + countEtfAlertsToday()} 条`,
  });

  // 下一次定时跑什么：只看已启用的模块定时，取最近的一个
  const nextJob = listModuleJobs()
    .filter((j) => j.enabled && j.nextRunAt)
    .sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)))[0];
  cells.push({
    key: 'schedule',
    label: '下一次定时',
    status: nextJob ? 'ok' : 'warn',
    detail: nextJob
      ? `${nextJob.label} · ${String(nextJob.nextRunAt).slice(5, 16).replace('T', ' ')}`
      : '无已启用的模块定时任务',
  });

  // 今日 AI 调用：花费无从直接取，用调用次数与 token 量代表
  const usage = getUsageSummary(1);
  cells.push({
    key: 'usage',
    label: '今日AI调用',
    status: 'ok',
    detail: `${usage.totals.calls} 次 · ${Math.round(usage.totals.totalTokens / 1000)}k tokens${
      usage.totals.successRate != null ? ` · 成功率 ${usage.totals.successRate}%` : ''
    }`,
  });

  return ok(cells);
}

/** 组装今日全景·秒开层（全部本地读取，无网络调用） */
export function buildPanorama(): CockpitPanorama {
  const regime = getRegimeSummaryForCockpit();
  const budget = budgetForPhase(regime?.phase ?? null);
  const planDetail = getTodayDetail();

  const canTrade: PanoramaBlock<PanoramaCanTrade> = ok({
    phase: regime?.phase ?? null,
    score: regime?.score ?? null,
    singleTradeRiskPct: budget.singleTradeRiskPct,
    totalMaxPositionPct: budget.totalMaxPositionPct,
    conclusion:
      regime == null
        ? '大盘阶段无快照，按最紧的震荡档执行'
        : `明日倾向${regime.tomorrowBias} · 建议交易${regime.suggestedFrequency} · 已持续 ${regime.consecutiveDays} 日` +
          `｜单笔风险预算 ${budget.singleTradeRiskPct}%，总仓上限 ${budget.totalMaxPositionPct}%`,
  });

  const items = planDetail?.items ?? [];
  const pending = items.filter((i) => i.status === 'pending').length;
  const invalid = items.filter((i) => i.status === 'invalid').length;
  const hit = computePlanFulfillment(planDetail);
  const todo: PanoramaBlock<PanoramaTodo> = planDetail
    ? ok({
        planPending: pending,
        planInvalid: invalid,
        conclusion:
          (pending === 0 && invalid === 0
            ? '今日计划无待触发项'
            : `${pending} 个计划标的待触发${invalid > 0 ? `，${invalid} 个已失效`  : ''}`) +
          (hit?.hitRate != null
            ? `｜兑现率 ${(hit.hitRate * 100).toFixed(0)}%（${hit.done}/${hit.total} 完成）`
            : ''),
      })
    : empty('今日暂无计划（盘前生成任务未运行）');

  const lanes = guard('主线泳道', buildLanes);
  const topLane = lanes.data?.find((l) => l.items.length > 0) ?? null;
  const focus: PanoramaBlock<PanoramaFocus> = topLane
    ? ok({
        board: topLane.items[0].board,
        stage: topLane.stage,
        action: topLane.action,
        etf: topLane.items[0].etf,
        conclusion:
          `${topLane.items[0].board}｜${STAGE_LABEL[topLane.stage]} → ${STAGE_ACTION_LABEL[topLane.action]}` +
          `（新高 ${topLane.items[0].newHighCount} 只·居首 ${topLane.items[0].topDays} 日）`,
      })
    : { status: lanes.status, data: null, note: lanes.note || '当前无任何达标主线' };

  return {
    asOf: nowIso(),
    tradeDate: shanghaiToday(),
    canTrade,
    focus,
    todo,
    sentimentNow: guard('情绪读数', buildSentimentNow),
    sentimentTrend: guard('情绪趋势', buildSentimentTrend),
    lanes,
    planActions: guard('计划清单', buildPlanActions),
    etfWatch: guard('ETF盯盘', buildEtfWatch),
    stockWatch: guard('个股盯盘', buildStockWatch),
    equity: guard('账户净值', buildEquity),
    health: guard('系统健康', buildHealth),
  };
}

// ===== 实时层各块 =====

async function buildAccount(): Promise<PanoramaBlock<PanoramaAccount>> {
  try {
    const pf = await fetchRealPositions();
    const positionPct = pf.totalAsset > 0 ? (pf.totalMarketValue / pf.totalAsset) * 100 : 0;
    // 分母是「今日开盘时的资产」，全仓一字板等极端情形下它可能为 0，不能只靠 totalAsset>0 兜底
    const openAsset = pf.totalAsset - pf.totalTodayProfit;
    const todayRate = openAsset !== 0 ? (pf.totalTodayProfit / openAsset) * 100 : 0;
    return ok({
      totalAsset: Math.round(pf.totalAsset),
      cash: Math.round(pf.cash),
      positionPct: Math.round(positionPct * 10) / 10,
      todayProfit: Math.round(pf.totalTodayProfit),
      todayRate: Math.round(todayRate * 100) / 100,
      positionCount: pf.positions.length,
    });
  } catch (e) {
    return failed(e, '真实账户');
  }
}

async function buildDisciplineSummary(): Promise<PanoramaBlock<PanoramaDisciplineSummary>> {
  try {
    const r = await evaluateDiscipline();
    const items = r.items
      .filter((i) => i.status !== 'healthy')
      .slice(0, LIST_CAP)
      .map((i) => ({
        code: i.code,
        name: i.name,
        status: i.status,
        // 有具体减仓股数时优先给股数，其余给 advice 首句——一屏只放能直接照做的那句
        action:
          i.sizing && i.sizing.reduceShares > 0
            ? `建议减 ${i.sizing.reduceShares} 股（上限 ${i.sizing.allowedShares} 股）`
            : i.advice.split('；')[0],
      }));
    return ok({
      stopLoss: r.counts.stopLoss,
      takeProfit: r.counts.takeProfit,
      overweight: r.counts.overweight,
      stopNotExecuted: r.counts.stopNotExecuted,
      healthy: r.counts.healthy,
      totalPositionPct: Math.round(r.account.totalPositionRate * 1000) / 10,
      totalMaxPositionPct: r.account.totalMaxPositionPct,
      warnings: r.account.warnings,
      items,
    });
  } catch (e) {
    return failed(e, '持仓纪律');
  }
}

async function buildRotation(): Promise<PanoramaBlock<PanoramaRotationItem[]>> {
  try {
    const ov = await buildRotationOverview();
    const items = ov.items.slice(0, 3).map((i) => ({
      code: i.code,
      name: i.name,
      track: i.track,
      state: i.state,
      score: i.score,
      rs: i.rs,
    }));
    if (items.length === 0) return empty('ETF 轮动榜为空（跟踪池未配置或取数降级）');
    return ok(items);
  } catch (e) {
    return failed(e, 'ETF轮动');
  }
}

async function buildDragon(): Promise<PanoramaBlock<PanoramaDragonRead>> {
  try {
    const ov = await buildDragonOverview();
    return ok({
      maxStreak: ov.maxStreak,
      limitUpCount: ov.limitUpCount,
      brokenRate: ov.brokenRate,
      topDragon: ov.topDragon ? `${ov.topDragon.name}（${ov.topDragon.streak}板）` : null,
    });
  } catch (e) {
    return failed(e, '涨停梯队');
  }
}

/** 组装今日全景·实时层（各块并行且独立降级，任一失败不影响其余） */
export async function buildPanoramaLive(): Promise<CockpitPanoramaLive> {
  const [account, discipline, rotation, dragon] = await Promise.all([
    buildAccount(),
    buildDisciplineSummary(),
    buildRotation(),
    buildDragon(),
  ]);
  return { asOf: nowIso(), account, discipline, rotation, dragon };
}
