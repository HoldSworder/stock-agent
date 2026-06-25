<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import dayjs from 'dayjs';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Refresh, MagicStick, Clock, Back, Compass, Promotion, Aim } from '@element-plus/icons-vue';
import { api } from '@/api';
import StockLink from '@/components/StockLink.vue';
import ModuleScheduleDialog from '@/components/ModuleScheduleDialog.vue';
import RunResultDrawer from '@/components/RunResultDrawer.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import type {
  DailyPlanDetail,
  DailyPlanEvent,
  DailyPlanItem,
  DailyPlanSummary,
  EtfAction,
  EtfSignal,
  PlanDirection,
  PlanEventKind,
  PlanItemStatus,
  PlanItemSource,
  PlanTrigger,
  OneClickRunState,
  OneClickStepStatus,
  RealPortfolio,
  ScreenPick,
  ScreenRunDetail,
  StockQuote,
  TaskRun,
} from '@stock-agent/shared';

const router = useRouter();
// 核心打法快捷入口：直达 ETF 轮动榜并一键跑「强赛道→成分股→中线龙头」下钻（复用 ETF 页下钻渲染）
function goDrilldown() {
  void router.push({ path: '/etf', query: { tab: 'rotation', drill: '1' } });
}
// 计划项「深度辩论」全站统一入口：跳决策页预填代码（与持仓卡/自选页同一对标签）
function debateItem(code: string, asset: 'stock' | 'etf') {
  void router.push({ path: '/decision', query: { code, asset } });
}

const detail = ref<DailyPlanDetail | null>(null);
const loading = ref(false);
const generating = ref(false);
const reevaluating = ref(false);
const error = ref('');

// 历史回看：viewingDate 非空表示当前查看的是历史计划（只读）
const viewingDate = ref<string | null>(null);
const historyDrawer = ref(false);
const historyList = ref<DailyPlanSummary[]>([]);
const historyLoading = ref(false);

// 实时合并数据（仅查看当日时拉取，历史回看不拉以免把当下行情误当历史）
const quoteMap = ref<Map<string, StockQuote>>(new Map());
const etfSignalMap = ref<Map<string, EtfSignal>>(new Map());

// 真实持仓（仅当日拉取，供「建议仓位 vs 真实持仓」对照；失败静默降级）
const realPortfolio = ref<RealPortfolio | null>(null);

// 分时作战当前时段高亮：每 30s 刷新本地时间
const nowTs = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;

/** 拉取实时行情（个股 quotes + ETF 信号），失败静默降级为只读落库字段 */
async function loadLive() {
  quoteMap.value = new Map();
  etfSignalMap.value = new Map();
  realPortfolio.value = null;
  // 真实持仓独立拉取（供仓位对照），失败静默
  void api
    .getRealPositions()
    .then((rp) => {
      realPortfolio.value = rp;
    })
    .catch(() => {});
  const list = detail.value?.items ?? [];
  const stockCodes = list.filter((i) => i.assetType !== 'etf').map((i) => i.code);
  const hasEtf = list.some((i) => i.assetType === 'etf');
  const tasks: Promise<void>[] = [];
  if (stockCodes.length) {
    tasks.push(
      api
        .quotes(stockCodes)
        .then((qs) => {
          quoteMap.value = new Map(qs.map((q) => [q.code, q]));
        })
        .catch(() => {}),
    );
  }
  if (hasEtf) {
    tasks.push(
      api.etf
        .signals()
        .then((r) => {
          etfSignalMap.value = new Map(r.signals.map((s) => [s.code, s]));
        })
        .catch(() => {}),
    );
  }
  await Promise.all(tasks);
}

// 系统选股候选（只读参考：取最近一次 screener run 的候选）
const screenerPicks = ref<ScreenPick[]>([]);
const screenerMeta = ref<{ strategyName: string; createdAt: string } | null>(null);
const screenerOpen = ref(false);

/** 拉取最新一次选股运行的候选，供今日计划交叉参考；失败静默 */
async function loadScreenerPicks() {
  try {
    const status = await api.screener.status();
    const latest = status.recentRuns?.[0];
    if (!latest) {
      screenerPicks.value = [];
      screenerMeta.value = null;
      return;
    }
    const detailRun = await api.screener.run(latest.id);
    screenerPicks.value = detailRun.picks ?? [];
    screenerMeta.value = { strategyName: detailRun.strategyName, createdAt: detailRun.createdAt };
  } catch {
    screenerPicks.value = [];
    screenerMeta.value = null;
  }
}

/** 计划已纳入的标的代码集合（判断选股候选是否已进计划） */
const planCodeSet = computed(() => new Set(items.value.map((i) => i.code)));

async function load() {
  loading.value = true;
  error.value = '';
  try {
    detail.value = await api.plan.today();
    viewingDate.value = null;
    if (detail.value) await loadLive();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    ElMessage.error(error.value);
  } finally {
    loading.value = false;
  }
  void loadScreenerPicks();
}

async function openHistory() {
  historyDrawer.value = true;
  historyLoading.value = true;
  try {
    historyList.value = await api.plan.history(60);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    historyLoading.value = false;
  }
}

