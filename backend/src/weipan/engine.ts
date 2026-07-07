import type { StrategySellProfile, WeipanConfig, WeipanStatus } from '@stock-agent/shared';
import { isTradingDay } from '../market/calendar';
import { getStrategySnapshot } from '../strategy/sim';
import { getProfile } from '../watch/strategyProfile';
import { nowIso } from '../util';
import { getWeipanConfig } from './config';
import { resolveWeipanStrategy } from './resolve';
import { evalWeipanExit, WEIPAN_FALLBACK_PROFILE } from './rules';
import { processWeipanExit } from './dispatcher';
import { broadcastWeipan } from './bus';

/** 取该战法的尾盘卖点档案（复用 watch/strategyProfile 单一出处；无显式档案回退兜底） */
function weipanProfile(strategyId: string): StrategySellProfile {
  return getProfile(strategyId) ?? WEIPAN_FALLBACK_PROFILE;
}

// 尾盘套利确定性盯盘引擎：交易时段轮询尾盘战法持仓，纯规则判定移动止盈/止盈/止损/尾盘了结，命中即自动
// 模拟卖出并推送。全程无 LLM、零 token。与个股 LLM 盯盘（watch）、ETF 盯盘（etfwatch）三套独立互不干扰。

let timer: NodeJS.Timeout | null = null;
let running = false;
let ticking = false;
let epoch = 0;
let lastPollAt: string | null = null;
let lastSignalCount = 0;
let trackedCount = 0;
let seenDay = '';
/** 每只标的当日盘中观测最高（跨日重置；引擎持续运行即可覆盖整个交易时段） */
const dayHighs = new Map<string, number>();

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
    dayHighs.clear();
  }
}

async function tick(cfg: WeipanConfig): Promise<void> {
  const { day, minutes } = shanghaiNow();
  resetIfNewDay(day);

  const strategy = resolveWeipanStrategy();
  if (!strategy) {
    trackedCount = 0;
    lastPollAt = nowIso();
    broadcastWeipan({ type: 'status', status: buildStatus(cfg) });
    return;
  }

  // 快照持仓已含实时现价/涨跌幅/可卖量（getStrategySnapshot 内部批量取报价），无需再单独取行情
  const snap = await getStrategySnapshot(strategy.id, { skipSync: true });
  const positions = snap.positions.filter((p) => p.qty > 0);
  trackedCount = positions.length;
  if (positions.length === 0) {
    lastPollAt = nowIso();
    broadcastWeipan({ type: 'status', status: buildStatus(cfg) });
    return;
  }

  const profile = weipanProfile(strategy.id);
  let count = 0;
  for (const pos of positions) {
    const price = pos.price > 0 ? pos.price : pos.avgCost;
    if (!(price > 0)) continue;
    // dayHigh 以成本兜底（保证 trailing 只在真正冲高到成本上方后才可能触发）
    const dayHigh = Math.max(dayHighs.get(pos.code) ?? 0, price, pos.avgCost);
    dayHighs.set(pos.code, dayHigh);

    const exit = evalWeipanExit({ avgCost: pos.avgCost, price, dayHigh, minutes }, profile);
    if (!exit) continue;
    count++;
    try {
      await processWeipanExit(strategy, pos, exit, { price, pct: pos.pct, dayHigh }, cfg);
    } catch (e) {
      console.warn('[weipan] 卖点处理异常:', pos.code, e instanceof Error ? e.message : e);
    }
  }

  lastSignalCount = count;
  lastPollAt = nowIso();
  broadcastWeipan({ type: 'status', status: buildStatus(cfg) });
}

function buildStatus(cfg: WeipanConfig): WeipanStatus {
  return {
    enabled: cfg.enabled,
    running,
    inSession: isTradingSession(),
    lastPollAt,
    lastSignalCount,
    trackedCount,
    strategyId: resolveWeipanStrategy()?.id ?? null,
    config: cfg,
  };
}

/** 并发护栏：已有 tick 在跑则跳过本次 */
async function safeTick(cfg: WeipanConfig): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await tick(cfg);
  } finally {
    ticking = false;
  }
}

function scheduleNext(delaySec: number, myEpoch: number): void {
  if (myEpoch !== epoch) return;
  timer = setTimeout(() => void loop(myEpoch), Math.max(5, delaySec) * 1000);
}

async function loop(myEpoch: number): Promise<void> {
  const cfg = getWeipanConfig();
  if (!cfg.enabled || myEpoch !== epoch) {
    running = false;
    timer = null;
    return;
  }
  running = true;
  try {
    if (isTradingSession()) {
      await safeTick(cfg);
    } else {
      lastPollAt = nowIso();
      broadcastWeipan({ type: 'status', status: buildStatus(cfg) });
    }
  } catch (e) {
    console.warn('[weipan] tick 异常:', e instanceof Error ? e.message : e);
  }
  scheduleNext(isTradingSession() ? cfg.pollSec : 60, myEpoch);
}

/** 启动引擎（未开启则不启动） */
export function startWeipanEngine(): void {
  const cfg = getWeipanConfig();
  if (!cfg.enabled) {
    console.log('[weipan] 尾盘套利盯盘未开启');
    return;
  }
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  epoch += 1;
  console.log('[weipan] 尾盘套利盯盘启动');
  void loop(epoch);
}

export function stopWeipanEngine(): void {
  epoch += 1;
  if (timer) clearTimeout(timer);
  timer = null;
  running = false;
}

/** 配置变更后据 enabled 重启/停止 */
export function applyWeipanConfig(): void {
  const cfg = getWeipanConfig();
  if (cfg.enabled) startWeipanEngine();
  else stopWeipanEngine();
}

export function getWeipanStatus(): WeipanStatus {
  return buildStatus(getWeipanConfig());
}

/** 手动触发一次检测（忽略开关与交易时段，仅单次，不启动轮询） */
export async function triggerWeipanNow(): Promise<WeipanStatus> {
  await safeTick(getWeipanConfig());
  return getWeipanStatus();
}
