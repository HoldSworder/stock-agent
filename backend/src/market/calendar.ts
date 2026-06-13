// chinese-days 的 main 为压缩 CJS，Node ESM 无法静态识别其具名导出，
// 故走默认导入再解构（默认导入即 module.exports 对象，含 isHoliday 等方法）。
import chineseDays from 'chinese-days';

const { isHoliday } = chineseDays;

// A 股交易日历：复用 chinese-days（MIT、零依赖、数据源自国务院公告，含调休）做确定性判定，
// 不自造节假日表。统一用 Asia/Shanghai 时区计算「今天」。

/** Asia/Shanghai 的 YYYY-MM-DD */
export function shanghaiDateStr(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Asia/Shanghai 的 HH:mm */
export function shanghaiTimeStr(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function shanghaiYmd(date: Date): string {
  return shanghaiDateStr(date);
}

/** Asia/Shanghai 是否周一至五 */
function isShanghaiWeekday(date: Date): boolean {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
  }).format(date);
  return wd !== 'Sat' && wd !== 'Sun';
}

/**
 * 是否 A 股交易日：周一至五 且 非法定节假日。
 * 调休补班的周六/周日 A 股不开市，故只要落在周末一律 false（不依赖 isWorkday 的补班语义）。
 */
export function isTradingDay(date: Date = new Date()): boolean {
  if (!isShanghaiWeekday(date)) return false;
  return !isHoliday(shanghaiYmd(date));
}

/**
 * 定时任务节假日 gate：是否应因节假日跳过。
 * 仅对「工作日触发」的任务生效——周一至五但当天为法定节假日时跳过；
 * 周末触发的任务（如周日周度扫描）不受影响，照常运行。
 */
export function shouldSkipForHoliday(date: Date = new Date()): boolean {
  return isShanghaiWeekday(date) && isHoliday(shanghaiYmd(date));
}
