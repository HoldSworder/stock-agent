import { and, desc, eq } from 'drizzle-orm';
import type {
  PositionAttributionItem,
  PositionAttributionReport,
  RealPortfolio,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { fetchRealPositions } from '../realPositions';
import { shanghaiDateStr } from '../market/calendar';
import { newId, nowIso } from '../util';

// 日终持仓归因：纯确定性只读。取真实持仓（股票/ETF + 场外基金），逐票计算「当日盈亏贡献」
// （当日盈亏率 × 仓位权重），并汇总账户级当日盈亏与最大赢家/输家，按 date+code 幂等落库。
// 不调用 LLM、不下单；note 仅存确定性归因文本，白话增强留作可选后续。

const ACCOUNT = 'real';

/** 把组合内一项（股票/ETF 或场外基金）归一化为归因条目 */
function toItem(args: {
  code: string;
  name: string;
  dayPnl: number;
  dayRate: number;
  weight: number;
}): PositionAttributionItem {
  const contribution = args.dayRate * args.weight;
  const note =
    `当日 ${args.dayRate >= 0 ? '+' : ''}${(args.dayRate * 100).toFixed(2)}%` +
    ` · 权重 ${(args.weight * 100).toFixed(1)}%` +
    ` · 贡献 ${contribution >= 0 ? '+' : ''}${(contribution * 100).toFixed(2)}pct`;
  return {
    code: args.code,
    name: args.name,
    dayPnl: Math.round(args.dayPnl * 100) / 100,
    dayRate: args.dayRate,
    weight: args.weight,
    contribution,
    note,
  };
}

/** 由实时持仓构造当日归因报告（不落库）。可传入已取的 portfolio 复用。 */
export async function computeAttribution(
  portfolio?: RealPortfolio,
): Promise<PositionAttributionReport> {
  const pf = portfolio ?? (await fetchRealPositions());
  const date = shanghaiDateStr(new Date());

  const items: PositionAttributionItem[] = [
    ...pf.positions.map((p) =>
      toItem({ code: p.code, name: p.name, dayPnl: p.todayProfit, dayRate: p.todayRate, weight: p.positionRate }),
    ),
    ...pf.funds.map((f) =>
      toItem({ code: f.code, name: f.name, dayPnl: f.todayProfit, dayRate: f.todayRate, weight: f.positionRate }),
    ),
  ].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const totalDayPnl = pf.totalTodayProfit;
  const totalDayRate = pf.totalAsset > 0 ? totalDayPnl / pf.totalAsset : 0;
  const winners = items.filter((i) => i.dayPnl > 0);
  const losers = items.filter((i) => i.dayPnl < 0);
  const topWinner = winners.length ? winners.reduce((m, i) => (i.dayPnl > m.dayPnl ? i : m)) : null;
  const topLoser = losers.length ? losers.reduce((m, i) => (i.dayPnl < m.dayPnl ? i : m)) : null;

  return {
    date,
    asOf: pf.asOf,
    totalDayPnl: Math.round(totalDayPnl * 100) / 100,
    totalDayRate,
    items,
    topWinner,
    topLoser,
  };
}

/** 落库当日归因（按 account+date+code 幂等覆盖），返回报告。 */
export function persistAttribution(report: PositionAttributionReport): void {
  const now = nowIso();
  db.transaction((tx) => {
    for (const it of report.items) {
      tx.insert(schema.positionAttributions)
        .values({
          id: newId(),
          account: ACCOUNT,
          date: report.date,
          code: it.code,
          name: it.name,
          dayPnl: it.dayPnl,
          dayRate: it.dayRate,
          weight: it.weight,
          contribution: it.contribution,
          note: it.note,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.positionAttributions.account,
            schema.positionAttributions.date,
            schema.positionAttributions.code,
          ],
          set: {
            name: it.name,
            dayPnl: it.dayPnl,
            dayRate: it.dayRate,
            weight: it.weight,
            contribution: it.contribution,
            note: it.note,
            createdAt: now,
          },
        })
        .run();
    }
  });
}

/** 收盘后归因：计算 + 落库，返回报告（供定时与手动触发共用） */
export async function runAttribution(portfolio?: RealPortfolio): Promise<PositionAttributionReport> {
  const report = await computeAttribution(portfolio);
  persistAttribution(report);
  return report;
}

