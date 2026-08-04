import type { ThemeFirstSpec } from '@stock-agent/shared';
import type { FactorRow } from './factors';
import { scoreOf } from './factors';

// 主题优先单仓引擎（TS 移植）：对齐 mode/etf-mainline-theme-first-flat-leader 的 python run()。
// 先按 family 把标的聚成主题、算主题强度，主题胜出后只买主题内代表标的（最大持仓 1），
// 因此同主题重复持仓天然为 0。每次跟踪都从 anchorDate 全量回放，不落中间状态表：
// 持仓/入场价/峰值价/主题都是回放的中间态，重放即一致，日跟踪与重回测共用同一条路径。
// ponytail: 53 只 × 800 根 bar 的因子重算单次数百毫秒，池子扩到几百只再考虑缓存 row。

/** 单标的的因子序列 */
export interface UniverseSeries {
  code: string;
  /** 已按 python load_pool 的 short() 截断过的名称 */
  name: string;
  rows: Map<string, FactorRow>;
}

/** python family()：把 ETF 名称归到主题族 */
const FAMILY_RULES: ReadonlyArray<[string, readonly string[]]> = [
  ['半导体设备', ['半导体设备']],
  ['科创芯片', ['科创芯片']],
  ['全球芯片', ['全球芯片']],
  ['中韩半导体', ['中韩半导体']],
  ['芯片宽泛', ['芯片', '半导体']],
  ['通信', ['通信']],
  ['人工智能', ['人工智能']],
  ['电池储能', ['电池', '储能']],
  ['电网电力', ['电网', '电力']],
  ['港股创新药', ['港股创新药']],
  ['港美互联网', ['港美互联网']],
  ['恒生科技', ['恒生科技']],
  ['港股通科技', ['港股通科技']],
  ['美股科技', ['纳指', '纳斯达克', '标普信息科技']],
  ['传媒游戏', ['传媒', '游戏']],
  ['化工', ['化工']],
  ['金融', ['证券', '银行', '金融科技']],
  ['军工航天', ['军工', '航天', '卫星']],
  ['消费', ['消费', '消费电子']],
  ['能源资源', ['煤炭', '石油', '有色', '黄金']],
  ['宽基', ['科创50', '创业板', '科创创业50']],
  ['信创软件', ['信创', '软件']],
];

export function family(name: string): string {
  for (const [fam, keys] of FAMILY_RULES) {
    if (keys.some((k) => name.includes(k))) return fam;
  }
  return name.split('(')[0];
}

/** python load_pool 的 short()：ETF 池名称去掉 ETF/LOF 后缀与基金公司尾巴 */
export function shortName(name: string): string {
  return name.replace(/(ETF.*|LOF.*)$/, '');
}

/**
 * 主题层聚合（python 991-1011）：在**全池**上按主题算宽度与量能，回填到每个成员行。
 * 注意先聚合、后过滤——门槛读的是聚合结果。
 */
export function annotateThemes(universe: UniverseSeries[], dates: string[]): void {
  const members = new Map<string, UniverseSeries[]>();
  for (const u of universe) {
    const fam = family(u.name);
    const list = members.get(fam);
    if (list) list.push(u);
    else members.set(fam, [u]);
  }
  for (const date of dates) {
    for (const list of members.values()) {
      const rows = list.map((u) => u.rows.get(date)).filter((r): r is FactorRow => !!r);
      const n = rows.length;
      if (!n) continue;
      const avg = (f: (r: FactorRow) => number): number => rows.reduce((s, r) => s + f(r), 0) / n;
      const share = (f: (r: FactorRow) => boolean): number => rows.filter(f).length / n;
      const avgMom30 = avg((r) => r.mom30);
      const avgMom60 = avg((r) => r.mom60);
      const breadthAbove120 = share((r) => r.above120);
      const avgVolRatio20 = avg((r) => r.volRatio20);
      const avgAmountRatio20 = avg((r) => r.amountRatio20);
      const breadthAmountConfirm = share((r) => r.amountRatio20 > 1.25);
      const themePower =
        0.45 * avgMom30 +
        0.25 * avgMom60 +
        0.2 * breadthAbove120 +
        0.1 * Math.min(Math.max(0, avgVolRatio20 - 1), 2);
      const themeAmountPower =
        themePower +
        0.12 * Math.min(Math.max(0, avgAmountRatio20 - 1), 2) +
        0.08 * breadthAmountConfirm;
      for (const r of rows) {
        r.themeBreadthAbove120 = breadthAbove120;
        r.themeAmountPower = themeAmountPower;
      }
    }
  }
}

