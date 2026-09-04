// 时间断言的**方向**命中率回算。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/timeDirection.livecheck.ts
//
// 立项理由：judgeTime 判「说准了」的条件是窗口内出现**任何一个**确认转折，
// 它不看那个转折是高点还是低点（见 judge.ts 的 inWindow，只比时间不比 kind）。
// 于是账本里 46%/57% 这些数字说的是「那几天附近确实拐了个弯」，不含方向信息。
// 而界面一度据此给出「预期见低点 → 留意止跌企稳再接」这种方向性建议，等于
// 拿一个非方向性的统计去背书方向性的操作。
//
// 本脚本**只读**：不改判定、不重算结局、不写库。用历史 K 线把当时窗口内实际出现的
// 转折是高是低找出来，与冻结时记下的 direction 比对，直接回算方向命中率。
// 这样既拿到了答案，又不违反「判定参数随记录冻结、不追溯改写历史成绩」的纪律。

import { eq } from 'drizzle-orm';
import { ASSERTION_TOLERANCE_BARS, type KlineBar, type KlinePeriod } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { isDeadTimeAssertion } from '../assertions/extract';
import { fetchSeries } from '../assertions/service';
import { detectSwings } from '../symbolPlans/structure';
import { wilsonLowerBound } from '../strategy/promotionGate';

/** 预测方向 → 预期转折类型：向上推进的浪走完即见高，向下走完即见低 */
function expectedKind(direction: string | null): 'high' | 'low' | null {
  if (direction === 'up') return 'high';
  if (direction === 'down') return 'low';
  return null;
}

/**
 * 复刻 judgeTime 的取窗方式，逐字对齐才有可比性。
 * 与它唯一的差别是：这里把命中的 swing 的 kind 也带出来。
 */
function swingsInWindow(
  bars: KlineBar[],
  period: KlinePeriod,
  windowFrom: string,
  windowTo: string,
  toleranceBars: number,
): Array<'high' | 'low'> {
  const idxOf = (date: string): number => bars.findIndex((b) => b.time.slice(0, 10) >= date);
  const fromIdx = idxOf(windowFrom);
  const toIdx = idxOf(windowTo);
  if (fromIdx < 0 || toIdx < 0) return [];
  const lo = Math.max(0, fromIdx - Math.max(0, toleranceBars));
  const hi = Math.min(bars.length - 1, toIdx + Math.max(0, toleranceBars));
  const loTime = bars[lo].time.slice(0, 10);
  const hiTime = bars[hi].time.slice(0, 10);
  return detectSwings(bars, period)
    .filter((s) => s.confirmed)
    .filter((s) => {
      const t = s.time.slice(0, 10);
      return t >= loTime && t <= hiTime;
    })
    .map((s) => s.kind);
}

/** 冻结当日那根不算，与 judge.barsAfter 同口径 */
function barsAfter(bars: KlineBar[], asOf: string): KlineBar[] {
  return bars.filter((b) => b.time.slice(0, 10) > asOf);
}

function rateText(hit: number, n: number): string {
  if (n === 0) return '无样本';
  const lo = wilsonLowerBound(hit, n);
  return `${hit}/${n} = ${((hit / n) * 100).toFixed(0)}%（95% 下界 ${lo == null ? '—' : (lo * 100).toFixed(0)}%）`;
}

