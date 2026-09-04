<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '@/api';
import type {
  CandidateLevelSource,
  KlinePeriod,
  PlanCondition,
  SymbolMarketPhase,
  SymbolPlanAction,
  SymbolPlanEvaluation,
  SymbolPlanProjection,
  SymbolPlanStatus,
  SymbolTradePlan,
  TradeLevel,
} from '@stock-agent/shared';
import {
  PLAN_SPAN_LABEL,
  cadenceOf,
  isPlanLive,
  planConditionProgress,
  planSpanOf,
  rescaleSharesToEntry,
} from '@stock-agent/shared';
import { pickLevelByRolePriority, splitBatchShares } from '@/composables/planMath';

/**
 * 标的交易计划面板。首屏只给「一个阶段 + 一个主动作 + 三条关键线」，
 * 专业证据放折叠区，避免同时出现互相冲突的建议（计划 10.2 / 10.3）。
 */
const props = defineProps<{
  code: string;
  name?: string;
  /**
   * 东方财富证券 id。指数/ETF 的日线只能按 secid 取，不透传取不到 K 线，
   * 推演接口会 500，整块「情景可能性」会无故消失。
   */
  secid?: string;
}>();
/** 空状态一键生成：由父组件切到 Agent 页签并触发计划生成 */
const emit = defineEmits<{ generate: [] }>();

const plan = ref<SymbolTradePlan | null>(null);
const loading = ref(false);
const evaluating = ref(false);
const loadError = ref('');
const evaluation = ref<SymbolPlanEvaluation | null>(null);
/** 展开的证据区块 */
const openPanels = ref<string[]>([]);

/** 周期中文名，用于逐条件的触发口径文案 */
const PERIOD_LABEL: Partial<Record<KlinePeriod, string>> = {
  week: '周线',
  day: '日线',
  '60m': '60分钟',
  '30m': '30分钟',
  '15m': '15分钟',
};

/**
 * 单条件的触发口径。计划级不再有统一的 triggerMode——
 * 同一份计划里「上穿 12.30」是盘中 tick 判、「周线收在 MA20 上方」要等周五收盘，
 * 早先用一个计划级字段一刀切，界面上给的口径跟实际怎么判是脱节的。
 */
function triggerLabel(c: PlanCondition): string {
  if (cadenceOf(c) === 'tick') return '盘中触发';
  return `${PERIOD_LABEL[c.timeframe] ?? c.timeframe}收盘确认`;
}

const PHASE_LABEL: Record<SymbolMarketPhase, string> = {
  decline: '下跌防守',
  bottoming: '筑底观察',
  recovery: '右侧修复',
  uptrend: '上升持有',
  acceleration: '加速谨慎',
  distribution: '高位分歧',
  uncertain: '不确定',
};

const ACTION_LABEL: Record<SymbolPlanAction, string> = {
  wait: '等待',
  probe: '小仓试错',
  add: '加仓',
  hold: '持有',
  reduce: '减仓',
  exit: '退出',
};

/** 阶段配色：防守类偏绿（跌）、进攻类偏红（涨），与 A 股红涨绿跌一致 */
const PHASE_TONE: Record<SymbolMarketPhase, string> = {
  decline: 'is-down',
  bottoming: 'is-flat',
  recovery: 'is-up',
  uptrend: 'is-up',
  acceleration: 'is-warn',
  distribution: 'is-warn',
  uncertain: 'is-flat',
};

/** 请求令牌：快速切换标的/车道时先发后到的响应必须丢弃，否则会把旧车道的计划显示成新车道 */
let loadToken = 0;

/**
 * @param autoReview 是否顺带自动复核。自动复核发现状态迁移后会回读一次，
 * 那次回读必须传 false：若服务端算出的状态始终与库里存的不一致
 * （例如某些状态不落库），复核与回读就会无限互相触发，把面板打成请求风暴。
 */
async function load(autoReview = true): Promise<void> {
  if (!props.code) return;
  const t = ++loadToken;
  loading.value = true;
  loadError.value = '';
  evaluation.value = null;
  // 不清的话切标的时会把上一只的情景概率挂在新标的下面，直到新响应回来
  projection.value = null;
  try {
    // 取最新一版而非生效版：失效计划也要能看见，否则计划一失效面板就整片空白，
    // 既看不到失效原因，也看不到那份计划究竟写了什么。是否可执行由 isLive 区分
    const p = await api.symbolPlans.latest(props.code);
    if (t !== loadToken) return;
    plan.value = p;
  } catch (e) {
    if (t !== loadToken) return;
    loadError.value = e instanceof Error ? e.message : String(e);
    plan.value = null;
  } finally {
    if (t === loadToken) loading.value = false;
  }
  if (t === loadToken && plan.value) {
    if (autoReview) void autoEvaluate(t);
    // 概率取自生效计划的情景，计划已失效时后端必然返回空情景，
    // 这一趟只是白取 200 根 K 线
    if (isLive.value) void loadProjection(t);
  }
}

/**
 * 打开面板即自动复核一次。
 *
 * 这条路径是纯计算 + 取 K 线，不调 LLM，没有理由要求用户先点一下按钮才肯告诉他
 * 「五条触发条件已经满足三条」——不点就只能看到一列没有状态的灰点，
 * 而条件命中与否恰恰是决定今天要不要动手的那个信息。
 *
 * 不复用 reevaluate：那个函数末尾会 load()，从这里调就成了死循环。
 * 复核可能让服务端迁移计划状态，故仅在状态确实变了时才回读一次，避免每次打开都两趟请求。
 *
 * 已失效的计划照样复核：终态不会被改回去（resolveOutcome 沿用原状态），
 * 但失效横幅要靠这次的 conditions 才能说出「是哪一条失效条件命中的」。
 */
