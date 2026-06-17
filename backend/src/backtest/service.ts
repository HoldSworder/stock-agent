import { desc, eq } from 'drizzle-orm';
import type {
  BacktestEquityPoint,
  BacktestMetricsLite,
  BacktestRun,
  BacktestRunInput,
  BacktestRunListItem,
  BacktestScope,
  BacktestSystemMetrics,
  BacktestTradeLite,
  KlinePeriod,
} from '@stock-agent/shared';
import type { BacktestMetrics, BacktestResult, BacktestTrade } from 'tradelab';
import { db, schema } from '../db/client';
import { newId, nowIso } from '../util';
import { loadCandles, msToDate, assertSupportedPeriod } from './candles';
import { resolveCosts, toTradelabCosts, costNote } from './costs';
import { buildSignal, resolveParams } from './signals';
import { runSignalBacktest, runPortfolioBacktest, type PortfolioSystemArgs } from './engine';

export class BacktestError extends Error {}

const MAX_PORTFOLIO_SYSTEMS = 20;
const DEFAULT_LIMIT = 500;
const DEFAULT_EQUITY = 100000;
const DEFAULT_RISK_PCT = 1;

function assertCode(code: string): void {
  if (!/^\d{6}$/.test(code)) throw new BacktestError(`非法标的代码：${code}`);
}

/** winRate 引擎口径可能为 0-1 或 0-100，统一归一到 0-1 */
function normWinRate(v: number): number {
  return v > 1 ? v / 100 : v;
}

function toMetricsLite(m: BacktestMetrics): BacktestMetricsLite {
  // tradelab 的 returnPct / maxDrawdown 为小数口径（0.0192=1.92%），统一 ×100 转百分数；
  // winRate 已是 0-1 小数；sharpe 在样本不足时可能为 null，按 0 兜底以满足 number 契约。
  return {
    trades: m.trades,
    winRate: normWinRate(m.winRate),
    profitFactor: Number.isFinite(m.profitFactor) ? m.profitFactor : 0,
    maxDrawdown: Math.abs(m.maxDrawdown) * 100,
    sharpe: Number.isFinite(m.sharpe) ? m.sharpe : 0,
    returnPct: m.returnPct * 100,
    finalEquity: m.finalEquity,
    startEquity: m.startEquity,
  };
}

function toEquity(result: BacktestResult): BacktestEquityPoint[] {
  return result.eqSeries.map((p) => ({ time: msToDate(p.time), equity: p.equity }));
}

function toTrades(positions: BacktestTrade[], fallbackSymbol: string): BacktestTradeLite[] {
  return positions.map((t) => ({
    symbol: t.symbol ?? fallbackSymbol,
    side: t.side,
    entry: t.entryFill ?? t.entry,
    exit: t.exit.price,
    entryTime: msToDate(t.openTime),
    exitTime: msToDate(t.exit.time),
    pnl: t.exit.pnl,
    reason: t.exit.reason,
  }));
}

function rangeOf(dates: string[]): string {
  if (dates.length === 0) return '';
  return `${dates[0]} ~ ${dates[dates.length - 1]}（${dates.length} 根）`;
}

interface PreparedRun {
  scope: BacktestScope;
  codes: string[];
  period: KlinePeriod;
  range: string;
  result: BacktestResult;
  systemsMetrics: BacktestSystemMetrics[];
}

/** 执行回测（不落库），返回引擎结果与映射元信息 */
async function execute(input: BacktestRunInput): Promise<{
  prepared: PreparedRun;
  notes: string[];
  costsResolved: ReturnType<typeof resolveCosts>;
  paramsResolved: ReturnType<typeof resolveParams>;
}> {
  const period: KlinePeriod = input.period ?? 'day';
  assertSupportedPeriod(period);
  const limit = Math.max(60, Math.min(2000, input.limit ?? DEFAULT_LIMIT));
  const equity = input.equity ?? DEFAULT_EQUITY;
  const riskPct = input.riskPct ?? DEFAULT_RISK_PCT;
  const costs = resolveCosts(input.costs);
  const tlCosts = toTradelabCosts(costs);
  const params = resolveParams(input.preset, input.params);

  const scope: BacktestScope = input.scope === 'portfolio' ? 'portfolio' : 'signal';

  const notes: string[] = [
    '回测限日/周线，建仓按信号次一根 bar 成交，天然近似 A 股 T+1',
    '涨停板当根不建仓（按代码涨跌停幅度近似识别，K 线无涨跌停标志）',
    costNote(costs),
  ];
  if (params.atrTrailMult > 0) notes.push(`ATR 跟踪止盈已启用（倍数 ${params.atrTrailMult}）`);

  if (scope === 'signal') {
    const code = (input.code ?? '').trim();
    assertCode(code);
    const { candles, dates } = await loadCandles(code, period, limit);
    const signal = buildSignal(input.preset, code, params);
    const result = runSignalBacktest({
      candles,
      symbol: code,
      signal,
      equity,
      riskPct,
      costs: tlCosts,
      atrTrailMult: params.atrTrailMult,
    });
    return {
      prepared: { scope, codes: [code], period, range: rangeOf(dates), result, systemsMetrics: [] },
      notes,
      costsResolved: costs,
      paramsResolved: params,
    };
  }

  // portfolio
  const sysInputs: { code: string; weight?: number }[] =
    input.systems && input.systems.length > 0
      ? input.systems
      : (input.codes ?? []).map((code) => ({ code }));
  if (sysInputs.length === 0) throw new BacktestError('组合回测需至少 1 个标的');
  if (sysInputs.length > MAX_PORTFOLIO_SYSTEMS) {
    throw new BacktestError(`组合标的数超限（${sysInputs.length} > ${MAX_PORTFOLIO_SYSTEMS}）`);
  }

  const systems: PortfolioSystemArgs[] = [];
  let longest: string[] = [];
  for (const s of sysInputs) {
    const code = s.code.trim();
    assertCode(code);
    const { candles, dates } = await loadCandles(code, period, limit);
    if (dates.length > longest.length) longest = dates;
    systems.push({
      symbol: code,
      candles,
      signal: buildSignal(input.preset, code, params),
      weight: s.weight,
      riskPct,
      costs: tlCosts,
      atrTrailMult: params.atrTrailMult,
    });
  }
  const result = runPortfolioBacktest(equity, systems);
  const systemsMetrics: BacktestSystemMetrics[] = result.systems.map((sys) => ({
    code: sys.symbol,
    weight: sys.weight,
    metrics: toMetricsLite(sys.result.metrics),
  }));
  return {
    prepared: {
      scope,
      codes: systems.map((s) => s.symbol),
      period,
      range: rangeOf(longest),
      result,
      systemsMetrics,
    },
    notes,
    costsResolved: costs,
    paramsResolved: params,
  };
}

