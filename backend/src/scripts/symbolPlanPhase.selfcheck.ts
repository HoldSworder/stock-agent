// 标的阶段状态机自检（无框架，assert 断言）。重点验两件最易写错的事：
// 1) 真正的滞回——候选阶段未连续满足门槛不得迁移，未收完的 bar 不得改写阶段；
// 2) 闸门只收紧不放大——大盘/板块只能把动作调保守，绝不能放大。
// 不碰网络与数据库。运行：cd backend && pnpm exec tsx src/scripts/symbolPlanPhase.selfcheck.ts
import assert from 'node:assert/strict';
import type { KlineBar, MaStructure, VolumePriceReading } from '@stock-agent/shared';
import {
  PHASE_DEFAULT_ACTION,
  computePhase,
  resolveMarketAction,
  tighten,
  type PhaseInput,
} from '../symbolPlans/phase';
import { computeDowStructure } from '../symbolPlans/structure';

const dayAt = (i: number): string =>
  new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString().slice(0, 10);

function zigzag(pivots: number[], perLeg = 8): KlineBar[] {
  const bars: KlineBar[] = [];
  let idx = 0;
  for (let i = 1; i < pivots.length; i++) {
    for (let k = 1; k <= perLeg; k++) {
      const px = pivots[i - 1] + ((pivots[i] - pivots[i - 1]) * k) / perLeg;
      bars.push({
        time: dayAt(idx),
        open: px,
        high: px * 1.01,
        low: px * 0.99,
        close: px,
        volume: 1000,
        amount: px * 1000,
      });
      idx += 1;
    }
  }
  return bars;
}

const ma = (ma20: number, ma60: number): MaStructure => ({
  values: [
    { period: 20, value: ma20 },
    { period: 60, value: ma60 },
  ],
  alignment: ma20 > ma60 ? '多头排列' : '空头排列',
  resistanceMa: null,
  supportMa: null,
});

const vp = (verdict: string, pattern: VolumePriceReading['pattern'] = null): VolumePriceReading => ({
  period: 'day',
  amountRatio20: 1,
  volumeRatio20: 1,
  amountState: 'normal',
  closeLocation: 0.5,
  turnoverRate: null,
  pattern,
  verdict,
  warnings: [],
});

function mkInput(bars: KlineBar[], over: Partial<PhaseInput> = {}): PhaseInput {
  const last = bars[bars.length - 1].close;
  return {
    bars,
    completeBar: true,
    dow: computeDowStructure(bars, 'day'),
    volumePrice: vp('成交额比 1.00（正常）'),
    ma: ma(last * 0.98, last * 0.95),
    atr: last * 0.03,
    prev: null,
    ...over,
  };
}

// 上涨与下跌两组 fixture
const UP = zigzag([80, 92, 86, 100, 94, 112]);
const DOWN = zigzag([112, 94, 100, 86, 92, 80]);

// ===== 1. 首次生成直接采纳 =====

{
  const r = computePhase(mkInput(UP));
  assert.equal(r.phase, 'uptrend', `上涨结构首次应判上升持有，实际 ${r.phase}`);
  assert.equal(r.pendingPhase, null, '首次生成不应留 pending');
  assert.ok(r.evidence.some((e) => e.includes('首次生成')), '应说明是首次生成');
}
{
  const bars = DOWN;
  const last = bars[bars.length - 1].close;
  const r = computePhase(mkInput(bars, { ma: ma(last * 1.05, last * 1.1) }));
  assert.equal(r.phase, 'decline', `下跌结构应判下跌防守，实际 ${r.phase}`);
  assert.ok(
    r.evidence.some((e) => e.includes('更低高点')) && r.evidence.some((e) => e.includes('更低低点')),
    '下跌判定须引用更低高点与更低低点',
  );
}

// ===== 2. 滞回：候选阶段未满门槛不迁移 =====

