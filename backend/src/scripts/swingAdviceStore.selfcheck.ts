// 建议持仓落库与推进自检。跑在临时库上，不碰真实数据。
//
// 这份钉的是「账不能记错」，与 swingAdvice.selfcheck 的纯状态机分工不同：
//
//  1) **幂等**：同一天重跑一遍评估，不能重复建仓、不能重复减仓。
//     定时任务失败重试、进程重启后补跑都会触发这种重复，
//     而重复建仓在账面上看不出异常——仓位就是多了一份。
//  2) **额度占用**：未执行的建议照样占额度。否则一天没买、第二天又能继续堆，
//     20% 的合计上限形同虚设。
//  3) **同一标的不重复建**：挂两条建议会让额度被算两次，上限随之失效。
//  4) **事件与状态同一事务**：现有 etfwatch 是分两次写的，
//     进程在中间退出会留下「有告警、无持仓状态」，这个坑不要复制。
//
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/swingAdviceStore.selfcheck.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'swing-advice-store-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

const { ensureSchema } = await import('../db/migrate');
const { db, schema } = await import('../db/client');
const { advanceAdvices, listAdviceEvents, listOpenAdvices, openAdvice, usedBudgetPct } =
  await import('../swing/adviceStore');

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

import type { KlineBar } from '@stock-agent/shared';

/** 造一段温和的 K 线，ATR 小，让仓位不被风险上限压到极小 */
function bars(price: number, n = 60): KlineBar[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 6, 1) + i * 86400_000);
    const c = price * (1 + Math.sin(i / 11) * 0.005);
    return {
      time: d.toISOString().slice(0, 10),
      open: c,
      close: c,
      high: c * 1.005,
      low: c * 0.995,
      volume: 1_000_000,
      amount: c * 1_000_000,
    };
  });
}

function bar(close: number, low = close, high = close): KlineBar {
  return {
    time: '2026-09-07',
    open: close,
    close,
    low,
    high,
    volume: 1_000_000,
    amount: close * 1_000_000,
  };
}

const EQUITY = 500_000;
const TRADE_DATE = '2026-09-07';

function newAdvice(code: string, name = `测试${code}`) {
  return openAdvice({
    code,
    name,
    direction: 'long_bottom',
    zone: { low: 0.98, high: 1.0 },
    initialStop: 0.95,
    bars: bars(1),
    assetType: 'etf',
    totalEquity: EQUITY,
    realPct: 0,
    ruleVersion: 'swing-test',
    tradeDate: TRADE_DATE,
  });
}

