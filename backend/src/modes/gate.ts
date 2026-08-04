import type { PromotionGateResult, ResearchModeDaily } from '@stock-agent/shared';
import { evaluatePromotionGate, type GateTrade } from '../strategy/promotionGate';
import { orderedDaily } from './repo';

// 模式库的晋级门：把每日跟踪快照还原成一笔笔「持仓回合」，再交给统一的晋级门体检。
// 模式库现在只展示累计收益曲线，看上去谁都很能打；这里补上「这条曲线到底有多少独立证据支撑」。

/**
 * 把日跟踪还原成持仓回合：某标的连续出现在 holdings 里算一个回合，中断即平仓。
 * 每日组合收益按当日权重分摊到各持仓，回合收益 = 期间分摊收益之和（百分点）。
 *
 * ponytail: 单仓模式（ETF 主线轮动这类）下这个分摊是精确的；多仓模式下按权重线性分摊，
 * 会把「同涨同跌」的共同因子平均分给各持仓，无法体现个股 alpha。上限是回合收益的归因精度，
 * 升级路径：让跟踪引擎在 daily 里直接落每只持仓的当日收益。
 */
export function dailyToTrades(days: ResearchModeDaily[]): GateTrade[] {
  interface Open {
    entryDate: string;
    pnl: number;
  }
  const open = new Map<string, Open>();
  const done: GateTrade[] = [];

  for (const d of days) {
    const held = new Set(d.holdings.map((h) => h.code));
    // 先结算已不在持仓里的回合
    for (const [code, ep] of [...open.entries()]) {
      if (!held.has(code)) {
        done.push({ entryDate: ep.entryDate, sector: null, netPnl: ep.pnl });
        open.delete(code);
      }
    }
    // 当日收益按权重分摊给各持仓
    const totalWeight = d.holdings.reduce((s, h) => s + (h.weight || 0), 0);
    for (const h of d.holdings) {
      const ep = open.get(h.code) ?? { entryDate: d.date, pnl: 0 };
      if (d.dayReturn != null && totalWeight > 0) {
        ep.pnl += d.dayReturn * ((h.weight || 0) / totalWeight);
      }
      open.set(h.code, ep);
    }
  }
  // 期末仍持有的回合不计入：未平仓的浮盈不是「完整可归因」的样本
  return done;
}

/** 某模式的晋级门体检（变体数取模式申报值，未申报则不计多重检验惩罚） */
export function evaluateModeGate(modeId: string, variantCount: number): PromotionGateResult {
  return evaluateModeGateFromDaily(orderedDaily(modeId), variantCount);
}

/** 同上，但日跟踪由调用方预先批量取好（列表页避免逐模式全表读） */
export function evaluateModeGateFromDaily(
  days: ResearchModeDaily[],
  variantCount: number,
): PromotionGateResult {
  return evaluatePromotionGate(dailyToTrades(days), variantCount);
}