{
  // 当前是上升持有，本根证据指向筑底观察（requiredBars=2）→ 第 1 根不得迁移
  const bars = zigzag([100, 70, 95, 80, 92], 8); // transition/低点抬高
  const step1 = computePhase(
    mkInput(bars, {
      prev: { phase: 'uptrend', pendingPhase: null, pendingBars: 0, lastBarTime: null },
      ma: ma(bars[bars.length - 1].close * 1.02, bars[bars.length - 1].close * 1.05),
    }),
  );
  assert.equal(step1.phase, 'uptrend', '第 1 根满足不得立即迁移（滞回）');
  assert.ok(step1.pendingPhase != null, '应记录候选阶段');
  assert.equal(step1.pendingBars, 1, 'pendingBars 应为 1');
  assert.ok(
    step1.evidence.some((e) => e.includes('1/2') || e.includes('未达迁移门槛')),
    '应说明未达门槛',
  );

  assert.ok(step1.lastBarTime != null, '必须回吐 lastBarTime，否则调用方无法持久化滞回锚点');

  // 同一根 bar 内重复生成计划：不得重复累计，否则一天就能跨过本应两根 K 线的门槛
  const sameBar = computePhase(
    mkInput(bars, {
      prev: {
        phase: 'uptrend',
        pendingPhase: step1.pendingPhase,
        pendingBars: 1,
        lastBarTime: step1.lastBarTime,
      },
      ma: ma(bars[bars.length - 1].close * 1.02, bars[bars.length - 1].close * 1.05),
    }),
  );
  assert.equal(sameBar.phase, 'uptrend', '同一根 bar 内重复生成不得触发迁移');
  assert.equal(sameBar.pendingBars, 1, '同一根 bar 内重复生成不得重复累计');

  // 换到新的一根 bar 且候选不变 → 迁移
  const step2 = computePhase(
    mkInput(bars, {
      prev: {
        phase: 'uptrend',
        pendingPhase: step1.pendingPhase,
        pendingBars: 1,
        lastBarTime: '1999-01-01',
      },
      ma: ma(bars[bars.length - 1].close * 1.02, bars[bars.length - 1].close * 1.05),
    }),
  );
  assert.equal(step2.phase, step1.pendingPhase, '连续第 2 根满足应迁移到候选阶段');
  assert.equal(step2.pendingBars, 0, '迁移后应清空 pending');
}

// ===== 2b. 盘中暂定阶段不享受滞回保护：收盘第一根即可推翻 =====

{
  // 盘中无历史 → 暂定为当根候选，并标 tentative
  const intraday = computePhase(mkInput(UP, { completeBar: false }));
  assert.equal(intraday.tentative, true, '盘中无历史时的阶段必须标为暂定');
  assert.equal(intraday.lastBarTime, null, '未收完的 bar 不得计入滞回累计');

  // 收盘后即便候选与暂定值不同，也应直接采纳，而不是走两根 K 的滞回
  const confirmed = computePhase(
    mkInput(DOWN, {
      prev: {
        phase: intraday.phase,
        pendingPhase: null,
        pendingBars: 0,
        lastBarTime: null,
        tentative: true,
      },
    }),
  );
  assert.equal(confirmed.tentative, false, '收盘确认后不再是暂定');
  assert.equal(confirmed.pendingBars, 0, '暂定值被推翻时直接采纳，不进入 pending 累计');
}

// ===== 2c. 滞回：同一根 bar 内候选改变不得借用上一个候选的连击 =====

{
  const r = computePhase(
    mkInput(DOWN, {
      prev: {
        phase: 'uptrend',
        pendingPhase: 'bottoming', // 上一根攒的是「筑底」的连击
        pendingBars: 1,
        lastBarTime: dayAt(DOWN.length - 1), // 同一根 bar 内重复生成
      },
    }),
  );
  // 本根候选是 decline（requiredBars=1），无论如何都会迁移；
  // 关键是不能把 bottoming 的连击算到别的候选头上
  assert.notEqual(r.pendingPhase, 'bottoming', '候选已改变，旧候选的 pending 必须清掉');
}

// ===== 3. 滞回：候选中断则重新计数 =====

{
  const bars = UP;
  const r = computePhase(
    mkInput(bars, { prev: { phase: 'uptrend', pendingPhase: 'bottoming', pendingBars: 1, lastBarTime: null } }),
  );
  assert.equal(r.phase, 'uptrend', '候选中断时阶段不变');
  assert.equal(r.pendingPhase, null, '本根候选与当前阶段一致应清空 pending，不得继续累计');
  assert.equal(r.pendingBars, 0);
}

// ===== 4. 破位类迁移不等待（requiredBars=1）=====

