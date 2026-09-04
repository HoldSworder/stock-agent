// 界面黑话扫描（无框架；纯静态扫描，不碰 DB/网络）。
// 运行：pnpm glossary:check                              严格模式，存在未豁免命中则退出码 1
//       tsx src/scripts/glossary.selfcheck.ts            报告模式，只列命中不阻断
//       tsx src/scripts/glossary.selfcheck.ts --test     只跑扫描器自身的判断自检
//
// 为什么不做「词 → 词」的自动替换：同一个词在不同页面是不同意思（口径/档位/命中/中枢），
// 机械替换必然改错。这里只负责把命中摆出来，改法由人判断，复核通过的语境写进 allow。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** 一条黑话规则：命中的词、为什么不能用、改成什么、以及已复核可保留的语境 */
type GlossaryRule = {
  /** 要拦的词 */
  term: string;
  /** 为什么用户看不懂 */
  why: string;
  /** 建议改法。一词多义时在这里写清分支，不给单一替换词 */
  fix: string;
  /**
   * 已人工复核、允许保留的语境。
   * 按「文件路径片段 + 该行必须包含的文本」匹配，不用行号——行号会随无关改动漂移，
   * 一漂移豁免就失效，严格模式会突然对一堆合法代码报错。
   */
  allow?: Array<{ file?: string; contains?: string; note: string }>;
};

/**
 * 只喂给 LLM、用户永远看不到的提示词文件。
 * 这些字符串是模型契约的一部分（指导它调哪个工具、按什么结构输出），
 * 改写有破坏工具调用的风险，收益却是零——用户看到的是模型的回答，不是这些指令。
 * 注意：指令里若要求模型「原样输出某句话」，那句话仍属界面文案，不在此豁免之列；
 * 这类文件里若还夹着真正会弹给用户的报错，得单独挪出去写，别指望扫描器兜底。
 * 它对所有规则生效（在 scan 里统一并进每条规则的 allow），不必逐条 spread。
 */
const PROMPT_ONLY: NonNullable<GlossaryRule['allow']> = [
  { file: 'backend/src/analyze/kinds.ts', note: 'agent 任务定义提示词' },
  { file: 'backend/src/decision/agentConfig.ts', note: '决策 agent 提示词' },
  { file: 'backend/src/plan/service.ts', note: '今日计划生成提示词' },
  { file: 'backend/src/research/service.ts', note: '情报研判提示词' },
  { file: 'backend/src/screener/ranker.ts', note: '选股排序提示词' },
  { file: 'backend/src/market/overview.ts', note: '大盘研判提示词与投喂底稿' },
  { file: 'backend/src/market/macro.ts', note: '宏观底稿，投喂 LLM' },
  { file: 'backend/src/market/usMapping.ts', note: '美股映射底稿，投喂 LLM' },
  { file: 'backend/src/themes/service.ts', note: '板块主线研判提示词' },
  { file: 'backend/src/rotation/service.ts', note: 'ETF 轮动研判提示词' },
  { file: 'backend/src/symbolPlans/format.ts', note: '个股计划底稿，投喂 LLM' },
  { file: 'backend/src/plan/context.ts', note: '计划上下文底稿，投喂 LLM' },
  { file: 'backend/src/etfwatch/confirm.ts', note: '量价确认底稿，投喂 LLM' },
  { file: 'backend/src/etfwatch/confidence.ts', note: '买点置信度提示词' },
  { file: 'backend/src/seeds/strategies.ts', note: '战法说明，投喂 LLM' },
  { file: 'backend/src/strategy/skill.ts', note: '战法技能提示词' },
  { file: 'backend/src/seeds/cronTasks.ts', note: 'openclaw 定时任务提示词' },
  { file: 'backend/src/boards/aiAction.ts', note: '板块动作提示词' },
];

