import type { BoardKind, BoardStockPick } from '@stock-agent/shared';
import { fetchBoardConstituents } from '../breadth/data';
import { fetchMarketSnapshot } from '../screener/snapshot';
import { enrichTrendFactors } from '../screener/trend';

// 板块标的解析（确定性排序，不调 LLM）：把板块成分股解析成「龙头 / 补涨」两类可执行标的。
// 复用现有成分取数（breadth 东财板块成分）+ 全市场快照（市值/涨幅）+ 逐只趋势/资金因子分。
// 龙头 = 市值大 + 趋势强；补涨 = 涨幅未起 + 位置不高 + 资金确认。均为研判，不下单。

// 限制逐只因子取数的候选规模，避免打爆东财接口（按市值取前 N 只成分）。
// ponytail: 纯按市值截断会系统性漏掉小市值真龙头/妖股；升级路径=候选选取融合当日涨幅/换手再截断。
const MAX_ENRICH = 30;
/** 每类输出上限 */
const TOP_N = 5;

/** 补涨判定阈值：涨幅未起 / 位置不高（趋势分不过热）/ 资金确认 */
const LAGGARD_MAX_PCT = 3;
const LAGGARD_MAX_TREND = 70;
const LAGGARD_MIN_FUND = 55;

/**
 * 解析板块内龙头与补涨标的。
 * @param kind 板块归类（行业/概念，决定东财成分接口）
 * @param boardName 板块名（fetchBoardConstituents 以名称为 symbol）
 */
export async function resolveBoardPicks(
  kind: BoardKind,
  boardName: string,
): Promise<{ leaders: BoardStockPick[]; laggards: BoardStockPick[] }> {
  const codes = await fetchBoardConstituents(kind, boardName).catch(() => [] as string[]);
  if (codes.length === 0) return { leaders: [], laggards: [] };

  // 全市场快照（含市值/涨幅/行业），映射成分 code → 行情行
  const snapshot = await fetchMarketSnapshot().catch(() => []);
  const rowByCode = new Map(snapshot.map((r) => [r.code, r]));
  const inBoard = codes.filter((c) => rowByCode.has(c));
  if (inBoard.length === 0) return { leaders: [], laggards: [] };

  // 按市值降序取前 N 只做逐只因子取数（趋势 + 资金），控制取数量
  const byCap = inBoard
    .slice()
    .sort((a, b) => (rowByCode.get(b)?.marketCap ?? 0) - (rowByCode.get(a)?.marketCap ?? 0))
    .slice(0, MAX_ENRICH);
  const factors = await enrichTrendFactors(byCap, ['trend', 'fundFlow']).catch(
    (): Awaited<ReturnType<typeof enrichTrendFactors>> => new Map(),
  );

  const picks: BoardStockPick[] = byCap.map((code) => {
    const r = rowByCode.get(code)!;
    const f = factors.get(code);
    return {
      code,
      name: r.name,
      price: r.price ?? null,
      pct: r.pct ?? null,
      marketCap: r.marketCap ?? null,
      trendScore: f?.trend ?? null,
      fundScore: f?.fundFlow ?? null,
      reason: '',
    };
  });

  // 龙头：趋势强度优先，市值兜底（市值大 + 趋势强）
  const leaders = picks
    .slice()
    .sort(
      (a, b) =>
        (b.trendScore ?? 0) - (a.trendScore ?? 0) || (b.marketCap ?? 0) - (a.marketCap ?? 0),
    )
    .slice(0, TOP_N)
    .map((p) => ({
      ...p,
      reason: `市值${p.marketCap != null ? Math.round(p.marketCap) + '亿' : '—'}·趋势分${p.trendScore ?? '—'}`,
    }));

  // 补涨：涨幅未起 + 位置不高（趋势分不过热）+ 资金确认，按资金分降序
  const laggards = picks
    .filter(
      (p) =>
        (p.pct ?? 99) < LAGGARD_MAX_PCT &&
        (p.trendScore ?? 100) <= LAGGARD_MAX_TREND &&
        (p.fundScore ?? 0) >= LAGGARD_MIN_FUND,
    )
    .sort((a, b) => (b.fundScore ?? 0) - (a.fundScore ?? 0))
    .slice(0, TOP_N)
    .map((p) => ({
      ...p,
      reason: `资金确认${p.fundScore ?? '—'}·涨幅${p.pct != null ? p.pct.toFixed(1) + '%' : '—'}·位置未高`,
    }));

  return { leaders, laggards };
}
