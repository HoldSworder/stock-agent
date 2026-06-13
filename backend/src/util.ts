import { randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();

/**
 * 是否处于 A 股连续竞价交易时段：周一至周五 09:30-11:30 与 13:00-15:00（Asia/Shanghai）。
 * 注意：仅按星期与时段判断，未排除法定节假日。
 */
export function isAShareTradingTime(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const m = hour * 60 + minute;
  const am = m >= 9 * 60 + 30 && m <= 11 * 60 + 30;
  const pm = m >= 13 * 60 && m <= 15 * 60;
  return am || pm;
}

/** Asia/Shanghai 当前自然日 YYYY-MM-DD（用于今日计划等按交易日归属） */
export function shanghaiToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Asia/Shanghai 当前时间 HH:mm，用于交易时段提示 */
export function shanghaiClock(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}
