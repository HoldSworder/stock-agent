// 建议持仓状态机自检。
//
// 状态机的错误只在特定时序下暴露，跑真实数据往往碰不到，所以这里把冲突组合逐个构造：
//  - 同一天既触发保护线又摸到 1R（谁优先）
//  - 正好第 10 天首次摸到 1R（时间退出还该不该生效）
//  - 已减半之后第二层还该不该加
//  - 价格涨过追高线时加不加
// 这几条都是「两个规则同时成立」的情形，也正是最容易实现成随机结果的地方。
//
// 另外单独钉住两条底线：
//  - 数据不全时**不许改状态**（假装减过仓会让账面与实际脱节，之后全错）
//  - 顶部信号在空仓时不产生任何动作（这套规则不做空，也做不了）
//
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/swingAdvice.selfcheck.ts
import type { KlineBar, SwingGrade } from '@stock-agent/shared';
import {
  evaluateAdvice,
  firstRTarget,
  oneRDistance,
  topSignalAction,
  ADVICE_PARAMS,
  type AdviceState,
} from '../swing/advice';

const line = (s: string): void => console.log(s);
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) line(`ok   ${name}`);
  else {
    line(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
}

function bar(close: number, low = close, high = close): KlineBar {
  return {
    time: '2026-09-04',
    open: close,
    close,
    low,
    high,
    volume: 1_000_000,
    amount: close * 1_000_000,
  };
}

/** 基准状态：成本 1.00、初始止损 0.95、已建第一层 4%，1R 目标 = 1.05 */
function baseState(over: Partial<AdviceState> = {}): AdviceState {
  return {
    layers: [{ layer: 1, pct: 4, price: 1, at: '2026-08-20' }],
    targetPct: 4,
    avgCost: 1,
    initialStop: 0.95,
    currentStop: 0.95,
    peakPrice: 1,
    firstRHit: false,
    firstLayerTradeDate: '2026-08-20',
    zone: { low: 0.98, high: 1.02 },
    chaseGuard: 1.04,
    ...over,
  };
}

const ev = (
  state: AdviceState,
  b: KlineBar,
  opts: { days?: number; grade?: SwingGrade; layer2Pct?: number } = {},
) =>
  evaluateAdvice({
    state,
    bar: b,
    tradeDate: '2026-09-04',
    tradeDaysSinceFirstLayer: opts.days ?? 3,
    grade: opts.grade ?? 'risk_easing_bottom',
    layer2Pct: opts.layer2Pct ?? 6,
  });

function main(): void {
  line('=== 建议持仓状态机自检 ===');
  line(
    `参数：${ADVICE_PARAMS.timeStopTradeDays} 个交易日时间退出、` +
      `达 1R 减 ${ADVICE_PARAMS.firstRReduceRatio * 100}%、顶部一级减 ${ADVICE_PARAMS.topTier1ReduceRatio * 100}%`,
  );
  line('');

  // --- 1. 1R 的算法：始终按初始止损，不随保护线上移而缩水 ---
  const s = baseState();
  check('1R 距离 = 成本 − 初始止损', Math.abs(oneRDistance(s) - 0.05) < 1e-9, `${oneRDistance(s)}`);
  check('1R 目标价 = 成本 + 1R', Math.abs(firstRTarget(s) - 1.05) < 1e-9, `${firstRTarget(s)}`);
  const moved = baseState({ currentStop: 0.99 });
  check(
    '保护线上移后 1R 目标不变（否则赚钱门槛会自己变矮）',
    Math.abs(firstRTarget(moved) - firstRTarget(s)) < 1e-9,
    `上移后 ${firstRTarget(moved)} vs 原 ${firstRTarget(s)}`,
  );

  // --- 2. 数据不全时不许改状态 ---
  for (const [name, b] of [
    ['收盘价为 0', bar(0)],
    ['最低价为 0', { ...bar(1), low: 0 }],
  ] as const) {
    const d = ev(baseState(), b as KlineBar);
    check(
      `${name} 时不改状态且给出无法检查的说明`,
      d.actions.length === 0 && d.blockedReason != null && d.next.targetPct === 4,
      `动作 ${d.actions.length} 个，仓位 ${d.next.targetPct}%，原因 ${d.blockedReason}`,
    );
  }
  const noCost = ev(baseState({ avgCost: 0 }), bar(1));
  check('成本缺失时不改状态', noCost.actions.length === 0 && noCost.blockedReason != null);

  // --- 3. 保护线触发 → 全退，用最低价判断 ---
  const stopped = ev(baseState(), bar(0.96, 0.94, 0.97));
  check(
    '盘中最低价跌破保护线即全退（只看收盘会漏掉插针）',
    stopped.actions.length === 1 &&
      stopped.actions[0].kind === 'exit_stop' &&
      stopped.next.targetPct === 0,
    `动作 ${stopped.actions.map((a) => a.kind).join(',')}，仓位 ${stopped.next.targetPct}%`,
  );
  check('全退后清空层', stopped.next.layers.length === 0);

  // --- 4. 首次达 1R → 减半，并取消未建的第二层 ---
  const rHit = ev(baseState(), bar(1.06, 1.03, 1.06));
  check(
    '摸到 1R 目标 → 减一半',
    rHit.actions.some((a) => a.kind === 'reduce_half') && rHit.next.targetPct === 2,
    `动作 ${rHit.actions.map((a) => a.kind).join(',')}，仓位 ${rHit.next.targetPct}%`,
  );
  check('减半后标记已触发', rHit.next.firstRHit === true);
  check(
    '同时取消尚未建立的第二层',
    rHit.actions.some((a) => a.kind === 'cancel_layer2'),
    rHit.actions.map((a) => a.kind).join(','),
  );

  // --- 5. 冲突一：同一天既破保护线又摸到 1R → 按保护线全退 ---
  const both = ev(baseState(), bar(1, 0.94, 1.06));
  check(
    '同一天既破止损又摸到 1R → 按止损全退（宁可少赚）',
    both.actions.length === 1 && both.actions[0].kind === 'exit_stop' && both.next.targetPct === 0,
    `动作 ${both.actions.map((a) => a.kind).join(',')}`,
  );
  check(
    '该情形的说明里点明了盘中先后无法确定',
    both.actions[0]?.reason.includes('盘中先后'),
    both.actions[0]?.reason,
  );

  // --- 6. 冲突二：正好第 10 天首次摸到 1R → 1R 优先，不触发时间退出 ---
  const day10R = ev(baseState(), bar(1.06, 1.02, 1.06), { days: ADVICE_PARAMS.timeStopTradeDays });
  check(
    '第 10 天摸到 1R → 按 1R 减半，不按时间退出',
    day10R.actions.some((a) => a.kind === 'reduce_half') &&
      !day10R.actions.some((a) => a.kind === 'exit_time') &&
      day10R.next.targetPct === 2,
    `动作 ${day10R.actions.map((a) => a.kind).join(',')}，仓位 ${day10R.next.targetPct}%`,
  );

  // --- 7. 时间退出：满 10 天且从未达 1R ---
  const timeOut = ev(baseState(), bar(1.01, 1, 1.02), { days: ADVICE_PARAMS.timeStopTradeDays });
  check(
    `满 ${ADVICE_PARAMS.timeStopTradeDays} 个交易日仍未走出预期 → 撤掉试探仓`,
    timeOut.actions.some((a) => a.kind === 'exit_time') && timeOut.next.targetPct === 0,
    `动作 ${timeOut.actions.map((a) => a.kind).join(',')}`,
  );
  const day9 = ev(baseState(), bar(1.01, 1, 1.02), { days: 9 });
  check(
    '第 9 天不触发时间退出',
    !day9.actions.some((a) => a.kind === 'exit_time'),
    `动作 ${day9.actions.map((a) => a.kind).join(',')}`,
  );
  const alreadyR = ev(baseState({ firstRHit: true, targetPct: 2 }), bar(1.01, 1, 1.02), {
    days: 20,
  });
  check(
    '已达过 1R 的持仓不再受时间退出约束',
    !alreadyR.actions.some((a) => a.kind === 'exit_time'),
    `动作 ${alreadyR.actions.map((a) => a.kind).join(',')}`,
  );

  // --- 8. 第二层只在二级定级下加，且不追高 ---
  const noConfirm = ev(baseState(), bar(1.01, 1, 1.02), { grade: 'risk_easing_bottom' });
  check(
    '只有一级定级时不加第二层（一级永远只拿试探仓）',
    !noConfirm.actions.some((a) => a.kind === 'open_layer2'),
    `动作 ${noConfirm.actions.map((a) => a.kind).join(',')}`,
  );
  const confirmed = ev(baseState(), bar(1.01, 1, 1.02), { grade: 'turn_confirmed_bottom' });
  check(
    '二级定级且未追高 → 加第二层',
    confirmed.actions.some((a) => a.kind === 'open_layer2') && confirmed.next.targetPct === 10,
    `动作 ${confirmed.actions.map((a) => a.kind).join(',')}，仓位 ${confirmed.next.targetPct}%`,
  );
  check(
    '加第二层后重算成本均价',
    confirmed.next.avgCost > 1 && confirmed.next.avgCost < 1.01,
    `${confirmed.next.avgCost}`,
  );
  check(
    '加第二层不改初始止损（1R 门槛不许变）',
    confirmed.next.initialStop === 0.95,
    `${confirmed.next.initialStop}`,
  );
  const chased = ev(baseState(), bar(1.06, 1.05, 1.07), { grade: 'turn_confirmed_bottom' });
  check(
    '价格涨过追高线 → 第二层作废而不是硬加',
    chased.actions.some((a) => a.kind === 'cancel_layer2') &&
      !chased.actions.some((a) => a.kind === 'open_layer2'),
    `动作 ${chased.actions.map((a) => a.kind).join(',')}`,
  );

  // --- 9. 保护线只上移不下调 ---
  const trailed = ev(baseState({ currentStop: 0.99 }), bar(1.02, 1.01, 1.03), {
    grade: 'risk_easing_bottom',
  });
  check(
    '保护线不会被下调',
    trailed.next.currentStop >= 0.99,
    `${trailed.next.currentStop}`,
  );
  check(
    '最高价被更新',
    trailed.next.peakPrice >= 1.03,
    `${trailed.next.peakPrice}`,
  );

  // --- 10. 只做多：顶部信号的处置 ---
  const empty = topSignalAction(0, 'turn_confirmed_top');
  check(
    '空仓遇顶部信号 → 不产生任何动作，只提示',
    empty.reducePct === 0 && empty.note.includes('没有这只'),
    `减 ${empty.reducePct}%，${empty.note}`,
  );
  const t1 = topSignalAction(10, 'risk_easing_top');
  check(
    `顶部一级 → 减 ${ADVICE_PARAMS.topTier1ReduceRatio * 100}%`,
    Math.abs(t1.reducePct - 10 * ADVICE_PARAMS.topTier1ReduceRatio) < 0.05,
    `${t1.reducePct}%`,
  );
  const t2 = topSignalAction(10, 'turn_confirmed_top');
  check('顶部二级 → 清光', Math.abs(t2.reducePct - 10) < 0.05, `${t2.reducePct}%`);
  const noSignal = topSignalAction(10, 'none');
  check('无信号时不减仓', noSignal.reducePct === 0);
  check(
    '任何情形下都不会给出负的减仓量',
    [empty, t1, t2, noSignal].every((x) => x.reducePct >= 0),
  );

  // --- 11. 空仓状态不产生退出类动作 ---
  const flat = ev(baseState({ targetPct: 0, layers: [] }), bar(0.9, 0.88, 0.92), { days: 30 });
  check(
    '空仓时不产生止损或时间退出动作',
    !flat.actions.some((a) => a.kind === 'exit_stop' || a.kind === 'exit_time'),
    `动作 ${flat.actions.map((a) => a.kind).join(',')}`,
  );

  line('');
  line(failed === 0 ? 'PASS 状态机自检通过' : `FAIL ${failed} 项不达标`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
