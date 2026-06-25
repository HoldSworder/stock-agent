import type {
  EtfWatchConfig,
  EtfWatchLayer,
  EtfWatchLayerState,
  EtfWatchSignal,
  EtfWatchStatus,
} from '@stock-agent/shared';
import { getQuotes } from '../market/eastmoney';
import { isTradingDay } from '../market/calendar';
import { getEtfWatchConfig } from './config';
import { collectTargets, type EtfTarget } from './targets';
import { readTfMacd, readDayContext, type TfMacdReadout, type DayContext } from './macd';
import { processEtfSignal, retryEtfUndelivered } from './dispatcher';
import { broadcastEtfWatch } from './bus';
import { getLayerState, listLayerStates, upsertLayerState } from './store';
import { computeTrendStage, snapshotEtfShares } from './confirm';

// ETF 多周期分层盯盘引擎：交易时段轮询，确定性检测多周期 MACD 金叉/死叉（收盘确认 + 大周期/零轴/
// 风险总闸过滤），按 2:2:1 分层产出建/撤层与硬止损信号。仅告警不下单；按自身信号维护「建议持仓层」。

let timer: NodeJS.Timeout | null = null;
let running = false;
/** 检测并发护栏：轮询 tick 与手动触发共用，避免 seenBar/层状态并发竞写 */
let ticking = false;
/** 引擎世代：每次启/停递增，使在途旧 loop 失效，避免 disable→enable 竞态遗留 timer */
let epoch = 0;
let lastPollAt: string | null = null;
let lastSignalCount = 0;
let trackedCount = 0;
let lastRetryAt = 0;
let seenDay = '';
/** 按 bar 去重：保证每根收盘 K 的同一动作仅触发一次（key 由 buildCandidates 给出） */
let seenBar = new Set<string>();
/**
 * 热启动标志：引擎(重)启动或跨日后的第一次 tick 只把买点候选的去重键写入 seenBar 而不发出，
 * 杜绝重启/启用/隔夜把早已收盘的旧金叉以「当前时刻」回放（卖点/硬止损不在此列，离场宁晚勿漏）。
 */
let primed = false;

/** Asia/Shanghai 当前日期与分钟数 */
function shanghaiNow(): { day: string; minutes: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return { day, minutes: hour * 60 + minute };
}

/** 是否 A 股交易时段：9:30-11:30 / 13:00-15:00 的交易日 */
function isTradingSession(): boolean {
  if (!isTradingDay()) return false;
  const { minutes } = shanghaiNow();
  const am = minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30;
  const pm = minutes >= 13 * 60 && minutes <= 15 * 60;
  return am || pm;
}

function resetIfNewDay(day: string): void {
  if (day !== seenDay) {
    seenDay = day;
    seenBar = new Set();
    primed = false; // 跨日重置：当日首拍重新热启动，避免隔夜旧金叉回放
  }
}

type Mutation =
  | { kind: 'add'; layer: EtfWatchLayer }
  | { kind: 'remove'; layers: EtfWatchLayer[] }
  | null;

interface Candidate {
  signal: EtfWatchSignal;
  /** 按 bar 去重键 */
  dedupKey: string;
  /** 确认后对逻辑层状态的变更 */
  mutation: Mutation;
}

const nowIso = (): string => new Date().toISOString();

/** 多周期读数包 */
interface Readouts {
  r30: TfMacdReadout;
  r60: TfMacdReadout;
  rWeek: TfMacdReadout | null;
  day: DayContext;
}

