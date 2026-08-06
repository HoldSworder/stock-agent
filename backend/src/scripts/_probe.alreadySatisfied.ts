/**
 * 临时探针（用完即删，不是自检）：确认候选目录里「当下已成立」的条件
 * 真的被摘掉了 invalidation 用途，且摘完之后仍有失效条件可选。
 *
 * 只建目录、只打印，不落库、不调模型。
 */
import { ensureSchema } from '../db/migrate';
import { prepareContext } from '../symbolPlans/orchestrator';

ensureSchema();

const CODE = process.argv[2] ?? '159516';
const NAME = process.argv[3] ?? '半导体设备ETF国泰';

const ctx = await prepareContext({ code: CODE, name: NAME });
const conds = ctx.catalog.conditions;

console.log(`\n=== ${CODE} ${NAME} ===`);
console.log(`阶段 ${ctx.context.marketPhase} / 主动作 ${ctx.primaryAction} / 候选条件 ${conds.length} 条`);

const already = conds.filter((c) => c.alreadySatisfied);
console.log(`\n【当下已成立】${already.length} 条`);
for (const c of already) {
  console.log(`  - ${c.description}｜${c.timeframe}｜剩余用途 ${c.suitableFor.join('/') || '（无）'}`);
}

const stillInvalid = conds.filter((c) => c.suitableFor.includes('invalidation'));
console.log(`\n【仍可作失效条件】${stillInvalid.length} 条`);
for (const c of stillInvalid.slice(0, 12)) {
  console.log(`  - ${c.description}｜${c.timeframe}`);
}

// 关键判据：v4 就是栽在这条上的
const ma20Below = conds.find((c) => c.description.includes('跌破 MA20'));
console.log(
  `\n【v4 的失效条件「收盘跌破 MA20」】` +
    (ma20Below
      ? `已成立=${ma20Below.alreadySatisfied === true}，仍可作失效条件=${ma20Below.suitableFor.includes('invalidation')}`
      : '本次目录未产出该条件'),
);

console.log(`\n【目录 warnings】`);
for (const w of ctx.catalog.warnings) console.log(`  - ${w}`);

// RUN_REGEN=1 时真实跑一轮收盘重算，走与 cron 完全相同的代码路径（会真调模型）
if (process.env.RUN_REGEN === '1') {
  const { regenerateStalePlans } = await import('../symbolPlans/regenerate');
  console.log('\n=== 触发收盘重算（真实调用）===');
  const s = await regenerateStalePlans();
  console.log(`待重算 ${s.stale}，成功 ${s.regenerated}，失败 ${s.failed}，顺延 ${s.deferred}`);
}
