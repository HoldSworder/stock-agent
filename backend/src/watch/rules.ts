import type {
  SectorMoneyItem,
  StockRankItem,
  WatchConfig,
  WatchSignal,
  WatchSignalType,
} from '@stock-agent/shared';
import { nowIso } from '../util';
import type { QuoteCtx } from './types';
import { volScale } from './volatility';

// 纯函数触发规则：输入快照 + 滚动状态，输出分类信号列表，零副作用。

function mk(
  ctx: QuoteCtx,
  type: WatchSignalType,
  severity: WatchSignal['severity'],
  detail: string,
  score: number,
): WatchSignal {
  return {
    code: ctx.code,
    name: ctx.name,
    source: ctx.source,
    type,
    severity,
    price: ctx.price,
    pct: ctx.pct,
    detail,
    score,
    turnoverRate: ctx.turnoverRate,
    volumeRatio: ctx.volumeRatio,
    strategyId: ctx.strategyId,
    strategyName: ctx.strategyName,
    at: nowIso(),
  };
}

const pctDelta = (a: number, b: number): number => (b > 0 ? ((a - b) / b) * 100 : 0);

/** 持仓卖点信号 */
function evalPositionSignals(ctx: QuoteCtx, cfg: WatchConfig): WatchSignal[] {
  const out: WatchSignal[] = [];
  const { price, dayHigh, prevPrice, avgCost, limitUp, profile } = ctx;

  // 中线档：过滤日内噪声（回撤/急跌/炸板/跌破成本/止盈都不在日内触发），
  // 只保留「硬止损」作安全垫；趋势破坏由低频 weekly_break 扫描负责（engine 调用）。
  if (ctx.horizon === 'mid') {
    if (profile && avgCost && avgCost > 0) {
      const stopLine = avgCost * (1 - profile.stopLossPct / 100);
      if (price <= stopLine && prevPrice != null && prevPrice > stopLine) {
        out.push(
          mk(
            ctx,
            'strategy_stop',
            'high',
            `跌破中线硬止损 ${stopLine.toFixed(2)}（成本 ${avgCost.toFixed(2)} 下方 ${profile.stopLossPct}%，现价 ${price.toFixed(2)}）`,
            75,
          ),
        );
      }
    }
    return out;
  }

  // 战法止盈：浮盈达档案 takeProfitPct（每轮均可提示，由 cooldown 控频）
  if (profile && avgCost && avgCost > 0) {
    const gain = ((price - avgCost) / avgCost) * 100;
    if (gain >= profile.takeProfitPct) {
      out.push(
        mk(
          ctx,
          'take_profit',
          'high',
          `达战法止盈线：浮盈 +${gain.toFixed(2)}%（成本 ${avgCost.toFixed(2)} → 现价 ${price.toFixed(2)}，止盈线 +${profile.takeProfitPct}%）`,
          80 + gain,
        ),
      );
    }
  }

  // 从今日高点回撤（有战法档案时用更敏感的 intradayDrawdownPct，保留战法纪律不做波动率缩放；
  // 通用真实持仓阈值按个股 ATR% 波动率归一化——高波动票放大、低波动票收紧）
  if (dayHigh > 0) {
    const dd = ((dayHigh - price) / dayHigh) * 100;
    const threshold = profile ? profile.intradayDrawdownPct : cfg.drawdownPct * volScale(ctx.atrPct);
    if (dd >= threshold) {
      out.push(
        mk(
          ctx,
          'drawdown_from_high',
          dd >= threshold * 1.8 ? 'high' : 'medium',
          `从今日高点 ${dayHigh.toFixed(2)} 回撤 ${dd.toFixed(1)}% 至 ${price.toFixed(2)}`,
          dd,
        ),
      );
    }
  }

  // 战法止损：跌破成本达档案 stopLossPct，且本轮刚跌破（避免持续刷屏）
  if (profile && avgCost && avgCost > 0) {
    const stopLine = avgCost * (1 - profile.stopLossPct / 100);
    if (price <= stopLine && prevPrice != null && prevPrice > stopLine) {
      out.push(
        mk(
          ctx,
          'strategy_stop',
          'high',
          `跌破战法止损线 ${stopLine.toFixed(2)}（成本 ${avgCost.toFixed(2)} 下方 ${profile.stopLossPct}%，现价 ${price.toFixed(2)}）`,
          75,
        ),
      );
    }
  }

  // 跌破成本（仅刚跌破的一刻触发，避免持续刷屏）
  if (avgCost && avgCost > 0 && price < avgCost && prevPrice != null && prevPrice >= avgCost) {
    out.push(
      mk(ctx, 'break_cost', 'medium', `跌破成本价 ${avgCost.toFixed(2)}（现价 ${price.toFixed(2)}）`, 50),
    );
  }

  // 单轮急跌（阈值按 ATR% 波动率归一化）
  if (prevPrice != null) {
    const d = pctDelta(price, prevPrice);
    if (d <= -cfg.surgeDropPct * volScale(ctx.atrPct)) {
      out.push(
        mk(ctx, 'surge_drop', 'high', `单轮急跌 ${d.toFixed(2)}%（${prevPrice.toFixed(2)}→${price.toFixed(2)}）`, 60 + Math.abs(d)),
      );
    }
  }

  // 涨停打开 / 炸板：上一轮封板（≈涨停价）本轮已打开
  if (limitUp && limitUp > 0 && prevPrice != null && prevPrice >= limitUp * 0.999 && price < limitUp * 0.997) {
    out.push(mk(ctx, 'limit_open', 'high', `涨停打开（炸板），现价 ${price.toFixed(2)}`, 80));
  }

  return out;
}

