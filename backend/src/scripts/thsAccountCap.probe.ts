// 探测同花顺投资账本的账户能力（工单 04-C 的前置判断）。
//
// 盲猜 12 条成交流水路径全部 404（见 thsTradeFlow.probe.ts）。在继续花力气抓包之前，
// 先回答一个更基本的问题：**这个产品有没有逐笔成交这回事。**
//
// 怀疑点写在现有代码的注释里——stock_position 返回的现价与当日盈亏是
// 「账本上次上传时的静态快照，可能滞后多日」。这听起来像一个**持仓跟踪**产品
// （用户把持仓同步进来看盈亏），而不是券商交易通道。若如此，
// 逐笔成交压根不在它的数据里，抓包也抓不到，工单 04-C 该改成另一条路。
//
// 跑法：cd backend && ./node_modules/.bin/tsx src/scripts/thsAccountCap.probe.ts

import { __test__thsPost, __test__THS_BASE } from '../realPositions';
import { getValue } from '../settings';

const userId = getValue('thsUserId');
if (!userId) {
  console.error('同花顺 UID 未配置');
  process.exit(1);
}

const base = {
  terminal: '1',
  version: '0.0.0',
  userid: userId,
  user_id: userId,
};

/** 递归打印字段名（不打值，避免把账户数字写进终端记录） */
function keysOf(v: unknown, depth = 0, prefix = ''): string[] {
  if (depth > 2 || v == null) return [];
  if (Array.isArray(v)) {
    return v.length > 0 ? keysOf(v[0], depth + 1, `${prefix}[]`) : [`${prefix}[] 空数组`];
  }
  if (typeof v !== 'object') return [];
  const out: string[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    const nested = keysOf(val, depth + 1, p);
    if (nested.length > 0) out.push(...nested);
    else out.push(`${p}:${Array.isArray(val) ? 'array' : typeof val}`);
  }
  return out;
}

console.log('=== account_list 返回的字段（看有没有交易能力相关的标记）===\n');
try {
  const ex = await __test__thsPost(`${__test__THS_BASE}/pc/account/v1/account_list`, {
    ...base,
    manual_id: '',
  });
  for (const k of keysOf(ex)) console.log(`  ${k}`);
} catch (e) {
  console.log(`  取不到：${e instanceof Error ? e.message : e}`);
}

console.log('\n=== stock_position 返回的字段（看有没有成交/流水痕迹）===\n');
const fundKey = (getValue('thsFundKeys') ?? '').split(/[,，\s]+/).filter(Boolean)[0] ?? '';
try {
  const ex = await __test__thsPost(`${__test__THS_BASE}/pc/asset/v1/stock_position`, {
    ...base,
    manual_id: '',
    fund_key: fundKey,
    rzrq_fund_key: '',
  });
  const ks = keysOf(ex);
  for (const k of ks) console.log(`  ${k}`);
  const tradeish = ks.filter((k) => /trade|deal|order|entrust|flow|record|history|bs|direction/i.test(k));
  console.log(
    tradeish.length > 0
      ? `\n  ↑ 其中像成交的字段：${tradeish.join('、')}`
      : '\n  ↑ 没有任何像成交的字段——持仓接口里确实没有逐笔信息',
  );
} catch (e) {
  console.log(`  取不到：${e instanceof Error ? e.message : e}`);
}
