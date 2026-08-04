import type { KlineBar, MarketRegimePhase, PositionSizing, RiskBudgetTier } from '@stock-agent/shared';

// 风险预算反推仓位：不再用「单票固定 30%」这种与波动无关的死上限，而是
//   允许权重 = min( 单笔风险预算 ÷ 有效损失距离 , 该阶段该资产的绝对上限 )
// 波动大 / 止损远的标的自动少买，且四档市场阶段各有一套预算，退潮期整体收紧。
//
// 标定说明（这是从个股短线系统搬过来时最容易搬错的地方）：
// 个股短线系统的单笔风险预算多在 0.3%~1.5%，那是配 3%~6% 的结构止损距离标的。
// 本项目以 ETF 中线为主，有效损失距离在 12% 量级，直接套 1.5% 会把单票压到 12% 以下、失去赛道暴露；
// 反过来把个股预算配宽止损又会反推出超过 100% 的仓位。故下表按本项目自身的止损距离重标。

/** 四档市场阶段的风险预算（主升最松、退潮最紧） */
const TIERS: Record<MarketRegimePhase, RiskBudgetTier> = {
  主升: {
    singleTradeRiskPct: 2.5,
    totalMaxPositionPct: 90,
    singleMaxStockPct: 30,
    singleMaxEtfPct: 40,
    boardMaxExposurePct: 50,
  },
  反弹: {
    singleTradeRiskPct: 1.5,
    totalMaxPositionPct: 60,
    singleMaxStockPct: 20,
    singleMaxEtfPct: 30,
    boardMaxExposurePct: 35,
  },
  震荡: {
    singleTradeRiskPct: 1.0,
    totalMaxPositionPct: 40,
    singleMaxStockPct: 15,
    singleMaxEtfPct: 25,
    boardMaxExposurePct: 25,
  },
  退潮: {
    singleTradeRiskPct: 0.5,
    totalMaxPositionPct: 25,
    singleMaxStockPct: 10,
    singleMaxEtfPct: 15,
    boardMaxExposurePct: 15,
  },
};

/** 取阶段对应的风险预算档；阶段未知（无快照）时按震荡档处理——不确定就取偏紧的那一档 */
export function budgetForPhase(phase: MarketRegimePhase | null): RiskBudgetTier {
  return TIERS[phase ?? '震荡'];
}

/** ATR 距离的倍数：止损若窄于 2 倍 ATR，实际会被日常波动打掉，故取两者较大者作损失距离 */
const ATR_MULT = 2;
/** ATR 计算周期（14 日真实波幅均值，业界惯例） */
const ATR_PERIOD = 14;
/** 费用 + 滑点缓冲 %（双边佣金/印花税/冲击成本的保守合计） */
const COST_BUFFER_PCT = 0.2;

/** 14 日 ATR（真实波幅均值）。不足周期返回 null。 */
export function atr(bars: KlineBar[], period = ATR_PERIOD): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = bars.length - period; i < bars.length; i += 1) {
    const cur = bars[i];
    const prevClose = bars[i - 1].close;
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose)));
  }
  return trs.reduce((s, v) => s + v, 0) / trs.length;
}

/**
 * 近 60 日向下跳空的 P95（占前收盘的百分比）：止损挂在那里也可能被一个跳空直接跨过去，
 * 这段距离必须预先从风险预算里扣掉，否则「最多亏 2.5%」是个假承诺。
 * ETF 由一篮子成分平滑，几乎不出现整体跳空，故 ETF 分支不调用本函数（缓冲取 0）。
 */
export function downGapP95(bars: KlineBar[], lookback = 60): number {
  const slice = bars.slice(-lookback);
  const gaps: number[] = [];
  for (let i = 1; i < slice.length; i += 1) {
    const prevClose = slice[i - 1].close;
    if (prevClose <= 0) continue;
    const gap = ((prevClose - slice[i].open) / prevClose) * 100;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))];
}

export interface SizingInput {
  assetType: 'stock' | 'etf';
  /** 现价 */
  price: number;
  /** 结构止损距离 %（相对成本，来自纪律规则或 ETF 信号触发价） */
  stopDistancePct: number;
  /** 账户总权益 */
  totalEquity: number;
  /** 当前持股数 */
  currentShares: number;
  /** 日线（用于 ATR 与跳空分位；缺失则这两项按 null/0 处理） */
  bars?: KlineBar[];
  /**
   * 账户/逐票配置的单票权重上限 %（纪律配置里的 singleMaxWeightPct）。
   * 与阶段绝对上限取更严的一个：阶段档只能收紧，不能因为处在主升档就放宽用户自己设的上限。
   */
  fixedCapPct?: number;
}

/**
 * 风险预算反推单票允许仓位。
 * 有效损失距离 = max(结构止损距离, ATR_MULT × ATR%) + 跳空缓冲 + 费用缓冲。
 * 允许权重 = min(风险预算 ÷ 有效损失距离, 该阶段该资产绝对上限)。
 */
export function computeSizing(input: SizingInput, budget: RiskBudgetTier): PositionSizing | null {
  const { assetType, price, stopDistancePct, totalEquity, currentShares, bars, fixedCapPct } = input;
  if (!(price > 0) || !(totalEquity > 0) || !(stopDistancePct > 0)) return null;

  const a = bars && bars.length > 0 ? atr(bars) : null;
  const atrDistancePct = a != null ? (ATR_MULT * a * 100) / price : null;
  // ETF 由一篮子成分平滑，整体跳空极少，硬套个股跳空分位只会白白吃掉仓位
  const gapBufferPct = assetType === 'etf' || !bars ? 0 : downGapP95(bars);

  const effectiveLossPct =
    Math.max(stopDistancePct, atrDistancePct ?? 0) + gapBufferPct + COST_BUFFER_PCT;
  const riskCapPct = (budget.singleTradeRiskPct / effectiveLossPct) * 100;
  const tierCapPct = assetType === 'etf' ? budget.singleMaxEtfPct : budget.singleMaxStockPct;
  const absoluteCapPct =
    fixedCapPct != null && fixedCapPct > 0 ? Math.min(tierCapPct, fixedCapPct) : tierCapPct;
  const allowedWeightPct = Math.min(riskCapPct, absoluteCapPct);

  // 向下取整到 100 股：A 股最小交易单位，给不出整手的建议等于给不出建议
  const allowedShares = Math.floor(((allowedWeightPct / 100) * totalEquity) / price / 100) * 100;
  const reduceShares = Math.max(0, Math.floor((currentShares - allowedShares) / 100) * 100);

  const r1 = (v: number): number => Math.round(v * 10) / 10;
  return {
    stopDistancePct: r1(stopDistancePct),
    atrDistancePct: atrDistancePct == null ? null : r1(atrDistancePct),
    gapBufferPct: r1(gapBufferPct),
    costBufferPct: COST_BUFFER_PCT,
    effectiveLossPct: r1(effectiveLossPct),
    riskCapPct: r1(riskCapPct),
    absoluteCapPct,
    allowedWeightPct: r1(allowedWeightPct),
    allowedShares,
    currentShares,
    reduceShares,
  };
}
