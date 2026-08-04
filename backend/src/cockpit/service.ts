import { desc, gte, sql } from 'drizzle-orm';
import type {
  CockpitEvent,
  CockpitModuleSummary,
  CockpitOverview,
  CockpitScreenerPick,
  DecisionVerdictCache,
  DisciplineEvent,
  MarketReviewResult,
  PlanItemStatus,
  SimTrade,
  WatchAlert,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { nowIso, shanghaiToday } from '../util';
import { getSafetyState } from '../safety/guard';
import { getTodayDetail, computePlanFulfillment } from '../plan/service';
import { listThemes } from '../themes/service';
import { getRegimeSummaryForCockpit } from '../regime/service';
import { getMoneyEffectSummary } from '../moneyeffect/service';
import { listVerdicts } from '../decision/verdictCache';
import { listDisciplineEvents } from '../positions/discipline';
import { listAlerts } from '../watch/store';
import {
  listEtfAnalyzeReviews,
  listIntelReviews,
  listMarketBoardReviews,
  listReviews,
} from '../repo';
import { listRuns as listScreenRuns, getRunDetail as getScreenRunDetail } from '../screener/repo';
import { countEtfAlertsToday, listEtfAlerts, listLayerStates } from '../etfwatch/store';
import { countAlertsToday } from '../watch/store';
import { listModes as listResearchModes, latestDaily as latestModeDaily } from '../modes/repo';

// 驾驶舱聚合：纯只读、仅本地 DB 读取（不触发取数 / 不调 LLM / 不下单），保证一屏概览秒开。
// 事件时间线把「持仓纪律 / 模拟成交 / 盯盘告警 / 决策研判」四类已落库事件合并按时间倒序，
// 跨模块呈现近期动作；各模块详情仍在各自页面。

const ACTION_LABEL: Record<DecisionVerdictCache['action'], string> = {
  buy: '买入',
  add: '加仓',
  hold: '持有',
  reduce: '减仓',
  sell: '卖出',
};

function disciplineSeverity(s: DisciplineEvent['severity']): CockpitEvent['severity'] {
  return s === 'high' ? 'high' : s === 'medium' ? 'warn' : 'info';
}

function watchSeverity(s: WatchAlert['severity']): CockpitEvent['severity'] {
  return s === 'high' ? 'high' : s === 'medium' ? 'warn' : 'info';
}

function disciplineEvents(limit: number): CockpitEvent[] {
  return listDisciplineEvents(limit).map((e) => ({
    id: `discipline:${e.id}`,
    at: e.createdAt,
    kind: 'discipline' as const,
    severity: disciplineSeverity(e.severity),
    title: `持仓纪律 · ${e.name || e.code}`,
    detail: e.detail,
    code: e.code,
    name: e.name,
  }));
}

function watchEvents(limit: number): CockpitEvent[] {
  // 仅纳入终审值得提醒的告警，避免沉默告警刷屏
  return listAlerts(limit)
    .filter((a) => a.shouldAlert)
    .map((a) => ({
      id: `watch:${a.id}`,
      at: a.createdAt,
      kind: 'watch' as const,
      severity: watchSeverity(a.severity),
      title: `盯盘告警 · ${a.name || a.code}${a.verdict ? `（${a.verdict}）` : ''}`,
      detail: a.adviceText || a.detail,
      code: a.code,
      name: a.name,
    }));
}

function decisionEvents(limit: number): CockpitEvent[] {
  return listVerdicts(undefined, limit).map((v) => ({
    id: `decision:${v.code}:${v.scenario}:${v.horizon}`,
    at: v.dataAsOf,
    kind: 'decision' as const,
    severity: v.action === 'sell' || v.action === 'reduce' ? 'warn' : 'info',
    title: `研判 · ${v.name || v.code}（${ACTION_LABEL[v.action]}/${v.confidence}分）`,
    detail: v.invalidators[0] ?? `${ACTION_LABEL[v.action]}，置信度 ${v.confidence}`,
    code: v.code,
    name: v.name,
  }));
}

function tradeEvents(limit: number): CockpitEvent[] {
  const rows = db
    .select()
    .from(schema.simTrades)
    .orderBy(desc(schema.simTrades.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200))
    .all() as SimTrade[];
  return rows.map((t) => {
    const profit =
      t.side === 'sell' && t.realizedProfit != null
        ? `，已实现 ${t.realizedProfit > 0 ? '+' : ''}${Math.round(t.realizedProfit)}`
        : '';
    return {
      id: `trade:${t.id}`,
      at: t.createdAt,
      kind: 'trade' as const,
      severity: 'info' as const,
      title: `模拟${t.side === 'buy' ? '买入' : '卖出'} · ${t.name || t.code}`,
      detail: `${t.qty} 股 @ ${t.price}（${t.source}）${profit}`,
      code: t.code,
      name: t.name,
      // 非手动来源（cron/agent/watch）即自动成交，前端打「自动」徽标
      auto: t.source !== 'manual',
    };
  });
}

// 今日计划标的状态 → 计划事件（确定性派生，时间取标的最近状态变更 updatedAt）：
// 已触发/已完成（命中）、已失效（逻辑被破），收盘后把仍 pending 的标记「未执行」（盘中不计，避免刷屏）。
// 直接回应「计划兑现度数据已算但时间线没体现」——把计划 vs 执行的偏离呈现在驾驶舱一屏。
const PLAN_STATUS_META: Record<
  Exclude<PlanItemStatus, 'pending'>,
  { label: string; severity: CockpitEvent['severity'] }
> = {
  triggered: { label: '已触发', severity: 'info' },
  done: { label: '已完成', severity: 'info' },
  invalid: { label: '已失效', severity: 'warn' },
};

function planEvents(): CockpitEvent[] {
  const detail = getTodayDetail();
  if (!detail) return [];
  const closed = detail.plan.status === 'closed';
  const events: CockpitEvent[] = [];
  for (const it of detail.items) {
    let label: string;
    let severity: CockpitEvent['severity'];
    if (it.status === 'pending') {
      if (!closed) continue; // 盘中待触发不算事件
      label = '未执行';
      severity = 'info';
    } else {
      ({ label, severity } = PLAN_STATUS_META[it.status]);
    }
    events.push({
      id: `plan:${it.id}`,
      at: it.updatedAt,
      kind: 'plan',
      severity,
      title: `计划 · ${it.name || it.code}（${label}）`,
      detail: it.lastNote || it.thesis || `计划项${label}`,
      code: it.code,
      name: it.name,
    });
  }
  return events;
}

/** 合并五类事件（持仓纪律/盯盘/研判/模拟成交/今日计划），按时间倒序取前 limit 条 */
export function buildTimeline(limit = 40): CockpitEvent[] {
  const per = Math.min(Math.max(limit, 1), 100);
  const merged = [
    ...disciplineEvents(per),
    ...watchEvents(per),
    ...decisionEvents(per),
    ...tradeEvents(per),
    ...planEvents(),
  ];
  merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return merged.slice(0, per);
}

// ===== 模块总结卡 =====

/** 抽取首个完整 JSON 对象（仅一键复盘结构化输出用），失败返回 null */
function parseJsonObject<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** 取正文首段（按空行/换行切），并截断，作为卡片摘要 */
function firstParagraph(text: string, max = 140): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const para = trimmed.split(/\n\s*\n|\n/).map((s) => s.trim()).find((s) => s.length > 0) ?? trimmed;
  return para.length <= max ? para : `${para.slice(0, max)}…`;
}

