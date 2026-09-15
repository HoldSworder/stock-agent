// 核实清仓行该用哪个字段当已实现盈亏（工单 04-C 的实际产出）。
//
// thsAccountCap.probe.ts 查明：投资账本是上传型持仓跟踪产品（account_list 里有
// access_upload / upload_time / brokername），**没有逐笔成交**，抓包也抓不到。
//
// 但它按持仓给了几个我们没读的字段：
//   close_profit / close_rate  已平仓盈亏与收益率
//   fee                        累计手续费
//   come_profit                （待查）
//
// 而现有代码的 toClosed() 拿 hold_profit 当清仓行的已实现盈亏。
// hold_profit 是**持有**盈亏，对 count=0 的行按定义应该是 0 或过期值；
// 已实现的那个数在 close_profit 里。若两者不同，台账记的就是错数。
//
// 跑法：cd backend && ./node_modules/.bin/tsx src/scripts/thsClosedProfit.probe.ts

import { __test__thsPost, __test__THS_BASE } from '../realPositions';
import { getValue } from '../settings';
import { num } from '../datasource/codes';

const userId = getValue('thsUserId');
if (!userId) {
  console.error('同花顺 UID 未配置');
  process.exit(1);
}
const fundKeys = (getValue('thsFundKeys') ?? '').split(/[,，\s]+/).filter(Boolean);

for (const fundKey of fundKeys.length > 0 ? fundKeys : ['']) {
  const ex = (await __test__thsPost(`${__test__THS_BASE}/pc/asset/v1/stock_position`, {
    terminal: '1',
    version: '0.0.0',
    userid: userId,
    user_id: userId,
    manual_id: '',
    fund_key: fundKey,
    rzrq_fund_key: '',
  })) as { position?: unknown };

  const list = Array.isArray(ex.position) ? (ex.position as Array<Record<string, unknown>>) : [];
  const held = list.filter((p) => num(p.count) > 0);
  const closed = list.filter((p) => num(p.count) <= 0);

  console.log(`\n=== fund_key ${fundKey.slice(0, 8)}…  持仓 ${held.length} 行，清仓 ${closed.length} 行 ===\n`);

  const show = (p: Record<string, unknown>, tag: string) => {
    console.log(
      `  ${tag} ${String(p.name)}(${String(p.code)}) 股数=${num(p.count)}\n` +
        `      hold_profit=${num(p.hold_profit)}  close_profit=${num(p.close_profit)}  ` +
        `come_profit=${num(p.come_profit)}\n` +
        `      hold_rate=${num(p.hold_rate)}  close_rate=${num(p.close_rate)}  fee=${num(p.fee)}`,
    );
  };

  // 持仓行：看 close_profit 是不是「这只票历史上已经卖掉那部分赚的钱」
  for (const p of held.slice(0, 5)) show(p, '[持仓]');
  // 清仓行：这才是关键——台账该记哪个数
  for (const p of closed.slice(0, 8)) show(p, '[清仓]');

  if (closed.length === 0) {
    console.log('  今天没有清仓行，无法直接对比。但持仓行的 close_profit 已能说明它的语义。');
  }

  // 汇总：累计手续费目前被完全丢弃，而它直接影响真实收益
  const totalFee = list.reduce((s, p) => s + num(p.fee), 0);
  const totalClose = list.reduce((s, p) => s + num(p.close_profit), 0);
  console.log(
    `\n  这个账户累计：已平仓盈亏 ${totalClose.toFixed(2)}  手续费 ${totalFee.toFixed(2)}` +
      `\n  两个数现在都没有落库——手续费直接吃掉真实收益，已平仓盈亏是过去交易的成绩。`,
  );
}
