// 背驰检测**在线**回归：拿真实行情核对，重点是 2026-08-18 半导体那次回调预警。
//
// 这条不是「规则成立的证明」，只是回归案例——单个案例对不上说明规则抓不住目标现象，
// 但对上了也不等于规则有效（那要靠阶段二的前向验收）。这个区别很重要，别把它当胜率。
//
// 未来数据防护：所有 K 线按 asOf 截断，只喂当天及之前的根。
// 不截断的话拿最新 260 根去检查 8 月 18 日，等于让规则偷看之后的走势——
// 那样任何规则都能「预测」得很准。
//
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/swingDivergence.livecheck.ts [asOf]
import type { KlineBar, KlinePeriod } from '@stock-agent/shared';
import { getKline } from '../datasource/scheduler';
import { buildSegments, detectDivergence } from '../swing/divergence';

/** 默认核对日：使用者反馈「近期半导体即将开始回调」的那天 */
const DEFAULT_AS_OF = '2026-08-18';

/** 半导体相关标的：使用者持仓的与赛道代表的都看 */
const CASES: ReadonlyArray<{ code: string; name: string }> = [
  { code: '159516', name: '半导体设备ETF' },
  { code: '512760', name: '芯片ETF' },
  { code: '588200', name: '科创芯片ETF' },
  { code: '588170', name: '科创半导体ETF' },
];

const asOf = process.argv[2] ?? DEFAULT_AS_OF;
const line = (s: string): void => console.log(s);

/** 按 asOf 截断：只保留当天及之前收盘的 K 线 */
function truncate(bars: KlineBar[], cutoff: string): KlineBar[] {
  return bars.filter((b) => b.time.slice(0, 10) <= cutoff);
}

async function probe(code: string, name: string, period: KlinePeriod): Promise<void> {
  let bars: KlineBar[];
  try {
    bars = await getKline(code, period, 400);
  } catch (e) {
    line(`  ${period.padEnd(4)} 取数失败：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const cut = truncate(bars, asOf);
  if (cut.length < 60) {
    line(`  ${period.padEnd(4)} 截断到 ${asOf} 后仅 ${cut.length} 根，样本不足`);
    return;
  }
  const segs = buildSegments(cut, period);
  const div = detectDivergence(cut, period);
  const last = cut[cut.length - 1];
  line(
    `  ${period.padEnd(4)} 截断 ${cut.length} 根（末根 ${last.time} 收 ${last.close}）` +
      `｜有效段 ${segs.length}｜结论 ${div.kind ?? '无背驰'}` +
      `${div.kind ? (div.confirmed ? '（已走完的段）' : '（当前还在走的段，提前提示）') : ''}` +
      `${div.strength != null ? `（强度 ${(div.strength * 100).toFixed(0)}%，面积比 ${((div.areaRatio ?? 0) * 100).toFixed(0)}%）` : ''}`,
  );
  for (const r of div.rationale) line(`        依据：${r}`);
  for (const c of div.counterEvidence) line(`        反证：${c}`);
}

/** 回调是否真的发生了：看 asOf 之后 30 个交易日的最大回撤 */
async function whatHappened(code: string, name: string): Promise<void> {
  try {
    const bars = await getKline(code, 'day', 400);
    const idx = bars.findIndex((b) => b.time.slice(0, 10) > asOf);
    if (idx < 0) {
      line(`  事后：${asOf} 之后暂无数据`);
      return;
    }
    const after = bars.slice(idx, idx + 30);
    if (after.length === 0) return;
    const base = bars[idx - 1]?.close ?? after[0].open;
    const lowest = Math.min(...after.map((b) => b.low));
    const highest = Math.max(...after.map((b) => b.high));
    line(
      `  事后：之后 ${after.length} 个交易日，最低 ${lowest.toFixed(3)}` +
        `（相对 ${base.toFixed(3)} 为 ${(((lowest - base) / base) * 100).toFixed(1)}%）、` +
        `最高 ${highest.toFixed(3)}（${(((highest - base) / base) * 100).toFixed(1)}%）`,
    );
  } catch {
    line('  事后：取数失败');
  }
}

async function main(): Promise<void> {
  line('=== 背驰在线回归 ===');
  line(`核对日 ${asOf}（K 线按此截断，不喂之后的数据）`);
  line('');
  for (const c of CASES) {
    line(`${c.name}（${c.code}）`);
    for (const p of ['day', '60m'] as KlinePeriod[]) {
      await probe(c.code, c.name, p);
    }
    await whatHappened(c.code, c.name);
    line('');
  }
  line('注：单个案例只用于回归，不构成规则有效的证据。');
}

void main();