{
  const bars = DOWN;
  const last = bars[bars.length - 1].close;
  const r = computePhase(
    mkInput(bars, {
      prev: { phase: 'uptrend', pendingPhase: null, pendingBars: 0, lastBarTime: null },
      ma: ma(last * 1.05, last * 1.1),
    }),
  );
  assert.equal(r.phase, 'decline', '破位应一次到位，不等滞回');
  assert.ok(
    r.evidence.some((e) => e.includes('结构破坏')),
    '由上升直接跳到下跌必须记录触发的结构破坏',
  );
}

// ===== 5. 未收完的 bar 只给预警，不改阶段 =====

{
  const bars = DOWN;
  const last = bars[bars.length - 1].close;
  const r = computePhase(
    mkInput(bars, {
      completeBar: false,
      prev: { phase: 'uptrend', pendingPhase: null, pendingBars: 0, lastBarTime: null },
      ma: ma(last * 1.05, last * 1.1),
    }),
  );
  assert.equal(r.phase, 'uptrend', '未收完的 bar 不得改写阶段');
  assert.ok(r.intradayAlert != null, '未收完应给盘中预警');
  assert.ok(r.intradayAlert!.includes('收盘确认'), '预警须说明待收盘确认');
  assert.ok(
    r.evidence.some((e) => e.includes('未收完')),
    '证据须写明当前 bar 未收完',
  );
}
{
  // 盘中且无历史阶段（首次生成）：必须采纳当根候选作为暂定阶段，
  // 退化成 uncertain 会让盘中生成的计划恒为「不确定 → 等待」，永远给不出可执行动作
  const bars = DOWN;
  const last = bars[bars.length - 1].close;
  const r = computePhase(
    mkInput(bars, { completeBar: false, prev: null, ma: ma(last * 1.05, last * 1.1) }),
  );
  assert.equal(r.phase, 'decline', `盘中首次生成应采纳当根候选，实际 ${r.phase}`);
  assert.notEqual(r.phase, 'uncertain', '盘中首次生成不得退化为不确定');
  assert.equal(r.lastBarTime, null, '未收完的 bar 不得计入滞回累计');
  assert.ok(r.intradayAlert?.includes('暂定'), '应标明是盘中暂定');
}

// ===== 6. 加速判定：乖离超 3×ATR =====

{
  const bars = UP;
  const last = bars[bars.length - 1].close;
  // MA20 远低于现价，乖离 > 3×ATR
  const r = computePhase(mkInput(bars, { ma: ma(last * 0.7, last * 0.6), atr: last * 0.02 }));
  assert.equal(r.phase, 'acceleration', `乖离过大应判加速谨慎，实际 ${r.phase}`);
  assert.ok(r.evidence.some((e) => e.includes('乖离')), '应写明乖离依据');
}

// ===== 7. 高位放量滞涨 → 分歧 =====

{
  const r = computePhase(
    mkInput(UP, { volumePrice: vp('成交额比 1.50：放量滞涨', 'stall_on_volume') }),
  );
  assert.equal(r.phase, 'distribution', `上升中放量滞涨应判高位分歧，实际 ${r.phase}`);
  // 判定必须读结构化标志位，改文案不得影响结果
  const byText = computePhase(mkInput(UP, { volumePrice: vp('放量滞涨', null) }));
  assert.notEqual(byText.phase, 'distribution', '不得靠匹配中文文案判定，pattern 为空时不应判分歧');
}

// ===== 8. 缺证据 → uncertain，不猜方向 =====

{
  const r = computePhase(mkInput(UP, { dow: null }));
  assert.equal(r.phase, 'uncertain', '缺结构证据必须进不确定，不做分数平均');
}

// ===== 9. tighten：只收紧不放大 =====

assert.equal(tighten('hold', 'wait'), 'wait', 'wait 比 hold 保守');
assert.equal(tighten('wait', 'hold'), 'wait', '顺序无关，总取保守');
assert.equal(tighten('add', 'exit'), 'exit', 'exit 最保守');
assert.equal(tighten('probe', 'add'), 'probe', 'probe 比 add 保守');
assert.equal(tighten('exit', 'exit'), 'exit');

// ===== 10. 闸门优先级：硬阻断 > 大盘 > 板块 =====

