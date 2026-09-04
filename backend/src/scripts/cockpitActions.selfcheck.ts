// 动作清单自检（无框架，assert 断言，不碰网络与数据库）。
//
// 钉住的是这一层「弄错了会让人亏钱」的几条，不是覆盖率：
//   1. 排序按不做的代价：止损永远在买入前面
//   2. 风险检查没就绪时，买入类必须被挡住
//   3. 同标的合并时股数不相加
//   4. P0 永不被截断
//   5. 触发原因未记录时不猜成任何一种
//   6. 数据过期与取数失败要能区分
//
// 运行：cd backend && pnpm exec tsx src/scripts/cockpitActions.selfcheck.ts
import assert from 'node:assert/strict';
import type { CockpitAction, SourceFreshness } from '@stock-agent/shared';
import {
  COCKPIT_ACTION_EMPTY_TEXT,
  PLAN_TRIGGER_UNKNOWN_TEXT,
  ACTION_DATA_SOURCE_LABELS,
  FRESHNESS_OUTAGE_DAYS,
} from '@stock-agent/shared';
import { prevTradingDay } from '../market/calendar';
import { expectedSnapshotDate } from '../scheduling/snapshotWindow';
import {
  __test__capTiers,
  __test__gateOpportunities,
  __test__mergeByCode,
  __test__sortActions,
} from '../cockpit/actions';
import { judgeFreshness, summarizeFreshness, RISK_SOURCES } from '../cockpit/freshness';
import { applyLiveOverlay, distanceText } from '../cockpit/liveOverlay';
import { isJunkBoard } from '../breadth/service';

function mk(p: Partial<CockpitAction> & Pick<CockpitAction, 'priority' | 'kind'>): CockpitAction {
  return {
    id: `${p.kind}:${p.code ?? '-'}`,
    readiness: 'actionable',
    code: null,
    name: null,
    what: '',
    when: '',
    why: '',
    blockedReason: null,
    evidence: [],
    basisSources: [],
    dataAt: null,
    live: null,
    distancePct: null,
    distanceTo: null,
    ...p,
  };
}

// ===== 1. 排序：止损永远排在买入前面 =====
{
  const sorted = __test__sortActions([
    mk({ priority: 'P2', kind: 'buy_triggered', code: '600000' }),
    mk({ priority: 'P0', kind: 'stop_loss', code: '600519' }),
    mk({ priority: 'P3', kind: 'observe', code: '000001' }),
    mk({ priority: 'P1', kind: 'overweight', code: '600036' }),
  ]);
  assert.deepEqual(
    sorted.map((a) => a.kind),
    ['stop_loss', 'overweight', 'buy_triggered', 'observe'],
    '必须按不做的代价排：止损 > 超仓 > 买入 > 观察',
  );
}

// P2 内部：可执行 > 正在接近 > 还要人筛
{
  const sorted = __test__sortActions([
    mk({ priority: 'P2', kind: 'candidate', readiness: 'screening', code: '600000' }),
    mk({ priority: 'P2', kind: 'near_buy', readiness: 'approaching', code: '600001' }),
    mk({ priority: 'P2', kind: 'buy_triggered', readiness: 'actionable', code: '600002' }),
  ]);
  assert.deepEqual(
    sorted.map((a) => a.readiness),
    ['actionable', 'approaching', 'screening'],
    'P2 内部按现在能不能执行排',
  );
}

// 同档 ETF 优先于个股（先锁赛道再选龙头）
{
  const sorted = __test__sortActions([
    mk({ priority: 'P2', kind: 'near_buy', readiness: 'approaching', code: '600519' }),
    mk({ priority: 'P2', kind: 'near_buy', readiness: 'approaching', code: '159516' }),
  ]);
  assert.equal(sorted[0].code, '159516', '同档 ETF 排在个股前面');
}

