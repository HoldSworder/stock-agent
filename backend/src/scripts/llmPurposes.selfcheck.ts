// 模型调用用途清单自检（无框架，assert 断言；只读源码，不联网不调模型）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/llmPurposes.selfcheck.ts
//
// 这条检查执行的是那句规矩：
//   「重开任何消耗 token 的任务之前，先说清它的产出进哪条决策链、由谁判分。」
//
// 它不替人判断某个用途该不该存在——那是人的决定。它只做一件事：
// **逼出声明**。源码里出现一个没在下面登记的用途，检查就红；
// 想加新调用点，就得在这里写清它属于哪一类、为什么允许。
//
// 为什么需要这种形式的约束：近 30 天 3051 万 token 里，59% 花在
// 盯盘买点研判上，而判卷机在 915 条可判样本上给出「尚无证据显示优于随机」。
// 它不是有人决定这么花的，是一个个调用点悄悄长出来的。
// 靠记性管不住二十多个调用点，得靠一条会变红的检查。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 用途类别。
 *
 * - `answer` 使用者主动问才触发，一次一问，不构成常态开销
 * - `translate` 把规则已经算出的结果转成人话或结构化字段，不产生新结论
 * - `verify` 事实核查与异常排雷，可以一票否决，但不得发起买入
 * - `conclusion` **让模型自己下买卖结论**。这一类违反职责边界，只允许留在
 *   默认关闭的开关后面，等判卷机给出它优于规则的证据再谈开启
 * - `infra` 连通性探测、模型能力自检一类，与交易决策无关
 */
type Category = 'answer' | 'translate' | 'verify' | 'conclusion' | 'infra';

interface Declared {
  category: Category;
  /** 一句话：它的产出进哪条链、由谁判分；conclusion 类必须写清受哪个开关控制 */
  note: string;
}

/**
 * 已登记的用途。新增调用点必须同步加一条，否则检查失败。
 *
 * 分类依据是**产出的用法**，不是它内部用了什么模型。
 * 同一段提示词，拿它的结论去改仓位就是 conclusion，拿它去翻译数字就是 translate。
 */
const DECLARED: Record<string, Declared> = {
  // ===== 使用者主动触发 =====
  chat: { category: 'answer', note: '对话页，使用者主动提问' },
  analyze: { category: 'answer', note: '统一分析中心，使用者点某个分析项才跑' },
  elliott: { category: 'answer', note: 'K 线图上主动请求的波浪读法解释' },
  'symbol-plan': { category: 'answer', note: '标的计划页主动生成/重算' },
  'board-action': { category: 'answer', note: '板块作战台主动请求行动建议' },

  // ===== 基础设施 =====
  connectivity: { category: 'infra', note: '数据源页的模型连通性探测' },

  // ===== 让模型下结论：全部必须在默认关闭的开关后 =====
  'watch-research': {
    category: 'conclusion',
    note: 'ETF/个股盯盘买点研判。受 etfwatch.agentConfirmBuy 与 watch.agentFinalVerdict 控制，两者默认关；判卷机对它的产出给出「尚无证据显示优于随机」',
  },
  'watch-decision': {
    category: 'conclusion',
    note: '个股盯盘多方辩论终审。受 watch.agentFinalVerdict 控制，默认关',
  },
  'watch-screen': {
    category: 'conclusion',
    note: '盯盘初筛。受 watch.enabled 控制，个股盯盘引擎默认关',
  },
  decision: {
    category: 'conclusion',
    note: '多方辩论决策。decision.* 定时默认关，仅决策页主动触发',
  },
  'decision-reflection': {
    category: 'conclusion',
    note: '决策事后反思。decision.reflection 定时默认关',
  },
  sellcheck: {
    category: 'conclusion',
    note: '持仓卖点复核。decision.sellcheck.* 定时默认关',
  },
  'market-review': {
    category: 'conclusion',
    note: '大盘与板块研判。market.boardReview / themes.boardReview 定时在库中已关闭',
  },
  research: {
    category: 'conclusion',
    note: '研报情报研判。research.* 定时默认关',
  },
  review: {
    category: 'conclusion',
    note: '收盘深度复盘。review.eod 定时在库中已关闭',
  },
  'plan-debate': {
    category: 'conclusion',
    note: '今日计划辩论增强。plan.generate 定时在库中已关闭',
  },
  'plan-etf-review': {
    category: 'conclusion',
    note: '今日计划的 ETF 研判增强。随 plan.* 一同关闭',
  },
  screen: {
    category: 'conclusion',
    note: '全市场选股的模型排序。screener.daily 定时默认关，仅选股页主动触发',
  },
  strategy: {
    category: 'conclusion',
    note: '战法模拟盘调仓。strategy.* 定时默认关',
  },
  'scheduled-task': {
    category: 'conclusion',
    note: '中央定时任务（外部编排的模拟盘等）。逐条在设置页可开关，种子默认关闭',
  },
};

// ===== 扫源码 =====

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // scripts 下是自检与探针，不是运行时调用点
    if (name === 'scripts' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const found = new Map<string, string[]>();
for (const file of walk(join(import.meta.dirname, '..'))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/purpose:\s*'([^']+)'/g)) {
    const arr = found.get(m[1]) ?? [];
    arr.push(file.replace(/.*\/backend\//, ''));
    found.set(m[1], arr);
  }
}

assert.ok(found.size > 0, '一个调用点都没扫到，说明扫描逻辑坏了而不是真没有');

// 1. 源码里的每个用途都必须已登记
const undeclared = [...found.keys()].filter((p) => !(p in DECLARED)).sort();
assert.deepEqual(
  undeclared,
  [],
  `发现未登记的模型调用用途：${undeclared.join(', ')}。\n` +
    `请在 llmPurposes.selfcheck.ts 的 DECLARED 里登记，写清它的产出进哪条决策链、由谁判分。\n` +
    `出现在：${undeclared.map((p) => found.get(p)?.join(' / ')).join('；')}`,
);

// 2. 登记了却已从源码消失的，要清掉——留着会让人以为还有这条链路
const stale = Object.keys(DECLARED).filter((p) => !found.has(p)).sort();
assert.deepEqual(
  stale,
  [],
  `以下用途已登记但源码里找不到了，请从 DECLARED 删除：${stale.join(', ')}`,
);

// 3. 每条登记都要有理由，空着等于没声明
for (const [p, d] of Object.entries(DECLARED)) {
  assert.ok(d.note.trim().length >= 8, `用途 ${p} 的理由太短，要写清产出去向与判分方`);
}

const byCat = (c: Category): string[] =>
  Object.entries(DECLARED)
    .filter(([, d]) => d.category === c)
    .map(([p]) => p);

console.log(
  `✅ 模型调用用途自检通过：${found.size} 个调用用途全部已登记\n` +
    `   主动提问 ${byCat('answer').length}｜翻译 ${byCat('translate').length}｜` +
    `核查 ${byCat('verify').length}｜下结论 ${byCat('conclusion').length}｜基础设施 ${byCat('infra').length}`,
);
console.log(
  `   「下结论」这一类共 ${byCat('conclusion').length} 个，全部只允许留在默认关闭的开关后面：\n` +
    `   ${byCat('conclusion').join(', ')}`,
);
