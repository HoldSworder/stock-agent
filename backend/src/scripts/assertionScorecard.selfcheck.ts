// 技术判断成绩口径自检（无框架，assert 断言；不查库、不联网）。
//
// 第 1~4 节用本文件内的镜像函数验证判据口径；第 5 节导入 scorecard.ts 的真实函数
// （因此会连带建立数据库连接，但不执行任何查询）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/assertionScorecard.selfcheck.ts
//
// 钉住两条，都是刚才真出过的错：
//
// 1. **单位换算。** 库里 edge / edge_lower 存的是小数（-0.0204 即 -2.04 个百分点）。
//    第一版直接当百分点用，于是 -2.04 显示成 -0.02，六套方法的结论全变成
//    「看不出差别」——一个把「明显弱于随机」粉饰成「持平」的错误，而且看不出来。
//
// 2. **结论以 95% 保守下界为准，不看点估计。** 点估计是「这批样本恰好算出来多少」，
//    下界是「最差情况下还剩多少」。几百条样本的点估计上下摆动一两个百分点很常见，
//    拿它宣布领先，下个月就翻脸。实测数据里道氏的点估计是 +0.75 而下界是 -0.88，
//    看点估计会说它领先，看下界才知道它弱于随机。
import assert from 'node:assert/strict';
import { __test__stalenessOf, __test__STALE_DAYS_WARN } from '../assertions/scorecard';

const MIN_SAMPLES = 100;
const MEANINGFUL_POINTS = 0.5;

/** 与 assertions/scorecard.ts 一致的换算 */
const toPoints = (v: number | null): number | null => (v == null ? null : v * 100);

/** 与 assertions/scorecard.ts 一致的结论判定 */
function verdictOf(row: { edgeLower: number | null; samples: number | null }): string {
  const n = row.samples ?? 0;
  if (n < MIN_SAMPLES) return 'sample-short';
  const lower = row.edgeLower;
  if (lower == null) return 'no-control';
  if (lower >= MEANINGFUL_POINTS) return 'ahead';
  if (lower <= -MEANINGFUL_POINTS) return 'behind';
  return 'indistinguishable';
}

// ===== 1. 单位换算 =====

assert.equal(toPoints(-0.0204), -2.04, '小数必须乘 100 转成百分点');
assert.equal(toPoints(0.0075), 0.75);
assert.equal(toPoints(null), null);
// 反例：漏了换算会把「弱 2 个百分点」判成「看不出差别」
assert.equal(
  verdictOf({ edgeLower: -0.0204, samples: 343 }),
  'indistinguishable',
  '这是漏换算时的错误结果，留作反例',
);
assert.equal(
  verdictOf({ edgeLower: toPoints(-0.0204), samples: 343 }),
  'behind',
  '换算后必须判为弱于随机',
);

// ===== 2. 用下界不用点估计 =====

// 实测的道氏：点估计 +0.75 点、下界 -0.88 点
const dow = { edge: 0.0075, edgeLower: -0.0088, samples: 295 };
assert.equal(
  verdictOf({ edgeLower: toPoints(dow.edgeLower), samples: dow.samples }),
  'behind',
  '下界为负必须判弱于随机，哪怕点估计是正的',
);
assert.ok(
  toPoints(dow.edge)! > 0 && toPoints(dow.edgeLower)! < 0,
  '这组数据的意义就在于点估计与下界符号相反，是本条断言的关键',
);

// ===== 3. 样本下限优先于一切 =====

assert.equal(
  verdictOf({ edgeLower: 5, samples: MIN_SAMPLES - 1 }),
  'sample-short',
  '样本不足时即使大幅领先也不许给结论',
);
assert.equal(verdictOf({ edgeLower: 5, samples: MIN_SAMPLES }), 'ahead');

// ===== 4. 中间带 =====

assert.equal(verdictOf({ edgeLower: 0.4, samples: 500 }), 'indistinguishable', '不够 0.5 点不算领先');
assert.equal(verdictOf({ edgeLower: -0.4, samples: 500 }), 'indistinguishable', '不够 -0.5 点不算弱');
assert.equal(verdictOf({ edgeLower: null, samples: 500 }), 'no-control', '没算出对照结果要如实说');

console.log(
  '✅ 技术判断成绩口径自检通过：小数转百分点 / 用 95% 下界不用点估计 / 样本下限优先 / 中间带判持平',
);

// ===== 5. 成绩过期提示（用的是 scorecard.ts 里的真实函数，不是镜像）=====
//
// 起因：这份成绩的重算此前只存在于 weights.livecheck.ts，生产没有任何入口，
// 于是成绩停在手工跑过的那一天（2026-08-28），而页面照常展示「算于 08-28」，
// 不提一个字说这是半个月前的数。**测出来没人知道是哪天的结论，和没测一样。**
//
// 两种停更原因给出的话必须不同，否则使用者不知道该做什么：
// 定时没开 = 「它本来就不会更新，去打开」；定时开着却停更 = 「有一环跑挂了，去看任务健康」。

assert.equal(
  __test__stalenessOf('2026-09-15', '2026-09-15', []).staleDays,
  0,
  '当天算的就是 0 天',
);
assert.equal(
  __test__stalenessOf('2026-09-15', '2026-09-15', []).staleNote,
  null,
  '链路开着且是当天的，不该有任何提示',
);

// 链路开着、在容忍窗口内 → 不提示（跨周末不能误报）
assert.equal(
  __test__stalenessOf('2026-09-09', '2026-09-15', []).staleNote,
  null,
  `${__test__STALE_DAYS_WARN} 天内不提示，否则周末假期天天误报`,
);

// 链路开着却停更超窗口 → 指向任务健康
{
  const r = __test__stalenessOf('2026-08-28', '2026-09-15', []);
  assert.equal(r.staleDays, 18);
  assert.ok(r.staleNote, '停更 18 天必须提示');
  assert.ok(r.staleNote!.includes('18 天'), '要把天数说出来，不能只给日期');
  assert.ok(r.staleNote!.includes('任务健康'), '定时开着却停更，该引导去看哪一项跑挂了');
  assert.ok(!r.staleNote!.includes('关着'), '定时开着时不该说成关着');
}

// 链路关着 → 必须说明「不会自己更新」并指出是哪几项
{
  const r = __test__stalenessOf('2026-08-28', '2026-09-15', ['存档', '核对']);
  assert.equal(r.staleDays, 18);
  assert.ok(r.staleNote!.includes('不会自己更新'), '关着的时候要说清它不会自动更新');
  assert.ok(r.staleNote!.includes('存档'), '要点名是哪几项没开');
  assert.ok(r.staleNote!.includes('核对'), '要点名是哪几项没开');
  assert.ok(!r.staleNote!.includes('任务健康'), '定时关着是预期内，不该引导去查故障');
}

// 从未算过 → 不能显示成 0 天（那会被读成「今天刚算的」）
{
  const r = __test__stalenessOf(null, '2026-09-15', ['存档', '核对', '算成绩']);
  assert.equal(r.staleDays, null, '从未算过必须是 null，不能是 0');
  assert.ok(r.staleNote!.includes('还没算过'), '从未算过要如实说');
}

console.log('✅ 成绩过期提示自检通过：天数与日期同时给出 / 两种停更原因给不同的话 / 从未算过不显示成 0 天');
