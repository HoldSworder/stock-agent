// 赛道代表标的**在线**探针：核对 swing/universe.ts 的归并表在今天的真实清单上还成不成立。
//
// 为什么需要它：universe.ts 不写死 ETF 代码，而是从实时清单按流动性挑代表。
// 这带来一个新的失效模式——归并表跟不上市场变化时会**静默漏掉赛道**：
// 新发的 ETF 用了没见过的赛道名（未归类）、或某赛道整体冷到没有标的达标（覆盖缺口）。
// 这两种情况在页面上都表现为「这个赛道没信号」，与「真的没信号」无法区分，所以要主动探。
//
// 判据：
//  1) ETF 清单取不到 → FAIL
//  2) 未归类且成交额 >= 1 亿的标的存在 → FAIL（这么大的量说明是主流赛道，归并表漏了）
//  3) 覆盖缺口只打印不判失败——赛道冷下去是市场常态，不是代码缺陷
//
// 只读，不写任何业务表。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/etfUniverse.probe.ts
import {
  MIN_AMOUNT,
  MIN_FLOAT_CAP,
  fetchEtfSpot,
  pickRepresentatives,
} from '../swing/universe';

/** 未归类标的的成交额告警线：超过这个量还没归类，说明归并表漏了主流赛道 */
const UNMATCHED_ALERT_AMOUNT = 100_000_000;

const line = (s: string): void => console.log(s);

async function main(): Promise<void> {
  let failed = 0;
  line('=== 赛道代表标的探针 ===');
  line(
    `门槛：日成交额 >= ${(MIN_AMOUNT / 1e8).toFixed(1)} 亿且流通市值 >= ${(MIN_FLOAT_CAP / 1e8).toFixed(0)} 亿`,
  );
  line('');

  let rows;
  try {
    rows = await fetchEtfSpot();
  } catch (e) {
    line(`FAIL ETF 清单取不到：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  line(`全市场 ETF ${rows.length} 只`);

  const { representatives, gaps, unmatched } = pickRepresentatives(rows);
  line(`归入 ${representatives.length} 个赛道；未归类 ${unmatched.length} 只；覆盖缺口 ${gaps.length} 个`);
  line('');

  line('=== 各赛道代表（同赛道取成交额最大者）===');
  for (const r of representatives) {
    line(
      `${r.category.padEnd(9)} ${r.track.padEnd(14)} ${r.code} ${r.name.padEnd(22)} ` +
        `${(r.amount / 1e8).toFixed(2).padStart(6)}亿  （同赛道 ${r.peerCount} 只）`,
    );
  }

  if (unmatched.length > 0) {
    line('');
    line('=== 未归类 ===');
    for (const r of unmatched) {
      const big = r.amount >= UNMATCHED_ALERT_AMOUNT;
      if (big) failed += 1;
      line(
        `  ${big ? 'FAIL' : 'note'} ${r.code} ${r.name.padEnd(24)} 赛道名「${r.rawTrack}」 ${(r.amount / 1e8).toFixed(2)}亿`,
      );
    }
    if (failed > 0) line(`  ↑ 标 FAIL 的成交额 >= ${UNMATCHED_ALERT_AMOUNT / 1e8} 亿，须补进 TRACK_MERGE`);
  }

  if (gaps.length > 0) {
    line('');
    line('=== 覆盖缺口（页面须如实标注，不得显示成「无信号」）===');
    for (const g of gaps) {
      line(`  ${g.track.padEnd(14)} ${g.reason}`);
    }
  }

  line('');
  line(failed === 0 ? 'PASS 探针通过' : `FAIL ${failed} 个主流赛道未归类`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