/** 构造一只 ETF 本轮的候选信号 + 层状态变更（纯确定性） */
function buildCandidates(
  t: EtfTarget,
  r: Readouts,
  price: number,
  pct: number,
  cfg: EtfWatchConfig,
  state: EtfWatchLayerState,
): Candidate[] {
  const out: Candidate[] = [];
  const held = new Set<EtfWatchLayer>(state.heldLayers);
  const { r30, r60, rWeek, day } = r;
  const at = nowIso();

  const mk = (
    type: EtfWatchSignal['type'],
    layer: EtfWatchLayer,
    timeframe: EtfWatchSignal['timeframe'],
    positionPct: number,
    dif: number,
    dea: number,
    detail: string,
    dedupKey: string,
    mutation: Mutation,
  ): Candidate => ({
    signal: {
      code: t.code,
      name: t.name,
      type,
      layer,
      timeframe,
      positionPct,
      price,
      pct,
      dif,
      dea,
      detail,
      at,
      barTime: timeframe === '30m' ? r30.barTime : timeframe === '60m' ? r60.barTime : day.macd.barTime,
    },
    dedupKey,
    mutation,
  });

  // ===== 硬止损（即时，不等死叉）：跌破建仓均价 hardStopPct 或日线收盘跌破 MA20 → 清该层及以下 =====
  if (held.size > 0) {
    const breached: EtfWatchLayer[] = [];
    for (const l of held) {
      const entry = state.layerEntryPrice[String(l)];
      if (entry && entry > 0 && price <= entry * (1 - cfg.hardStopPct / 100)) breached.push(l);
    }
    const ma20Break = day.ma20 != null && day.macd.close < day.ma20;
    if (breached.length > 0 || ma20Break) {
      const maxB = ma20Break ? 3 : (Math.max(...breached) as EtfWatchLayer);
      const cleared = [...held].filter((l) => l <= maxB).sort((a, b) => a - b);
      if (cleared.length > 0) {
        const pos = cleared.reduce((s, l) => s + layerPct(l, cfg), 0);
        const reason = ma20Break
          ? `日线收盘 ${day.macd.close} 跌破 MA20 ${day.ma20?.toFixed(3)}`
          : `跌破建仓价 ${cfg.hardStopPct}% 硬止损线`;
        out.push(
          mk(
            'hard_stop',
            maxB,
            'day',
            pos,
            day.macd.dif,
            day.macd.dea,
            `硬止损：${reason}，清第 ${cleared.join('/')} 层（不等死叉，坚决离场）`,
            `${t.code}:hard:${maxB}:${day.macd.barTime}`,
            { kind: 'remove', layers: cleared },
          ),
        );
        // 硬止损当轮优先，不再评估同标的其它撤层（避免重复）
        return out;
      }
    }

    // ===== 移动止盈（守主升浪利润）：盈利状态下从持有高点回撤 ≥ 阈值 → 落袋清层 =====
    if (cfg.trailTakeProfitPct > 0 && state.peakPrice > 0) {
      const entries = [...held]
        .map((l) => state.layerEntryPrice[String(l)])
        .filter((p): p is number => typeof p === 'number' && p > 0);
      const minEntry = entries.length ? Math.min(...entries) : Infinity;
      const inProfit = Number.isFinite(minEntry) && state.peakPrice > minEntry;
      const drawdown = ((state.peakPrice - price) / state.peakPrice) * 100;
      if (inProfit && drawdown >= cfg.trailTakeProfitPct) {
        const cleared = [...held].sort((a, b) => a - b);
        const maxL = Math.max(...cleared) as EtfWatchLayer;
        const pos = cleared.reduce((s, l) => s + layerPct(l, cfg), 0);
        out.push(
          mk(
            'sell_layer',
            maxL,
            'day',
            pos,
            day.macd.dif,
            day.macd.dea,
            `移动止盈：从持有高点 ${state.peakPrice.toFixed(3)} 回撤 ${drawdown.toFixed(1)}% ≥ ${cfg.trailTakeProfitPct}%，落袋清第 ${cleared.join('/')} 层`,
            `${t.code}:trailtp:${day.macd.barTime}`,
            { kind: 'remove', layers: cleared },
          ),
        );
        return out;
      }
    }
  }

  // ===== 建层买点 =====
  // 风险总闸：日线价 < MA60 冻结建 L1（逆势不开新仓）
  const regimeFrozen = cfg.higherTfFilter && day.ma60 != null && day.macd.close < day.ma60;

  // L1：30分钟金叉。被风控/大周期拦截不再静默丢弃，降级为「观察」留痕（positionPct=0），写明原因。
  if (r30.state === '金叉' && !held.has(1)) {
    const key = `${t.code}:buy:1:${r30.barTime}`;
    if (regimeFrozen) {
      out.push(mk('buy_layer', 1, '30m', 0, r30.dif, r30.dea, `30分钟金叉但日线收盘 ${day.macd.close} 跌破 MA60 ${day.ma60?.toFixed(3)}（逆势冻结 L1），降级观察`, key, null));
    } else if (cfg.higherTfFilter && !r60.bullish) {
      out.push(mk('buy_layer', 1, '30m', 0, r30.dif, r30.dea, `30分钟金叉但 60分钟未多头（DIF ${r60.dif}<DEA ${r60.dea}），降级观察`, key, null));
    } else if (cfg.zeroAxisFilter && !r30.aboveZero) {
      out.push(mk('buy_layer', 1, '30m', 0, r30.dif, r30.dea, `30分钟金叉但 DIF<0（水下），降级观察`, key, null));
    } else {
      out.push(mk('buy_layer', 1, '30m', cfg.layer1Pct, r30.dif, r30.dea, `30分钟 MACD 金叉（DIF ${r30.dif}/DEA ${r30.dea}）+ 60分钟多头，建 L1 试探仓 ${cfg.layer1Pct}%`, key, { kind: 'add', layer: 1 }));
    }
  }

  // L2：60分钟金叉。日线非多头时降级观察留痕，不再静默丢弃。
  if (r60.state === '金叉' && !held.has(2)) {
    const key = `${t.code}:buy:2:${r60.barTime}`;
    if (cfg.higherTfFilter && !day.macd.bullish) {
      out.push(mk('buy_layer', 2, '60m', 0, r60.dif, r60.dea, `60分钟金叉但日线非多头（DIF ${day.macd.dif}<DEA ${day.macd.dea}），降级观察`, key, null));
    } else if (cfg.zeroAxisFilter && !r60.aboveZero) {
      out.push(mk('buy_layer', 2, '60m', 0, r60.dif, r60.dea, `60分钟金叉但 DIF<0（水下），降级观察`, key, null));
    } else {
      out.push(mk('buy_layer', 2, '60m', cfg.layer2Pct, r60.dif, r60.dea, `60分钟 MACD 金叉（DIF ${r60.dif}/DEA ${r60.dea}）+ 日线多头，建 L2 加仓 ${cfg.layer2Pct}%`, key, { kind: 'add', layer: 2 }));
    }
  }

  // L3：日线金叉。周线/MA60 未多头时降级观察留痕，不再静默丢弃。
  if (day.macd.state === '金叉' && !held.has(3)) {
    const key = `${t.code}:buy:3:${day.macd.barTime}`;
    const weeklyBull = (rWeek?.bullish ?? false) || (day.ma60 != null && day.macd.close > day.ma60);
    if (cfg.higherTfFilter && !weeklyBull) {
      out.push(mk('buy_layer', 3, 'day', 0, day.macd.dif, day.macd.dea, `日线金叉但周线/MA60 未多头，降级观察`, key, null));
    } else if (cfg.zeroAxisFilter && !day.macd.aboveZero) {
      out.push(mk('buy_layer', 3, 'day', 0, day.macd.dif, day.macd.dea, `日线金叉但 DIF<0（水下），降级观察`, key, null));
    } else {
      out.push(mk('buy_layer', 3, 'day', cfg.layer3Pct, day.macd.dif, day.macd.dea, `日线 MACD 金叉（DIF ${day.macd.dif}/DEA ${day.macd.dea}）+ 周线多头，建 L3 确认仓 ${cfg.layer3Pct}%`, key, { kind: 'add', layer: 3 }));
    }
  }

  // ===== 撤层卖点（死叉，各周期各撤各层）=====
  if (r30.state === '死叉' && held.has(1)) {
    if (r60.bullish) {
      // 60m 仍多头：改挂移动止损（跌破近 N 根 30m 低点才撤），防主升浪被日内噪声洗
      if (price < r30.recentLow) {
        out.push(mk('sell_layer', 1, '30m', cfg.layer1Pct, r30.dif, r30.dea, `30分钟死叉且跌破近 ${cfg.trailLookback} 根30分钟低点 ${r30.recentLow.toFixed(3)}，移动止损撤 L1`, `${t.code}:sell:1:${r30.barTime}`, { kind: 'remove', layers: [1] }));
      } else {
        out.push(mk('sell_layer', 1, '30m', 0, r30.dif, r30.dea, `30分钟死叉但 60分钟仍多头：改挂移动止损（跌破近 ${cfg.trailLookback} 根30分钟低点 ${r30.recentLow.toFixed(3)} 才撤），暂不清 L1`, `${t.code}:trailadv:1:${r30.barTime}`, null));
      }
    } else {
      out.push(mk('sell_layer', 1, '30m', cfg.layer1Pct, r30.dif, r30.dea, `30分钟 MACD 死叉且 60分钟转弱，撤 L1（${cfg.layer1Pct}%）`, `${t.code}:sell:1:${r30.barTime}`, { kind: 'remove', layers: [1] }));
    }
  }

  if (r60.state === '死叉' && held.has(2)) {
    out.push(mk('sell_layer', 2, '60m', cfg.layer2Pct, r60.dif, r60.dea, `60分钟 MACD 死叉，撤 L2（${cfg.layer2Pct}%）`, `${t.code}:sell:2:${r60.barTime}`, { kind: 'remove', layers: [2] }));
  }

  if (day.macd.state === '死叉' && held.has(3)) {
    out.push(mk('sell_layer', 3, 'day', cfg.layer3Pct, day.macd.dif, day.macd.dea, `日线 MACD 死叉，撤 L3（${cfg.layer3Pct}%）`, `${t.code}:sell:3:${day.macd.barTime}`, { kind: 'remove', layers: [3] }));
  }

  return out;
}

