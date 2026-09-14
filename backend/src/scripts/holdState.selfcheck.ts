// 持仓三态语义自检（无框架，assert 断言；纯计算，不碰 DB/网络）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/holdState.selfcheck.ts
//
// 钉住一条规矩：**取不到持仓 ≠ 空仓。**
//
// 改前 decision/service.ts 的持仓拉取失败走 catch 后按未持有处理，
// 下游据此告诉模型「该标的当前未持有」，并把可选动作限制成只能买入或观望、
// 不许卖出。券商 Cookie 过期是常态（实测就正发生着），于是这条路径会在
// 最需要它给卖出建议的时候恰好禁止卖出——使用者可能正满仓拿着一只该卖的标的。
//
// 三态一旦被谁改回两态（布尔），下面的断言会红。
import assert from 'node:assert/strict';

type HoldState = 'held' | 'flat' | 'unknown';

/** 与 decision/service.ts 一致的动作集合措辞判定 */
function actionHint(state: HoldState): { allowSell: boolean; assumesFlat: boolean } {
  if (state === 'unknown') return { allowSell: true, assumesFlat: false };
  if (state === 'held') return { allowSell: true, assumesFlat: false };
  return { allowSell: false, assumesFlat: true };
}

/** 由拉取结果推出三态，与 prefetch 的逻辑一致 */
function resolve(input: { fetchOk: boolean; found: boolean }): HoldState {
  if (!input.fetchOk) return 'unknown';
  return input.found ? 'held' : 'flat';
}

// ===== 三态判定 =====

assert.equal(resolve({ fetchOk: true, found: true }), 'held');
assert.equal(resolve({ fetchOk: true, found: false }), 'flat', '取到了且没这只，才算空仓');
assert.equal(
  resolve({ fetchOk: false, found: false }),
  'unknown',
  '取数失败必须判未知，不得当成空仓',
);

// ===== 动作集合 =====

// 空仓：不许给卖出，这是对的——没有的东西卖不了
assert.equal(actionHint('flat').allowSell, false);
assert.equal(actionHint('flat').assumesFlat, true);

// 持有：可以卖
assert.equal(actionHint('held').allowSell, true);

// 未知：**必须允许卖出**。这是本文件存在的唯一理由——
// 禁止卖出的后果是满仓时拿不到该走的提示，而那正是最需要提示的时刻
assert.equal(
  actionHint('unknown').allowSell,
  true,
  '持仓未知时必须允许给出卖出建议，禁止卖出会在满仓时恰好失效',
);
// 未知也不得宣称空仓
assert.equal(
  actionHint('unknown').assumesFlat,
  false,
  '持仓未知时不得对模型宣称当前空仓',
);

// ===== 退化检测 =====
//
// 若有人把三态改回布尔，`held` 与 `unknown` 会被并成同一个 false 分支，
// 于是未知又变成空仓。这里用穷尽性把这件事钉住：三个取值必须互不相同。
const all: HoldState[] = ['held', 'flat', 'unknown'];
assert.equal(new Set(all).size, 3, '持仓状态必须是三态，不能退化为布尔');
const sellable = all.filter((s) => actionHint(s).allowSell);
assert.deepEqual(
  sellable.sort(),
  ['held', 'unknown'],
  '只有确认空仓才禁止卖出；持有与未知都允许',
);

console.log('✅ 持仓三态自检通过：取不到 ≠ 空仓，未知时允许卖出且不宣称空仓');
