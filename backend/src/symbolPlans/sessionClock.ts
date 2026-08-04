import { shanghaiClock, shanghaiToday } from '../util';

// 「当根 K 线是否已收完」的唯一判据。求值层与证据层必须共用，
// 否则 15:00 整点两处会给出相反结论（一处 < 900、一处 <= 900）。

/** 收盘分钟数（上海时间 15:00）。到点即视为当日 K 已收完 */
const CLOSE_MINUTE = 15 * 60;

/**
 * 最后一根 K 线是否还没收完。
 *
 * 判据只用「数据日期 + 时钟」，**不要求处于连续竞价时段**：
 * - 按时段判会把 11:30–13:00 午休判成非交易中，于是 11:35 的定时任务会把当天半根日 K
 *   当成已收盘数据去做失效判定与量能确认；
 * - 反过来，法定假日虽是工作日，但最后一根 bar 的日期不会是今天，因此不会被误判为未收完，
 *   这条数据侧判据已经替代了原先的星期/时段过滤。
 *
 * @param lastBarTime 最后一根 bar 的时间（'YYYY-MM-DD' 或 'YYYY-MM-DD HH:mm'）
 */
export function isBarUnclosed(lastBarTime: string | null | undefined, now: Date = new Date()): boolean {
  if (!lastBarTime) return false;
  if (lastBarTime.slice(0, 10) !== shanghaiToday(now)) return false;
  const [h, m] = shanghaiClock(now).split(':');
  return Number(h) * 60 + Number(m) < CLOSE_MINUTE;
}
