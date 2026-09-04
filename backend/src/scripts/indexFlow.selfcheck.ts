// 指数资金流统计自检（无框架，assert 断言，不碰网络与数据库）。
//
// 钉的是「样本不够却照样下结论」这一类错误。它们不报错、不崩，只是给出一个
// 看起来很像那么回事的方向，而用户会拿它决定加不加仓。具体四种：
//   断档的序列被拼成连续的、不足 20 日就给强弱、1 强 3 中被判成整组偏强、
//   混了短样本的组却说得像有完整历史。
//
// 运行：cd backend && pnpm exec tsx src/scripts/indexFlow.selfcheck.ts
import assert from 'node:assert/strict';
import type { IndexFundFlow, IndexFundFlowDay } from '@stock-agent/shared';
import { shiftTradingDays } from '../market/calendar';
import { buildSummary, computeStats, continuousTail, voteGroup } from '../indexflow/stats';
import { INDEX_FLOW_DEFS } from '../indexflow/defs';

const END = '2026-08-27'; // 周四，交易日

/** 造一段以 END 结尾、长度 n 的连续交易日序列；values 从旧到新 */
function series(values: number[]): IndexFundFlowDay[] {
  const n = values.length;
  return values.map((main, i) => ({
    date: shiftTradingDays(END, -(n - 1 - i)),
    main,
    pct: 0,
  }));
}

function toMap(days: IndexFundFlowDay[]): Map<string, IndexFundFlowDay> {
  return new Map(days.map((d) => [d.date, d]));
}

/** 造一个带指定序列的指数条目 */
function item(secid: string, values: number[]): IndexFundFlow {
  const def = INDEX_FLOW_DEFS.find((d) => d.secid === secid)!;
  const days = series(values);
  return { code: def.code, name: def.name, secid, group: def.group, days, stats: computeStats(days) };
}

// ===== 1. 断档：跨过缺口的行绝不能拼进同一段 =====
{
  const full = series(Array.from({ length: 30 }, (_, i) => i + 1));
  assert.equal(continuousTail(toMap(full)).length, 30, '无缺口时应取满全段');

  // 挖掉中间一天：连续段只能从缺口之后算起
  const holed = toMap(full);
  holed.delete(full[10].date);
  const tail = continuousTail(holed);
  assert.equal(tail.length, 19, '缺口之前的记录不得跨过缺口接上来');
  assert.equal(tail[0].date, full[11].date, '连续段应始于缺口之后的第一天');

  assert.equal(continuousTail(new Map()).length, 0, '无记录返回空段');
}

// ===== 2. 样本门槛：不足 20 日一个字的方向都不能给 =====
{
  const short = computeStats(series(Array.from({ length: 19 }, () => 5)))!;
  assert.equal(short.tier, 'insufficient');
  assert.equal(short.level, 'unknown', '19 日不得给出任何强弱档位');
  assert.equal(short.rank5, null, '19 日不得给出排名数字');

  const tentative = computeStats(series(Array.from({ length: 20 }, (_, i) => i)))!;
  assert.equal(tentative.tier, 'tentative', '20 日进入暂定档');
  assert.notEqual(tentative.level, 'unknown', '20 日应能给出档位');

  const full = computeStats(series(Array.from({ length: 40 }, (_, i) => i)))!;
  assert.equal(full.tier, 'full', '40 日进入正常档');

  assert.equal(computeStats([]), null, '空序列没有统计量');
}

// ===== 3. rank5：并列走中位排名，整段相同时应为 50 而不是 0 或 100 =====
{
  const flat = computeStats(series(Array.from({ length: 30 }, () => 0)))!;
  assert.equal(flat.rank5, 50, '整段数值相同意味着毫无差别，不能读成极端值');
  assert.equal(flat.level, 'neutral');
  assert.equal(flat.streak, 0, '最近一日为零时不算连续流入或流出');

  // 单调上升：最近 5 日累计必然是历史最高，应判偏强
  const rising = computeStats(series(Array.from({ length: 40 }, (_, i) => i)))!;
  assert.ok(rising.rank5! > 90, '一路走高时最近 5 日应排在最前列');
  assert.equal(rising.level, 'strong');
  assert.equal(rising.windows, 36, '40 日只能切出 36 个可比较的 5 日区间');

  // 单调下降：应判偏弱
  const falling = computeStats(series(Array.from({ length: 40 }, (_, i) => -i)))!;
  assert.ok(falling.rank5! < 10);
  assert.equal(falling.level, 'weak');
  assert.equal(falling.streak, -39, '除首日 0 外连续 39 天净流出');

  // 档位偏强但金额仍可能为负：它比的是相对位置，界面必须同时保留原始金额
  const negative = computeStats(series(Array.from({ length: 40 }, (_, i) => -100 + i)))!;
  assert.equal(negative.level, 'strong', '相对自身历史在改善');
  assert.ok(negative.sum5! < 0, '但绝对金额仍是净流出');
}

