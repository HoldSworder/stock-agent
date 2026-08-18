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

// 同标同因冷却：key=`${code}:${reason}` → 生效时刻与时长
const cooldown = new Map<string, { at: number; ms: number }>();
/** 已就该 key 推过「未成交」告知的集合：成交或恢复后清除，避免上游持续报错时反复刷屏 */
const failNotified = new Set<string>();

/** 本次下单尝试的结果分类，决定写多长的冷却 */
type AttemptKind =
  /** 确有成交 */
  | 'sold'
  /** 确定性拒单（跌停不可卖 / 不足一手 / T+1 锁定）：短期内不会变，但仍需重试窗口 */
  | 'rejected'
  /** 网络等偶发失败：只写一个极短退避，仓位不能因为上游抖动被冷却挡在止损之外 */
  | 'transient';

/**
 * 偶发失败的短退避。不写冷却会让上游持续报错时每个 tick（10 秒一轮）都重下单 + 重推
 * Telegram + 重落库，一小时 360 条；30 秒退避把重试频率压到可接受，又远短于任何 cooldownMin，
 * 上游一恢复就能立刻止损。
 */
const TRANSIENT_COOLDOWN_MS = 30_000;

/**
 * 冷却时长决策。冷却绝不能在下单**之前**就写：下单失败时冷却照样生效，
 * 止损信号在 cooldownMin 内不会再触发。
 * 确定性拒单用一个更短的独立冷却（1/5，且不短于 1 分钟）压住每 tick 的重复推送——
 * 下界必须用 Math.max 包在最外层，否则 cooldownMin 配 0 时 full=0 会把下界压成 0，
 * 退化成零冷却。
 */
export function cooldownMsFor(kind: AttemptKind, cooldownMin: number): number {
  const full = Math.max(0, cooldownMin) * 60_000;
  if (kind === 'sold') return full;
  if (kind === 'rejected') return Math.max(60_000, Math.min(full, full / 5));
  return TRANSIENT_COOLDOWN_MS;
}

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
  if (last && now - last.at < last.ms) {
    emitSignal(pos, exit, q, 'cooldown');
    return;
  }

  let soldQty = 0;
  let realized: number | null = null;
  let skipNote: string | null = null;
  let kind: AttemptKind = 'sold';
  const sellable = Math.floor(pos.sellableQty / 100) * 100;
  if (sellable < 100) {
    skipNote = `可卖 ${pos.sellableQty} 股不足一手（T+1 锁定或持仓过小）`;
    kind = 'rejected';
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
      // StrategyError=市场规则不满足（确定性）；其余按网络等偶发失败处理，只写短退避
      kind = e instanceof StrategyError ? 'rejected' : 'transient';
    }
  }
  if (soldQty <= 0 && kind === 'sold') kind = 'rejected'; // 未抛错但也没成交，按确定性拒单处理

  cooldown.set(key, { at: Date.now(), ms: cooldownMsFor(kind, cfg.cooldownMin) });

  emitSignal(pos, exit, q, skipNote ? 'skipped' : 'emitted');

  // 失败只推第一条：短退避后仍失败的同一 key 只落库留痕，不再刷屏
  const notifyFailure = skipNote == null || !failNotified.has(key);
  if (skipNote == null) failNotified.delete(key);
  else failNotified.add(key);

  let delivered = false;
  if (cfg.pushTelegram && notifyFailure) {
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
