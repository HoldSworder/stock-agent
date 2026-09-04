// 快照断档自检（无框架，assert 断言，不碰网络与数据库）。
//
// 钉的是「快照漏跑之后系统会不会撒谎」这一类错误。它们的共同特征是不报错、不崩，
// 只是安静地给出一个错的数字——实测 regime 表断续成 8-28 / 8-20 / 8-18 / 8-07，
// 而「已连续 N 天处于某阶段」照样算得有鼻子有眼。这种错误没有自检就发现不了。
//
// 运行：cd backend && pnpm exec tsx src/scripts/snapshotGap.selfcheck.ts
import assert from 'node:assert/strict';
import {
  SNAPSHOT_EARLIEST_SAVE,
  canPersistSnapshot,
  expectedSnapshotDate,
  snapshotBehindDays,
  type DailySnapshotSource,
} from '../scheduling/snapshotWindow';
import { prevTradingDay } from '../market/calendar';

/** 造一个「上海时间为指定时刻」的 Date。用固定交易日 2026-08-27（周四）避开周末 */
function at(clock: string, day = '2026-08-27'): Date {
  return new Date(`${day}T${clock}:00+08:00`);
}

const SOURCES: DailySnapshotSource[] = ['sentiment', 'regime', 'indexFlow', 'breadth'];

// ===== 1. 落盘闸门：时刻不到一律不许存 =====
{
  for (const s of SOURCES) {
    const earliest = SNAPSHOT_EARLIEST_SAVE[s];
    // 盘中随手触发：存进去的是半天数据，必须拒绝
    const mid = canPersistSnapshot(s, at('11:00'));
    assert.equal(mid.ok, false, `${s} 盘中不得落盘`);
    assert.ok(mid.reason.includes(earliest), '拒绝时要说清要等到几点');

    // 刚收盘还没到该源的时刻：日线可能还没回填完
    const justClosed = canPersistSnapshot(s, at('15:02'));
    assert.equal(justClosed.ok, false, `${s} 15:02 还太早（日线回填未完成）`);

    // 到点之后放行
    const [h, m] = earliest.split(':').map(Number);
    const after = new Date(at(earliest).getTime() + 60_000);
    assert.equal(canPersistSnapshot(s, after).ok, true, `${s} 过了 ${earliest} 应放行`);
    assert.ok(h === 15 && m >= 10, '三个源都应排在收盘且日线回填之后');
  }
}

// 三个源必须错峰，不能撞在同一分钟一起抢上游
{
  const times = SOURCES.map((s) => SNAPSHOT_EARLIEST_SAVE[s]);
  assert.equal(new Set(times).size, times.length, '三个日频快照的落盘时刻必须互不相同');
}

// 非交易日一律不存：周末算出来的是上周五的重复，写进去会挤占连续交易日序列
{
  for (const s of SOURCES) {
    const sat = canPersistSnapshot(s, at('16:00', '2026-08-29'));
    assert.equal(sat.ok, false, `${s} 周末不得落盘`);
    assert.ok(sat.reason.includes('交易日'), '拒绝原因要说明是非交易日');
  }
}

// ===== 2. 预期快照日：按各源产出时刻，不按自然日 =====
{
  // 盘中：板块快照 15:25 才产出，此刻「最新应该有的」是上一交易日
  const midday = expectedSnapshotDate('breadth', at('11:00'));
  assert.equal(midday, prevTradingDay('2026-08-27'), '未到产出时刻，预期日应为上一交易日');

  // 过了产出时刻：预期就是今天
  assert.equal(
    expectedSnapshotDate('breadth', at('15:30')),
    '2026-08-27',
    '过了产出时刻，预期日应为当日',
  );

  // 同一时刻不同源的预期日可以不同——15:18 时情绪已产出、板块还没
  assert.equal(expectedSnapshotDate('sentiment', at('15:18')), '2026-08-27');
  assert.equal(expectedSnapshotDate('breadth', at('15:18')), prevTradingDay('2026-08-27'));
}

// ===== 3. 落后天数按交易日算，不按自然日 =====
{
  const expected = '2026-08-27';
  assert.equal(snapshotBehindDays('2026-08-27', expected), 0, '当天不算落后');
  assert.equal(snapshotBehindDays('2026-08-28', expected), 0, '比预期还新也算及时');
  assert.equal(snapshotBehindDays(prevTradingDay(expected), expected), 1, '落后一个交易日');
  assert.equal(snapshotBehindDays(null, expected), null, '没有数据不是「落后 0 天」');

  // 跨周末不得被算成多天：周一的预期对上周五的数据只落后 1 个交易日，不是 3 个自然日
  const mon = '2026-08-31';
  const fri = prevTradingDay(mon);
  assert.equal(snapshotBehindDays(fri, mon), 1, '跨周末只算 1 个交易日，否则周一必然误报');

  // 断档三周：要能数出一个明显大的天数，而不是饱和成 1
  const old = snapshotBehindDays('2026-08-06', '2026-08-27');
  assert.ok(old != null && old >= 10, `三周断档应报出较大落后天数，实际 ${old}`);
}

console.log('snapshotGap.selfcheck 全部通过');
