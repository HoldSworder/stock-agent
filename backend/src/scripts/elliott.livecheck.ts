// 波浪计数的真实数据体检：对个股 / ETF / 板块 / 大盘指数各周期拉一遍，
// 断言那些「算得出来但一看就错」的不变量。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/elliott.livecheck.ts
//
// 与 market/elliott.ts 尾部的 assert 自检分工：那里用构造数据锁住算法分支，
// 这里用真实行情兜住「构造不出来的形态」——负目标价与已被击穿的失效价都是先在真实数据上暴露的。

import type { ElliottAnalysis, ElliottWaveCount, KlinePeriod } from '@stock-agent/shared';
import { ELLIOTT_MIN_TRUSTED_CONFIDENCE } from '@stock-agent/shared';
import { getElliottAnalysis } from '../market/elliott';

interface Case {
  code: string;
  period: KlinePeriod;
  secid?: string;
  label: string;
}

const CASES: Case[] = [
  { code: '601127', period: 'day', label: '个股·日线' },
  { code: '601127', period: 'week', label: '个股·周线' },
  { code: '601127', period: 'month', label: '个股·月线' },
  { code: '601127', period: '60m', label: '个股·60分' },
  { code: '601127', period: '15m', label: '个股·15分' },
  { code: '600519', period: 'week', label: '个股·周线2' },
  { code: '300750', period: 'day', label: '个股·创业板' },
  { code: '159516', period: 'day', label: 'ETF·日线' },
  { code: '159740', period: 'week', label: 'ETF·跨境周线' },
  { code: '512480', period: 'day', label: 'ETF·行业日线' },
  { code: 'BK0447', period: 'day', label: '板块·日线' },
  { code: '000001', period: 'day', secid: '1.000001', label: '指数·上证日线' },
  { code: '000001', period: 'month', secid: '1.000001', label: '指数·上证月线' },
  { code: '399006', period: 'day', secid: '0.399006', label: '指数·创业板指' },
];

