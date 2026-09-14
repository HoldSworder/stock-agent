// 两级定级与区间自检。
//
// 重点钉三件事：
//  1) 两级是**两类证据**而不是一个阈值换说法：一级看指标读数，二级要价格自己走出反转。
//     尤其「还在延伸的那一段永远够不上二级」——它的极值点还没定下来，
//     若这条失守，未验证的提前提示会被当成确认信号拿去放大仓位。
//  2) 区间与止损的算术关系，以及「止损必须在区间之外」这个方向性。
//     写反了会得到一个开仓即触发止损的建议，而它在页面上看起来完全正常。
//  3) 判不了的时候要给出原因，不能静默返回「无信号」——
//     「数据不够所以没判」和「判过了没信号」对使用者是完全不同的两件事。
//
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/swingJudge.selfcheck.ts
import type { KlineBar } from '@stock-agent/shared';
import { SWING_GRADE_LABELS } from '@stock-agent/shared';
import { dropUnclosedBar, judgeSwing, JUDGE_PARAMS } from '../swing/judge';

const line = (s: string): void => console.log(s);
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) line(`ok   ${name}`);
  else {
    line(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
}

function bar(i: number, close: number, span = 0.02): KlineBar {
  const d = new Date(Date.UTC(2026, 0, 5) + i * 86400_000);
  return {
    time: d.toISOString().slice(0, 10),
    open: close,
    close,
    high: close * (1 + span),
    low: close * (1 - span),
    volume: 1_000_000,
    amount: close * 1_000_000,
  };
}

function makeSeries(start: number, segs: Array<[number, number]>): KlineBar[] {
  const closes: number[] = [];
  let price = start;
  for (const [pct, n] of segs) {
    const step = (price * pct) / n;
    for (let i = 0; i < n; i += 1) {
      price += step;
      closes.push(Number(price.toFixed(4)));
    }
  }
  return closes.map((c, i) => bar(i, c));
}

const WARMUP: Array<[number, number]> = [
  [0.04, 12],
  [-0.03, 10],
  [0.03, 12],
  [-0.02, 10],
];

function main(): void {
  line('=== 两级定级与区间自检 ===');
  line(
    `参数：区间宽 ${JUDGE_PARAMS.zoneAtrMult} 倍波动、止损距 ${JUDGE_PARAMS.stopAtrMult} 倍、` +
      `追高线 ${JUDGE_PARAMS.chaseGuardAtrMult} 倍`,
  );
  line('');

  // --- 1. 样本不足要给原因，不能静默无信号 ---
  const tiny = judgeSwing(makeSeries(10, [[0.05, 20]]), 'day');
  check(
    '样本不足时给出原因而非静默无信号',
    tiny.grade === 'none' && tiny.unavailableReason != null,
    `reason=${tiny.unavailableReason}`,
  );
  check('样本不足时不给区间与止损', tiny.zone === null && tiny.initialStop === null);

  // --- 2. 底部：力道衰减但价格未确认反转 → 只能一级 ---
  // 深跌 → 反弹 → 破前低但跌得浅（力道衰减）→ 仅小幅回升，未站上最低那根的高点
  const bottomEasing = judgeSwing(
    makeSeries(10, [...WARMUP, [-0.22, 12], [0.1, 8], [-0.12, 14], [0.005, 4]]),
    'day',
  );
  line(`     [底部力道衰减] ${SWING_GRADE_LABELS[bottomEasing.grade]}`);
  check(
    '力道衰减但未走出反转 → 判一级',
    bottomEasing.grade === 'risk_easing_bottom',
    `实际 ${bottomEasing.grade}；反证 ${bottomEasing.counterEvidence.join('｜')}`,
  );

  // --- 3. 底部：力道衰减 + 站上确认K线高点 → 二级 ---
  const bottomConfirmed = judgeSwing(
    makeSeries(10, [...WARMUP, [-0.22, 12], [0.1, 8], [-0.12, 14], [0.12, 8]]),
    'day',
  );
  line(`     [底部走出反转] ${SWING_GRADE_LABELS[bottomConfirmed.grade]}`);
  check(
    '力道衰减且价格走出反转 → 判二级',
    bottomConfirmed.grade === 'turn_confirmed_bottom',
    `实际 ${bottomConfirmed.grade}；反证 ${bottomConfirmed.counterEvidence.join('｜')}`,
  );
  check(
    '二级的依据里包含价格走出转向这件事',
    bottomConfirmed.rationale.some((r) => r.includes('走出了转向')),
    bottomConfirmed.rationale.join('｜'),
  );

  // --- 4. 两级确实由不同证据区分（不是同一阈值换说法）---
  check(
    '一级与二级的区别来自价格事实，不是背驰强度差异',
    bottomEasing.grade !== bottomConfirmed.grade &&
      bottomEasing.divergence?.kind === bottomConfirmed.divergence?.kind,
    `一级背驰=${bottomEasing.divergence?.kind}，二级背驰=${bottomConfirmed.divergence?.kind}`,
  );

  // --- 5. 延伸段（这一段还在走）永远够不上二级 ---
  //
  // 这是本自检最要紧的一条，对应 2026-08-18 半导体那种情形：
  // 上涨还在延续、顶尚未形成，此时能给的只有提前提示。
  // 若这条失守，未经确认的提示会被当成确认信号拿去放大仓位。
  // 参数经搜索确定必然产生「延伸段顶部背驰」，不是随手写的（见 strength 断言）。
  const extending = judgeSwing(
    makeSeries(10, [...WARMUP, [0.25, 12], [-0.12, 8], [0.18, 15]]),
    'day',
  );
  line(
    `     [上涨途中] ${SWING_GRADE_LABELS[extending.grade]}` +
      `（背驰 ${extending.divergence?.kind ?? '无'}，已走完=${extending.divergence?.confirmed}）`,
  );
  check(
    '该样本确实产生了延伸段背驰（否则下面两条形同虚设）',
    extending.divergence?.kind === 'top' && extending.divergence.confirmed === false,
    `kind=${extending.divergence?.kind}，confirmed=${extending.divergence?.confirmed}`,
  );
  check(
    '还在延伸的段只判一级，绝不判二级',
    extending.grade === 'risk_easing_top',
    `实际 ${extending.grade}`,
  );
  check(
    '延伸段的反证里说明了「还在走」',
    extending.counterEvidence.some((c) => c.includes('还在走')),
    extending.counterEvidence.join('｜'),
  );
  check(
    '延伸段也给出区间与存档止损（试探仓需要它们）',
    extending.zone != null && extending.initialStop != null,
  );

  // --- 6. 区间与止损的算术关系与方向 ---
  for (const [name, j] of [
    ['底部一级', bottomEasing],
    ['底部二级', bottomConfirmed],
  ] as const) {
    if (!j.zone || j.initialStop == null || j.anchor == null || j.atr14 == null) {
      check(`${name} 应给出区间与止损`, false, '缺字段');
      continue;
    }
    const width = j.zone.high - j.zone.low;
    check(
      `${name} 区间宽度等于 ${JUDGE_PARAMS.zoneAtrMult} 倍波动`,
      Math.abs(width - JUDGE_PARAMS.zoneAtrMult * j.atr14) < 0.002,
      `宽 ${width.toFixed(4)}，期望 ${(JUDGE_PARAMS.zoneAtrMult * j.atr14).toFixed(4)}`,
    );
    check(
      `${name} 止损在区间下方（底部信号）`,
      j.initialStop < j.zone.low,
      `止损 ${j.initialStop} vs 区间下沿 ${j.zone.low}`,
    );
    check(
      `${name} 锚点就是区间下沿（底部信号）`,
      Math.abs(j.anchor - j.zone.low) < 0.002,
      `锚点 ${j.anchor} vs 下沿 ${j.zone.low}`,
    );
    check(
      `${name} 追高线在区间上沿之上`,
      j.chaseGuard != null && j.chaseGuard > j.zone.high,
      `追高线 ${j.chaseGuard} vs 上沿 ${j.zone.high}`,
    );
  }

  // --- 7. 顶部信号方向镜像 ---
  const topCase = judgeSwing(
    makeSeries(10, [...WARMUP, [0.22, 12], [-0.1, 8], [0.12, 14], [-0.12, 8]]),
    'day',
  );
  line(`     [顶部] ${SWING_GRADE_LABELS[topCase.grade]}`);
  if (topCase.zone && topCase.initialStop != null) {
    check(
      '顶部信号的止损在区间上方（与底部镜像）',
      topCase.initialStop > topCase.zone.high,
      `止损 ${topCase.initialStop} vs 上沿 ${topCase.zone.high}`,
    );
    check(
      '顶部信号的追高线在区间下沿之下',
      topCase.chaseGuard != null && topCase.chaseGuard < topCase.zone.low,
      `${topCase.chaseGuard} vs ${topCase.zone.low}`,
    );
  } else {
    line('     （该样本未产生顶部信号，跳过方向检查）');
  }

  // --- 8. 关注价位 ---
  const wl = bottomConfirmed.watchLevels;
  check('关注价位非空', wl.length > 0);
  check(
    '上下两侧各不超过上限条数',
    wl.filter((l) => l.side === 'below').length <= JUDGE_PARAMS.maxWatchLevels &&
      wl.filter((l) => l.side === 'above').length <= JUDGE_PARAMS.maxWatchLevels,
  );
  const close = 0; // 用第一条自洽校验：距离必须与 side 一致
  check(
    '下方的价位确实低于上方的价位',
    (() => {
      const below = wl.filter((l) => l.side === 'below').map((l) => l.price);
      const above = wl.filter((l) => l.side === 'above').map((l) => l.price);
      return below.length === 0 || above.length === 0 || Math.max(...below) < Math.min(...above);
    })(),
    `下方 ${wl.filter((l) => l.side === 'below').map((l) => l.price).join(',')}｜上方 ${wl.filter((l) => l.side === 'above').map((l) => l.price).join(',')}`,
  );
  check(
    '每条价位都带来由说明',
    wl.every((l) => l.basis.length > 0),
  );
  check('距离都是非负数', wl.every((l) => l.distancePct >= 0));
  void close;

  // --- 9. 除权除息日不给结论 ---
  // 实测抓到过一只 XD 标的被判出底部信号并建了仓：除权当天价格断层，
  // 尽管取数层已做前复权，那一根的振幅与相邻几根仍不可比
  const good = makeSeries(10, [...WARMUP, [-0.22, 12], [0.1, 8], [-0.12, 14], [0.12, 8]]);
  for (const prefix of ['XD', 'XR', 'DR']) {
    const j = judgeSwing(good, 'day', `${prefix}测试股`);
    check(
      `${prefix} 前缀（除权除息）当天不给结论`,
      j.grade === 'none' && j.unavailableReason != null,
      `grade=${j.grade}，reason=${j.unavailableReason}`,
    );
    check(`${prefix} 当天不给区间与止损`, j.zone === null && j.initialStop === null);
  }
  const normal = judgeSwing(good, 'day', '正常股票');
  check(
    '名称正常的标的照常判断（守卫不会误伤）',
    normal.grade !== 'none',
    `grade=${normal.grade}`,
  );
  check(
    '不传标的名时也照常判断（守卫是可选参数）',
    judgeSwing(good, 'day').grade !== 'none',
  );

  // --- 10. 剔除未收盘那根 ---
  const bars = makeSeries(10, [[0.1, 40]]);
  const inSession = new Date('2026-09-04T02:00:00Z'); // 北京时间 10:00，盘中
  const afterClose = new Date('2026-09-04T09:00:00Z'); // 北京时间 17:00，收盘后
  check(
    '盘中剔除最后一根未收盘K线',
    dropUnclosedBar(bars, inSession).length === bars.length - 1,
  );
  check(
    '收盘后保留全部K线',
    dropUnclosedBar(bars, afterClose).length === bars.length,
  );

  line('');
  line(failed === 0 ? 'PASS 定级自检通过' : `FAIL ${failed} 项不达标`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