// ===== 2. 风险检查没就绪时，买入类必须被挡住 =====
{
  const list = [
    mk({ priority: 'P0', kind: 'stop_loss', code: '600519' }),
    mk({ priority: 'P2', kind: 'buy_triggered', code: '600000' }),
    mk({ priority: 'P2', kind: 'rotate', code: '159516' }),
    mk({ priority: 'P1', kind: 'board_fading', code: '600036' }),
  ];
  const gated = __test__gateOpportunities(list, false);
  const buy = gated.find((a) => a.kind === 'buy_triggered')!;
  const rot = gated.find((a) => a.kind === 'rotate')!;
  const stop = gated.find((a) => a.kind === 'stop_loss')!;
  assert.equal(buy.readiness, 'blocked', '风险没查完时买入必须被挡');
  assert.equal(rot.readiness, 'blocked', '换仓同样是买入侧，一并挡住');
  assert.ok(buy.blockedReason, '挡住必须说明原因，否则用户不知道为什么点不了');
  assert.notEqual(stop.readiness, 'blocked', '止损绝不能被挡——它正是风险本身');

  const open = __test__gateOpportunities(list, true);
  assert.equal(
    open.find((a) => a.kind === 'buy_triggered')!.readiness,
    'actionable',
    '风险就绪后买入恢复可执行',
  );
}

// ===== 3. 同标的合并：风险压过增仓，股数不相加 =====
{
  const merged = __test__mergeByCode([
    mk({
      priority: 'P2',
      kind: 'buy_triggered',
      code: '600519',
      what: '买入 1000 股',
      why: '买点到了',
      evidence: [{ label: '今日计划', route: '/plan' }],
    }),
    mk({
      priority: 'P0',
      kind: 'stop_loss',
      code: '600519',
      what: '减 1200 股（留到 3000 股以内）',
      why: '已跌破止损线',
      evidence: [{ label: '持仓与纪律', route: '/positions' }],
    }),
  ]);
  assert.equal(merged.length, 1, '同一标的必须合成一条，两条并列会让人两件都做');
  const m = merged[0];
  assert.equal(m.kind, 'stop_loss', '风险压过增仓');
  assert.equal(m.what, '减 1200 股（留到 3000 股以内）', '只保留胜出那条的动作，股数不相加');
  assert.ok(!m.what.includes('买入'), '合并后不得同时出现买与卖的动作');
  assert.ok(m.why.includes('买点到了'), '被压下去的那条要在理由里交代，不能凭空消失');
  assert.equal(m.evidence.length, 2, '两条的证据入口都要保留');
}

// 不同标的不合并
{
  const merged = __test__mergeByCode([
    mk({ priority: 'P0', kind: 'stop_loss', code: '600519' }),
    mk({ priority: 'P0', kind: 'stop_loss', code: '600036' }),
  ]);
  assert.equal(merged.length, 2, '不同标的各自成条');
}

// ===== 4. P0 永不截断 =====
{
  const many = [
    ...Array.from({ length: 12 }, (_, i) =>
      mk({ priority: 'P0' as const, kind: 'stop_loss' as const, code: `60000${i}` }),
    ),
    ...Array.from({ length: 12 }, (_, i) =>
      mk({ priority: 'P2' as const, kind: 'candidate' as const, code: `30000${i}` }),
    ),
  ];
  const { kept, omitted } = __test__capTiers(many);
  assert.equal(kept.filter((a) => a.priority === 'P0').length, 12, 'P0 一条都不能少');
  assert.ok(kept.filter((a) => a.priority === 'P2').length < 12, 'P2 该折就折');
  assert.ok(omitted > 0, '折叠掉的条数要报出来');
}

// ===== 4b. 机会区按类型限额：某一类不得把别的类整类挤掉 =====
{
  // 板块机会排序靠前，若按整档总额限制，它会把选股候选整类吃光——
  // 于是「今天有哪些股票值得看」在界面上又没有答案了
  const many = [
    ...Array.from({ length: 8 }, (_, i) =>
      mk({
        priority: 'P2' as const,
        kind: 'board_leading' as const,
        readiness: 'approaching' as const,
        code: `5150${i}0`,
      }),
    ),
    ...Array.from({ length: 8 }, (_, i) =>
      mk({
        priority: 'P2' as const,
        kind: 'candidate' as const,
        readiness: 'screening' as const,
        code: `60000${i}`,
      }),
    ),
  ];
  const { kept } = __test__capTiers(__test__sortActions(many));
  const kinds = new Set(kept.map((a) => a.kind));
  assert.ok(kinds.has('board_leading'), '板块机会要留得下');
  assert.ok(kinds.has('candidate'), '选股候选不能被板块整类挤掉');
  for (const k of kinds) {
    const n = kept.filter((a) => a.kind === k).length;
    assert.ok(n <= 4, `每类机会最多 4 条，${k} 实际 ${n}`);
  }
}

