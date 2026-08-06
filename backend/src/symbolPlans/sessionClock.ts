import type { KlinePeriod } from '@stock-agent/shared';
import { shanghaiClock, shanghaiToday } from '../util';

// 「当根 K 线是否已收完」的唯一判据。求值层与证据层必须共用，
// 否则 15:00 整点两处会给出相反结论（一处 < 900、一处 <= 900）。
//
// 判据按周期分三类，实测东财时间戳约定（2026-08-06 10:50 探针）：
// - 日线：time='YYYY-MM-DD'，当日那根在 15:00 前未收完；
// - 分钟线：time 是该 bar 的**结束**时刻，如 60m 为 10:30/11:30/14:00/15:00，
//   15m 为 09:45/10:00/…；因此「现在早于结束时刻」即未收完；
// - 周/月线：time 是该周期内**目前最后一个交易日**的日期（本周的周 bar 在周四时 time 就是周四），
//   不是周五/月末，所以不能拿它跟今天比，只能判它落在当前周/月内。
//
// 早先只有一套「日期==今天 && 时钟<15:00」的判据，对后两类都是错的：
// 一根仍在走的周 K 只要最后交易日不是今天就被当成已收完（周五盘中拿半周数据做周线金叉判定），
// 而一根早已收完的 60m bar 只要日期是今天、时间早于 15:00 就被当成未收完（白白丢掉一根）。

/** 收盘分钟数（上海时间 15:00）。到点即视为当日 K 已收完 */
const CLOSE_MINUTE = 15 * 60;

/** 上海时区的分钟数 */
function nowMinute(now: Date): number {
  const [h, m] = shanghaiClock(now).split(':');
  return Number(h) * 60 + Number(m);
}

/** 上海时区的星期几，0=周日 */
function shanghaiWeekday(now: Date): number {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
  }).format(now);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(s);
}

/** 'YYYY-MM-DD' 所在自然周的周一（按上海时区的日期字符串比较，不涉时区换算） */
function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const wd = d.getUTCDay(); // 0=周日
  const back = wd === 0 ? 6 : wd - 1;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/**
 * 最后一根 K 线是否还没收完。
 *
 * 日线判据只用「数据日期 + 时钟」，**不要求处于连续竞价时段**：
 * - 按时段判会把 11:30–13:00 午休判成非交易中，于是 11:35 的定时任务会把当天半根日 K
 *   当成已收盘数据去做失效判定与量能确认；
 * - 反过来，法定假日虽是工作日，但最后一根 bar 的日期不会是今天，因此不会被误判为未收完。
 *
 * 周/月线一律**从宽判未收完**：无从得知本周/本月最后一个交易日是哪天（假日不定），
 * 宁可把一根已收完的周 K 判成未收完（该周期条件本轮不参与，下轮再说），
 * 也不能把半周数据当成已收完去做一次性的金叉判定并就此标记已见。
 *
 * @param period bar 所属周期
 * @param lastBarTime 最后一根 bar 的时间（'YYYY-MM-DD' 或 'YYYY-MM-DD HH:mm'）
 */
export function isBarUnclosed(
  period: KlinePeriod,
  lastBarTime: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastBarTime) return false;
  const barDate = lastBarTime.slice(0, 10);
  const today = shanghaiToday(now);

  if (period === 'week') {
    // 落在本周内即视为未收完，直到周五 15:00
    if (mondayOf(barDate) !== mondayOf(today)) return false;
    const wd = shanghaiWeekday(now);
    if (wd === 0 || wd === 6) return false; // 周末：本周已经走完
    return !(wd === 5 && nowMinute(now) >= CLOSE_MINUTE);
  }

  if (period === 'month') {
    if (barDate.slice(0, 7) !== today.slice(0, 7)) return false;
    // 只有当天就是本月最后一个自然日、且已过收盘，才敢认定本月收完
    const lastDay = new Date(
      Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0),
    )
      .toISOString()
      .slice(0, 10);
    return !(today === lastDay && nowMinute(now) >= CLOSE_MINUTE);
  }

  if (period === 'day') {
    if (barDate !== today) return false;
    return nowMinute(now) < CLOSE_MINUTE;
  }

  // 分钟级：时间戳是 bar 的结束时刻，现在还没到结束时刻就是没收完
  if (barDate !== today) return false;
  const hm = lastBarTime.slice(11, 16);
  if (!/^\d{2}:\d{2}$/.test(hm)) return nowMinute(now) < CLOSE_MINUTE; // 无时分，退回日线口径
  const endMinute = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  return nowMinute(now) < endMinute;
}