/**
 * 模块卡来源注册表。两种来源二选一：
 *   latest —— AI 产出型（取最近一次落库正文，抽首段作摘要）；
 *   build  —— 状态型（自己算出 headline/excerpt，供无 AI 正文的确定性域使用）。
 *
 * 之前只支持 latest，导致 ETF 盯盘、持仓纪律、情绪这些没有 AI 正文的域即使有产出也永远进不了驾驶舱。
 * 新增域只需往本数组加一项，不必改 buildModuleSummaries。
 */
interface ModuleSource {
  key: string;
  title: string;
  route: string;
  routeQuery?: Record<string, string>;
  latest?: () => { createdAt: string | null; outputText: string | null } | undefined;
  /** 一键复盘为结构化 JSON，取 comprehensiveStance 作 headline */
  structured?: boolean;
  /** 状态型来源：直接产出卡片内容；返回 null 表示该域当前无内容 */
  build?: () => { headline: string; excerpt: string; createdAt: string | null } | null;
}

/** 今日（Asia/Shanghai）起始时刻的 ISO，用于「今日新增」类计数 */
function todayStartIso(): string {
  return `${shanghaiToday()}T00:00:00`;
}

const MODULE_SOURCES: ModuleSource[] = [
  { key: 'intel', title: '情报研判', route: '/intel', latest: () => listIntelReviews(1)[0] },
  { key: 'market-board', title: '大盘与板块研判', route: '/market', latest: () => listMarketBoardReviews(1)[0] },
  { key: 'etf', title: 'ETF 综合研判', route: '/etf', latest: () => listEtfAnalyzeReviews(1)[0] },
  {
    key: 'review',
    title: '一键复盘',
    route: '/review',
    structured: true,
    latest: () => listReviews(3).find((r) => r.outputText),
  },
  {
    key: 'etf-watch',
    title: 'ETF 多周期盯盘',
    route: '/etf-watch',
    build: () => {
      const states = listLayerStates();
      const alerts = listEtfAlerts(1, false);
      if (states.length === 0 && alerts.length === 0) return null;
      const held = states.filter((s) => s.heldLayers.length > 0);
      return {
        headline: `${held.length} 只在层 · 今日告警 ${countEtfAlertsToday()} 条`,
        excerpt: held.length
          ? held
              .slice(0, 3)
              .map((s) => `${s.name} L${s.heldLayers.join('/')}`)
              .join('；')
          : '暂无持层标的，等待首层触发',
        createdAt: alerts[0]?.createdAt ?? states[0]?.updatedAt ?? null,
      };
    },
  },
  {
    key: 'watch',
    title: '实时盯盘',
    route: '/watch',
    build: () => {
      const alerts = listAlerts(3).filter((a) => a.shouldAlert);
      const n = countAlertsToday();
      if (n === 0 && alerts.length === 0) return null;
      return {
        headline: `今日告警 ${n} 条`,
        excerpt: alerts[0] ? `${alerts[0].name}：${alerts[0].adviceText || alerts[0].detail}` : '今日无需提醒的告警',
        createdAt: alerts[0]?.createdAt ?? null,
      };
    },
  },
  {
    key: 'discipline',
    title: '持仓纪律',
    route: '/positions',
    build: () => {
      const events = listDisciplineEvents(20);
      const today = shanghaiToday();
      const todays = events.filter((e) => e.createdAt.slice(0, 10) === today);
      if (events.length === 0) return null;
      const high = todays.filter((e) => e.severity === 'high').length;
      return {
        headline: todays.length === 0 ? '今日无新纪律事件' : `今日 ${todays.length} 条（高危 ${high}）`,
        excerpt: events[0].detail,
        createdAt: events[0].createdAt,
      };
    },
  },
  {
    key: 'sentiment',
    title: '市场情绪',
    route: '/market',
    routeQuery: { tab: 'sentiment' },
    build: () => {
      const row = db
        .select()
        .from(schema.sentimentSnapshots)
        .orderBy(desc(schema.sentimentSnapshots.tradeDate))
        .limit(1)
        .get();
      if (!row) return null;
      return {
        headline: `情绪 ${Math.round(row.indexScore)} · ${row.level} · ${row.phase}`,
        excerpt: `最高连板 ${row.maxStreak ?? '—'} · 活跃度 ${row.activity ?? '—'}%`,
        createdAt: row.updatedAt,
      };
    },
  },
  {
    key: 'modes',
    title: '模式跟踪',
    route: '/modes',
    build: () => {
      const followed = listResearchModes().filter((m) => m.followed);
      if (followed.length === 0) return null;
      const lines = followed
        .slice(0, 3)
        .map((m) => {
          const d = latestModeDaily(m.id);
          return d ? `${m.name} ${fmtPctSigned(d.cumReturn)}` : `${m.name} 待跟踪`;
        });
      const newest = followed
        .map((m) => latestModeDaily(m.id)?.date ?? null)
        .filter((d): d is string => !!d)
        .sort()
        .pop();
      return {
        headline: `${followed.length} 个关注中`,
        excerpt: lines.join('；'),
        createdAt: newest ? `${newest}T15:10:00` : null,
      };
    },
  },
  {
    key: 'kol',
    title: '大V观点',
    route: '/kol',
    build: () => {
      const start = todayStartIso();
      const n = db
        .select({ n: sql<number>`count(*)` })
        .from(schema.kolPosts)
        .where(gte(schema.kolPosts.createdAt, start))
        .get()?.n ?? 0;
      const latest = db
        .select()
        .from(schema.kolPosts)
        .orderBy(desc(schema.kolPosts.createdAt))
        .limit(1)
        .get();
      if (!latest) return null;
      return {
        headline: `今日 ${n} 条更新`,
        excerpt: `${latest.screenName}：${latest.text.slice(0, 60)}`,
        createdAt: latest.createdAt,
      };
    },
  },
];