// ===== 4c. 机会区不得把平台聚合桶当成板块推荐 =====
{
  // 这些不是行业也不是题材，成分每天换一批。「热股里有 12 只创新高」
  // 说明不了任何赛道在走强，却会挤掉真板块的位置
  for (const junk of ['东方财富热股', '题材股', '龙虎榜活跃', '北向资金重仓']) {
    assert.ok(isJunkBoard(junk), `${junk} 属于平台聚合桶，不该作为板块机会推荐`);
  }
  // 真板块不能被误杀
  for (const real of ['医药生物', '煤炭开采', '半导体设备', '光模块', '焦煤']) {
    assert.ok(!isJunkBoard(real), `${real} 是真板块，不能被过滤掉`);
  }
}

// ===== 5. 触发原因未记录时不猜 =====
{
  // 这里钉的是文案常量本身：任何地方拿它当默认值都不会变成某个具体触发类型
  assert.ok(
    PLAN_TRIGGER_UNKNOWN_TEXT.includes('未记录'),
    '原因缺失必须明说未记录，不能填一个具体触发类型',
  );
  assert.ok(
    !/止损|买点|止盈|卖点/.test(PLAN_TRIGGER_UNKNOWN_TEXT),
    '缺失文案里不得出现任何具体触发类型，否则等于猜',
  );
}

// ===== 6. 新鲜度：过期与失败必须能区分 =====
{
  const today = new Date().toISOString().slice(0, 10);

  // 板块快照 15:25 才产出，未到点时「上一交易日的」就是最新的，不能判过期——
  // 上一版就是这里判错，导致整个交易日买入动作被永久挡住。
  //
  // 基准必须问 expectedSnapshotDate 而不是写死「昨天」：这个断言的正确答案随当前时刻变化，
  // 写死的话跑在 15:25 之后就会自己失败（实测踩到过）。
  const expected = expectedSnapshotDate('breadth');
  const atExpected = judgeFreshness('boards', expected);
  assert.equal(atExpected.state, 'ok', '正好等于预期快照日的数据必须判新鲜');
  assert.equal(atExpected.behindDays, 0, '及时的数据落后天数为 0');

  // 落后一个交易日：算过期但还不到断供
  const staleOne = judgeFreshness('boards', prevTradingDay(expected));
  assert.equal(staleOne.state, 'stale', '落后 1 个交易日算过期');
  assert.equal(staleOne.behindDays, 1, '落后天数按交易日算');

  // 断供：与「过期」必须是两种状态，否则三周没跑会被当成日常黄灯忽略
  const dead = judgeFreshness('boards', '2020-01-01');
  assert.equal(dead.state, 'outage', '落后多个交易日必须升级为断供');
  assert.ok((dead.behindDays ?? 0) >= FRESHNESS_OUTAGE_DAYS, '断供门槛按交易日计');
  assert.ok(dead.note.includes('2020-01-01'), '断供要说清最新停在哪天');
  assert.ok(dead.note.includes('交易日'), '断供要说清落后多久，而不只是「不是今天的」');

  const failedOne = judgeFreshness('positions', null, '接口 500');
  assert.equal(failedOne.state, 'failed', '取数失败与过期是两回事');

  const missingOne = judgeFreshness('plan', null);
  assert.equal(missingOne.state, 'missing', '没有数据与取数失败也要分开');

  // 后台预热中不是失败：标成 failed 会让人去排查一个不存在的故障
  const pending = judgeFreshness('rotation', null, undefined, '还在后台算');
  assert.equal(pending.state, 'missing', '预热中必须判 missing 而不是 failed');
  assert.equal(pending.note, '还在后台算', '预热说明要如实透传');

  // 取到了但过期，绝不能被当成 ok——这正是这层存在的理由
  assert.notEqual(staleOne.state, 'ok', '过期数据不得判为可用');
}