/** 查看某历史日期计划（只读回看） */
async function viewHistory(date: string) {
  loading.value = true;
  try {
    const d = await api.plan.get(date);
    if (!d) {
      ElMessage.warning('该日期暂无计划详情');
      return;
    }
    detail.value = d;
    viewingDate.value = date;
    historyDrawer.value = false;
      // 历史回看不拉实时数据，清空合并 Map 与真实持仓
      quoteMap.value = new Map();
      etfSignalMap.value = new Map();
      realPortfolio.value = null;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function generate() {
  if (detail.value) {
    try {
      await ElMessageBox.confirm(
        '今日已有计划，重新生成将覆盖当前计划标的（保留历史事件）。确认继续？',
        '重新生成今日计划',
        { type: 'warning', confirmButtonText: '重新生成', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }
  generating.value = true;
  try {
    const date = detail.value?.plan.planDate;
    await (date ? api.plan.regenerate(date) : api.plan.generate());
    ElMessage.success('计划生成完成');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    generating.value = false;
  }
}

async function reevaluate() {
  reevaluating.value = true;
  try {
    await api.plan.reevaluate();
    ElMessage.success('盘中重评估完成');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    reevaluating.value = false;
  }
}

// ===== 一键计划（盘前链：串行刷新六源 + 生成计划，后台跑、前端轮询进度）=====
const oneclick = ref<OneClickRunState | null>(null);
const oneclickRunning = computed(() => oneclick.value?.running ?? false);
let oneclickTimer: ReturnType<typeof setTimeout> | null = null;

const STEP_META: Record<OneClickStepStatus['status'], { label: string; type: string; icon: string }> = {
  pending: { label: '待执行', type: 'info', icon: '○' },
  running: { label: '进行中', type: 'warning', icon: '◐' },
  success: { label: '成功', type: 'success', icon: '●' },
  error: { label: '失败', type: 'danger', icon: '×' },
  skipped: { label: '跳过', type: 'info', icon: '–' },
};

function stopOneclickPoll() {
  if (oneclickTimer) {
    clearTimeout(oneclickTimer);
    oneclickTimer = null;
  }
}

/** 轮询编排状态：running 时每 3s 续询；结束后刷新计划详情 */
async function pollOneclick() {
  try {
    const st = await api.plan.oneclickStatus();
    oneclick.value = st;
    if (st.running) {
      oneclickTimer = setTimeout(pollOneclick, 3000);
    } else {
      stopOneclickPoll();
      ElMessage.success('一键计划完成');
      await load();
    }
  } catch {
    // 单次轮询失败不终止，下一拍重试
    oneclickTimer = setTimeout(pollOneclick, 3000);
  }
}

async function runOneClick() {
  if (detail.value) {
    try {
      await ElMessageBox.confirm(
        '一键计划将按链路刷新「情报 → 大盘与板块研判（含期货外盘）→ ETF·选股（并行）」后重新生成今日计划（覆盖当前标的，保留历史事件），全程约数分钟。确认继续？',
        '一键计划',
        { type: 'warning', confirmButtonText: '开始', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }
  stopOneclickPoll();
  try {
    oneclick.value = await api.plan.oneclickStart();
    ElMessage.info('一键计划已启动，正在后台按序执行');
  } catch (e) {
    // 可能 409（已在运行）：直接拉当前状态续接轮询
    ElMessage.warning(e instanceof Error ? e.message : String(e));
    try {
      oneclick.value = await api.plan.oneclickStatus();
    } catch {
      return;
    }
  }
  if (oneclick.value?.running) oneclickTimer = setTimeout(pollOneclick, 3000);
}

// ===== 节点点击：呼出本次运行结果抽屉 =====
// taskRun 步（情报/大盘板块/ETF/计划）走 RunResultDrawer；选股步只有 screen_runs id，走轻量候选抽屉。
const runDrawer = ref(false);
const activeRun = ref<TaskRun | null>(null);
const screenerDrawer = ref(false);
const screenerRunDetail = ref<ScreenRunDetail | null>(null);
const screenerRunLoading = ref(false);

async function openStep(step: OneClickStepStatus) {
  if (!step.runId) return;
  if (step.key === 'screener') {
    screenerDrawer.value = true;
    screenerRunLoading.value = true;
    screenerRunDetail.value = null;
    try {
      screenerRunDetail.value = await api.screener.run(step.runId);
    } catch (e) {
      ElMessage.error(e instanceof Error ? e.message : String(e));
      screenerDrawer.value = false;
    } finally {
      screenerRunLoading.value = false;
    }
    return;
  }
  try {
    const { run } = await api.getRun(step.runId);
    activeRun.value = run;
    runDrawer.value = true;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

const plan = computed(() => detail.value?.plan ?? null);
const items = computed(() => detail.value?.items ?? []);
const isLive = computed(() => !viewingDate.value);

// 计划兑现度：纯前端统计当前已加载标的（今日/历史通用），与后端 computePlanFulfillment 口径一致
const fulfillment = computed(() => {
  const list = items.value;
  if (!list.length) return null;
  const hasTrigger = (i: DailyPlanItem) =>
    !!(i.buyTrigger || i.sellTrigger || i.stopLoss || i.takeProfit);
  const withTrigger = list.filter(hasTrigger);
  const hit = withTrigger.filter((i) => i.status === 'triggered' || i.status === 'done').length;
  return {
    total: list.length,
    withTrigger: withTrigger.length,
    triggered: list.filter((i) => i.status === 'triggered' || i.status === 'done').length,
    done: list.filter((i) => i.status === 'done').length,
    invalid: list.filter((i) => i.status === 'invalid').length,
    pending: list.filter((i) => i.status === 'pending').length,
    hitRate: withTrigger.length ? Math.round((hit / withTrigger.length) * 100) : null,
  };
});

function itemPriority(a: DailyPlanItem, b: DailyPlanItem) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return (b.confidence ?? -1) - (a.confidence ?? -1);
}

const stockItems = computed(() =>
  items.value.filter((i) => i.assetType !== 'etf').sort(itemPriority),
);
const etfItems = computed(() =>
  items.value.filter((i) => i.assetType === 'etf').sort(itemPriority),
);

const events = computed<DailyPlanEvent[]>(() =>
  [...(detail.value?.events ?? [])].sort((a, b) => (a.ts < b.ts ? 1 : -1)),
);

const STATUS_META: Record<DailyPlanDetail['plan']['status'], { label: string; type: string }> = {
  draft: { label: '草稿', type: 'info' },
  active: { label: '生效中', type: 'success' },
  closed: { label: '已复盘', type: 'warning' },
};

const DIR_META: Record<PlanDirection, { label: string; type: string }> = {
  buy: { label: '买入', type: 'danger' },
  hold: { label: '持有', type: 'warning' },
  reduce: { label: '减仓', type: 'success' },
  sell: { label: '卖出', type: 'success' },
  watch: { label: '观察', type: 'info' },
};

const ITEM_STATUS_META: Record<PlanItemStatus, { label: string; type: string }> = {
  pending: { label: '待触发', type: 'info' },
  triggered: { label: '已触发', type: 'danger' },
  done: { label: '已完成', type: 'success' },
  invalid: { label: '已失效', type: 'info' },
};

const SOURCE_LABEL: Record<PlanItemSource, string> = {
  research: '研报',
  hotspot: '热点',
  sector: '板块',
  screener: '选股',
  position: '持仓',
  watchlist: '自选',
  other: '其他',
};

/** 置信度颜色档：≥80 强（绿）、60-79 中（橙）、<60 弱（灰），null 不显示 */
function confidenceCls(v: number | null): string {
  if (v == null) return '';
  if (v >= 80) return 'conf-high';
  if (v >= 60) return 'conf-mid';
  return 'conf-low';
}

const BIAS_META: Record<'bull' | 'bear' | 'neutral', { label: string; cls: string }> = {
  bull: { label: '偏多', cls: 'up' },
  bear: { label: '偏空', cls: 'down' },
  neutral: { label: '中性', cls: '' },
};

const TIMING_META: Record<'attack' | 'balanced' | 'defense', { label: string; type: string }> = {
  attack: { label: '进攻', type: 'danger' },
  balanced: { label: '均衡', type: 'warning' },
  defense: { label: '防守', type: 'success' },
};

const ACTION_META: Record<EtfAction, { label: string; type: string }> = {
  buy: { label: '买入', type: 'danger' },
  add: { label: '加仓', type: 'danger' },
  hold: { label: '持有', type: 'warning' },
  reduce: { label: '减仓', type: 'success' },
  avoid: { label: '回避', type: 'info' },
};

const EVENT_META: Record<PlanEventKind, { label: string; type: string }> = {
  created: { label: '生成', type: 'primary' },
  regenerated: { label: '重新生成', type: 'warning' },
  trigger_hit: { label: '触发', type: 'danger' },
  note: { label: '备注', type: 'info' },
  review: { label: '复盘', type: 'success' },
};

function trg(t: PlanTrigger | null): string {
  if (!t) return '—';
  const tag = t.type === 'breakout' ? '突破' : t.type === 'pullback' ? '回落' : '';
  return `${tag}${t.value}${t.note ? `（${t.note}）` : ''}`;
}

/** 研判结论标签色：清仓/进攻=危险 / 减仓=警告 / 回踩等待/规避/持有=信息 */
function debateTagType(verdict: string | null): string {
  if (verdict === '清仓' || verdict === '进攻') return 'danger';
  if (verdict === '减仓') return 'warning';
  return 'info';
}

const liveQuote = (code: string): StockQuote | null => quoteMap.value.get(code) ?? null;
const etfSig = (code: string): EtfSignal | null => etfSignalMap.value.get(code) ?? null;

function pctCls(v: number | null | undefined): string {
  if (v == null) return '';
  return v > 0 ? 'up' : v < 0 ? 'down' : '';
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

function fmtPct(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

/** 现价距买入触发价的百分比（正=尚在触发价之上，负=已跌破/接近买点） */
function distToTrigger(code: string, t: PlanTrigger | null): string {
  const q = liveQuote(code);
  if (!q || !t || !t.value) return '—';
  const d = ((q.price - t.value) / t.value) * 100;
  return `${d > 0 ? '+' : ''}${d.toFixed(2)}%`;
}

/** 某标的现价（个股取 quote、ETF 取 signal），无则 null */
function itemPrice(item: DailyPlanItem): number | null {
  if (item.assetType === 'etf') return etfSig(item.code)?.price ?? null;
  return liveQuote(item.code)?.price ?? null;
}

type TriggerState = { label: string; cls: string };

/**
 * 盘中实时触发状态（B）：用现价对照该标的触发价分级，给「现在该不该动手」的醒目提示。
 * 仅当日(isLive)且有实时价时有效；历史回看或缺价返回 null。
 */
function triggerState(item: DailyPlanItem): TriggerState | null {
  if (!isLive.value) return null;
  const price = itemPrice(item);
  if (price == null) return null;
  if (item.stopLoss?.value && price <= item.stopLoss.value)
    return { label: '已破止损', cls: 'ts-stop' };
  if (item.takeProfit?.value && price >= item.takeProfit.value)
    return { label: '已达止盈', cls: 'ts-profit' };
  const bt = item.buyTrigger;
  if (bt?.value) {
    if (bt.type === 'breakout') {
      if (price >= bt.value) return { label: '已触发买点', cls: 'ts-active' };
      if ((bt.value - price) / bt.value <= 0.01) return { label: '接近买点', cls: 'ts-near' };
    } else {
      // price/pullback：回落至触发价及以下视为触发
      if (price <= bt.value) return { label: '已触发买点', cls: 'ts-active' };
      if ((price - bt.value) / bt.value <= 0.01) return { label: '接近买点', cls: 'ts-near' };
    }
    return { label: '待触发', cls: 'ts-wait' };
  }
  return null;
}

// 真实持仓中的 ETF 代码集合（用于「持仓」标记，仅当日有持仓数据时非空）
const heldEtfCodes = computed(
  () =>
    new Set(
      (realPortfolio.value?.positions ?? [])
        .filter((p) => /^[15]/.test(p.code))
        .map((p) => p.code),
    ),
);
const isHeld = (code: string): boolean => heldEtfCodes.value.has(code);

// ETF 优先、再按 priority×confidence 排序（今日计划以 ETF 为主体）
function etfFirst(a: DailyPlanItem, b: DailyPlanItem) {
  const ae = a.assetType === 'etf' ? 0 : 1;
  const be = b.assetType === 'etf' ? 0 : 1;
  if (ae !== be) return ae - be;
  return itemPriority(a, b);
}

// ===== A 今日操作清单 / 观察池（ETF 优先，再按 priority×confidence）=====
const actionItems = computed(() =>
  items.value.filter((i) => i.direction !== 'watch').sort(etfFirst),
);
const watchItems = computed(() =>
  items.value.filter((i) => i.direction === 'watch').sort(etfFirst),
);

/** 操作清单单行触发价摘要：买/止损/止盈各取一，紧凑展示 */
function actionTriggers(item: DailyPlanItem): { label: string; value: string; cls: string }[] {
  const out: { label: string; value: string; cls: string }[] = [];
  if (item.buyTrigger) out.push({ label: '买', value: trg(item.buyTrigger), cls: 'up' });
  if (item.stopLoss) out.push({ label: '损', value: trg(item.stopLoss), cls: 'down' });
  if (item.takeProfit) out.push({ label: '盈', value: trg(item.takeProfit), cls: '' });
  return out;
}

// ===== C 建议仓位 vs 真实持仓对照 =====
const positionCompare = computed(() => {
  if (!isLive.value) return null;
  const rp = realPortfolio.value;
  if (!rp) return null;
  const target = plan.value?.marketStance?.positionPct ?? null;
  const actual = Math.round(rp.positions.reduce((a, p) => a + (p.positionRate || 0), 0));
  const diff = target != null ? target - actual : null;
  const heldCodes = new Set(rp.positions.map((p) => p.code));
  const toBuild = items.value.filter((i) => i.direction === 'buy' && !heldCodes.has(i.code));
  const toReduce = items.value.filter(
    (i) => (i.direction === 'reduce' || i.direction === 'sell') && heldCodes.has(i.code),
  );
  return { target, actual, diff, toBuild, toReduce };
});

// ===== D 盘中失效预警：pending 标的的失效条件提前置顶 =====
const invalidWatch = computed(() =>
  items.value.filter((i) => i.status === 'pending' && i.invalidConditions.length),
);

// ===== E 分时作战：当前时段高亮 =====
const PHASES = [
  { key: 'auction', label: '集合竞价', range: '9:15-9:25', start: 9 * 60 + 15, end: 9 * 60 + 25 },
  { key: 'morning', label: '早盘', range: '9:30-11:30', start: 9 * 60 + 30, end: 11 * 60 + 30 },
  { key: 'midday', label: '午盘', range: '13:00-14:30', start: 13 * 60, end: 14 * 60 + 30 },
  { key: 'tail', label: '尾盘', range: '14:30-15:00', start: 14 * 60 + 30, end: 15 * 60 },
] as const;

const currentPhaseKey = computed<string | null>(() => {
  const d = new Date(nowTs.value);
  const m = d.getHours() * 60 + d.getMinutes();
  return PHASES.find((p) => m >= p.start && m < p.end)?.key ?? null;
});

/** 分时指引可展示的段（仅渲染 AI 给出内容的段），历史回看也保留落库内容 */
const intradayPhases = computed(() => {
  const g = plan.value?.intradayGuide;
  if (!g) return [];
  return PHASES.map((p) => ({ ...p, text: (g as Record<string, string | undefined>)[p.key] })).filter(
    (p) => !!p.text,
  );
});

/** 解析事件 payload（note/trigger 文本） */
function eventText(ev: DailyPlanEvent): string {
  if (!ev.payload) return '';
  try {
    const p = JSON.parse(ev.payload) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof p.code === 'string') parts.push(p.code);
    if (typeof p.name === 'string') parts.push(p.name);
    const msg = p.note ?? p.message ?? p.text ?? p.summary;
    if (typeof msg === 'string' && msg) parts.push(msg);
    return parts.join(' · ') || ev.payload;
  } catch {
    return ev.payload;
  }
}

onMounted(async () => {
  clockTimer = setInterval(() => {
    nowTs.value = Date.now();
  }, 30000);
  await load();
  // 进入页面时若编排仍在运行（如刷新页面），续接轮询展示进度
  try {
    const st = await api.plan.oneclickStatus();
    if (st.running) {
      oneclick.value = st;
      oneclickTimer = setTimeout(pollOneclick, 3000);
    }
  } catch {
    /* 忽略：无编排状态 */
  }
});

onUnmounted(() => {
  stopOneclickPoll();
  if (clockTimer) clearInterval(clockTimer);
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">今日计划</div>
      <div class="head-actions">
        <el-tag v-if="viewingDate" type="info" effect="plain" size="small">历史查看</el-tag>
        <el-tag v-if="plan" :type="STATUS_META[plan.status].type as any" effect="dark" size="small">
          {{ STATUS_META[plan.status].label }}
        </el-tag>
        <span v-if="plan" class="meta">{{ plan.planDate }}</span>
        <el-button :icon="Clock" @click="openHistory">历史</el-button>
        <el-button v-if="viewingDate" :icon="Back" :loading="loading" @click="load">返回今日</el-button>
        <template v-else>
          <ModuleScheduleDialog module="plan" />
          <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
          <el-button :icon="Aim" @click="goDrilldown">下钻强赛道龙头</el-button>
          <el-button
            v-if="plan && !viewingDate"
            :icon="Compass"
            :loading="reevaluating"
            :disabled="oneclickRunning"
            @click="reevaluate"
          >
            盘中重评估
          </el-button>
          <el-button
            :icon="MagicStick"
            :loading="generating"
            :disabled="oneclickRunning"
            @click="generate"
          >
            {{ plan ? '重新生成' : '生成今日计划' }}
          </el-button>
          <el-button
            type="primary"
            :icon="Promotion"
            :loading="oneclickRunning"
            :disabled="generating || reevaluating"
            @click="runOneClick"
          >
            一键计划
          </el-button>
        </template>
      </div>
    </div>
    <div class="page-sub">
      盘前作战室：研报 / 热点 / 板块 / 持仓 / 大盘 / 外围串联，盘中盯盘程序化对照，盘后收盘复盘闭环（仅研判不下单）
    </div>

    <!-- 一键计划管线进度 -->
    <div v-if="oneclick" class="pipeline" :class="{ done: !oneclick.running }">
      <div class="pipeline-head">
        <span class="pipeline-title">
          一键计划编排
          <el-tag v-if="oneclick.running" type="warning" size="small" effect="dark">运行中</el-tag>
          <el-tag v-else type="success" size="small" effect="dark">已完成</el-tag>
        </span>
        <span v-if="oneclick.startedAt" class="pipeline-time num">
          {{ dayjs(oneclick.startedAt).format('HH:mm:ss') }} 起
        </span>
      </div>
      <div class="pipeline-steps">
        <div
          v-for="(s, i) in oneclick.steps"
          :key="s.key"
          class="pl-step"
          :class="[s.status, { clickable: !!s.runId }]"
          @click="openStep(s)"
        >
          <span class="pl-idx num">{{ i + 1 }}</span>
          <span class="pl-icon">{{ STEP_META[s.status].icon }}</span>
          <span class="pl-label">{{ s.label }}</span>
          <el-tag size="small" :type="STEP_META[s.status].type as any" effect="plain">
            {{ STEP_META[s.status].label }}
          </el-tag>
          <span v-if="s.runId" class="pl-view">查看结果 →</span>
          <span v-if="s.error" class="pl-err">{{ s.error }}</span>
        </div>
      </div>
    </div>

    <el-empty
      v-if="!loading && !plan"
      description="今日尚无作战计划，点击右上角「生成今日计划」由 Agent 综合各模块生成，或「一键计划」串行刷新全链路"
    />

    <template v-if="plan">
      <!-- 大盘研判 -->
      <div class="section">
        <div class="section-title">大盘研判</div>
        <div v-if="plan.marketStance" class="stance">
          <div class="cards">
            <div class="card">
              <div class="card-label">方向</div>
              <div class="card-value" :class="BIAS_META[plan.marketStance.bias].cls">
                {{ BIAS_META[plan.marketStance.bias].label }}
              </div>
            </div>
            <div v-if="plan.marketStance.timingLevel" class="card">
              <div class="card-label">择时档位</div>
              <div class="card-value">
                <el-tag
                  size="small"
                  effect="dark"
                  :type="TIMING_META[plan.marketStance.timingLevel].type as any"
                >
                  {{ TIMING_META[plan.marketStance.timingLevel].label }}
                </el-tag>
              </div>
            </div>
            <div class="card">
              <div class="card-label">建议仓位</div>
              <div class="card-value num">{{ plan.marketStance.positionPct }}%</div>
            </div>
            <div class="card">
              <div class="card-label">关键支撑</div>
              <div class="card-value">{{ plan.marketStance.support || '—' }}</div>
            </div>
            <div class="card">
              <div class="card-label">关键压力</div>
              <div class="card-value">{{ plan.marketStance.resistance || '—' }}</div>
            </div>
          </div>
          <div class="stance-summary">{{ plan.marketStance.summary }}</div>
        </div>
        <div v-else class="muted">未提供大盘研判</div>
      </div>

      <!-- A 今日操作清单（按 优先级×置信度，开盘即照做） -->
      <div v-if="actionItems.length || watchItems.length" class="section">
        <div class="section-title">
          今日操作清单
          <span class="tag-hist">按 优先级×置信度 排序{{ isLive ? '·含盘中触发状态' : '·历史回看' }}</span>
        </div>
        <div v-if="actionItems.length" class="action-list">
          <div v-for="it in actionItems" :key="it.id" class="action-row">
            <el-tag size="small" :type="DIR_META[it.direction].type as any" effect="dark" class="ac-dir">
              {{ DIR_META[it.direction].label }}
            </el-tag>
            <span class="ac-name">
              <StockLink :code="it.code" :name="it.name" />
              <el-tag size="small" effect="plain" class="ac-type">{{ it.assetType === 'etf' ? 'ETF' : '个股' }}</el-tag>
              <el-tag v-if="isLive && isHeld(it.code)" size="small" type="warning" effect="plain" class="ac-type">持仓</el-tag>
            </span>
            <span class="ac-trgs">
              <span v-for="t in actionTriggers(it)" :key="t.label" class="ac-trg">
                {{ t.label }}<b class="num" :class="t.cls">{{ t.value }}</b>
              </span>
              <span v-if="it.positionHint" class="ac-trg">仓位<b class="num">{{ it.positionHint }}</b></span>
            </span>
            <el-tag
              v-if="triggerState(it)"
              size="small"
              effect="dark"
              class="ac-state"
              :class="triggerState(it)!.cls"
            >
              {{ triggerState(it)!.label }}
            </el-tag>
            <span v-if="it.confidence != null" class="ac-conf conf-num" :class="confidenceCls(it.confidence)">
              {{ it.confidence }}
            </span>
            <span class="ac-note">{{ it.confirmConditions?.[0] || it.thesis || '—' }}</span>
          </div>
        </div>
        <div v-else class="muted">今日无可执行标的（均为观察）</div>
        <div v-if="watchItems.length" class="watch-pool">
          <span class="watch-cap">观察池</span>
          <span v-for="it in watchItems" :key="it.id" class="watch-chip">
            <StockLink :code="it.code" :name="it.name" />
            <span v-if="it.confidence != null" class="conf-num sub" :class="confidenceCls(it.confidence)">{{ it.confidence }}</span>
          </span>
        </div>
      </div>

      <!-- E 分时作战（当前时段高亮） -->
      <div v-if="intradayPhases.length" class="section">
        <div class="section-title">分时作战</div>
        <div class="intraday">
          <div
            v-for="p in intradayPhases"
            :key="p.key"
            class="intraday-phase"
            :class="{ active: isLive && currentPhaseKey === p.key }"
          >
            <div class="ip-head">
              <span class="ip-label">{{ p.label }}</span>
              <span class="ip-range num">{{ p.range }}</span>
              <el-tag v-if="isLive && currentPhaseKey === p.key" size="small" type="warning" effect="dark">当前</el-tag>
            </div>
            <div class="ip-text">{{ p.text }}</div>
          </div>
        </div>
      </div>

      <!-- 计划兑现度（纯统计） -->
      <div v-if="fulfillment" class="section">
        <div class="section-title">
          计划兑现度
          <span class="tag-hist">按触发价命中统计·不经 AI 估算</span>
        </div>
        <div class="fulfill">
          <div class="fulfill-rate">
            <span class="fulfill-num">{{ fulfillment.hitRate ?? '—' }}</span>
            <span v-if="fulfillment.hitRate != null" class="fulfill-pct">%</span>
            <span class="fulfill-cap">兑现率</span>
          </div>
          <div class="fulfill-stats">
            <span>命中 {{ fulfillment.triggered }}/{{ fulfillment.withTrigger }}</span>
            <span>已完成 {{ fulfillment.done }}</span>
            <span class="warn">已失效 {{ fulfillment.invalid }}</span>
            <span class="muted">待触发 {{ fulfillment.pending }}</span>
            <span class="muted">标的 {{ fulfillment.total }}</span>
          </div>
        </div>
      </div>

      <!-- C 建议仓位 vs 真实持仓对照 -->
      <div v-if="positionCompare" class="section">
        <div class="section-title">
          仓位对照
          <span class="tag-hist">计划建议 vs 真实持仓·实时</span>
        </div>
        <div class="poscmp">
          <div class="poscmp-cards">
            <div class="card">
              <div class="card-label">建议总仓位</div>
              <div class="card-value num">{{ positionCompare.target != null ? positionCompare.target + '%' : '—' }}</div>
            </div>
            <div class="card">
              <div class="card-label">真实总仓位</div>
              <div class="card-value num">{{ positionCompare.actual }}%</div>
            </div>
            <div v-if="positionCompare.diff != null" class="card">
              <div class="card-label">{{ positionCompare.diff > 0 ? '可加仓' : positionCompare.diff < 0 ? '宜减仓' : '已匹配' }}</div>
              <div class="card-value num" :class="positionCompare.diff > 0 ? 'up' : positionCompare.diff < 0 ? 'down' : ''">
                {{ positionCompare.diff > 0 ? '+' : '' }}{{ positionCompare.diff }}%
              </div>
            </div>
          </div>
          <div v-if="positionCompare.toBuild.length" class="poscmp-line">
            <span class="poscmp-cap up">待建仓</span>
            <span v-for="it in positionCompare.toBuild" :key="it.id" class="poscmp-chip">
              <StockLink :code="it.code" :name="it.name" />
              <span v-if="it.positionHint" class="sub num">{{ it.positionHint }}</span>
            </span>
          </div>
          <div v-if="positionCompare.toReduce.length" class="poscmp-line">
            <span class="poscmp-cap down">待减仓</span>
            <span v-for="it in positionCompare.toReduce" :key="it.id" class="poscmp-chip">
              <StockLink :code="it.code" :name="it.name" />
              <el-tag size="small" :type="DIR_META[it.direction].type as any" effect="plain">{{ DIR_META[it.direction].label }}</el-tag>
            </span>
          </div>
        </div>
      </div>

      <!-- D 今日风险 / 盘中失效预警 -->
      <div v-if="plan.keyRisks.length || invalidWatch.length" class="section risk-section">
        <div class="section-title">今日风险</div>
        <ul v-if="plan.keyRisks.length" class="risk-list">
          <li v-for="(r, i) in plan.keyRisks" :key="i">{{ r }}</li>
        </ul>
        <div v-if="invalidWatch.length" class="risk-invalid">
          <div class="risk-invalid-cap">盘中失效预警（待触发标的的失效条件，破则当天取消）</div>
          <div v-for="it in invalidWatch" :key="it.id" class="risk-invalid-row">
            <span class="riv-name">{{ it.name }}</span>
            <span class="riv-cond">{{ it.invalidConditions.join('；') }}</span>
          </div>
        </div>
      </div>

      <!-- 外围 / 重点板块 -->
      <div class="section two-col">
        <div class="col">
          <div class="section-title">隔夜外围 / 政策</div>
          <div class="ext">{{ plan.externalContext || '—' }}</div>
        </div>
        <div class="col">
          <div class="section-title">重点板块</div>
          <div v-if="plan.focusSectors.length" class="sectors">
            <div v-for="s in plan.focusSectors" :key="s.name" class="sector">
              <span class="sector-name">{{ s.name }}</span>
              <el-tag size="small" effect="plain">{{ s.strength }}</el-tag>
              <span class="sector-reason">{{ s.reason }}</span>
            </div>
          </div>
          <div v-else class="muted">—</div>
        </div>
      </div>

      <!-- ETF 计划（主线，置于个股之前） -->
      <div v-if="etfItems.length" class="section">
        <div class="section-title">
          ETF 计划（主线·{{ etfItems.length }}）
          <span v-if="!isLive" class="tag-hist">历史回看·不含实时量化信号</span>
        </div>
        <el-table :data="etfItems" stripe style="width: 100%">
          <el-table-column label="名称" min-width="120">
            <template #default="{ row }">
              <StockLink :code="row.code" :name="row.name" />
              <el-tag v-if="isLive && isHeld(row.code)" size="small" type="warning" effect="plain" class="held-tag">持仓</el-tag>
              <span class="code-sub num">{{ row.code }}</span>
            </template>
          </el-table-column>
          <el-table-column label="方向" width="74" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="DIR_META[row.direction as PlanDirection].type as any" effect="dark">
                {{ DIR_META[row.direction as PlanDirection].label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="现价" width="80" align="right">
            <template #default="{ row }"><span class="num">{{ fmtNum(etfSig(row.code)?.price) }}</span></template>
          </el-table-column>
          <el-table-column v-if="isLive" label="涨跌幅" width="80" align="right">
            <template #default="{ row }">
              <span class="num" :class="pctCls(etfSig(row.code)?.pct)">{{ fmtPct(etfSig(row.code)?.pct) }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="折溢价" width="76" align="right">
            <template #default="{ row }">
              <span class="num" :class="pctCls(etfSig(row.code)?.premiumPct)">{{ fmtPct(etfSig(row.code)?.premiumPct) }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="估值分位" width="84" align="right">
            <template #default="{ row }">
              <span class="num">{{ etfSig(row.code)?.pricePercentile != null ? fmtNum(etfSig(row.code)?.pricePercentile, 0) + '%' : '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="年线偏离" width="84" align="right">
            <template #default="{ row }">
              <span class="num" :class="pctCls(etfSig(row.code)?.maDeviation)">{{ fmtPct(etfSig(row.code)?.maDeviation) }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="动量排名" width="80" align="right">
            <template #default="{ row }">
              <span class="num">{{ etfSig(row.code)?.momentumRank != null ? '#' + etfSig(row.code)?.momentumRank : '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="网格水位" width="84" align="center">
            <template #default="{ row }">
              <span v-if="etfSig(row.code)?.grid" class="num">
                {{ etfSig(row.code)?.grid?.level }}/{{ etfSig(row.code)?.grid?.gridCount }}
              </span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="信号建议" width="82" align="center">
            <template #default="{ row }">
              <el-tag
                v-if="etfSig(row.code)"
                size="small"
                :type="ACTION_META[etfSig(row.code)!.action].type as any"
                effect="dark"
              >
                {{ ACTION_META[etfSig(row.code)!.action].label }}
              </el-tag>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="触发状态" width="92" align="center">
            <template #default="{ row }">
              <el-tag v-if="triggerState(row)" size="small" effect="dark" class="ac-state" :class="triggerState(row)!.cls">
                {{ triggerState(row)!.label }}
              </el-tag>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="买入触发" min-width="112" align="right">
            <template #default="{ row }"><span class="num up">{{ trg(row.buyTrigger) }}</span></template>
          </el-table-column>
          <el-table-column label="止损" min-width="100" align="right">
            <template #default="{ row }"><span class="num down">{{ trg(row.stopLoss) }}</span></template>
          </el-table-column>
          <el-table-column label="止盈 / 卖点" min-width="116" align="right">
            <template #default="{ row }">
              <span class="num">{{ trg(row.takeProfit) }}</span>
              <span v-if="row.sellTrigger" class="num sub"> / {{ trg(row.sellTrigger) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="仓位" width="72" align="right">
            <template #default="{ row }"><span class="num">{{ row.positionHint || '—' }}</span></template>
          </el-table-column>
          <el-table-column prop="confidence" label="置信度" width="92" align="center" sortable>
            <template #default="{ row }">
              <div v-if="row.confidence != null" class="conf-cell">
                <div class="conf-bar"><i :class="confidenceCls(row.confidence)" :style="{ width: row.confidence + '%' }" /></div>
                <span class="conf-num" :class="confidenceCls(row.confidence)">{{ row.confidence }}</span>
              </div>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="研判" width="104" align="center">
            <template #default="{ row }">
              <el-tooltip
                v-if="row.debateVerdict"
                :content="`${row.debateNote || 'ETF agent 研判结论'} · 点击重跑深度辩论`"
                placement="top"
              >
                <el-tag
                  size="small"
                  class="debate-tag"
                  :type="debateTagType(row.debateVerdict) as any"
                  effect="dark"
                  @click="debateItem(row.code, 'etf')"
                >
                  {{ row.debateVerdict }}<span v-if="row.debateConfidence != null"> {{ row.debateConfidence }}</span>
                </el-tag>
              </el-tooltip>
              <el-button v-else link type="warning" size="small" @click="debateItem(row.code, 'etf')">
                深度辩论
              </el-button>
            </template>
          </el-table-column>
          <el-table-column label="逻辑 / 条件" min-width="200">
            <template #default="{ row }">
              <div v-if="row.thesis" class="thesis">{{ row.thesis }}</div>
              <div v-else-if="isLive && etfSig(row.code)?.notes?.length" class="thesis clamp">
                {{ etfSig(row.code)!.notes.join('；') }}
              </div>
              <div v-if="row.confirmConditions?.length" class="cond cond-confirm">
                确认：{{ row.confirmConditions.join('；') }}
              </div>
              <div v-if="row.invalidConditions?.length" class="cond cond-invalid">
                失效：{{ row.invalidConditions.join('；') }}
              </div>
              <span v-if="!row.thesis && !row.confirmConditions?.length && !row.invalidConditions?.length && !(isLive && etfSig(row.code)?.notes?.length)" class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="80" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="ITEM_STATUS_META[row.status as PlanItemStatus].type as any">
                {{ ITEM_STATUS_META[row.status as PlanItemStatus].label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="盘中备注" min-width="150">
            <template #default="{ row }"><span class="muted">{{ row.lastNote || '—' }}</span></template>
          </el-table-column>
        </el-table>
      </div>

      <!-- 个股计划（可选附属层，默认折叠，不与 ETF 主体抢版面） -->
      <el-collapse v-if="stockItems.length" class="stock-collapse section">
        <el-collapse-item name="stock">
          <template #title>
            <span class="stock-collapse-title">个股参考（折叠·{{ stockItems.length }}）</span>
            <span v-if="!isLive" class="tag-hist">历史回看·不含实时行情</span>
          </template>
          <el-table :data="stockItems" stripe style="width: 100%">
          <el-table-column label="名称" min-width="120">
            <template #default="{ row }">
              <StockLink :code="row.code" :name="row.name" />
              <span class="code-sub num">{{ row.code }}</span>
            </template>
          </el-table-column>
          <el-table-column label="方向" width="74" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="DIR_META[row.direction as PlanDirection].type as any" effect="dark">
                {{ DIR_META[row.direction as PlanDirection].label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="现价" width="84" align="right">
            <template #default="{ row }">
              <span class="num">{{ fmtNum(liveQuote(row.code)?.price) }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="涨跌幅" width="84" align="right">
            <template #default="{ row }">
              <span class="num" :class="pctCls(liveQuote(row.code)?.pct)">{{ fmtPct(liveQuote(row.code)?.pct) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="逻辑" min-width="200">
            <template #default="{ row }">
              <div class="thesis">{{ row.thesis || '—' }}</div>
              <div v-if="row.confirmConditions?.length" class="cond cond-confirm">
                确认：{{ row.confirmConditions.join('；') }}
              </div>
              <div v-if="row.invalidConditions?.length" class="cond cond-invalid">
                失效：{{ row.invalidConditions.join('；') }}
              </div>
            </template>
          </el-table-column>
          <el-table-column label="买入触发" min-width="118" align="right">
            <template #default="{ row }"><span class="num up">{{ trg(row.buyTrigger) }}</span></template>
          </el-table-column>
          <el-table-column v-if="isLive" label="距买点" width="84" align="right">
            <template #default="{ row }">
              <span class="num sub">{{ distToTrigger(row.code, row.buyTrigger) }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="触发状态" width="92" align="center">
            <template #default="{ row }">
              <el-tag v-if="triggerState(row)" size="small" effect="dark" class="ac-state" :class="triggerState(row)!.cls">
                {{ triggerState(row)!.label }}
              </el-tag>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="止损" min-width="104" align="right">
            <template #default="{ row }"><span class="num down">{{ trg(row.stopLoss) }}</span></template>
          </el-table-column>
          <el-table-column label="止盈 / 卖点" min-width="118" align="right">
            <template #default="{ row }">
              <span class="num">{{ trg(row.takeProfit) }}</span>
              <span v-if="row.sellTrigger" class="num sub"> / {{ trg(row.sellTrigger) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="仓位" width="74" align="right">
            <template #default="{ row }"><span class="num">{{ row.positionHint || '—' }}</span></template>
          </el-table-column>
          <el-table-column label="来源" width="68" align="center">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ SOURCE_LABEL[row.source as PlanItemSource] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="confidence" label="置信度" width="96" align="center" sortable>
            <template #default="{ row }">
              <div v-if="row.confidence != null" class="conf-cell">
                <div class="conf-bar"><i :class="confidenceCls(row.confidence)" :style="{ width: row.confidence + '%' }" /></div>
                <span class="conf-num" :class="confidenceCls(row.confidence)">{{ row.confidence }}</span>
              </div>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="辩论" width="96" align="center">
            <template #default="{ row }">
              <el-tooltip
                v-if="row.debateVerdict"
                :content="`${row.debateNote || '多 agent 辩论结论'} · 点击重跑深度辩论`"
                placement="top"
              >
                <el-tag
                  size="small"
                  class="debate-tag"
                  :type="debateTagType(row.debateVerdict) as any"
                  effect="dark"
                  @click="debateItem(row.code, 'stock')"
                >
                  {{ row.debateVerdict }}<span v-if="row.debateConfidence != null"> {{ row.debateConfidence }}</span>
                </el-tag>
              </el-tooltip>
              <el-button v-else link type="warning" size="small" @click="debateItem(row.code, 'stock')">
                深度辩论
              </el-button>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="80" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="ITEM_STATUS_META[row.status as PlanItemStatus].type as any">
                {{ ITEM_STATUS_META[row.status as PlanItemStatus].label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="盘中备注" min-width="150">
            <template #default="{ row }"><span class="muted">{{ row.lastNote || '—' }}</span></template>
          </el-table-column>
          </el-table>
        </el-collapse-item>
      </el-collapse>

      <el-empty v-if="!stockItems.length && !etfItems.length" :image-size="60" description="本计划暂无标的" />

      <!-- 系统选股候选（只读参考：最近一次选股引擎运行） -->
      <el-collapse v-if="screenerPicks.length" v-model="screenerOpen" class="screener-ref">
        <el-collapse-item name="screener">
          <template #title>
            <span class="screener-ref-title">
              系统选股候选
              <span class="muted">
                （{{ screenerMeta?.strategyName }}· {{ screenerMeta ? dayjs(screenerMeta.createdAt).format('MM-DD HH:mm') : '' }}）
              </span>
            </span>
            <RouterLink class="screener-ref-link" to="/screener" @click.stop>去选股页 →</RouterLink>
          </template>
          <el-table :data="screenerPicks" stripe size="small" style="width: 100%">
            <el-table-column label="#" width="44" align="center">
              <template #default="{ row }"><span class="num sub">{{ row.rank }}</span></template>
            </el-table-column>
            <el-table-column label="名称" min-width="120">
              <template #default="{ row }"><StockLink :code="row.code" :name="row.name" /></template>
            </el-table-column>
            <el-table-column label="选股分" width="80" align="right">
              <template #default="{ row }"><span class="num">{{ Math.round(row.screenScore) }}</span></template>
            </el-table-column>
            <el-table-column label="信心" width="72" align="center">
              <template #default="{ row }">
                <span v-if="row.confidence != null" class="conf-num" :class="confidenceCls(row.confidence)">{{ row.confidence }}</span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="选股逻辑" min-width="220">
              <template #default="{ row }"><span class="thesis">{{ row.thesis || '—' }}</span></template>
            </el-table-column>
            <el-table-column label="入计划" width="84" align="center">
              <template #default="{ row }">
                <el-tag v-if="planCodeSet.has(row.code)" size="small" type="success" effect="dark">已纳入</el-tag>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
          </el-table>
        </el-collapse-item>
      </el-collapse>

      <!-- 完整作战图（默认展开） -->
      <el-collapse v-if="plan.narrative" class="narr" :model-value="['narr']">
        <el-collapse-item name="narr" title="完整作战图（narrative）">
          <MarkdownView :source="plan.narrative" />
        </el-collapse-item>
      </el-collapse>

      <!-- 计划动态 -->
      <div v-if="events.length" class="section">
        <div class="section-title">计划动态</div>
        <el-timeline>
          <el-timeline-item
            v-for="ev in events"
            :key="ev.id"
            :timestamp="dayjs(ev.ts).format('MM-DD HH:mm')"
            placement="top"
            :type="EVENT_META[ev.kind].type as any"
          >
            <el-tag size="small" :type="EVENT_META[ev.kind].type as any" effect="plain">
              {{ EVENT_META[ev.kind].label }}
            </el-tag>
            <span v-if="eventText(ev)" class="event-text">{{ eventText(ev) }}</span>
          </el-timeline-item>
        </el-timeline>
      </div>

      <!-- 盘后复盘 -->
      <div v-if="plan.status === 'closed' && plan.reviewSummary" class="section review">
        <div class="section-title">盘后复盘</div>
        <pre class="narrative">{{ plan.reviewSummary }}</pre>
        <div class="meta">更新于 {{ dayjs(plan.updatedAt).format('YYYY-MM-DD HH:mm') }}</div>
      </div>
    </template>

    <!-- 计划历史抽屉 -->
    <el-drawer v-model="historyDrawer" title="计划历史" size="360px">
      <div v-loading="historyLoading" class="hist-list">
        <div
          v-for="item in historyList"
          :key="item.planDate"
          class="hist-item"
          :class="{ active: item.planDate === viewingDate }"
          @click="viewHistory(item.planDate)"
        >
          <div class="hist-row">
            <span class="hist-date num">{{ item.planDate }}</span>
            <el-tag :type="STATUS_META[item.status].type as any" effect="plain" size="small">
              {{ STATUS_META[item.status].label }}
            </el-tag>
            <span v-if="item.bias" class="hist-bias" :class="BIAS_META[item.bias].cls">
              {{ BIAS_META[item.bias].label }}
            </span>
            <span class="hist-count">{{ item.itemCount }} 只</span>
          </div>
          <div v-if="item.summary" class="hist-summary">{{ item.summary }}</div>
        </div>
        <el-empty
          v-if="!historyLoading && !historyList.length"
          :image-size="60"
          description="暂无计划记录"
        />
      </div>
    </el-drawer>

    <!-- 编排节点：taskRun 运行结果抽屉 -->
    <RunResultDrawer v-model="runDrawer" :run="activeRun" />

    <!-- 编排节点：选股引擎候选抽屉（screen_runs） -->
    <el-drawer v-model="screenerDrawer" title="选股引擎 · 本次候选" size="560px">
      <div v-loading="screenerRunLoading" class="screener-run">
        <div v-if="screenerRunDetail" class="screener-run-head">
          <span class="screener-ref-title">{{ screenerRunDetail.strategyName }}</span>
          <span class="muted">{{ dayjs(screenerRunDetail.createdAt).format('MM-DD HH:mm') }} · {{ screenerRunDetail.picks.length }} 只</span>
          <RouterLink class="screener-ref-link" to="/screener">去选股页 →</RouterLink>
        </div>
        <el-table v-if="screenerRunDetail" :data="screenerRunDetail.picks" stripe size="small" style="width: 100%">
          <el-table-column label="#" width="44" align="center">
            <template #default="{ row }"><span class="num sub">{{ row.rank }}</span></template>
          </el-table-column>
          <el-table-column label="名称" min-width="120">
            <template #default="{ row }"><StockLink :code="row.code" :name="row.name" /></template>
          </el-table-column>
          <el-table-column label="选股分" width="80" align="right">
            <template #default="{ row }"><span class="num">{{ Math.round(row.screenScore) }}</span></template>
          </el-table-column>
          <el-table-column label="信心" width="72" align="center">
            <template #default="{ row }">
              <span v-if="row.confidence != null" class="conf-num" :class="confidenceCls(row.confidence)">{{ row.confidence }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="选股逻辑" min-width="220">
            <template #default="{ row }"><span class="thesis">{{ row.thesis || '—' }}</span></template>
          </el-table-column>
        </el-table>
        <el-empty
          v-if="!screenerRunLoading && (!screenerRunDetail || !screenerRunDetail.picks.length)"
          :image-size="60"
          description="本次选股无候选"
        />
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.debate-tag {
  cursor: pointer;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.meta {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

/* 一键计划管线进度 */
.pipeline {
  margin: 12px 0 4px;
  padding: 12px 14px;
  border: 1px solid var(--el-border-color);
  border-left: 3px solid var(--el-color-warning);
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
}
.pipeline.done {
  border-left-color: var(--el-color-success);
}
.pipeline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.pipeline-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 14px;
}
.pipeline-time {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.pipeline-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.pl-step {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 6px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  font-size: 12.5px;
}
.pl-step.running {
  border-color: var(--el-color-warning);
}
.pl-step.success {
  border-color: var(--el-color-success);
}
.pl-step.error {
  border-color: var(--el-color-danger);
}
.pl-step.clickable {
  cursor: pointer;
  transition: box-shadow 0.15s, transform 0.15s;
}
.pl-step.clickable:hover {
  box-shadow: 0 2px 8px var(--el-color-info-light-7);
  transform: translateY(-1px);
}
.pl-view {
  font-size: 11.5px;
  color: var(--el-color-primary);
}
.screener-run-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.pl-idx {
  color: var(--el-text-color-secondary);
  font-size: 11px;
}
.pl-icon {
  font-size: 13px;
}
.pl-step.running .pl-icon {
  color: var(--el-color-warning);
}
.pl-step.success .pl-icon {
  color: var(--el-color-success);
}
.pl-step.error .pl-icon {
  color: var(--el-color-danger);
}
.pl-label {
  font-weight: 600;
}
.pl-err {
  color: var(--el-color-danger);
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.muted {
  color: var(--el-text-color-secondary);
}
.section {
  margin-top: 18px;
}
.section-title {
  font-weight: 600;
  margin-bottom: 10px;
  font-size: 15px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}
.card {
  background: var(--el-fill-color-light);
  border-radius: 8px;
  padding: 12px 14px;
}
.card-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 6px;
}
.card-value {
  font-size: 20px;
  font-weight: 600;
}
.stance-summary {
  margin-top: 12px;
  padding: 10px 14px;
  background: var(--el-fill-color-lighter);
  border-radius: 8px;
  line-height: 1.6;
}
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.ext {
  line-height: 1.7;
  white-space: pre-wrap;
}
.sectors {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sector {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sector-name {
  font-weight: 600;
}
.sector-reason {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.thesis {
  font-size: 13px;
  line-height: 1.5;
}
.cond {
  font-size: 12px;
  line-height: 1.45;
  margin-top: 3px;
}
.cond-confirm {
  color: var(--el-color-success);
}
.cond-invalid {
  color: var(--el-color-warning);
}
.thesis.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* 置信度列：进度条 + 数值 */
.conf-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
}
.conf-bar {
  flex: 1;
  height: 5px;
  border-radius: 3px;
  background: var(--el-fill-color);
  overflow: hidden;
  max-width: 44px;
}
.conf-bar i {
  display: block;
  height: 100%;
  border-radius: 3px;
}
.conf-num {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 600;
}
.conf-num.conf-high {
  color: var(--el-color-success);
}
.conf-num.conf-mid {
  color: var(--el-color-warning);
}
.conf-num.conf-low {
  color: var(--el-text-color-secondary);
}
.conf-bar i.conf-high {
  background: var(--el-color-success);
}
.conf-bar i.conf-mid {
  background: var(--el-color-warning);
}
.conf-bar i.conf-low {
  background: var(--el-text-color-secondary);
}
/* 系统选股候选只读区 */
.screener-ref {
  margin-top: 12px;
}
.screener-ref-title {
  font-weight: 600;
}
.screener-ref-link {
  margin-left: auto;
  margin-right: 12px;
  font-size: 13px;
  color: var(--el-color-primary);
  text-decoration: none;
}
.code-sub {
  margin-left: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.held-tag {
  margin-left: 6px;
  transform: scale(0.88);
}
.stock-collapse-title {
  font-weight: 600;
  font-size: 15px;
}
.tag-hist {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.fulfill {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}
.fulfill-rate {
  display: flex;
  align-items: baseline;
  gap: 2px;
}
.fulfill-num {
  font-size: 32px;
  font-weight: 700;
  color: var(--el-color-primary);
}
.fulfill-pct {
  font-size: 16px;
  color: var(--el-color-primary);
}
.fulfill-cap {
  margin-left: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.fulfill-stats {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 13px;
}
.fulfill-stats .warn {
  color: var(--el-color-warning);
}
.fulfill-stats .muted {
  color: var(--el-text-color-secondary);
}
.event-text {
  margin-left: 8px;
  font-size: 13px;
}
.sub {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.narr {
  margin-top: 18px;
}
.review {
  background: var(--el-fill-color-lighter);
  border-radius: 8px;
  padding: 14px 16px;
}
.hist-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hist-item {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
  cursor: pointer;
  transition: background 0.15s;
}
.hist-item:hover {
  background: var(--el-fill-color);
}
.hist-item.active {
  outline: 1px solid var(--el-color-primary);
}
.hist-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.hist-date {
  font-weight: 600;
}
.hist-bias.up {
  color: var(--el-color-danger);
}
.hist-bias.down {
  color: var(--el-color-success);
}
.hist-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.hist-summary {
  margin-top: 6px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}
@media (max-width: 760px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}

/* A 今日操作清单 */
.action-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.action-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 13px;
}
.ac-dir {
  flex-shrink: 0;
}
.ac-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 150px;
  font-weight: 600;
}
.ac-type {
  transform: scale(0.85);
}
.ac-trgs {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.ac-trg {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.ac-trg b {
  margin-left: 2px;
  font-weight: 600;
}
.ac-conf {
  margin-left: auto;
  flex-shrink: 0;
}
.ac-note {
  flex-basis: 100%;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.4;
}
/* 触发状态彩色标签（A 清单 + 两表共用） */
.ac-state {
  flex-shrink: 0;
  border: none;
}
.ac-state.ts-stop {
  background: var(--el-color-danger);
  color: #fff;
}
.ac-state.ts-active {
  background: var(--el-color-danger);
  color: #fff;
}
.ac-state.ts-near {
  background: var(--el-color-warning);
  color: #fff;
}
.ac-state.ts-profit {
  background: var(--el-color-success);
  color: #fff;
}
.ac-state.ts-wait {
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
}
.watch-pool {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--el-border-color-lighter);
}
.watch-cap {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-weight: 600;
}
.watch-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
}

/* E 分时作战 */
.intraday {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}
.intraday-phase {
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
}
.intraday-phase.active {
  border-color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
}
.ip-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.ip-label {
  font-weight: 600;
}
.ip-range {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.ip-text {
  font-size: 13px;
  line-height: 1.5;
}

/* C 仓位对照 */
.poscmp-cards {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.poscmp-cards .card {
  min-width: 120px;
}
.poscmp-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
}
.poscmp-cap {
  font-size: 12px;
  font-weight: 600;
}
.poscmp-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
}

/* D 今日风险 */
.risk-section {
  border-left: 3px solid var(--el-color-danger);
  padding-left: 12px;
}
.risk-list {
  margin: 0;
  padding-left: 20px;
  line-height: 1.7;
  font-size: 13px;
  color: var(--el-color-danger);
}
.risk-invalid {
  margin-top: 12px;
}
.risk-invalid-cap {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 6px;
}
.risk-invalid-row {
  display: flex;
  gap: 8px;
  font-size: 13px;
  line-height: 1.5;
  padding: 3px 0;
}
.riv-name {
  font-weight: 600;
  flex-shrink: 0;
}
.riv-cond {
  color: var(--el-color-warning);
}
</style>
