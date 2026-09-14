// 规则存档与验收资格自检。
//
// 这份自检里有一条与众不同：**把放行门槛的数字复写一遍并断言相等**。
// 看起来是重复，其实是刻意的摩擦——用上两三个月、感觉「好像挺准」的时候，
// 一定会很想把门槛调松一点好放大仓位。那时候调，等于用已经看过的数据
// 反推一个能通过的标准。改门槛会让这条自检失败，迫使改动被明确意识到，
// 而不是顺手改掉。
//
// 其余几条钉的是防作弊链路本身：哈希对参数敏感、参数一改自动升版、
// 定版当天的数据没有验收资格、历史重放永远不能用于放行。
//
// 跑在临时库上，不碰真实数据：本自检会写入版本记录，不该污染日常使用的库。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/swingRuleVersion.selfcheck.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'swing-rule-selfcheck-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

const { ensureSchema } = await import('../db/migrate');
const { shiftTradingDays } = await import('../market/calendar');
const { shanghaiToday } = await import('../util');
const {
  buildRuleManifest,
  currentRuleVersion,
  ensureRuleVersion,
  isValidationEligible,
  ruleHashOf,
  VALIDATION_GATE,
} = await import('../swing/ruleVersion');

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

function main(): void {
  line('=== 规则存档与验收资格自检 ===');
  line('');

  // --- 1. 门槛数字不许被悄悄调松 ---
  // 这里的期望值来自方案定稿。任何改动都应当是明确决定，而不是顺手为之
  const expectedGate = {
    eventDedupeTradeDays: 20,
    minEventsPerDirection: 60,
    minTradeDatesPerDirection: 30,
    minBlocksPerDirection: 30,
    controlsPerEvent: 8,
    observeTradeDays: 20,
    targetAtrMult: 2,
    invalidAtrMult: 1,
    bootstrapIterations: 10_000,
    minEdgePoints: 10,
    minEdgeLowerPoints: 5,
    minRealRatePct: 45,
    minTracks: 10,
    minEventsPerPhase: 10,
    maxSingleCodeSharePct: 10,
  };
  for (const [k, v] of Object.entries(expectedGate)) {
    const actual = (VALIDATION_GATE as unknown as Record<string, number>)[k];
    check(
      `门槛 ${k} 仍为 ${v}`,
      actual === v,
      `实际 ${actual}。改门槛必须是明确决定：确认要改就同步改本自检，并知道这会让样本重新积累`,
    );
  }
  check(
    '只有二级信号能决定放大仓位',
    VALIDATION_GATE.upgradableGrades.length === 2 &&
      VALIDATION_GATE.upgradableGrades.includes('turn_confirmed_bottom') &&
      VALIDATION_GATE.upgradableGrades.includes('turn_confirmed_top'),
    `实际 ${VALIDATION_GATE.upgradableGrades.join(',')}`,
  );

  // --- 2. 哈希对参数敏感、对键序不敏感 ---
  const m = buildRuleManifest();
  const h1 = ruleHashOf(m);
  const reordered = Object.fromEntries(Object.entries(m).reverse());
  check('键序不同但内容相同 → 哈希相同', ruleHashOf(reordered) === h1, `${ruleHashOf(reordered)} vs ${h1}`);
  const tweaked = JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
  (tweaked.sizing as Record<string, unknown>).singleCapPct = 20;
  check('改一个参数 → 哈希改变', ruleHashOf(tweaked) !== h1);
  const tweakedGate = JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
  (tweakedGate.gate as Record<string, unknown>).minEventsPerDirection = 10;
  check('改门槛 → 哈希也改变（门槛属于规则的一部分）', ruleHashOf(tweakedGate) !== h1);

  // --- 3. 规则清单必须覆盖会改变结果的各类参数 ---
  // advice 是试探仓的动作规则，coreHolding 是底仓的动作规则，两套并列，
  // 都会改变实际给出的动作，漏收任一项都会让那一套被偷偷改掉而版本号不变
  for (const key of ['divergence', 'judge', 'sizing', 'advice', 'coreHolding', 'universe', 'gate']) {
    check(`规则清单包含 ${key}`, key in m);
  }

  // --- 4. 自动升版与幂等 ---
  const v1 = ensureRuleVersion();
  check('能确保存在生效版本', v1.version.length > 0 && v1.status === 'active');
  check('版本的哈希与当前参数一致', v1.ruleHash === h1, `${v1.ruleHash} vs ${h1}`);
  const v2 = ensureRuleVersion();
  check(
    '参数未变时不重复升版（幂等）',
    v2.version === v1.version && v2.ruleHash === v1.ruleHash,
    `${v1.version} → ${v2.version}`,
  );
  const cur = currentRuleVersion();
  check('生效版本可被读回', cur != null && cur.version === v1.version);

  // --- 5. 资格起始日是下一个交易日，不是当天 ---
  // 定版当天的数据有一部分产生于定版之前，用它给自己验收就是作弊
  const expectFrom = shiftTradingDays(shanghaiToday(), 1);
  check(
    '验收资格从下一个交易日起算',
    v1.eligibleFromTradeDate === expectFrom,
    `${v1.eligibleFromTradeDate} vs 期望 ${expectFrom}`,
  );
  check(
    '资格起始日晚于今天',
    v1.eligibleFromTradeDate > shanghaiToday(),
    `${v1.eligibleFromTradeDate} vs 今天 ${shanghaiToday()}`,
  );

  // --- 6. 资格判定的每个条件都能单独否决 ---
  const ok = {
    ruleVersion: v1.version,
    ruleHash: v1.ruleHash,
    mode: 'live' as const,
    barTime: `${v1.eligibleFromTradeDate}T15:00:00+08:00`,
    tradeDate: v1.eligibleFromTradeDate,
    runStatus: 'ok',
  };
  check('五个条件全中 → 有资格', isValidationEligible(ok));
  check(
    '历史重放永远没有资格（只能提前否决，不能用于放行）',
    !isValidationEligible({ ...ok, mode: 'replay' as never }),
  );
  check('运行未完整成功 → 无资格', !isValidationEligible({ ...ok, runStatus: 'partial' }));
  check(
    '定版之前的交易日 → 无资格',
    !isValidationEligible({ ...ok, tradeDate: shanghaiToday() }),
  );
  check(
    '信号K线收盘于定版之前 → 无资格',
    !isValidationEligible({
      ...ok,
      barTime: `${shanghaiToday()}T15:00:00+08:00`,
    }),
  );
  check('版本号不匹配 → 无资格', !isValidationEligible({ ...ok, ruleVersion: 'swing-v999' }));
  check(
    '哈希不匹配 → 无资格（防「改了参数但版本号没动」）',
    !isValidationEligible({ ...ok, ruleHash: 'deadbeef' }),
  );

  line('');
  line(failed === 0 ? 'PASS 规则存档自检通过' : `FAIL ${failed} 项不达标`);
}

try {
  main();
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
process.exit(failed === 0 ? 0 : 1);
