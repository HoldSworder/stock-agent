import type {
  BacktestCosts,
  KlineBar,
  PlaybookBacktestMetrics,
  PlaybookEquityPoint,
  PlaybookSpec,
  PlaybookTrade,
} from '@stock-agent/shared';
import { getKline, getQuotes } from '../market/eastmoney';
import { listPool } from '../etf/repo';
import { listUniverse } from '../modes/universeRepo';
import { listWatch } from '../watchlist';
import { resolveCosts } from '../backtest/costs';
import { buildSeries, evalGroup, describeRule, isBacktestableRule, type Series } from './rules';
import { PLAYBOOK_RULE_CAPABILITY } from '@stock-agent/shared';

// 战法回测引擎：逐 bar 严格按战法自身规则执行，不用预设近似。
//
// 为什么不复用 backend/src/backtest 的 tradelab 引擎：tradelab 在持仓期间不再调用信号函数，
// 离场只能走固定止损/盈亏比/ATR 跟踪，无法表达「收盘跌破 5 日线卖出」「MACD 死叉卖出」这类
// 战法自带卖点。此处自研逐 bar 循环，买卖两端都按战法规则严格判定。
//
// 口径（写入 notes 对用户透明）：
//   - 信号一律在收盘后确认，次一根 bar 开盘/收盘成交，无前视、天然满足 T+1；
//   - 每只标的独立一份资金、同时最多一笔持仓，组合权益按标的等权合成，
//     避免引入「资金如何在标的间分配」这一主观假设；
//   - 成本按 A 股真实结构分别计：佣金双边（含最低佣金）+ 过户费双边 + 印花税卖出单边 + 滑点双边。

export class PlaybookBacktestError extends Error {}

/** 单只标的最多取多少根 K 线 */
const MAX_BARS = 2000;
/** 标的池上限 */
const MAX_CODES = 30;
/** 取数并发路数：控制对上游的瞬时压力，与 klineCache 预热同口径 */
const FETCH_CONCURRENCY = 5;
/** 整轮取数时长预算（毫秒）：超时后用已取到的标的出结果，避免 HTTP handler 无上限地挂着 */
const FETCH_BUDGET_MS = 45_000;
/** 一年按 244 个交易日折算年化 */
const BARS_PER_YEAR_DAY = 244;
const BARS_PER_YEAR_WEEK = 50;

export interface PlaybookBacktestResult {
  range: string;
  poolSize: number;
  metrics: PlaybookBacktestMetrics;
  trades: PlaybookTrade[];
  equity: PlaybookEquityPoint[];
  notes: string[];
}

/** 解析标的池：codes 直接用，其余取站内已有列表 */
export function resolveUniverse(spec: PlaybookSpec): Array<{ code: string; name?: string }> {
  const kind = spec.universe?.kind ?? 'codes';
  if (kind === 'codes') {
    const codes = (spec.universe?.codes ?? []).map((c) => c.trim()).filter(Boolean);
    return [...new Set(codes)].map((code) => ({ code }));
  }
  if (kind === 'watchlist') return listWatch().map((w) => ({ code: w.code, name: w.name }));
  if (kind === 'etfPool') return listPool().map((p) => ({ code: p.code, name: p.name }));
  return listUniverse().map((u) => ({ code: u.code, name: u.name }));
}

/**
 * 补齐标的名称（就地修改）。名称仅供逐笔成交展示，取不到不影响回测口径，
 * 所以查名失败一律静默跳过。
 */
export function mergeNames(
  universe: Array<{ code: string; name?: string }>,
  nameByCode: Map<string, string>,
): void {
  for (const u of universe) {
    if (!u.name) u.name = nameByCode.get(u.code) || undefined;
  }
}