export const GLOSSARY_RULES: GlossaryRule[] = [
  {
    term: '确定性',
    why: '会被读成「确定会涨」，与真实含义相反。实际指「按规则算的、不经 LLM」',
    fix: '按整句改写成「按规则计算」，不要机械替换词面',
    allow: [{ contains: '不确定性', note: '「不确定性」是正常中文，语义与本条相反' }],
  },
  {
    term: '断言',
    why: '自造词，用户会读成编程 assert',
    fix: '技术判断记录',
    allow: [{ contains: '类型断言', note: 'TS 语言概念，非业务黑话' }],
  },
  {
    term: '冻结',
    why: '会被读成「资金冻结」；且仓库里存档义与禁止义混用',
    fix: '存档义→存档；禁止建仓义→禁止建仓',
    allow: [
      {
        file: 'backend/src/miaoxiang/format.ts',
        note: '券商账户里真的被冻结的资金，此处字面义正确',
      },
    ],
  },
  {
    term: '口径',
    why: '统计工程词',
    fix: '按语境写成 计算方式 / 数据依据 / 时间范围',
  },
  {
    term: '下钻',
    why: 'BI 术语 drill-down',
    fix: '赛道选股义→挑出；打开详情义→展开明细',
  },
  {
    term: '降级',
    why: '工程词，会被读成「服务缩水」或「被处罚」',
    fix: '数据不全 / 降为观望',
    allow: [
      { contains: '降级观望', note: '交易动作，指把动作下调为观望，非工程降级' },
      { contains: '降级观察', note: '同上' },
    ],
  },
  {
    term: '暴露',
    why: '金融词 exposure，会被读成「隐私暴露」',
    fix: '持仓/自选关联板块',
    allow: [
      {
        file: 'backend/src/datasource/registry.ts',
        note: '这里说的是「端口对外暴露」，运维本义，用词正确',
      },
    ],
  },
  { term: '读模型', why: 'CQRS 架构术语泄漏', fix: '删掉，直接说「各页结论汇总在这里」' },
  { term: '收口', why: '内部说法', fix: '汇总' },
  { term: '打点', why: '埋点工程词', fix: '调用日志' },
  { term: '治理', why: '运维词，且暴露 SQLite 实现', fix: '清理' },
  { term: '限流', why: '后端 rate limit', fix: '超出本轮处理上限' },
  { term: '反哺', why: '内部说法', fix: '不会自动改参数' },
  {
    term: '底稿',
    why: '内部说法',
    fix: '原始数据',
    allow: [{ file: 'backend/src/server.ts', note: '波浪解读系统提示词' }],
  },
  { term: '前向验证', why: '量化词 out-of-sample', fix: '用之后的新数据检验' },
  { term: '晋级门', why: '自造词', fix: '达标检验' },
  { term: '协议号', why: '自造词', fix: '规则版本号' },
  { term: '有效簇数', why: '统计词', fix: '独立样本数' },
  {
    term: '闭环',
    why: '流程拓扑描述',
    fix: '展开成「复盘结论会自动带进第二天计划」',
  },
  { term: 'superseded', why: '英文直出界面', fix: '已被后来的判断推翻' },
];

/** 实现细节泄漏：这些出现在用户可见文案里会让人以为系统坏了 */
const LEAK_RULES: GlossaryRule[] = [
  { term: 'dataAsOf', why: '英文字段名直出', fix: '改成中文说明或不显示' },
  { term: '未失效，直接复用', why: '缓存实现细节', fix: '用的是今天已经算好的结果' },
  { term: '持久化', why: '工程词', fix: '已保存 / 已存档' },
  { term: '定时未启用或未产出', why: '开发者自述，用户会以为坏了', fix: '这项没开启，可到设置里打开' },
  { term: '结构化解析失败', why: '实现细节', fix: '这段内容读不出来' },
  { term: 'ELLIOTT_MIN_TRUSTED_CONFIDENCE', why: '常量名直印给用户', fix: '把阈值渲染成数字，别印变量名' },
  { term: 'SQLite', why: '暴露存储实现', fix: '本地数据' },
];

/** 扫描范围：只看会变成用户可见文字的地方 */
const TARGETS = [
  { dir: 'frontend/src', exts: ['.vue', '.ts'] },
  { dir: 'backend/src', exts: ['.ts'] },
  { dir: 'shared/src', exts: ['.ts'] },
];

/**
 * 整目录跳过：开发者自用或机器读的，用户看不到。
 * agent/ 是给 LLM 读的工具定义与提示词，属于模型契约而非界面文案——
 * 把它拉进来会淹没真正的 UI 命中，而且改写提示词有破坏工具调用的风险。
 */
const SKIP_DIRS = [
  'backend/src/scripts',
  'backend/src/db',
  'backend/src/agent',
  'node_modules',
  'dist',
];
/** 单文件跳过：词表自身会逐字包含所有黑话，扫它等于自己咬自己 */
const SKIP_FILES = ['backend/src/scripts/glossary.selfcheck.ts'];
/** 自检脚本是写给开发者的断言，不是界面文案 */
const SKIP_SUFFIX = '.selfcheck.ts';

/**
 * 去掉行尾的 // 注释再匹配。
 * `break; // 鉴权失效为确定性失败` 这类行前半段是代码、后半段是注释，
 * 只判断「行首是不是 //」会把它整行当成界面文案。
 *
 * 必须跟引号状态，不能直接正则切第一个 `//`：文案里本来就可能有斜杠
 * （`'成本/口径 // 见说明'`、`'//cdn.example.com'`），一刀切会把真文案削掉半截而漏报。
 */
function stripTrailingComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/**
 * 该英文词是否出现在「和中文混排的字符串」里——这是界面文案的特征。
 *
 * `superseded` 既是会被渲染出去的英文，也是遍布代码的枚举原值和字段名。
 * 纯 `'superseded'` 是 DB 存值与类型字面量，改了会拆掉契约；
 * 而 `置 superseded` 这种夹在中文里的，才是漏给用户看的。
 * Vue 模板里 `v-if="i.supersededBy"` 属性值也被引号包住，靠「同串含中文」一并排除。
 */
const inChineseString = (line: string, term: string): boolean =>
  [...line.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)]
    // `${...}` 是代码不是文案，渲染出来的是它的值。容一层嵌套花括号（`${a ? {b:1}.b : ''}`）
    .map((m) => (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, ''))
    .some((s) => s.includes(term) && /[\u4e00-\u9fff]/.test(s));

/**
 * 文件内自检块的起点。这些块统一写成 `if (process.argv[1] && /xxx\.ts$/.test(process.argv[1]))`，
 * 块里全是开发者断言与 console 输出，用户永远看不到；扫到这一行就停止扫该文件。
 *
 * 只认行首的这一种写法。放宽成「包含 process.argv[1]」会让任何一处偶然引用
 * 都把后半个文件静默排除在扫描之外——漏扫比误报危险得多。截断的文件会在报告末尾列出。
 */
const isSelfcheckGuard = (trimmed: string): boolean => /^if \(process\.argv\[1\]/.test(trimmed);

type Hit = { file: string; line: number; text: string; rule: GlossaryRule };

/**
 * 该行是否为注释。注释是写给开发者看的，用户看不到，不该拦。
 * Vue 模板里的 <!-- --> 同理，漏掉它会把整屏模板注释当成界面文案报出来。
 */
const isCommentLine = (trimmed: string): boolean =>
  trimmed.startsWith('//') ||
  trimmed.startsWith('*') ||
  trimmed.startsWith('/*') ||
  trimmed.startsWith('<!--');

/** 该行是否含中文或目标英文词——纯代码行没有用户可见文字 */
const hasUserText = (line: string): boolean => /[\u4e00-\u9fff]/.test(line);

function walk(dir: string, exts: string[], out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(REPO, full);
    if (SKIP_DIRS.some((d) => rel.startsWith(d))) continue;
    if (entry.isDirectory()) walk(full, exts, out);
    else if (
      exts.includes(path.extname(entry.name)) &&
      !SKIP_FILES.includes(rel) &&
      !entry.name.endsWith(SKIP_SUFFIX)
    )
      out.push(full);
  }
}

/** 命中是否已被人工复核豁免 */
const isAllowed = (rule: GlossaryRule, relPath: string, line: string): boolean =>
  (rule.allow ?? []).some(
    (a) => (!a.file || relPath.includes(a.file)) && (!a.contains || line.includes(a.contains)),
  );

/** 扫到自检块守卫而提前收尾的文件，报告末尾列出，避免「静默漏扫」 */
const truncated: Array<{ file: string; line: number }> = [];

function scan(): Hit[] {
  const hits: Hit[] = [];
  // 提示词豁免只给黑话规则。实现细节泄漏规则不豁免：提示词文件里照样混着会弹给用户的
  // 报错（research/service.ts、plan/context.ts 都有），整文件放行等于给这类文案开后门。
  const rules = [
    ...GLOSSARY_RULES.map((r) => ({ ...r, allow: [...(r.allow ?? []), ...PROMPT_ONLY] })),
    ...LEAK_RULES,
  ];
  truncated.length = 0;
  for (const target of TARGETS) {
    const files: string[] = [];
    walk(path.join(REPO, target.dir), target.exts, files);
    for (const file of files) {
      const rel = path.relative(REPO, file);
      let inBlockComment = false;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (const [i, line] of lines.entries()) {
        const trimmed = line.trim();
        if (isSelfcheckGuard(trimmed)) {
          truncated.push({ file: rel, line: i + 1 });
          break;
        }
        // 跨行块注释要整段跳过，否则 /** ... */ 与 Vue 模板 <!-- --> 里的说明文字会被当成 UI 文案
        if (trimmed.startsWith('/*')) inBlockComment = !trimmed.includes('*/');
        else if (trimmed.startsWith('<!--')) inBlockComment = !trimmed.includes('-->');
        else if (inBlockComment) {
          if (trimmed.includes('*/') || trimmed.includes('-->')) inBlockComment = false;
          continue;
        }
        if (isCommentLine(trimmed)) continue;
        const code = stripTrailingComment(line);
        for (const rule of rules) {
          if (!code.includes(rule.term)) continue;
          if (/[\u4e00-\u9fff]/.test(rule.term)) {
            // 中文词：该行得确实有中文，纯代码行不算界面文案
            if (!hasUserText(code)) continue;
          } else if (!inChineseString(code, rule.term)) {
            // 英文词：只有和中文混在同一个字符串里才是界面文案，枚举原值/标识符不算
            continue;
          }
          if (isAllowed(rule, rel, code)) continue;
          hits.push({ file: rel, line: i + 1, text: trimmed.slice(0, 120), rule });
        }
      }
    }
  }
  return hits;
}

