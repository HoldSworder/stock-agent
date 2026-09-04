import { and, desc, eq, gte, lt } from 'drizzle-orm';
import type {
  DisciplineAccountCheck,
  DisciplineConfig,
  DisciplineEvent,
  DisciplineFlag,
  DisciplineOverride,
  DisciplineOverrideInput,
  DisciplinePositionItem,
  DisciplineReport,
  DisciplineStatus,
  EtfSignal,
  KlineBar,
  MarketRegimePhase,
  PositionSizing,
  RealPortfolio,
  RiskBudgetTier,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { getMeta, setMeta } from '../settings';
import { fetchRealPositions } from '../realPositions';
import { shanghaiDateStr } from '../market/calendar';
import { newId, nowIso } from '../util';
import { budgetForPhase, computeSizing } from './riskBudget';
import { getRegimeSummaryForCockpit as regimeSummary } from '../regime/service';
import { getKline } from '../datasource/scheduler';

// 真实持仓纪律层：纯确定性体检（不调用 LLM、不下单）。真实账户无法自动交易，
// 此层只把「该止损 / 该止盈 / 超期 / 超配 / 总仓过重」这些规则在代码层算清楚，
// 直白呈现给用户在同花顺手动执行，并落事件流供历史与智能推送（按日去重防刷屏）。

const CONFIG_META_KEY = 'position_discipline_config';
const ACCOUNT = 'real';

/** 账户级默认纪律（面向中线，可在纪律配置里调；偏宽松，避免频繁触发） */
const DEFAULT_CONFIG: DisciplineConfig = {
  stopLossPct: 8,
  takeProfitPct: 25,
  maxHoldDays: null,
  singleMaxWeightPct: 30,
  totalMaxPositionPct: 90,
};

/**
 * ETF 走更宽松的趋势级默认纪律：ETF 跟随赛道趋势波动更大、可承受更深回撤与更高集中度，
 * 用偏紧的个股止损会频繁误触发。优先引用 ETF 信号的结构化触发价，取不到才回退此默认。
 */
const ETF_DEFAULT_CONFIG: DisciplineConfig = {
  stopLossPct: 12,
  takeProfitPct: 40,
  maxHoldDays: null,
  singleMaxWeightPct: 40,
  totalMaxPositionPct: 95,
};

/**
 * 判定是否 ETF/LOF 场内基金：深市 15xxxx 与沪市 5xxxxx，名称匹配作补充。
 * 旧写法 `5\d{4}` 只有 5 位，512880/588000/563000 这类沪市 ETF 匹配不到，
 * 名称里又不一定带「ETF/LOF」，于是被当个股套用 8% 止损（应为 12%）、单票上限从 40% 收到 30%。
 * 但 1 开头只能收到 `15\d{4}`：放宽成 `1\d{5}` 会把沪市转债 110/113、深市转债 123/127
 * 全划进 ETF 口径，可转债日内波动远大于 ETF，套 12% 止损与 40% 单票上限是在放松风控。
 */
export function isEtfPosition(code: string, name: string): boolean {
  return /^(15\d{4}|5\d{5})$/.test(code) || /ETF|LOF/i.test(name);
}

/**
 * 取**手上这几只** ETF 的信号（best-effort，动态导入避免与 agent/runner 形成静态循环依赖）。
 *
 * 早先这里调的是全池 `signals()`：只要账户里有一只 ETF，就会把跟踪池里每一只都算一遍、
 * 每只单独拉一次实时行情。实测这让 `evaluateDiscipline()` 要跑 9-11 秒，
 * 而驾驶舱动作清单每次刷新都要等它——盘中轮询会把这个开销变成常态。
 *
 * 纪律只用到每只自己的 stopLoss / takeProfit，跨池排名用不上，所以定向算就够了。
 */
async function loadEtfSignals(codes: string[]): Promise<Map<string, EtfSignal>> {
  if (codes.length === 0) return new Map();
  try {
    const etf = await import('../etf/service');
    return await etf.signalsFor(codes);
  } catch {
    return new Map();
  }
}

/** 读取账户级默认纪律（meta JSON，缺省回退内置默认） */
export function getDisciplineConfig(): DisciplineConfig {
  const raw = getMeta(CONFIG_META_KEY);
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<DisciplineConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** 更新账户级默认纪律（部分字段），返回最新配置 */
export function setDisciplineConfig(patch: Partial<DisciplineConfig>): DisciplineConfig {
  const next = { ...getDisciplineConfig(), ...sanitizeConfig(patch) };
  setMeta(CONFIG_META_KEY, JSON.stringify(next));
  return next;
}

/** 配置入参清洗：仅接受合法数值/允许 maxHoldDays 为 null */
function sanitizeConfig(patch: Partial<DisciplineConfig>): Partial<DisciplineConfig> {
  const out: Partial<DisciplineConfig> = {};
  const posNum = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  if (posNum(patch.stopLossPct) !== undefined) out.stopLossPct = patch.stopLossPct;
  if (posNum(patch.takeProfitPct) !== undefined) out.takeProfitPct = patch.takeProfitPct;
  if (posNum(patch.singleMaxWeightPct) !== undefined)
    out.singleMaxWeightPct = patch.singleMaxWeightPct;
  if (posNum(patch.totalMaxPositionPct) !== undefined)
    out.totalMaxPositionPct = patch.totalMaxPositionPct;
  if (patch.maxHoldDays === null || posNum(patch.maxHoldDays) !== undefined)
    out.maxHoldDays = patch.maxHoldDays ?? null;
  return out;
}

// ===== 逐票纪律覆盖 =====

function rowToOverride(row: typeof schema.positionDiscipline.$inferSelect): DisciplineOverride {
  return {
    code: row.code,
    name: row.name ?? null,
    stopLossPct: row.stopLossPct ?? null,
    takeProfitPct: row.takeProfitPct ?? null,
    maxHoldDays: row.maxHoldDays ?? null,
    singleMaxWeightPct: row.singleMaxWeightPct ?? null,
    note: row.note ?? null,
    updatedAt: row.updatedAt,
  };
}

export function listOverrides(): DisciplineOverride[] {
  return db
    .select()
    .from(schema.positionDiscipline)
    .where(eq(schema.positionDiscipline.account, ACCOUNT))
    .all()
    .map(rowToOverride);
}

function getOverrideMap(): Map<string, DisciplineOverride> {
  return new Map(listOverrides().map((o) => [o.code, o]));
}

/** upsert 逐票覆盖 */
export function setOverride(code: string, input: DisciplineOverrideInput): DisciplineOverride {
  const now = nowIso();
  const values = {
    account: ACCOUNT,
    code,
    name: input.name ?? null,
    stopLossPct: input.stopLossPct ?? null,
    takeProfitPct: input.takeProfitPct ?? null,
    maxHoldDays: input.maxHoldDays ?? null,
    singleMaxWeightPct: input.singleMaxWeightPct ?? null,
    note: input.note ?? null,
    updatedAt: now,
  };
  db.insert(schema.positionDiscipline)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.positionDiscipline.account, schema.positionDiscipline.code],
      set: {
        name: values.name,
        stopLossPct: values.stopLossPct,
        takeProfitPct: values.takeProfitPct,
        maxHoldDays: values.maxHoldDays,
        singleMaxWeightPct: values.singleMaxWeightPct,
        note: values.note,
        updatedAt: now,
      },
    })
    .run();
  return rowToOverride(
    db
      .select()
      .from(schema.positionDiscipline)
      .where(
        and(
          eq(schema.positionDiscipline.account, ACCOUNT),
          eq(schema.positionDiscipline.code, code),
        ),
      )
      .get()!,
  );
}