/** 一套计数上所有「不该出现」的情况；返回问题描述，空数组即通过 */
function violations(c: ElliottWaveCount, close: number, asOf: string): string[] {
  const bad: string[] = [];
  if (c.state === 'unclear') return bad;
  const first = c.legs[0];
  // 浪1 的走向即整套计数的顺势方向
  const up = first ? first.toPrice > first.fromPrice : true;
  const iv = c.invalidationPrice;

  for (const t of c.targets) {
    if (!Number.isFinite(t.price) || t.price <= 0) bad.push(`目标价非正：${t.ratio} → ${t.price}`);
  }
  if (iv != null && c.currentLabel) {
    // A 浪的失效价是浪5 极值（顺势越过即证伪），1-5 浪的失效价在逆势一侧
    const breached =
      c.currentLabel === 'A' ? (up ? close > iv : close < iv) : up ? close < iv : close > iv;
    if (breached) bad.push(`现价 ${close} 已击穿失效价 ${iv}，这套计数本不该输出`);
  }
  if (iv != null && c.currentDirection) {
    const dir = c.currentDirection;
    const guardAhead = dir === 'up' ? iv > close : iv < close;
    if (guardAhead) {
      for (const t of c.targets) {
        const beyond = dir === 'up' ? t.price >= iv : t.price <= iv;
        if (beyond) bad.push(`目标 ${t.price} 越过失效价 ${iv}，走到即自我证伪`);
      }
    }
  }
  if (c.timeWindow) {
    if (c.timeWindow.fromDate <= asOf.slice(0, 10)) {
      bad.push(`时间窗起点 ${c.timeWindow.fromDate} 没有推到最后一根 bar(${asOf}) 之后`);
    }
    if (c.timeWindow.fromDate > c.timeWindow.toDate) {
      bad.push(`时间窗首尾颠倒：${c.timeWindow.fromDate} > ${c.timeWindow.toDate}`);
    }
  }
  for (const l of c.legs) {
    if (l.bars <= 0) bad.push(`浪${l.label} 跨越 ${l.bars} 根 bar`);
    if (!(l.fromPrice > 0) || !(l.toPrice > 0)) bad.push(`浪${l.label} 价格非正`);
  }
  const running = c.legs.filter((l) => !l.completed);
  if (running.length > 1) bad.push(`出现 ${running.length} 段进行中的浪，应至多一段`);
  if (c.confidence < 0 || c.confidence > 1) bad.push(`置信度越界：${c.confidence}`);
  // 低置信度必须在后端就砍掉目标位：底稿同时喂给 LLM，只在前端隐藏会让解读把它念出来
  if (c.confidence < ELLIOTT_MIN_TRUSTED_CONFIDENCE && c.targets.length > 0) {
    bad.push(`置信度 ${c.confidence} 低于门槛却仍给出 ${c.targets.length} 个目标位`);
  }

  // 首选必须取「沿行进方向下一个尚未到达」的那一档，取错等于把已经走过的位子当成还要去的地方
  if (c.primary?.price != null) {
    if (!c.targets.some((t) => t.price === c.primary!.price)) {
      bad.push(`首选价位 ${c.primary.price} 不在候选位之列`);
    }
    const dir = c.currentDirection;
    if (dir && close > 0) {
      const up = dir === 'up';
      const unreached = c.targets
        .filter((t) => !(up ? close >= t.price : close <= t.price))
        .sort((a, b) => (up ? a.price - b.price : b.price - a.price));
      if (unreached.length > 0 && c.primary.price !== unreached[0].price) {
        bad.push(`首选应取最近的未到达档 ${unreached[0].price}，实际 ${c.primary.price}`);
      }
    }
    if (c.primary.date && c.primary.date <= asOf.slice(0, 10)) {
      bad.push(`首选日期 ${c.primary.date} 没有推到最后一根 bar(${asOf}) 之后`);
    }
  }
  if (c.primary && c.targets.length === 0) bad.push('无候选位却给出了首选');

  // 时间位必须递增，且未到达的日期都要在最后一根 bar 之后
  for (let i = 1; i < c.timeProjections.length; i += 1) {
    if (c.timeProjections[i].bars <= c.timeProjections[i - 1].bars) {
      bad.push(`斐波那契时间位未按 bar 数递增：${c.timeProjections[i - 1].ratio} → ${c.timeProjections[i].ratio}`);
    }
  }
  for (const t of c.timeProjections) {
    if (!t.reached && t.date <= asOf.slice(0, 10)) {
      bad.push(`未到达的时间位 ${t.ratio} 日期 ${t.date} 不晚于最后一根 bar`);
    }
  }

  // 子浪必须完整覆盖父浪：首尾对不上就不是「这一浪的内部结构」
  const s = c.subdivision;
  if (s) {
    const running = c.legs.find((l) => !l.completed);
    if (!running) bad.push('没有进行中的浪却给出了子浪细分');
    else {
      const first = s.legs[0];
      const last = s.legs[s.legs.length - 1];
      if (!first || !last) bad.push('子浪细分为空');
      else {
        if (first.fromTime.slice(0, 10) !== running.fromTime.slice(0, 10)) {
          bad.push(`子浪起点 ${first.fromTime} 与父浪起点 ${running.fromTime} 不符`);
        }
        if (last.toTime.slice(0, 10) !== running.toTime.slice(0, 10)) {
          bad.push(`子浪终点 ${last.toTime} 与父浪终点 ${running.toTime} 不符`);
        }
      }
      for (const l of s.legs) {
        if (l.bars <= 0) bad.push(`子浪 ${l.label} 跨越 ${l.bars} 根 bar`);
        if (!l.label.startsWith(s.parentLabel)) bad.push(`子浪 ${l.label} 未以父浪 ${s.parentLabel} 为前缀`);
      }
      if (s.legs.filter((l) => !l.completed).length > 1) bad.push('子浪中出现多于一段进行中');
    }
  }
  return bad;
}