// ===== 4. 分组投票：方向票不足 2 张不得判方向 =====
{
  const rise = Array.from({ length: 40 }, (_, i) => i);
  const flat = Array.from({ length: 40 }, () => 0);

  // 1 强 3 中——这不是多数，绝不能判成整组偏强
  const onlyOne = [
    item('1.000300', rise),
    item('1.000016', flat),
    item('1.000510', flat),
    item('1.000001', flat),
  ];
  const v1 = voteGroup(onlyOne, 'large');
  assert.equal(v1.strong, 1);
  assert.equal(v1.rated, 4);
  assert.equal(v1.level, 'unknown', '只有 1 张方向票时必须判方向不明');

  // 2 强 2 中：够 2 张方向票，可以判
  const two = [
    item('1.000300', rise),
    item('1.000016', rise),
    item('1.000510', flat),
    item('1.000001', flat),
  ];
  assert.equal(voteGroup(two, 'large').level, 'strong');

  // 平票：不设任何 tie-breaker，尤其不比金额
  const tied = [
    item('1.000300', rise),
    item('1.000016', Array.from({ length: 40 }, (_, i) => -i)),
    item('1.000510', flat),
    item('1.000001', flat),
  ];
  const vTied = voteGroup(tied, 'large');
  assert.equal(vTied.strong, 1);
  assert.equal(vTied.weak, 1);
  assert.equal(vTied.level, 'unknown', '一强一弱是平票，不许挑一边');

  // 有档位的指数不足 2 个 → 数据不全
  const scarce = [item('1.000300', rise), item('1.000016', rise.slice(0, 10))];
  assert.equal(voteGroup(scarce, 'large').rated, 1);
  assert.equal(voteGroup(scarce, 'large').level, 'unknown', '只有一个有效指数不足以判整组');
}

// ===== 5. 组级样本档继承组内最低的一档 =====
{
  const rise40 = Array.from({ length: 40 }, (_, i) => i);
  const rise25 = Array.from({ length: 25 }, (_, i) => i);
  const mixed = [item('1.000300', rise40), item('1.000016', rise25)];
  const v = voteGroup(mixed, 'large');
  assert.equal(v.level, 'strong');
  assert.equal(v.tier, 'tentative', '混了 25 日的指数，整组只能说暂时');
}

// ===== 6. 结论文案：说法必须跟得住样本 =====
{
  const rise40 = Array.from({ length: 40 }, (_, i) => i);
  const fall40 = Array.from({ length: 40 }, (_, i) => -i);
  const short = Array.from({ length: 8 }, (_, i) => i);

  // 不足 20 日：一个方向字都不许出现
  const early = buildSummary([item('1.000300', short), item('1.000905', short)]);
  assert.equal(early.actionable, false);
  assert.ok(early.text.includes('8 个交易日'), '要如实说出记录了几天');
  assert.ok(!early.text.includes('偏强') && !early.text.includes('偏弱'), '样本不足时不许出现方向');

  // 完全没有记录
  const empty = buildSummary(INDEX_FLOW_DEFS.map((d) => item(d.secid, [])));
  assert.equal(empty.maxDays, 0);
  assert.ok(empty.text.includes('还没有记录'));

  // 大盘强、中小盘弱：两组都判出方向才允许出现对比
  const contrast = buildSummary([
    item('1.000300', rise40),
    item('1.000016', rise40),
    item('1.000905', fall40),
    item('1.000852', fall40),
  ]);
  assert.ok(contrast.text.includes('大盘蓝筹'), '两组都判出方向时应给对比');
  assert.equal(contrast.actionable, true);
  assert.ok(!contrast.text.includes('暂时'), '全部 40 日以上不该降级成暂时');

  // 一组判得出、一组数据不全：只能分别陈述，不许给对比
  const partial = buildSummary([item('1.000300', rise40), item('1.000016', rise40)]);
  assert.equal(partial.actionable, false);
  assert.ok(partial.text.includes('数据不全'), '缺样本的那组要明说数据不全');
  assert.ok(!partial.text.includes('更愿意进'), '有一组判不出就不许给两组对比');
}

// ===== 7. 指数清单：分组构成不能被悄悄改坏 =====
{
  assert.equal(INDEX_FLOW_DEFS.length, 10);
  const large = INDEX_FLOW_DEFS.filter((d) => d.group === 'large');
  const small = INDEX_FLOW_DEFS.filter((d) => d.group === 'small');
  assert.ok(large.length >= 2 && small.length >= 2, '每组至少 2 个才可能凑够方向票');
  assert.ok(
    INDEX_FLOW_DEFS.some((d) => d.secid === '1.000300'),
    '沪深300 是最主流的宽基，必须在清单里',
  );
  assert.equal(new Set(INDEX_FLOW_DEFS.map((d) => d.secid)).size, 10, 'secid 不得重复');
}

console.log('指数资金流统计自检通过：断档、样本门槛、并列排名、票数门槛、样本档继承、文案降级');
