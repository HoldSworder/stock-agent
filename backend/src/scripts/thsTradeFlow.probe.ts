// 探测同花顺投资账本有没有「成交流水」接口可用（工单 04-C）。
//
// 只读探测，不是自检。要回答的是：逐笔成交（日期、价格、数量、手续费）拿不拿得到。
// 拿得到，账就是精确的，按日快照差分反推可以退为兜底；
// 若还能拉到历史，就能用过去真实做过的交易对照系统当时会怎么说，
// 比等未来攒几个月快得多。
//
// **安全约束**：只试路径里带 query / list / record / detail 这类查询语义的，
// 一律用现有 thsPost（POST + form + Cookie），绝不碰任何带 order / buy / sell /
// entrust / cancel 字样的路径。这是用户的真实账户。
//
// 跑法：cd backend && ./node_modules/.bin/tsx src/scripts/thsTradeFlow.probe.ts

import { __test__thsPost, __test__THS_BASE } from '../realPositions';
import { getValue } from '../settings';

const userId = getValue('thsUserId');
if (!userId) {
  console.error('同花顺 UID 未配置，先去设置页填写');
  process.exit(1);
}
const fundKeysRaw = getValue('thsFundKeys') ?? '';
const fundKey = fundKeysRaw.split(/[,，\s]+/).filter(Boolean)[0] ?? '';
console.log(`UID=${userId.slice(0, 6)}…  fund_key=${fundKey ? fundKey.slice(0, 8) + '…' : '(空)'}\n`);

/** 候选路径。全部是查询语义；带下单语义的一个都不放进来 */
const CANDIDATES: ReadonlyArray<{ path: string; note: string }> = [
  { path: '/pc/asset/v1/trade_record', note: '成交记录（最直白的猜法）' },
  { path: '/pc/asset/v1/trade_list', note: '成交列表' },
  { path: '/pc/asset/v1/deal_record', note: '成交记录（deal 说法）' },
  { path: '/pc/asset/v1/stock_trade', note: '股票成交' },
  { path: '/pc/asset/v1/history_position', note: '历史持仓（退一步：有历史也够反推）' },
  { path: '/pc/asset/v1/position_history', note: '历史持仓（另一种命名）' },
  { path: '/invest/v1/trade_record', note: '成交记录（invest 域）' },
  { path: '/invest/v1/trade_detail', note: '成交明细' },
  { path: '/pc/account/v1/trade_record', note: '成交记录（account 域）' },
  { path: '/pc/asset/v1/asset_flow', note: '资产流水' },
  { path: '/pc/asset/v1/capital_flow', note: '资金流水（能反推买卖金额）' },
  { path: '/pc/asset/v1/manual_record', note: '手工记录（账本可能把成交叫这个）' },
];

const BASE_PARAMS = {
  terminal: '1',
  version: '0.0.0',
  userid: userId,
  user_id: userId,
  manual_id: '',
  fund_key: fundKey,
  rzrq_fund_key: '',
  // 时间范围：给近一年，接口不认就忽略
  start_date: '20250915',
  end_date: '20260915',
  page: '1',
  page_size: '20',
};

const hits: Array<{ path: string; note: string; shape: string }> = [];

for (const c of CANDIDATES) {
  const url = `${__test__THS_BASE}${c.path}`;
  try {
    const ex = await __test__thsPost(url, BASE_PARAMS);
    // error_code==='0' 才会走到这里（thsPost 会对非 0 抛错）
    const shape =
      ex == null
        ? 'ex_data 为空'
        : Array.isArray(ex)
          ? `数组 ${ex.length} 条，首条字段：${Object.keys((ex[0] ?? {}) as object).join(',')}`
          : typeof ex === 'object'
            ? `对象，字段：${Object.keys(ex as object).join(',')}`
            : `标量 ${String(ex).slice(0, 40)}`;
    console.log(`✅ ${c.path}  —— ${c.note}\n    ${shape}\n`);
    hits.push({ ...c, shape });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 404 / 路径不存在 / error_code 非 0 都算「这条不通」，只打一行
    console.log(`—  ${c.path}  ${msg.slice(0, 80)}`);
  }
}

console.log(`\n结论：${CANDIDATES.length} 条候选里通了 ${hits.length} 条`);
if (hits.length === 0) {
  console.log(
    '这一轮猜的路径全不通。下一步只能抓包（浏览器打开投资账本的成交记录页，' +
      '看它实际请求哪个地址），不要继续盲猜——盲猜命中率低，且每次都在打真实账户的接口。',
  );
} else {
  for (const h of hits) console.log(`  ${h.path} —— ${h.note}`);
}
