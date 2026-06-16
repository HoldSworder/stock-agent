import { desc } from 'drizzle-orm';
import type {
  CockpitEvent,
  CockpitModuleSummary,
  CockpitOverview,
  CockpitScreenerPick,
  DecisionVerdictCache,
  DisciplineEvent,
  MarketReviewResult,
  SimTrade,
  WatchAlert,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { nowIso, shanghaiToday } from '../util';
import { getSafetyState } from '../safety/guard';
import { getTodayDetail, computePlanFulfillment } from '../plan/service';
import { listThemes } from '../themes/service';
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
    };
  });
}

/** 合并四类事件，按时间倒序取前 limit 条 */
export function buildTimeline(limit = 40): CockpitEvent[] {
  const per = Math.min(Math.max(limit, 1), 100);
  const merged = [
    ...disciplineEvents(per),
    ...watchEvents(per),
    ...decisionEvents(per),
    ...tradeEvents(per),
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

interface ModuleSource {
  key: string;
  title: string;
  route: string;
  routeQuery?: Record<string, string>;
  latest: () => { createdAt: string | null; outputText: string | null } | undefined;
  /** 一键复盘为结构化 JSON，取 comprehensiveStance 作 headline */
  structured?: boolean;
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
];

/** 构建各模块最新产出摘要卡（纯本地读取已落库产出，不重算） */
export function buildModuleSummaries(): CockpitModuleSummary[] {
  const today = shanghaiToday();
  const cards: CockpitModuleSummary[] = [];
  for (const m of MODULE_SOURCES) {
    const row = m.latest();
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
  const themes = listThemes(false)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 6);
  const stance = detail?.plan.marketStance ?? null;
  return {
    asOf: nowIso(),
    safety: getSafetyState(),
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
