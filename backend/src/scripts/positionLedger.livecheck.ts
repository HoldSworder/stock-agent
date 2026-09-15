// 成交台账的端到端核对：建表 → 生产写入函数 → 反推成交 → 汇总已实现盈亏。
//
// 用临时数据库跑，**不碰真实库**。运行：
//   cd backend && DATABASE_PATH=/tmp/sa-ledger-check.sqlite \
//     ./node_modules/.bin/tsx src/scripts/positionLedger.livecheck.ts
//
// 为什么需要它：positionLedger.selfcheck 只钉了差分算法本身（纯函数）。
// 真正会出错又看不出来的是中间那几层——表建没建对、盘中反复同步是不是真的幂等、
// drizzle 的字段映射有没有写反、日期排序是不是倒的。这些只有真跑一遍 SQL 才知道。
// 而这条链路一旦写错，攒出来的账会静默失真，比不攒更糟。
//
// 它直接调生产的 persistHistory，不在这里另写一遍 insert——另写一遍就只是在
// 核对测试代码自己，生产路径写错了照样绿。
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { config } from '../config';

if (!config.databasePath.includes('/tmp/')) {
  console.error('拒绝执行：必须用 DATABASE_PATH 指向 /tmp 下的临时库，避免污染真实账本');
  process.exit(1);
}

// 每次从干净库开始，避免上一轮残留让断言失真
for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(config.databasePath + suffix);
  } catch {
    /* 不存在即可 */
  }
}

const { ensureSchema } = await import('../db/migrate');
ensureSchema();

const { db, schema } = await import('../db/client');
const { listCloses, listTradeGuesses, summarizeCloses } = await import(
  '../positions/ledgerRepo'
);
// 直接调生产的写入函数，而不是在这里另写一遍 insert——
// 另写一遍就只是在核对我自己的测试代码，生产路径写错了照样绿
const { persistHistory } = await import('../realPositions');

/** 造一个只含必要字段的合成组合，喂给生产写入函数 */
const portfolio = (
  sourceDate: string,
  held: Array<{ code: string; qty: number; avgCost: number }>,
  closed: Array<{ code: string; avgCost: number; price: number; pnl: number; rate: number }> = [],
) =>
  ({
    asOf: `${sourceDate}T15:00:00+08:00`,
    sourceDate,
    source: '合成核对数据',
    cash: 0,
    positionCount: held.length,
    totalMarketValue: 0,
    fundMarketValue: 0,
    totalAsset: 0,
    totalHoldProfit: 0,
    totalTodayProfit: 0,
    positions: held.map((h) => ({
      code: h.code,
      name: `名称${h.code}`,
      market: '1',
      qty: h.qty,
      avgCost: h.avgCost,
      price: h.avgCost,
      // 这里用成本价当现价只是台账差分用不到现价，不是报价缺失
      priceIsCostFallback: false,
      marketValue: h.qty * h.avgCost,
      holdProfit: 0,
      holdRate: 0,
      todayProfit: 0,
      todayRate: 0,
      positionRate: 0,
      holdDays: 1,
    })),
    funds: [],
    closedToday: closed.map((c) => ({
      code: c.code,
      name: `名称${c.code}`,
      market: '1',
      qty: 0,
      avgCost: c.avgCost,
      price: c.price,
      priceIsCostFallback: false,
      marketValue: 0,
      holdProfit: c.pnl,
      holdRate: c.rate,
      todayProfit: 0,
      todayRate: 0,
      positionRate: 0,
      holdDays: 9,
    })),
  }) satisfies Parameters<typeof persistHistory>[0];

// 三天：建仓 → 部分减仓 → 清仓（清仓当天账户里还留着另一只，否则当日快照为空、差分无从比较）
persistHistory(portfolio('2026-09-09', [{ code: '159915', qty: 1000, avgCost: 2.0 }]));
persistHistory(portfolio('2026-09-10', [{ code: '159915', qty: 400, avgCost: 2.0 }]));
persistHistory(
  portfolio(
    '2026-09-11',
    [{ code: '512880', qty: 500, avgCost: 1.0 }],
    [{ code: '159915', avgCost: 2.0, price: 2.3, pnl: 120, rate: 0.15 }],
  ),
);

// ===== 1. 同一天重复同步必须幂等 =====
// 盘中每隔几分钟同步一次，若不幂等，一天下来会写出几十条重复快照，
// 差分反推立刻失真（同日多行会被当成不同日期比较）
persistHistory(portfolio('2026-09-09', [{ code: '159915', qty: 1000, avgCost: 2.0 }]));
persistHistory(
  portfolio(
    '2026-09-11',
    [{ code: '512880', qty: 500, avgCost: 1.0 }],
    [{ code: '159915', avgCost: 2.0, price: 2.3, pnl: 120, rate: 0.15 }],
  ),
);
assert.equal(
  db.select().from(schema.realPositionSnapshots).all().length,
  3,
  '同（账户,日期,标的）重复同步必须 upsert，不能写重',
);
assert.equal(
  db.select().from(schema.realPositionCloses).all().length,
  1,
  '清仓行重复同步同样必须 upsert',
);

// ===== 2. 反推成交 =====
const trades = listTradeGuesses();
const at = (date: string, code: string) =>
  trades.filter((t) => t.tradeDate === date && t.code === code);

const cut = at('2026-09-10', '159915');
assert.equal(cut.length, 1, '09-10 应反推出一条 159915 的动作');
assert.equal(cut[0].kind, 'sell');
assert.equal(cut[0].qty, 600, '1000 → 400，应为卖出 600');

const done = at('2026-09-11', '159915');
assert.equal(done.length, 1);
assert.equal(done[0].kind, 'sell', '有清仓台账确认，应判为卖出而非说不清');
assert.equal(done[0].qty, 400);

const other = at('2026-09-11', '512880');
assert.equal(other.length, 1);
assert.equal(other[0].kind, 'buy', '新出现的标的应判为新建仓');

// 倒序：最近的排前面
assert.equal(trades[0].tradeDate, '2026-09-11', '结果必须按日期倒序');

// ===== 3. 已实现盈亏汇总 =====
const sum = summarizeCloses();
assert.equal(sum.count, 1);
assert.equal(sum.totalPnl, 120);
assert.equal(sum.winCount, 1);
assert.equal(
  sum.from,
  '2026-09-11',
  '必须给出起始日期——这份账只覆盖开始记录之后的交易，不带起始日会被误读成全部历史战绩',
);

// ===== 4. since 过滤 =====
assert.equal(listCloses('2026-09-12').length, 0, 'since 晚于全部记录时应为空');
assert.equal(listCloses('2026-09-01').length, 1);

console.log(
  '✅ 成交台账核对通过：建表 / 生产写入幂等 / 差分反推 / 清仓确认 / 盈亏汇总带起始日 / since 过滤',
);
console.log(
  '⚠️ 未覆盖：券商接口 → RealPortfolio 的取数与归一化（需 Cookie 有效）。' +
    'Cookie 恢复后用一次真实同步确认清仓行确实被识别出来即可，落库之后的链路已由本脚本钉住。',
);
