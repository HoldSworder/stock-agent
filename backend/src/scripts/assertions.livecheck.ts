// 技术断言账本的真实数据体检 + 历史回补。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/assertions.livecheck.ts [回补天数]
//
// 与 assertions/judge.selfcheck.ts 的分工：那里用构造走势锁住判定分支，
// 这里用真实行情跑通「冻结 → 结算 → 统计」整条链，并校验落库数据的不变量。
//
// 回补的意义：账本刚建时一条样本都没有，光看空表判断不了统计是否可信。
// 拿历史交易日补跑一遍，当天就能看到几百条已结算断言，遵循率是否荒谬立刻可见。

import { and, eq, gte, sql } from 'drizzle-orm';
import { db, schema } from '../db/client';
import {
  backfill,
  buildReport,
  computeDrafts,
  fetchSeries,
  settleDue,
  shadowedFocusCodes,
  trackedCodes,
  MIN_SAMPLE,
} from '../assertions/service';
import { TURNING_MIN_STREAK as MIN_STREAK } from '@stock-agent/shared';
import { buildCalendar, streakOf } from '../assertions/calendar';
import { isDeadTimeAssertion } from '../assertions/extract';
import { wilsonLowerBound } from '../strategy/promotionGate';
import { getKline } from '../market/eastmoney';

const BACKFILL_DAYS = Number(process.argv[2]) || 40;

/**
 * 日历回放的基准案例。
 *
 * 这不是随手挑的日期：2026-08-20 收盘后系统冻结了「159516 预测 08-25 走完当前浪」，
 * 而 8/25 最低 0.682 正是那一波的低点。整个转折日历功能就是因为
 * 「这条预测早就算出来了却没有任何页面展示」才立项的，回放对不上就说明白做了。
 */
const REPLAY_ASOF = '2026-08-20';
const REPLAY_EXPECT_CODE = '159516';
const REPLAY_EXPECT_DATE = '2026-08-25';

/** 取最近 N 个真实交易日（用某只必然存在的标的的日线当交易日历） */
async function tradingDays(n: number): Promise<string[]> {
  const bars = await getKline('000001', 'day', n + 10).catch(() => []);
  return bars.map((b) => b.time.slice(0, 10)).slice(-n);
}

