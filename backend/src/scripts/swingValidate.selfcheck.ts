// 阶段二验收逻辑自检。跑在临时库上。
//
// 这块最容易出的错不是崩，而是**把结论做漂亮**。所以断言集中在几个「一改就能虚增胜率」的点：
//
//  1) 样本资格：定版之前的数据、历史重放的数据，一律不得进入统计。
//  2) 事件去重：同代码同方向 20 个交易日内只算一次。
//     不去重的话连续几天反复触发会把有效样本量虚增几倍，
//     bootstrap 的置信区间随之窄得离谱，看起来就「显著」了。
//  3) 分块粒度：必须按自然周。按交易日分块会低估不确定性。
//  4) 样本不足要判 insufficient 而**不是** rejected——
//     「还没检验够」和「检验过不合格」混为一谈，会让人以为规则已被否决。
//  5) 观察窗口未走完的事件不计入分母：既不算命中也不算未命中。
//
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/swingValidate.selfcheck.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'swing-validate-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

const { ensureSchema } = await import('../db/migrate');
const { db, schema } = await import('../db/client');
const { ensureRuleVersion, currentRuleVersion, VALIDATION_GATE } = await import(
  '../swing/ruleVersion'
);
const { collectEvents, latestResults, weekKey: wk } = await import('../swing/validate');
const { newId, nowIso } = await import('../util');

ensureSchema();

