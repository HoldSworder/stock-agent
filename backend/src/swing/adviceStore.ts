import { and, desc, eq } from 'drizzle-orm';
import type { KlineBar, SwingAdvice, SwingAdviceLayer, SwingGrade } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso, shanghaiToday } from '../util';
import { shiftTradingDays } from '../market/calendar';
import { evaluateAdvice, type AdviceState, type AdviceAction } from './advice';
import { isExDividendName } from './judge';
import { heldLayerCount as etfWatchHeldLayers } from '../etfwatch/store';
import { computeSwingSizing, splitLayers } from './sizing';

// 建议持仓的落库与推进。
//
// 与 advice.ts 的分工：那边是纯函数（给状态和 K 线，算出该做什么），
// 这边负责读写数据库、算额度占用、把动作落成事件。分开是为了让状态机能被自检穷举。
//
// 两条硬约束：
//  1) **写事件与改状态必须同一事务**，且事件带幂等键。
//     现有 etfwatch 是分两次写的，进程在中间退出会出现「有告警、无持仓状态」，
//     这个坑不要复制。
//  2) 未执行的建议**照样占用额度**。否则一天没买、第二天又能继续堆建议，
//     20% 的合计上限就形同虚设。

/** 读所有仍在跟踪的建议 */
export function listOpenAdvices(): Array<typeof schema.swingAdviceState.$inferSelect> {
  return db
    .select()
    .from(schema.swingAdviceState)
    .where(eq(schema.swingAdviceState.status, 'open'))
    .orderBy(desc(schema.swingAdviceState.updatedAt))
    .all();
}

/** 当前在跟踪的建议条数 */
export function countOpenAdvices(): number {
  return listOpenAdvices().length;
}

/** 当前被未验证建议占用的额度合计 %（不含指定标的） */
export function usedBudgetPct(excludeCode?: string): number {
  return listOpenAdvices()
    .filter((a) => a.code !== excludeCode)
    .reduce((s, a) => s + a.targetPct, 0);
}

function parseLayers(json: string): SwingAdviceLayer[] {
  try {
    const obj = JSON.parse(json) as Record<string, { pct: number; price: number; at: string }>;
    return Object.entries(obj)
      .map(([k, v]) => ({ layer: Number(k) as 1 | 2, pct: v.pct, price: v.price, at: v.at }))
      .sort((a, b) => a.layer - b.layer);
  } catch {
    return [];
  }
}

function stringifyLayers(layers: SwingAdviceLayer[]): string {
  const obj: Record<string, { pct: number; price: number; at: string }> = {};
  for (const l of layers) obj[String(l.layer)] = { pct: l.pct, price: l.price, at: l.at };
  return JSON.stringify(obj);
}

/** 行 → 状态机用的状态 */
function toState(row: typeof schema.swingAdviceState.$inferSelect): AdviceState {
  return {
    layers: parseLayers(row.layers),
    targetPct: row.targetPct,
    avgCost: row.avgCost,
    initialStop: row.initialStop,
    currentStop: row.currentStop,
    peakPrice: row.peakPrice,
    firstRHit: row.firstRHit,
    firstLayerTradeDate: row.firstLayerTradeDate,
    zone: { low: row.zoneLow, high: row.zoneHigh },
    // 追高线不入表：它由区间与波动算出，重算比存一份可能过期的副本更可靠
    chaseGuard: row.zoneHigh + (row.zoneHigh - row.zoneLow) * 0.667,
  };
}