export function removeOverride(code: string): void {
  db.delete(schema.positionDiscipline)
    .where(
      and(eq(schema.positionDiscipline.account, ACCOUNT), eq(schema.positionDiscipline.code, code)),
    )
    .run();
}

// ===== 纪律体检 =====

/**
 * 解析某标的的生效纪律：逐票覆盖优先 → ETF 走趋势级默认（并引用 ETF 信号触发价反算止损/止盈线）
 * → 个股走账户默认。逐字段回退，互不影响。
 */
function resolveRule(
  p: RealPortfolio['positions'][number],
  assetType: 'stock' | 'etf',
  cfg: DisciplineConfig,
  overrides: Map<string, DisciplineOverride>,
  etfSig?: EtfSignal,
): DisciplinePositionItem['rule'] {
  const base = assetType === 'etf' ? ETF_DEFAULT_CONFIG : cfg;
  const ov = overrides.get(p.code);
  const hasOverride =
    !!ov &&
    (ov.stopLossPct != null ||
      ov.takeProfitPct != null ||
      ov.maxHoldDays != null ||
      ov.singleMaxWeightPct != null);

  // ETF 无逐票覆盖该字段时，引用信号结构化触发价反算「相对成本的百分比」线（取不到回退趋势级默认）
  let etfStopLossPct: number | null = null;
  let etfTakeProfitPct: number | null = null;
  if (assetType === 'etf' && etfSig && p.avgCost > 0) {
    if (etfSig.stopLoss && etfSig.stopLoss.value > 0 && etfSig.stopLoss.value < p.avgCost) {
      etfStopLossPct = Math.round(((p.avgCost - etfSig.stopLoss.value) / p.avgCost) * 1000) / 10;
    }
    if (etfSig.takeProfit && etfSig.takeProfit.value > p.avgCost) {
      etfTakeProfitPct = Math.round(((etfSig.takeProfit.value - p.avgCost) / p.avgCost) * 1000) / 10;
    }
  }

  return {
    stopLossPct: ov?.stopLossPct ?? etfStopLossPct ?? base.stopLossPct,
    takeProfitPct: ov?.takeProfitPct ?? etfTakeProfitPct ?? base.takeProfitPct,
    maxHoldDays: ov?.maxHoldDays ?? base.maxHoldDays,
    singleMaxWeightPct: ov?.singleMaxWeightPct ?? base.singleMaxWeightPct,
    source: hasOverride ? 'override' : 'default',
  };
}