// 风险三源任一不 ok，riskReady 就为假
{
  const allOk: SourceFreshness[] = RISK_SOURCES.map((s) =>
    judgeFreshness(s, new Date().toISOString().slice(0, 10)),
  );
  assert.equal(summarizeFreshness(allOk).riskReady, true, '三源都新鲜时放行');

  const oneBad = [...allOk.slice(1), judgeFreshness(RISK_SOURCES[0], null, '取不到')];
  const sum = summarizeFreshness(oneBad);
  assert.equal(sum.riskReady, false, '风险源缺一就不放行');
  assert.ok(sum.summary.includes('检查不了'), '不放行要说人话，不能只给个 false');
}

// 非风险源过期不影响风险闸门（否则轮动挂了就没法止损了）
{
  const rows = [
    ...RISK_SOURCES.map((s) => judgeFreshness(s, new Date().toISOString().slice(0, 10))),
    judgeFreshness('rotation', null, 'ETF 源超时'),
  ];
  const sum = summarizeFreshness(rows);
  assert.equal(sum.riskReady, true, '轮动取不到不该挡住止损与买入判断');
  assert.ok(sum.summary.includes('不完整'), '仍要如实说部分数据不完整');
}

// ===== 7. 实时距离的方向不能算反 =====
{
  // 止损是**跌破**生效：现价 1.174 在止损线 1.327 下方 = 已经破了，不是「还有 13%」。
  // 这条算反过一次，界面显示「距止损线还有 13.0%」，读起来像还早着呢
  const broken = applyLiveOverlay(
    [
      mk({
        priority: 'P0',
        kind: 'stop_loss',
        code: '588200',
        distanceTo: { label: '止损线', price: 1.327, cross: 'below' },
      }),
    ],
    new Map([['588200', { price: 1.174, changePct: -2.41, at: new Date().toISOString() }]]),
  )[0];
  assert.ok(
    (broken.distancePct ?? 0) < 0,
    `跌破止损必须是负距离（已越过），实际 ${broken.distancePct}`,
  );
  assert.ok(distanceText(broken).includes('跌破'), '已破止损要说「跌破」，不能只说「越过」');

  // 还没破：现价在止损线上方
  const safe = applyLiveOverlay(
    [
      mk({
        priority: 'P1',
        kind: 'near_stop',
        code: '159516',
        distanceTo: { label: '止损线', price: 0.671, cross: 'below' },
      }),
    ],
    new Map([['159516', { price: 0.721, changePct: -2.96, at: new Date().toISOString() }]]),
  )[0];
  assert.ok((safe.distancePct ?? 0) > 0, '还在止损线上方应为正距离');
  assert.ok(distanceText(safe).includes('还有'), '未破止损要说还有多远');

  // 突破买点方向相反：涨过才算到位
  const notYet = applyLiveOverlay(
    [mk({ priority: 'P2', kind: 'near_buy', code: '600000', distanceTo: { label: '买点', price: 11, cross: 'above' } })],
    new Map([['600000', { price: 10, changePct: 0, at: new Date().toISOString() }]]),
  )[0];
  assert.ok((notYet.distancePct ?? 0) > 0, '还没涨到突破买点应为正距离');

  // 取不到行情：不得编距离，也不得沿用旧价
  const noQuote = applyLiveOverlay(
    [mk({ priority: 'P0', kind: 'stop_loss', code: '999999', distanceTo: { label: '止损线', price: 1, cross: 'below' } })],
    new Map(),
  )[0];
  assert.equal(noQuote.live, null, '取不到行情时 live 必须为 null');
  assert.equal(noQuote.distancePct, null, '没有实时价就不能给距离');
  assert.ok(distanceText(noQuote).includes('取不到'), '要如实说行情取不到，而不是留空让人以为没差距');
}

// ===== 8. 空清单四态文案各不相同 =====
{
  const vals = Object.values(COCKPIT_ACTION_EMPTY_TEXT);
  assert.equal(new Set(vals).size, vals.length, '四种空状态的说法必须各不相同');
  assert.ok(
    COCKPIT_ACTION_EMPTY_TEXT.risk_checking !== COCKPIT_ACTION_EMPTY_TEXT.all_clear,
    '「还没查完」与「今天没事做」是两回事，绝不能混为一谈',
  );
  assert.equal(Object.keys(ACTION_DATA_SOURCE_LABELS).length, 6, '六个数据来源都要有中文名');
}

console.log('cockpitActions.selfcheck 全部通过');
