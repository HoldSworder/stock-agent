// 一键跑全部断言式自检。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/runSelfchecks.ts
//   或：pnpm check（仓库根）
//
// 为什么需要这个入口：src/scripts/ 下有五十多个自检，但此前只有 glossary 挂了 npm script，
// 其余都要手敲路径，CI 也不跑。于是「凡是产出价格、数量、方向的代码都要有检查钉着」
// 这条规矩，实际靠的是有人记得去跑——而记性正是这类约束最不该依赖的东西。
//
// 只收 *.selfcheck.ts：它们是断言式的，失败即非零退出，构成真正的保护。
// *.probe.ts 与 *.livecheck.ts 不收——前者只打印结果、不断言，后者依赖外部服务或
// 需要单独的库路径，放进来会让这条命令因环境问题常态变红，红得太容易就没人看了。
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const dir = import.meta.dirname;
/** 各自检自己写 .ts，得用 tsx 起子进程 */
const TSX = join(dir, '../../node_modules/.bin/tsx');

/**
 * 跳过清单：依赖外部服务或会写库的自检，放这里并写明原因。
 * 空着说明当前没有例外——加例外要写理由，不能默默跳过。
 */
const SKIP: Record<string, string> = {
  // 它真去连小红书取博主资料，Cookie 过期或平台风控就红。
  // 这是环境可用性核对，不是断言式保护，留在这条命令里会让它常态变红。
  // 要单独跑：./node_modules/.bin/tsx src/scripts/kol.selfcheck.ts
  'kol.selfcheck.ts': '需要可用的小红书 Cookie，属环境核对',
};

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.selfcheck.ts'))
  .sort();

const skipped: string[] = [];
const passed: string[] = [];
const failed: Array<{ name: string; output: string }> = [];

for (const f of files) {
  const name = f.replace('.selfcheck.ts', '');
  if (SKIP[f]) {
    skipped.push(`${name}（${SKIP[f]}）`);
    continue;
  }
  // 必须用 tsx 而不是 process.execPath：裸 node 不认 .ts，
  // 会把每个自检都报成「未知文件扩展名」，看起来像全军覆没，实际一个都没跑
  const r = spawnSync(TSX, [join(dir, f)], { encoding: 'utf8', env: process.env });
  if (r.status === 0) {
    passed.push(name);
  } else {
    failed.push({ name, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() });
  }
}

console.log(`\n通过 ${passed.length}／失败 ${failed.length}／跳过 ${skipped.length}`);
if (skipped.length) console.log(`跳过：${skipped.join('、')}`);

if (failed.length) {
  console.log('\n失败明细：');
  for (const f of failed) {
    console.log(`\n──── ${f.name} ────`);
    // 只留末尾若干行：断言失败的信息在最后，前面的成功日志没用
    console.log(f.output.split('\n').slice(-12).join('\n'));
  }
  process.exit(1);
}
console.log('全部断言式自检通过。');
