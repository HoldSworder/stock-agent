import { and, asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { getKline } from '../market/eastmoney';
import { getMeta, setMeta } from '../settings';
import { newId, nowIso } from '../util';
import { getStrategy, listStrategies, resetStrategy, shanghaiDate } from './sim';
import { syncMiaoxiangStrategy } from './miaoxiangSync';
import { fetchMoneyEffectSeries, positionForDate, type MoneyEffectBar } from './moneyEffectSignal';

// 首板择时·影子战法：把原「妙想东财模拟盘」镜像的每日真实成交，按 883994 首板赚钱效应择时
// （站上MA5且MA5向上→可开新仓，否则空仓不开新仓；已有持仓永不因信号强平、只走 mx 真实卖点）
// 重放进一套系统内的本地影子战法。只读镜像成交 + 只写本地库，绝不触碰真实东财模拟盘。
// 重放按成交单 extId 幂等（回填/每日重跑安全）；被门槛跳过的买入不留痕，重跑按同日信号一致再跳过。

export const SHADOW_NAME = '妙想·首板择时影子盘';
export const MIRROR_NAME = '妙想东财模拟盘';
/** 回填起点（妙想模拟盘首笔成交日；早于此不回填） */
const SHADOW_START = '2026-05-13';
/** 一次性回填幂等标志（settings meta） */
const BACKFILL_FLAG = 'shadow_backfilled';

type SimTradeRow = typeof schema.simTrades.$inferSelect;

/** 取影子(local) 与镜像(miaoxiang) 两个战法（按名 + kind），任一缺失返回 null */
function getShadowAndMirror(): { shadowId: string; mirrorId: string; initialCapital: number } | null {
  const all = listStrategies(true);
  const shadow = all.find((s) => s.name === SHADOW_NAME && s.kind === 'local');
  const mirror = all.find((s) => s.name === MIRROR_NAME && s.kind === 'miaoxiang');
  if (!shadow || !mirror) return null;
  return { shadowId: shadow.id, mirrorId: mirror.id, initialCapital: shadow.initialCapital };
}

/** 镜像某日的真实成交（source=miaoxiang），按 createdAt 升序（保留买卖真实先后） */
function mirrorTradesOn(mirrorId: string, date: string): SimTradeRow[] {
  return db
    .select()
    .from(schema.simTrades)
    .where(
      and(
        eq(schema.simTrades.strategyId, mirrorId),
        eq(schema.simTrades.source, 'miaoxiang'),
        eq(schema.simTrades.tradeDate, date),
      ),
    )
    .orderBy(asc(schema.simTrades.createdAt))
    .all();
}

/** 影子已重放成交的去重键集合（extId），供幂等跳过 */
function shadowSeenKeys(shadowId: string): Set<string> {
  const rows = db
    .select({ extId: schema.simTrades.extId })
    .from(schema.simTrades)
    .where(eq(schema.simTrades.strategyId, shadowId))
    .all();
  return new Set(rows.map((r) => r.extId).filter((x): x is string => !!x));
}

/** 成交单稳定去重键：优先 mx 订单 id，缺失则用稳定字段拼（跨镜像同步不变） */
function dedupKey(t: SimTradeRow): string {
  return t.extId || `mx:${t.code}|${t.side}|${t.tradeDate}|${t.qty}|${t.price}`;
}

/**
 * 重放镜像某日成交到影子战法（gate_only）：signal 满则买入照价照量执行，空则跳过买入；
 * 卖出永远执行但封顶当前持仓；已有持仓不因信号强平。extId 幂等，seen 会就地更新。
 * 单日一个事务，直接读写 sim_positions / sim_trades / strategies.cash（不走 executeSimTrade）。
 */
function replayTradesForDate(
  shadowId: string,
  mirrorId: string,
  date: string,
  signal: 0 | 1,
  seen: Set<string>,
): void {
  const trades = mirrorTradesOn(mirrorId, date);
  if (trades.length === 0) return;
  db.transaction((tx) => {
    const sRow = tx.select().from(schema.strategies).where(eq(schema.strategies.id, shadowId)).get();
    if (!sRow) return;
    let cash = sRow.cash;
    const now = nowIso();

    const posOf = (code: string) =>
      tx
        .select()
        .from(schema.simPositions)
        .where(and(eq(schema.simPositions.strategyId, shadowId), eq(schema.simPositions.code, code)))
        .get();

    for (const t of trades) {
      const key = dedupKey(t);
      if (seen.has(key)) continue; // 已重放，幂等跳过

      if (t.side === 'buy') {
        if (signal !== 1) continue; // 空仓：不开新仓（不留痕，重跑同日仍跳过）
        const amount = t.qty * t.price;
        // 影子盘初始资金可能小于镜像账户，硬扣会让现金变负、净值曲线失真且无人察觉。
        // 买不起就跳过并显式告警，让「口径失配」暴露出来（不留痕，重跑同日仍跳过）。
        if (amount > cash) {
          console.warn(
            `[shadow] ${t.tradeDate} ${t.code} 现金不足（需 ${amount.toFixed(0)} / 余 ${cash.toFixed(0)}），跳过该笔买入；影子盘初始资金与镜像账户不一致`,
          );
          continue;
        }
        const existing = posOf(t.code);
        if (existing) {
          const newQty = existing.qty + t.qty;
          const newAvg = (existing.qty * existing.avgCost + amount) / newQty;
          tx.update(schema.simPositions)
            .set({ qty: newQty, avgCost: newAvg, name: t.name, updatedAt: now })
            .where(eq(schema.simPositions.id, existing.id))
            .run();
        } else {
          tx.insert(schema.simPositions)
            .values({
              id: newId(),
              strategyId: shadowId,
              code: t.code,
              name: t.name,
              qty: t.qty,
              avgCost: t.price,
              updatedAt: now,
            })
            .run();
        }
        cash -= amount;
        tx.insert(schema.simTrades)
          .values({
            id: newId(),
            strategyId: shadowId,
            runId: null,
            extId: key,
            code: t.code,
            name: t.name,
            side: 'buy',
            qty: t.qty,
            price: t.price,
            amount,
            realizedProfit: null,
            reason: '首板择时:满·跟随mx买入',
            source: 'shadow',
            tradeDate: t.tradeDate,
            createdAt: t.createdAt,
          })
          .run();
        seen.add(key);
      } else {
        // 卖出：只卖手上实际持有的量（被门槛跳过的买入 → 无持仓可卖 → sellQty=0 跳过）
        const pos = posOf(t.code);
        const held = pos?.qty ?? 0;
        const sellQty = Math.min(t.qty, held);
        if (sellQty <= 0 || !pos) continue;
        const amount = sellQty * t.price;
        const realized = sellQty * (t.price - pos.avgCost);
        const remaining = pos.qty - sellQty;
        if (remaining <= 1e-6) {
          tx.delete(schema.simPositions).where(eq(schema.simPositions.id, pos.id)).run();
        } else {
          tx.update(schema.simPositions)
            .set({ qty: remaining, updatedAt: now })
            .where(eq(schema.simPositions.id, pos.id))
            .run();
        }
        cash += amount;
        tx.insert(schema.simTrades)
          .values({
            id: newId(),
            strategyId: shadowId,
            runId: null,
            extId: key,
            code: t.code,
            name: t.name,
            side: 'sell',
            qty: sellQty,
            price: t.price,
            amount,
            realizedProfit: realized,
            reason: '跟随mx卖出',
            source: 'shadow',
            tradeDate: t.tradeDate,
            createdAt: t.createdAt,
          })
          .run();
        seen.add(key);
      }
    }

    tx.update(schema.strategies)
      .set({ cash, updatedAt: now })
      .where(eq(schema.strategies.id, shadowId))
      .run();
  });
}

/** 影子当前状态（现金 + 持仓）供净值快照 */
function readShadowState(shadowId: string): {
  cash: number;
  positions: { code: string; qty: number; avgCost: number }[];
} {
  const s = getStrategy(shadowId);
  const positions = db
    .select()
    .from(schema.simPositions)
    .where(eq(schema.simPositions.strategyId, shadowId))
    .all()
    .map((p) => ({ code: p.code, qty: p.qty, avgCost: p.avgCost }));
  return { cash: s?.cash ?? 0, positions };
}

/** 某 code 在日期 d 或之前最近一根收盘（carry-forward 兜停牌），无则 null */
function closeOnOrBefore(bars: { time: string; close: number }[], d: string): number | null {
  let close: number | null = null;
  for (const b of bars) {
    if (b.time <= d && b.close > 0) close = b.close;
    if (b.time > d) break;
  }
  return close;
}

/** upsert 影子某日权益样本（同日幂等） */
function upsertSample(
  shadowId: string,
  date: string,
  totalAsset: number,
  totalProfitRate: number,
  positionCount: number,
  cash: number,
): void {
  const existing = db
    .select({ id: schema.strategySamples.id })
    .from(schema.strategySamples)
    .where(
      and(
        eq(schema.strategySamples.strategyId, shadowId),
        eq(schema.strategySamples.sampleDate, date),
      ),
    )
    .get();
  const values = { totalAsset, totalProfitRate, positionCount, cash };
  if (existing) {
    db.update(schema.strategySamples).set(values).where(eq(schema.strategySamples.id, existing.id)).run();
  } else {
    db.insert(schema.strategySamples)
      .values({ id: newId(), strategyId: shadowId, sampleDate: date, createdAt: nowIso(), ...values })
      .run();
  }
}

/**
 * 逐日重放信号；序列不可用返回 null 表示「本轮整体放弃」。
 *
 * 这里不允许任何「取不到就默认满仓」的乐观兜底：重放窗口里全是历史日期，
 * 乐观默认会把当初因信号为 0 而正确跳过的买单补记进影子盘，
 * 净值曲线于是随上游可用性变化、无法重现。宁可这轮不跑，下轮自愈。
 */
export function replaySignals(
  series: MoneyEffectBar[],
  dates: string[],
): Array<{ date: string; signal: 0 | 1 }> | null {
  if (series.length === 0) return null;
  return dates.map((date) => ({ date, signal: positionForDate(series, date) }));
}

/**
 * 每日重放（自愈补漏）：收盘后（mx 定时任务结束后）把近 30 天窗口内镜像成交按门槛重放进影子，
 * 各日用其当日 883994 信号。按 extId 幂等去重——已重放（含回填）为 no-op，只补真正漏掉的日期，
 * 使某天 15:40 后端漏跑/建盘晚于收盘也能在下次运行自动补齐。
 *
 * 883994 取数失败时整轮放弃（留待下次自愈），绝不退回「各日默认满仓」：窗口里都是历史日期，
 * 乐观默认会把当初因信号为 0 而正确跳过的买单补记进来，净值曲线随上游可用性变化、不可重现。
 */
export async function runShadowDaily(): Promise<void> {
  const ids = getShadowAndMirror();
  if (!ids) {
    console.warn('[shadow] 影子/镜像战法未就绪，跳过每日重放');
    return;
  }
  try {
    await syncMiaoxiangStrategy(ids.mirrorId);
  } catch (e) {
    console.warn(`[shadow] 镜像同步失败，用现有成交重放: ${e instanceof Error ? e.message : e}`);
  }
  // 883994 信号序列（一次取，逐日算各自当日仓位）；取空/取失败一律放弃本轮，保留下次自愈机会
  let series: MoneyEffectBar[];
  try {
    series = await fetchMoneyEffectSeries();
  } catch (e) {
    console.warn(
      `[shadow] 883994 取数失败，本轮不重放（历史日期不做乐观默认，避免补记当初正确跳过的买单）: ${e instanceof Error ? e.message : e}`,
    );
    return;
  }
  const today = shanghaiDate();
  // 自愈补漏窗口：近 30 自然日内的镜像成交日期（升序），覆盖某日 15:40 漏跑/建盘晚于收盘；
  // 更早历史由 backfillShadow 覆盖，seen(extId) 去重保证已重放日期为 no-op、可安全重复。
  const floor = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.parse(`${today}T00:00:00+08:00`) - 30 * 86_400_000));

  const dates = db
    .select({ d: schema.simTrades.tradeDate })
    .from(schema.simTrades)
    .where(
      and(eq(schema.simTrades.strategyId, ids.mirrorId), eq(schema.simTrades.source, 'miaoxiang')),
    )
    .all()
    .map((r) => r.d)
    .filter((d) => d >= floor && d <= today);
  const uniqAsc = Array.from(new Set(dates)).sort();

  const plan = replaySignals(series, uniqAsc);
  if (!plan) {
    console.warn('[shadow] 883994 序列为空，本轮不重放');
    return;
  }
  const seen = shadowSeenKeys(ids.shadowId);
  for (const { date, signal } of plan) {
    replayTradesForDate(ids.shadowId, ids.mirrorId, date, signal, seen);
  }
  console.log(`[shadow] 每日重放完成，覆盖 ${uniqAsc.length} 个成交日（至 ${today}）`);
}