/** 主题强度：强调最强代表，同时要求第二梯队别太弱（python theme_score） */
function themeScore(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => b - a);
  const top = sorted[0];
  const avgTop2 = sorted.slice(0, 2).reduce((a, b) => a + b, 0) / Math.min(sorted.length, 2);
  return 0.65 * top + 0.35 * avgTop2;
}

interface ThemeRank {
  themeScore: number;
  leaderScore: number;
  family: string;
  leader: string;
}

/** python build_rank()：当日按门槛过滤后聚成主题、排序，返回主题榜 */
function rankAt(spec: ThemeFirstSpec, universe: UniverseSeries[], date: string): ThemeRank[] {
  const g = spec.gates;
  const groups = new Map<string, Array<{ code: string; row: FactorRow }>>();
  for (const u of universe) {
    const row = u.rows.get(date);
    if (!row?.above60) continue;
    if (g.mainlinePersist !== undefined && row.mainlinePersist < g.mainlinePersist) continue;
    if (
      g.themeBreadthAbove120 !== undefined &&
      (row.themeBreadthAbove120 ?? -999) < g.themeBreadthAbove120
    ) {
      continue;
    }
    if (g.themeAmountPower !== undefined && (row.themeAmountPower ?? -999) < g.themeAmountPower) {
      continue;
    }
    const fam = family(u.name);
    const list = groups.get(fam);
    if (list) list.push({ code: u.code, row });
    else groups.set(fam, [{ code: u.code, row }]);
  }

  const out: ThemeRank[] = [];
  for (const [fam, rows] of groups) {
    if (rows.length < (g.minThemeMembers ?? 1)) continue;
    const ts = themeScore(rows.map((x) => scoreOf(x.row, spec.themeKey)));
    if (ts === null) continue;
    const leaders = rows
      .map((x) => ({ score: scoreOf(x.row, spec.leaderKey), code: x.code }))
      .sort((a, b) => b.score - a.score || (a.code < b.code ? 1 : -1));
    if (!leaders.length) continue;
    out.push({ themeScore: ts, leaderScore: leaders[0].score, family: fam, leader: leaders[0].code });
  }
  // python 对 (ts, leader_score, fam, leader) 元组整体 reverse 排序
  out.sort(
    (a, b) =>
      b.themeScore - a.themeScore ||
      b.leaderScore - a.leaderScore ||
      (a.family < b.family ? 1 : a.family > b.family ? -1 : 0) ||
      (a.leader < b.leader ? 1 : a.leader > b.leader ? -1 : 0),
  );
  return out;
}

/** 一笔完整交易（未平仓时 exitDate 为 null） */
export interface ReplayTrade {
  entryDate: string;
  exitDate: string | null;
  code: string;
  name: string;
  family: string;
  entryPrice: number;
  exitPrice: number;
  /** 收益率（小数） */
  pnl: number;
  reason: string;
}

/** 回放中的单日切片 */
export interface ReplayDay {
  date: string;
  holding: { code: string; name: string } | null;
  /** 组合权益（起点 1） */
  equity: number;
  events: Array<{ kind: 'enter' | 'exit'; detail: string }>;
}

export interface ReplayResult {
  days: ReplayDay[];
  trades: ReplayTrade[];
  /** 期末权益 */
  equity: number;
  /** 最大回撤（小数，负数） */
  maxDrawdown: number;
  tradeCount: number;
  /** 持仓天数占比 */
  heldRatio: number;
}

/**
 * 单仓回放，对齐 python run()（px='close', cost_bps=0）。
 * 调仓相位以 dates[0] 为第 0 天，故 dates 必须从 spec.anchorDate 起算才能复现回测。
 */
