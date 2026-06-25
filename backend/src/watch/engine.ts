import type {
  StockRankItem,
  WatchConfig,
  WatchQuoteItem,
  WatchSignal,
  WatchSource,
  WatchStatus,
} from '@stock-agent/shared';
import { getQuotes, getSectorMoneyFlow, getStockRanking, getKline } from '../market/eastmoney';
import { getStockIndicators } from '../market/indicators';
import type { StockIndicators } from '@stock-agent/shared';
import { isTradingDay } from '../market/calendar';
import { fetchRealPositions } from '../realPositions';
import { listWatch } from '../watchlist';
import { listStrategies, getStrategySnapshot } from '../strategy/sim';
import { getWatchConfig } from './config';
import { broadcastWatch } from './bus';
import { countAlertsToday } from './store';
import { approxLimitUp, buildEodSettle, buildWeeklyBreak, evalQuoteSignals, evalScanSignals } from './rules';
import { broadcastDisposition, dispatchSignals, retryUndelivered } from './dispatcher';
import { gateSignals, resetGate } from './gate';
import { getAtrPct } from './volatility';
import { evaluateOutcomes } from './reflect';
import { sendDailyDigest } from './digest';
import { resolveProfile, ETF_MID_PROFILE } from './strategyProfile';
import { getActivePlanItems } from '../plan/service';
import type { QuoteCtx, RollState } from './types';
import type { DailyPlanItem, StrategySellProfile } from '@stock-agent/shared';

// Pulse 层：常驻轮询循环（纯计算，无 LLM）。仅交易时段拉快照评估，命中信号交 dispatcher。

const rollState = new Map<string, RollState>();
let seenLimitUp = new Set<string>();
let seenEodSettle = new Set<string>();
/** 当日已告警的中线趋势破坏（按日去重，避免刷屏） */
let seenWeeklyBreak = new Set<string>();
/** 周线 K 当日缓存（中线趋势破坏扫描复用，避免每轮重取周 K） */
const weekBarCache = new Map<string, { day: string; closes: number[] }>();
/** 日线技术指标当日缓存（S9 中线指标转弱扫描复用，避免每轮重算日线指标） */
const indCache = new Map<string, { day: string; ind: StockIndicators | null }>();
let lastMidScanAt = 0;
let seenDay = '';

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastPollAt: string | null = null;
let lastSignalCount = 0;
let lastRetryAt = 0;
let lastOutcomeEvalDay = '';
let lastDigestDay = '';
let lastWatchPollAt = 0;
let lastScanAt = 0;

/** Asia/Shanghai 当前 YYYY-MM-DD 与分钟数、是否周末 */
function shanghaiNow(): { day: string; minutes: number; weekend: boolean } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return { day, minutes: hour * 60 + minute, weekend: weekday === 'Sat' || weekday === 'Sun' };
}

/** 是否 A 股交易时段（含集合竞价 9:15）：9:15-11:30 / 13:00-15:00，且为交易日（非周末/节假日） */
function isTradingSession(): boolean {
  const { minutes } = shanghaiNow();
  if (!isTradingDay()) return false;
  const am = minutes >= 9 * 60 + 15 && minutes <= 11 * 60 + 30;
  const pm = minutes >= 13 * 60 && minutes <= 15 * 60;
  return am || pm;
}

/** 跨日重置滚动状态与已见涨停集合 */
function resetIfNewDay(day: string): void {
  if (day !== seenDay) {
    seenDay = day;
    rollState.clear();
    seenLimitUp = new Set();
    seenEodSettle = new Set();
    seenWeeklyBreak = new Set();
    weekBarCache.clear();
    indCache.clear();
    resetGate();
  }
}

/**
 * 坏价过滤：单 tick 相对上一价的跳变超过该板块「日内理论最大区间」(2×涨跌停幅度)，
 * 在连续竞价里物理不可能，判为东财坏数据。主板 10% / 创业板(300·301) 20%。
 */
function isAbnormalJump(code: string, prev: number, cur: number): boolean {
  if (prev <= 0) return false;
  const ratio = /^(300|301)/.test(code) ? 20 : 10;
  const delta = Math.abs((cur - prev) / prev) * 100;
  return delta > ratio * 2;
}