/** 收益率格式化（小数 → 带符号百分比） */
function fmtPctSigned(v: number | null | undefined): string {
  if (v == null) return '—';
  const p = v * 100;
  return `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
}

/** 构建各模块最新产出摘要卡（纯本地读取已落库产出，不重算） */
export function buildModuleSummaries(): CockpitModuleSummary[] {
  const today = shanghaiToday();
  const cards: CockpitModuleSummary[] = [];
  for (const m of MODULE_SOURCES) {
    // 状态型来源：自带 headline/excerpt，无 AI 正文可抽
    if (m.build) {
      const built = (() => {
        try {
          return m.build!();
        } catch {
          return null;
        }
      })();
      cards.push({
        key: m.key,
        title: m.title,
        route: m.route,
        routeQuery: m.routeQuery,
        headline: built?.headline ?? '',
        excerpt: built?.excerpt ?? '暂无产出（该模块未启用或尚未运行）',
        createdAt: built?.createdAt ?? null,
        stale: built?.createdAt ? built.createdAt.slice(0, 10) !== today : true,
      });
      continue;
    }
    const row = m.latest?.();
    const createdAt = row?.createdAt ?? null;
    const stale = createdAt ? createdAt.slice(0, 10) !== today : true;
    if (!row?.outputText) {
      cards.push({
        key: m.key,
        title: m.title,
        route: m.route,
        routeQuery: m.routeQuery,
        headline: '',
        excerpt: '暂无持久化产出（对应分析未运行或未产出）',
        createdAt: null,
        stale: true,
      });
      continue;
    }
    let headline = '';
    let excerpt = '';
    if (m.structured) {
      const obj = parseJsonObject<Partial<MarketReviewResult>>(row.outputText);
      const cs = obj?.comprehensiveStance;
      if (cs) {
        headline = cs.bias ? `综合方向：${cs.bias}` : '';
        excerpt = cs.summary ?? '';
      }
      if (!excerpt) excerpt = firstParagraph(row.outputText);
    } else {
      excerpt = firstParagraph(row.outputText);
    }
    cards.push({
      key: m.key,
      title: m.title,
      route: m.route,
      routeQuery: m.routeQuery,
      headline,
      excerpt: excerpt || '（产出为空）',
      createdAt,
      stale,
    });
  }

  // 今日计划卡
  const detail = getTodayDetail();
  if (detail) {
    const cs = detail.plan.marketStance;
    cards.push({
      key: 'plan',
      title: '今日计划',
      route: '/plan',
      headline: cs?.bias ? `定调：${cs.bias}${cs.positionPct != null ? ` · 仓位${cs.positionPct}%` : ''}` : '',
      excerpt: cs?.summary || `${detail.items.length} 个标的`,
      createdAt: detail.plan.createdAt,
      stale: detail.plan.planDate !== today,
    });
  } else {
    cards.push({
      key: 'plan',
      title: '今日计划',
      route: '/plan',
      headline: '',
      excerpt: '今日暂无计划（盘前生成任务未运行）',
      createdAt: null,
      stale: true,
    });
  }

  // 选股卡
  const latestRun = listScreenRuns(1)[0];
  if (latestRun) {
    cards.push({
      key: 'screener',
      title: '系统选股',
      route: '/screener',
      headline: `${latestRun.strategyName} · Top${latestRun.topN}`,
      excerpt: latestRun.selectionLogic || `全市场 ${latestRun.marketCount} → 硬筛 ${latestRun.filteredCount} → 入选 ${latestRun.topN}`,
      createdAt: latestRun.createdAt,
      stale: latestRun.createdAt.slice(0, 10) !== today,
    });
  } else {
    cards.push({
      key: 'screener',
      title: '系统选股',
      route: '/screener',
      headline: '',
      excerpt: '暂无选股运行',
      createdAt: null,
      stale: true,
    });
  }

  return cards;
}

/** 最新一次选股运行的精简候选（前 N 条），供驾驶舱速览 */
export function buildScreenerPicks(limit = 6): CockpitScreenerPick[] {
  const latestRun = listScreenRuns(1)[0];
  if (!latestRun) return [];
  const detail = getScreenRunDetail(latestRun.id);
  if (!detail) return [];
  return detail.picks.slice(0, limit).map((p) => ({
    rank: p.rank,
    code: p.code,
    name: p.name,
    screenScore: Math.round(p.screenScore),
    confidence: p.confidence ?? null,
    thesis: p.thesis ?? null,
  }));
}

/** 驾驶舱一屏概览（全部本地 DB 读取，秒开） */
export function buildCockpitOverview(): CockpitOverview {
  const detail = getTodayDetail();
  // 主线取自 market_themes（含 boardCode/phase/strength），与板块作战台/主线共识同源，
  // 故三处按 boardCode 对齐时阶段/强度天然一致；此处保持纯本地 DB 读，不引入 breadth 取数破坏秒开。
  const themes = listThemes(false)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 6);
  const stance = detail?.plan.marketStance ?? null;
  return {
    asOf: nowIso(),
    safety: getSafetyState(),
    // 大盘阶段：读最近一次收盘快照（纯本地，秒开）；完整明细在大盘页实时接口
    regime: getRegimeSummaryForCockpit(),
    // 首板赚钱效应(883994)：读最近一次 meta 快照（纯本地，秒开）；完整趋势在大盘页情绪 tab
    moneyEffect: getMoneyEffectSummary(),
    plan: computePlanFulfillment(detail),
    planStance: detail
      ? {
          status: detail.plan.status,
          bias: stance?.bias ?? null,
          positionPct: stance?.positionPct ?? null,
          summary: stance?.summary ?? '',
        }
      : null,
    themes,
    modules: buildModuleSummaries(),
    screenerPicks: buildScreenerPicks(6),
    events: buildTimeline(40),
  };
}
