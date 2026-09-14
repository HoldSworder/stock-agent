import { Cron } from 'croner';
import { shanghaiDateStr } from '../market/calendar';

// missed-run 判定所需的「上一次应触发时刻」推算。
//
// 为什么不能用 croner 的 previousRun()：它返回的是该 Cron 实例**实际执行过**的上一次时间。
// 两处 catchUp 都在 reloadScheduler() / register 之后立刻调用，实例刚建、一次都没跑过，
// previousRun() 必为 null，循环第一步就 continue——整条「停机期间被错过」的告警链路是死代码
// （服务停机跨过 14:45 尾盘选股，重启后不会有任何提示）。

/** 逐槽前推的上限：兜住「每分钟」这类高频表达式，1440 槽即一整天 */
const MAX_SLOTS = 1500;

/**
 * 某 cron 表达式在「今日（上海）零点 ~ now」区间内最后一个应触发时刻，没有则 null。
 * 以今日零点为基准用 nextRun 逐槽前推，与 previousRun 的语义无关，不依赖实例是否跑过。
 *
 * 两处边界：
 * - 起点回退 1ms：nextRun 返回的是**严格晚于** cursor 的时刻，起点正好是零点时，
 *   `0 0 * * *` 这类每日零点任务永远算不出当日槽位，missed-run 判定被静默跳过。
 * - 槽位打满返回 null：croner 支持 6 段秒级表达式（每 30 秒一次即一天 2880 槽），
 *   此时 last 停在凌晨某个残缺时刻，会打印错误的「应于 00:25 触发」，
 *   `prev.getTime() <= lastCheck` 的幂等水位线也跟着判错。宁可不判也不给错时刻。
 */
export function previousScheduledSlot(
  cronExpr: string,
  tz: string,
  now: Date = new Date(),
): Date | null {
  let cron: Cron;
  try {
    // 不传回调：croner 此时只作表达式计算器，不会真的排程
    cron = new Cron(cronExpr, { timezone: tz });
  } catch {
    return null;
  }
  const midnight = new Date(`${shanghaiDateStr(now)}T00:00:00+08:00`);
  if (Number.isNaN(midnight.getTime())) return null;
  let cursor: Date = new Date(midnight.getTime() - 1);
  let last: Date | null = null;
  for (let i = 0; i < MAX_SLOTS; i++) {
    const next = cron.nextRun(cursor);
    if (!next || next.getTime() > now.getTime()) return last;
    last = next;
    cursor = next;
  }
  return null; // 槽位打满：last 只是当日靠前的某一槽，给出去会误导，直接判为不可判
}

/** 往回翻的天数上限。超过两周没跑的任务，具体落后几天已经不重要，都是「早就停了」 */
const MAX_LOOKBACK_DAYS = 14;

/**
 * 某 cron 表达式在 now 之前最后一个应触发时刻，跨天回溯，没有则 null。
 *
 * 与 previousScheduledSlot 的区别只在范围：后者只看今天，用于「今天该跑的跑了没」；
 * 本函数往回翻最多两周，用于回答「这个任务上一次本该在什么时候跑」——
 * 像每周一次或工作日任务在周末这种情形，今天根本没有槽位，只看今天会误判成一切正常。
 *
 * skip 回调用于跳过不该触发的日子（法定节假日）。返回 true 表示该时刻不算数，继续往前找。
 */
export function lastExpectedSlot(
  cronExpr: string,
  tz: string,
  now: Date = new Date(),
  skip?: (at: Date) => boolean,
): Date | null {
  for (let back = 0; back <= MAX_LOOKBACK_DAYS; back++) {
    // 第 0 天用真实 now（当天只算已经过去的槽位），更早的日子取当日 23:59:59.999 拿全天最后一槽
    const probe =
      back === 0
        ? now
        : new Date(`${shanghaiDateStr(new Date(now.getTime() - back * 86400000))}T23:59:59.999+08:00`);
    if (Number.isNaN(probe.getTime())) continue;
    const slot = previousScheduledSlot(cronExpr, tz, probe);
    if (!slot) continue;
    if (skip?.(slot)) continue;
    return slot;
  }
  return null;
}
