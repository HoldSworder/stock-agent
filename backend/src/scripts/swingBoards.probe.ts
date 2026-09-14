// 板块行情**在线**可用性探针：波段模块要横向扫全行业板块，必须先确认板块 K 线取不取得到。
//
// 为什么单独探这一件事：计划原本把「板块指数优先、ETF 仅作替代」写成前置条件，
// 而仓库里 eastmoney.buildKlineSecid 虽已支持 BKxxxx（90 前缀），
// 却没有任何现存调用方真的用它拉过板块 K 线——这条路径从未被验证过。
//
// 2026-09-04 首次实测结论（判据见下，探针会自己复核）：
//  - 东财 push2（实时）200 通，push2his（历史 K 线）不通 → getKlineEastmoney 对**任何**标的都失败
//  - aktools 板块清单 200 可用（含最新价/涨跌幅），板块历史 K 线 stock_board_industry_hist_em 返回 500
//  - ETF / 个股走 datasource/scheduler 的多源 failover 完全可用（日线与 60m 各 260 根）
//  → 板块指数历史 K 线在本环境取不到，板块信号只能用 ETF 代理，且须如实标注无 ETF 可代的板块
//
// 这里最容易犯的错（第一版就犯了）：直接拿板块 K 线失败率下结论。
// 那会把「整个历史行情源不通」误判成「板块路径不可靠」——两者的处置完全不同，
// 前者连 ETF 替代方案都得换源，后者只需改代理方式。所以必须先验基准标的，再验板块。
//
// 判据：
//  1) 基准 ETF 日线取不到 → FAIL 并立即停止（此时任何板块结论都不可信）
//  2) 板块清单取不到 → FAIL（连名单都没有，横向扫无从谈起）
//  3) 基准可用的前提下，板块日线可用率 < 80% → 判定板块指数路径不可用，输出「须走 ETF 代理」结论（不算 FAIL，这是已知事实的复核）
//  4) 若板块日线可用率回升到 >= 80% → 提示可以回退到板块指数直取，届时应重新评估设计
//
// 只读：只发行情 GET 与 aktools GET，不读写任何业务表。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/swingBoards.probe.ts [抽样数]
import type { BoardKind, KlinePeriod } from '@stock-agent/shared';
import { getKlineEastmoney } from '../market/eastmoney';
import { getKline } from '../datasource/scheduler';
import { fetchBoards, type BoardMeta } from '../breadth/data';

/** 抽样板块数：默认 8，够算可用率又不至于把数据源打爆 */
const SAMPLE = Number(process.argv[2] ?? 8);
/** 判定为「可用」所需的最少 K 线根数：区间与背驰都要 60 根以上才算得动 */
const MIN_BARS = 60;
/** 可用率达标线 */
const PASS_RATE = 0.8;
/** 基准标的：确认历史行情链路本身是活的，避免把源故障误判成板块问题 */
const BASELINE = ['159516', '512010'];

const line = (s: string): void => console.log(s);
let failed = 0;

/** 均匀抽样，避免只取前 N 个（东财清单前列按涨幅排序，不具代表性） */
function sample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

/** 基准检查：ETF 日线必须能取到，否则后续板块结论一律不可信 */
async function checkBaseline(): Promise<boolean> {
  let ok = 0;
  for (const code of BASELINE) {
    try {
      const bars = await getKline(code, 'day', 260);
      if (bars.length >= MIN_BARS) {
        ok += 1;
        line(`  ok 基准 ${code} 日线 ${bars.length} 根（末根 ${bars.at(-1)?.time ?? '—'}）`);
      } else {
        line(`  NG 基准 ${code} 日线仅 ${bars.length} 根`);
      }
    } catch (e) {
      line(`  NG 基准 ${code} 取数失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return ok === BASELINE.length;
}

/** 探一个板块一个周期：返回根数，失败返回 null */
async function probeBoard(code: string, period: KlinePeriod): Promise<number | null> {
  try {
    const bars = await getKlineEastmoney(code, period, 260);
    return bars.length;
  } catch {
    return null;
  }
}

async function probeKind(
  kind: BoardKind,
): Promise<{ total: number; day: number; listSize: number } | null> {
  const boards = await fetchBoards(kind).catch(() => [] as BoardMeta[]);
  if (boards.length === 0) {
    line(`FAIL [${kind}] 板块清单取不到（aktools 不通或该口径无数据）`);
    failed += 1;
    return null;
  }
  const picked = sample(boards, SAMPLE);
  line(`[${kind}] 清单 ${boards.length} 个板块，抽样 ${picked.length} 个探日线`);

  let day = 0;
  for (const b of picked) {
    const d = await probeBoard(b.code, 'day');
    const dOk = d != null && d >= MIN_BARS;
    if (dOk) day += 1;
    line(`  ${dOk ? 'ok' : 'NG'} ${b.name}(${b.code}) 日线 ${d ?? '取数失败'}`);
  }
  return { total: picked.length, day, listSize: boards.length };
}

async function main(): Promise<void> {
  line('=== 板块行情可用性探针 ===');
  line('');
  line('第一步 基准检查（历史行情链路是否活着）');
  const baseOk = await checkBaseline();
  line('');
  if (!baseOk) {
    line('FAIL 基准标的日线都取不到，历史行情链路本身有问题。');
    line('     此时任何板块结论都不可信，请先修数据源再跑本探针。');
    process.exit(1);
  }
  line('基准通过：历史行情链路正常，以下板块结论可信。');
  line('');

  line('第二步 板块指数直取');
  const results: Array<{ kind: BoardKind; day: number; total: number; listSize: number }> = [];
  for (const kind of ['industry', 'concept'] as BoardKind[]) {
    const r = await probeKind(kind);
    if (r) results.push({ kind, ...r });
    line('');
  }

  line('=== 结论 ===');
  const totalAll = results.reduce((s, r) => s + r.total, 0);
  const dayAll = results.reduce((s, r) => s + r.day, 0);
  const listAll = results.reduce((s, r) => s + r.listSize, 0);
  if (totalAll === 0) {
    line('无有效样本，无法定论');
  } else {
    const dr = dayAll / totalAll;
    line(`板块清单合计 ${listAll} 个；抽样日线可用率 ${(dayAll / totalAll) * 100}%（${dayAll}/${totalAll}）`);
    if (dr >= PASS_RATE) {
      line('→ 板块指数已可直取。这与 2026-09-04 的实测结论不同，说明数据源环境变了，');
      line('  应重新评估「板块信号只能用 ETF 代理」这个设计决定。');
    } else {
      line('→ 板块指数不可直取（与已知结论一致）：板块信号必须映射到可交易 ETF，');
      line('  并如实标注没有 ETF 可代的板块，不得静默漏掉。');
    }
  }

  line('');
  line(failed === 0 ? 'PASS 探针通过' : `FAIL ${failed} 项不达标`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