/** 行 → 对外 DTO */
export function toDto(
  row: typeof schema.swingAdviceState.$inferSelect,
  realPct: number | null,
): SwingAdvice {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    direction: row.direction as SwingAdvice['direction'],
    status: row.status as SwingAdvice['status'],
    zone: { low: row.zoneLow, high: row.zoneHigh },
    initialStop: row.initialStop,
    currentStop: row.currentStop,
    layers: parseLayers(row.layers),
    targetPct: row.targetPct,
    avgCost: row.avgCost,
    firstRHit: row.firstRHit,
    firstLayerTradeDate: row.firstLayerTradeDate,
    realPositionPct: realPct,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 把动作写成事件并更新状态。同一事务，事件带幂等键 */
function commit(
  row: typeof schema.swingAdviceState.$inferSelect,
  actions: AdviceAction[],
  next: AdviceState,
  tradeDate: string,
  ruleVersion: string,
): void {
  if (actions.length === 0) return;
  db.transaction((tx) => {
    for (const a of actions) {
      // 幂等键：同一标的、同一交易日、同一动作只记一次。
      // 重启后重跑当日评估不会重复建仓或重复减仓
      const signalKey = `${row.code}:${tradeDate}:${a.kind}`;
      const dup = tx
        .select()
        .from(schema.swingAdviceEvents)
        .where(eq(schema.swingAdviceEvents.signalKey, signalKey))
        .all();
      if (dup.length > 0) continue;
      tx.insert(schema.swingAdviceEvents)
        .values({
          id: newId(),
          stateId: row.id,
          code: row.code,
          kind: a.kind,
          signalKey,
          pctBefore: row.targetPct,
          pctAfter: a.pctAfter,
          price: a.price,
          reason: a.reason,
          dataDate: tradeDate,
          tradeDate,
          ruleVersion,
          createdAt: nowIso(),
        })
        .run();
    }
    tx.update(schema.swingAdviceState)
      .set({
        targetPct: next.targetPct,
        avgCost: next.avgCost,
        currentStop: next.currentStop,
        peakPrice: next.peakPrice,
        firstRHit: next.firstRHit,
        layers: stringifyLayers(next.layers),
        status: next.targetPct > 0 ? 'open' : 'closed',
        stateVersion: row.stateVersion + 1,
        updatedAt: nowIso(),
      })
      .where(eq(schema.swingAdviceState.id, row.id))
      .run();
  });
}

/** 推进所有在跟踪的建议 */
export function advanceAdvices(input: {
  barByCode: Map<string, KlineBar>;
  gradeByCode: Map<string, SwingGrade>;
  layer2PctByCode: Map<string, number>;
  ruleVersion: string;
  tradeDate?: string;
}): { advanced: number; blocked: Array<{ code: string; reason: string }> } {
  const tradeDate = input.tradeDate ?? shanghaiToday();
  const blocked: Array<{ code: string; reason: string }> = [];
  let advanced = 0;

  for (const row of listOpenAdvices()) {
    const bar = input.barByCode.get(row.code);
    if (!bar) {
      blocked.push({ code: row.code, reason: '今天没取到这只的行情，暂时无法检查' });
      continue;
    }
    // 距第一层建立过了几个交易日
    let days = 0;
    if (row.firstLayerTradeDate) {
      let d = row.firstLayerTradeDate;
      while (d < tradeDate && days < 60) {
        d = shiftTradingDays(d, 1);
        days += 1;
      }
    }
    const decision = evaluateAdvice({
      state: toState(row),
      bar,
      tradeDate,
      tradeDaysSinceFirstLayer: days,
      grade: input.gradeByCode.get(row.code) ?? 'none',
      layer2Pct: input.layer2PctByCode.get(row.code) ?? 0,
    });
    if (decision.blockedReason) {
      blocked.push({ code: row.code, reason: decision.blockedReason });
      continue;
    }
    if (decision.actions.length > 0) {
      commit(row, decision.actions, decision.next, tradeDate, input.ruleVersion);
      advanced += 1;
    }
  }
  return { advanced, blocked };
}

/**
 * 新建一条建议持仓（建第一层）。
 *
 * 已有同标的在跟踪时不重复建：一个标的同时挂两条建议，
 * 额度会被算两次，仓位上限就失效了。
 */
export function openAdvice(input: {
  code: string;
  name: string;
  direction: 'long_bottom';
  zone: { low: number; high: number };
  initialStop: number;
  bars: KlineBar[];
  assetType: 'etf' | 'stock';
  totalEquity: number;
  realPct: number;
  ruleVersion: string;
  tradeDate?: string;
}): { created: boolean; reason: string; allowedPct?: number } {
  const tradeDate = input.tradeDate ?? shanghaiToday();
  const exists = db
    .select()
    .from(schema.swingAdviceState)
    .where(
      and(
        eq(schema.swingAdviceState.code, input.code),
        eq(schema.swingAdviceState.status, 'open'),
      ),
    )
    .all();
  if (exists.length > 0) return { created: false, reason: '这只已经在跟踪中，不重复建' };
  // 除权除息日不建仓。定级层已经拦了一道，这里再拦一次——
  // 建仓是真金白银的动作，值得两处独立防护，而不是依赖上游一定传了标的名
  if (isExDividendName(input.name)) {
    return { created: false, reason: '今天除权除息，价格是断层的，不建仓' };
  }

  const sizing = computeSwingSizing({
    assetType: input.assetType,
    // 按区间上沿算，也就是最不利的那个入场价
    entryPrice: input.zone.high,
    initialStop: input.initialStop,
    totalEquity: input.totalEquity,
    bars: input.bars,
    realPct: input.realPct,
    etfWatchHeldLayers: etfWatchHeldLayers(input.code),
    usedByOthersPct: usedBudgetPct(input.code),
  });
  if (!sizing) {
    // 盯盘已建层要单独说明：它不是「算不出来」，而是「这只已经有人在管」。
    // 混成一句会让使用者以为数据缺失，去查一个根本没坏的东西
    const layers = etfWatchHeldLayers(input.code);
    if (layers > 0) {
      return {
        created: false,
        reason: `这只 ETF 盯盘那边已经建了 ${layers} 层，仓位由盯盘统一管，波段不再另给一份`,
      };
    }
    return { created: false, reason: '算不出仓位（缺总资产或止损方向不对），不给建议' };
  }
  if (sizing.allowedPct <= 0) return { created: false, reason: sizing.note };

  const { layer1Pct } = splitLayers(sizing.allowedPct);
  if (layer1Pct <= 0) return { created: false, reason: '算出来的第一层仓位为零，不给建议' };

  const stateId = newId();
  const now = nowIso();
  db.transaction((tx) => {
    tx.insert(schema.swingAdviceState)
      .values({
        id: stateId,
        code: input.code,
        name: input.name,
        source: 'swing',
        ruleVersion: input.ruleVersion,
        direction: input.direction,
        status: 'open',
        zoneLow: input.zone.low,
        zoneHigh: input.zone.high,
        initialStop: input.initialStop,
        currentStop: input.initialStop,
        layers: stringifyLayers([
          { layer: 1, pct: layer1Pct, price: input.zone.high, at: tradeDate },
        ]),
        targetPct: layer1Pct,
        avgCost: input.zone.high,
        peakPrice: input.zone.high,
        firstRHit: false,
        firstLayerTradeDate: tradeDate,
        stateVersion: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(schema.swingAdviceEvents)
      .values({
        id: newId(),
        stateId,
        code: input.code,
        kind: 'open_layer1',
        signalKey: `${input.code}:${tradeDate}:open_layer1`,
        pctBefore: 0,
        pctAfter: layer1Pct,
        price: input.zone.high,
        reason: `进入区间 ${input.zone.low}~${input.zone.high}，建第一层 ${layer1Pct}%（${sizing.note}）`,
        dataDate: tradeDate,
        tradeDate,
        ruleVersion: input.ruleVersion,
        createdAt: now,
      })
      .run();
  });
  return { created: true, reason: sizing.note, allowedPct: layer1Pct };
}

/** 某标的的建议动作历史 */
export function listAdviceEvents(code: string, limit = 50) {
  return db
    .select()
    .from(schema.swingAdviceEvents)
    .where(eq(schema.swingAdviceEvents.code, code))
    .orderBy(desc(schema.swingAdviceEvents.createdAt))
    .limit(limit)
    .all();
}
