import { and, desc, eq } from 'drizzle-orm';
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
  RealPortfolio,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { getMeta, setMeta } from '../settings';
import { fetchRealPositions } from '../realPositions';
import { shanghaiDateStr } from '../market/calendar';
import { newId, nowIso } from '../util';

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

/** 解析某标的的生效纪律（逐票覆盖优先，逐字段回退账户默认） */
function resolveRule(
  code: string,
  cfg: DisciplineConfig,
  overrides: Map<string, DisciplineOverride>,
): DisciplinePositionItem['rule'] {
  const ov = overrides.get(code);
  const hasOverride =
    !!ov &&
    (ov.stopLossPct != null ||
      ov.takeProfitPct != null ||
      ov.maxHoldDays != null ||
      ov.singleMaxWeightPct != null);
  return {
    stopLossPct: ov?.stopLossPct ?? cfg.stopLossPct,
    takeProfitPct: ov?.takeProfitPct ?? cfg.takeProfitPct,
    maxHoldDays: ov?.maxHoldDays ?? cfg.maxHoldDays,
    singleMaxWeightPct: ov?.singleMaxWeightPct ?? cfg.singleMaxWeightPct,
    source: hasOverride ? 'override' : 'default',
  };
}

/** 评估单票纪律：返回命中点集合 + 主状态 + 建议 */
function evalPosition(
  p: RealPortfolio['positions'][number],
  rule: DisciplinePositionItem['rule'],
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

  // 超配
  if (posPct > rule.singleMaxWeightPct) {
    flags.push({
      kind: 'overweight',
      severity: 'medium',
      detail: `仓位 ${posPct.toFixed(1)}% 超过单票上限 ${rule.singleMaxWeightPct}%，建议适度减仓分散`,
    });
  }

  // 主状态：按严重度优先 stop_loss > take_profit > over_hold > overweight > near_stop
  const priority: DisciplineStatus[] = [
    'stop_loss',
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

  const items: DisciplinePositionItem[] = pf.positions.map((p) => {
    const rule = resolveRule(p.code, cfg, overrides);
    const { status, flags, advice } = evalPosition(p, rule);
    return {
      code: p.code,
      name: p.name,
      price: p.price,
      avgCost: p.avgCost,
      holdRate: p.holdRate,
      positionRate: p.positionRate,
      holdDays: p.holdDays,
      rule,
      status,
      flags,
      advice,
    };
  });

  // 账户级：总持仓占比、现金占比、最大集中度
  const totalPositionRate = pf.totalAsset > 0 ? pf.totalMarketValue / pf.totalAsset : 0;
  const cashRate = pf.totalAsset > 0 ? pf.cash / pf.totalAsset : 0;
  const top = [...pf.positions].sort((a, b) => b.positionRate - a.positionRate)[0];
  const warnings: string[] = [];
  const overTotal = totalPositionRate * 100 > cfg.totalMaxPositionPct;
  if (overTotal) {
    warnings.push(
      `总持仓 ${(totalPositionRate * 100).toFixed(1)}% 超过上限 ${cfg.totalMaxPositionPct}%，现金缓冲不足`,
    );
  }
  if (top && top.positionRate * 100 > cfg.singleMaxWeightPct) {
    warnings.push(
      `最大持仓 ${top.name} 占 ${(top.positionRate * 100).toFixed(1)}%，集中度偏高`,
    );
  }
  const account: DisciplineAccountCheck = {
    totalPositionRate,
    totalMaxPositionPct: cfg.totalMaxPositionPct,
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
  };

  return { asOf: pf.asOf, config: cfg, items, account, counts };
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
  return db
    .select()
    .from(schema.disciplineEvents)
    .orderBy(desc(schema.disciplineEvents.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200))
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