/** 校验 spec 可执行，不可执行直接抛错（宁可报错也不静默降级成近似回测） */
export function assertRunnableSpec(spec: PlaybookSpec | null | undefined): asserts spec is PlaybookSpec {
  if (!spec) throw new PlaybookBacktestError('该战法尚未配置回测规则');
  if (!spec.entry?.rules?.length) throw new PlaybookBacktestError('缺少买入规则');
  const hasExit =
    (spec.exit?.rules?.length ?? 0) > 0 ||
    spec.stopLossPct != null ||
    spec.takeProfitPct != null ||
    spec.maxHoldBars != null;
  if (!hasExit) throw new PlaybookBacktestError('缺少卖出规则（可用卖出条件 / 止损 / 止盈 / 持有上限）');
  if (spec.period !== 'day' && spec.period !== 'week') {
    throw new PlaybookBacktestError('回测仅支持日线 / 周线');
  }
  // R18：含实时专用或未注册规则的 spec 一律明确报错，不得静默判 false 后当成「条件未满足」，
  // 否则回测会给出一条看似正常但实际永不触发的曲线。
  const unrunnable = [...(spec.entry?.rules ?? []), ...(spec.exit?.rules ?? [])].filter(
    (r) => !isBacktestableRule(r),
  );
  if (unrunnable.length > 0) {
    const detail = unrunnable
      .map((r) => `${r.kind}（${PLAYBOOK_RULE_CAPABILITY[r.kind] ?? '未注册'}）`)
      .join('、');
    throw new PlaybookBacktestError(`以下规则不可回测，请改用可回测规则或移出回测 spec：${detail}`);
  }
}

/**
 * 单边成本率（bps → 小数）与固定项分离：
 * 买入 = 佣金 + 过户费 + 滑点；卖出 = 佣金 + 过户费 + 印花税 + 滑点。
 */
function sideCostRate(costs: BacktestCosts, side: 'buy' | 'sell'): number {
  const bps =
    costs.commissionBps +
    costs.transferFeeBps +
    costs.slippageBps +
    (side === 'sell' ? costs.stampDutyBps : 0);
  return bps / 10000;
}

/** 一笔往返交易的净收益率（%）：含双边费率与两次最低佣金对名义本金的摊薄 */
function netReturnPct(
  entryPrice: number,
  exitPrice: number,
  costs: BacktestCosts,
  notional: number,
): number {
  if (!(entryPrice > 0)) return 0;
  const buyRate = sideCostRate(costs, 'buy');
  const sellRate = sideCostRate(costs, 'sell');
  const gross = exitPrice / entryPrice;
  // 最低佣金：按名义本金折算成额外费率，双边各一次
  const minFeeRate =
    notional > 0
      ? Math.max(0, costs.minCommission - (notional * costs.commissionBps) / 10000) / notional
      : 0;
  const net = gross * (1 - sellRate - minFeeRate) - (buyRate + minFeeRate);
  return (net - 1) * 100;
}

/** 成交价：按成交口径取次一根 bar 的开盘 / 收盘 */
function fillPrice(bar: KlineBar, fill: PlaybookSpec['fill']): number {
  return fill === 'nextClose' ? bar.close : bar.open;
}

interface SymbolRun {
  code: string;
  trades: PlaybookTrade[];
  /** 日期 → 该标的当日权益（初始 1） */
  equityByDate: Map<string, number>;
  /** 出现过 entryPrice ≤ 0 的异常 bar（行情数据本身有问题），持仓期折算已按 1 计 */
  badEntryPrice: boolean;
}

/**
 * 在给定 K 线上按规则跑一只标的（供自检与单标的复算，不触网）。
 * costs 省略则用 A 股默认档。
 */
export function runOnBars(
  code: string,
  bars: KlineBar[],
  spec: PlaybookSpec,
  costs?: Partial<BacktestCosts>,
  name?: string,
): PlaybookTrade[] {
  const series = buildSeries(code, bars, [spec.entry, spec.exit].filter(Boolean));
  return runSymbol(series, name, spec, resolveCosts(costs), NOTIONAL).trades;
}