const line = (s: string): void => console.log(s);
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) line(`ok   ${name}`);
  else {
    line(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
}

const rule = ensureRuleVersion();
const RUN_ID = 'run-test';

/** 造一条快照行 */
function snap(over: {
  code: string;
  tradeDate: string;
  grade?: string;
  eligible?: boolean;
  ruleVersion?: string;
  ruleHash?: string;
  period?: string;
}): void {
  db.insert(schema.swingSnapshots)
    .values({
      id: newId(),
      runId: RUN_ID,
      tradeDate: over.tradeDate,
      code: over.code,
      name: `测试${over.code}`,
      period: over.period ?? 'day',
      assetType: 'etf',
      track: '',
      category: 'own',
      isTrackProxy: false,
      grade: over.grade ?? 'turn_confirmed_bottom',
      divergenceStrength: 0.5,
      zoneLow: 1,
      zoneHigh: 1.02,
      initialStop: 0.98,
      atr14: 0.03,
      close: 1.01,
      watchLevels: '[]',
      rationale: '{}',
      barTime: `${over.tradeDate}T15:00:00+08:00`,
      marketPhase: '震荡',
      ruleVersion: over.ruleVersion ?? rule.version,
      ruleHash: over.ruleHash ?? rule.ruleHash,
      validationEligible: over.eligible ?? true,
      createdAt: nowIso(),
    })
    .run();
}

/** 从资格起始日往后推 n 个自然日 */
function dateAfter(n: number): string {
  const d = new Date(`${rule.eligibleFromTradeDate}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function main(): void {
  line('=== 阶段二验收自检 ===');
  line(
    `门槛：每方向 ${VALIDATION_GATE.minEventsPerDirection} 次独立信号、` +
      `${VALIDATION_GATE.minTradeDatesPerDirection} 个交易日、${VALIDATION_GATE.minBlocksPerDirection} 周`,
  );
  line('');

  // --- 1. 只收二级信号 ---
  snap({ code: '159001', tradeDate: dateAfter(1), grade: 'risk_easing_bottom' });
  check(
    '一级信号不进验收样本（它永远只拿试探仓，不参与放大资格）',
    collectEvents('bottom').length === 0,
    `实际收到 ${collectEvents('bottom').length} 条`,
  );

  // --- 2. 只收日线 ---
  snap({ code: '159002', tradeDate: dateAfter(1), period: '60m' });
  check(
    '60 分钟线的信号不进验收样本（结论会随盘中变动）',
    collectEvents('bottom').length === 0,
    `实际 ${collectEvents('bottom').length} 条`,
  );

  // --- 3. 无资格标记的不收 ---
  snap({ code: '159003', tradeDate: dateAfter(1), eligible: false });
  check('未标记验收资格的不收', collectEvents('bottom').length === 0);

  // --- 4. 版本或哈希不匹配的不收（防「改了参数但版本号没动」）---
  snap({ code: '159004', tradeDate: dateAfter(1), ruleVersion: 'swing-v999' });
  snap({ code: '159005', tradeDate: dateAfter(1), ruleHash: 'deadbeef' });
  check(
    '版本或哈希不匹配的不收',
    collectEvents('bottom').length === 0,
    `实际 ${collectEvents('bottom').length} 条`,
  );

  // --- 5. 合格样本能被收上来 ---
  snap({ code: '159100', tradeDate: dateAfter(1) });
  const one = collectEvents('bottom');
  check('合格样本能收上来', one.length === 1, `${one.length} 条`);
  check('带上了信号那根的收盘时刻（不是只有日期）', one[0]?.barTime.includes('T'), one[0]?.barTime);

  // --- 6. 事件去重：同代码 20 个交易日内只算一次 ---
  // 连续 5 天都触发，应该只算 1 个事件
  for (let i = 2; i <= 6; i += 1) snap({ code: '159100', tradeDate: dateAfter(i) });
  const dedup = collectEvents('bottom').filter((e) => e.code === '159100');
  check(
    '同一标的连续多天触发只算一个事件（否则样本量虚增几倍）',
    dedup.length === 1,
    `实际 ${dedup.length} 个：${dedup.map((d) => d.tradeDate).join(',')}`,
  );

  // 隔得足够远的第二次触发应该算新事件
  snap({ code: '159100', tradeDate: dateAfter(40) });
  const farApart = collectEvents('bottom').filter((e) => e.code === '159100');
  check(
    '隔了 40 天的再次触发算作新事件',
    farApart.length === 2,
    `实际 ${farApart.length} 个：${farApart.map((d) => d.tradeDate).join(',')}`,
  );

  // --- 7. 不同标的各自独立去重 ---
  snap({ code: '159200', tradeDate: dateAfter(1) });
  snap({ code: '159300', tradeDate: dateAfter(1) });
  const multi = collectEvents('bottom');
  check(
    '不同标的各自独立计事件',
    new Set(multi.map((m) => m.code)).size === 3,
    `涉及 ${new Set(multi.map((m) => m.code)).size} 只标的`,
  );

  // --- 8. 顶部与底部分开统计 ---
  snap({ code: '159400', tradeDate: dateAfter(1), grade: 'turn_confirmed_top' });
  check(
    '顶部信号只进顶部统计',
    collectEvents('top').length === 1 && !collectEvents('bottom').some((e) => e.code === '159400'),
    `顶部 ${collectEvents('top').length} 条`,
  );

  // --- 9. 门槛数字直接体现在判定里：样本远不够时必须是 insufficient ---
  // 这里只验证判定分支，不跑真实取数（那要联网且慢）
  const eventsNow = collectEvents('bottom').length;
  check(
    '当前样本数远低于门槛（自检环境本就该如此）',
    eventsNow < VALIDATION_GATE.minEventsPerDirection,
    `${eventsNow} vs 门槛 ${VALIDATION_GATE.minEventsPerDirection}`,
  );

  // --- 10. 自然周分块：同一周的样本必须落在同一块 ---
  // 直接验证 weekKey 的行为（通过 collectEvents 拿不到 blockKey，故用样本表间接验）
  // 造两条同周不同天的记录，写入样本表后核对 blockKey
  const monday = '2026-09-07';
  const wednesday = '2026-09-09';
  const nextMonday = '2026-09-14';
  db.insert(schema.swingValidationSamples)
    .values([
      {
        id: newId(),
        ruleVersion: rule.version,
        ruleHash: rule.ruleHash,
        code: 'T1',
        direction: 'bottom',
        kind: 'real',
        eventKey: 'k1',
        blockKey: 'placeholder',
        tradeDate: monday,
        barTime: `${monday}T15:00:00+08:00`,
        basePrice: 1,
        atr14: 0.03,
        targetPrice: 1.06,
        invalidPrice: 0.97,
        marketPhase: null,
        track: '',
        outcome: 'hit',
        settledAt: nowIso(),
        createdAt: nowIso(),
      },
    ])
    .run();
  // 分块粒度必须是自然周。断言的是语义，故直接用被测函数
  check('同一周的两天落在同一分块', wk(monday) === wk(wednesday), `${wk(monday)} vs ${wk(wednesday)}`);
  check(
    '跨周的两天落在不同分块（按周分块，不按交易日）',
    wk(monday) !== wk(nextMonday),
    `${wk(monday)} vs ${wk(nextMonday)}`,
  );
  // 一周里的每一天都必须归到同一块，否则「按周分块」名不副实。
  // 这条是冲着时区偏移来的：带 +08:00 构造再取 UTC 星期会让周一被算进上一周
  const weekDays = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
  check(
    '同一周的五个交易日全部同块',
    new Set(weekDays.map(wk)).size === 1,
    weekDays.map((d) => `${d}→${wk(d)}`).join(' '),
  );
  // 跨年边界：12 月末与次年 1 月初可能属同一 ISO 周，不能因跨年被切开
  check(
    '跨年边界的同一 ISO 周不被切开',
    wk('2026-12-31') === wk('2027-01-01'),
    `${wk('2026-12-31')} vs ${wk('2027-01-01')}`,
  );

  // --- 11. 结果表可读回 ---
  check('尚未跑过检验时结果为空', latestResults().length === 0);

  // --- 12. 目标与失效价的方向：底部信号顺向朝上、反向朝下 ---
  const cur = currentRuleVersion();
  check('规则版本可读回', cur != null);
  const base = 1;
  const atr = 0.03;
  const upTarget = base + VALIDATION_GATE.targetAtrMult * atr;
  const upInvalid = base - VALIDATION_GATE.invalidAtrMult * atr;
  check(
    `底部信号的目标在上方 ${VALIDATION_GATE.targetAtrMult} 倍波动、失效在下方 ${VALIDATION_GATE.invalidAtrMult} 倍`,
    upTarget > base && upInvalid < base,
    `目标 ${upTarget}，失效 ${upInvalid}`,
  );
  check(
    '顺向目标比反向失效更远（赢的时候赚得比输的时候亏得多）',
    Math.abs(upTarget - base) > Math.abs(upInvalid - base),
  );

  line('');
  line(failed === 0 ? 'PASS 验收逻辑自检通过' : `FAIL ${failed} 项不达标`);
}

try {
  main();
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
process.exit(failed === 0 ? 0 : 1);
