// 全A等权（880008）取数探针：大盘阶段收盘快照从未成功过，卡点就在这一路。
// 只打印，不断言、不写库。运行：cd backend && ./node_modules/.bin/tsx src/scripts/regimeEqualWeight.probe.ts
import { getAllAEqualWeight } from '../regime/client';

async function main(): Promise<void> {
  try {
    const s = await getAllAEqualWeight(260);
    console.log(`取到 ${s.bars.length} 根日线，上涨 ${s.upCount} / 下跌 ${s.downCount}`);
    console.log('最后三根收盘：', s.bars.slice(-3).map((b) => b.close).join(' | '));
    // 服务层要求 >= 61 根才算可用（要算 MA60），少于这个数同样会回退代理
    console.log(s.bars.length >= 61 ? '✅ 根数够，可用于 MA60' : '❌ 根数不足 61，服务层会回退代理');
  } catch (e) {
    console.log('❌ 取数失败：', e instanceof Error ? e.message : String(e));
  }
}

void main();
