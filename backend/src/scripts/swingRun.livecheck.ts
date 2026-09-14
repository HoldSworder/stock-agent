// 端到端跑一轮真实扫描，看链路通不通、扫出什么。
//
// 跑在**临时库**上：这条会写入运行批次与快照，不该污染日常使用的库。
// 但取数需要真实的数据源配置（aktools 地址、同花顺凭据），所以先把真实库的
// settings 表整表复制过来——只读配置、只写临时库，两边都不越界。
// 行情走真实数据源（只读 GET）。
//
// 判据：
//  1) 运行状态不是 failed
//  2) 快照里日线与 60 分钟线两个周期都有
//  3) 有信号的标的，区间与止损方向必须自洽（底部信号止损低于区间下沿）
//  4) 每个标的的判定依据非空——空依据等于给了个结论却说不出为什么
//
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/swingRun.livecheck.ts
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tmpDir = mkdtempSync(join(tmpdir(), 'swing-run-livecheck-'));
const tmpDb = join(tmpDir, 'test.sqlite');

// 真实库路径**必须自己算，不能 import ../config**。
// config 在被 import 的那一刻就把 DATABASE_PATH 固化了，
// 之后再改 process.env 已经不起作用——db/client 会连到真实库。
// 这个坑真踩过：前几轮 livecheck 因此把 6 轮运行、3941 条快照、
// 20 条建议持仓全写进了日常使用的库。所以这里手动重复一遍 config 的默认值。
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rawPath = process.env.DATABASE_PATH ?? './data/stock-agent.sqlite';
const realPath = isAbsolute(rawPath) ? rawPath : resolve(backendRoot, rawPath);

// 先设环境变量，再 import 任何会碰 db 的模块。顺序不能颠倒
process.env.DATABASE_PATH = tmpDb;
if (existsSync(realPath)) {
  const src = new Database(realPath, { readonly: true });
  const dst = new Database(tmpDb);
  dst.exec(
    'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)',
  );
  const rows = src.prepare('SELECT key, value, updated_at FROM settings').all() as Array<{
    key: string;
    value: string;
    updated_at: string;
  }>;
  const ins = dst.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)');
  for (const r of rows) ins.run(r.key, r.value, r.updated_at);
  console.log(`（已从真实库复制 ${rows.length} 项配置到临时库，真实库以只读方式打开）`);
  src.close();
  dst.close();
} else {
  console.log('（未找到真实库，取数可能因缺配置而失败）');
}

const { ensureSchema } = await import('../db/migrate');
const { sqlite } = await import('../db/client');
const { runSwingScan, readLatestSnapshot } = await import('../swing/runner');
const { SWING_GRADE_LABELS } = await import('@stock-agent/shared');

// 守卫：确认真的连在临时库上。
// 这条检查存在的唯一理由是「写错库」是静默的——扫描照样成功、断言照样通过，
// 只有日常使用的库里悄悄多出一堆测试建议。宁可在这里硬崩。
const connected = (sqlite.pragma('database_list') as Array<{ file: string }>)[0]?.file ?? '';
// 必须比规范化后的路径：macOS 会把 /var/folders 解析成 /private/var/folders，
// 直接比字符串前缀会误报（第一版就在这里误报过）
const realTmp = realpathSync(tmpDir);
if (!realpathSync(connected).startsWith(realTmp)) {
  console.error(
    `FAIL 连到的不是临时库而是 ${connected}。\n` +
      '原因通常是在设置 DATABASE_PATH 之前就 import 了 ../config 或任何碰 db 的模块。',
  );
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
}
console.log(`（已确认连在临时库：${connected}）`);

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