/** 跑一次回测并落库，返回完整结果 */
export async function runBacktest(input: BacktestRunInput): Promise<BacktestRun> {
  const { prepared, notes, costsResolved, paramsResolved } = await execute(input);
  const { scope, codes, period, range, result, systemsMetrics } = prepared;

  const metrics = toMetricsLite(result.metrics);
  const equity = toEquity(result);
  const trades = toTrades(result.positions, codes[0] ?? '');
  const label =
    input.label?.trim() ||
    `${input.preset}·${scope === 'portfolio' ? `组合${codes.length}标的` : codes[0]}`;

  const id = newId();
  const createdAt = nowIso();
  const run: BacktestRun = {
    id,
    scope,
    label,
    codes,
    preset: input.preset,
    params: paramsResolved,
    period,
    range,
    costs: costsResolved,
    metrics,
    systems: systemsMetrics,
    equity,
    trades,
    notes,
    createdAt,
  };

  db.insert(schema.backtestRuns)
    .values({
      id,
      scope,
      label,
      codes: JSON.stringify(codes),
      preset: input.preset,
      params: JSON.stringify(paramsResolved),
      period,
      range,
      costs: JSON.stringify(costsResolved),
      metrics: JSON.stringify(metrics),
      systems: JSON.stringify(systemsMetrics),
      equity: JSON.stringify(equity),
      trades: JSON.stringify(trades),
      notes: JSON.stringify(notes),
      createdAt,
    })
    .run();

  return run;
}

type RunRow = typeof schema.backtestRuns.$inferSelect;

function parse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function rowToRun(row: RunRow): BacktestRun {
  return {
    id: row.id,
    scope: row.scope as BacktestScope,
    label: row.label,
    codes: parse<string[]>(row.codes, []),
    preset: row.preset as BacktestRun['preset'],
    params: parse(row.params, {}),
    period: row.period as KlinePeriod,
    range: row.range,
    costs: parse(row.costs, {} as BacktestRun['costs']),
    metrics: parse(row.metrics, {} as BacktestMetricsLite),
    systems: parse<BacktestSystemMetrics[]>(row.systems, []),
    equity: parse<BacktestEquityPoint[]>(row.equity, []),
    trades: parse<BacktestTradeLite[]>(row.trades, []),
    notes: parse<string[]>(row.notes, []),
    createdAt: row.createdAt,
  };
}

/** 历史回测列表（不含曲线/流水，省带宽） */
export function listBacktestRuns(limit = 50): BacktestRunListItem[] {
  const rows = db
    .select()
    .from(schema.backtestRuns)
    .orderBy(desc(schema.backtestRuns.createdAt))
    .limit(limit)
    .all();
  return rows.map((row) => ({
    id: row.id,
    scope: row.scope as BacktestScope,
    label: row.label,
    codes: parse<string[]>(row.codes, []),
    preset: row.preset as BacktestRunListItem['preset'],
    period: row.period as KlinePeriod,
    range: row.range,
    metrics: parse(row.metrics, {} as BacktestMetricsLite),
    createdAt: row.createdAt,
  }));
}

/** 取单次回测完整结果 */
export function getBacktestRun(id: string): BacktestRun | undefined {
  const row = db.select().from(schema.backtestRuns).where(eq(schema.backtestRuns.id, id)).get();
  return row ? rowToRun(row) : undefined;
}