interface PoolMeta {
  source: WatchSource;
  name: string;
  avgCost?: number;
  /** 战法归属（仅战法持仓，真实持仓不带） */
  strategyId?: string;
  strategyName?: string;
  /** 战法卖点档案（有则启用战法专属触发） */
  profile?: StrategySellProfile | null;
  /** 持仓周期：short 短线（默认）/ mid 中线（中线走趋势破坏档，过滤日内噪声） */
  horizon?: 'short' | 'mid';
  /** 今日计划标的项（有则启用计划结构化触发价对照） */
  planItem?: DailyPlanItem | null;
}

/** 汇集监控池：持仓（真实+战法）∪ 自选，去重，持仓优先。includeWatch 控制本轮是否纳入自选（分频） */
async function collectPool(cfg: WatchConfig, includeWatch: boolean): Promise<Map<string, PoolMeta>> {
  const meta = new Map<string, PoolMeta>();

  if (cfg.watchPositions) {
    // 真实持仓（best-effort：未配置 Cookie 时降级跳过）
    try {
      const pf = await fetchRealPositions(false);
      for (const p of pf.positions) {
        if (p.qty <= 0) continue;
        // 真实持仓 ETF（场内基金 1/5 开头，无战法归属）默认走中线档：
        // 享受周线破位/回撤/MACD死叉告警，过滤日内噪声（拿得住主升浪）；个股持仓保持短线档。
        const isEtf = /^[15]/.test(p.code);
        meta.set(p.code, {
          source: 'position',
          name: p.name,
          avgCost: p.avgCost,
          ...(isEtf ? { horizon: 'mid' as const, profile: ETF_MID_PROFILE } : {}),
        });
      }
    } catch {
      /* 降级 */
    }
    // 本地战法持仓（仅 kind=local；妙想镜像盘不纳入。skipSync 避免每轮触发同步）
    try {
      for (const s of listStrategies().filter((s) => s.kind === 'local')) {
        const snap = await getStrategySnapshot(s.id, { skipSync: true });
        const horizon = s.horizon === 'mid' ? 'mid' : 'short';
        const profile = resolveProfile(s.id, horizon);
        for (const p of snap.positions) {
          if (!meta.has(p.code)) {
            meta.set(p.code, {
              source: 'position',
              name: p.name,
              avgCost: p.avgCost,
              strategyId: s.id,
              strategyName: s.name,
              profile,
              horizon,
            });
          }
        }
      }
    } catch {
      /* 降级 */
    }
  }

  // 自选：仅纳入命中「重点分组」的标的（watchGroup 为空则不盯任何自选）
  const group = cfg.watchGroup?.trim();
  if (cfg.watchWatchlist && includeWatch && group) {
    for (const w of listWatch()) {
      if (meta.has(w.code)) continue;
      const tags = (w.tags ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      if (tags.includes(group)) meta.set(w.code, { source: 'watch', name: w.name });
    }
  }

  // 今日计划标的：有生效计划时无条件并入（不受 watchGroup 限制），结构化触发价对照。
  // 已在持仓/自选池内则附加 planItem；否则按方向新建池目（买/观察→watch，持有/减/卖→position）。
  try {
    for (const it of getActivePlanItems()) {
      if (it.status === 'done' || it.status === 'invalid') continue;
      const existing = meta.get(it.code);
      if (existing) {
        existing.planItem = it;
        continue;
      }
      const asPosition = it.direction === 'hold' || it.direction === 'reduce' || it.direction === 'sell';
      meta.set(it.code, {
        source: asPosition ? 'position' : 'watch',
        name: it.name,
        planItem: it,
      });
    }
  } catch {
    /* 降级：无计划或读取失败不影响主监控 */
  }

  return meta;
}

/** 全市场异动扫描：新晋涨停（差集） + 板块主力净流入 */
async function scanSignals(cfg: WatchConfig): Promise<WatchSignal[]> {
  if (!cfg.watchScan) return [];
  const [gainers, sectors] = await Promise.all([
    getStockRanking('gainers', 40).catch(() => [] as StockRankItem[]),
    getSectorMoneyFlow('inflow', 10).catch(() => []),
  ]);

  const isLimitUp = (r: StockRankItem): boolean => {
    const cyb = /^(300|301)/.test(r.code);
    return cyb ? r.pct >= 19.5 : r.pct >= 9.8;
  };
  const newLimitUps: StockRankItem[] = [];
  for (const r of gainers) {
    if (!isLimitUp(r)) continue;
    if (seenLimitUp.has(r.code)) continue;
    seenLimitUp.add(r.code);
    newLimitUps.push(r);
  }

  return evalScanSignals(newLimitUps, sectors, cfg);
}

const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / a.length;

/** 取某只标的当日缓存的周线收盘序列（best-effort，失败返回空） */
async function getWeekCloses(code: string, day: string): Promise<number[]> {
  const hit = weekBarCache.get(code);
  if (hit && hit.day === day) return hit.closes;
  let closes: number[] = [];
  try {
    const bars = await getKline(code, 'week', 120);
    closes = bars.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0);
  } catch {
    closes = [];
  }
  weekBarCache.set(code, { day, closes });
  return closes;
}

