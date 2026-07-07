import type {
  SimPosition,
  Strategy,
  WeipanConfig,
  WeipanDisposition,
  WeipanExitReason,
  WeipanSignal,
} from '@stock-agent/shared';
import { StrategyError, executeSimTrade } from '../strategy/sim';
import { sendTelegram } from '../notify/telegram';
import { broadcastWeipan } from './bus';
import { insertWeipanAlert } from './store';
import type { ExitResult } from './rules';

// 尾盘盯盘信号分发：全程确定性、无 gateway/LLM。命中即模拟清仓 → 落告警 → WS 广播 + Telegram 直推。

const REASON_LABEL: Record<WeipanExitReason, string> = {
  stop_loss: '止损',
  take_profit: '止盈',
  trailing: '冲高回落',
  eod: '尾盘了结',
};

// 同标同因冷却：key=`${code}:${reason}` → 上次时间戳(ms)
const cooldown = new Map<string, number>();

export interface QuoteCtx {
  price: number;
  pct: number;
  dayHigh: number;
}

function emitSignal(
  pos: SimPosition,
  exit: ExitResult,
  q: QuoteCtx,
  disposition: WeipanDisposition,
): void {
  const signal: WeipanSignal = {
    code: pos.code,
    name: pos.name,
    reason: exit.reason,
    price: q.price,
    pct: q.pct,
    avgCost: pos.avgCost,
    dayHigh: q.dayHigh,
    gainPct: exit.gainPct,
    drawdownPct: exit.drawdownPct,
    detail: exit.detail,
    at: new Date().toISOString(),
    disposition,
  };
  broadcastWeipan({ type: 'signal', signal });
}

/**
 * 确定性处理一次卖点命中：模拟清仓（可卖全部）→ 落告警 → WS 广播 + Telegram 直推。
 * 市场规则（跌停不可卖 / T+1 / 可卖不足）由 executeSimTrade 强校验，被拒则记为 skipped。
 */
export async function processWeipanExit(
  strategy: Strategy,
  pos: SimPosition,
  exit: ExitResult,
  q: QuoteCtx,
  cfg: WeipanConfig,
): Promise<void> {
  const key = `${pos.code}:${exit.reason}`;
  const now = Date.now();
  const last = cooldown.get(key);
  if (last != null && now - last < cfg.cooldownMin * 60_000) {
    emitSignal(pos, exit, q, 'cooldown');
    return;
  }
  cooldown.set(key, now);

  let soldQty = 0;
  let realized: number | null = null;
  let skipNote: string | null = null;
  const sellable = Math.floor(pos.sellableQty / 100) * 100;
  if (sellable < 100) {
    skipNote = `可卖 ${pos.sellableQty} 股不足一手（T+1 锁定或持仓过小）`;
  } else {
    try {
      const r = await executeSimTrade({
        strategyId: strategy.id,
        side: 'sell',
        code: pos.code,
        qty: sellable,
        price: null,
        reason: `尾盘盯盘·${REASON_LABEL[exit.reason]}：${exit.detail}`,
        source: 'watch',
      });
      soldQty = r.trade.qty;
      realized = r.trade.realizedProfit;
    } catch (e) {
      skipNote = e instanceof StrategyError ? e.message : e instanceof Error ? e.message : String(e);
    }
  }

  emitSignal(pos, exit, q, skipNote ? 'skipped' : 'emitted');

  let delivered = false;
  if (cfg.pushTelegram) {
    const gainTag = realized != null ? `，实现盈亏 ${realized.toFixed(2)}` : '';
    const body =
      soldQty > 0
        ? `已模拟卖出 ${soldQty} 股 @${q.price.toFixed(2)}${gainTag}`
        : `未成交：${skipNote}`;
    const text =
      `【尾盘盯盘·${REASON_LABEL[exit.reason]}·${strategy.name}】${pos.name}(${pos.code})\n` +
      `触发：${exit.detail}\n\n${body}`;
    try {
      const r = await sendTelegram(text);
      delivered = r.ok;
    } catch {
      delivered = false;
    }
  }

  const alert = insertWeipanAlert({
    code: pos.code,
    name: pos.name,
    reason: exit.reason,
    detail: exit.detail + (skipNote ? `｜未成交：${skipNote}` : ''),
    triggerPrice: q.price,
    soldQty,
    realizedProfit: realized,
    delivered,
    skipNote,
  });
  broadcastWeipan({ type: 'alert', alert });
}