/** 评估单票纪律：返回命中点集合 + 主状态 + 建议 */
function evalPosition(
  p: RealPortfolio['positions'][number],
  rule: DisciplinePositionItem['rule'],
  sizing: PositionSizing | null,
  stopPendingSince: string | null,
): { status: DisciplineStatus; flags: DisciplineFlag[]; advice: string } {
  const flags: DisciplineFlag[] = [];
  const holdPct = p.holdRate * 100;
  const posPct = p.positionRate * 100;

  // 止损：跌破成本达止损线
  if (holdPct <= -rule.stopLossPct) {
    flags.push({
      kind: 'stop_loss',
      severity: 'high',
      detail: `已跌破止损线：持有 ${holdPct.toFixed(2)}%（止损线 -${rule.stopLossPct}%），建议止损离场`,
    });
  } else if (holdPct <= -(rule.stopLossPct - 2)) {
    // 接近止损（距止损线 2 个百分点内）
    flags.push({
      kind: 'near_stop',
      severity: 'medium',
      detail: `接近止损线：持有 ${holdPct.toFixed(2)}%（止损线 -${rule.stopLossPct}%），密切观察`,
    });
  }

  // 止盈
  if (holdPct >= rule.takeProfitPct) {
    flags.push({
      kind: 'take_profit',
      severity: 'high',
      detail: `已达止盈线：持有 +${holdPct.toFixed(2)}%（止盈线 +${rule.takeProfitPct}%），建议分批兑现`,
    });
  }

  // 超期持有
  if (rule.maxHoldDays != null && p.holdDays > rule.maxHoldDays) {
    flags.push({
      kind: 'over_hold',
      severity: 'medium',
      detail: `持有 ${p.holdDays} 个交易日超过上限 ${rule.maxHoldDays} 日，复核持有逻辑是否仍成立`,
    });
  }

  // 超配：以风险预算反推的允许权重为准，该权重已把 rule.singleMaxWeightPct 作为额外 cap 折进去
  // （与账户级同口径：两个上限取更严的一个，阶段档只收紧不放宽）。
  // 后一分支不再要求 sizing 为空——否则只要 computeSizing 返回了非 null 且 reduceShares=0，
  // 用户配置的固定上限就永远不会被检查。
  if (sizing && sizing.reduceShares > 0) {
    flags.push({
      kind: 'overweight',
      severity: 'medium',
      detail:
        `本档风险预算下该票上限 ${sizing.allowedShares} 股（占 ${sizing.allowedWeightPct}%），` +
        `当前 ${sizing.currentShares} 股（占 ${posPct.toFixed(1)}%），建议减 ${sizing.reduceShares} 股。` +
        `有效损失距离 ${sizing.effectiveLossPct}%（结构止损 ${sizing.stopDistancePct}%` +
        `${sizing.atrDistancePct != null ? ` / ATR距离 ${sizing.atrDistancePct}%` : ''}` +
        `${sizing.gapBufferPct > 0 ? ` + 跳空缓冲 ${sizing.gapBufferPct}%` : ''}` +
        ` + 费用 ${sizing.costBufferPct}%）`,
    });
  } else if (posPct > rule.singleMaxWeightPct) {
    flags.push({
      kind: 'overweight',
      severity: 'medium',
      detail: `仓位 ${posPct.toFixed(1)}% 超过单票上限 ${rule.singleMaxWeightPct}%，建议适度减仓分散`,
    });
  }

  // 止损未执行：风险预算的全部前提是止损真的会被执行。真实账户是手动清单，
  // 若前几日已提示止损而至今仍持有，这笔的实际风险已经超出预算，必须显式点名。
  if (stopPendingSince) {
    flags.push({
      kind: 'stop_not_executed',
      severity: 'high',
      detail:
        `${stopPendingSince} 已提示止损，至今仍持有（当前 ${holdPct.toFixed(2)}%）。` +
        '止损不执行时，风险预算反推出的仓位上限不再成立，该票实际风险敞口不可控。',
    });
  }

  // 主状态：按严重度优先 stop_loss > stop_not_executed > take_profit > over_hold > overweight > near_stop
  const priority: DisciplineStatus[] = [
    'stop_loss',
    'stop_not_executed',
    'take_profit',
    'over_hold',
    'overweight',
    'near_stop',
  ];
  const status = priority.find((k) => flags.some((f) => f.kind === k)) ?? 'healthy';
  const advice = flags.length ? flags.map((f) => f.detail).join('；') : '纪律健康，维持持有';
  return { status, flags, advice };
}

