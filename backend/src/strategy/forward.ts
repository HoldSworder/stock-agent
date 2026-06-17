import { and, asc, eq } from 'drizzle-orm';
import type { StrategyForwardStats, StrategySample } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { csi300Return } from '../market/csi300';
import { listStrategies as listScreenStrategies } from '../screener/strategy';
import { getMeta, setMeta } from '../settings';
import { newId, nowIso } from '../util';
import { getStrategy, getStrategySnapshot, listStrategies, shanghaiDate } from './sim';

/** 全局自动模拟总闸的内部 meta 键（不进用户设置视图，属高级实验开关） */
const AUTO_SIM_META = 'sim_auto_enabled';

// 战法前向验证：每交易日收盘记录各本地战法权益快照，累积 3-6 个月前向样本轨迹（只读、不交易）。
// 自动模拟受双重总闸约束：全局 simAutoEnabled（默认 false）+ 单战法 autoSimEnabled 白名单，
// 二者皆开才允许自动模拟买卖；本阶段仅提供闸门与样本积累，自动买入默认关闭、不在此实现下单。

/** 全局自动模拟总闸（默认关闭） */
export function isGlobalAutoSimEnabled(): boolean {
  return getMeta(AUTO_SIM_META) === 'true';
}

export function setGlobalAutoSimEnabled(on: boolean): void {
  setMeta(AUTO_SIM_META, on ? 'true' : 'false');
}

/** 某战法是否被允许自动模拟：全局总闸 + 单战法白名单 同时开启 */
export function isAutoSimAllowed(strategyId: string): boolean {
  if (!isGlobalAutoSimEnabled()) return false;
  const s = getStrategy(strategyId);
  return !!s && !s.archived && s.kind === 'local' && s.autoSimEnabled;
}

/** 记录单个战法当日权益样本（同日 upsert，幂等）。失败不抛。 */
async function sampleStrategy(strategyId: string, date: string): Promise<void> {
  try {
    const snap = await getStrategySnapshot(strategyId, { skipSync: true });
    const existing = db
      .select({ id: schema.strategySamples.id })
      .from(schema.strategySamples)
      .where(
        and(
          eq(schema.strategySamples.strategyId, strategyId),
          eq(schema.strategySamples.sampleDate, date),
        ),
      )
      .get();
    const values = {
      totalAsset: snap.totalAsset,
      totalProfitRate: snap.totalProfitRate,
      positionCount: snap.positions.length,
      cash: snap.strategy.cash,
    };
    if (existing) {
      db.update(schema.strategySamples).set(values).where(eq(schema.strategySamples.id, existing.id)).run();
    } else {
      db.insert(schema.strategySamples)
        .values({ id: newId(), strategyId, sampleDate: date, createdAt: nowIso(), ...values })
        .run();
    }
  } catch (e) {
    console.warn(`[strategy] 前向样本记录失败 ${strategyId}:`, e instanceof Error ? e.message : e);
  }
}

/** 记录全部本地战法当日权益样本（收盘后定时调用）。返回记录数。 */
export async function recordDailySamples(): Promise<number> {
  const date = shanghaiDate();
  const strategies = listStrategies().filter((s) => s.kind === 'local');
  let n = 0;
  for (const s of strategies) {
    await sampleStrategy(s.id, date);
    n += 1;
  }
  return n;
}

function listSamples(strategyId: string): StrategySample[] {
  return db
    .select()
    .from(schema.strategySamples)
    .where(eq(schema.strategySamples.strategyId, strategyId))
    .orderBy(asc(schema.strategySamples.sampleDate))
    .all()
    .map((r) => ({
      strategyId: r.strategyId,
      sampleDate: r.sampleDate,
      totalAsset: r.totalAsset,
      totalProfitRate: r.totalProfitRate,
      positionCount: r.positionCount,
      cash: r.cash,
    }));
}

/** 已实现交易统计：卖出笔数与胜率（realizedProfit>0 占比） */
function realizedStats(strategyId: string): { closedTrades: number; winRate: number | null } {
  const sells = db
    .select({ realizedProfit: schema.simTrades.realizedProfit })
    .from(schema.simTrades)
    .where(and(eq(schema.simTrades.strategyId, strategyId), eq(schema.simTrades.side, 'sell')))
    .all();
  const closedTrades = sells.length;
  if (closedTrades === 0) return { closedTrades: 0, winRate: null };
  const wins = sells.filter((t) => (t.realizedProfit ?? 0) > 0).length;
  return { closedTrades, winRate: Math.round((wins / closedTrades) * 1000) / 10 };
}

/** 两个 YYYY-MM-DD 之间的自然日差（b - a，Asia/Shanghai） */
function dayDiff(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00+08:00`);
  const tb = Date.parse(`${b}T00:00:00+08:00`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
}

/** 解析战法绑定选股策略名（内置策略；未绑定/未知为 null，id 仍照常返回） */
function resolveScreenStrategyName(id: string | null): string | null {
  if (!id) return null;
  return listScreenStrategies().find((s) => s.id === id)?.name ?? null;
}

/**
 * 前向验证统计：样本曲线累计收益、最大回撤 + 已实现胜率 + 自动模拟闸门状态。
 * 额外按「选股口径」附沪深300 同期收益与超额 Alpha（权益曲线起点日起算），以及绑定选股策略 id/名。
 * 因需拉取指数 K 线算 Alpha 故为异步。
 */
export async function computeForwardStats(strategyId: string): Promise<StrategyForwardStats> {
  const samples = listSamples(strategyId);
  const strategy = getStrategy(strategyId);
  const { closedTrades, winRate } = realizedStats(strategyId);

  let cumReturn: number | null = null;
  let maxDrawdown: number | null = null;
  if (samples.length >= 2) {
    const first = samples[0].totalAsset;
    const last = samples[samples.length - 1].totalAsset;
    if (first > 0) cumReturn = Math.round((last / first - 1) * 10000) / 100;
    // 权益曲线最大回撤
    let peak = samples[0].totalAsset;
    let mdd = 0;
    for (const s of samples) {
      peak = Math.max(peak, s.totalAsset);
      if (peak > 0) mdd = Math.min(mdd, s.totalAsset / peak - 1);
    }
    maxDrawdown = Math.round(mdd * 10000) / 100;
  }

  // 同期沪深300 区间收益（与 cumReturn 同为 % 口径）与超额 Alpha
  let csi300: number | null = null;
  let alpha: number | null = null;
  const sinceDate = samples[0]?.sampleDate ?? null;
  if (sinceDate && cumReturn != null) {
    const days = Math.max(dayDiff(sinceDate, shanghaiDate()), samples.length);
    const idx = await csi300Return(sinceDate, days);
    if (idx != null) {
      csi300 = Math.round(idx * 100) / 100;
      alpha = Math.round((cumReturn - csi300) * 100) / 100;
    }
  }

  const screenStrategyId = strategy?.screenStrategyId ?? null;
  return {
    strategyId,
    sinceDate,
    days: samples.length,
    cumReturn,
    maxDrawdown,
    closedTrades,
    winRate,
    csi300Return: csi300,
    alpha,
    screenStrategyId,
    screenStrategyName: resolveScreenStrategyName(screenStrategyId),
    autoSimEnabled: strategy?.autoSimEnabled ?? false,
    globalAutoEnabled: isGlobalAutoSimEnabled(),
    samples,
  };
}