function layerPct(l: EtfWatchLayer, cfg: EtfWatchConfig): number {
  return l === 1 ? cfg.layer1Pct : l === 2 ? cfg.layer2Pct : cfg.layer3Pct;
}

/** 应用层状态变更（确认信号后） */
function applyMutation(state: EtfWatchLayerState, m: Mutation, price: number): void {
  if (!m) return;
  if (!state.layerEntryAt) state.layerEntryAt = {};
  const held = new Set<EtfWatchLayer>(state.heldLayers);
  if (m.kind === 'add') {
    held.add(m.layer);
    state.layerEntryPrice[String(m.layer)] = price;
    state.layerEntryAt[String(m.layer)] = nowIso();
  } else {
    for (const l of m.layers) {
      held.delete(l);
      delete state.layerEntryPrice[String(l)];
      delete state.layerEntryAt[String(l)];
    }
  }
  state.heldLayers = [...held].sort((a, b) => a - b);
}

const RESONANCE = (r: Readouts): number =>
  [r.r30.bullish, r.r60.bullish, r.day.macd.bullish].filter(Boolean).length;

async function evalTarget(t: EtfTarget, price: number, pct: number, cfg: EtfWatchConfig): Promise<number> {
  const [r30, r60, rWeek, day] = await Promise.all([
    readTfMacd(t.code, '30m', cfg.trailLookback),
    readTfMacd(t.code, '60m', cfg.trailLookback),
    readTfMacd(t.code, 'week', cfg.trailLookback),
    readDayContext(t.code, cfg.trailLookback),
  ]);
  if (!r30 || !r60 || !day) {
    // 关键周期数据不足：留痕，区分「数据问题」与「被过滤」（金叉无记录时的排查依据）
    console.warn(`[etfwatch] ${t.code} 多周期数据不足，跳过: r30=${!!r30} r60=${!!r60} day=${!!day}`);
    return 0;
  }

  const readouts: Readouts = { r30, r60, rWeek, day };
  const usePrice = price > 0 ? price : day.macd.close;

  const existing = getLayerState(t.code);
  const state: EtfWatchLayerState = existing ?? {
    code: t.code,
    name: t.name,
    heldLayers: [],
    layerEntryPrice: {},
    layerEntryAt: {},
    peakPrice: usePrice,
    updatedAt: nowIso(),
  };
  if (!state.layerEntryAt) state.layerEntryAt = {};
  state.name = t.name;
  state.peakPrice = Math.max(state.peakPrice || 0, usePrice);
  // 趋势阶段（确定性合成，每轮刷新）：用于「该持有还是该防守」基调与指令卡展示
  const trendStage = computeTrendStage({
    close: day.macd.close,
    ma20: day.ma20,
    ma60: day.ma60,
    dayBullish: day.macd.bullish,
    dayAboveZero: day.macd.aboveZero,
  });
  state.trendStage = trendStage;
  // 已建总仓位（买点护栏用）：当前已建各层目标仓位之和
  const heldPct = state.heldLayers.reduce((s, l) => s + layerPct(l, cfg), 0);

  const candidates = buildCandidates(t, readouts, usePrice, pct, cfg, state);

  // 金叉诊断：任一周期金叉时打一行，便于「金叉却无记录」时定位走的是过滤/热启动/去重哪条
  if (r30.state === '金叉' || r60.state === '金叉' || day.macd.state === '金叉') {
    const crossed = [
      r30.state === '金叉' ? '30m' : null,
      r60.state === '金叉' ? '60m' : null,
      day.macd.state === '金叉' ? 'day' : null,
    ].filter(Boolean).join('/');
    const regimeFrozen = cfg.higherTfFilter && day.ma60 != null && day.macd.close < day.ma60;
    console.info(
      `[etfwatch] ${t.code} 金叉 ${crossed} | r60.bull=${r60.bullish} day.bull=${day.macd.bullish} regimeFrozen=${regimeFrozen} primed=${primed} held=[${state.heldLayers.join(',')}] candidates=${candidates.length}`,
    );
  }

  let emitted = 0;
  for (const c of candidates) {
    if (seenBar.has(c.dedupKey)) continue;
    seenBar.add(c.dedupKey);
    // 热启动首拍：买点候选只记去重键不发出（防回放旧金叉）；卖点/硬止损照常发出
    if (!primed && c.signal.type === 'buy_layer') {
      console.info('[etfwatch] 热启动跳过买点(防旧金叉回放):', c.dedupKey);
      continue;
    }
    try {
      const { confirmed } = await processEtfSignal(c.signal, cfg, {
        resonance: RESONANCE(readouts),
        heldPct,
        trendStage,
      });
      emitted += 1;
      if (confirmed) applyMutation(state, c.mutation, usePrice);
    } catch (e) {
      console.warn('[etfwatch] 信号处理失败:', e instanceof Error ? e.message : e);
    }
  }

  if (state.heldLayers.length === 0) state.peakPrice = usePrice;
  upsertLayerState(state);
  return emitted;
}

