// 指数资金流实网取数核查（会真的打东财，不写库）。
//
// 存在的理由：新加的沪深300 / 上证50 / 中证A500 能不能取到当日资金流，
// 光看代码看不出来——东财对不同指数的支持并不一致，而取不到的指数会安静地
// 留一段空序列，页面上只是少一行，不会有任何报错提示。
//
// 顺带报出每个指数拿回几行：如果哪天历史源恢复了，这里会从 1 行变成 60 行，
// 快照任务会自动把整段补进库，不需要改代码。
//
// 运行：cd backend && pnpm exec tsx src/scripts/indexFlow.livecheck.ts
import { fetchIndexFlows } from '../market/eastmoney';
import { INDEX_FLOW_DEFS, GROUP_LABEL } from '../indexflow/defs';

const results = await fetchIndexFlows(INDEX_FLOW_DEFS.map((d) => d.secid));
let ok = 0;
for (const def of INDEX_FLOW_DEFS) {
  const r = results.find((x) => x.secid === def.secid)!;
  const last = r.rows[r.rows.length - 1];
  const group = def.group ? GROUP_LABEL[def.group] : '不分组';
  if (last) {
    ok += 1;
    console.log(
      `✅ ${def.name.padEnd(8)} ${group.padEnd(5)} ${r.rows.length} 行  最新 ${last.date} ` +
        `主力 ${last.main >= 0 ? '+' : ''}${last.main.toFixed(1)}亿  来源 ${r.host}`,
    );
  } else {
    console.log(`❌ ${def.name.padEnd(8)} ${group.padEnd(5)} 取不到数据（这个指数会在面板上缺席）`);
  }
}
const maxRows = Math.max(...results.map((r) => r.rows.length), 0);
console.log(`\n${ok}/${INDEX_FLOW_DEFS.length} 个指数可取数，单指数最多拿到 ${maxRows} 行。`);
console.log(
  maxRows > 1
    ? '历史源可用，快照任务会把整段回填入库。'
    : '只有当日一行（历史源在本网络不可达），历史将从今天起逐日累积。',
);