/** 自选买点信号 */
function evalWatchSignals(ctx: QuoteCtx, cfg: WatchConfig): WatchSignal[] {
  const out: WatchSignal[] = [];
  const { price, pct, prevPrice, dayHigh, limitUp } = ctx;

  // 临近涨停
  if (limitUp && limitUp > 0 && price > 0 && price < limitUp) {
    const gap = ((limitUp - price) / limitUp) * 100;
    if (gap <= cfg.nearLimitPct) {
      out.push(mk(ctx, 'near_limit_up', 'high', `距涨停仅 ${gap.toFixed(2)}%（涨停 ${limitUp.toFixed(2)}）`, 70 - gap));
    }
  }

  // 量价配合：techContext 开启且量比偏高时上调权重（量价齐升更可信）
  const vr = ctx.volumeRatio;
  const heavyVol = cfg.techContext && vr != null && vr >= 1.5;
  const volTag = cfg.techContext && vr != null ? `，量比 ${vr.toFixed(2)}` : '';

  // 单轮涨速异动（阈值按 ATR% 波动率归一化）
  if (prevPrice != null) {
    const d = pctDelta(price, prevPrice);
    if (d >= cfg.fastRisePct * volScale(ctx.atrPct)) {
      out.push(
        mk(
          ctx,
          'fast_rise',
          heavyVol ? 'high' : 'medium',
          `单轮拉升 ${d.toFixed(2)}%（${prevPrice.toFixed(2)}→${price.toFixed(2)}）${volTag}`,
          40 + d + (heavyVol ? 15 : 0),
        ),
      );
    }
  }

  // 创日内新高（伴随当日涨幅）
  if (prevPrice != null && price >= dayHigh && price > prevPrice && pct >= 3) {
    out.push(
      mk(
        ctx,
        'breakout',
        heavyVol ? 'medium' : 'low',
        `创日内新高 ${price.toFixed(2)}（当日 +${pct.toFixed(2)}%）${volTag}`,
        20 + pct + (heavyVol ? 15 : 0),
      ),
    );
  }

  return out;
}

/**
 * 今日计划结构化触发：按 buyTrigger/sellTrigger/stopLoss/takeProfit 的 value 做廉价数值比较。
 * - 候选标的（source=watch，方向 buy/watch）：命中买点；
 * - 持仓标的（source=position）：命中止损/止盈/卖点。
 * 不依赖战法档案，纯计划价位对照；命中后交 dispatcher 唤醒 AI 研判（不下单）。
 */