async function main(): Promise<void> {
  const rows = db
    .select()
    .from(schema.symbolAssertions)
    .where(eq(schema.symbolAssertions.kind, 'time'))
    .all()
    .filter(
      (r) =>
        (r.outcome === 'respected' || r.outcome === 'violated') &&
        r.windowFrom != null &&
        r.windowTo != null &&
        !isDeadTimeAssertion(r.evidenceRef),
    );

  console.log(`已判定的时间断言（剔除停产的 161.8% 档）：${rows.length} 条`);

  // 每只标的只取一次线：逐条取会把几十条变成几十次回源
  const seriesOf = new Map<string, KlineBar[]>();
  for (const r of rows) {
    const key = `${r.code}|${r.secid ?? ''}`;
    if (seriesOf.has(key)) continue;
    const { bars } = await fetchSeries(r.code, r.secid);
    seriesOf.set(key, bars);
  }

  let touched = 0; // 窗口内出现了转折（= judgeTime 判 respected 的口径）
  let dirHit = 0; // 且方向对
  let dirMiss = 0; // 出现了但方向反了
  let ambiguous = 0; // 窗口内高低都有，说不清
  let noDirection = 0; // 记录时就没写方向
  const byCode = new Map<string, { hit: number; n: number }>();
  /**
   * 事件级去重容器：同一标的、同一周期、对同一天的预测，连着记多少天都只算一次。
   *
   * 不去重的话证据量会被夸大两倍多（实测 141 条记录只对应 55 个独立预测），
   * 而且重复次数与「连续几天没改口」正相关，等于让强信号在统计里自己给自己加权。
   */
  const events = new Map<string, { ok: boolean; actual: 'high' | 'low' }>();

  for (const r of rows) {
    const all = seriesOf.get(`${r.code}|${r.secid ?? ''}`) ?? [];
    if (all.length === 0) continue;
    const bars = barsAfter(all, r.asOf);
    if (bars.length === 0) continue;
    const kinds = swingsInWindow(
      bars,
      r.period as KlinePeriod,
      r.windowFrom!,
      r.windowTo!,
      r.toleranceBars ?? ASSERTION_TOLERANCE_BARS,
    );
    if (kinds.length === 0) continue;
    touched += 1;
    const want = expectedKind(r.direction);
    if (want == null) {
      noDirection += 1;
      continue;
    }
    const hasHigh = kinds.includes('high');
    const hasLow = kinds.includes('low');
    // 窗口内高低都出现过就判不了方向：说它对或错都是挑对自己有利的那个
    if (hasHigh && hasLow) {
      ambiguous += 1;
      continue;
    }
    const ok = want === 'high' ? hasHigh : hasLow;
    if (ok) dirHit += 1;
    else dirMiss += 1;
    const b = byCode.get(r.code) ?? { hit: 0, n: 0 };
    b.n += 1;
    if (ok) b.hit += 1;
    byCode.set(r.code, b);
    events.set(`${r.code}|${r.period}|${r.windowFrom}`, {
      ok,
      actual: hasHigh ? 'high' : 'low',
    });
  }

  const judged = dirHit + dirMiss;
  console.log(`\n窗口内确实出现转折的：${touched} 条（这就是 judgeTime 判 respected 的口径）`);
  console.log(`  其中高低同现、判不了方向：${ambiguous} 条`);
  console.log(`  其中冻结时没记方向：${noDirection} 条`);
  console.log(`\n=== 方向命中率（本脚本新增的口径）===`);
  console.log(`  ${rateText(dirHit, judged)}`);
  console.log(`  方向对 ${dirHit} 条，方向反了 ${dirMiss} 条`);

  if (judged > 0) {
    console.log('\n按标的：');
    for (const [code, b] of [...byCode].sort((a, b2) => b2[1].n - a[1].n)) {
      console.log(`  ${code}  ${rateText(b.hit, b.n)}`);
    }
  }

  /**
   * 与基线对照——这一步不能省。
   *
   * 曾经只看「预测见高时命中 63%」就以为方向可用，其实同期实际出现的转折里本来就有
   * 66% 是高点：无脑全说见高就能拿 66%，系统反而更低。没有基线的准确率什么都说明不了。
   *
   * 基线取「永远猜多数类」。它是**事后基线**（多数类看完样本才知道），
   * 所以只能用来否定、不能用来肯定：跑不赢一定没用，跑赢了也还要留出期验证。
   */
  const ev = [...events.values()];
  const evHit = ev.filter((x) => x.ok).length;
  const actualHigh = ev.filter((x) => x.actual === 'high').length;
  const actualLow = ev.length - actualHigh;
  const majority = Math.max(actualHigh, actualLow);
  console.log('\n=== 事件级（同一预测连记多天只算一次）===');
  console.log(`  系统方向命中  ${rateText(evHit, ev.length)}`);
  console.log(
    `  无脑全说${actualHigh >= actualLow ? '见高' : '见低'}  ${rateText(majority, ev.length)}  ← 基线`,
  );
  console.log(`  实际出现：见高 ${actualHigh} 次、见低 ${actualLow} 次`);
  console.log(
    ev.length > 0 && evHit > majority
      ? '  ✓ 跑赢基线。但这是事后基线，正式采信仍需未来留出期验证'
      : '  ✗ 未跑赢基线：当前样本下方向判断没有体现出增量信息',
  );

  console.log(
    '\n读法：这个数字回答的是「说会转折的那几天，转的方向也说对了吗」。\n' +
      '必须与基线比，不能只看绝对值——同期实际转折的高低比例本身就不是五五开。\n' +
      '跑不赢基线时，界面不得给「见低点→接回 / 见高点→减仓」这类方向性建议。',
  );
}

void main();
