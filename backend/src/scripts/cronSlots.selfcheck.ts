// 「上一次应触发时刻」推算自检（无框架，assert 断言；纯计算，不碰 DB/网络）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/cronSlots.selfcheck.ts
import assert from 'node:assert/strict';
import { previousScheduledSlot } from '../scheduling/cronSlots';

const TZ = 'Asia/Shanghai';
/** 上海时刻 → Date */
const sh = (s: string): Date => new Date(`${s}+08:00`);
/** Date → 上海 'HH:MM' */
const hhmm = (d: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);

// 1. 常规分钟级表达式：取今日零点以来最后一个已过的槽位
assert.equal(hhmm(previousScheduledSlot('45 14 * * *', TZ, sh('2026-08-07T15:30:00'))!), '14:45');
assert.equal(
  previousScheduledSlot('45 14 * * *', TZ, sh('2026-08-07T09:00:00')),
  null,
  '当日尚未到点则无槽位',
);

// 2. 恰好落在零点的任务：nextRun 返回的是**严格晚于** cursor 的时刻，
//    起点不回退一毫秒的话当日零点这一槽永远算不出来，missed-run 判定被静默跳过
const midnightSlot = previousScheduledSlot('0 0 * * *', TZ, sh('2026-08-07T08:00:00'));
assert.ok(midnightSlot, '每日零点任务必须能算出当日槽位');
assert.equal(hhmm(midnightSlot), '00:00');

// 3. 秒级表达式（每 30 秒，一天 2880 槽）超出前推上限：宁可返回 null，
//    也不能把停在凌晨的残缺槽位当成「应于 XX:XX 触发」报出去，幂等水位线也会跟着判错
assert.equal(
  previousScheduledSlot('0/30 * * * * *', TZ, sh('2026-08-07T15:30:00')),
  null,
  '槽位打满必须返回 null，而不是当日靠前的某一槽',
);

// 4. 非法表达式不抛错
assert.equal(previousScheduledSlot('这不是 cron', TZ, sh('2026-08-07T15:30:00')), null);

console.log('✅ cron 槽位推算自检通过：零点槽可判 / 槽位打满返回 null / 非法表达式不抛错');