async function tick(cfg: EtfWatchConfig): Promise<void> {
  const { day } = shanghaiNow();
  resetIfNewDay(day);

  const targets = await collectTargets(cfg);
  trackedCount = targets.length;
  if (targets.length === 0) {
    lastPollAt = nowIso();
    broadcastEtfWatch({ type: 'status', status: buildStatus(cfg) });
    return;
  }

  const codes = targets.map((t) => t.code);
  const quotes = await getQuotes(codes).catch(() => []);
  const qMap = new Map(quotes.map((q) => [q.code, q]));
  // 份额日快照（按日累积，幂等；不阻塞主检测流程）
  void snapshotEtfShares(codes).catch(() => {});

  let signalCount = 0;
  for (const t of targets) {
    const q = qMap.get(t.code);
    try {
      signalCount += await evalTarget(t, q?.price ?? 0, q?.pct ?? 0, cfg);
    } catch (e) {
      console.warn('[etfwatch] 标的评估异常:', t.code, e instanceof Error ? e.message : e);
    }
  }

  primed = true; // 本拍已评估过标的：完成热启动，后续拍开始正常发出买点
  lastSignalCount = signalCount;
  lastPollAt = nowIso();
  broadcastEtfWatch({ type: 'states', at: lastPollAt, states: listLayerStates() });
  broadcastEtfWatch({ type: 'status', status: buildStatus(cfg) });
}

