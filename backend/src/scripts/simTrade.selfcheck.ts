// 模拟盘下单并发一致性自检（无框架，assert 断言）。跑在临时 sqlite 上，不碰真实库。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/simTrade.selfcheck.ts
//
// 钉住一条改回去就会静默复发的规则：**现金校验必须在事务内重读**。
// executeSimTrade 里取报价是 await，会让出事件循环；定时调仓与盯盘自动卖出并发时，
// 两笔成交都基于函数入口那份旧现金快照校验并写回，后写覆盖先写，账户现金凭空多出一笔。
// 真实取价既联网又不可控，制造不出那个时间窗，所以这里用注入的 quoteFetcher 在
// 「取价返回前」精确插入一次并发扣款，再断言后一笔必须按最新现金拒单。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'simtrade-selfcheck-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

const { ensureSchema } = await import('../db/migrate');
const { db, schema } = await import('../db/client');
const { executeSimTrade, StrategyError } = await import('../strategy/sim');
const { eq } = await import('drizzle-orm');

ensureSchema();

const SID = 'st-selfcheck';
const CODE = '600000';
const now = new Date().toISOString();

const resetStrategy = (cash: number): void => {
  db.delete(schema.simTrades).where(eq(schema.simTrades.strategyId, SID)).run();
  db.delete(schema.simPositions).where(eq(schema.simPositions.strategyId, SID)).run();
  db.delete(schema.strategies).where(eq(schema.strategies.id, SID)).run();
  db.insert(schema.strategies)
    .values({
      id: SID,
      name: '并发自检账户',
      kind: 'local',
      initialCapital: cash,
      cash,
      horizon: 'short',
      createdAt: now,
      updatedAt: now,
    })
    .run();
};

const cashOf = (): number =>
  db.select().from(schema.strategies).where(eq(schema.strategies.id, SID)).get()!.cash;

/** 固定报价，价格 10 元、涨跌停区间足够宽，不会被 A 股硬约束提前拦下 */
const quote = async (code: string): Promise<{
  code: string;
  name: string;
  price: number;
  limitUp: number;
  limitDown: number;
  prevClose: number;
}> => ({ code, name: '自检标的', price: 10, limitUp: 11, limitDown: 9, prevClose: 10 });

/** 手动 + force：跳过交易日/时段校验，kill switch 仍然生效（新库默认关闭） */
const buy = (qty: number, fetcher = quote): Promise<unknown> =>
  executeSimTrade(
    { strategyId: SID, side: 'buy', code: CODE, qty, source: 'manual', force: true },
    fetcher,
  );

// ===== 1. 基线：正常买入按成交额扣现金 =====
{
  resetStrategy(100_000);
  await buy(1000); // 1000 股 × 10 元
  assert.equal(cashOf(), 90_000, '正常买入应扣掉 10000 元');
}

// ===== 2. 竞态：取价返回前现金被并发扣走，本笔必须按最新现金拒单 =====
{
  resetStrategy(100_000);
  let snapshotCashAtEntry = 0;
  const racingQuote = async (code: string): Promise<Awaited<ReturnType<typeof quote>>> => {
    // 此刻函数入口那份 strategy 快照还写着 100000，若校验读它，这笔 10000 元的单会被放行
    snapshotCashAtEntry = cashOf();
    // 模拟并发的另一笔成交：把现金花到只剩 5000
    db.update(schema.strategies).set({ cash: 5_000 }).where(eq(schema.strategies.id, SID)).run();
    return quote(code);
  };

  await assert.rejects(
    () => buy(1000, racingQuote),
    (e: unknown) =>
      e instanceof StrategyError && /可用资金不足/.test((e as Error).message),
    '取价期间现金被扣走后，本笔必须按事务内重读的现金拒单',
  );
  assert.equal(snapshotCashAtEntry, 100_000, '前置条件：入口快照确实是过期的 100000');
  assert.equal(cashOf(), 5_000, '被拒的买单不得留下任何写入（现金应保持并发方写的 5000）');
  assert.equal(
    db.select().from(schema.simPositions).where(eq(schema.simPositions.strategyId, SID)).all().length,
    0,
    '被拒的买单不得建出持仓',
  );
  assert.equal(
    db.select().from(schema.simTrades).where(eq(schema.simTrades.strategyId, SID)).all().length,
    0,
    '被拒的买单不得写出成交流水',
  );
}

// ===== 3. 并发扣款后仍在余额内的单要放行，且从**新**余额起扣 =====
{
  resetStrategy(100_000);
  const racingQuote = async (code: string): Promise<Awaited<ReturnType<typeof quote>>> => {
    db.update(schema.strategies).set({ cash: 30_000 }).where(eq(schema.strategies.id, SID)).run();
    return quote(code);
  };
  await buy(1000, racingQuote);
  assert.equal(cashOf(), 20_000, '扣款基数必须是事务内重读的 30000，而不是入口快照的 100000');
}

rmSync(tmpDir, { recursive: true, force: true });
console.log('✅ 模拟盘并发自检通过：事务内重读现金 / 拒单零写入 / 扣款基数取最新值');