/** 取某只标的当日缓存的日线技术指标（S9，best-effort，失败返回 null） */
async function getDailyIndicators(code: string, day: string): Promise<StockIndicators | null> {
  const hit = indCache.get(code);
  if (hit && hit.day === day) return hit.ind;
  let ind: StockIndicators | null = null;
  try {
    ind = await getStockIndicators(code);
  } catch {
    ind = null;
  }
  indCache.set(code, { day, ind });
  return ind;
}

/**
 * 中线趋势破坏扫描（低频，M3 中线盯盘档）：对中线战法持仓算周线均线/高点回撤，
 * 跌破 maBreakPeriod 周线或周线高点回撤超 trailingStop 即产 weekly_break。按日去重。
 * best-effort：单只取数失败跳过，不影响主监控。
 */
async function midTrendScan(
  metas: Array<{ code: string; meta: PoolMeta; price: number; pct: number; prevClose: number }>,
  day: string,
): Promise<WatchSignal[]> {
  const out: WatchSignal[] = [];
  for (const { code, meta, price, pct, prevClose } of metas) {
    if (meta.horizon !== 'mid' || seenWeeklyBreak.has(code)) continue;
    const profile = meta.profile;
    const period = profile?.maBreakPeriod ?? 0;
    const trail = profile?.trailingStop ?? 0;
    if (period <= 0 && trail <= 0) continue;

    const closes = await getWeekCloses(code, day);
    if (closes.length < Math.max(period, 1)) continue;

    const ctx = {
      code,
      name: meta.name,
      source: meta.source,
      price,
      pct,
      prevClose,
      dayHigh: price,
      prevPrice: null,
      strategyId: meta.strategyId,
      strategyName: meta.strategyName,
      horizon: meta.horizon,
    } as QuoteCtx;

    // ① 跌破周线均线（趋势破坏）
    if (period > 0 && closes.length >= period) {
      const ma = mean(closes.slice(closes.length - period));
      if (price < ma) {
        seenWeeklyBreak.add(code);
        out.push(
          buildWeeklyBreak(
            ctx,
            `跌破 ${period} 周线 ${ma.toFixed(2)}（现价 ${price.toFixed(2)}），中线趋势破坏，评估是否离场`,
            'ma',
          ),
        );
        continue;
      }
    }

    // ② 周线高点回撤超移动止盈阈值（锁趋势利润）
    if (trail > 0) {
      const lookback = period > 0 ? Math.min(period, closes.length) : closes.length;
      const peak = Math.max(...closes.slice(closes.length - lookback), price);
      if (peak > 0) {
        const dd = ((peak - price) / peak) * 100;
        if (dd >= trail) {
          seenWeeklyBreak.add(code);
          out.push(
            buildWeeklyBreak(
              ctx,
              `从周线高点 ${peak.toFixed(2)} 回撤 ${dd.toFixed(1)}%（现价 ${price.toFixed(2)}，移动止盈线 ${trail}%），趋势走弱`,
              'trail',
            ),
          );
          continue;
        }
      }
    }

    // ③ 日线技术指标转弱（S9）：MACD 死叉 / KDJ 高位死叉，作为中线趋势破坏的指标佐证。
    // 死叉为「当根穿越」状态，次日转空头不再复发；叠加按日去重，不刷屏。
    const ind = await getDailyIndicators(code, day);
    if (ind?.macd?.state === '死叉') {
      seenWeeklyBreak.add(code);
      out.push(
        buildWeeklyBreak(
          ctx,
          `日线 MACD 死叉（DIF ${ind.macd.dif} 下穿 DEA ${ind.macd.dea}），中线动能转弱，评估是否减仓`,
          'ma',
        ),
      );
      continue;
    }
    if (ind?.kdj && ind.kdj.signal === '超买' && ind.kdj.k < ind.kdj.d) {
      seenWeeklyBreak.add(code);
      out.push(
        buildWeeklyBreak(
          ctx,
          `日线 KDJ 高位死叉（K ${ind.kdj.k} 下穿 D ${ind.kdj.d}，J ${ind.kdj.j}），短期见顶风险，评估止盈`,
          'trail',
        ),
      );
    }
  }
  return out;
}

