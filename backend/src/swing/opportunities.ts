import type {
  KlineBar,
  SwingGrade,
  SwingOpportunity,
  SwingOpportunityOrigin,
  SwingReading,
} from '@stock-agent/shared';
import { getKline } from '../datasource/scheduler';
import { computeSwingSizing } from './sizing';
import { heldLayerCount as etfWatchHeldLayers } from '../etfwatch/store';
import { usedBudgetPct } from './adviceStore';
import { TIME_STOP_TRADE_DAYS } from './advice';

// 机会清单：把一轮扫描的读数整理成「现在有哪几个可以买的，每个具体怎么操作」。
//
// 它与 rotationBoard 的 entries 的区别是**带数量**。
// 只给区间不给数量的建议，到了下单那一刻还是得自己拍脑袋——
// 而拍脑袋正是这套系统要替掉的东西。
//
// 三条规则，都是「弄错了会让人亏钱」那类：
//
//  1. **一只标的只出一条。** 日线和 60 分钟都有信号时合成一条，不显示成两个机会——
//     否则同一笔钱会被算两次，合计额度也就形同虚设。
//  2. **日线定动作，60 分钟只作提前提示。** 只有 60 分钟出信号的那些照样列出来
//     （两个周期并列都看），但**不给可执行数量**：60 分钟的结构还没被日线确认，
//     按它下单等于把提前量当成了确认。
//  3. **价格越过追高线就不给数量。** 区间解决的是「不用赌精确点位」，
//     追高线解决的是「这个信号什么时候就不作数了」。少了后者，
//     价格早跑上去了人还会照着那个区间追。

/** 机会清单最多列几条。多到看不过来等于没有机会 */
const MAX_OPPORTUNITIES = 12;

/** 底部信号：只有这两级算「可以考虑买」 */
function isBottomSignal(grade: SwingGrade): boolean {
  return grade === 'risk_easing_bottom' || grade === 'turn_confirmed_bottom';
}

export interface BuildOpportunitiesInput {
  /** 一轮扫描的全部读数（含日线与 60 分钟） */
  readings: SwingReading[];
  /** 已持有的代码，这些不进机会清单——它们在「手上这几只」那一段 */
  heldCodes: Set<string>;
  /** 账户总资产；取不到为 null，此时不给任何数量 */
  totalEquity: number | null;
}

/**
 * 挑出要列进清单的读数并合成，一只标的一条。
 *
 * 拆成纯函数是为了能用自检穷举各种周期组合——
 * 合成错了会让同一只标的出现两次，而这种错误靠跑真实数据碰不到。
 */
export function selectOpportunitySignals(
  readings: SwingReading[],
  heldCodes: Set<string>,
): Array<{ main: SwingReading; intraday: SwingReading | null; basis: 'day' | 'intraday_only' }> {
  const byCode = new Map<string, { day?: SwingReading; intraday?: SwingReading }>();
  for (const r of readings) {
    // 个股不进：这套打法是赛道 ETF 轮动，个股混进来会套上 ETF 的口径
    if (r.assetType !== 'etf') continue;
    // 已持有的不进：它们已经在「手上这几只」里，重复出现会让人以为是两件事
    if (heldCodes.has(r.code)) continue;
    // 数据不足判不了的不进：它不是机会，也不该被显示成「暂无信号」
    if (r.unavailableReason) continue;
    const slot = byCode.get(r.code) ?? {};
    if (r.period === 'day') slot.day = r;
    else if (r.period === '60m') slot.intraday = r;
    byCode.set(r.code, slot);
  }

  const out: Array<{
    main: SwingReading;
    intraday: SwingReading | null;
    basis: 'day' | 'intraday_only';
  }> = [];
  for (const { day, intraday } of byCode.values()) {
    const dayHit = day != null && isBottomSignal(day.grade);
    const intraHit = intraday != null && isBottomSignal(intraday.grade);
    if (dayHit && day) {
      // 日线有信号：它定动作；60 分钟若也有，作为佐证附上
      out.push({ main: day, intraday: intraHit ? intraday! : null, basis: 'day' });
    } else if (intraHit && intraday) {
      // 只有 60 分钟有：列出来但不给数量，标明日线还没确认
      out.push({ main: intraday, intraday: null, basis: 'intraday_only' });
    }
  }

  // 日线的排在前面（它们才是可执行的），各自按背驰强度降序
  const rank = (b: 'day' | 'intraday_only'): number => (b === 'day' ? 0 : 1);
  out.sort(
    (a, b) =>
      rank(a.basis) - rank(b.basis) ||
      (b.main.divergenceStrength ?? 0) - (a.main.divergenceStrength ?? 0),
  );
  return out;
}

/** 1R 目标价：赚到的钱等于当初打算亏的钱。按区间上沿这个最不利的入场价算 */
export function firstRTargetOf(entry: number, initialStop: number): number | null {
  if (!(entry > 0) || !(initialStop > 0) || initialStop >= entry) return null;
  return Math.round((entry + (entry - initialStop)) * 1000) / 1000;
}

/**
 * 拼出机会清单。
 *
 * 取数失败不整块失败：某一只算不出数量就只给它标原因，其余照常。
 */
