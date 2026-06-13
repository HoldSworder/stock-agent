import { eq } from 'drizzle-orm';
import type { SafetyState, SafetyUpdate } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { isTradingDay, shanghaiDateStr } from '../market/calendar';
import { isAShareTradingTime, nowIso, shanghaiClock } from '../util';

// 安全守卫：所有交易/模拟动作（本地 sim_trade、外部 mx_trade、盯盘自动卖出）落单前的代码层总闸。
// 设计原则：kill switch / 交易日 / 自动开关 全在代码层判断，绝不依赖 prompt 或模型自觉。
// 自动来源（cron/agent/watch）默认被拒，须用户显式打开对应自动开关；手动来源始终受 kill switch 约束。

/** 交易动作类型：本地战法模拟 vs 外部妙想模拟盘 */
export type TradeOperation = 'sim_buy' | 'sim_sell' | 'external_sim_buy' | 'external_sim_sell';

/** 触发来源：manual=用户手动；其余均视为自动，需自动开关放行 */
export type TradeSource = 'manual' | 'watch' | 'cron' | 'agent';

/** 守卫拒绝交易时抛出（与 StrategyError 区分，便于上层回显「安全拒绝」） */
export class SafetyError extends Error {}

const GLOBAL_ID = 'global';

/** 读取全局安全状态；首次访问自动以默认值落库（kill 关、自动模拟关、允许手动强制） */
export function getSafetyState(): SafetyState {
  let row = db
    .select()
    .from(schema.safetyControls)
    .where(eq(schema.safetyControls.id, GLOBAL_ID))
    .get();
  if (!row) {
    const now = nowIso();
    db.insert(schema.safetyControls)
      .values({
        id: GLOBAL_ID,
        killSwitch: false,
        killReason: null,
        autoLocalSimEnabled: false,
        autoExternalSimEnabled: false,
        allowManualForceTrade: true,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    row = db
      .select()
      .from(schema.safetyControls)
      .where(eq(schema.safetyControls.id, GLOBAL_ID))
      .get();
  }
  return rowToState(row!);
}

function rowToState(row: typeof schema.safetyControls.$inferSelect): SafetyState {
  return {
    killSwitch: row.killSwitch,
    killReason: row.killReason ?? null,
    autoLocalSimEnabled: row.autoLocalSimEnabled,
    autoExternalSimEnabled: row.autoExternalSimEnabled,
    allowManualForceTrade: row.allowManualForceTrade,
    updatedAt: row.updatedAt,
  };
}

/** 更新安全状态（部分字段），返回最新状态 */
export function updateSafetyState(patch: SafetyUpdate): SafetyState {
  getSafetyState(); // 确保行存在
  const set: Record<string, unknown> = { updatedAt: nowIso() };
  if (patch.killSwitch !== undefined) set.killSwitch = patch.killSwitch;
  if (patch.killReason !== undefined) set.killReason = patch.killReason;
  if (patch.autoLocalSimEnabled !== undefined) set.autoLocalSimEnabled = patch.autoLocalSimEnabled;
  if (patch.autoExternalSimEnabled !== undefined)
    set.autoExternalSimEnabled = patch.autoExternalSimEnabled;
  if (patch.allowManualForceTrade !== undefined)
    set.allowManualForceTrade = patch.allowManualForceTrade;
  db.update(schema.safetyControls)
    .set(set)
    .where(eq(schema.safetyControls.id, GLOBAL_ID))
    .run();
  return getSafetyState();
}

/** 拉下总闸（急停）：拒绝所有后续交易/模拟动作 */
export function killAll(reason?: string | null): SafetyState {
  return updateSafetyState({ killSwitch: true, killReason: reason ?? '手动急停' });
}

/** 解除总闸 */
export function resumeAll(): SafetyState {
  return updateSafetyState({ killSwitch: false, killReason: null });
}

/**
 * 交易前置守卫：不满足任一条件即抛 SafetyError，调用方据此回显原因。
 * 判定顺序：① kill switch 一票否决 → ② 自动来源须对应开关开启 →
 * ③ 手动强制成交须 allowManualForceTrade → ④ 交易日 + 交易时段（手动强制可跳过）。
 */
export function assertTradeAllowed(input: {
  operation: TradeOperation;
  source: TradeSource;
  forceTrade?: boolean;
  now?: Date;
}): void {
  const state = getSafetyState();
  const now = input.now ?? new Date();
  const isAuto = input.source !== 'manual';
  const isExternal = input.operation.startsWith('external_');

  // ① kill switch：一票否决（手动也拦）
  if (state.killSwitch) {
    throw new SafetyError(
      `安全总闸已拉下（kill switch）${state.killReason ? `：${state.killReason}` : ''}，已拒绝所有交易/模拟动作。请到安全控制台解除后重试。`,
    );
  }

  // ② 自动来源：对应自动开关必须开启
  if (isAuto) {
    const enabled = isExternal ? state.autoExternalSimEnabled : state.autoLocalSimEnabled;
    if (!enabled) {
      throw new SafetyError(
        `自动${isExternal ? '外部（妙想）' : '本地'}模拟交易开关未开启，已拒绝来自 ${input.source} 的自动下单。如需放行请到安全控制台开启对应开关。`,
      );
    }
  }

  // ③ 手动强制成交：受总开关控制
  if (input.source === 'manual' && input.forceTrade && !state.allowManualForceTrade) {
    throw new SafetyError('手动强制成交已被禁用（allowManualForceTrade=false），请到安全控制台开启。');
  }

  // ④ 交易日 + 交易时段：代码层判定。仅「手动强制成交」可跳过（如收盘后按收盘价补录）。
  const bypassCalendar = input.source === 'manual' && Boolean(input.forceTrade);
  if (!bypassCalendar) {
    if (!isTradingDay(now)) {
      throw new SafetyError(
        `${shanghaiDateStr(now)} 非 A 股交易日（周末或法定节假日），已拒绝下单。`,
      );
    }
    if (!isAShareTradingTime(now)) {
      throw new SafetyError(
        `当前(${shanghaiClock(now)})非 A 股交易时段，仅 9:30-11:30、13:00-15:00（交易日）可成交。`,
      );
    }
  }
}