/** 单轮 tick */
async function tick(cfg: WatchConfig): Promise<void> {
  const { day, minutes } = shanghaiNow();
  resetIfNewDay(day);

  // 分频：持仓每 tick；自选每 watchEverySec；全市场扫描每 scanEverySec
  const now = Date.now();
  const includeWatch = now - lastWatchPollAt >= Math.max(cfg.pollSec, cfg.watchEverySec) * 1000;
  if (includeWatch) lastWatchPollAt = now;
  const doScan = cfg.watchScan && now - lastScanAt >= Math.max(cfg.pollSec, cfg.scanEverySec) * 1000;
  if (doScan) lastScanAt = now;

  const meta = await collectPool(cfg, includeWatch);
  const codes = [...meta.keys()];
  const quotes = codes.length > 0 ? await getQuotes(codes) : [];

  // 中线趋势破坏扫描分频：每 max(pollSec, 1800s)=30min 一次（周线慢变 + 按日去重，不刷屏）
  const doMidScan = now - lastMidScanAt >= Math.max(cfg.pollSec, 1800) * 1000;
  if (doMidScan) lastMidScanAt = now;

  const quoteItems: WatchQuoteItem[] = [];
  const signals: WatchSignal[] = [];

  for (const q of quotes) {
    const m = meta.get(q.code);
    if (!m || q.price <= 0) continue;

    const prev = rollState.get(q.code);
    const prevPrice = prev?.lastPrice ?? null;

    // 坏价过滤：异常跳变跳过本轮，不评估、不更新滚动状态（保留上一良好价）
    if (prevPrice != null && isAbnormalJump(q.code, prevPrice, q.price)) continue;

    const dayHigh = Math.max(prev?.dayHigh ?? 0, q.price);

    const ctx: QuoteCtx = {
      code: q.code,
      name: m.name || q.name,
      source: m.source,
      price: q.price,
      pct: q.pct,
      prevClose: q.prevClose,
      avgCost: m.avgCost,
      dayHigh,
      prevPrice,
      limitUp: approxLimitUp(q.code, q.prevClose),
      turnoverRate: q.turnoverRate,
      volumeRatio: q.volumeRatio,
      atrPct: getAtrPct(q.code, day),
      strategyId: m.strategyId,
      strategyName: m.strategyName,
      horizon: m.horizon,
      profile: m.profile,
      planItem: m.planItem,
    };
    signals.push(...evalQuoteSignals(ctx, cfg));

    // 尾盘了结：到达战法档案 eodCutoffMin 后，每日一次提示该战法持仓不过夜
    // （中线档 eodCutoffMin=0 表示持有过夜，不产尾盘了结）
    if (m.profile && m.profile.eodCutoffMin > 0 && minutes >= m.profile.eodCutoffMin && !seenEodSettle.has(q.code)) {
      seenEodSettle.add(q.code);
      signals.push(buildEodSettle(ctx));
    }

    rollState.set(q.code, { dayHigh, lastPrice: q.price, day });

    quoteItems.push({
      code: q.code,
      name: ctx.name,
      source: m.source,
      price: q.price,
      pct: q.pct,
      dayHigh,
      strategyId: m.strategyId,
      strategyName: m.strategyName,
    });
  }

  if (doScan) signals.push(...(await scanSignals(cfg)));

  // 中线趋势破坏：低频对中线持仓算周线均线/高点回撤（复用本轮已取的现价）
  if (doMidScan) {
    const midMetas = quotes
      .map((q) => {
        const m = meta.get(q.code);
        return m && m.horizon === 'mid' && q.price > 0
          ? { code: q.code, meta: m, price: q.price, pct: q.pct, prevClose: q.prevClose }
          : null;
      })
      .filter((x): x is { code: string; meta: PoolMeta; price: number; pct: number; prevClose: number } => x != null);
    if (midMetas.length > 0) {
      try {
        signals.push(...(await midTrendScan(midMetas, day)));
      } catch (e) {
        console.warn('[watch] 中线趋势扫描异常:', e instanceof Error ? e.message : e);
      }
    }
  }

  lastSignalCount = signals.length;
  lastPollAt = new Date().toISOString();

  broadcastWatch({ type: 'quotes', at: lastPollAt, items: quoteItems });
  broadcastWatch({ type: 'status', status: buildStatus(cfg) });

  // 迟滞 + 最小持续门：把持续成立期间每 tick 重复的信号收敛为「首次/升级」事件再 dispatch。
  // evaluatedSources 据本 tick 实际评估过的来源（持仓/自选 ∪ doScan 时的扫描）精确判定「消失重置」。
  const evaluatedSources = new Set<WatchSource>([...meta.values()].map((m) => m.source));
  if (doScan) evaluatedSources.add('scan');
  const { passed, suppressed } = gateSignals(signals, evaluatedSources);
  // 信号流去向化广播：被迟滞静默者标 hysteresis；放行者交 dispatcher 按冷却/限流/送AI 等去向广播。
  // 保证每条信号每 tick 恰好广播一次且都带去向标签（前端据此折叠并解释「为何没升级」）。
  for (const s of suppressed) broadcastDisposition(s, 'hysteresis');
  if (passed.length > 0) await dispatchSignals(passed, cfg);
}

