import { eq } from 'drizzle-orm';
import type { StrategySellProfile, WatchStrategyView } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { listStrategies } from '../strategy/sim';
import { getActiveSkills, updateSkillManually } from '../strategy/skill';

// 战法盯盘卖点档案：轻量存于 settings 表 JSON，无需新表/新 UI。
// 仅「有档案」的战法启用战法专属触发（止盈/尾盘了结/止损）；
// 无档案的持仓（含真实持仓）只走通用下跌触发。

const PROFILES_KEY = 'watch_strategy_profiles';
const WEIPAN_SKILL_FLAG = 'watch_weipan_sell_skill_v2';
const LOCAL_NAME = '尾盘动能套利';

/** 通用兜底档案（当前仅作参考，未配档案的战法不启用专属触发） */
export const DEFAULT_PROFILE: StrategySellProfile = {
  takeProfitPct: 8,
  intradayDrawdownPct: 3,
  stopLossPct: 4,
  eodCutoffMin: 890, // 14:50
};

/** 尾盘动能套利卖点档案（A1：止盈 5% / 回撤 3% / 止损 3% / 14:50 了结） */
const WEIPAN_PROFILE: StrategySellProfile = {
  takeProfitPct: 5,
  intradayDrawdownPct: 3,
  stopLossPct: 3,
  eodCutoffMin: 890,
};

/**
 * 中线档默认卖点档案（M3）：趋势不破不走——只在跌破 10 周线 / 周线高点回撤 18% 时告警，
 * 过滤日内噪声（拿得住主升浪）。无尾盘了结（eodCutoffMin=0，中线持有过夜）。
 * 止盈/日内回撤设很宽（仅作硬安全垫），实际中线卖点由 weekly_break 主导。
 */
export const MID_PROFILE: StrategySellProfile = {
  takeProfitPct: 50,
  intradayDrawdownPct: 99,
  stopLossPct: 12,
  eodCutoffMin: 0,
  maBreakPeriod: 10,
  maBreakTimeframe: 'week',
  trailingStop: 18,
};

/** 写回尾盘套利的卖出标准，统一 cron 与 watch 研判口径 */
const WEIPAN_SELL_STANDARD = `T+1 尾盘动能套利卖出标准（持有不超 1-2 日）：
1. 止盈：次日冲高，盈利达 +5%（强势主线可看 +8%）即分批/全部兑现，不贪回调。
2. 冲高回落：盘中从当日高点回撤 ≥3%，或冲高后跌破当日分时均价线 → 动能转弱卖出。
3. 急跌/破位止损：放量下杀、跌破买入价 ≥3%、主线退潮 → 止损离场。
4. 动能衰竭：次日缩量横盘/高开乏力、不再延续动能 → 套利逻辑证伪，了结。
5. 时间止损：尾盘(14:50 后)仍未达预期且无强动能 → 不过夜，了结离场。`;

function readRaw(key: string): string | undefined {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  return row?.value;
}

function writeRaw(key: string, value: string): void {
  const now = new Date().toISOString();
  db.insert(schema.settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: now } })
    .run();
}

function loadProfiles(): Record<string, StrategySellProfile> {
  const raw = readRaw(PROFILES_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 获取某战法的卖点档案；无档案返回 null（即不启用战法专属触发） */
export function getProfile(strategyId: string): StrategySellProfile | null {
  const map = loadProfiles();
  return map[strategyId] ?? null;
}

/**
 * 按战法周期解析卖点档案：显式档案优先；中线战法（horizon=mid）无显式档案时回退 MID_PROFILE
 * （趋势不破不走的中线纪律），短线战法无档案仍返回 null（只走通用下跌触发）。
 */
export function resolveProfile(
  strategyId: string,
  horizon: 'short' | 'mid',
): StrategySellProfile | null {
  const explicit = getProfile(strategyId);
  if (explicit) return explicit;
  return horizon === 'mid' ? MID_PROFILE : null;
}

/** 页面展示：各非归档战法的卖点档案 + 现行 active 卖出 Skill */
export function getStrategyViews(): WatchStrategyView[] {
  return listStrategies(false).map((s) => {
    const sell = getActiveSkills(s.id).sell;
    return {
      strategyId: s.id,
      name: s.name,
      kind: s.kind,
      profile: resolveProfile(s.id, s.horizon === 'mid' ? 'mid' : 'short'),
      sellSkill: sell?.content ?? null,
    };
  });
}

/** 幂等种子：给尾盘动能套利写入卖点档案 + 写回卖出 Skill 标准 */
export function seedStrategyProfiles(): void {
  const weipan = listStrategies(true).find((s) => s.name === LOCAL_NAME);
  if (!weipan) return;

  const map = loadProfiles();
  if (!map[weipan.id]) {
    map[weipan.id] = { ...WEIPAN_PROFILE };
    writeRaw(PROFILES_KEY, JSON.stringify(map));
  }

  if (readRaw(WEIPAN_SKILL_FLAG) !== '1') {
    const active = getActiveSkills(weipan.id).sell;
    if (active?.content?.trim() !== WEIPAN_SELL_STANDARD) {
      updateSkillManually(weipan.id, 'sell', WEIPAN_SELL_STANDARD, '盯盘卖点标准化');
    }
    writeRaw(WEIPAN_SKILL_FLAG, '1');
  }
}