async function main(): Promise<void> {
  const targets = trackedCodes();
  console.log(`跟踪标的 ${targets.length} 只：${targets.map((t) => t.code).join(', ')}`);
  if (targets.length === 0) {
    console.log('没有跟踪标的（关注 / 自选 / 活跃计划都为空），无法体检');
    process.exitCode = 1;
    return;
  }

  const days = await tradingDays(BACKFILL_DAYS);
  console.log(`\n=== 回补 ${days.length} 个交易日（${days[0]} ~ ${days[days.length - 1]}）===`);
  const bf = await backfill(days, (m) => console.log(`  ${m}`));
  console.log(`回补写入 ${bf.written} 条断言`);

  console.log('\n=== 结算 ===');
  const s = await settleDue();
  console.log(
    `待判 ${s.checked}，遵循 ${s.settled.respected}，未遵循 ${s.settled.violated}，` +
      `未触及 ${s.settled.untouched}，判不了 ${s.settled.unjudgeable}`,
  );

  console.log('\n=== 不变量校验 ===');
  let bad = 0;
  const fail = (msg: string): void => {
    console.log(`  ✗ ${msg}`);
    bad += 1;
  };

  // 到期日必须晚于冻结日，否则断言一落库就过期
  const badDue = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.symbolAssertions)
    .where(sql`${schema.symbolAssertions.dueDate} <= ${schema.symbolAssertions.asOf}`)
    .get();
  if (Number(badDue?.n ?? 0) > 0) fail(`有 ${badDue?.n} 条断言的到期日不晚于冻结日`);

  // 点位断言必须齐备判定三要素，否则只能判成 unjudgeable，白占账本
  const badLevel = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.symbolAssertions)
    .where(
      and(
        eq(schema.symbolAssertions.kind, 'level'),
        sql`(${schema.symbolAssertions.price} is null or ${schema.symbolAssertions.direction} is null or ${schema.symbolAssertions.atrSnapshot} is null)`,
      ),
    )
    .get();
  if (Number(badLevel?.n ?? 0) > 0) fail(`有 ${badLevel?.n} 条点位断言缺价位/方向/ATR`);

  // 时间断言必须有窗口
  const badTime = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.symbolAssertions)
    .where(
      and(
        eq(schema.symbolAssertions.kind, 'time'),
        sql`(${schema.symbolAssertions.windowFrom} is null or ${schema.symbolAssertions.windowTo} is null)`,
      ),
    )
    .get();
  if (Number(badTime?.n ?? 0) > 0) fail(`有 ${badTime?.n} 条时间断言缺窗口`);

  // 判定参数必须冻结：为空说明冻结时漏写，日后判定会退回默认值，历史成绩就漂了
  const noParam = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.symbolAssertions)
    .where(sql`${schema.symbolAssertions.reactionBars} is null`)
    .get();
  if (Number(noParam?.n ?? 0) > 0) fail(`有 ${noParam?.n} 条断言未冻结 reactionBars`);

  const report = buildReport('2000-01-01');

  // untouched 绝不能进分母：进了会让远端位子被系统性判差
  const o = report.overall;
  if (o.settled !== o.respected + o.violated) {
    fail(`分母口径错：settled ${o.settled} != respected ${o.respected} + violated ${o.violated}`);
  }
  if (o.recorded < o.settled + o.untouched) {
    fail(`recorded ${o.recorded} 小于 settled+untouched ${o.settled + o.untouched}`);
  }

  // Wilson 下界必须 <= 点估计，且都在 [0,1]
  const checkRate = (a: { key: string; rate: number | null; lowerBound: number | null }): void => {
    if (a.rate == null && a.lowerBound == null) return;
    if (a.rate == null || a.lowerBound == null) {
      fail(`${a.key} 的 rate 与 lowerBound 必须同时有或同时无`);
      return;
    }
    if (a.lowerBound > a.rate + 1e-9) fail(`${a.key} 的下界 ${a.lowerBound} 高于点估计 ${a.rate}`);
    if (a.rate < 0 || a.rate > 1 || a.lowerBound < 0 || a.lowerBound > 1) {
      fail(`${a.key} 的比率越界：${a.rate} / ${a.lowerBound}`);
    }
  };
  checkRate(o);
  for (const dim of ['source', 'kind', 'code', 'period'] as const) {
    for (const a of report.slices[dim]) {
      checkRate(a);
      if (a.settled < MIN_SAMPLE && a.rate != null) {
        fail(`${dim}/${a.key} 样本仅 ${a.settled} 却给了比率，应低于 ${MIN_SAMPLE} 时不给`);
      }
    }
  }

  console.log('\n=== 战绩概览 ===');
  const pct = (v: number | null): string => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
  console.log(
    `全部：记录 ${o.recorded}，已判 ${o.settled}（遵循 ${o.respected} / 未遵循 ${o.violated}），` +
      `未触及 ${o.untouched}，遵循率 ${pct(o.rate)}（下界 ${pct(o.lowerBound)}）`,
  );
  console.log('\n按来源：');
  for (const a of report.slices.source) {
    console.log(
      `  ${a.label.padEnd(12)} 已判 ${String(a.settled).padStart(4)}  ` +
        `遵循率 ${pct(a.rate).padStart(7)}  下界 ${pct(a.lowerBound).padStart(7)}  ` +
        `未触及 ${a.untouched}`,
    );
  }
  console.log('\n按类型：');
  for (const a of report.slices.kind) {
    console.log(`  ${a.label.padEnd(6)} 已判 ${a.settled}  遵循率 ${pct(a.rate)}  下界 ${pct(a.lowerBound)}`);
  }

  // === 161.8% 时间档已停止登记 ===
  // 校验在**产出端**而不是查库：库里的存量记录是改动前冻结的，删不掉也不该删
  // （历史成绩不能被追溯改写），只能确认从今往后不再生成。
  console.log('\n=== 161.8% 时间档 ===');
  let deadDrafts = 0;
  for (const t of targets) {
    const { bars, majorBars } = await fetchSeries(t.code, t.secid);
    if (bars.length < 30) continue;
    const { drafts } = computeDrafts({ code: t.code, bars, majorBars });
    deadDrafts += drafts.filter((d) => isDeadTimeAssertion(d.evidenceRef)).length;
  }
  if (deadDrafts > 0) fail(`仍产出 ${deadDrafts} 条 161.8% 时间断言，应已停止登记`);
  else console.log('  ✓ 已停止产出（存量记录保留，不追溯改写历史成绩）');

  // 移除的收益：拿存量数据对比「含 / 不含」该档的时间断言遵循率
  const timeRows = db
    .select({
      outcome: schema.symbolAssertions.outcome,
      evidenceRef: schema.symbolAssertions.evidenceRef,
    })
    .from(schema.symbolAssertions)
    .where(eq(schema.symbolAssertions.kind, 'time'))
    .all()
    .filter((r) => r.outcome === 'respected' || r.outcome === 'violated');
  const rateOf = (rows: typeof timeRows): string => {
    if (rows.length === 0) return '—';
    const hit = rows.filter((r) => r.outcome === 'respected').length;
    return `${((hit / rows.length) * 100).toFixed(1)}%（${hit}/${rows.length}）`;
  };
  const kept = timeRows.filter((r) => !isDeadTimeAssertion(r.evidenceRef));
  const dead = timeRows.filter((r) => isDeadTimeAssertion(r.evidenceRef));
  console.log(`  含该档：${rateOf(timeRows)}`);
  console.log(`  该档自身：${rateOf(dead)}`);
  console.log(`  不含该档：${rateOf(kept)}`);
  if (dead.length > 0 && kept.length > 0) {
    const dr = dead.filter((r) => r.outcome === 'respected').length / dead.length;
    const kr = kept.filter((r) => r.outcome === 'respected').length / kept.length;
    if (dr >= kr) fail(`161.8% 档（${(dr * 100).toFixed(1)}%）并不比其余档（${(kr * 100).toFixed(1)}%）差，移除依据不成立`);
    else console.log(`  ✓ 移除后时间断言遵循率提升 ${((kr - dr) * 100).toFixed(1)} 个百分点`);
  }

  /**
   * 连续天数分档的成绩。**只打印，不计入失败**。
   *
   * TURNING_MIN_STREAK 这个门槛就是据此定的：只出现 1 天的 4/20 = 20%（95% 上界 42%，
   * 上界够不到 50%），连续 ≥2 天的 20/35 = 57%。但每档只有二三十笔，拿它当红线会在
   * 小样本抖动时天天误报。放在这里是为了让「这个分档依据日后是否失效」保持可见。
   *
   * 同时打共振作对照：实测单标的 47% 对多标的 43%、区间几乎完全重叠，
   * 这正是界面不拿共振当可信度的理由，成绩表里也该留着这个反证。
   */
  console.log('\n=== 时间断言分档（只观察，不判定）===');
  {
    const rows = db
      .select({
        code: schema.symbolAssertions.code,
        asOf: schema.symbolAssertions.asOf,
        windowFrom: schema.symbolAssertions.windowFrom,
        outcome: schema.symbolAssertions.outcome,
        evidenceRef: schema.symbolAssertions.evidenceRef,
      })
      .from(schema.symbolAssertions)
      .where(eq(schema.symbolAssertions.kind, 'time'))
      .all()
      .filter((r) => r.windowFrom && !isDeadTimeAssertion(r.evidenceRef));

    const byKey = new Map<string, typeof rows>();
    const codesByWindow = new Map<string, Set<string>>();
    for (const r of rows) {
      const k = `${r.code}|${r.windowFrom}`;
      (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
      (codesByWindow.get(r.windowFrom!) ?? codesByWindow.set(r.windowFrom!, new Set()).get(r.windowFrom!)!).add(r.code);
    }
    const agg = (keep: (days: number, reso: number) => boolean): string => {
      let hit = 0;
      let n = 0;
      for (const group of byKey.values()) {
        const settledOnes = group.filter(
          (g) => g.outcome === 'respected' || g.outcome === 'violated',
        );
        if (settledOnes.length === 0) continue;
        // 必须用 calendar 的 streakOf，不能用 new Set(asOf).size：
        // 后者是「出现过几天」，界面显示的是「连续几天」，两个定义不一样，
        // 拿前者的成绩给后者定阈值就是在编依据
        const days = streakOf(group.map((g) => g.asOf));
        const reso = codesByWindow.get(group[0].windowFrom!)?.size ?? 1;
        if (!keep(days, reso)) continue;
        n += 1;
        if (settledOnes[0].outcome === 'respected') hit += 1;
      }
      if (n === 0) return '无样本';
      const lo = wilsonLowerBound(hit, n);
      return `${hit}/${n} = ${((hit / n) * 100).toFixed(0)}%（下界 ${lo == null ? '—' : (lo * 100).toFixed(0)}%）`;
    };
    console.log(`  只出现 1 天   ${agg((d) => d === 1)}`);
    console.log(`  连续 ≥${MIN_STREAK} 天   ${agg((d) => d >= MIN_STREAK)}`);
    console.log(`  对照·单标的   ${agg((_d, r) => r === 1)}`);
    console.log(`  对照·多标的   ${agg((_d, r) => r >= 2)}`);
    console.log('  界面据「连续天数」分强弱、不据共振——上面两组对照就是理由');
  }

  // === 大盘指数纳入跟踪 ===
  // 指数与个股撞码，取数必须走显式 secid。这里确认它们真的进了账本、
  // 而不是因为取不到线而堆积 unjudgeable
  console.log('\n=== 大盘指数 ===');
  const indexTargets = targets.filter((t) => t.secid);
  if (indexTargets.length === 0) fail('跟踪列表里没有任何带 secid 的指数');
  // 撞码只可能是静默的：用户加了平安银行(000001)，会被上证指数(1.000001)顶掉，
  // 账本里一条都没有却不报错。宁可让体检红一次，也不让人对着空统计猜原因
  const shadowed = shadowedFocusCodes();
  if (shadowed.length > 0) {
    fail(
      `关注标的 ${shadowed.join('、')} 与常驻指数撞码，已被挤出跟踪范围。` +
        '要同时跟踪需把 secid 并入 idx_assertion_semantic 唯一索引',
    );
  }
  for (const t of indexTargets) {
    const row = db
      .select({
        n: sql<number>`count(*)`,
        bad: sql<number>`sum(case when ${schema.symbolAssertions.outcome} = 'unjudgeable' then 1 else 0 end)`,
      })
      .from(schema.symbolAssertions)
      .where(eq(schema.symbolAssertions.code, t.code))
      .get();
    const n = Number(row?.n ?? 0);
    const nb = Number(row?.bad ?? 0);
    if (n === 0) {
      fail(`指数 ${t.code}(${t.secid}) 一条断言都没有，多半是 secid 取数失败`);
      continue;
    }
    // 判不了的占比过半说明取数链有问题，不是行情本身的原因
    if (nb / n > 0.5) fail(`指数 ${t.code} 有 ${nb}/${n} 条判不了，取数链可能有问题`);
    else console.log(`  ✓ ${t.code}(${t.secid}) 共 ${n} 条，判不了 ${nb} 条`);
  }

  // === 转折日历回放 ===
  // 这条是整个功能的立项依据：系统在 8/20 就说出了 8/25，而 8/25 正是实际低点。
  // 回放对不上就说明日历把「当时说了什么」和「现在知道什么」混了。
  console.log('\n=== 转折日历回放 ===');
  const cal = buildCalendar(20, REPLAY_ASOF);
  const allEntries = [...cal.daily.entries, ...cal.weekly.entries];
  if (allEntries.length === 0) {
    console.log(`  － ${REPLAY_ASOF} 无时间预测，跳过（回补范围没盖到这天时属正常）`);
  } else {
    console.log(`  日线 ${cal.daily.entries.length} 个预测日、周线 ${cal.weekly.entries.length} 个`);
    for (const e of allEntries) {
      console.log(
        `  ${e.date}（${e.from}~${e.to}）${e.expect} 标的数 ${e.resonance} 连续 ${e.maxStreak} 天：` +
          e.items.map((i) => `${i.code}/${i.period} 连续${i.streak}天`).join('，'),
      );
    }
    const hit = cal.daily.entries.find(
      (e) => e.date === REPLAY_EXPECT_DATE && e.items.some((i) => i.code === REPLAY_EXPECT_CODE),
    );
    if (!hit) {
      fail(`回放 ${REPLAY_ASOF} 未重现「${REPLAY_EXPECT_CODE} → ${REPLAY_EXPECT_DATE}」这条预测`);
    } else {
      console.log(`  ✓ 重现了 ${REPLAY_EXPECT_CODE} → ${REPLAY_EXPECT_DATE}（连续 ${hit.maxStreak} 天）`);
    }
    // 回放绝不能含基准日之后才记录的内容，否则等于拿后来的走势回答当时的问题
    const leak = allEntries.flatMap((e) => e.items).filter((i) => i.asOf > REPLAY_ASOF);
    if (leak.length > 0) fail(`回放里混进了 ${leak.length} 条 ${REPLAY_ASOF} 之后记录的内容`);
    // 日线与周线绝不能混进同一个条目：两者尺度差一个数量级，合并会把连续天数搅在一起
    const mixed = allEntries.filter((e) => new Set(e.items.map((i) => i.period)).size > 1);
    if (mixed.length > 0) fail(`有 ${mixed.length} 个预测日把日线与周线混在了同一条里`);
  }

  // 指数条目必须带 secid 才能被前端正确点开。
  // 踩过一次：日历只给 code，点「上证指数」打开的是平安银行的 K 线（000001 两边都占），
  // 标题写着上证指数、现价却是 11.74，看着像行情源坏了。
  const indexCodes = new Set(indexTargets.map((t) => t.code));
  const wide = buildCalendar(90);
  const noSecid = [...wide.daily.entries, ...wide.weekly.entries]
    .flatMap((e) => e.items)
    .filter((i) => indexCodes.has(i.code) && !i.secid);
  if (noSecid.length > 0) {
    fail(`日历里有 ${noSecid.length} 条指数条目没带 secid，前端会点开同码个股`);
  }

  console.log(`\n问题 ${bad} 项`);
  if (bad > 0) process.exitCode = 1;
  else
    console.log(
      '✅ 断言账本体检通过（到期日晚于冻结日 · 判定要素齐备 · 参数已冻结 · ' +
        'untouched 不进分母 · Wilson 下界不高于点估计 · 样本不足不给比率 · ' +
        '161.8% 已停产 · 指数已入账 · 日历回放无未来数据泄漏）',
    );
}

void main();