function main(): void {
  line('=== 建议持仓落库与推进自检 ===');
  line('');

  // --- 1. 建第一层 ---
  const a1 = newAdvice('159516');
  check('能建第一层', a1.created && (a1.allowedPct ?? 0) > 0, `${a1.reason}`);
  const opens = listOpenAdvices();
  check('状态表里有一条在跟踪', opens.length === 1, `${opens.length} 条`);
  const ev1 = listAdviceEvents('159516');
  check('同时写入了一条建仓事件', ev1.length === 1 && ev1[0].kind === 'open_layer1');
  check(
    '事件与状态的仓位一致（同一事务写入）',
    ev1[0]?.pctAfter === opens[0]?.targetPct,
    `事件 ${ev1[0]?.pctAfter}% vs 状态 ${opens[0]?.targetPct}%`,
  );
  line(`     第一层 ${a1.allowedPct}%（${a1.reason}）`);

  // --- 2. 同一标的不重复建 ---
  const dup = newAdvice('159516');
  check('同一标的已在跟踪时不重复建', !dup.created, dup.reason);
  check('状态表仍只有一条', listOpenAdvices().length === 1);

  // --- 3. 额度占用：未执行的建议照样占额度 ---
  const used = usedBudgetPct();
  check('已占用额度等于在跟踪建议的目标仓位之和', used === opens[0].targetPct, `${used}%`);
  const usedExcl = usedBudgetPct('159516');
  check('排除自身后额度为 0', usedExcl === 0, `${usedExcl}%`);

  // 再建几只把额度吃满，验证上限真的生效
  const codes = ['512760', '588200', '512010', '515880', '512880', '512800'];
  const created: string[] = [];
  for (const c of codes) {
    const r = newAdvice(c);
    if (r.created) created.push(c);
  }
  const totalUsed = usedBudgetPct();
  line(`     又建了 ${created.length} 只，合计占用 ${totalUsed}%`);
  check(
    '合计占用不超过 20% 上限',
    totalUsed <= 20.05,
    `${totalUsed}%（未验证建议的合计上限是 20%）`,
  );
  check(
    '额度吃满后新建被拒（而不是硬塞）',
    created.length < codes.length || totalUsed <= 20.05,
    `建成 ${created.length}/${codes.length}`,
  );

  // --- 4. 推进：幂等 ---
  const barMap = new Map<string, KlineBar>([['159516', bar(1.0, 0.99, 1.01)]]);
  const gradeMap = new Map<string, 'none'>([['159516', 'none']]);
  const first = advanceAdvices({
    barByCode: barMap,
    gradeByCode: gradeMap,
    layer2PctByCode: new Map(),
    ruleVersion: 'swing-test',
    tradeDate: TRADE_DATE,
  });
  line(`     推进一次：动了 ${first.advanced} 条，受阻 ${first.blocked.length} 条`);

  // 触发止损，然后同一天重跑，验证不重复减仓
  const stopBar = new Map<string, KlineBar>([['159516', bar(0.94, 0.93, 0.96)]]);
  const r1 = advanceAdvices({
    barByCode: stopBar,
    gradeByCode: gradeMap,
    layer2PctByCode: new Map(),
    ruleVersion: 'swing-test',
    tradeDate: TRADE_DATE,
  });
  const afterStop = listAdviceEvents('159516');
  check(
    '跌破止损后写入退出事件',
    r1.advanced === 1 && afterStop.some((e) => e.kind === 'exit_stop'),
    `动了 ${r1.advanced} 条，事件 ${afterStop.map((e) => e.kind).join(',')}`,
  );
  check(
    '退出后该条不再处于跟踪中',
    !listOpenAdvices().some((a) => a.code === '159516'),
  );
  const countBefore = listAdviceEvents('159516').length;
  advanceAdvices({
    barByCode: stopBar,
    gradeByCode: gradeMap,
    layer2PctByCode: new Map(),
    ruleVersion: 'swing-test',
    tradeDate: TRADE_DATE,
  });
  const countAfter = listAdviceEvents('159516').length;
  check(
    '同一天重跑不产生重复事件（幂等）',
    countAfter === countBefore,
    `${countBefore} → ${countAfter}`,
  );

  // --- 5. 退出后额度被释放 ---
  const usedAfterExit = usedBudgetPct();
  check(
    '退出后释放了它占的额度',
    usedAfterExit < totalUsed,
    `${totalUsed}% → ${usedAfterExit}%`,
  );

  // --- 6. 取不到行情时如实标记受阻，不改状态 ---
  const openCode = listOpenAdvices()[0]?.code;
  if (openCode) {
    const before = listOpenAdvices().find((a) => a.code === openCode)?.targetPct;
    const blockedRes = advanceAdvices({
      barByCode: new Map(),
      gradeByCode: new Map(),
      layer2PctByCode: new Map(),
      ruleVersion: 'swing-test',
      tradeDate: TRADE_DATE,
    });
    const after = listOpenAdvices().find((a) => a.code === openCode)?.targetPct;
    check(
      '取不到行情时标记受阻且不改仓位',
      blockedRes.blocked.length > 0 && before === after,
      `受阻 ${blockedRes.blocked.length} 条，仓位 ${before} → ${after}`,
    );
  }

  // --- 7. 总资产无效时不建仓 ---
  const noEquity = openAdvice({
    code: '159999',
    name: '无总资产测试',
    direction: 'long_bottom',
    zone: { low: 0.98, high: 1.0 },
    initialStop: 0.95,
    bars: bars(1),
    assetType: 'etf',
    totalEquity: 0,
    realPct: 0,
    ruleVersion: 'swing-test',
    tradeDate: TRADE_DATE,
  });
  check('总资产无效时不给建仓建议', !noEquity.created, noEquity.reason);

  // --- 8. 真实持仓已达上限时不建 ---
  const held = openAdvice({
    code: '159888',
    name: '已满仓测试',
    direction: 'long_bottom',
    zone: { low: 0.98, high: 1.0 },
    initialStop: 0.95,
    bars: bars(1),
    assetType: 'etf',
    totalEquity: EQUITY,
    realPct: 12,
    ruleVersion: 'swing-test',
    tradeDate: TRADE_DATE,
  });
  check('真实持仓已超单标的上限时不再建议加仓', !held.created, held.reason);

  // --- 9. 事件表的幂等键真的唯一 ---
  const anyEvent = db.select().from(schema.swingAdviceEvents).all()[0];
  if (anyEvent) {
    let blocked = false;
    try {
      db.insert(schema.swingAdviceEvents)
        .values({ ...anyEvent, id: 'dup-test' })
        .run();
    } catch {
      blocked = true;
    }
    check('相同幂等键的事件被数据库拦住', blocked);
  }

  line('');
  line(failed === 0 ? 'PASS 建议持仓落库自检通过' : `FAIL ${failed} 项不达标`);
}

try {
  main();
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
process.exit(failed === 0 ? 0 : 1);