async function autoEvaluate(token: number): Promise<void> {
  const p = plan.value;
  if (!p) return;
  try {
    const ev = await api.symbolPlans.evaluate(p.id);
    if (token !== loadToken) return;
    evaluation.value = ev;
    if (ev.status !== p.status) {
      await load(false);
      // load 会清掉 evaluation（换标的时必须清），但这次回读是同一份计划的同一次复核，
      // 结果仍然有效。不还原的话「刚刚判失效」这一次恰好没有命中条件可报，
      // 横幅只能给中性文案——而这正是最需要说清「是哪一条失效了」的时刻。
      if (token === loadToken) evaluation.value = ev;
    }
  } catch {
    // 复核失败不打扰：计划本身已经显示出来了，缺的只是命中态
  }
}

async function reevaluate(): Promise<void> {
  if (!plan.value || evaluating.value) return;
  evaluating.value = true;
  try {
    evaluation.value = await api.symbolPlans.evaluate(plan.value.id);
    ElMessage.success(evaluation.value.summary);
    // 状态可能已迁移，重新拉一次；刚复核过，不必再自动复核一遍
    await load(false);
  } catch (e) {
    ElMessage.error(`复核失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    evaluating.value = false;
  }
}

/** 计划是否仍可执行。口径与后端共用（shared 的 isPlanLive），不在这里另写一份状态白名单 */
const isLive = computed(() => (plan.value ? isPlanLive(plan.value.status) : false));

const STATUS_LABEL: Record<SymbolPlanStatus, string> = {
  draft: '草稿',
  active: '生效中',
  triggered: '已触发',
  invalid: '已失效',
  completed: '已完成',
  expired: '已过期',
  superseded: '已被新版替代',
};

/**
 * 后端时间戳一律是 UTC（nowIso），直接截字符串会把 18:21 失效显示成 10:21，
 * 而这个横幅存在的意义就是告诉用户「什么时候失效的」。
 */
function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 风险路径触发提示。
 *
 * 后端已把 invalidated 的语义收窄到「非风险情景失效」——风险情景条件命中走 triggered，
 * 因为「价格真的跌下来」正是风险情景兑现，不是整份计划作废。但计划因此仍是生效状态，
 * 若界面不专门说一句，用户就拿不到那条减仓/清仓指令。
 */
const riskTriggered = computed<{ action: string; reasons: string[] } | null>(() => {
  const hits = (evaluation.value?.triggeredScenarios ?? []).filter((s) => s.rank === 'risk');
  if (hits.length === 0) return null;
  const p = plan.value;
  const byId = new Map((p?.scenarios ?? []).map((s) => [s.id, s]));
  const satisfied = new Set(
    (evaluation.value?.conditions ?? []).filter((c) => c.satisfied).map((c) => c.conditionId),
  );
  const reasons = [
    ...new Set(
      hits.flatMap((h) => {
        const sc = byId.get(h.scenarioId);
        if (!sc) return [];
        // 触发与失效两边都要列：条件可双用途，同一条件既是该情景的减仓触发也是它的失效条件，
        // 后端对同一情景只回一条命中记录（带哪个 via 取决于哪边先判出），
        // 按 via 二选一会漏掉另一边真正满足的条件
        return [...sc.conditions, ...sc.invalidConditions]
          .filter((c) => satisfied.has(c.id))
          .map((c) => c.description);
      }),
    ),
  ];
  return { action: ACTION_LABEL[hits[0].action] ?? hits[0].action, reasons };
});

/**
 * 失效横幅。计划一旦不再生效，正文照常展开供复盘，但顶部必须写清「什么时候、因为哪一条」。
 *
 * 原因优先取本次复核里真正命中的失效条件——那是实时算出来的，与状态迁移同源。
 * 复核还没回来或取不到时给中性文案，绝不按状态反推一个听起来合理的原因。
 */
const staleBanner = computed<{ text: string; reason: string } | null>(() => {
  const p = plan.value;
  if (!p || isLive.value) return null;
  const hitIds = new Set(
    (evaluation.value?.conditions ?? []).filter((c) => c.satisfied).map((c) => c.conditionId),
  );
  const hit = [
    ...new Set(
      p.scenarios
        .flatMap((s) => s.invalidConditions)
        .filter((c) => hitIds.has(c.id))
        .map((c) => c.description),
    ),
  ];
  return {
    text: `v${p.version} ${STATUS_LABEL[p.status]}（${localTime(p.updatedAt)}）`,
    reason:
      hit.length > 0
        ? `命中失效条件：${hit.join('、')}`
        : '以下内容为该版计划的最后状态，仅供复盘',
  };
});

/**
 * 候选来源 → 中文。用于在关键线旁标明「这条线是怎么来的」——
 * 只给一个价格数字，用户无从判断它是随口给的还是有结构依据的。
 */
const SOURCE_LABEL: Record<CandidateLevelSource, string> = {
  swing: '摆动点',
  pivot_zone: '中枢边沿',
  prev_extreme: '前高前低',
  ma: '均线',
  classic_pivot: '经典枢轴',
  fibonacci: '黄金分割',
  adapter: '执行位',
};

/** 价位来源文案；老计划没有 sources 字段，返回空串即不显示，不编造来源 */
function sourceText(l?: TradeLevel): string {
  const s = l?.sources;
  if (!s || s.length === 0) return '';
  return s.map((x) => SOURCE_LABEL[x] ?? x).join(' + ');
}

function fmtLevel(l?: TradeLevel): string {
  if (!l) return '—';
  if (l.price != null) return l.price.toFixed(3);
  if (l.zoneLow != null && l.zoneHigh != null) return `${l.zoneLow.toFixed(3)}~${l.zoneHigh.toFixed(3)}`;
  return '—';
}

/**
 * 可下单指令要拿它去算股数，故除展示文案外还带一个可算的数。
 * 区间型价位取上沿：突破要站上整个带，取中值会在价格还在带内时就报成交。
 */
function rawPriceOf(l?: TradeLevel): number | null {
  return l?.price ?? l?.zoneHigh ?? l?.zoneLow ?? null;
}

/**
 * 从给定价位里取三条关键线：触发 / 结构失效 / 第一目标。
 *
 * 传进来的必须是已按持有时长筛过的子集。早先是在全部价位里 find 第一个角色匹配项，
 * 完全无视 timeframe——于是「你现在应加仓，突破 13.45 改变动作」里的 13.45
 * 可能是一条周线压力位，读起来像明天的事，实际是几个月的事。
 */
function buildKeyLines(levels: TradeLevel[], exitPlan: SymbolTradePlan['exitPlan']) {
  // roles 表达的是优先级顺序，取值必须按它来（见 pickLevelByRolePriority）
  const pick = (roles: string[]): TradeLevel | undefined =>
    pickLevelByRolePriority(levels, roles);
  const trigger = pick(['entry_trigger', 'add_trigger', 'resistance']);
  const invalid = pick(['invalidation', 'stop', 'support']);
  const target =
    levels.find((l) => l.id === exitPlan.firstTakeProfitLevelId) ?? pick(['target']);
  return [
    { label: '触发线', value: fmtLevel(trigger), tone: 'is-up', detail: trigger?.label ?? '', source: sourceText(trigger), rawPrice: rawPriceOf(trigger) },
    { label: '结构失效线', value: fmtLevel(invalid), tone: 'is-down', detail: invalid?.label ?? '', source: sourceText(invalid), rawPrice: rawPriceOf(invalid) },
    { label: '第一目标', value: fmtLevel(target), tone: 'is-warn', detail: target?.label ?? '', source: sourceText(target), rawPrice: rawPriceOf(target) },
  ];
}

/**
 * 按持有时长分成两栏。只有该栏确实有价位时才出这一栏——
 * 空栏摆三个「—」会让人以为计划漏了东西，实际是这个时长上本来就没结论。
 */
const keyLineGroups = computed(() => {
  const p = plan.value;
  if (!p) return [];
  return (['short', 'long'] as const)
    .map((span) => ({
      span,
      label: PLAN_SPAN_LABEL[span],
      levels: p.levels.filter((l) => planSpanOf(l.timeframe) === span),
    }))
    .filter((g) => g.levels.length > 0)
    .map((g) => ({ span: g.span, label: g.label, lines: buildKeyLines(g.levels, p.exitPlan) }));
});

/**
 * 供行动句式与可下单指令使用的那一组线。
 * 优先取短期栏：主动作说的是「你现在应怎么做」，配一条几个月尺度的触发价是答非所问。
 * 短期栏没有可用触发价时才退到中长期，退了也不隐瞒——分栏本身已经把时长写在标题上。
 */
const keyLines = computed(() => {
  const groups = keyLineGroups.value;
  if (groups.length === 0) return [];
  return (groups.find((g) => g.span === 'short' && g.lines[0].rawPrice != null) ?? groups[0]).lines;
});

/** 建仓类动作才需要挂单指令；持有/等待类给的是「不动」，报股数只会诱导多余交易 */
const BUY_ACTIONS: SymbolPlanAction[] = ['probe', 'add'];
const SELL_ACTIONS: SymbolPlanAction[] = ['reduce', 'exit'];

function fmtAmount(v: number): string {
  return v >= 10000 ? `${(v / 10000).toFixed(1)} 万` : `${Math.round(v)} 元`;
}

/** 分批股数文案，边界语义见 splitBatchShares */
function splitBatches(shares: number, fractions: number[]): string[] {
  return splitBatchShares(shares, fractions).map((n) => `${n} 股`);
}

/**
 * 可下单指令：把「持有 / 减仓」这类动词换算成挂单价 + 股数 + 金额 + 分批。
 *
 * 股数不直接用 risk.allowedShares：那是按现价算的，而计划要求在触发价才进场。
 * 触发价更高 → 到止损的距离更大 → 同样风险预算下能买的股数更少，
 * 照搬现价股数会让实际亏损超出「单笔最多亏 x%」的约定。换算见 rescaleSharesToEntry。
 */
const orderInstruction = computed<{ text: string; note: string } | null>(() => {
  const p = plan.value;
  // 已失效/过期的计划不给挂单价与股数：那份价位所依据的结构已经被行情否掉了，
  // 照它下单是拿一份作废的判断去成交，比不给指令危险得多
  if (!p || !isLive.value) return null;
  const r = p.risk;
  const isBuy = BUY_ACTIONS.includes(p.primaryAction);
  const isSell = SELL_ACTIONS.includes(p.primaryAction);
  if (!isBuy && !isSell) return null;

  if (isSell) {
    // exit 是清仓，不能用 reduceShares：那个数只是「超出风险预算的那部分」，
    // 仓位恰好在预算内时它是 0，照它显示会在计划写着「退出」时告诉用户无需减持。
    const held = p.positionContext?.availableQuantity ?? null;
    const shares = p.primaryAction === 'exit' ? held : r.reduceShares;
    if (shares == null) {
      return {
        text:
          p.primaryAction === 'exit'
            ? '未接入账户，只能给结论：清仓退出，股数按你的实际持仓全额卖出。'
            : '未接入账户，只能给百分比：按上方建议仓位上限自行折算减持股数。',
        note: '',
      };
    }
    if (shares <= 0) {
      return {
        text: p.primaryAction === 'exit' ? '当前无持仓，无需退出。' : '当前持仓未超风险预算，无需减持。',
        note: '',
      };
    }
    const fracs = p.exitPlan.reduceFractions.filter((f) => f > 0 && f <= 1);
    return {
      text: `${p.primaryAction === 'exit' ? '清仓卖出' : '减持'} ${shares} 股`,
      note: fracs.length > 1 ? `分 ${fracs.length} 批：${splitBatches(shares, fracs).join(' → ')}` : '',
    };
  }

  const trigger = keyLines.value[0]?.rawPrice ?? null;
  const stop = r.executionStop ?? r.structuralStop;
  const basis = r.sizingBasisPrice;
  if (r.allowedShares == null) {
    return {
      text: '未接入账户，只能给百分比：请按上方「建议仓位上限」自行折算股数。',
      note: '',
    };
  }
  // 触发价缺失（观察计划没有可执行触发位）时退回基准价，并在说明里写清按的是现价
  const entry = trigger ?? basis;
  if (entry == null || stop == null || basis == null) {
    return { text: `风险预算允许 ${r.allowedShares} 股`, note: '缺触发价或止损价，未做挂单价换算' };
  }
  // 买入类动作必须满足 entry > stop：否则 shares×(entry−stop) 会算成负数，
  // 界面上就出现「单笔最大亏损约 -3000 元」。这种计划本身自相矛盾，
  // 不能给股数与金额去引导下单，只能明确说清哪里对不上。
  if (entry <= stop) {
    return {
      text: '该计划的触发价不高于止损价，无法换算股数，请先让 Agent 重新出计划。',
      note: `触发价 ${entry.toFixed(3)} ≤ 止损价 ${stop.toFixed(3)}，买入方向不成立`,
    };
  }
  const shares = rescaleSharesToEntry(r.allowedShares, basis, entry, stop) ?? 0;
  if (shares <= 0) {
    return {
      text: '按当前风险预算，在触发价买入不足一手，本次不建仓。',
      note: `触发价 ${entry.toFixed(3)} 距止损 ${stop.toFixed(3)} 过远`,
    };
  }
  const amount = shares * entry;
  // 亏损按「挂单价到止损价」实算，不用 effectiveLossPct×挂单价：
  // 那个百分比锚在现价上，股数换算后两者不再对应，会报出一个跟风险预算对不上的数。
  // executionStop 已含跳空与成本缓冲，故 shares×(entry−stop) 就是换算后应当守住的预算。
  const parts = [
    `${trigger == null ? '现价' : '触发价'} ${entry.toFixed(3)} 挂单买入 ${shares} 股（约 ${fmtAmount(amount)}）`,
    `跌破 ${stop.toFixed(3)} 止损`,
    `单笔最大亏损约 ${fmtAmount(shares * (entry - stop))}`,
  ];
  return {
    text: parts.join('，'),
    note:
      trigger == null
        ? '计划无可执行触发位，股数按现价折算'
        : `股数已按现价 ${basis.toFixed(3)} → 触发价 ${entry.toFixed(3)} 等比缩减，保持单笔风险不超 ${r.maxAccountRiskPct}%`,
  };
});

/** 首屏固定行动句式（计划 10.2） */
const actionSentence = computed(() => {
  const p = plan.value;
  if (!p) return '';
  const trig = keyLines.value[0]?.value ?? '—';
  const inval = keyLines.value[1]?.value ?? '—';
  return (
    `当前处于【${PHASE_LABEL[p.marketPhase]}】；你现在应【${ACTION_LABEL[p.primaryAction]}】；` +
    `只有【${trig}】被有效突破才改变动作；跌破【${inval}】进入防守。`
  );
});

const primaryScenario = computed(() => plan.value?.scenarios.find((s) => s.rank === 'primary') ?? null);
const otherScenarios = computed(() => plan.value?.scenarios.filter((s) => s.rank !== 'primary') ?? []);

/** 条件状态索引：模板里每个条件要查两三次，线性查找会退化成 O(n²)，这里一次建表 */
const condStates = computed(() => {
  const m = new Map<string, SymbolPlanEvaluation['conditions'][number]>();
  for (const c of evaluation.value?.conditions ?? []) m.set(c.conditionId, c);
  return m;
});

/** 条件状态查表，供复核后在条件旁标注 */
function condState(id: string): SymbolPlanEvaluation['conditions'][number] | undefined {
  return condStates.value.get(id);
}

/** 主路径触发条件的待办进度（必要条件置顶、还差哪几条），排序与计数口径见 planConditionProgress */
const progress = computed(() =>
  planConditionProgress(primaryScenario.value?.conditions ?? [], (id) => condState(id)?.satisfied),
);

const primaryConditions = computed(() => progress.value.ordered);

const conditionProgress = computed<{ text: string; done: number; total: number } | null>(() => {
  const { done, total, missing } = progress.value;
  if (total === 0) return null;
  // 计划已失效时不报「还差哪几条」：那是「照着做就能进场」的行动指引，
  // 而这份计划已经作废，凑齐剩下的条件也不会让它复活
  if (!isLive.value) return { text: `共 ${total} 条（失效时的条件快照）`, done, total };
  if (!evaluation.value) return { text: `共 ${total} 条，复核中…`, done: 0, total };
  const tail =
    missing.length === 0 ? '，全部满足' : `，还差：${missing.map((c) => c.description).join('、')}`;
  return { text: `共 ${total} 条，已满足 ${done} 条${tail}`, done, total };
});

/**
 * 时间止损换成日历口径。「10 根」要用户自己知道这是日线、再自己除以 5 才知道是两周，
 * 而这个数存在的意义恰恰是「等多久还不动就撤」——那就该直接用等多久的说法。
 */
const timeStopText = computed(() => {
  const bars = plan.value?.risk.timeStopBars;
  if (bars == null || bars <= 0) return '未设定';
  if (bars < 5) return `约 ${bars} 个交易日`;
  const weeks = bars / 5;
  return `约 ${Number.isInteger(weeks) ? weeks : weeks.toFixed(1)} 周`;
});

/** 有效期补一句「还剩几天」：只给日期，用户还得自己跟今天比 */
const expiresText = computed(() => {
  const iso = plan.value?.expiresAt;
  if (!iso) return '未设定';
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86400000);
  const rel = days < 0 ? '已过期' : days === 0 ? '今日内' : `还剩 ${days} 天`;
  return `${iso.slice(0, 10)}（${rel}）`;
});

/**
 * 走势推演。概率来自模型，是未经校准的主观数——本组件只把它显示出来，
 * 不拿它去乘仓位、调止损或排序，这条纪律由 symbolPlanProjection.selfcheck.ts 扫源码守着。
 */
const projection = ref<SymbolPlanProjection | null>(null);

/** 短期锥 5 天，与「短期 = 本周内」的分栏口径一致 */
const CONE_STEPS_SHORT = 5;

async function loadProjection(token: number): Promise<void> {
  try {
    const p = await api.symbolPlans.projection(
      props.code,
      CONE_STEPS_SHORT,
      props.secid || undefined,
    );
    if (token !== loadToken) return;
    projection.value = p;
  } catch {
    if (token === loadToken) projection.value = null;
  }
}

/**
 * 校准提示。样本不足 20 条只报记录数不报兑现率：
 * 十来个样本算出的比率比模型报的原数更容易骗人，显示出来等于用一个更没根的数去背书另一个。
 */
function calibrationText(c: { recorded: number; settled: number; hit: number }): string {
  if (c.recorded === 0) return '首次记录';
  if (c.settled < 20) return `同档已记录 ${c.recorded} 次，样本不足未算兑现率`;
  return `同档已判定 ${c.settled} 次，实际兑现 ${Math.round((c.hit / c.settled) * 100)}%`;
}

const dataStatusText: Record<SymbolTradePlan['dataStatus'], string> = {
  complete: '数据完整',
  provisional: '盘中未收盘，结论为暂定',
  degraded: '关键数据没取全，仅供观察',
};

// 不能直接把 load 当回调：watch 会把新值作为第一个实参传进去，
// 那个位置现在是 autoReview 开关，标的一换就变成用 code 字符串当布尔值
watch(() => props.code, () => void load(), { immediate: true });
</script>

<template>
  <div class="tp">
    <div class="tp__head">
      <!-- 终态计划复核不会改变任何结论（resolveOutcome 直接沿用原状态），按钮留着只是骗点击 -->
      <el-button
        v-if="plan && isLive"
        size="small"
        :loading="evaluating"
        class="tp__recheck"
        @click="reevaluate"
      >
        复核条件
      </el-button>
    </div>

    <div v-loading="loading" class="tp__body">
      <div v-if="loadError" class="tp__error">加载失败：{{ loadError }}</div>

      <div v-else-if="!plan" class="tp__empty">
        <div class="tp__empty-title">尚无交易计划</div>
        <div class="tp__empty-sub">
          点下方按钮（或切到「Agent」页签用同名快捷按钮），让它生成本标的的技术交易计划。计划会给出
          当前阶段、唯一主动作、触发与失效条件，并把关键位同步到左侧 K 线图。
        </div>
        <div class="tp__empty-actions">
          <el-button size="small" type="primary" plain @click="emit('generate')">
            生成交易计划
          </el-button>
        </div>
      </div>

      <template v-else>
        <!-- 失效横幅：正文照常展开供复盘，但先说清什么时候、因为哪一条失效的 -->
        <div v-if="staleBanner" class="tp__stale">
          <div class="tp__stale-head">
            <span class="tp__stale-tag">{{ staleBanner.text }}</span>
            <el-button size="small" type="primary" plain @click="emit('generate')">
              重新生成
            </el-button>
          </div>
          <div class="tp__stale-reason">{{ staleBanner.reason }}</div>
        </div>

        <!-- 风险路径已触发：计划仍生效，但这条指令必须顶到最上面，否则用户看不到该减仓了 -->
        <div v-if="riskTriggered" class="tp__risk-hit">
          <div class="tp__risk-head">
            <span class="tp__risk-tag">风险路径已触发</span>
            <span class="tp__risk-action">建议动作：{{ riskTriggered.action }}</span>
          </div>
          <div v-if="riskTriggered.reasons.length" class="tp__risk-reason">
            命中：{{ riskTriggered.reasons.join('、') }}
          </div>
        </div>

        <!-- 阶段与唯一主动作 -->
        <div class="tp__phase" :class="[PHASE_TONE[plan.marketPhase], { 'is-stale': !isLive }]">
          <div class="tp__phase-row">
            <span class="tp__phase-tag">{{ PHASE_LABEL[plan.marketPhase] }}</span>
            <span class="tp__action">{{ ACTION_LABEL[plan.primaryAction] }}</span>
            <span class="tp__ver">v{{ plan.version }} · {{ STATUS_LABEL[plan.status] }}</span>
          </div>
          <div class="tp__sentence">{{ actionSentence }}</div>
          <div class="tp__summary">{{ plan.summary }}</div>
        </div>

        <!-- 相比上一版本的变化 -->
        <div v-if="plan.changes.length" class="tp__changes">
          <span class="tp__changes-label">相比上一版</span>
          <ul>
            <li v-for="(c, i) in plan.changes.slice(0, 3)" :key="i">{{ c }}</li>
          </ul>
        </div>

        <!-- 关键线按持有时长分栏：短期是这几天要动手的，中长期是拿几个月的仓位安排 -->
        <div v-for="g in keyLineGroups" :key="g.span" class="tp__span">
          <div class="tp__span-title">{{ g.label }}</div>
          <div class="tp__lines">
            <div v-for="l in g.lines" :key="l.label" class="tp__line" :class="l.tone">
              <span class="tp__line-label">{{ l.label }}</span>
              <span class="tp__line-value num">{{ l.value }}</span>
              <span v-if="l.source" class="tp__line-source">{{ l.source }}</span>
              <span v-if="l.detail" class="tp__line-detail">{{ l.detail }}</span>
            </div>
          </div>
        </div>

        <!-- 可下单指令：动词换算成挂单价 + 股数 + 金额 -->
        <div v-if="orderInstruction" class="tp__order">
          <div class="tp__order-text">{{ orderInstruction.text }}</div>
          <div v-if="orderInstruction.note" class="tp__order-note">{{ orderInstruction.note }}</div>
        </div>

        <!-- 情景概率：模型主观估计，未经校准，显著标注，不参与任何计算 -->
        <div v-if="projection?.scenarios.length" class="tp__prob">
          <div class="tp__prob-head">
            情景可能性
            <span class="tp__prob-warn">模型主观估计，未经校准</span>
          </div>
          <div v-for="s in projection.scenarios" :key="s.id" class="tp__prob-row">
            <span class="tp__prob-pct num">{{ s.probabilityPct }}%</span>
            <span class="tp__prob-name">{{ s.name }}</span>
            <span class="tp__prob-cal">{{ calibrationText(s.calibration) }}</span>
            <span v-if="s.basis" class="tp__prob-basis">{{ s.basis }}</span>
          </div>
        </div>

        <!-- 仓位与有效期 -->
        <div class="tp__meta">
          <span>建议仓位上限 <b class="num">{{ plan.risk.suggestedPositionPct ?? '—' }}%</b></span>
          <span>单笔风险 <b class="num">{{ plan.risk.maxAccountRiskPct }}%</b></span>
          <span>时间止损 <b>{{ timeStopText }}</b></span>
          <span>有效期至 {{ expiresText }}</span>
        </div>
        <div class="tp__status" :class="{ 'is-warn': plan.dataStatus !== 'complete' }">
          {{ dataStatusText[plan.dataStatus] }}（数据截至 {{ plan.asOf }}）
        </div>

        <!-- 主路径条件 -->
        <div v-if="primaryScenario" class="tp__scenario">
          <div class="tp__scenario-name">{{ primaryScenario.name }}</div>
          <div v-if="conditionProgress" class="tp__progress">
            <span
              class="tp__progress-count num"
              :class="{ 'is-done': conditionProgress.done === conditionProgress.total }"
            >
              {{ conditionProgress.done }}/{{ conditionProgress.total }}
            </span>
            <span>{{ conditionProgress.text }}</span>
          </div>
          <div class="tp__cond-group">
            <span class="tp__cond-label">触发</span>
            <div class="tp__conds">
              <div v-for="c in primaryConditions" :key="c.id" class="tp__cond">
                <span
                  class="tp__cond-dot"
                  :class="{
                    'is-hit': condState(c.id)?.satisfied,
                    'is-miss': condState(c.id) && !condState(c.id)?.satisfied,
                  }"
                />
                <span v-if="c.required" class="tp__cond-req">必要</span>
                <span>{{ c.description }}</span>
                <span class="tp__cadence">{{ triggerLabel(c) }}</span>
              </div>
            </div>
          </div>
          <div class="tp__cond-group">
            <span class="tp__cond-label is-down">失效</span>
            <div class="tp__conds">
              <div v-for="c in primaryScenario.invalidConditions" :key="c.id" class="tp__cond">
                <span
                  class="tp__cond-dot"
                  :class="{
                    'is-hit': condState(c.id)?.satisfied,
                    'is-miss': condState(c.id) && !condState(c.id)?.satisfied,
                  }"
                />
                <span>{{ c.description }}</span>
                <span class="tp__cadence">{{ triggerLabel(c) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 折叠的专业证据 -->
        <el-collapse v-model="openPanels" class="tp__collapse">
          <el-collapse-item v-if="otherScenarios.length" title="备选与风险路径" name="scenarios">
            <div v-for="s in otherScenarios" :key="s.id" class="tp__alt">
              <div class="tp__alt-name">
                {{ s.rank === 'risk' ? '风险路径' : '备选路径' }}：{{ s.name }}
              </div>
              <div v-for="c in s.conditions" :key="c.id" class="tp__alt-cond">触发：{{ c.description }}</div>
              <div v-for="c in s.invalidConditions" :key="c.id" class="tp__alt-cond">失效：{{ c.description }}</div>
            </div>
          </el-collapse-item>

          <el-collapse-item title="止盈与保护" name="exit">
            <div class="tp__kv">
              <span>移动保护</span><span>{{ plan.exitPlan.trailingRule ?? '—' }}</span>
            </div>
            <div class="tp__kv">
              <span>利润保护</span><span>{{ plan.exitPlan.profitProtectionRule ?? '—' }}</span>
            </div>
            <div class="tp__kv">
              <span>分批比例</span>
              <span>{{ plan.exitPlan.reduceFractions.map((f) => `${Math.round(f * 100)}%`).join(' + ') || '—' }}</span>
            </div>
            <div class="tp__kv">
              <span>结构/波动/执行止损</span>
              <span class="num">
                {{ plan.risk.structuralStop ?? '—' }} / {{ plan.risk.volatilityStop ?? '—' }} /
                {{ plan.risk.executionStop ?? '—' }}
              </span>
            </div>
            <div v-if="plan.risk.gapRiskNote" class="tp__kv"><span>跳空</span><span>{{ plan.risk.gapRiskNote }}</span></div>
          </el-collapse-item>

          <el-collapse-item title="执行闸门与资产风险" name="exec">
            <div class="tp__kv">
              <span>追涨保护</span><span class="num">{{ plan.execution.chaseGuardAtr ?? '—' }}×ATR</span>
            </div>
            <div v-if="plan.execution.maxPremiumPct != null" class="tp__kv">
              <span>折溢价上限</span><span class="num">{{ plan.execution.maxPremiumPct }}%</span>
            </div>
            <div v-for="(r, i) in plan.assetSpecificRisks" :key="i" class="tp__risk">{{ r }}</div>
          </el-collapse-item>

          <el-collapse-item title="模型证据（道氏 / 缠论 / 阶段）" name="evidence">
            <div class="tp__kv"><span>道氏趋势</span><span>{{ plan.trendState }}</span></div>
            <div class="tp__kv"><span>缠论候选</span><span>{{ plan.chanSetup }}</span></div>
            <div class="tp__kv"><span>市场动作（不含账户）</span><span>{{ ACTION_LABEL[plan.marketAction] }}</span></div>
            <div class="tp__kv"><span>算法版本</span>
              <span class="tp__ver-note">
                {{ plan.evidenceVersion }} / {{ plan.phaseModelVersion }} / {{ plan.candidateModelVersion }}
              </span>
            </div>
            <div v-for="b in plan.benchmarks" :key="b.code" class="tp__kv">
              <span>基准（{{ b.role }}）</span><span>{{ b.code }} {{ b.name }}</span>
            </div>
            <div class="tp__note">
              缠论结果一律是候选，不单独构成买卖依据；波浪首期不进结构化字段。
            </div>
          </el-collapse-item>
        </el-collapse>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tp {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
  overflow: hidden;
}
.tp__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.tp__recheck {
  margin-left: auto;
}
.tp__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
}
.tp__error {
  color: var(--el-color-danger);
  font-size: 12px;
}
.tp__empty {
  padding: 16px 4px;
  color: var(--text-2);
}
.tp__empty-title {
  font-size: 13px;
  font-weight: 600;
  color: #cfd3dc;
  margin-bottom: 4px;
}
.tp__empty-sub {
  font-size: 12px;
  line-height: 1.7;
}
.tp__empty-actions {
  display: flex;
  gap: 6px;
  margin-top: 12px;
}
.tp__empty-actions .el-button {
  flex: 1;
  font-size: 12px;
}
/* 阶段带：唯一阶段 + 唯一主动作 */
.tp__phase {
  padding: 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
}
.tp__phase.is-up {
  border-color: rgba(240, 69, 74, 0.35);
}
.tp__phase.is-down {
  border-color: rgba(18, 184, 134, 0.35);
}
.tp__phase.is-warn {
  border-color: rgba(255, 176, 0, 0.35);
}
/* 失效计划整块压暗：既保留可读性供复盘，又一眼看出这不是今天要照着做的东西 */
.tp__phase.is-stale {
  opacity: 0.62;
  border-color: rgba(255, 255, 255, 0.08);
}
.tp__stale {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 176, 0, 0.3);
  background: rgba(255, 176, 0, 0.08);
}
.tp__stale-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tp__stale-tag {
  font-size: 13px;
  font-weight: 700;
  color: #ffc74d;
}
.tp__stale-head .el-button {
  margin-left: auto;
}
.tp__stale-reason {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-2);
}
/* 风险路径触发：用「跌」的绿色，与 A 股红涨绿跌一致，避免和黄色失效横幅混淆 */
.tp__risk-hit {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid rgba(18, 184, 134, 0.35);
  background: rgba(18, 184, 134, 0.08);
}
.tp__risk-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tp__risk-tag {
  font-size: 13px;
  font-weight: 700;
  color: #2fd8a4;
}
.tp__risk-action {
  font-size: 13px;
  font-weight: 700;
}
.tp__risk-reason {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-2);
}
.tp__phase-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.tp__phase-tag {
  font-size: 15px;
  font-weight: 700;
  color: #cfd3dc;
}
.tp__action {
  font-size: 13px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 3px;
  background: rgba(31, 111, 235, 0.18);
  color: #7aa7ff;
}
.tp__ver {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-2);
}
.tp__sentence {
  margin-top: 7px;
  font-size: 12px;
  line-height: 1.7;
  color: #cfd3dc;
}
.tp__summary {
  margin-top: 5px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
}
.tp__changes {
  margin-top: 10px;
  font-size: 12px;
}
.tp__changes-label {
  color: var(--text-2);
  font-size: 11px;
}
.tp__changes ul {
  margin: 4px 0 0;
  padding-left: 18px;
  color: #cfd3dc;
  line-height: 1.7;
}
/* 三条关键线 */
.tp__lines {
  display: flex;
  margin-top: 10px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  overflow: hidden;
}
.tp__line {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 9px;
  border-left: 1px solid rgba(255, 255, 255, 0.06);
  min-width: 0;
}
.tp__line:first-child {
  border-left: none;
}
.tp__line-label {
  font-size: 10px;
  color: var(--text-2);
}
.tp__line-value {
  font-size: 14px;
  font-weight: 600;
}
.tp__line.is-up .tp__line-value {
  color: #f0454a;
}
.tp__line.is-down .tp__line-value {
  color: #12b886;
}
.tp__line.is-warn .tp__line-value {
  color: #ffb000;
}
.tp__prob {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 4px;
  background: rgba(155, 109, 255, 0.07);
  border-left: 3px solid #9b6dff;
}
.tp__prob-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-1);
  margin-bottom: 4px;
}
.tp__prob-warn {
  font-size: 10px;
  color: #ffb000;
  border: 1px solid #ffb000;
  border-radius: 2px;
  padding: 0 4px;
}
.tp__prob-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11px;
  color: var(--text-2);
  line-height: 1.7;
}
.tp__prob-pct {
  font-size: 13px;
  font-weight: 600;
  color: #9b6dff;
  min-width: 38px;
}
.tp__prob-name {
  color: var(--text-1);
}
.tp__prob-basis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tp__progress {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.tp__progress-count {
  font-size: 13px;
  font-weight: 600;
  color: #ffb000;
}
.tp__progress-count.is-done {
  color: #12b886;
}
.tp__cond-req {
  flex: none;
  font-size: 10px;
  color: #ffb000;
  border: 1px solid #ffb000;
  border-radius: 2px;
  padding: 0 3px;
}
.tp__span {
  margin-top: 8px;
}
.tp__span-title {
  font-size: 11px;
  color: var(--text-2);
  margin-bottom: 4px;
}
.tp__order {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 4px;
  background: rgba(31, 111, 235, 0.08);
  border-left: 3px solid #1f6feb;
}
.tp__order-text {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-1);
}
.tp__order-note {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-2);
}
.tp__line-source {
  font-size: 10px;
  color: var(--text-2);
  border: 1px solid var(--border-1, #33384a);
  border-radius: 3px;
  padding: 0 4px;
  white-space: nowrap;
}
.tp__line-detail {
  font-size: 10px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tp__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 9px;
  font-size: 11px;
  color: var(--text-2);
}
.tp__meta b {
  color: #cfd3dc;
}
.tp__status {
  margin-top: 5px;
  font-size: 11px;
  color: var(--text-2);
}
.tp__status.is-warn {
  color: #ffb000;
}
/* 主路径条件 */
.tp__scenario {
  margin-top: 11px;
  padding-top: 9px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.tp__scenario-name {
  font-size: 12px;
  font-weight: 600;
  color: #cfd3dc;
  margin-bottom: 6px;
}
.tp__cond-group {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
}
.tp__cond-label {
  flex-shrink: 0;
  font-size: 11px;
  color: #f0454a;
  padding-top: 2px;
}
.tp__cond-label.is-down {
  color: #12b886;
}
.tp__conds {
  flex: 1;
  min-width: 0;
}
.tp__cond {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 12px;
  line-height: 1.7;
  color: #cfd3dc;
}
.tp__cond-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
}
.tp__cond-dot.is-hit {
  background: #f0454a;
}
.tp__cond-dot.is-miss {
  background: rgba(255, 255, 255, 0.15);
}
.tp__cadence {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-2);
}
.tp__collapse {
  margin-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.tp__collapse :deep(.el-collapse-item__header),
.tp__collapse :deep(.el-collapse-item__wrap) {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.06);
}
.tp__collapse :deep(.el-collapse-item__header) {
  font-size: 12px;
}
.tp__kv {
  display: flex;
  gap: 10px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-2);
}
.tp__kv span:last-child {
  color: #cfd3dc;
  text-align: right;
  margin-left: auto;
}
.tp__ver-note {
  font-size: 10px;
}
.tp__alt {
  margin-bottom: 8px;
}
.tp__alt-name {
  font-size: 12px;
  font-weight: 600;
  color: #cfd3dc;
}
.tp__alt-cond,
.tp__risk,
.tp__note {
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-2);
}
.tp__note {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
}
</style>