function buildStatus(cfg: EtfWatchConfig): EtfWatchStatus {
  return {
    enabled: cfg.enabled,
    running,
    inSession: isTradingSession(),
    lastPollAt,
    lastSignalCount,
    trackedCount,
    config: cfg,
  };
}

/** 包裹 tick 的并发护栏：已有检测在跑则跳过本次，供轮询与手动触发共用 */
async function safeTick(cfg: EtfWatchConfig): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await tick(cfg);
  } finally {
    ticking = false;
  }
}

function scheduleNext(delaySec: number, myEpoch: number): void {
  if (myEpoch !== epoch) return; // 旧世代 loop 不再排程
  timer = setTimeout(() => void loop(myEpoch), Math.max(5, delaySec) * 1000);
}

async function loop(myEpoch: number): Promise<void> {
  const cfg = getEtfWatchConfig();
  if (!cfg.enabled || myEpoch !== epoch) {
    running = false;
    timer = null;
    return;
  }
  running = true;

  try {
    if (isTradingSession()) {
      await safeTick(cfg);
      if (Date.now() - lastRetryAt > 60_000) {
        lastRetryAt = Date.now();
        await retryEtfUndelivered(cfg);
      }
    } else {
      lastPollAt = nowIso();
      broadcastEtfWatch({ type: 'status', status: buildStatus(cfg) });
    }
  } catch (e) {
    console.warn('[etfwatch] tick 异常:', e instanceof Error ? e.message : e);
  }

  scheduleNext(isTradingSession() ? cfg.pollSec : 60, myEpoch);
}