export async function buildOpportunities(
  input: BuildOpportunitiesInput,
): Promise<{ items: SwingOpportunity[]; omitted: number }> {
  const { readings, heldCodes, totalEquity } = input;
  const picked = selectOpportunitySignals(readings, heldCodes);
  const shown = picked.slice(0, MAX_OPPORTUNITIES);
  const omitted = picked.length - shown.length;

  // 仓位要用 ATR 与跳空分位，跟 runner 建仓时同一套算法——
  // 两处算出不同的数字比不给数字更糟。走本地 K 线缓存，命中即秒回
  const barsByCode = new Map<string, KlineBar[]>();
  await Promise.all(
    shown.map(async ({ main }) => {
      try {
        const bars = await getKline(main.code, 'day', 120);
        if (bars.length > 0) barsByCode.set(main.code, bars);
      } catch {
        /* 取不到就不算 ATR，computeSwingSizing 仍能按结构止损距离给出上限 */
      }
    }),
  );

  const usedByOthersPct = usedBudgetPct();
  const items = shown.map(({ main, intraday, basis }) =>
    toOpportunity(main, intraday, basis, totalEquity, barsByCode.get(main.code) ?? [], usedByOthersPct),
  );
  return { items, omitted };
}

function toOpportunity(
  main: SwingReading,
  intraday: SwingReading | null,
  basis: 'day' | 'intraday_only',
  totalEquity: number | null,
  bars: KlineBar[],
  usedByOthersPct: number,
): SwingOpportunity {
  const origin: SwingOpportunityOrigin = main.isTrackProxy ? 'track' : 'watchlist';
  // 入场价按区间上沿算，也就是最不利的那个价：
  // 按下沿算会高估能买的量，真按上沿成交时仓位就超了
  const entry = main.zone?.high ?? main.close;
  const chaseBlocked = main.chaseGuard != null && main.close > main.chaseGuard;

  const base = {
    code: main.code,
    name: main.name,
    track: main.track,
    peerCount: main.peerCount,
    isTrackProxy: main.isTrackProxy,
    origin,
    basis,
    grade: main.grade,
    intradayHint: intraday ? { grade: intraday.grade, barTime: intraday.barTime } : null,
    close: main.close,
    zone: main.zone,
    chaseGuard: main.chaseGuard,
    chaseBlocked,
    initialStop: main.initialStop,
    firstRTarget: main.initialStop != null ? firstRTargetOf(entry, main.initialStop) : null,
    timeStopTradeDays: TIME_STOP_TRADE_DAYS,
    watchLevels: main.watchLevels,
    rationale: main.rationale,
    counterEvidence: main.counterEvidence,
    barTime: main.barTime,
  };

  // --- 不给数量的几种情形，每种都要说清是哪一种 ---
  if (basis === 'intraday_only') {
    return {
      ...base,
      sizing: null,
      sizingUnavailable: '这只只有 60 分钟线出了信号，日线还没确认，先看着不动手',
    };
  }
  if (chaseBlocked) {
    return {
      ...base,
      sizing: null,
      sizingUnavailable: `现价 ${main.close} 已经涨过不追线 ${main.chaseGuard}，这次机会过了，等下一次`,
    };
  }
  if (totalEquity == null) {
    return {
      ...base,
      sizing: null,
      sizingUnavailable: '读不到账户总资产，算不出该买多少。不要按空仓处理',
    };
  }
  if (main.initialStop == null) {
    return { ...base, sizing: null, sizingUnavailable: '这只算不出止损价，给不出数量' };
  }

  const sized = computeSwingSizing({
    assetType: 'etf',
    entryPrice: entry,
    initialStop: main.initialStop,
    totalEquity,
    bars,
    // 已持有的标的不进这个清单，所以这里恒为 0
    realPct: 0,
    // 盯盘已建层的标的不再另给一份仓位。此前这里硬填 0 并注明「盯盘定时已关，
    // 暂不会冲突」，但库里 etfwatch_enabled 是 true——那句假设早就过期了，
    // 于是两套系统可以同时对一只 ETF 各占一次仓。
    etfWatchHeldLayers: etfWatchHeldLayers(main.code),
    usedByOthersPct,
  });
  if (!sized) {
    const layers = etfWatchHeldLayers(main.code);
    if (layers > 0) {
      return {
        ...base,
        sizing: null,
        sizingUnavailable: `ETF 盯盘那边已经建了 ${layers} 层，仓位由盯盘统一管`,
      };
    }
    return { ...base, sizing: null, sizingUnavailable: '按现有止损距离算不出仓位' };
  }
  if (sized.allowedPct <= 0) {
    return { ...base, sizing: null, sizingUnavailable: sized.note };
  }

  const amount = Math.round((sized.allowedPct / 100) * totalEquity);
  // 向下取整到 100 份：场内基金最小交易单位，给不出整手的建议等于给不出建议
  const shares = Math.floor(amount / entry / 100) * 100;
  if (shares <= 0) {
    return {
      ...base,
      sizing: null,
      sizingUnavailable: `按 ${sized.allowedPct}% 算下来不够买 100 份（一手），这只先放着`,
    };
  }

  return {
    ...base,
    sizing: {
      allowedPct: sized.allowedPct,
      amount,
      shares,
      note: sized.note,
      binding: sized.binding,
    },
    sizingUnavailable: null,
  };
}

/** 导出给自检用：纯逻辑部分，不碰 DB、不取数 */
export const __testables = { isBottomSignal, MAX_OPPORTUNITIES };
