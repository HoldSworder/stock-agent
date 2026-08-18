import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type {
  SimPosition,
  SimTrade,
  Strategy,
  StrategyHistoryItem,
  StrategyInput,
  StrategyListItem,
  StrategySnapshot,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { getQuoteWithLimits, getQuotes } from '../market/eastmoney';
import { newId, nowIso } from '../util';
import { assertTradeAllowed } from '../safety/guard';
import { broadcastWatch } from '../watch/bus';
import { sendTelegram } from '../notify/telegram';
import { syncMiaoxiangStrategy } from './miaoxiangSync';
// shadowReplay 反向依赖本模块的 listStrategies，但两侧都只在函数体内使用对方，
// ESM 循环引用在模块初始化完成后才被读取，安全。
import { SHADOW_NAME } from './shadowReplay';

// 战法模拟引擎：每个战法是一个独立的本地纸上交易账户。
// 买卖只落本系统库（strategies / sim_positions / sim_trades），不触发任何真实/妙想下单。
// 强制校验通用交易规则：涨停不可买 / 跌停不可卖、100 股整数倍、T+1、资金/可卖持仓充足。

export class StrategyError extends Error {}

type StrategyRow = typeof schema.strategies.$inferSelect;
type SimTradeRow = typeof schema.simTrades.$inferSelect;

/** Asia/Shanghai 当日 YYYY-MM-DD，用于 T+1 与成交日记录 */
export function shanghaiDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function rowToStrategy(row: StrategyRow): Strategy {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    kind: (row.kind as Strategy['kind']) ?? 'local',
    initialCapital: row.initialCapital,
    cash: row.cash,
    archived: row.archived,
    syncedAt: row.syncedAt ?? null,
    skillEnabled: row.skillEnabled ?? false,
    autoSimEnabled: row.autoSimEnabled ?? false,
    screenEngine: row.screenEngine ?? null,
    screenStrategyId: row.screenStrategyId ?? null,
    horizon: (row.horizon as Strategy['horizon']) ?? 'short',
    pickTopN: row.pickTopN ?? null,
    maxPositions: row.maxPositions ?? null,
    rebalanceCron: row.rebalanceCron ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToTrade(row: SimTradeRow): SimTrade {
  return {
    id: row.id,
    strategyId: row.strategyId,
    runId: row.runId ?? null,
    extId: row.extId ?? null,
    code: row.code,
    name: row.name,
    side: row.side as 'buy' | 'sell',
    qty: row.qty,
    price: row.price,
    amount: row.amount,
    realizedProfit: row.realizedProfit ?? null,
    reason: row.reason ?? null,
    source: row.source,
    tradeDate: row.tradeDate,
    createdAt: row.createdAt,
  };
}

// ===== CRUD =====

export function getStrategy(id: string): Strategy | undefined {
  const row = db.select().from(schema.strategies).where(eq(schema.strategies.id, id)).get();
  return row ? rowToStrategy(row) : undefined;
}

export function listStrategies(includeArchived = false): Strategy[] {
  const rows = db
    .select()
    .from(schema.strategies)
    .orderBy(desc(schema.strategies.createdAt))
    .all();
  return rows.map(rowToStrategy).filter((s) => includeArchived || !s.archived);
}

export function createStrategy(input: StrategyInput): Strategy {
  const name = input.name?.trim();
  if (!name) throw new StrategyError('战法名称不能为空');
  const capital = Number(input.initialCapital);
  if (!Number.isFinite(capital) || capital <= 0) throw new StrategyError('初始资金需为正数');
  const kind: Strategy['kind'] = input.kind === 'miaoxiang' ? 'miaoxiang' : 'local';
  const horizon: Strategy['horizon'] = input.horizon === 'mid' ? 'mid' : 'short';
  const id = newId();
  const now = nowIso();
  db.insert(schema.strategies)
    .values({
      id,
      name,
      description: input.description?.trim() || null,
      kind,
      initialCapital: capital,
      cash: capital,
      archived: false,
      syncedAt: null,
      skillEnabled: input.skillEnabled ?? false,
      autoSimEnabled: input.autoSimEnabled ?? false,
      screenEngine: input.screenEngine ?? null,
      screenStrategyId: input.screenStrategyId ?? null,
      horizon,
      pickTopN: input.pickTopN ?? null,
      maxPositions: input.maxPositions ?? null,
      rebalanceCron: input.rebalanceCron?.trim() || null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getStrategy(id)!;
}

export function updateStrategy(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    skillEnabled?: boolean;
    autoSimEnabled?: boolean;
    screenEngine?: string | null;
    screenStrategyId?: string | null;
    horizon?: Strategy['horizon'];
    pickTopN?: number | null;
    maxPositions?: number | null;
    rebalanceCron?: string | null;
  },
): Strategy | undefined {
  const existing = getStrategy(id);
  if (!existing) return undefined;
  db.update(schema.strategies)
    .set({
      name: patch.name?.trim() || existing.name,
      description:
        patch.description !== undefined ? patch.description?.trim() || null : existing.description,
      skillEnabled:
        patch.skillEnabled !== undefined ? patch.skillEnabled : existing.skillEnabled,
      autoSimEnabled:
        patch.autoSimEnabled !== undefined ? patch.autoSimEnabled : existing.autoSimEnabled,
      screenEngine:
        patch.screenEngine !== undefined ? patch.screenEngine || null : existing.screenEngine,
      screenStrategyId:
        patch.screenStrategyId !== undefined
          ? patch.screenStrategyId || null
          : existing.screenStrategyId,
      horizon:
        patch.horizon !== undefined ? (patch.horizon === 'mid' ? 'mid' : 'short') : existing.horizon,
      pickTopN: patch.pickTopN !== undefined ? patch.pickTopN : existing.pickTopN,
      maxPositions:
        patch.maxPositions !== undefined ? patch.maxPositions : existing.maxPositions,
      rebalanceCron:
        patch.rebalanceCron !== undefined
          ? patch.rebalanceCron?.trim() || null
          : existing.rebalanceCron,
      updatedAt: nowIso(),
    })
    .where(eq(schema.strategies.id, id))
    .run();
  return getStrategy(id);
}

/** 归档（软删除）：保留历史流水，列表默认不再展示 */
export function archiveStrategy(id: string): void {
  db.update(schema.strategies)
    .set({ archived: true, updatedAt: nowIso() })
    .where(eq(schema.strategies.id, id))
    .run();
}

/**
 * 重置本地战法账户：清空持仓与成交流水、现金回到初始资金。
 * 仅 kind='local'：妙想镜像账户由同步覆盖，重置无意义，直接拒绝。
 */
export function resetStrategy(id: string): void {
  const strategy = getStrategy(id);
  if (!strategy) throw new StrategyError('战法不存在');
  if (strategy.kind === 'miaoxiang') {
    throw new StrategyError('妙想镜像账户由同步覆盖，不支持重置');
  }
  const now = nowIso();
  db.transaction((tx) => {
    tx.delete(schema.simPositions).where(eq(schema.simPositions.strategyId, id)).run();
    tx.delete(schema.simTrades).where(eq(schema.simTrades.strategyId, id)).run();
    tx.update(schema.strategies)
      .set({ cash: strategy.initialCapital, updatedAt: now })
      .where(eq(schema.strategies.id, id))
      .run();
  });
}

// ===== 持仓与流水查询 =====

function getPositionRow(strategyId: string, code: string) {
  return db
    .select()
    .from(schema.simPositions)
    .where(and(eq(schema.simPositions.strategyId, strategyId), eq(schema.simPositions.code, code)))
    .get();
}

function listPositionRows(strategyId: string) {
  return db
    .select()
    .from(schema.simPositions)
    .where(eq(schema.simPositions.strategyId, strategyId))
    .all();
}

function listTradeRows(strategyId: string, limit = 200): SimTradeRow[] {
  return db
    .select()
    .from(schema.simTrades)
    .where(eq(schema.simTrades.strategyId, strategyId))
    .orderBy(desc(schema.simTrades.createdAt))
    .limit(limit)
    .all();
}

// ===== 持有逻辑 / 操作原因 持久化（与 sim_positions / sim_trades 解耦，跨妙想同步留存）=====

/** upsert 持仓「持有逻辑」（thesis 为空白则删除该 code 记录） */
export function setPositionThesis(strategyId: string, code: string, thesis: string | null): void {
  const text = (thesis ?? '').trim();
  if (!text) {
    db.delete(schema.simPositionThesis)
      .where(
        and(
          eq(schema.simPositionThesis.strategyId, strategyId),
          eq(schema.simPositionThesis.code, code),
        ),
      )
      .run();
    return;
  }
  db.insert(schema.simPositionThesis)
    .values({ strategyId, code, thesis: text, updatedAt: nowIso() })
    .onConflictDoUpdate({
      target: [schema.simPositionThesis.strategyId, schema.simPositionThesis.code],
      set: { thesis: text, updatedAt: nowIso() },
    })
    .run();
}

/** 读取某战法全部持仓持有逻辑（code -> thesis），用于快照关联 */
function getThesisMap(strategyId: string): Map<string, string> {
  const rows = db
    .select()
    .from(schema.simPositionThesis)
    .where(eq(schema.simPositionThesis.strategyId, strategyId))
    .all();
  return new Map(rows.map((r) => [r.code, r.thesis]));
}

/**
 * upsert 妙想镜像成交「操作原因」兜底（按 strategyId+code+side+tradeDate）。
 * 妙想同步重写成交时会清掉 reason，故 mx_trade 落本表，同步重插时回填。
 */
export function setTradeReason(
  strategyId: string,
  code: string,
  side: 'buy' | 'sell',
  tradeDate: string,
  reason: string | null,
): void {
  const text = (reason ?? '').trim();
  if (!text) return;
  db.insert(schema.simTradeReasons)
    .values({ strategyId, code, side, tradeDate, reason: text, updatedAt: nowIso() })
    .onConflictDoUpdate({
      target: [
        schema.simTradeReasons.strategyId,
        schema.simTradeReasons.code,
        schema.simTradeReasons.side,
        schema.simTradeReasons.tradeDate,
      ],
      set: { reason: text, updatedAt: nowIso() },
    })
    .run();
}

/** 同步重插妙想成交时取兜底操作原因 */
export function getTradeReason(
  strategyId: string,
  code: string,
  side: 'buy' | 'sell',
  tradeDate: string,
): string | null {
  const row = db
    .select()
    .from(schema.simTradeReasons)
    .where(
      and(
        eq(schema.simTradeReasons.strategyId, strategyId),
        eq(schema.simTradeReasons.code, code),
        eq(schema.simTradeReasons.side, side),
        eq(schema.simTradeReasons.tradeDate, tradeDate),
      ),
    )
    .get();
  return row?.reason ?? null;
}

/** 某标的当日买入总股数（T+1：这些股数当日不可卖） */
function todayBoughtQty(strategyId: string, code: string, date: string): number {
  const row = db
    .select({ q: sql<number>`coalesce(sum(${schema.simTrades.qty}), 0)` })
    .from(schema.simTrades)
    .where(
      and(
        eq(schema.simTrades.strategyId, strategyId),
        eq(schema.simTrades.code, code),
        eq(schema.simTrades.side, 'buy'),
        eq(schema.simTrades.tradeDate, date),
      ),
    )
    .get();
  return row?.q ?? 0;
}

// ===== 下单执行 =====

export interface ExecuteSimTradeInput {
  strategyId: string;
  side: 'buy' | 'sell';
  code: string;
  qty: number;
  /** 限价（元），缺省用实时现价 */
  price?: number | null;
  reason?: string | null;
  /** 持有逻辑（position 级，如金属钨涨价；提供时 upsert 到 sim_position_thesis） */
  thesis?: string | null;
  runId?: string | null;
  source: 'cron' | 'manual' | 'agent' | 'watch';
  /** 强制成交：跳过 A 股交易时段校验（仅前端手动下单可设置） */
  force?: boolean;
}

export interface ExecuteSimTradeResult {
  trade: SimTrade;
  cash: number;
}

/**
 * 自动成交可见性：非手动来源（cron/agent/watch）的成交经盯盘总线广播 trade 事件，
 * 自动买入额外推一条 Telegram（自动卖出已由盯盘 dispatcher 推送，避免重复故不在此推）。
 * 全程 best-effort：广播/推送失败不影响成交本身。
 */
function emitAutoTrade(strategy: Strategy, trade: SimTrade, source: ExecuteSimTradeInput['source']): void {
  if (source === 'manual') return;
  try {
    broadcastWatch({
      type: 'trade',
      trade: {
        at: trade.createdAt,
        kind: trade.side === 'buy' ? 'auto_buy' : 'auto_sell',
        source,
        code: trade.code,
        name: trade.name,
        qty: trade.qty,
        price: trade.price,
        amount: trade.amount,
        realizedProfit: trade.realizedProfit,
        strategyId: strategy.id,
        strategyName: strategy.name,
        reason: trade.reason,
      },
    });
  } catch {
    /* 广播失败不影响成交 */
  }
  if (trade.side === 'buy') {
    const msg =
      `🤖 自动建仓（${strategy.name}）：买入 ${trade.name}(${trade.code}) ` +
      `${trade.qty}股 @${trade.price} 金额${trade.amount.toFixed(2)}` +
      (trade.reason ? `\n理由：${trade.reason}` : '');
    void sendTelegram(msg).catch(() => {
      /* 推送失败忽略 */
    });
  }
}

/** 报价取数口径，仅供自检注入。生产调用一律走默认的 getQuoteWithLimits */
export type QuoteFetcher = typeof getQuoteWithLimits;

/**
 * 执行一笔模拟成交：校验通用交易规则后落库并更新现金/持仓。
 * 任何规则不满足都会抛 StrategyError，调用方据此回显原因。
 *
 * @param quoteFetcher 仅自检使用：并发超买这类竞态只有在「取价这段 await 期间账户被别人改了」
 *   时才暴露，而真实取价既联网又不可控，无法在断言里制造那个时间窗。
 */
export async function executeSimTrade(
  input: ExecuteSimTradeInput,
  quoteFetcher: QuoteFetcher = getQuoteWithLimits,
): Promise<ExecuteSimTradeResult> {
  const strategy = getStrategy(input.strategyId);
  if (!strategy) throw new StrategyError('战法不存在');
  if (strategy.archived) throw new StrategyError('战法已归档，不能交易');
  // 妙想镜像账户只读：本地手工/模拟下单会被下次同步覆盖，直接拒绝
  if (strategy.kind === 'miaoxiang') {
    throw new StrategyError('妙想镜像账户不支持本地下单，请在妙想模拟盘交易后同步');
  }
  // 首板择时影子盘为程序化重放账户：只按镜像成交 + 883994 门槛自动重放，
  // 手工/自动下单会污染重放结果，直接拒绝（重放本身不走本函数，直接写库）。
  // 必须比对 SHADOW_NAME 常量而非硬编码字面量——战法名可经 PUT /api/strategies/:id 改，
  // 硬编码时改个名这道守卫就形同虚设。
  if (strategy.name === SHADOW_NAME) {
    throw new StrategyError('首板择时影子盘为程序化重放账户，不支持手动/自动下单');
  }
  // 安全守卫（代码层总闸）：kill switch / 自动开关 / 交易日 + 时段统一在此判定。
  // 手动 force 仅跳过交易日/时段校验，不绕过 kill switch。
  assertTradeAllowed({
    operation: input.side === 'buy' ? 'sim_buy' : 'sim_sell',
    source: input.source,
    forceTrade: input.force ?? false,
  });

  const code = String(input.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) throw new StrategyError('请输入 6 位股票代码');

  const qty = Number(input.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new StrategyError('数量需为正数');
  if (qty % 100 !== 0) throw new StrategyError('数量必须为 100 股的整数倍');

  const quote = await quoteFetcher(code);
  if (!(quote.price > 0)) throw new StrategyError(`未取到 ${code} 的有效现价，暂不能下单`);

  // 定执行价：传 price 用限价（须在涨跌停区间内），否则用实时现价
  let price = quote.price;
  if (input.price != null) {
    price = Number(input.price);
    if (!Number.isFinite(price) || price <= 0) throw new StrategyError('限价需为正数');
    if (quote.limitUp > 0 && price > quote.limitUp) {
      throw new StrategyError(`限价 ${price} 高于涨停价 ${quote.limitUp}`);
    }
    if (quote.limitDown > 0 && price < quote.limitDown) {
      throw new StrategyError(`限价 ${price} 低于跌停价 ${quote.limitDown}`);
    }
  }

  const date = shanghaiDate();
  const amount = qty * price;

  // 校验与写入必须在同一个事务里，且现金/持仓要在事务内重新 select：
  // 上面的 getQuoteWithLimits 是 await，让出过事件循环，函数入口读到的 strategy 快照可能已过期。
  // 定时调仓（rebalance 循环下单）与盯盘自动卖出并发时，两笔成交都基于同一份旧现金校验并写回，
  // 后写覆盖先写，账户现金会凭空多出一笔、净值曲线随之失真。
  // 仅把 cash 改成 SQL 原子自减不够——校验本身也得看到最新值，否则照样超买。
  // better-sqlite3 同步单连接：事务回调内的所有 db.* 语句都在同一个 BEGIN/COMMIT 里。
  const result = db.transaction((): ExecuteSimTradeResult => {
    const row = db.select().from(schema.strategies).where(eq(schema.strategies.id, input.strategyId)).get();
    if (!row) throw new StrategyError('战法不存在');
    const fresh = rowToStrategy(row);

    if (input.side === 'buy') {
      // 涨停不可买入
      if (quote.limitUp > 0 && price >= quote.limitUp) {
        throw new StrategyError(`${quote.name}(${code}) 已涨停（涨停价 ${quote.limitUp}），无法买入`);
      }
      if (amount > fresh.cash + 1e-6) {
        throw new StrategyError(
          `可用资金不足：需 ${amount.toFixed(2)}，现金 ${fresh.cash.toFixed(2)}`,
        );
      }
      return applyBuy(fresh, quote.name, code, qty, price, amount, date, input);
    }

    // 卖出：跌停不可卖出
    if (quote.limitDown > 0 && price <= quote.limitDown) {
      throw new StrategyError(`${quote.name}(${code}) 已跌停（跌停价 ${quote.limitDown}），无法卖出`);
    }
    const pos = getPositionRow(input.strategyId, code);
    if (!pos || pos.qty <= 0) throw new StrategyError(`${quote.name}(${code}) 当前无持仓，无法卖出`);
    const lockedToday = todayBoughtQty(input.strategyId, code, date);
    const sellable = pos.qty - lockedToday;
    if (qty > sellable + 1e-6) {
      throw new StrategyError(
        `可卖数量不足：可卖 ${sellable}（持仓 ${pos.qty}，当日买入 T+1 锁定 ${lockedToday}），欲卖 ${qty}`,
      );
    }
    return applySell(fresh, pos, qty, price, amount, date, input);
  });

  emitAutoTrade(strategy, result.trade, input.source);
  return result;
}

function applyBuy(
  strategy: Strategy,
  name: string,
  code: string,
  qty: number,
  price: number,
  amount: number,
  date: string,
  input: ExecuteSimTradeInput,
): ExecuteSimTradeResult {
  const now = nowIso();
  const existing = getPositionRow(strategy.id, code);
  if (existing) {
    const newQty = existing.qty + qty;
    const newAvg = (existing.qty * existing.avgCost + amount) / newQty;
    db.update(schema.simPositions)
      .set({ qty: newQty, avgCost: newAvg, name, updatedAt: now })
      .where(eq(schema.simPositions.id, existing.id))
      .run();
  } else {
    db.insert(schema.simPositions)
      .values({ id: newId(), strategyId: strategy.id, code, name, qty, avgCost: price, updatedAt: now })
      .run();
  }
  const newCash = strategy.cash - amount;
  db.update(schema.strategies)
    .set({ cash: newCash, updatedAt: now })
    .where(eq(schema.strategies.id, strategy.id))
    .run();
  const trade = insertTrade({
    strategyId: strategy.id,
    runId: input.runId ?? null,
    code,
    name,
    side: 'buy',
    qty,
    price,
    amount,
    realizedProfit: null,
    reason: input.reason ?? null,
    source: input.source,
    tradeDate: date,
    createdAt: now,
  });
  if (input.thesis != null) setPositionThesis(strategy.id, code, input.thesis);
  return { trade, cash: newCash };
}

function applySell(
  strategy: Strategy,
  pos: typeof schema.simPositions.$inferSelect,
  qty: number,
  price: number,
  amount: number,
  date: string,
  input: ExecuteSimTradeInput,
): ExecuteSimTradeResult {
  const now = nowIso();
  const realized = qty * (price - pos.avgCost);
  const remaining = pos.qty - qty;
  if (remaining <= 1e-6) {
    db.delete(schema.simPositions).where(eq(schema.simPositions.id, pos.id)).run();
  } else {
    db.update(schema.simPositions)
      .set({ qty: remaining, updatedAt: now })
      .where(eq(schema.simPositions.id, pos.id))
      .run();
  }
  const newCash = strategy.cash + amount;
  db.update(schema.strategies)
    .set({ cash: newCash, updatedAt: now })
    .where(eq(schema.strategies.id, strategy.id))
    .run();
  const trade = insertTrade({
    strategyId: strategy.id,
    runId: input.runId ?? null,
    code: pos.code,
    name: pos.name,
    side: 'sell',
    qty,
    price,
    amount,
    realizedProfit: realized,
    reason: input.reason ?? null,
    source: input.source,
    tradeDate: date,
    createdAt: now,
  });
  if (input.thesis != null) setPositionThesis(strategy.id, pos.code, input.thesis);
  // 清仓后该标的持有逻辑失效，一并清理避免残留
  if (remaining <= 1e-6) setPositionThesis(strategy.id, pos.code, null);
  return { trade, cash: newCash };
}

function insertTrade(values: Omit<typeof schema.simTrades.$inferInsert, 'id'>): SimTrade {
  const id = newId();
  db.insert(schema.simTrades)
    .values({ ...values, id })
    .run();
  const row = db.select().from(schema.simTrades).where(eq(schema.simTrades.id, id)).get();
  return rowToTrade(row!);
}

// ===== 快照（实时报价计盈亏）=====

/**
 * 行情取不到时原先直接拿 avgCost 冒充现价，于是 holdProfit/holdRate 全变 0，
 * totalAsset / totalProfitRate 一并失真，而这些值又被前向验证当作当日权益样本落库。
 * 现在缺价一律经 SimPosition.priceStale / StrategySnapshot.priceStale 显式标记。
 */
export async function getStrategySnapshot(
  id: string,
  opts: { skipSync?: boolean } = {},
): Promise<StrategySnapshot> {
  let strategy = getStrategy(id);
  if (!strategy) throw new StrategyError('战法不存在');

  // 妙想镜像账户：读取前尝试同步一次，失败则吞错沿用上次数据（stale）
  if (strategy.kind === 'miaoxiang' && !opts.skipSync) {
    try {
      await syncMiaoxiangStrategy(id);
      strategy = getStrategy(id) ?? strategy;
    } catch (e) {
      console.warn(`[strategy] 妙想同步失败，使用上次快照: ${e instanceof Error ? e.message : e}`);
    }
  }

  const posRows = listPositionRows(id);
  const date = shanghaiDate();
  const codes = posRows.map((p) => p.code);
  const quotes = codes.length > 0 ? await getQuotes(codes) : [];
  const quoteMap = new Map(quotes.map((q) => [q.code, q]));

  // 先算市值与总资产，再算仓位占比
  let totalMarketValue = 0;
  const stalePriceCodes: string[] = [];
  const enriched = posRows.map((p) => {
    const q = quoteMap.get(p.code);
    const stale = !(q && q.price > 0);
    if (stale) stalePriceCodes.push(p.code);
    // 取不到价时按成本估值只是为了总资产不至于塌成 0，盈亏不会据此编造（见下方 priceStale）
    const price = stale ? p.avgCost : q!.price;
    const marketValue = p.qty * price;
    totalMarketValue += marketValue;
    return { p, q, price, marketValue, stale };
  });
  const totalAsset = strategy.cash + totalMarketValue;
  const thesisMap = getThesisMap(id);

  const positions: SimPosition[] = enriched.map(({ p, q, price, marketValue, stale }) => {
    const holdProfit = p.qty * (price - p.avgCost);
    const lockedToday = todayBoughtQty(id, p.code, date);
    return {
      code: p.code,
      name: p.name,
      qty: p.qty,
      avgCost: p.avgCost,
      price,
      pct: q?.pct ?? 0,
      marketValue,
      holdProfit,
      holdRate: p.avgCost > 0 ? (price - p.avgCost) / p.avgCost : 0,
      positionRate: totalAsset > 0 ? marketValue / totalAsset : 0,
      sellableQty: Math.max(0, p.qty - lockedToday),
      thesis: thesisMap.get(p.code) ?? null,
      priceStale: stale || undefined,
    };
  });

  const trades = listTradeRows(id).map(rowToTrade);
  const totalProfit = totalAsset - strategy.initialCapital;
  return {
    strategy,
    asOf: nowIso(),
    totalMarketValue,
    totalAsset,
    totalHoldProfit: positions.reduce((s, p) => s + p.holdProfit, 0),
    totalProfit,
    totalProfitRate: strategy.initialCapital > 0 ? totalProfit / strategy.initialCapital : 0,
    positions,
    trades,
    priceStale: stalePriceCodes.length > 0 || undefined,
    stalePriceCodes: stalePriceCodes.length ? stalePriceCodes : undefined,
  };
}

/**
 * 历史持仓（按标的汇总复盘）：把该战法全部成交按 code 归并，算加权均买/卖价、
 * 持有收益（已实现+持有中浮盈）、卖出后至今收益（已清仓：现价/均卖价-1，判卖飞/卖对）、首买/末卖时间。
 * 现价经 getQuotes 批量取（best-effort，失败置 null 不阻断）；含持有中与已清仓标的。
 */
export async function getStrategyHistory(id: string): Promise<StrategyHistoryItem[]> {
  const strategy = getStrategy(id);
  if (!strategy) throw new StrategyError('战法不存在');

  const rows = db
    .select()
    .from(schema.simTrades)
    .where(eq(schema.simTrades.strategyId, id))
    .orderBy(asc(schema.simTrades.createdAt))
    .all();

  interface Acc {
    code: string;
    name: string;
    buyQty: number;
    buyAmount: number;
    sellQty: number;
    sellAmount: number;
    realized: number;
    firstBuyDate: string | null;
    lastBuyDate: string | null;
    firstSellDate: string | null;
    lastSellDate: string | null;
  }
  const byCode = new Map<string, Acc>();
  for (const r of rows) {
    let a = byCode.get(r.code);
    if (!a) {
      a = {
        code: r.code,
        name: r.name,
        buyQty: 0,
        buyAmount: 0,
        sellQty: 0,
        sellAmount: 0,
        realized: 0,
        firstBuyDate: null,
        lastBuyDate: null,
        firstSellDate: null,
        lastSellDate: null,
      };
      byCode.set(r.code, a);
    }
    a.name = r.name || a.name; // 名称以最近一笔为准
    if (r.side === 'buy') {
      a.buyQty += r.qty;
      a.buyAmount += r.amount;
      a.firstBuyDate = a.firstBuyDate ?? r.tradeDate;
      a.lastBuyDate = r.tradeDate;
    } else {
      a.sellQty += r.qty;
      a.sellAmount += r.amount;
      a.realized += r.realizedProfit ?? 0;
      a.firstSellDate = a.firstSellDate ?? r.tradeDate;
      a.lastSellDate = r.tradeDate;
    }
  }
  if (byCode.size === 0) return [];

  // 批量取现价（best-effort）
  const codes = Array.from(byCode.keys());
  let quoteMap = new Map<string, number>();
  try {
    const quotes = await getQuotes(codes);
    quoteMap = new Map(quotes.filter((q) => q.price > 0).map((q) => [q.code, q.price]));
  } catch {
    /* 现价取不到：currentPrice 置 null，浮盈/卖出后收益降级 */
  }

  const items: StrategyHistoryItem[] = [];
  for (const a of byCode.values()) {
    const currentQty = Math.round((a.buyQty - a.sellQty) * 1000) / 1000;
    const holding = currentQty > 1e-6;
    const avgBuyPrice = a.buyQty > 0 ? a.buyAmount / a.buyQty : 0;
    const avgSellPrice = a.sellQty > 0 ? a.sellAmount / a.sellQty : null;
    const currentPrice = quoteMap.get(a.code) ?? null;
    // 已实现盈亏按均价口径 (均卖价-均买价)×卖出量：源无关，兼容妙想镜像(逐笔 realizedProfit 为空)。
    const realized = avgSellPrice != null ? (avgSellPrice - avgBuyPrice) * a.sellQty : 0;
    // 持有中浮盈：仅当持仓>0 且有现价
    const unrealized = holding && currentPrice != null ? currentQty * (currentPrice - avgBuyPrice) : 0;
    const holdProfit = realized + unrealized;
    const holdProfitRate = a.buyAmount > 0 ? holdProfit / a.buyAmount : null;
    // 卖出后至今收益：已清仓 + 有均卖价 + 有现价
    const postSellReturn =
      !holding && avgSellPrice != null && avgSellPrice > 0 && currentPrice != null
        ? (currentPrice / avgSellPrice - 1) * 100
        : null;
    items.push({
      code: a.code,
      name: a.name,
      status: holding ? 'holding' : 'closed',
      buyQty: a.buyQty,
      avgBuyPrice: Math.round(avgBuyPrice * 1000) / 1000,
      sellQty: a.sellQty,
      avgSellPrice: avgSellPrice == null ? null : Math.round(avgSellPrice * 1000) / 1000,
      currentQty,
      currentPrice,
      realizedProfit: Math.round(realized * 100) / 100,
      holdProfit: Math.round(holdProfit * 100) / 100,
      holdProfitRate: holdProfitRate == null ? null : Math.round(holdProfitRate * 10000) / 10000,
      postSellReturn: postSellReturn == null ? null : Math.round(postSellReturn * 100) / 100,
      firstBuyDate: a.firstBuyDate,
      lastBuyDate: a.lastBuyDate,
      firstSellDate: a.firstSellDate,
      lastSellDate: a.lastSellDate,
    });
  }
  // 持有中在前；其次按末次活动日期倒序
  const lastActivity = (i: StrategyHistoryItem): string => i.lastSellDate ?? i.lastBuyDate ?? '';
  items.sort((x, y) => {
    if (x.status !== y.status) return x.status === 'holding' ? -1 : 1;
    return lastActivity(y).localeCompare(lastActivity(x));
  });
  return items;
}

/**
 * 战法列表（含账户汇总），用于列表页卡片。
 * 用 allSettled 而非 all：getStrategySnapshot 内部会调 getQuotes（网络）与妙想同步，
 * 任一战法失败就让整个列表接口 reject，等于一只标的取价超时整页打不开。
 */
export async function listStrategyItems(): Promise<StrategyListItem[]> {
  const strategies = listStrategies();
  const settled = await Promise.allSettled(strategies.map((s) => getStrategySnapshot(s.id)));
  return strategies.map((s, i) => {
    const r = settled[i];
    if (r.status === 'rejected') {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      // 占位卡片：现金是本地库里的确定值；收益与持仓数无从计算，一律 null 而不是 0——
      // 0 会被读成「不赚不亏、空仓」，比明说取不到更误导
      return {
        strategy: s,
        totalAsset: s.cash,
        totalProfit: null,
        totalProfitRate: null,
        positionCount: null,
        snapshotError: `账户快照取失败：${msg}`,
      };
    }
    const snap = r.value;
    return {
      strategy: s,
      totalAsset: snap.totalAsset,
      totalProfit: snap.totalProfit,
      totalProfitRate: snap.totalProfitRate,
      positionCount: snap.positions.length,
    };
  });
}