async function main(): Promise<void> {
  line('=== 端到端扫描 ===');
  const t0 = Date.now();
  const res = await runSwingScan('live');
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  line(
    `运行 ${res.runId.slice(0, 8)} 状态 ${res.status}：` +
      `${res.okCount}/${res.targetCount} 个标的成功，耗时 ${secs}s`,
  );
  if (res.failures.length > 0) {
    line(`失败 ${res.failures.length} 项（前 8 条）：`);
    for (const f of res.failures.slice(0, 8)) line(`  ${f.code} ${f.reason}`);
  }
  line('');

  check('运行未整体失败', res.status !== 'failed', `状态 ${res.status}`);

  const { run, rows } = readLatestSnapshot();
  check('能读回快照', run != null && rows.length > 0, `${rows.length} 条`);
  if (!run) {
    line('FAIL 无快照可查，后续检查跳过');
    process.exit(1);
  }
  line(`快照日期 ${run.tradeDate}，数据截止 ${run.dataAsOf ?? '—'}，共 ${rows.length} 条读数`);

  const periods = new Set(rows.map((r) => r.period));
  check(
    '日线与 60 分钟线都算了（两者不能互相替代）',
    periods.has('day') && periods.has('60m'),
    `实际 ${[...periods].join(',')}`,
  );
  // 60 分钟线只对持仓、赛道代表、日线已出信号的标的取，不是全量——
  // 全量取会被数据源限流（实测第二轮 15 分钟跑不完）
  const dayRows = rows.filter((r) => r.period === 'day');
  const m60Rows = rows.filter((r) => r.period === '60m');
  line(`  日线 ${dayRows.length} 条、60 分钟线 ${m60Rows.length} 条`);
  // 只断言不超过，不断言严格少于：赛道代表按规则本来就都要取 60 分钟线，
  // 当标的池里全是赛道代表时（临时库没有持仓与自选数据的情形）两者相等是正常的
  check(
    '60 分钟线不超过日线条数（按需取，不会凭空多出来）',
    m60Rows.length <= dayRows.length,
    `60m ${m60Rows.length} 条 vs 日线 ${dayRows.length} 条`,
  );
  const proxyOrHeld = dayRows.filter((r) => r.isTrackProxy || r.grade !== 'none').length;
  line(`  其中该取 60 分钟线的（赛道代表或日线已出信号）约 ${proxyOrHeld} 条`);

  // 每条读数都得说得出话来。正面依据、反证、判不了的原因，三者至少有一样——
  // 页面上出现「暂无信号」却一片空白，使用者会以为系统没算
  const speechless = rows.filter((r) => {
    try {
      const p = JSON.parse(r.rationale) as {
        rationale?: string[];
        counterEvidence?: string[];
        unavailableReason?: string | null;
      };
      return (
        (p.rationale?.length ?? 0) === 0 &&
        (p.counterEvidence?.length ?? 0) === 0 &&
        !p.unavailableReason
      );
    } catch {
      return true;
    }
  });
  check(
    '每条读数都有依据、反证或判不了的原因',
    speechless.length === 0,
    `${speechless.length} 条什么都没说，如 ${speechless[0]?.code}`,
  );
  // 无信号的行也要有正面说明，不能只有反证
  const noPositive = rows.filter((r) => {
    if (r.grade !== 'none') return false;
    try {
      const p = JSON.parse(r.rationale) as { rationale?: string[]; unavailableReason?: string | null };
      return (p.rationale?.length ?? 0) === 0 && !p.unavailableReason;
    } catch {
      return true;
    }
  });
  check(
    '无信号的行也给出正面说明（说清系统看了什么）',
    noPositive.length === 0,
    `${noPositive.length} 条只有反证没有说明，如 ${noPositive[0]?.code}`,
  );

  // 有信号的行：区间与止损方向自洽
  const signaled = rows.filter((r) => r.grade !== 'none');
  line('');
  line(`有信号 ${signaled.length} 条：`);
  for (const r of signaled.slice(0, 20)) {
    line(
      `  ${r.code} ${r.name.padEnd(20)} ${r.period.padEnd(4)} ${SWING_GRADE_LABELS[r.grade as never]}` +
        `${r.track ? ` [${r.track}]` : ''}` +
        `  区间 ${r.zoneLow}~${r.zoneHigh} 止损 ${r.initialStop} 现价 ${r.close}`,
    );
  }
  if (signaled.length > 20) line(`  …另有 ${signaled.length - 20} 条`);

  const badDirection = signaled.filter((r) => {
    if (r.zoneLow == null || r.zoneHigh == null || r.initialStop == null) return true;
    const isBottom = r.grade.includes('bottom');
    return isBottom ? !(r.initialStop < r.zoneLow) : !(r.initialStop > r.zoneHigh);
  });
  check(
    '有信号的行区间与止损方向自洽（底部止损在区间下方，顶部反之）',
    badDirection.length === 0,
    `${badDirection.length} 条方向不对，如 ${badDirection[0]?.code} ${badDirection[0]?.grade}`,
  );

  // 赛道代表要标注出来，否则会被当成赛道指数本身
  const proxies = rows.filter((r) => r.isTrackProxy);
  check(
    '赛道代表标的被标注（页面据此说明是用某只 ETF 代看该赛道）',
    proxies.length > 0,
    `${proxies.length} 条`,
  );

  // 建议持仓：看这一轮有没有真的建出仓来，以及额度有没有守住
  const { listOpenAdvices, usedBudgetPct } = await import('../swing/adviceStore');
  const advices = listOpenAdvices();
  line('');
  line(`建议持仓 ${advices.length} 条，合计占用额度 ${usedBudgetPct().toFixed(1)}%`);
  for (const a of advices.slice(0, 10)) {
    line(
      `  ${a.code} ${a.name.padEnd(18)} 建议 ${a.targetPct}%  区间 ${a.zoneLow}~${a.zoneHigh}  止损 ${a.initialStop}`,
    );
  }
  check(
    '建议持仓合计不超过 20% 上限',
    usedBudgetPct() <= 20.05,
    `${usedBudgetPct().toFixed(1)}%`,
  );
  check(
    '每条建议的止损都低于区间下沿（只做多）',
    advices.every((a) => a.initialStop < a.zoneLow),
    advices
      .filter((a) => a.initialStop >= a.zoneLow)
      .map((a) => `${a.code} 止损${a.initialStop}>=下沿${a.zoneLow}`)
      .join('；'),
  );
  check(
    '同一标的不会挂两条建议（否则额度被算两次）',
    new Set(advices.map((a) => a.code)).size === advices.length,
  );
  // 条数上限：不加会把仓位摊成灰（实测建 20 条、每条 0.78%）
  const { MAX_CONCURRENT_ADVICES } = await import('../swing/sizing');
  check(
    `同时跟踪不超过 ${MAX_CONCURRENT_ADVICES} 条（仓位不摊薄成无意义的碎片）`,
    advices.length <= MAX_CONCURRENT_ADVICES,
    `实际 ${advices.length} 条`,
  );
  if (advices.length > 0) {
    const avg = advices.reduce((s, a) => s + a.targetPct, 0) / advices.length;
    line(`  平均每条 ${avg.toFixed(1)}%`);
    check(
      '每条建议的仓位有实际意义（不低于 1%）',
      advices.every((a) => a.targetPct >= 1),
      `最小 ${Math.min(...advices.map((a) => a.targetPct))}%`,
    );
  }

  line('');
  line(failed === 0 ? 'PASS 端到端通过' : `FAIL ${failed} 项不达标`);
}

try {
  await main();
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
process.exit(failed === 0 ? 0 : 1);
