import type { ModeProtocolMark, PromotionGateResult, ResearchModeDaily } from '@stock-agent/shared';
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
  let prev: ResearchModeDaily | null = null;

  for (const d of days) {
    // 1) 当日收益归给**上一日**持仓：写入方的 dayReturn 是前一日持仓赚到的，
    //    按当日新选出的 holdings 分摊会让今天刚买入的标的背上买入前一天的涨跌，
    //    而今天卖出的标的因不在 holdings 里丢掉最后一段收益，两个偏差都会传导到胜率
    if (prev && d.dayReturn != null) {
      const w = prev.holdings.reduce((s, h) => s + (h.weight || 0), 0);
      if (w > 0) {
        for (const h of prev.holdings) {
          const ep = open.get(h.code);
          if (ep) ep.pnl += d.dayReturn * ((h.weight || 0) / w);
        }
      }
    }
    // 2) 收益归完再关旧回合，否则卖出腿的最后一段收益会丢
    const held = new Set(d.holdings.map((h) => h.code));
    for (const [code, ep] of [...open.entries()]) {
      if (!held.has(code)) {
        done.push({ entryDate: ep.entryDate, sector: null, netPnl: ep.pnl });
        open.delete(code);
      }
    }
    // 3) 最后开新回合
    for (const h of d.holdings) {
      if (!open.has(h.code)) open.set(h.code, { entryDate: d.date, pnl: 0 });
    }
    prev = d;
  }
  // 期末仍持有的回合不计入：未平仓的浮盈不是「完整可归因」的样本
  return done;
}

/**
 * 口径键：引擎版本 + 标的池 + 成本三者任一不同，收益就不可比。
 * 加协议列之前的历史行没有标记，统一落到 v1-legacy 桶里（那批出自 supertrend 恒不触发、
 * 回放零成本的引擎，与新版曲线混算会把偏乐观的样本算进当前证据）。
 * 导出给跟踪引擎复用：回撤的峰值也只能在同口径区段里取。
 */
export function protocolKeyOf(p: ModeProtocolMark | null | undefined): string {
  if (!p) return 'v1-legacy';
  return `${p.engineVersion}|${p.universeHash}|b${p.costBps.buyBps}/s${p.costBps.sellBps}`;
}

const protocolKey = (d: ResearchModeDaily): string => protocolKeyOf(d.protocol);

/**
 * 取「与最新快照同协议的连续区段」。只回溯到第一次口径变更为止，中间夹着旧口径就断开——
 * 跨过一次引擎升级把两头的同版本样本拼起来，等于假装中间那段不存在，回合归因也会错位。
 */
function latestProtocolRun(days: ResearchModeDaily[]): ResearchModeDaily[] {
  if (days.length === 0) return days;
  const key = protocolKey(days[days.length - 1]);
  let i = days.length - 1;
  while (i > 0 && protocolKey(days[i - 1]) === key) i--;
  return days.slice(i);
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
  const run = latestProtocolRun(days);
  const r = evaluatePromotionGate(dailyToTrades(run), variantCount);
  // 旧口径的行保留可见（曲线照旧全量展示），但不进本次统计，必须在结论里说清楚
  if (run.length < days.length) {
    const dropped = days.length - run.length;
    r.note +=
      `本次只统计最新口径（${protocolKey(run[0])}）下 ${run[0].date} 起的 ${run.length} 个交易日；` +
      `更早的 ${dropped} 个交易日出自不同引擎/标的池/成本口径，保留可见但不混算。`;
  }
  return r;
}
