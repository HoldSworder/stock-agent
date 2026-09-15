import { desc, eq } from 'drizzle-orm';
import type { AssertionScorecard, AssertionScoreRow } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { listModuleJobs } from '../scheduling/moduleScheduler';
import { shanghaiToday } from '../util';
import { weightsEnabled } from './weightService';

// 技术判断的明码标价。
//
// 这些方法（道氏、波浪、黄金分割、均线、枢轴、缠论中枢）走的不是信号级判分那套
// 「未来 N 日相对基准」，而是点位判断 + 安慰剂对照：为每条真实价位造一条同样远近的
// 随机价位，比较两者「被触及后是否按判断掉头」的比例。
//
// 成绩早就算出来并落在 assertion_source_weights 里，但此前只存在于代码注释和数据库中，
// 页面上一个字都看不到。那等于白测——测出来没人知道的结论，和没测一样。
//
// 结论口径与 scorecard/score.ts 保持一致，否则同一套系统里两处成绩各说一套话，
// 使用者没法横向比较哪个模块更值得信。

/** 样本量下限，与信号级判分同口径 */
const MIN_SAMPLES = 100;

/** 增益达到这个幅度（百分点）才敢说领先 */
const MEANINGFUL_POINTS = 0.5;

/**
 * 成绩超过这么多天没更新就提示过期。
 *
 * 链路正常时每个交易日都会重算，隔了一周还没动必然是哪一环没跑。
 * 取 7 天而不是 1 天，是为了让周末与连续假期不产生误报。
 */
const STALE_DAYS_WARN = 7;

/** 成绩更新链路的三环，缺任一环成绩都会停在原地 */
const UPDATE_CHAIN: Array<{ id: string; label: string }> = [
  { id: 'assertions.freeze', label: '存档' },
  { id: 'assertions.settle', label: '核对' },
  { id: 'assertions.weights', label: '算成绩' },
];

/** 相差几个自然日。两侧都是 YYYY-MM-DD，按 UTC 零点相减即可，不涉及时区偏移 */
function daysSince(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86400_000));
}

/** 成绩更新链路里没打开的那几环。查不到的任务也算没开——宁可多提示一句，也不让停更悄悄发生 */
function disabledChainLabels(): string[] {
  const jobs = listModuleJobs();
  return UPDATE_CHAIN.filter((j) => {
    const info = jobs.find((x) => x.id === j.id);
    return !info || !info.enabled;
  }).map((j) => j.label);
}

/**
 * 成绩新不新鲜、为什么不新鲜。
 *
 * 不新鲜有两种原因，给出的话必须不同：**定时没开**是「它本来就不会更新，去打开」，
 * **定时开着却停更**是「有一环跑挂了，去看任务健康」。
 * 混成一句「成绩已过期」，使用者不知道该做什么。
 */
function stalenessOf(
  computedAt: string | null,
  today: string,
  /** 没打开的那几环的人读名。空数组 = 三环都开着 */
  off: string[],
): {
  staleDays: number | null;
  staleNote: string | null;
} {
  if (computedAt == null) {
    return {
      staleDays: null,
      staleNote:
        '还没算过成绩。' +
        (off.length > 0
          ? `要算出来得先打开这几项定时：${off.join('、')}（在「定时任务」页）。`
          : '定时已开，等下一个交易日收盘后就有了。'),
    };
  }

  const staleDays = daysSince(computedAt, today);

  if (off.length > 0) {
    return {
      staleDays,
      staleNote:
        `这份成绩算于 ${computedAt}，${staleDays} 天没更新过，而且不会自己更新——` +
        `${off.join('、')}这几项定时是关着的（在「定时任务」页可以打开）。` +
        '下面的数字反映的是那天为止的历史，不是最新情况。',
    };
  }

  if (staleDays > STALE_DAYS_WARN) {
    return {
      staleDays,
      staleNote:
        `这份成绩算于 ${computedAt}，已经 ${staleDays} 天没更新。` +
        '定时是开着的，说明有一环没跑成——到首页的任务健康屏看是哪一项。',
    };
  }

  return { staleDays, staleNote: null };
}

