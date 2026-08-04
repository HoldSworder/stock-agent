// 各 K 线数据源的 volume 单位**在线** capability 探针：有硬判据、会以退出码 1 失败。
//
// 与 klineVolumeUnit.selfcheck 的分工：自检用固定 fixture 钉住「我们的解析层换算对不对」（离线、进常规自检）；
// 本探针钉住「数据源今天实际给的还是不是原来那个单位」——这是 fixture 永远测不到的一类失效，
// 尤其腾讯/新浪日线不返回成交额，本源内部无法自证，只能跨源对账。
//
// 判据（不再靠人读打印）：
//  1) 本源自带成交额 → 用「成交额 ÷ 均价 ÷ volume」反推，必须落在「手」档（30~300）；落在 0.3~3 说明本源
//     改口径给「股」而我们没归一，判 FAIL。
//  2) 本源无成交额 → 拿有成交额的参照源同一交易日的 volume 对账，比值须在 0.2~5；接近 100 或 0.01 判 FAIL。
//     带宽刻意放宽：单位错误是 100 倍量级，收窄反会误伤「一源对份额折算复权了量、另一源没复权」（1:2 折算比值恰为 2）。
//  3) 取数失败 / 该源不支持该周期 / 无参照 → SKIP（打印原因，不判失败），避免探针变成网络抖动报警器。
//
// 两条踩过的坑，改这个脚本时别踩回去：
//  1) 必须用**已结算的历史行**判定。当日未收盘那根的口径与结算后不一致，
//     2026-08-04 盘后就是因为拿末根判定，把 mootdx 的「手」误判成「股」。
//  2) 优先用该源自己返回的 amount 做参照；跨源对账要对齐到同一交易日，别拿实时报价对历史行。
//
// 只读：只发行情 GET，不读写任何业务表、不下单。
// （注：provider 经 market/eastmoney → datasource/scheduler → db/client 传递性 import，
//   模块加载时会打开 sqlite 连接并建 -wal 文件，但本脚本不碰任何业务表。）
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/klineVolumeUnit.probe.ts [code]
import type { KlineBar, KlinePeriod } from '@stock-agent/shared';
import { getKlineEastmoney } from '../market/eastmoney';
import { getKlineTencent } from '../market/tencent';
import { getKlineSina } from '../market/sina';
import { getKlineAstock } from '../astock/market';

const code = process.argv[2] ?? '159516';
/** 日线与分钟线都要探：/100 归一对分钟周期同样生效，且 mootdx 是分钟链首选源 */
const PERIODS: KlinePeriod[] = ['day', '30m'];

const PROVIDERS: Array<{ id: string; fn: (c: string, p: KlinePeriod) => Promise<KlineBar[]> }> = [
  { id: 'tencent', fn: (c, p) => getKlineTencent(c, p, 60) },
  { id: 'eastmoney', fn: (c, p) => getKlineEastmoney(c, p, 60) },
  { id: 'sina', fn: (c, p) => getKlineSina(c, p, 60) },
  { id: 'astockdata', fn: (c, p) => getKlineAstock(c, p, 60) },
];

let failed = 0;
const line = (s: string): void => console.log(s);

/** 反推「成交额 ÷ 均价 ÷ volume」：≈1 说明 volume 是股，≈100 说明是手 */
function unitRatio(bar: KlineBar): number | null {
  const avg = (bar.high + bar.low + bar.close) / 3;
  if (!(avg > 0) || !(bar.volume > 0) || !(bar.amount > 0)) return null;
  return bar.amount / avg / bar.volume;
}

/** 已结算的历史行（去掉可能未收完的末根），最多取最近 5 根 */
function settledTail(bars: KlineBar[]): KlineBar[] {
  return bars.slice(0, -1).slice(-5);
}

function judgeSelfConsistent(id: string, period: KlinePeriod, bars: KlineBar[]): boolean | null {
  const ratios = settledTail(bars)
    .map(unitRatio)
    .filter((r): r is number => r != null);
  if (ratios.length === 0) return null; // 本源无成交额，交给跨源对账
  const min = Math.min(...ratios);
  const max = Math.max(...ratios);
  const inLot = min > 30 && max < 300;
  const inShare = min > 0.3 && max < 3;
  line(
    `${inLot ? 'PASS' : 'FAIL'} ${id}/${period} 自带成交额，${ratios.length} 根反推比值 ${min.toFixed(2)}~${max.toFixed(2)}` +
      `　→ ${inLot ? '「手」，符合 KlineBar.volume 口径' : inShare ? '「股」：本源改口径了，解析层需补 /SHARES_PER_LOT' : '两档之外，需人工复核价格/成交额字段'}`,
  );
  return inLot;
}

function judgeCrossSource(
  id: string,
  period: KlinePeriod,
  bars: KlineBar[],
  ref: { id: string; byTime: Map<string, number> } | null,
): boolean | null {
  if (!ref) {
    line(`SKIP ${id}/${period} 本源无成交额，且本轮无可用参照源，无法对账`);
    return null;
  }
  for (const b of settledTail(bars).reverse()) {
    const refVol = ref.byTime.get(b.time);
    if (!refVol || !(b.volume > 0)) continue;
    const r = b.volume / refVol;
    // 带宽放到 0.2~5：单位错误是 100 倍量级，放宽不影响灵敏度；
    // 收窄反而会误伤「一源对份额折算复权了成交量、另一源没复权」——1:2 折算的比值恰好是 2.0
    const ok = r > 0.2 && r < 5;
    line(
      `${ok ? 'PASS' : 'FAIL'} ${id}/${period} 本源无成交额，用 ${ref.id} 同日(${b.time})对账：` +
        `${b.volume} vs ${refVol}，比值 ${r.toFixed(3)}` +
        `　→ ${ok ? '同为「手」' : r > 10 ? '本源疑似给「股」未归一（约 100 倍）' : r < 0.1 ? '本源疑似被多除了一次 100' : '量级不符，需人工复核'}`,
    );
    return ok;
  }
  line(`SKIP ${id}/${period} 本源无成交额，与 ${ref.id} 无重叠交易日可对账`);
  return null;
}

async function probePeriod(period: KlinePeriod): Promise<void> {
  line(`\n===== ${code} ${period} =====`);
  const fetched = new Map<string, KlineBar[]>();
  for (const p of PROVIDERS) {
    try {
      const bars = await p.fn(code, period);
      if (bars.length === 0) line(`SKIP ${p.id}/${period} 无数据`);
      else fetched.set(p.id, bars);
    } catch (e) {
      line(`SKIP ${p.id}/${period} 取数失败 → ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 参照源：自带成交额且自证为「手」的那个源（优先 astockdata，它每根都带 amount）
  let ref: { id: string; byTime: Map<string, number> } | null = null;
  const withoutAmount: string[] = [];
  for (const [id, bars] of fetched) {
    const verdict = judgeSelfConsistent(id, period, bars);
    if (verdict === null) {
      withoutAmount.push(id);
      continue;
    }
    if (!verdict) failed += 1;
    else if (!ref) ref = { id, byTime: new Map(bars.map((b) => [b.time, b.volume])) };
  }
  for (const id of withoutAmount) {
    if (judgeCrossSource(id, period, fetched.get(id)!, ref) === false) failed += 1;
  }
}

async function main(): Promise<void> {
  for (const period of PERIODS) await probePeriod(period);
  line(failed === 0 ? '\n单位探针：无 FAIL' : `\n单位探针：${failed} 项 FAIL`);
  if (failed > 0) process.exitCode = 1;
}

void main();
