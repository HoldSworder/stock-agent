// 探测两套前复权实现在真实数据上是否认定同样的除权点。
//
// 不是自检（不带断言、要联网），要回答的问题是：
// 回测链路与实盘链路算出来的历史价会不会不同？差得够不够大到让回测结论失效？
//
//   实盘链路：datasource/adjust.ts 的 frontAdjustDaily
//     判据 = 开盘价对前收向下跳空，阈值按板别 12%~33%，只修向下
//   回测链路：modes/factors.ts 的 adjustSplits
//     判据 = 收盘价比值 < 0.65 或 > 1.5，双向
//
// 测法：把 adjustSplits 跑在**已经被 frontAdjustDaily 修过**的数据上。
// 若两套认定的除权点一致，实盘链路已经把跳空抹平了，adjustSplits 应当一动不动。
// 它一旦还改了什么，就说明它认为那里有个除权点而实盘链路没认——两套口径分歧。
//
// 跑法：./node_modules/.bin/tsx src/scripts/adjustDivergence.probe.ts

import { getKline } from '../datasource/scheduler';
import { adjustSplits } from '../modes/factors';
import { listPool } from '../etf/repo';

const pool = listPool().slice(0, 20);
console.log(
  `取 ${pool.length} 只 ETF 的 500 根日 K（已由实盘链路前复权），` +
    `再用回测链路的算法跑一遍，看它还改不改\n`,
);

const rows: Array<{ name: string; code: string; maxDiffPct: number; bars: number }> = [];

for (const t of pool) {
  let ks;
  try {
    ks = await getKline(t.code, 'day', 500);
  } catch (e) {
    console.log(`  ${t.name}(${t.code}) 取数失败：${(e as Error).message.slice(0, 60)}`);
    continue;
  }
  if (ks.length < 100) continue;

  const before = ks.map((b) => b.close);
  const after = adjustSplits(
    ks.map((b) => ({
      d: b.time,
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      v: b.volume,
      amt: b.amount ?? b.close * b.volume,
    })),
  );

  let maxDiffPct = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const a = before[i];
    const b = after[i].c;
    if (!(a > 0) || !(b > 0)) continue;
    const d = (Math.abs(a - b) / a) * 100;
    if (d > maxDiffPct) maxDiffPct = d;
  }
  rows.push({ name: t.name, code: t.code, maxDiffPct, bars: before.length });
}

rows.sort((a, b) => b.maxDiffPct - a.maxDiffPct);
for (const r of rows) {
  const tag = r.maxDiffPct > 1 ? ' ← 分歧够大' : r.maxDiffPct > 0.01 ? ' ← 有分歧' : '';
  console.log(
    `  ${r.name}(${r.code}) ${r.bars} 根，回测算法还想改动 ${r.maxDiffPct.toFixed(3)}%${tag}`,
  );
}

const diffCount = rows.filter((r) => r.maxDiffPct > 0.01).length;
console.log(
  `\n结论：${rows.length} 只里有 ${diffCount} 只两套口径认定的除权点不同` +
    (diffCount === 0
      ? '——当前池子里两套实际重合，分歧是潜在风险而非现存错误'
      : `，最大分歧 ${rows[0].maxDiffPct.toFixed(2)}%。回测用一套、实盘用另一套，结论不必然互通`),
);
