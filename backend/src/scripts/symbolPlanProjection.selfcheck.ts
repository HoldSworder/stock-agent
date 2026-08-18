// 走势推演自检（无框架，assert 断言）。覆盖计划 S5 的三条硬要求：
// - 波动率锥按 σ_N = σ_日 × √N 张开，样本不足时返回 null 而不是硬算；
// - 预测判定的先后顺序与「同一根 bar 内说不准就算落空」的保守口径；
// - **模型主观概率只展示不参与计算**：扫源码确认风险/求值/告警链路一个字都没读它。
// 跑在临时 sqlite 上。运行：cd backend && pnpm exec tsx src/scripts/symbolPlanProjection.selfcheck.ts
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KlineBar } from '@stock-agent/shared';

const tmpDir = mkdtempSync(join(tmpdir(), 'projection-selfcheck-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

const { buildCone, dailyLogSigma } = await import('../symbolPlans/projection');
const { judge } = await import('../symbolPlans/forecast');

function bar(time: string, close: number): KlineBar {
  return { time, open: close, high: close, low: close, close, volume: 1, amount: 1 };
}

// ===== 1. 波动率锥 =====

{
  // 固定日涨跌 ±1%：对数收益取值 ±ln(1.01)，样本标准差可解析验证
  const bars: KlineBar[] = [];
  let price = 100;
  for (let i = 0; i < 200; i += 1) {
    price *= i % 2 === 0 ? 1.01 : 1 / 1.01;
    bars.push(bar(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, price));
  }
  const est = dailyLogSigma(bars)!;
  assert.ok(est, '样本充足时必须给出 σ');
  // 用样本标准差（n−1），故比总体值略大 √(n/(n−1))≈1.004，留 1% 容差
  assert.ok(
    Math.abs(est.sigma / Math.log(1.01) - 1) < 0.01,
    `σ 应约等于 ln(1.01)，实际 ${est.sigma}`,
  );

  const cone = buildCone(bars, 5)!;
  assert.equal(cone.steps.length, 5);
  const s1 = cone.steps[0];
  const s4 = cone.steps[3];
  // √N 外推：第 4 步的对数半宽应是第 1 步的 2 倍
  const w1 = Math.log(s1.p1High / cone.basePrice);
  const w4 = Math.log(s4.p1High / cone.basePrice);
  assert.ok(Math.abs(w4 / w1 - 2) < 0.01, `第 4 步宽度应是第 1 步的 √4=2 倍，实际 ${w4 / w1}`);
  // 2σ 必须完全包住 1σ，否则图上内外两层会交叉，读图直接读反
  for (const s of cone.steps) {
    assert.ok(s.p2Low < s.p1Low && s.p1Low < s.p1High && s.p1High < s.p2High, '锥的四条轨必须严格有序');
  }
}

{
  const few = Array.from({ length: 10 }, (_, i) => bar(`2026-01-${String(i + 1).padStart(2, '0')}`, 100 + i));
  assert.equal(buildCone(few, 5), null, '样本不足必须返回 null，不许用短样本硬算一个看着很精确的区间');
  // 完全无波动时 σ=0，锥退化成一条线，同样不给
  const flat = Array.from({ length: 200 }, (_, i) => bar(`2026-0${1 + (i % 9)}-01`, 10));
  assert.equal(buildCone(flat, 5), null, 'σ=0 时不给锥');
}

// ===== 2. 预测判定 =====

{
  const bars = [
    { time: '2026-02-02', high: 11, low: 10 },
    { time: '2026-02-03', high: 13, low: 10.5 },
  ];
  const since = '2026-02-01T07:00:00.000Z';
  const base = 10.5;
  assert.equal(judge(bars, since, base, 12.5, 9, '2026-03-01', '2026-02-04'), 'hit', '先到目标价判兑现');
  assert.equal(
    judge(bars, since, base, 20, 10.4, '2026-03-01', '2026-02-04'),
    'miss',
    '先破失效价判落空',
  );
  assert.equal(
    judge(bars, since, base, 20, 5, '2026-03-01', '2026-02-04'),
    null,
    '未到期且都没触及时不得下判定',
  );
  assert.equal(
    judge(bars, since, base, 20, 5, '2026-02-03', '2026-02-04'),
    'timeout',
    '到期仍未触及判超时',
  );
  // 同一根既触目标又破失效：日线看不出盘中先后，必须判落空，
  // 反过来会系统性地把模型成绩单往高了修，校准表也就白攒了
  assert.equal(
    judge(
      [{ time: '2026-02-02', high: 13, low: 9 }],
      since,
      base,
      12.5,
      9.5,
      '2026-03-01',
      '2026-02-04',
    ),
    'miss',
    '同一根内既触目标又破失效必须判落空',
  );
  // 预测落库当天的 bar 不参与判定：那根是报概率时就已经看到的，拿它判等于用已知结果打分
  assert.equal(
    judge(
      [{ time: '2026-02-01', high: 99, low: 1 }],
      since,
      base,
      12.5,
      9.5,
      '2026-03-01',
      '2026-02-04',
    ),
    null,
    '落库当天及之前的 bar 不得参与判定',
  );
  // 例外：盘前（09:30 前）生成的预测，当日行情整根都还在未来，必须计入——
  // 否则「盘前生成、当天就走到目标」这类兑现会被整批漏掉，而盘前批量生成正是主力路径
  assert.equal(
    judge(
      [{ time: '2026-02-01', high: 13, low: 10 }],
      '2026-02-01T00:30:00.000Z', // 上海 08:30
      base,
      12.5,
      9.5,
      '2026-03-01',
      '2026-02-04',
    ),
    'hit',
    '盘前生成的预测必须把当日行情计入判定',
  );
  // 风险情景：目标价在基准价下方，必须按最低价判触及。
  // 若一律按 high >= target 判，第一根 bar 就满足，所有看跌情景都会被记成兑现，校准表直接作废
  const downBars = [{ time: '2026-02-02', high: 11, low: 10.2 }, { time: '2026-02-03', high: 10.4, low: 9.6 }];
  assert.equal(
    judge(downBars, since, base, 9.8, 12, '2026-03-01', '2026-02-04'),
    'hit',
    '下方目标价必须按最低价判触及',
  );
  assert.equal(
    judge([{ time: '2026-02-02', high: 11, low: 10.4 }], since, base, 9.8, 12, '2026-03-01', '2026-02-04'),
    null,
    '下方目标价未跌到位不得判兑现',
  );
  // 失效价在基准价上方（看跌情景被证伪）时按最高价判
  assert.equal(
    judge([{ time: '2026-02-02', high: 12.1, low: 10.4 }], since, base, 9.8, 12, '2026-03-01', '2026-02-04'),
    'miss',
    '上方失效价必须按最高价判触及',
  );
}

// ===== 3. 主观概率不得流进任何计算链路 =====

/**
 * 允许读这个字段的地方，仅限：编译时原样透传、落库核对、暴露给前端、告诉 LLM 可以填。
 * 其余任何文件出现它，都意味着一个未经校准的数正在参与决策——
 * 而这种污染一旦发生，事后从仓位结果里是看不出来的。
 */
const ALLOWED = new Set([
  'symbolPlans/service.ts',
  'symbolPlans/forecast.ts',
  'symbolPlans/index.ts',
  'agent/tools.ts',
]);

/** 自检脚本整体豁免：它们只断言行为，不构成决策路径 */
const isSelfcheck = (rel: string): boolean => rel.endsWith('.selfcheck.ts');

// fileURLToPath 而非 .pathname：路径含中文时 pathname 是百分号编码的，直接拿去 readdir 会 ENOENT
const SRC = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

{
  const offenders = walk(SRC)
    .map((f) => relative(SRC, f))
    .filter((rel) => !ALLOWED.has(rel) && !isSelfcheck(rel))
    .filter((rel) => readFileSync(join(SRC, rel), 'utf8').includes('subjectiveProbabilityPct'));
  assert.deepEqual(
    offenders,
    [],
    `模型主观概率只允许展示与落库，以下文件读了它：${offenders.join(', ')}`,
  );
  // 白名单本身要有效：拼错文件名会让这条断言变成永远通过的摆设
  for (const f of ALLOWED) {
    assert.ok(
      readFileSync(join(SRC, f), 'utf8').includes('subjectiveProbabilityPct'),
      `白名单里的 ${f} 并没有用到该字段，白名单已过期`,
    );
  }
}

rmSync(tmpDir, { recursive: true, force: true });
console.log('✅ 走势推演自检通过（√N 锥 · 样本不足不硬算 · 判定保守口径 · 主观概率零污染）');