function describe(a: ElliottAnalysis, c: ElliottWaveCount | null, role: string): string {
  if (!c) return `  ${role.padEnd(4)} —`;
  const t = c.targets.map((x) => x.price).join(' / ') || '—';
  const p = c.primary?.price != null ? `${c.primary.price}@${c.primary.date ?? '—'}` : '—';
  const s = c.subdivision
    ? `${c.subdivision.period}:${c.subdivision.legs.map((l) => l.label).join('/')}`
    : '—';
  return (
    `  ${role.padEnd(4)} ${c.degreeLabel.padEnd(10)} ${String(c.currentLabel ?? '—').padEnd(2)}` +
    `(${c.currentDirection ?? '—'}) conf=${c.confidence.toFixed(2)} legs=${c.legs.length}` +
    ` 候选[${t}] 首选 ${p} 失效 ${c.invalidationPrice ?? '—'} 子浪 ${s}`
  );
}

async function main(): Promise<void> {
  let failed = 0;
  let checked = 0;
  for (const cs of CASES) {
    let a: ElliottAnalysis;
    try {
      a = await getElliottAnalysis(cs.code, cs.period, cs.secid);
    } catch (e) {
      console.log(`✗ ${cs.label} ${cs.code} 取数失败：${e instanceof Error ? e.message : String(e)}`);
      failed += 1;
      continue;
    }
    if (a.code !== cs.code) {
      console.log(`✗ ${cs.label} 返回的 code 串了：${a.code} != ${cs.code}`);
      failed += 1;
      continue;
    }
    console.log(`\n【${cs.label}】${cs.code} ${cs.period} close=${a.close} asOf=${a.asOf}`);
    console.log(`  ${a.summary}`);
    // 两种读法说的是同一段走势，候选位必须逐个相同——不同就说明折叠或量度出了错
    if (a.contextual?.currentLabel === 'B' && a.minor) {
      const x = a.contextual.targets.map((t) => t.price).join(',');
      const y = a.minor.targets.map((t) => t.price).join(',');
      if (x !== y) {
        console.log(`      ✗ 高一度与当前级别的候选位不一致：[${x}] vs [${y}]`);
        failed += 1;
      }
      // 时间窗则必须各算各的：B 浪比照 24 根的 A 浪，minor 比照 4 根的小浪中位数，
      // 借用会让 B 浪报出差一个数量级的「还需 N 根」
      const cw = a.contextual.timeWindow;
      const doneBars = a.contextual.legs.filter((l) => l.completed).map((l) => l.bars);
      const runBars = a.contextual.legs.find((l) => !l.completed)?.bars ?? 0;
      if (cw && doneBars.length > 0) {
        const expect = Math.max(1, Math.round(doneBars[0] - runBars));
        if (Math.abs(cw.bars - expect) > 1) {
          console.log(`      ✗ 高一度时间窗应按自己的 A 浪(${doneBars[0]}根)算，期望约 ${expect} 根，实际 ${cw.bars} 根`);
          failed += 1;
        }
      }
    }
    for (const [role, c] of [
      ['大级别', a.major],
      ['当前', a.minor],
      ['高一度', a.contextual],
      ['备选', a.alternate],
    ] as Array<[string, ElliottWaveCount | null]>) {
      console.log(describe(a, c, role));
      if (!c) continue;
      checked += 1;
      for (const v of violations(c, a.close, a.asOf)) {
        console.log(`      ✗ ${v}`);
        failed += 1;
      }
    }
  }
  console.log(`\n共校验 ${checked} 套计数，问题 ${failed} 项`);
  if (failed > 0) process.exitCode = 1;
  else {
    console.log(
      '✅ 真实数据体检通过（目标价为正 · 未输出已击穿失效价的计数 · 目标不越过失效价 · 时间窗向未来 · ' +
        '至多一段进行中的浪 · 首选取最近未达档 · 时间位递增且指向未来 · 子浪完整覆盖父浪 · 两种读法候选位一致）',
    );
  }
}

void main();