function buildStatus(cfg: WatchConfig): WatchStatus {
  return {
    enabled: cfg.enabled,
    running,
    inSession: isTradingSession(),
    lastPollAt,
    lastSignalCount,
    alertsToday: countAlertsToday(),
    config: cfg,
  };
}

/** 调度下一轮（setTimeout 递归，避免重入） */
function scheduleNext(delaySec: number): void {
  timer = setTimeout(() => void loop(), Math.max(3, delaySec) * 1000);
}

async function loop(): Promise<void> {
  const cfg = getWatchConfig();
  if (!cfg.enabled) {
    running = false;
    timer = null;
    return;
  }
  running = true;

  try {
    const { day, minutes } = shanghaiNow();
    if (isTradingSession()) {
      // 结果反思：进入新交易日首个 tick 回看历史告警应验
      if (cfg.reflection && lastOutcomeEvalDay !== day) {
        lastOutcomeEvalDay = day;
        try {
          await evaluateOutcomes(day);
        } catch (e) {
          console.warn('[watch] 反思回看异常:', e instanceof Error ? e.message : e);
        }
      }
      await tick(cfg);
      // 死信重投：最多每 60s 一次
      if (Date.now() - lastRetryAt > 60_000) {
        lastRetryAt = Date.now();
        await retryUndelivered(cfg);
      }
    } else {
      // 非交易时段：仅刷新心跳，低频空转
      lastPollAt = new Date().toISOString();
      broadcastWatch({ type: 'status', status: buildStatus(cfg) });
      // 收盘后（>=15:05）推送当日告警摘要，每日一次
      if (cfg.dailyDigest && minutes >= 15 * 60 + 5 && lastDigestDay !== day) {
        lastDigestDay = day;
        try {
          await sendDailyDigest(cfg);
        } catch (e) {
          console.warn('[watch] 当日摘要推送异常:', e instanceof Error ? e.message : e);
        }
      }
    }
  } catch (e) {
    console.warn('[watch] tick 异常:', e instanceof Error ? e.message : e);
  }

  scheduleNext(isTradingSession() ? cfg.pollSec : 30);
}

/** 启动引擎（按当前配置；未开启则不启动） */
export function startWatchEngine(): void {
  if (timer) return;
  const cfg = getWatchConfig();
  if (!cfg.enabled) {
    console.log('[watch] 引擎未开启（可在设置页或盯盘页启用）');
    return;
  }
  console.log('[watch] 引擎启动');
  void loop();
}

/** 停止引擎 */
export function stopWatchEngine(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  running = false;
}

/** 配置变更后调用：据 enabled 重启或停止 */
export function applyWatchConfig(): void {
  const cfg = getWatchConfig();
  if (cfg.enabled) {
    if (!timer) startWatchEngine();
  } else {
    stopWatchEngine();
  }
}

export function getWatchStatus(): WatchStatus {
  return buildStatus(getWatchConfig());
}