/** 跑单只标的：逐 bar 判定，收盘确认、次根成交 */
function runSymbol(
  s: Series,
  name: string | undefined,
  spec: PlaybookSpec,
  costs: BacktestCosts,
  notional: number,
): SymbolRun {
  const bars = s.bars;
  const trades: PlaybookTrade[] = [];
  const equityByDate = new Map<string, number>();
  let equity = 1;
  let badEntryPrice = false;

  let entryIndex = -1;
  let entryPrice = 0;
  /** 待执行动作：在下一根 bar 成交 */
  let pending: 'buy' | 'sell' | null = null;
  let pendingReason = '';

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // 1) 先执行上一根确认的信号（次根成交，无前视）
    if (pending === 'buy') {
      entryPrice = fillPrice(bar, spec.fill);
      entryIndex = i;
      pending = null;
    } else if (pending === 'sell' && entryIndex >= 0) {
      const exitPrice = fillPrice(bar, spec.fill);
      trades.push({
        code: s.code,
        name,
        entryDate: bars[entryIndex].time,
        entryPrice,
        exitDate: bar.time,
        exitPrice,
        returnPct: netReturnPct(entryPrice, exitPrice, costs, notional),
        holdBars: i - entryIndex,
        exitReason: pendingReason,
      });
      equity *= 1 + netReturnPct(entryPrice, exitPrice, costs, notional) / 100;
      entryIndex = -1;
      entryPrice = 0;
      pending = null;
      pendingReason = '';
    }

    // 2) 收盘确认下一步动作
    if (entryIndex >= 0) {
      const heldBars = i - entryIndex;
      const pnlPct = entryPrice > 0 ? ((bar.close - entryPrice) / entryPrice) * 100 : 0;
      // T+1：买入当根不确认卖出信号
      if (heldBars >= 1 && pending === null) {
        let reason = '';
        if (spec.stopLossPct != null && pnlPct <= -Math.abs(spec.stopLossPct)) reason = '止损';
        else if (spec.takeProfitPct != null && pnlPct >= Math.abs(spec.takeProfitPct)) reason = '止盈';
        else if (spec.maxHoldBars != null && heldBars >= spec.maxHoldBars) reason = '持有上限';
        else if (evalGroup(spec.exit, s, i, { entryPrice, heldBars })) reason = '卖出规则';
        if (reason) {
          pending = 'sell';
          pendingReason = reason;
        }
      }
    } else if (pending === null && evalGroup(spec.entry, s, i)) {
      pending = 'buy';
    }

    // entryPrice 必须非零：为 0 时折算得 Infinity，会污染整条权益曲线且 JSON 序列化变 null
    if (entryIndex >= 0 && !(entryPrice > 0)) badEntryPrice = true;
    const mtm = entryIndex >= 0 && entryPrice > 0 ? bar.close / entryPrice : 1;
    equityByDate.set(bar.time, equity * mtm);
  }

  // 数据结束仍持仓：按最后一根收盘平掉，避免把浮盈当已实现收益漏记
  if (entryIndex >= 0) {
    const last = bars[bars.length - 1];
    const ret = netReturnPct(entryPrice, last.close, costs, notional);
    trades.push({
      code: s.code,
      name,
      entryDate: bars[entryIndex].time,
      entryPrice,
      exitDate: last.time,
      exitPrice: last.close,
      returnPct: ret,
      holdBars: bars.length - 1 - entryIndex,
      exitReason: '数据结束平仓',
    });
  }

  return { code: s.code, trades, equityByDate, badEntryPrice };
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** 由等权组合权益曲线与逐笔成交汇总指标 */
function summarize(
  equity: PlaybookEquityPoint[],
  trades: PlaybookTrade[],
  barsPerYear: number,
): PlaybookBacktestMetrics {
  const last = equity.length ? equity[equity.length - 1].equity : 1;
  let peak = 1;
  let maxDD = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) maxDD = Math.min(maxDD, p.equity / peak - 1);
  }
  const years = equity.length / barsPerYear;
  const annualized = years > 0 && last > 0 ? Math.pow(last, 1 / years) - 1 : null;

  const wins = trades.filter((t) => t.returnPct > 0);
  const losses = trades.filter((t) => t.returnPct <= 0);
  const grossWin = wins.reduce((s, t) => s + t.returnPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.returnPct, 0));

  let consecutive = 0;
  let maxConsecutive = 0;
  for (const t of trades) {
    consecutive = t.returnPct <= 0 ? consecutive + 1 : 0;
    maxConsecutive = Math.max(maxConsecutive, consecutive);
  }

  return {
    returnPct: r2((last - 1) * 100),
    annualizedPct: annualized == null ? undefined : r2(annualized * 100),
    maxDrawdownPct: r2(maxDD * 100),
    trades: trades.length,
    winRatePct: trades.length ? r2((wins.length / trades.length) * 100) : 0,
    // 无亏损笔时盈亏比无定义，留空由前端显示「—」，不用 Infinity（JSON 会变 null）
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : undefined,
    avgReturnPct: trades.length
      ? r2(trades.reduce((s, t) => s + t.returnPct, 0) / trades.length)
      : 0,
    avgHoldBars: trades.length
      ? r2(trades.reduce((s, t) => s + t.holdBars, 0) / trades.length)
      : 0,
    maxConsecutiveLosses: maxConsecutive,
  };
}