export function startEtfWatchEngine(): void {
  const cfg = getEtfWatchConfig();
  if (!cfg.enabled) {
    console.log('[etfwatch] ETF 多周期盯盘未开启');
    return;
  }
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  epoch += 1; // 新世代：作废在途旧 loop，保证开启即从干净状态立即起跑
  primed = false; // (重)启动热启动：首拍只对买点候选去重不发出，避免回放已收盘旧金叉
  console.log('[etfwatch] ETF 多周期盯盘启动');
  void loop(epoch);
}

export function stopEtfWatchEngine(): void {
  epoch += 1; // 让在途旧 loop 失效，不再排程
  if (timer) clearTimeout(timer);
  timer = null;
  running = false;
  primed = false; // 停止后下次启动重新热启动
}

export function applyEtfWatchConfig(): void {
  const cfg = getEtfWatchConfig();
  if (cfg.enabled) startEtfWatchEngine(); // 开启/改配置即刻跑一次检测（交易时段内立即 tick）
  else stopEtfWatchEngine();
}

export function getEtfWatchStatus(): EtfWatchStatus {
  return buildStatus(getEtfWatchConfig());
}

/** 手动触发一次检测：按最近收盘 K 线立即评估，忽略交易时段与开关，仅单次、不启动轮询 */
export async function triggerEtfWatchNow(): Promise<EtfWatchStatus> {
  const cfg = getEtfWatchConfig();
  try {
    await safeTick(cfg); // tick 内部会 resetIfNewDay + 广播 states/status
  } catch (e) {
    console.warn('[etfwatch] 手动触发检测异常:', e instanceof Error ? e.message : e);
  }
  return buildStatus(cfg);
}