function evalPlanSignals(ctx: QuoteCtx): WatchSignal[] {
  const item = ctx.planItem;
  if (!item) return [];
  if (item.status === 'done' || item.status === 'invalid') return [];
  const p = ctx.price;
  if (p <= 0) return [];
  const out: WatchSignal[] = [];

  // 命中判定：breakout=上破(>=)，price/pullback=下破(<=)
  const cross = (t: NonNullable<typeof item.buyTrigger>): boolean =>
    t.type === 'breakout' ? p >= t.value : p <= t.value;

  if (ctx.source === 'watch' && (item.direction === 'buy' || item.direction === 'watch')) {
    const bt = item.buyTrigger;
    if (bt && bt.value > 0 && cross(bt)) {
      out.push(
        mk(
          ctx,
          'plan_buy',
          'high',
          `命中今日计划买点（${bt.type === 'breakout' ? '突破' : '回落至'} ${bt.value}）现价 ${p.toFixed(2)}${item.thesis ? `｜${item.thesis}` : ''}`,
          78,
        ),
      );
    }
  }

  if (ctx.source === 'position') {
    const sl = item.stopLoss;
    const tp = item.takeProfit;
    const st = item.sellTrigger;
    if (sl && sl.value > 0 && p <= sl.value) {
      out.push(mk(ctx, 'plan_stop', 'high', `跌破今日计划止损 ${sl.value}，现价 ${p.toFixed(2)}`, 76));
    } else if (tp && tp.value > 0 && p >= tp.value) {
      out.push(mk(ctx, 'plan_take_profit', 'high', `达今日计划止盈 ${tp.value}，现价 ${p.toFixed(2)}`, 74));
    } else if (st && st.value > 0 && cross(st)) {
      out.push(mk(ctx, 'plan_stop', 'medium', `命中今日计划卖点（${st.value}）现价 ${p.toFixed(2)}`, 60));
    }
  }

  return out;
}

/** 单标的规则评估入口 */
export function evalQuoteSignals(ctx: QuoteCtx, cfg: WatchConfig): WatchSignal[] {
  const base =
    ctx.source === 'position'
      ? evalPositionSignals(ctx, cfg)
      : ctx.source === 'watch'
        ? evalWatchSignals(ctx, cfg)
        : [];
  return [...base, ...evalPlanSignals(ctx)];
}

/**
 * 中线趋势破坏信号（engine 低频周线扫描后调用；按日去重）。
 * reason 区分：'ma' 跌破周线均线 / 'trail' 周线高点回撤超阈值。
 */
export function buildWeeklyBreak(
  ctx: QuoteCtx,
  detail: string,
  reason: 'ma' | 'trail',
): WatchSignal {
  return mk(ctx, 'weekly_break', reason === 'ma' ? 'high' : 'medium', detail, reason === 'ma' ? 78 : 64);
}

/** 尾盘了结信号（engine 在到点且按日去重后调用） */
export function buildEodSettle(ctx: QuoteCtx): WatchSignal {
  const gainTag =
    ctx.avgCost && ctx.avgCost > 0
      ? `，当前浮盈 ${(((ctx.price - ctx.avgCost) / ctx.avgCost) * 100).toFixed(2)}%`
      : '';
  return mk(
    ctx,
    'eod_settle',
    'high',
    `尾盘了结提示：${ctx.strategyName ?? '战法'}持仓不过夜，请评估是否兑现（现价 ${ctx.price.toFixed(2)}${gainTag}）`,
    70,
  );
}

/**
 * 全市场扫描信号（部分需 engine 提供「是否新出现」的有状态判断）。
 * @param newLimitUps 本轮新晋涨停（engine 用 seen 集合算差集后传入）
 * @param sectors 板块主力净流入榜
 */
export function evalScanSignals(
  newLimitUps: StockRankItem[],
  sectors: SectorMoneyItem[],
  cfg: WatchConfig,
): WatchSignal[] {
  const at = nowIso();
  const out: WatchSignal[] = [];

  for (const s of newLimitUps) {
    out.push({
      code: s.code,
      name: s.name,
      source: 'scan',
      type: 'new_limit_up',
      severity: 'medium',
      price: s.price,
      pct: s.pct,
      detail: `新晋涨停 ${s.name}（${s.code}）现价 ${s.price.toFixed(2)} +${s.pct.toFixed(2)}%`,
      score: 45,
      at,
    });
  }

  for (const sec of sectors) {
    if (sec.netInflow >= cfg.sectorInflowYi) {
      out.push({
        code: sec.code,
        name: sec.name,
        source: 'scan',
        type: 'sector_inflow',
        severity: 'low',
        price: 0,
        pct: sec.pct,
        detail: `板块【${sec.name}】主力净流入 ${sec.netInflow.toFixed(2)} 亿，板块涨 ${sec.pct.toFixed(2)}%`,
        score: 30 + sec.netInflow,
        at,
      });
    }
  }

  return out;
}

/** 按板块近似推算涨停价（主板 10% / 创业板 300·301 为 20%；688/8·4 北交所不参与） */
export function approxLimitUp(code: string, prevClose: number): number | undefined {
  if (prevClose <= 0) return undefined;
  let ratio = 0.1;
  if (/^(300|301)/.test(code)) ratio = 0.2;
  return Math.round(prevClose * (1 + ratio) * 100) / 100;
}