/** 组合权益：各标的等权，缺该日数据的标的按上一可得值延续（不做插值） */
function combineEquity(runs: SymbolRun[]): PlaybookEquityPoint[] {
  const dates = [...new Set(runs.flatMap((r) => [...r.equityByDate.keys()]))].sort();
  const lastSeen = runs.map(() => 1);
  return dates.map((date) => {
    let sum = 0;
    runs.forEach((r, k) => {
      const v = r.equityByDate.get(date);
      if (v != null) lastSeen[k] = v;
      sum += lastSeen[k];
    });
    return { date, equity: Math.round((sum / Math.max(runs.length, 1)) * 10000) / 10000 };
  });
}

/** 单笔名义本金：仅用于把最低佣金折算成费率，不改变等权口径 */
const NOTIONAL = 100000;

/** 按战法规则跑一次回测（纯只读取数，不下单、不调 LLM） */
export async function runPlaybookBacktest(spec: PlaybookSpec): Promise<PlaybookBacktestResult> {
  assertRunnableSpec(spec);
  const universe = resolveUniverse(spec);
  if (!universe.length) throw new PlaybookBacktestError('标的池为空，请先选定回测标的');
  if (universe.length > MAX_CODES) {
    throw new PlaybookBacktestError(`标的池最多 ${MAX_CODES} 只，当前 ${universe.length} 只`);
  }

  // kind: 'codes' 的标的池只有代码，批量查一次名称（≤30 只，一次请求）
  const missing = universe.filter((u) => !u.name).map((u) => u.code);
  if (missing.length) {
    try {
      mergeNames(universe, new Map((await getQuotes(missing)).map((q) => [q.code, q.name])));
    } catch {
      // 查名失败不阻塞回测
    }
  }

  const costs = resolveCosts(spec.costs);
  const barLimit = Math.max(60, Math.min(MAX_BARS, spec.barLimit || 500));
  const groups = [spec.entry, spec.exit].filter(Boolean);

  const runs: SymbolRun[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  let firstDate = '';
  let lastDate = '';

  // 分批并发取数 + 整轮时长预算：串行 30 次外部请求会把单个 HTTP handler 阻塞到无法预估的时长；
  // 预算耗尽后不再发起新请求，用已取到的标的出结果，并在 notes 里说明少了哪些。
  const deadline = Date.now() + FETCH_BUDGET_MS;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, universe.length) }, async () => {
      while (cursor < universe.length) {
        const u = universe[cursor];
        cursor += 1;
        if (Date.now() > deadline) {
          skipped.push(u.code);
          continue;
        }
        let bars: KlineBar[];
        try {
          bars = await getKline(u.code, spec.period, barLimit);
        } catch {
          failed.push(u.code);
          continue;
        }
        if (bars.length < 30) {
          failed.push(u.code);
          continue;
        }
        runs.push(runSymbol(buildSeries(u.code, bars, groups), u.name, spec, costs, NOTIONAL));
        if (!firstDate || bars[0].time < firstDate) firstDate = bars[0].time;
        if (!lastDate || bars[bars.length - 1].time > lastDate) lastDate = bars[bars.length - 1].time;
      }
    }),
  );
  // 并发完成顺序不定，按标的池顺序还原，保证同一 spec 的结果可重现
  const order = new Map(universe.map((u, i) => [u.code, i]));
  runs.sort((a, b) => (order.get(a.code) ?? 0) - (order.get(b.code) ?? 0));

  if (!runs.length) throw new PlaybookBacktestError('标的行情全部取数失败，无法回测');

  const trades = runs
    .flatMap((r) => r.trades)
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const equity = combineEquity(runs);
  const barsPerYear = spec.period === 'week' ? BARS_PER_YEAR_WEEK : BARS_PER_YEAR_DAY;

  const notes: string[] = [
    `买入条件（${spec.entry.mode === 'all' ? '全部满足' : '任一满足'}）：${spec.entry.rules.map(describeRule).join('；')}`,
    // exit 可缺省（assertRunnableSpec 明确放行「只配止损」的 spec），必须判空
    spec.exit?.rules?.length
      ? `卖出条件（${spec.exit.mode === 'all' ? '全部满足' : '任一满足'}）：${spec.exit.rules.map(describeRule).join('；')}`
      : '未配置卖出条件，仅按止损/止盈/持有上限离场',
    `离场兜底：止损 ${spec.stopLossPct ?? '—'}% / 止盈 ${spec.takeProfitPct ?? '—'}% / 持有上限 ${spec.maxHoldBars ?? '—'} 根`,
    `成交口径：信号收盘确认，次一根 bar ${spec.fill === 'nextClose' ? '收盘' : '开盘'}成交，买入当根不卖（T+1）`,
    `成本：佣金双边 ${costs.commissionBps}bps（最低 ${costs.minCommission} 元，按 ${NOTIONAL} 元名义本金折算费率）` +
      ` + 过户费双边 ${costs.transferFeeBps}bps + 印花税卖出 ${costs.stampDutyBps}bps + 滑点双边 ${costs.slippageBps}bps`,
    '组合口径：每只标的独立一份资金、同时最多一笔持仓，权益按标的等权合成',
    '权益曲线含持仓期浮动盈亏（按收盘市值计，浮盈尚未扣卖出侧成本）；逐笔收益为已实现、已扣双边成本',
  ];
  if (failed.length) notes.push(`以下标的取数失败或样本不足，已跳过：${failed.join('、')}`);
  if (skipped.length) {
    notes.push(
      `取数超出整轮 ${FETCH_BUDGET_MS / 1000} 秒预算，以下标的未纳入本次回测（结果为部分标的口径）：${skipped.join('、')}`,
    );
  }
  const bad = runs.filter((r) => r.badEntryPrice).map((r) => r.code);
  if (bad.length) {
    notes.push(`以下标的存在买入价为 0 的异常行情，持仓期浮动盈亏按不变处理：${bad.join('、')}`);
  }

  return {
    range: firstDate && lastDate ? `${firstDate} ~ ${lastDate}` : '',
    poolSize: runs.length,
    metrics: summarize(equity, trades, barsPerYear),
    trades,
    equity,
    notes,
  };
}
