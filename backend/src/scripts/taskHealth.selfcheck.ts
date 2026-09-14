// 任务健康判定自检（无框架，assert 断言；纯计算，不碰 DB/网络）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/taskHealth.selfcheck.ts
//
// 钉住的行为：三种「没在跑」必须分开——被关掉 / 该跑没跑 / 还没到点。
// 混成一个「暂无数据」，就是实测里那个「持仓纪律体检连续四个交易日缺席无人察觉」的成因。
import assert from 'node:assert/strict';
import { lastExpectedSlot } from '../scheduling/cronSlots';

const TZ = 'Asia/Shanghai';
const sh = (s: string): Date => new Date(`${s}+08:00`);
/** Date → 上海 'DD-MM HH:MM'（Intl en-GB 的日月序，只用于断言比对） */
const stamp = (d: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(d)
    .replace(/\//g, '-')
    .replace(', ', ' ');

// ===== lastExpectedSlot：跨天回溯 =====

// 1. 当天已过点，取当天的槽位
assert.equal(
  stamp(lastExpectedSlot('40 14 * * 1-5', TZ, sh('2026-09-11T16:00:00'))!),
  '11-09 14:40',
  '当天已过点应取当天槽位',
);

// 2. 当天还没到点，回退到最近一个有槽位的更早日期。
//    只看今天（previousScheduledSlot 的语义）会返回 null，
//    上层就会把「已经三天没跑」误判成「今天还没到点，一切正常」。
assert.equal(
  stamp(lastExpectedSlot('40 14 * * 1-5', TZ, sh('2026-09-11T09:00:00'))!),
  '10-09 14:40',
  '当天未到点应回退到前一个工作日',
);

// 3. 周末：工作日任务在周六没有槽位，必须回退到周五，而不是判为「无从谈起」
assert.equal(
  stamp(lastExpectedSlot('40 14 * * 1-5', TZ, sh('2026-09-12T10:00:00'))!),
  '11-09 14:40',
  '周六应回退到周五的槽位',
);

// 4. skip 回调可跳过整段日期（法定节假日场景），继续往更早找
assert.equal(
  stamp(
    lastExpectedSlot(
      '40 14 * * 1-5',
      TZ,
      sh('2026-09-11T16:00:00'),
      (at) => stamp(at).startsWith('11-09') || stamp(at).startsWith('10-09'),
    )!,
  ),
  '09-09 14:40',
  '被 skip 跳过的槽位不算数，应继续往前找',
);

// 5. 回溯上限之外返回 null：每年一次的任务两周内找不到槽位，
//    此时应判为「不可判」而不是随便给一个时刻——给错时刻比不给更糟
assert.equal(
  lastExpectedSlot('0 3 1 1 *', TZ, sh('2026-09-11T16:00:00')),
  null,
  '超出回溯上限应返回 null，不得给出错误时刻',
);

// 6. 非法表达式不抛错
assert.equal(lastExpectedSlot('这不是 cron', TZ, sh('2026-09-11T16:00:00')), null);

// ===== 健康状态判定 =====
//
// jobHealth 依赖已注册的 job 与 settings 水位线，此处只钉判定规则本身，
// 用与其完全一致的三行逻辑复刻，避免为测试去启动整个 fastify 与 DB。
type Status = 'ok' | 'overdue' | 'disabled' | 'idle';
const GRACE_MS = 10 * 60 * 1000;
const decide = (
  enabled: boolean,
  expected: Date | null,
  lastSuccess: string | null,
  now: Date = sh('2026-09-11T16:00:00'),
): Status => {
  if (!enabled) return 'disabled';
  if (!expected) return 'idle';
  if (lastSuccess && new Date(lastSuccess).getTime() >= expected.getTime()) return 'ok';
  if (now.getTime() - expected.getTime() < GRACE_MS) return 'idle';
  return 'overdue';
};

const expected = sh('2026-09-11T14:40:00');

// 7. 被关掉的任务永远不算故障，哪怕它三个月没跑过——那是预期内的
assert.equal(decide(false, expected, null), 'disabled');
assert.equal(decide(false, expected, '2026-06-18T06:40:00Z'), 'disabled');

// 8. 该跑没跑：有应触发时刻，但其后没有成功记录
assert.equal(decide(true, expected, null), 'overdue', '从未成功过且已过点 = 该跑没跑');
assert.equal(
  decide(true, expected, '2026-09-07T06:40:00Z'),
  'overdue',
  '最后成功早于应触发时刻 = 该跑没跑（实测的持仓纪律体检即此情形）',
);

// 9. 正常：应触发时刻之后有成功记录
assert.equal(decide(true, expected, '2026-09-11T06:40:00Z'), 'ok');

// 10. 还没到点：算不出应触发时刻时不下故障结论
assert.equal(decide(true, null, null), 'idle', '算不出应触发时刻时不得判为故障');

// 11. 宽限期内不报警。任务本身要跑一会儿、服务重启会错过一两拍、互斥锁会让本次跳过，
//     刚过点就标红会让每十分钟一次的任务频繁误报——红得太容易，人就不看了
assert.equal(
  decide(true, expected, null, sh('2026-09-11T14:45:00')),
  'idle',
  '过点 5 分钟仍在宽限期内，不得报警',
);
assert.equal(
  decide(true, expected, null, sh('2026-09-11T14:55:00')),
  'overdue',
  '过点 15 分钟超出宽限期，必须报警',
);

console.log(
  '✅ 任务健康自检通过：跨天回溯 / 周末回退 / 节假日跳过 / 宽限期 / 关闭与故障分开',
);
