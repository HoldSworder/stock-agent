import type { MarketRegimeOverview, RotationBoardMarket } from '@stock-agent/shared';

// 大盘那一行：阶段说该拿几成，对上我实际拿了几成。
//
// 阶段研判本身（backend/src/regime）早就有了，但它只说「建议仓位 60-90%」，
// 没人把这句话和账户里实际的八成仓对上。而「我现在该加还是该减」这个答案，
// 恰恰只在这两个数字碰到一起时才出现——这也是每天打开系统第一个要看的东西。
//
// 一条底线：**读不到账户就说读不到，不能按空仓算。**
// 按空仓算会得出「还能加 80%」，而实际上可能已经满仓了。

/** 建议仓位区间的上下界，单位 % */
export interface PositionRange {
  low: number;
  high: number;
}

/**
 * 解析 `PHASE_META` 里那几种写法的建议仓位区间。
 *
 * 现有写法只有两类：`60-90%`（区间）与 `≤30%`（只有上限）。
 * 解析不了时返回 null 而不是猜一个——猜错会直接导致「该减仓」被说成「还能加」。
 */
export function parsePositionRange(text: string | null | undefined): PositionRange | null {
  if (!text) return null;
  const s = text.trim();
  const between = s.match(/^(\d+(?:\.\d+)?)\s*[-~至]\s*(\d+(?:\.\d+)?)\s*%?$/);
  if (between) {
    const low = Number(between[1]);
    const high = Number(between[2]);
    return low <= high ? { low, high } : { low: high, high: low };
  }
  const atMost = s.match(/^[≤<]=?\s*(\d+(?:\.\d+)?)\s*%?$/);
  if (atMost) return { low: 0, high: Number(atMost[1]) };
  const atLeast = s.match(/^[≥>]=?\s*(\d+(?:\.\d+)?)\s*%?$/);
  if (atLeast) return { low: Number(atLeast[1]), high: 100 };
  return null;
}

/**
 * 把「阶段建议」和「我实际几成」对成一句话。
 *
 * 拆成纯函数是为了让措辞能被自检钉住：这一句直接决定加仓还是减仓，
 * 说反了就是让人反着做。
 */
export function comparePosition(
  actualPct: number | null,
  range: PositionRange | null,
): { stance: RotationBoardMarket['stance']; gapNote: string } {
  if (actualPct == null) {
    return {
      stance: 'unknown',
      gapNote: '读不到账户，不知道你现在几成仓。这不代表空仓',
    };
  }
  const cur = Math.round(actualPct);
  if (!range) {
    return { stance: 'unknown', gapNote: `你现在 ${cur} 成不到的仓位算不出对照（建议区间没读懂）` };
  }
  if (actualPct > range.high) {
    return {
      stance: 'over',
      gapNote: `你现在 ${cur}%，比这个阶段建议的上限多了 ${Math.round(actualPct - range.high)} 个点，偏重了`,
    };
  }
  if (actualPct < range.low) {
    return {
      stance: 'under',
      gapNote: `你现在 ${cur}%，还能再加 ${Math.round(range.low - actualPct)} 到 ${Math.round(range.high - actualPct)} 个点`,
    };
  }
  const room = Math.round(range.high - actualPct);
  return {
    stance: 'inside',
    gapNote:
      room > 0
        ? `你现在 ${cur}%，在建议区间里，最多还能加 ${room} 个点`
        : `你现在 ${cur}%，正好在建议区间的上沿`,
  };
}

/**
 * 拼出大盘那一行。
 *
 * @param regime 收盘快照（纯读 DB，不触网、不调模型）。取不到为 null
 * @param actualPct 账户实际总仓位 %；读不到为 null
 */
export function buildMarketStance(
  regime: MarketRegimeOverview | null,
  actualPct: number | null,
): RotationBoardMarket {
  if (!regime) {
    return {
      tradeDate: null,
      phase: null,
      positionRange: null,
      tomorrowBias: null,
      suggestedFrequency: null,
      advice: '',
      actualPct,
      stance: 'unknown',
      gapNote: '',
      unavailableReason: '还没有大盘阶段的收盘结果，今天先不据此加减仓',
    };
  }
  const range = parsePositionRange(regime.positionRange);
  const { stance, gapNote } = comparePosition(actualPct, range);
  return {
    tradeDate: regime.tradeDate,
    phase: regime.phase,
    positionRange: regime.positionRange,
    tomorrowBias: regime.tomorrowBias,
    suggestedFrequency: regime.suggestedFrequency,
    advice: regime.advice,
    actualPct: actualPct == null ? null : Math.round(actualPct * 10) / 10,
    stance,
    gapNote,
    unavailableReason: null,
  };
}
