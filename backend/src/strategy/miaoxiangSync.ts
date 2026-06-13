import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { miaoxiang } from '../miaoxiang/client';
import { newId, nowIso } from '../util';
import { StrategyError, getStrategy, getTradeReason } from './sim';

// 妙想东财模拟盘 → 本地战法账户镜像同步。
// 从妙想 mockTrading 的 balance/positions/orders 拉取资金/持仓/成交，
// 事务覆盖写入本地 strategies / sim_positions / sim_trades（source=miaoxiang）。
// 字段映射见 plan：注意 *Dec 价格缩放、status==4 才是成交、drt 1买2卖。

interface ParsedPosition {
  code: string;
  name: string;
  qty: number;
  avgCost: number;
}

interface ParsedTrade {
  extId: string;
  code: string;
  name: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  amount: number;
  tradeDate: string;
  createdAt: string;
}

/** 安全取嵌套 data 对象（妙想响应统一 { data: {...} } 结构） */
function dataOf(resp: unknown): Record<string, unknown> {
  if (resp && typeof resp === 'object') {
    const obj = resp as Record<string, unknown>;
    const d = obj.data;
    if (d && typeof d === 'object') return d as Record<string, unknown>;
    return obj;
  }
  return {};
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 按 *Dec 小数位还原真实价格：rawValue / 10^dec */
function scaled(value: unknown, dec: unknown): number {
  const raw = num(value);
  const d = num(dec);
  return d > 0 ? raw / 10 ** d : raw;
}

/** secCode 可能带市场后缀/前缀，统一取 6 位数字代码 */
function normCode(raw: unknown): string {
  const s = String(raw ?? '');
  const m = s.match(/\d{6}/);
  return m ? m[0] : s;
}

/** unix 秒 → Asia/Shanghai YYYY-MM-DD */
function shanghaiDateFromUnix(sec: number): string {
  const ms = sec > 1e12 ? sec : sec * 1000;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/**
 * 校验并解析 positions 响应。
 * positions 接口同时返回账户现金（availBalance）与持仓列表，作为现金权威来源，
 * 避免再依赖单独的 balance 调用（同样会间歇返回 schema 桩）。
 * 响应不是合法 envelope（缺 availBalance/posList）时抛错，由上层回退到上次快照，
 * 杜绝把空数据事务覆盖写入导致现金清零、持仓清空。
 */
function parseAccount(resp: unknown): { cash: number; positions: ParsedPosition[] } {
  const d = dataOf(resp);
  const hasCash = 'availBalance' in d;
  const hasPosList = Array.isArray(d.posList);
  if (!hasCash || !hasPosList) {
    throw new StrategyError('妙想持仓响应无效（缺 availBalance/posList），跳过本次同步');
  }
  const list = d.posList as unknown[];
  const positions: ParsedPosition[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const qty = num(p.count);
    if (qty <= 0) continue; // 已清仓跳过
    positions.push({
      code: normCode(p.secCode),
      name: String(p.secName ?? ''),
      qty,
      avgCost: scaled(p.costPrice, p.costPriceDec),
    });
  }
  return { cash: num(d.availBalance), positions };
}

/** 从 balance 响应取初始资金；调用方需 best-effort，失败沿用现有初始资金。 */
function parseInitMoney(resp: unknown): number {
  return num(dataOf(resp).initMoney);
}

function parseTrades(resp: unknown): ParsedTrade[] {
  const d = dataOf(resp);
  const list = Array.isArray(d.orders) ? d.orders : [];
  const out: ParsedTrade[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (num(o.status) !== 4) continue; // 仅成交单（9=废单等跳过）
    const side: 'buy' | 'sell' = num(o.drt) === 2 ? 'sell' : 'buy';
    const qty = num(o.tradeCount);
    const price = scaled(o.tradePrice, o.priceDec);
    const timeSec = num(o.time);
    out.push({
      extId: String(o.id ?? ''),
      code: normCode(o.secCode),
      name: String(o.secName ?? ''),
      side,
      qty,
      price,
      amount: qty * price,
      tradeDate: timeSec > 0 ? shanghaiDateFromUnix(timeSec) : nowIso().slice(0, 10),
      createdAt: timeSec > 0 ? new Date(timeSec * 1000).toISOString() : nowIso(),
    });
  }
  return out;
}

/**
 * 拉取妙想模拟盘并覆盖写入指定战法账户（镜像）。
 * 仅对 kind=miaoxiang 战法有效；非镜像战法抛错。
 */
export async function syncMiaoxiangStrategy(strategyId: string): Promise<{ syncedAt: string }> {
  const strategy = getStrategy(strategyId);
  if (!strategy) throw new StrategyError('战法不存在');
  if (strategy.kind !== 'miaoxiang') {
    throw new StrategyError('该战法不是妙想镜像账户，无法同步');
  }

  // positions / orders 必须成功（失败抛错 → 上层回退到上次快照，不清库）。
  // balance 仅 best-effort 取初始资金：现金以 positions.availBalance 为权威来源。
  const [posResp, orderResp] = await Promise.all([
    miaoxiang.positions(),
    miaoxiang.orders(),
  ]);

  const { cash, positions } = parseAccount(posResp);
  const trades = parseTrades(orderResp);

  let initMoney = 0;
  try {
    initMoney = parseInitMoney(await miaoxiang.balance());
  } catch (e) {
    console.warn(`[miaoxiang] balance 取初始资金失败，沿用现值: ${e instanceof Error ? e.message : e}`);
  }

  const now = nowIso();
  db.transaction((tx) => {
    // 覆盖资金（initMoney 作为初始资金，与本系统初始一致）
    tx.update(schema.strategies)
      .set({
        cash,
        initialCapital: initMoney > 0 ? initMoney : strategy.initialCapital,
        syncedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.strategies.id, strategyId))
      .run();

    // 持仓：清空后按妙想重写
    tx.delete(schema.simPositions).where(eq(schema.simPositions.strategyId, strategyId)).run();
    for (const p of positions) {
      tx.insert(schema.simPositions)
        .values({
          id: newId(),
          strategyId,
          code: p.code,
          name: p.name,
          qty: p.qty,
          avgCost: p.avgCost,
          updatedAt: now,
        })
        .run();
    }

    // 成交流水：删除 source=miaoxiang 旧记录后按成交单重插
    tx.delete(schema.simTrades)
      .where(and(eq(schema.simTrades.strategyId, strategyId), eq(schema.simTrades.source, 'miaoxiang')))
      .run();
    for (const t of trades) {
      tx.insert(schema.simTrades)
        .values({
          id: newId(),
          strategyId,
          runId: null,
          extId: t.extId || null,
          code: t.code,
          name: t.name,
          side: t.side,
          qty: t.qty,
          price: t.price,
          amount: t.amount,
          realizedProfit: null,
          // 操作原因兜底：mx_trade 落库的 reason 按 code/side/date 回填，避免被同步清空
          reason: getTradeReason(strategyId, t.code, t.side, t.tradeDate),
          source: 'miaoxiang',
          tradeDate: t.tradeDate,
          createdAt: t.createdAt,
        })
        .run();
    }
  });

  return { syncedAt: now };
}