/**
 * 一次性回填：从 2026-05-13 起逐交易日按门槛重放镜像全部成交，并回填每日净值曲线。
 * settings 标志 shadow_backfilled 幂等；best-effort，失败不阻断启动。
 */
export async function backfillShadow(): Promise<void> {
  if (getMeta(BACKFILL_FLAG) === 'done') return;
  const ids = getShadowAndMirror();
  if (!ids) {
    console.warn('[shadow] 影子/镜像战法未就绪，跳过回填');
    return;
  }
  try {
    await syncMiaoxiangStrategy(ids.mirrorId);
  } catch (e) {
    console.warn(`[shadow] 回填前镜像同步失败，用现有成交: ${e instanceof Error ? e.message : e}`);
  }

  // 镜像全部真实成交 → 涉及标的 + 首笔日期
  const allTrades = db
    .select()
    .from(schema.simTrades)
    .where(and(eq(schema.simTrades.strategyId, ids.mirrorId), eq(schema.simTrades.source, 'miaoxiang')))
    .all();
  if (allTrades.length === 0) {
    console.warn('[shadow] 镜像无成交，回填空跑（标记完成）');
    setMeta(BACKFILL_FLAG, 'done');
    return;
  }
  const firstTrade = allTrades.reduce((m, t) => (t.tradeDate < m ? t.tradeDate : m), allTrades[0].tradeDate);
  const startDate = firstTrade > SHADOW_START ? firstTrade : SHADOW_START;
  const today = shanghaiDate();

  // 交易日历用 883994 序列日期（trading calendar）
  let series: MoneyEffectBar[];
  try {
    series = await fetchMoneyEffectSeries();
  } catch (e) {
    console.warn(`[shadow] 883994 取数失败，无法回填（保留未标记，下次启动重试）: ${e instanceof Error ? e.message : e}`);
    return;
  }
  // 交易日历 = 883994 序列日期 ∪ 全部镜像成交日期（限窗口）。
  // 关键：883994 序列可能有缺口（如 2026-06-19），若只用它做日历，缺口日的成交（尤其卖出）
  // 会被 exact-date 重放整单丢弃 → 该卖的没卖、持仓虚高失真。并入成交日期确保零丢单。
  const calSet = new Set<string>();
  for (const b of series) if (b.date >= startDate && b.date <= today) calSet.add(b.date);
  for (const t of allTrades) if (t.tradeDate >= startDate && t.tradeDate <= today) calSet.add(t.tradeDate);
  const calendar = Array.from(calSet).sort();
  if (calendar.length === 0) {
    console.warn('[shadow] 交易日历为空，回填空跑（标记完成）');
    setMeta(BACKFILL_FLAG, 'done');
    return;
  }

  // 预取涉及标的历史日线（MTM 用），best-effort 缺失则该标的按成本价兜底
  const codes = Array.from(new Set(allTrades.map((t) => t.code)));
  const closeMap = new Map<string, { time: string; close: number }[]>();
  for (const code of codes) {
    try {
      const bars = await getKline(code, 'day', 250);
      closeMap.set(
        code,
        bars.map((b) => ({ time: b.time, close: b.close })),
      );
    } catch {
      closeMap.set(code, []);
    }
  }

  // 从零重放（清空影子后逐日推进）
  resetStrategy(ids.shadowId);
  const seen = new Set<string>();
  for (const d of calendar) {
    const signal = positionForDate(series, d);
    replayTradesForDate(ids.shadowId, ids.mirrorId, d, signal, seen);
    // 记录当日净值样本
    const { cash, positions } = readShadowState(ids.shadowId);
    let mv = 0;
    for (const p of positions) {
      // 日线缺失（取数失败/停牌且无历史）时按成本价兜底，等于当日不计浮动盈亏
      mv += p.qty * (closeOnOrBefore(closeMap.get(p.code) ?? [], d) ?? p.avgCost);
    }
    const totalAsset = cash + mv;
    upsertSample(
      ids.shadowId,
      d,
      totalAsset,
      ids.initialCapital > 0 ? totalAsset / ids.initialCapital - 1 : 0,
      positions.length,
      cash,
    );
  }
  setMeta(BACKFILL_FLAG, 'done');
  const last = readShadowState(ids.shadowId);
  console.log(
    `[shadow] 回填完成：${startDate}~${today}，共 ${calendar.length} 交易日，当前现金 ${last.cash.toFixed(0)}、持仓 ${last.positions.length} 只`,
  );
}
