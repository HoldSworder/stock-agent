import type { ScreenPick } from '@stock-agent/shared';
import { isTradingDay } from '../market/calendar';
import { runScreen } from '../screener/service';
import { runMidDrilldown } from '../rotation/service';
import { isAutoSimAllowed } from './forward';
import {
  StrategyError,
  executeSimTrade,
  getStrategySnapshot,
  listStrategies,
} from './sim';

// M4 中线验证闭环（闭环 A）：调仓编排器。交易日定时按战法绑定口径选出 TopN 目标持仓，
// diff 当前持仓后对「应持有但未持有」的标的自动模拟建仓（executeSimTrade）。
// 所有市场规则（交易时段/涨跌停/T+1/100 股/可买现金）与 kill switch / 自动总闸均由 executeSimTrade 强校验，
// 本编排器只负责「选标的 + 计算仓位 + 调用」，不重复做风控判断。卖出仍由盯盘 weekly_break/止损链路负责。

/** 单战法调仓默认目标持仓数 / 最大持仓数 */
const DEFAULT_PICK_TOPN = 5;
const DEFAULT_MAX_POSITIONS = 5;

export interface RebalanceResult {
  strategyId: string;
  strategyName: string;
  /** 是否实际执行了（false=被闸门/非交易日/无目标跳过） */
  ran: boolean;
  /** 跳过原因（ran=false 时） */
  skipReason?: string;
  /** 成功建仓的标的 */
  bought: Array<{ code: string; name: string; qty: number; price: number }>;
  /** 跳过建仓的标的 + 原因（现金不足/涨停/规则不满足等） */
  skipped: Array<{ code: string; reason: string }>;
}

/** 按战法绑定口径取目标 TopN：中线走轮动下钻，其余走绑定的选股策略 */
async function resolveTargets(strategy: {
  id: string;
  horizon: 'short' | 'mid';
  screenStrategyId: string | null;
  pickTopN: number | null;
}): Promise<ScreenPick[]> {
  const topN = strategy.pickTopN ?? DEFAULT_PICK_TOPN;
  if (strategy.horizon === 'mid') {
    // 中线：强赛道 ETF → 成分股下钻 → mid_leader 选龙头（纯量化，不调 LLM 控成本/提速）
    const drill = await runMidDrilldown({ pickTopN: topN, useLlm: false, trigger: 'cron' });
    return drill.run?.picks ?? [];
  }
  // 短线/其它：用战法绑定的选股策略跑一轮（未绑定则无目标）
  if (!strategy.screenStrategyId) return [];
  const run = await runScreen({
    engine: 'multifactor',
    strategyId: strategy.screenStrategyId,
    topN,
    useLlm: false,
    trigger: 'cron',
  });
  return run.picks;
}

/**
 * 对单个本地战法执行一次调仓建仓。
 * 仅当 isAutoSimAllowed（全局总闸 + 单战法白名单）为真才动作；否则原样跳过。
 */
export async function rebalanceStrategy(strategyId: string): Promise<RebalanceResult> {
  const list = listStrategies();
  const strategy = list.find((s) => s.id === strategyId);
  const base: RebalanceResult = {
    strategyId,
    strategyName: strategy?.name ?? strategyId,
    ran: false,
    bought: [],
    skipped: [],
  };
  if (!strategy) return { ...base, skipReason: '战法不存在' };
  if (strategy.kind !== 'local' || strategy.archived) {
    return { ...base, skipReason: '非本地或已归档战法' };
  }
  if (!isAutoSimAllowed(strategyId)) {
    return { ...base, skipReason: '自动模拟未开启（全局总闸或单战法白名单关闭）' };
  }

  const targets = await resolveTargets({
    id: strategy.id,
    horizon: strategy.horizon === 'mid' ? 'mid' : 'short',
    screenStrategyId: strategy.screenStrategyId ?? null,
    pickTopN: strategy.pickTopN ?? null,
  });
  if (targets.length === 0) {
    return { ...base, skipReason: '本轮无目标标的（选股为空或未绑定选股策略）' };
  }

  const topN = strategy.pickTopN ?? DEFAULT_PICK_TOPN;
  const maxPositions = strategy.maxPositions ?? DEFAULT_MAX_POSITIONS;

  const snap = await getStrategySnapshot(strategyId, { skipSync: true });
  const held = new Set(snap.positions.map((p) => p.code));
  const heldCount = held.size;
  const freeSlots = Math.max(0, maxPositions - heldCount);
  if (freeSlots === 0) {
    return { ...base, skipReason: `已满仓（持仓 ${heldCount}/${maxPositions}）` };
  }

  // 应持有但未持有的目标（按排名），最多补到 freeSlots
  const toBuy = targets
    .slice(0, topN)
    .filter((p) => !held.has(p.code) && /^\d{6}$/.test(p.code))
    .slice(0, freeSlots);
  if (toBuy.length === 0) {
    return { ...base, ran: true, skipReason: '目标标的已全部在持仓内，无需建仓' };
  }

  // 等权目标：按总资产 / 最大持仓数 估算单标的预算，再受可用现金约束
  const perSlotBudget = snap.totalAsset / Math.max(maxPositions, 1);
  const result: RebalanceResult = { ...base, ran: true, bought: [], skipped: [] };
  let cashLeft = snap.strategy.cash;

  for (const pick of toBuy) {
    const price = pick.price;
    if (!Number.isFinite(price) || price <= 0) {
      result.skipped.push({ code: pick.code, reason: '快照价无效' });
      continue;
    }
    const budget = Math.min(perSlotBudget, cashLeft);
    const qty = Math.floor(budget / price / 100) * 100;
    if (qty < 100) {
      result.skipped.push({ code: pick.code, reason: `现金不足一手（预算 ${budget.toFixed(0)} 元）` });
      continue;
    }
    try {
      const r = await executeSimTrade({
        strategyId,
        side: 'buy',
        code: pick.code,
        qty,
        price: null, // 用实时现价成交（executeSimTrade 内取价 + A 股规则校验）
        reason: `调仓建仓·${strategy.horizon === 'mid' ? '中线龙头' : '选股'} TopN（排名 ${pick.rank}）`,
        source: 'cron',
      });
      result.bought.push({ code: pick.code, name: pick.name, qty: r.trade.qty, price: r.trade.price });
      cashLeft = r.cash;
    } catch (e) {
      // 涨停/非交易时段/可买不足等规则不满足：安全跳过，记录原因
      const msg = e instanceof StrategyError ? e.message : e instanceof Error ? e.message : String(e);
      result.skipped.push({ code: pick.code, reason: msg });
    }
  }
  return result;
}

/**
 * 全战法调仓（收盘前定时调用）：遍历所有本地战法逐个调仓。
 * 交易日校验：非交易日直接空跑（与既有定时一致，接口异常按交易日继续）。
 */
export async function runRebalanceAll(): Promise<RebalanceResult[]> {
  if (!isTradingDay()) return [];
  const out: RebalanceResult[] = [];
  for (const s of listStrategies().filter((s) => s.kind === 'local' && !s.archived)) {
    try {
      out.push(await rebalanceStrategy(s.id));
    } catch (e) {
      out.push({
        strategyId: s.id,
        strategyName: s.name,
        ran: false,
        skipReason: `调仓异常：${e instanceof Error ? e.message : e}`,
        bought: [],
        skipped: [],
      });
    }
  }
  return out;
}