/** 持仓归因文本（注入收盘复盘 / agent 的确定性底稿；无数据返回提示） */
export function formatAttributionForAgent(report: PositionAttributionReport | null): string {
  if (!report || report.items.length === 0) {
    return '当日持仓归因：暂无数据（收盘归因未生成或当日无持仓）。';
  }
  const sign = (v: number) => (v >= 0 ? '+' : '');
  const lines: string[] = [
    `当日持仓归因（${report.date}）`,
    `账户当日盈亏 ${sign(report.totalDayPnl)}${report.totalDayPnl.toFixed(2)} 元` +
      ` ｜对账户贡献 ${sign(report.totalDayRate)}${(report.totalDayRate * 100).toFixed(2)}pct`,
  ];
  if (report.topWinner) {
    const w = report.topWinner;
    lines.push(
      `最大赢家：${w.name}(${w.code}) 贡献 ${sign(w.contribution)}${(w.contribution * 100).toFixed(2)}pct` +
        `（当日 ${sign(w.dayRate)}${(w.dayRate * 100).toFixed(2)}% · 权重 ${(w.weight * 100).toFixed(1)}%）`,
    );
  }
  if (report.topLoser) {
    const l = report.topLoser;
    lines.push(
      `最大输家：${l.name}(${l.code}) 贡献 ${sign(l.contribution)}${(l.contribution * 100).toFixed(2)}pct` +
        `（当日 ${sign(l.dayRate)}${(l.dayRate * 100).toFixed(2)}% · 权重 ${(l.weight * 100).toFixed(1)}%）`,
    );
  }
  lines.push('逐票贡献（按绝对值倒序）：');
  for (const it of report.items.slice(0, 10)) {
    lines.push(
      `  ${it.name}(${it.code})：贡献 ${sign(it.contribution)}${(it.contribution * 100).toFixed(2)}pct` +
        ` ｜当日 ${sign(it.dayRate)}${(it.dayRate * 100).toFixed(2)}% ｜权重 ${(it.weight * 100).toFixed(1)}%`,
    );
  }
  return lines.join('\n');
}

/** 读取某交易日已落库的归因；无 date 取最近一日。 */
export function getAttribution(date?: string): PositionAttributionReport | null {
  let day = date;
  if (!day) {
    const latest = db
      .select({ date: schema.positionAttributions.date })
      .from(schema.positionAttributions)
      .where(eq(schema.positionAttributions.account, ACCOUNT))
      .orderBy(desc(schema.positionAttributions.date))
      .limit(1)
      .get();
    day = latest?.date;
  }
  if (!day) return null;

  const rows = db
    .select()
    .from(schema.positionAttributions)
    .where(
      and(
        eq(schema.positionAttributions.account, ACCOUNT),
        eq(schema.positionAttributions.date, day),
      ),
    )
    .all();
  if (rows.length === 0) return null;

  const items: PositionAttributionItem[] = rows
    .map((r) => ({
      code: r.code,
      name: r.name,
      dayPnl: r.dayPnl,
      dayRate: r.dayRate,
      weight: r.weight,
      contribution: r.contribution,
      note: r.note ?? null,
    }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const totalDayPnl = Math.round(items.reduce((s, i) => s + i.dayPnl, 0) * 100) / 100;
  const winners = items.filter((i) => i.dayPnl > 0);
  const losers = items.filter((i) => i.dayPnl < 0);
  const topWinner = winners.length ? winners.reduce((m, i) => (i.dayPnl > m.dayPnl ? i : m)) : null;
  const topLoser = losers.length ? losers.reduce((m, i) => (i.dayPnl < m.dayPnl ? i : m)) : null;
  // 落库口径无总资产，账户日收益率以各权重×日收益率求和近似
  const totalDayRate = items.reduce((s, i) => s + i.contribution, 0);

  const asOf = rows.reduce((mx, r) => (r.createdAt > mx ? r.createdAt : mx), rows[0].createdAt);
  return { date: day, asOf, totalDayPnl, totalDayRate, items, topWinner, topLoser };
}
