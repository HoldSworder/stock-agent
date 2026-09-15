// 探测「缺数不参与排名」这条规则在真实市场数据上剔掉多少只。
//
// 不是自检（不带断言、要联网），只是用来回答一个必须用真实数据才能回答的问题：
// 这条规则会不会把榜单剔空？会不会一只都剔不掉（说明规则没在起作用）？
//
// 跑法：./node_modules/.bin/tsx src/scripts/screenerMissing.probe.ts

import { fetchMarketSnapshot } from '../screener/snapshot';
import { scoreCandidates, buildThemeContext } from '../screener/scorer';
import { activeFactors, listStrategyDefs } from '../screener/strategy';
import { hardFilter } from '../screener/filter';

const rows = await fetchMarketSnapshot();
console.log(`全市场快照 ${rows.length} 只`);
console.log(
  `其中涨跌幅取不到 ${rows.filter((r) => r.pct == null).length} 只，` +
    `成交额取不到 ${rows.filter((r) => r.amount == null).length} 只，` +
    `换手率取不到 ${rows.filter((r) => r.turnoverRate == null).length} 只，` +
    `市值取不到 ${rows.filter((r) => r.marketCap == null).length} 只，` +
    `行业取不到 ${rows.filter((r) => !r.industry).length} 只`,
);

const theme = await buildThemeContext('缺数探测');
for (const def of listStrategyDefs()) {
  const filtered = hardFilter(rows, def.hardFilters, 'full');
  const scored = scoreCandidates(filtered, def, theme);

  // 只看第一遍打分的缺数情况没有意义：trend / fundFlow / midTrend / dragonRank
  // 要等二段增强才注入，此刻必然全空。所以这里把二段因子排除后再看，
  // 反映的才是「快照本身缺不缺数」。二段因子取数成不成功由 enrich 自己的日志看。
  const second = new Set(['trend', 'fundFlow', 'midTrend', 'dragonRank']);
  const snapshotMissing = scored.filter((c) =>
    c.missingFactors.some((k) => !second.has(k)),
  );
  const needsEnrich = activeFactors(def).filter((k) => second.has(k));

  const eg = snapshotMissing
    .slice(0, 2)
    .map((d) => `${d.row.name} 缺[${d.missingFactors.filter((k) => !second.has(k)).join(',')}]`)
    .join('；');
  console.log(
    `${def.name}：硬筛后 ${filtered.length} 只，快照缺数 ${snapshotMissing.length} 只` +
      (eg ? `（例：${eg}）` : '') +
      (needsEnrich.length ? `｜依赖二段因子：${needsEnrich.join(',')}` : ''),
  );
}