/**
 * 真实持仓纪律体检：取实时持仓 → 逐票按生效纪律判定 → 汇总账户级检查。
 * 纯读：不下单、不调用 LLM。可传入已取的 portfolio 复用（定时与接口共享）。
 */
export async function evaluateDiscipline(portfolio?: RealPortfolio): Promise<DisciplineReport> {
  const pf = portfolio ?? (await fetchRealPositions());
  const cfg = getDisciplineConfig();
  const overrides = getOverrideMap();

  // 风险预算档随市场阶段切换：主升最松、退潮最紧。读收盘快照，不触发重算与网络请求
  const regimePhase = readRegimePhase();
  const budget = budgetForPhase(regimePhase);

  // 只算真实持有的那几只 ETF，不遍历整个跟踪池
  const etfCodes = pf.positions.filter((p) => isEtfPosition(p.code, p.name)).map((p) => p.code);
  const etfSignals = await loadEtfSignals(etfCodes);

  // 日线用于 ATR 与跳空分位；走 W1 的本地缓存，命中即秒回，取不到就退化为「只按结构止损」
  const barsByCode = await loadBars(pf.positions.map((p) => p.code));
  const stopPending = getPendingStopMap(
    pf.positions.map((p) => ({ code: p.code, holdDays: p.holdDays })),
  );

  const items: DisciplinePositionItem[] = pf.positions.map((p) => {
    const assetType: 'stock' | 'etf' = isEtfPosition(p.code, p.name) ? 'etf' : 'stock';
    const rule = resolveRule(p, assetType, cfg, overrides, etfSignals.get(p.code));
    const sizing = computeSizing(
      {
        assetType,
        price: p.price,
        stopDistancePct: rule.stopLossPct,
        totalEquity: pf.totalAsset,
        currentShares: p.qty,
        bars: barsByCode.get(p.code),
        fixedCapPct: rule.singleMaxWeightPct,
      },
      budget,
    );
    const { status, flags, advice } = evalPosition(p, rule, sizing, stopPending.get(p.code) ?? null);
    return {
      code: p.code,
      name: p.name,
      assetType,
      price: p.price,
      avgCost: p.avgCost,
      holdRate: p.holdRate,
      positionRate: p.positionRate,
      holdDays: p.holdDays,
      rule,
      sizing,
      status,
      flags,
      advice,
    };
  });

  // 账户级：总持仓占比、现金占比、最大集中度。总仓上限取「配置」与「本阶段预算」中更严的一个——
  // 阶段只收紧不放宽，配置更严时不因为阶段档宽松而放大。
  const totalPositionRate = pf.totalAsset > 0 ? pf.totalMarketValue / pf.totalAsset : 0;
  const cashRate = pf.totalAsset > 0 ? pf.cash / pf.totalAsset : 0;
  const top = [...pf.positions].sort((a, b) => b.positionRate - a.positionRate)[0];
  const warnings: string[] = [];
  const totalCap = Math.min(cfg.totalMaxPositionPct, budget.totalMaxPositionPct);
  const overTotal = totalPositionRate * 100 > totalCap;
  if (overTotal) {
    warnings.push(
      `总持仓 ${(totalPositionRate * 100).toFixed(1)}% 超过${regimePhase ?? '震荡'}档上限 ${totalCap}%，现金缓冲不足`,
    );
  }
  const topSizing = top ? items.find((i) => i.code === top.code)?.sizing ?? null : null;
  if (top && topSizing && topSizing.reduceShares > 0) {
    warnings.push(
      `最大持仓 ${top.name} 占 ${(top.positionRate * 100).toFixed(1)}%，超出本档允许的 ${topSizing.allowedWeightPct}%`,
    );
  }
  const account: DisciplineAccountCheck = {
    totalPositionRate,
    totalMaxPositionPct: totalCap,
    overTotal,
    cashRate,
    topConcentration: top ? { code: top.code, name: top.name, rate: top.positionRate } : null,
    warnings,
  };

  const counts = {
    stopLoss: items.filter((i) => i.status === 'stop_loss').length,
    takeProfit: items.filter((i) => i.status === 'take_profit').length,
    overweight: items.filter((i) => i.flags.some((f) => f.kind === 'overweight')).length,
    overHold: items.filter((i) => i.flags.some((f) => f.kind === 'over_hold')).length,
    healthy: items.filter((i) => i.status === 'healthy').length,
    stopNotExecuted: items.filter((i) => i.flags.some((f) => f.kind === 'stop_not_executed')).length,
  };

  return { asOf: pf.asOf, config: cfg, regimePhase, budget, items, account, counts };
}