/**
 * 扫描器自检。
 *
 * 这套判断（剥注释、剥插值、英文词只在中文串里才算、自检块截断）是本仓唯一的强制机制，
 * 写错一处就是静默放行——比报错危险。用合成行把每条判断各钉一遍。
 */
function runSelftest(): void {
  const fails: string[] = [];
  let total = 0;
  const check = (ok: boolean, msg: string): void => {
    total += 1;
    if (!ok) fails.push(msg);
  };

  check(stripTrailingComment(`const a = 1; // 确定性说明`) === 'const a = 1; ', '应剥掉行尾注释');
  check(
    stripTrailingComment(`const a = '见 https://x.cn 的口径';`).includes('口径'),
    'URL 里的 // 不该被当注释切掉',
  );
  check(
    stripTrailingComment(`const a = '成本 // 口径';`).includes('口径'),
    '字符串内的 // 不该被当注释切掉',
  );

  check(inChineseString(`'置 superseded 状态'`, 'superseded'), '中英混排字符串应算界面文案');
  check(!inChineseString(`status === 'superseded'`, 'superseded'), '纯枚举原值不算界面文案');
  check(
    !inChineseString('`低于 ${ELLIOTT_MIN} 分`', 'ELLIOTT_MIN'),
    '插值里的标识符渲染出来是值，不算界面文案',
  );
  check(
    !inChineseString('`更新于 ${fmt({ t: v.dataAsOf })}`', 'dataAsOf'),
    '带嵌套花括号的插值也要剥干净，否则字段名会被误判成界面文案',
  );

  check(isSelfcheckGuard('if (process.argv[1] && /x\\.ts$/.test(process.argv[1])) {'), '应识别自检块守卫');
  check(!isSelfcheckGuard('const p = process.argv[1];'), '普通引用不该截断整个文件');

  check(isCommentLine('<!-- 确定性 -->'), 'Vue 注释行不该拦');
  check(isCommentLine('// 确定性'), 'JS 注释行不该拦');
  check(!isCommentLine('<div>确定性</div>'), '模板正文必须拦');

  if (fails.length) {
    console.error(`❌ 扫描器自检失败 ${fails.length} 项：`);
    for (const f of fails) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ 扫描器自检通过（${total} 项）`);
}

if (process.argv.includes('--test')) {
  runSelftest();
  process.exit(0);
}

const strict = process.argv.includes('--strict');
const hits = scan();

/** 因自检块守卫而提前收尾的文件——必须打出来，否则漏扫是无声的 */
function printTruncated(): void {
  if (!truncated.length) return;
  console.log('以下文件扫到自检块守卫即停止（守卫之后为开发者断言，不是界面文案）：');
  for (const t of truncated) console.log(`  ${t.file}:${t.line} 起未扫描`);
  console.log('');
}

if (hits.length === 0) {
  console.log('✅ 界面黑话扫描通过：未发现未豁免的黑话或实现细节泄漏\n');
  printTruncated();
  process.exit(0);
}

const byTerm = new Map<string, Hit[]>();
for (const h of hits) {
  const list = byTerm.get(h.rule.term) ?? [];
  list.push(h);
  byTerm.set(h.rule.term, list);
}

console.log(`\n界面黑话扫描：${hits.length} 处命中，涉及 ${byTerm.size} 个词\n`);
for (const [term, list] of [...byTerm.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const { why, fix } = list[0]!.rule;
  console.log(`【${term}】${list.length} 处 — ${why}`);
  console.log(`  改法：${fix}`);
  for (const h of list) console.log(`  ${h.file}:${h.line}  ${h.text}`);
  console.log('');
}

printTruncated();

if (strict) {
  console.error(`❌ 严格模式：存在 ${hits.length} 处未处理命中。改掉，或把已复核的语境写进 allow`);
  process.exit(1);
}
console.log('（报告模式，不阻断。改完后用 --strict 验收）');