export function replayThemeFirst(
  spec: ThemeFirstSpec,
  universe: UniverseSeries[],
  dates: string[],
  costBps = 0,
): ReplayResult {
  const byCode = new Map(universe.map((u) => [u.code, u]));
  const cost = costBps / 10000;
  const days: ReplayDay[] = [];
  const trades: ReplayTrade[] = [];

  let cash = 1;
  let hold: string | null = null;
  let holdFamily = '';
  let entry = 0;
  let entryDay = '';
  let entryIdx = 0;
  let peakPx = 0;
  let equityPeak = 1;
  let maxDrawdown = 0;
  let heldSum = 0;
  /** 持仓最近一次有效收盘（停牌/数据缺口日沿用它估值） */
  let lastHoldClose = 0;

  for (let idx = 0; idx < dates.length; idx++) {
    const date = dates[idx];
    const events: ReplayDay['events'] = [];
    const holdRow = hold ? byCode.get(hold)?.rows.get(date) : undefined;
    if (holdRow) lastHoldClose = holdRow.c;
    // 持仓当日无行情（停牌、数据缺口）时沿用上一次有效估值：
    // 直接落回 cash 会让净值当天跳掉全部浮盈、次日跳回，在曲线上造出假回撤并污染 maxDrawdown
    const equity = hold && lastHoldClose > 0 ? cash * (lastHoldClose / entry) : cash;
    equityPeak = Math.max(equityPeak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / equityPeak - 1);
    if (hold) heldSum += 1;

    if (idx % spec.rebalanceDays === 0) {
      const rows = rankAt(spec, universe, date);
      const best = rows.length ? rows[0] : null;

      if (hold) {
        const heldDays = idx - entryIdx;
        if (holdRow) peakPx = Math.max(peakPx, holdRow.c);
        const gain = entry ? peakPx / entry - 1 : 0;
        const pullback = holdRow && peakPx ? holdRow.c / peakPx - 1 : 0;
        const famRank = rows.findIndex((r) => r.family === holdFamily);
        const pct = (v: number): string => `${Math.round(v * 100)}%`;

        let reason: string | null = null;
        if (holdRow && gain >= spec.protectGain && pullback <= -spec.protectDrawdown) {
          reason = `盈利保护${pct(spec.protectGain)}/${pct(spec.protectDrawdown)}`;
        } else if (holdRow && holdRow.c < holdRow.ma[spec.exitMa]) {
          reason = `跌破MA${spec.exitMa}`;
        } else if (famRank < 0 && heldDays >= spec.minHoldDays) {
          reason = '主题失效';
        } else if (famRank >= spec.themeTopExit && heldDays >= spec.minHoldDays) {
          reason = `主题跌出Top${spec.themeTopExit}`;
        } else if (best && best.family !== holdFamily && heldDays >= spec.minHoldDays) {
          reason = '主线主题替换';
        }

        if (reason) {
          const series = byCode.get(hold);
          const sell = series?.rows.get(date)?.c ?? entry;
          const pnl = (sell / entry) * (1 - cost) * (1 - cost) - 1;
          trades.push({
            entryDate: entryDay,
            exitDate: date,
            code: hold,
            name: series?.name ?? hold,
            family: holdFamily,
            entryPrice: entry,
            exitPrice: sell,
            pnl,
            reason,
          });
          events.push({ kind: 'exit', detail: `卖出 ${series?.name ?? ''}(${hold})：${reason}` });
          cash *= (sell / entry) * (1 - cost);
          hold = null;
          holdFamily = '';
          peakPx = 0;
          lastHoldClose = 0;
        }
      }

      if (!hold && best) {
        const series = byCode.get(best.leader);
        const row = series?.rows.get(date);
        if (row) {
          hold = best.leader;
          holdFamily = best.family;
          entry = row.c;
          entryDay = date;
          entryIdx = idx;
          peakPx = entry;
          lastHoldClose = entry;
          cash *= 1 - cost;
          events.push({ kind: 'enter', detail: `买入 ${series?.name ?? ''}(${hold})：主题 ${best.family}` });
        }
      }
    }

    const holdSeries = hold ? byCode.get(hold) : null;
    days.push({
      date,
      holding: hold ? { code: hold, name: holdSeries?.name ?? hold } : null,
      equity,
      events,
    });
  }

  // 期末仍持仓：按最后一日收盘计入权益与交易记录（python 的「持有中」）
  if (hold && dates.length) {
    const last = dates[dates.length - 1];
    const series = byCode.get(hold);
    const sell = series?.rows.get(last)?.c ?? entry;
    trades.push({
      entryDate: entryDay,
      exitDate: null,
      code: hold,
      name: series?.name ?? hold,
      family: holdFamily,
      entryPrice: entry,
      exitPrice: sell,
      pnl: (sell / entry) * (1 - cost) * (1 - cost) - 1,
      reason: '持有中',
    });
  }

  return {
    days,
    trades,
    equity: days.length ? days[days.length - 1].equity : 1,
    maxDrawdown,
    // 交易次数 = 完整回合数（trades 每回合一条）。原先买腿卖腿各 +1，报告里的次数是真实回合数的约两倍
    tradeCount: trades.length,
    heldRatio: dates.length ? heldSum / dates.length : 0,
  };
}