/** 读大盘阶段快照（只读，不触发重算）；无快照返回 null → 风险预算回落到偏紧的震荡档 */
function readRegimePhase(): MarketRegimePhase | null {
  try {
    return regimeSummary()?.phase ?? null;
  } catch {
    return null;
  }
}

/** 批量取日线（走本地缓存）；单只失败不影响其他 */
async function loadBars(codes: string[]): Promise<Map<string, KlineBar[]>> {
  const map = new Map<string, KlineBar[]>();
  await Promise.all(
    codes.map(async (code) => {
      try {
        const bars = await getKline(code, 'day', 120);
        if (bars.length > 0) map.set(code, bars);
      } catch {
        /* 取不到就不算 ATR / 跳空，仅用结构止损距离 */
      }
    }),
  );
  return map;
}

/**
 * 找出「本轮持仓期间已提示止损、今天仍在持仓列表里」的标的 → code -> 该期间首次提示日期。
 *
 * 必须以「本轮建仓日」为下界：不设下界时，三个月前触发止损、已卖出、上周重新建仓的标的
 * 会被翻出旧事件报成「至今仍持有」，并以 high 级别抢占主状态。建仓日由 holdDays（交易日）
 * 折算成自然日近似（×7/5 并留 1 天余量），宁可略微保守也不要把上一轮的事件算进来。
 * 只看早于今天的事件：当天刚触发的止损属于正常待执行，不算未执行。
 */
