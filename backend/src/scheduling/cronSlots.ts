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