/** 依据来源的人读名 */
const SOURCE_LABELS: Record<string, string> = {
  dow: '道氏前高前低',
  elliott: '波浪',
  fib: '黄金分割',
  ma: '均线',
  pivot: '枢轴',
  chan: '缠论中枢',
};

/**
 * 一句人话结论。
 *
 * 用 95% 保守下界而不是点估计做判据：点估计是「这批样本恰好算出来多少」，
 * 下界是「最差情况下还能剩多少」。几百条样本的点估计上下摆动一两个百分点很常见，
 * 拿它宣布领先，下个月就会翻脸。
 */
function verdictOf(row: { edgeLower: number | null; samples: number | null }): string {
  const n = row.samples ?? 0;
  if (n < MIN_SAMPLES) return `样本不足（${n} 条，需要 ${MIN_SAMPLES} 条才给结论）`;
  const lower = row.edgeLower;
  if (lower == null) return '还没算出对照结果';
  if (lower >= MEANINGFUL_POINTS) {
    return `比同样远近的随机价位稳定领先 ${lower.toFixed(1)} 个百分点（${n} 条样本）`;
  }
  if (lower <= -MEANINGFUL_POINTS) {
    return `比同样远近的随机价位弱 ${Math.abs(lower).toFixed(1)} 个百分点（${n} 条样本）`;
  }
  return `与同样远近的随机价位看不出差别（${n} 条样本）`;
}

/**
 * 各技术依据的最新成绩。
 *
 * 每个来源取它自己最新一条记录——不同来源的最后计算日可能不同（某一天某个来源
 * 样本塌缩会跳过），统一取全局最新日会让那些来源显示成空白。
 */
export function getAssertionScorecard(): AssertionScorecard {
  const sources = Object.keys(SOURCE_LABELS);
  const rows: AssertionScoreRow[] = [];
  for (const source of sources) {
    const r = db
      .select()
      .from(schema.assertionSourceWeights)
      .where(eq(schema.assertionSourceWeights.source, source))
      .orderBy(desc(schema.assertionSourceWeights.asOf))
      .limit(1)
      .all()[0];
    if (!r) continue;
    // 库里的 edge / edge_lower 存的是小数（-0.0204 即 -2.04 个百分点），
    // 直接当百分点用会把 -2.04 显示成 -0.02，于是所有结论都变成「看不出差别」
    const edgePoints = r.edge == null ? null : r.edge * 100;
    const edgeLowerPoints = r.edgeLower == null ? null : r.edgeLower * 100;
    rows.push({
      source,
      label: SOURCE_LABELS[source],
      asOf: r.asOf,
      edgePoints,
      edgeLowerPoints,
      samples: r.samples,
      blocks: r.blocks,
      verdict: verdictOf({ edgeLower: edgeLowerPoints, samples: r.samples }),
    });
  }
  rows.sort((a, b) => (b.edgeLowerPoints ?? -99) - (a.edgeLowerPoints ?? -99));

  const latest = rows.map((r) => r.asOf).sort().pop() ?? null;
  const { staleDays, staleNote } = stalenessOf(latest, shanghaiToday(), disabledChainLabels());
  return {
    rows,
    computedAt: latest,
    weightsEnabled: weightsEnabled(),
    staleDays,
    staleNote,
    note:
      '判定方式：为每条真实价位造一条同样远近的随机价位，比较两者被触及后是否按判断掉头。' +
      '只看命中率会骗人——价格总会在某处反应，所以任何画在图上的线都能拿到接近五成的命中率。' +
      '结论用 95% 保守下界，不用点估计。',
  };
}

export { stalenessOf as __test__stalenessOf, STALE_DAYS_WARN as __test__STALE_DAYS_WARN };