{
  // 硬阻断把上升持有收紧为等待
  const r = resolveMarketAction({
    phase: 'uptrend',
    hardBlocks: ['停牌'],
    marketRegimePhase: '主升',
    boardStageAction: 'lead',
  });
  assert.equal(r.action, 'wait', '硬阻断应把持有收紧为等待');
  assert.ok(r.reasons.some((x) => x.includes('硬阻断')));
}
{
  // 关键：硬阻断也必须走 tighten。wait 比 exit 激进，
  // 直接锁 wait 会把「下跌防守 + 停牌」的退出指令放大成观望，复牌后该退的仓位就丢了。
  const r = resolveMarketAction({
    phase: 'decline',
    hardBlocks: ['停牌'],
    marketRegimePhase: '主升',
    boardStageAction: 'lead',
  });
  assert.equal(r.action, 'exit', '硬阻断不得把下跌防守的退出放大成等待');
}
{
  // 板块阶段枚举出现未知值时必须收紧而非静默放行
  const r = resolveMarketAction({
    phase: 'uptrend',
    hardBlocks: [],
    marketRegimePhase: '主升',
    boardStageAction: 'some_new_enum_value',
  });
  assert.equal(r.action, 'wait', '未识别的板块动作应保守收紧');
  assert.ok(r.reasons.some((x) => x.includes('未识别')), '应留痕便于排查上游改名');
}
{
  // 大盘退潮把 hold 收紧为 wait
  const r = resolveMarketAction({
    phase: 'uptrend',
    hardBlocks: [],
    marketRegimePhase: '退潮',
    boardStageAction: null,
  });
  assert.equal(r.action, 'wait', '大盘退潮应收紧为等待');
}
{
  // 板块退幕把动作收紧为 exit
  const r = resolveMarketAction({
    phase: 'recovery',
    hardBlocks: [],
    marketRegimePhase: '主升',
    boardStageAction: 'exit_only',
  });
  assert.equal(r.action, 'exit', '板块退幕应收紧为退出');
}
{
  // 关键：板块「可追领涨」不得把标的的等待放大成加仓
  const r = resolveMarketAction({
    phase: 'bottoming',
    hardBlocks: [],
    marketRegimePhase: '主升',
    boardStageAction: 'lead',
  });
  assert.equal(
    r.action,
    PHASE_DEFAULT_ACTION.bottoming,
    '外部闸门只能收紧，不得把筑底观察放大成进攻',
  );
  assert.equal(r.action, 'wait');
}
{
  // 板块 hold_only 不得把 exit 放大成 hold
  const r = resolveMarketAction({
    phase: 'decline',
    hardBlocks: [],
    marketRegimePhase: '主升',
    boardStageAction: 'hold_only',
  });
  assert.equal(r.action, 'exit', 'hold_only 不得把下跌防守的退出放大成持有');
}
{
  // 硬阻断不得直接锁 wait：wait 比 exit 激进，停牌不该把该退的仓位变成观望
  const r = resolveMarketAction({
    phase: 'decline',
    hardBlocks: ['停牌'],
    marketRegimePhase: '主升',
    boardStageAction: null,
  });
  assert.equal(r.action, 'exit', '硬阻断只能朝 wait 收紧，不得覆盖更保守的退出指令');
}
{
  // 硬阻断也不能提前 return 跳过后续闸门：
  // 上升默认 hold + 板块 exit_only 本应收成 exit，多一条停牌不该反而变成 wait
  const withBlock = resolveMarketAction({
    phase: 'uptrend',
    hardBlocks: ['停牌'],
    marketRegimePhase: '主升',
    boardStageAction: 'exit_only',
  });
  const withoutBlock = resolveMarketAction({
    phase: 'uptrend',
    hardBlocks: [],
    marketRegimePhase: '主升',
    boardStageAction: 'exit_only',
  });
  assert.equal(withoutBlock.action, 'exit');
  assert.equal(withBlock.action, 'exit', '多一条硬阻断不得让输出比没有它时更激进');
}

// ===== 11. 确定性：同输入两次结果一致 =====

{
  const input = mkInput(UP, { prev: { phase: 'bottoming', pendingPhase: 'uptrend', pendingBars: 1, lastBarTime: null } });
  assert.equal(
    JSON.stringify(computePhase(input)),
    JSON.stringify(computePhase(input)),
    '阶段判定必须完全可复现',
  );
}

console.log(
  '✅ 阶段状态机自检通过（首次采纳 · 滞回累计与中断重置 · 破位不等待并记录结构破坏 · 未收完只预警 · 加速乖离 · 放量滞涨转分歧 · 缺证据进 uncertain · 闸门只收紧不放大 · 可复现）',
);
