import { desc } from 'drizzle-orm';
import type {
  CockpitEvent,
  CockpitOverview,
  DecisionVerdictCache,
  DisciplineEvent,
  SimTrade,
  WatchAlert,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { nowIso } from '../util';
import { getSafetyState } from '../safety/guard';
import { getTodayDetail, computePlanFulfillment } from '../plan/service';
import { listThemes } from '../themes/service';
import { listVerdicts } from '../decision/verdictCache';
import { listDisciplineEvents } from '../positions/discipline';
import { listAlerts } from '../watch/store';

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

/** 驾驶舱一屏概览（全部本地 DB 读取，秒开） */
export function buildCockpitOverview(): CockpitOverview {
  const detail = getTodayDetail();
  const themes = listThemes(false)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 6);
  return {
    asOf: nowIso(),
    safety: getSafetyState(),
    plan: computePlanFulfillment(detail),
    themes,
    events: buildTimeline(40),
  };
}