export function getPendingStopMap(
  positions: Array<{ code: string; holdDays: number }>,
): Map<string, string> {
  if (positions.length === 0) return new Map();
  const today = shanghaiDateStr(new Date());
  const sinceByCode = new Map<string, string>();
  for (const p of positions) {
    const calendarDays = Math.ceil(Math.max(p.holdDays, 0) * 1.4) + 1;
    sinceByCode.set(p.code, shanghaiDateStr(new Date(Date.now() - calendarDays * 86_400_000)));
  }
  const globalSince = [...sinceByCode.values()].sort()[0];
  const rows = db
    .select({ code: schema.disciplineEvents.code, date: schema.disciplineEvents.eventDate })
    .from(schema.disciplineEvents)
    .where(
      and(
        eq(schema.disciplineEvents.kind, 'stop_loss'),
        gte(schema.disciplineEvents.eventDate, globalSince),
        lt(schema.disciplineEvents.eventDate, today),
      ),
    )
    .all();
  const map = new Map<string, string>();
  for (const r of rows) {
    const since = sinceByCode.get(r.code);
    if (since == null || r.date < since) continue; // 非持仓标的、或上一轮持仓期的旧事件
    const prev = map.get(r.code);
    if (!prev || r.date < prev) map.set(r.code, r.date); // 取本轮内最早一次提示，体现拖了多久
  }
  return map;
}

// ===== 事件流（落库 + 按日去重）=====

function rowToEvent(row: typeof schema.disciplineEvents.$inferSelect): DisciplineEvent {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind as DisciplineEvent['kind'],
    severity: row.severity as DisciplineEvent['severity'],
    detail: row.detail,
    holdRate: row.holdRate ?? null,
    createdAt: row.createdAt,
  };
}

export function listDisciplineEvents(limit = 50): DisciplineEvent[] {
  // Math.max(NaN, 1) 仍是 NaN：路由层传的是 Number(req.query.limit)，非数字须回落默认而非绑进 SQL
  const safe = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 200) : 50;
  return db
    .select()
    .from(schema.disciplineEvents)
    .orderBy(desc(schema.disciplineEvents.createdAt))
    .limit(safe)
    .all()
    .map(rowToEvent);
}

/** 当日是否已记过该 (code, kind) 事件（防同日重复刷屏） */
function existsToday(code: string, kind: string, date: string): boolean {
  const row = db
    .select({ id: schema.disciplineEvents.id })
    .from(schema.disciplineEvents)
    .where(
      and(
        eq(schema.disciplineEvents.code, code),
        eq(schema.disciplineEvents.kind, kind),
        eq(schema.disciplineEvents.eventDate, date),
      ),
    )
    .get();
  return !!row;
}

/**
 * 把体检里 high/medium 的命中点记入事件流（同日同 code+kind 去重），返回本次新增事件。
 * 仅记中高严重度，low/healthy 不落库。
 */
export function recordDisciplineEvents(report: DisciplineReport): DisciplineEvent[] {
  const date = shanghaiDateStr(new Date());
  const now = nowIso();
  const created: DisciplineEvent[] = [];
  for (const item of report.items) {
    for (const flag of item.flags) {
      if (flag.severity === 'low') continue;
      if (existsToday(item.code, flag.kind, date)) continue;
      const id = newId();
      db.insert(schema.disciplineEvents)
        .values({
          id,
          account: ACCOUNT,
          code: item.code,
          name: item.name,
          kind: flag.kind,
          severity: flag.severity,
          detail: flag.detail,
          holdRate: item.holdRate,
          eventDate: date,
          delivered: false,
          createdAt: now,
        })
        .run();
      created.push({
        id,
        code: item.code,
        name: item.name,
        kind: flag.kind,
        severity: flag.severity,
        detail: flag.detail,
        holdRate: item.holdRate,
        createdAt: now,
      });
    }
  }
  return created;
}
