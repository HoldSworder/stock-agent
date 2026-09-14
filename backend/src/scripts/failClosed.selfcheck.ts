// 「取不到数据就判不了」这条共用规矩的自检（无框架，assert 断言；纯计算）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/failClosed.selfcheck.ts
//
// 这条规矩是从五个同类缺陷里收口出来的。它们的形状完全一样：
// **取不到数据时，用一个「看起来正常」的值继续往下走**，于是产出一条基于错数据的
// 精确动作，而界面上什么异常都看不出来。
//
//   1. 行情取不到 → 现价按 0 元 → 禁追高护栏按 0% 涨幅判断从而失效；
//      硬止损拿昨收比较从而该卖不卖
//   2. 已建层号解析失败 → 当成空仓 → 已持仓的标的照样触发建仓，重复买入
//   3. 量价确认取不到 → 该扣的分归零 → 确定性分虚高过门槛 → 发出建仓与仓位
//   4. 单标的评估抛错 → 只打一行日志 → 那只的卖点/止损/买点全部静默跳过
//   5. 卖点复核失败 → 填 hold → 概览写「持有」、头部写「整体可持有观察」
//
// 规矩：**判不了就明确判不了，并且让它可见。** 宁可少一条提示，
// 不可给一条基于错数据的提示——后者会让人以为系统看过了。
//
// 今天之前已经在 decision（持仓三态）和 plan（持仓未知不当空仓）上各修过一次
// 同样的问题，这是第三次，所以收口成一条带检查的规矩而不是继续逐个打补丁。
import assert from 'node:assert/strict';

// ===== 1. 行情取不到：跳过该标的，不用 0 元或昨收顶上 =====

type Quote = { code: string; price: number; pct: number } | undefined;

/** 与 etfwatch/engine.ts tick 里一致的判定 */
const judgeable = (q: Quote): boolean => !!q && q.price > 0;

assert.equal(judgeable(undefined), false, '完全没取到行情，不可判');
assert.equal(judgeable({ code: 'x', price: 0, pct: 0 }), false, '现价 0 是取数失败的表现，不可判');
assert.equal(judgeable({ code: 'x', price: -1, pct: 0 }), false, '负价不可判');
assert.equal(judgeable({ code: 'x', price: 1.234, pct: -2 }), true, '有正现价才可判');

// 反例说明为什么不能用 0 顶上：禁追高护栏看的是涨幅，
// 取不到时若按 pct=0 处理，等于宣称「今天没涨」，护栏必然放行
const chaseGuardPct = 7;
const wouldPassGuard = (pct: number): boolean => pct < chaseGuardPct;
assert.equal(wouldPassGuard(0), true, '按 0% 涨幅判断，禁追高护栏一定放行——这就是缺陷');
assert.equal(wouldPassGuard(9), false, '真实涨幅 9% 时护栏应拦住');

// ===== 2. 已建层号解析失败：抛错交上层处理，不当空仓 =====

/** 与 etfwatch/store.ts rowToState 里一致的解析 */
function parseHeldLayers(raw: string): number[] {
  const arr = JSON.parse(raw) as number[];
  if (!Array.isArray(arr)) throw new Error('层号不是数组');
  return arr.filter((n) => n >= 1 && n <= 3);
}

assert.deepEqual(parseHeldLayers('[1,2]'), [1, 2]);
assert.deepEqual(parseHeldLayers('[1,9]'), [1], '越界层号剔除，但这不算解析失败');
for (const bad of ['', 'null', '{"a":1}', '不是 JSON']) {
  assert.throws(
    () => parseHeldLayers(bad),
    `坏数据 ${JSON.stringify(bad)} 必须抛错。返回空数组会让系统当成空仓、重复买入`,
  );
}

// ===== 3. 量价确认取不到：不许判「建仓」 =====

/** 与 etfwatch/confidence.ts 里一致的放行判定 */
const passBuy = (det: number, minConfidence: number, confirm: unknown): boolean =>
  !(minConfidence > 0 && det < minConfidence) && confirm !== null;

assert.equal(passBuy(80, 55, {}), true, '分数够且确认拿到了，可建仓');
assert.equal(passBuy(80, 55, null), false, '分数够但确认取不到，必须降为观察');
assert.equal(passBuy(30, 55, {}), false, '分数不够，本来就不该建仓');
// 反例：确认取不到时该扣的分归零，分数会虚高
const deterministicOnly = 60;
const withDeduction = 60 - 15; // 假设派发该扣 15 分
assert.ok(
  deterministicOnly > 55 && withDeduction < 55,
  '这是缺陷的算术证明：扣分归零后越过门槛，扣了就不该过',
);

// ===== 4. 评估抛错：要收进「没能判断」清单，不能只打日志 =====

type Unjudged = { code: string; reason: string };
function tickOnce(quotes: Quote[], failOn: Set<string>): { judged: number; unjudged: Unjudged[] } {
  const unjudged: Unjudged[] = [];
  let judged = 0;
  for (const q of quotes) {
    const code = q?.code ?? '?';
    if (!judgeable(q)) {
      unjudged.push({ code, reason: '现价取不到' });
      continue;
    }
    if (failOn.has(code)) {
      unjudged.push({ code, reason: '评估出错' });
      continue;
    }
    judged += 1;
  }
  return { judged, unjudged };
}

const r = tickOnce(
  [
    { code: 'a', price: 1, pct: 1 },
    { code: 'b', price: 0, pct: 0 },
    undefined,
    { code: 'd', price: 2, pct: 0 },
  ],
  new Set(['d']),
);
assert.equal(r.judged, 1, '只有 a 真的判了');
assert.equal(r.unjudged.length, 3, 'b（现价 0）、未取到、d（出错）三只都要留痕');
assert.ok(
  r.unjudged.every((u) => u.reason.length > 0),
  '每条都要写清为什么判不了，光有数量还是看不出该查什么',
);

// ===== 5. 卖点复核失败：进「需重点处理」，不混进「持有」 =====

type Res = { code: string; thesis: string; shouldAlert: boolean };
/** 与 decision/sellcheck.ts 里一致的分类 */
function classify(results: Res[]) {
  const failed = results.filter((x) => x.thesis.startsWith('ETF 研判失败'));
  const failedCodes = new Set(failed.map((x) => x.code));
  const alerts = results.filter((x) => x.shouldAlert && !failedCodes.has(x.code));
  return { failed, alerts, needAttention: alerts.length + failed.length > 0 };
}

const c = classify([
  { code: 'a', thesis: '趋势完好', shouldAlert: false },
  { code: 'b', thesis: 'ETF 研判失败：取数超时', shouldAlert: false },
]);
assert.equal(c.failed.length, 1);
assert.ok(
  c.needAttention,
  '只要有判不出来的，就必须进「需重点处理」——不能显示「整体可持有观察」',
);
// 全部成功且无减仓信号时，才可以说整体可持有
const ok = classify([{ code: 'a', thesis: '趋势完好', shouldAlert: false }]);
assert.equal(ok.needAttention, false);

console.log(
  '✅ 取不到就判不了 自检通过：现价 0 不可判 / 层号坏数据抛错 / ' +
    '确认缺失不建仓 / 判不了要留痕带原因 / 研判失败进需重点处理',
);
