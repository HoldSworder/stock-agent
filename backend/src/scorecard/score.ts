import type { ScorableSignal, Scorecard, ScoreRow } from '@stock-agent/shared';
import { forwardReturnOn, loadSeries, type Series } from './series';

// 判卷机·信号级：回答「这批信号比随便买强多少」。
//
// 为什么两个对照缺一不可，它们问的是两件不同的事：
//   · 同标的随机日：在这只标的上随便挑一天买能拿多少 → 检验择时
//   · 同一天全池：这一天买池里任意一只能拿多少 → 检验挑标的
// 光看信号自己的收益率毫无意义——区间里大盘怎么走，随便买也是那个结果。
//
// 这套口径来自 ETF 盯盘那张第一张成绩单，已经在一千多条真实信号上跑过。
// 它现在是所有信号来源的统一判分标准，任何模块想进建议区都得先过这一关。

/** 默认持有期（交易日）。短中长各一档，避免只挑一个对自己有利的窗口 */
export const DEFAULT_HORIZONS = [5, 10, 20] as const;

/**
 * 样本量下限。低于此数不给结论，只报「样本不足」。
 *
 * 定在这个量级是因为：几十条样本的均值差一两个百分点纯属噪声，
 * 而一句「稳定领先」会被当成可以照做的依据。宁可不说，不能说错。
 */
export const MIN_JUDGED = 100;

/** 价值达到这个幅度才敢说「领先」（小数，即 0.5 个百分点） */
export const MEANINGFUL_EDGE = 0.005;

/**
 * 信号的价值：比基准好多少，已按方向换算。
 *
 * 看跌信号的方向是反的——发出之后价格越跌，说明判断越对。
 * 不翻转的话，「跑输基准 9 个百分点」会被读成信号很差，实际含义正好相反。
 */
