import { isTradingDay, prevTradingDay } from '../market/calendar';
import { shanghaiClock, shanghaiToday } from '../util';

// 日频快照的「什么时候该有数据」与「什么时候允许落盘」的**唯一**定义。
//
// 为什么要单独一个模块：这两个问题必须用同一份答案。
// 落盘闸门说「15:25 之后才算数」，而新鲜度判定说「过了今天就该有」，
// 结果就是同一份数据在保存侧被拒、在展示侧被标过期——用户看到的是自相矛盾的两句话。
//
// 各源的时刻按它依赖什么来定，不是随便排的：
// 收盘 15:00 之后，先等 15:10 的日线回填把当日真实收盘线写进缓存，
// 后面三个快照才依次开算。谁先谁后取决于计算量与依赖深度。

/** 会落日频快照的源 */
export type DailySnapshotSource = 'sentiment' | 'regime' | 'indexFlow' | 'breadth';

/**
 * 最早允许落盘的时刻（Asia/Shanghai，HH:mm）。
 *
 * 不能统一用 15:00：收盘那一刻日线还没回填，此时算出来的是盘中合成的临时 bar。
 * 也不能只判「是不是交易日」——那样盘中任意时刻手动触发一次，
 * 半天的计数就会被当成当日定盘值写进去，之后再也分不出真假。
 */
export const SNAPSHOT_EARLIEST_SAVE: Record<DailySnapshotSource, string> = {
  // 情绪只依赖涨跌停与连板统计，日线回填完就能算
  sentiment: '15:15',
  // 大盘阶段要读多个指数的当日收盘线，等日线回填稳一会儿
  regime: '15:20',
  // 指数资金流只取 10 个指数各一条，但 15:20 已挤了大盘阶段与标的计划复核，往后错开一格
  indexFlow: '15:23',
  // 板块宽度要遍历全部板块成分，最重，排最后
  breadth: '15:25',
};

/** 中文名，用于对用户解释为什么现在不能存 */
const LABEL: Record<DailySnapshotSource, string> = {
  sentiment: '市场情绪',
  regime: '大盘阶段',
  indexFlow: '指数资金流',
  breadth: '板块宽度',
};

/**
 * 现在允不允许把该源的结果落盘。
 *
 * 落盘意味着「这是当日定盘值」，所以门槛必须严：非交易日不存（周末算出来的是上周五的重复），
 * 没到该源的最早时刻不存（存进去的是半天数据）。
 * 页面随机访问一律走 `persist=false`，不受这里约束。
 */
export function canPersistSnapshot(
  source: DailySnapshotSource,
  now: Date = new Date(),
): { ok: boolean; reason: string } {
  if (!isTradingDay(now)) {
    return { ok: false, reason: `今天不是交易日，不写 ${LABEL[source]} 快照` };
  }
  const earliest = SNAPSHOT_EARLIEST_SAVE[source];
  const clock = shanghaiClock(now);
  if (clock < earliest) {
    return {
      ok: false,
      reason: `${LABEL[source]}要等 ${earliest} 之后才算得准，现在 ${clock} 存进去的是半天数据`,
    };
  }
  return { ok: true, reason: '' };
}

/**
 * 该源此刻「应该已经有数据」的那个交易日。
 *
 * 这是新鲜度判定的基准，不是自然日今天。板块宽度 15:25 才产出，
 * 拿「是不是今天的」去判它，盘中全程都会被判过期——而过期又会连锁挡住买入动作。
 * 正确的问法是「按它的产出时刻，现在最新应该是哪天的」。
 */
export function expectedSnapshotDate(
  source: DailySnapshotSource,
  now: Date = new Date(),
): string {
  const today = shanghaiToday(now);
  const produced = isTradingDay(now) && shanghaiClock(now) >= SNAPSHOT_EARLIEST_SAVE[source];
  return produced ? today : prevTradingDay(today);
}

/**
 * 实际快照日落后预期多少个**交易日**。
 *
 * 必须按交易日算而不是自然日：周末隔两天、长假隔一周，按自然日会天天报警，
 * 把人训练成「黄灯是常态」，真断供时反而看不见。
 *
 * @returns 0 = 及时；正数 = 落后几个交易日；null = 压根没有数据
 */
export function snapshotBehindDays(
  actual: string | null,
  expected: string,
): number | null {
  if (!actual) return null;
  if (actual >= expected) return 0;
  let cursor = expected;
  // 上限防呆：超过 60 个交易日就不必再数了，早就是断供
  for (let n = 1; n <= 60; n += 1) {
    cursor = prevTradingDay(cursor);
    if (actual >= cursor) return n;
  }
  return 60;
}