export function signalEdge(side: 'long' | 'short', mean: number, baseline: number): number {
  return (side === 'long' ? 1 : -1) * (mean - baseline);
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 同标的同日只算一条：一天刷屏十次不能把那天的涨跌重复计十遍 */
function dedupe(signals: readonly ScorableSignal[]): ScorableSignal[] {
  const m = new Map<string, ScorableSignal>();
  for (const s of signals) {
    const key = `${s.code}|${s.tradeDate}|${s.side}`;
    const prev = m.get(key);
    if (!prev) {
      m.set(key, { ...s });
    } else if (s.tag && !prev.tag) {
      prev.tag = s.tag;
    }
  }
  return [...m.values()];
}

function rowFor(
  n: number,
  group: readonly ScorableSignal[],
  series: Map<string, Series>,
  pool: readonly string[],
  from: string,
  to: string,
  side: 'long' | 'short',
): ScoreRow {
  const sig: number[] = [];
  const bySameCode: number[] = [];
  const bySameDate: number[] = [];

  // 三组必须在同一批信号上算。
  // 若信号组丢掉「未来 K 线不足 n 根」的条目而对照组照算，
  // 区间末尾的信号会被踢出信号组、对照仍按全部信号的分布取值，比的就不是同一批。
  // 对照按标的、按日期重复计入是有意为之：这样对照的分布与信号组一致，
  // 正是配对比较该有的加权。
  for (const u of group) {
    const r = forwardReturnOn(series.get(u.code), u.tradeDate, n);
    if (r == null) continue;
    sig.push(r);

    const s = series.get(u.code);
    if (s) {
      const rs: number[] = [];
      for (const d of s.dates) {
        if (d < from || d > to) continue;
        const x = forwardReturnOn(s, d, n);
        if (x != null) rs.push(x);
      }
      if (rs.length) bySameCode.push(mean(rs));
    }

    const rs: number[] = [];
    for (const c of pool) {
      const x = forwardReturnOn(series.get(c), u.tradeDate, n);
      if (x != null) rs.push(x);
    }
    if (rs.length) bySameDate.push(mean(rs));
  }

  const m = mean(sig);
  const b1 = mean(bySameCode);
  const b2 = mean(bySameDate);
  return {
    horizon: n,
    judged: sig.length,
    mean: m,
    upRatio: sig.length === 0 ? 0 : sig.filter((x) => x > 0).length / sig.length,
    baselineSameCode: b1,
    baselineSameDate: b2,
    edgeVsSameCode: signalEdge(side, m, b1),
    edgeVsSameDate: signalEdge(side, m, b2),
  };
}

/**
 * 一句人话结论。这句话会挂在模块名旁边，所以宁可保守。
 *
 * 判据：两个对照都要过。只赢一个说明不了什么——赢了择时输了选标的，
 * 换成「这一天买池子里任意一只」反而更好，那这套信号就没有存在意义。
 */
// 这句话是使用者唯一会读的东西，措辞本身就是产品，单独导出供自检钉住。
export { verdictOf as __test__verdictOf };

function verdictOf(rows: readonly ScoreRow[]): string {
  const usable = rows.filter((r) => r.judged >= MIN_JUDGED);
  if (usable.length === 0) {
    const most = Math.max(0, ...rows.map((r) => r.judged));
    const base = `样本不足（最多 ${most} 条，需要 ${MIN_JUDGED} 条才给结论）`;

    // 样本不够时不给「有本事」的结论，这条不松口——门槛就是被一次
    // 58 条样本的越界结论逼出来的。但**「样本不足」不该被读成「不知道」**：
    // 真实例子（2026-09-15 的选股·模型挑选）74 条样本落后 4 个百分点、
    // 60 条样本落后 9.4 个百分点，方向已经很清楚了。
    //
    // 所以这里只补一句事实陈述，不是结论：说清目前的方向，让人别把它当中性。
    // 判断「有没有本事」需要足够样本，提醒「目前看着在亏」不需要——
    // 两个方向的谨慎程度本来就不对称：漏报优势只是错过，漏报亏损是真亏钱。
    const bad = rows.filter(
      (r) => r.judged > 0 && Math.min(r.edgeVsSameCode, r.edgeVsSameDate) <= -MEANINGFUL_EDGE,
    );
    if (bad.length === 0) return base;
    const worst = bad.reduce((a, b) =>
      Math.min(a.edgeVsSameCode, a.edgeVsSameDate) <= Math.min(b.edgeVsSameCode, b.edgeVsSameDate)
        ? a
        : b,
    );
    const pts = Math.abs(Math.min(worst.edgeVsSameCode, worst.edgeVsSameDate) * 100);
    return (
      `${base}。但目前这些样本的方向是负的：持有 ${worst.horizon} 日落后随机 ` +
      `${pts.toFixed(1)} 个百分点（${worst.judged} 条）。样本不够还不能下结论，` +
      `但也别当成「不知道」`
    );
  }
  const winning = usable.filter(
    (r) => r.edgeVsSameCode >= MEANINGFUL_EDGE && r.edgeVsSameDate >= MEANINGFUL_EDGE,
  );
  if (winning.length === 0) return '尚无证据显示优于随机';
  const best = winning.reduce((a, b) =>
    Math.min(a.edgeVsSameCode, a.edgeVsSameDate) >= Math.min(b.edgeVsSameCode, b.edgeVsSameDate)
      ? a
      : b,
  );
  const pts = Math.min(best.edgeVsSameCode, best.edgeVsSameDate) * 100;
  const head = `持有 ${best.horizon} 日时领先随机 ${pts.toFixed(1)} 个百分点（${best.judged} 条样本）`;

  // 只报最好的那个持有期是在骗人。
  //
  // 真实例子（2026-09-15 的选股·多因子）：5 日领先 0.8 个百分点，
  // 而同一批信号 20 日是**落后 6.6 个百分点**。只印前半句，
  // 使用者会当成「这套选股有本事」，然后按他自己的中线打法拿 20 天以上——
  // 正好踩在它亏钱的那一段。报好看的、省掉打脸的，跟没判一样。
  const losing = usable.filter(
    (r) => Math.min(r.edgeVsSameCode, r.edgeVsSameDate) <= -MEANINGFUL_EDGE,
  );
  if (losing.length === 0) return head;

  const worst = losing.reduce((a, b) =>
    Math.min(a.edgeVsSameCode, a.edgeVsSameDate) <= Math.min(b.edgeVsSameCode, b.edgeVsSameDate)
      ? a
      : b,
  );
  const wpts = Math.min(worst.edgeVsSameCode, worst.edgeVsSameDate) * 100;
  return (
    `${head}；但持有 ${worst.horizon} 日反而落后 ${Math.abs(wpts).toFixed(1)} 个百分点` +
    `（${worst.judged} 条样本）——只在短持有期有效，拿久了会亏回去`
  );
}

/**
 * 给一批信号打分。
 *
 * @param pool 对照二用的标的池。传空则用信号自身涉及的标的，
 *        这是最保守的取法——池子越大越容易显得信号厉害，不该由判分方自己挑。
 */
export function scoreSignals(input: {
  source: string;
  label: string;
  signals: readonly ScorableSignal[];
  side: 'long' | 'short';
  horizons?: readonly number[];
  pool?: readonly string[];
}): Scorecard {
  const horizons = input.horizons ?? DEFAULT_HORIZONS;
  const group = dedupe(input.signals);
  const dates = group.map((u) => u.tradeDate).sort();
  const from = dates[0] ?? '';
  const to = dates[dates.length - 1] ?? '';
  const pool = input.pool?.length ? input.pool : [...new Set(group.map((u) => u.code))];
  const series = loadSeries([...new Set([...pool, ...group.map((u) => u.code)])]);

  const rows = horizons.map((n) =>
    rowFor(n, group, series, pool, from, to, input.side),
  );

  // 分组只对首个持有期出，多个持有期乘上分组数会变成一张没人看的大表
  const n0 = horizons[0];
  const tags = [...new Set(group.map((u) => u.tag).filter((t): t is string => !!t))].sort();
  const byTag = tags.map((tag) => {
    const rs: number[] = [];
    for (const u of group) {
      if (u.tag !== tag) continue;
      const r = forwardReturnOn(series.get(u.code), u.tradeDate, n0);
      if (r != null) rs.push(r);
    }
    return {
      tag,
      judged: rs.length,
      mean: mean(rs),
      upRatio: rs.length === 0 ? 0 : rs.filter((x) => x > 0).length / rs.length,
    };
  });

  return {
    source: input.source,
    label: input.label,
    rawCount: input.signals.length,
    count: group.length,
    from,
    to,
    poolSize: pool.length,
    rows,
    byTag,
    verdict: verdictOf(rows),
  };
}
