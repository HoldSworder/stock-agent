<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import dayjs from 'dayjs';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import StockLink from '@/components/StockLink.vue';
import type {
  ActionDataSource,
  CockpitAction,
  CockpitActionPlan,
  CockpitActionPriority,
  SourceFreshness,
} from '@stock-agent/shared';
import {
  COCKPIT_ACTION_EMPTY_TEXT,
  COCKPIT_ACTION_KIND_LABELS,
  actionDistanceText,
} from '@stock-agent/shared';

/**
 * 今日动作清单（L0 总纲 + L1 清单）。
 *
 * 这是驾驶舱重构后的主体：原来一屏铺 60-80 个读数，用户得自己在脑子里合成「今天先做什么」。
 * 现在读数全部降级为证据，这里只回答一件事——按顺序该做哪几件。
 *
 * 三条界面纪律，都是「弄错了会让人亏钱」那类：
 *   1. 数据完整性状态**不可折叠**。看不见「持仓还没查完」就会把不完整的清单当完整的做。
 *   2. 动作卡**不显示任何单来源准确率数字**。安慰剂对照显示六套画线方法没有一套强于
 *      同距离随机价位，标个「黄金分割 51%」等于暗示它有预测力。完整统计在证据区。
 *   3. 空清单要**分清四种原因**。「今天没事做」和「还没查完」长得一样但意思相反。
 */

const plan = ref<CockpitActionPlan | null>(null);
const loading = ref(false);
const error = ref('');
const router = useRouter();

async function load(): Promise<void> {
  loading.value = true;
  try {
    plan.value = await api.cockpit.actions();
    error.value = '';
  } catch (e) {
    plan.value = null;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/**
 * 盘中自动刷新。
 *
 * 三条约束，都不是可有可无的：
 * 1. **上一次完成后再等 60 秒**，不用 setInterval。这个接口要取持仓、纪律、行情，
 *    实测几秒起步，固定间隔会在慢的时候让请求首尾相接堆起来。
 * 2. **页面看不见就停**。切到别的标签页还在每分钟打一次上游，纯属浪费配额。
 * 3. **非交易时段不轮询**。收盘后数据不再变，刷新只会让人以为它在动。
 *
 * 只刷动作清单。日频区块（全景、板块、情绪）一天也不会变，跟着重拉是白费。
 */
const POLL_MS = 60_000;
let timer: ReturnType<typeof setTimeout> | null = null;

/** A股连续竞价时段（含集合竞价起点），与后端 isAShareTradingTime 同口径 */
function inTradingHours(): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const mins = Number(get('hour')) * 60 + Number(get('minute'));
  return (mins >= 9 * 60 + 15 && mins <= 11 * 60 + 30) || (mins >= 13 * 60 && mins <= 15 * 60);
}

function scheduleNext(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void tick();
  }, POLL_MS);
}

async function tick(): Promise<void> {
  if (document.hidden || !inTradingHours()) {
    // 不刷，但继续排下一次：盘前打开页面，到点会自己接上
    scheduleNext();
    return;
  }
  await load();
  scheduleNext();
}

function onVisibility(): void {
  // 切回来时立刻补一次，否则要再等满一个周期才更新
  if (!document.hidden && inTradingHours()) void load();
}

onMounted(() => {
  void load();
  scheduleNext();
  document.addEventListener('visibilitychange', onVisibility);
});

onUnmounted(() => {
  if (timer) clearTimeout(timer);
  document.removeEventListener('visibilitychange', onVisibility);
});

defineExpose({ load });

const actions = computed(() => plan.value?.actions ?? []);
const completeness = computed(() => plan.value?.completeness ?? null);

/** 按优先级分组，保持后端给的组内顺序 */
const groups = computed(() => {
  const order: CockpitActionPriority[] = ['P0', 'P1', 'P2', 'P3'];
  return order
    .map((p) => ({ priority: p, label: TIER_LABEL[p], items: actions.value.filter((a) => a.priority === p) }))
    .filter((g) => g.items.length > 0);
});

/** 分层标题说的是「为什么要现在做」，不是抽象的优先级代号 */
const TIER_LABEL: Record<CockpitActionPriority, string> = {
  P0: '先处理这个 · 不做会亏钱',
  P1: '今天要想清楚',
  P2: '有机会可以做',
  P3: '记个号就行',
};

const tierClass = (p: CockpitActionPriority) => `tier-${p.toLowerCase()}`;

/** 取数状态的颜色：过期与失败都要看得见，不能只给个灰点 */
const freshType = (s: SourceFreshness['state']) =>
  s === 'ok' ? 'success' : s === 'stale' ? 'warning' : 'danger';
const freshText = (f: SourceFreshness): string =>
  f.state === 'ok' ? `${f.label} 最新` : f.note || `${f.label}不可用`;

function goEvidence(e: CockpitAction['evidence'][number]): void {
  void router.push(e.anchor ? { path: e.route, hash: `#${e.anchor}` } : e.route);
}

/** 断供的来源 */
const outages = computed(() => completeness.value?.outages ?? []);

/** A股红涨绿跌 */
const dirOf = (v: number): string => (v > 0 ? 'up' : v < 0 ? 'down' : '');

// 距离措辞直接用 shared 的实现，不在这里再写一份：
// 各写一份就会出现后端说「已跌破」、界面说「已越过」这种同一条动作两个说法
const distanceText = actionDistanceText;

/** 今日计划缺失。missing 才算，failed 是另一回事（取数坏了，不是没生成） */
const planMissing = computed(
  () => completeness.value?.sources.some((s) => s.source === 'plan' && s.state === 'missing') ?? false,
);

/** 各数据源对应的调度关键词，用来带着筛选条件跳进调度页 */
const SCHEDULE_KEYWORD: Partial<Record<ActionDataSource, string>> = {
  boards: 'breadth',
  rotation: 'etf',
  plan: 'plan',
  discipline: 'discipline',
  positions: 'discipline',
};

/**
 * 跳到调度页并带上筛选。
 *
 * 直接跳过去等于把人丢进 40 多条混排列表自己找——这正是这批任务关了三周没人发现的原因。
 */
function goSchedules(source: ActionDataSource): void {
  void router.push({
    path: '/core',
    query: { tab: 'schedules', q: SCHEDULE_KEYWORD[source] ?? '', attention: '1' },
  });
}
</script>

<template>
  <section class="today-action" v-loading="loading">
    <div class="ta-head">
      <div class="ta-title">今天按顺序做这几件事</div>
      <div class="ta-head-right">
        <span v-if="plan" class="ta-asof">{{ dayjs(plan.asOf).format('MM-DD HH:mm:ss') }}</span>
        <el-button :icon="Refresh" size="small" text :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <!--
      断供是「系统在拿旧结论冒充今天的判断」，比一般的数据不全严重一个量级，
      所以单独一条、放在最前、给可直达的处理入口。
      实测发生过板块判断停更 22 天而界面只说「不是今天的」，那种说法看不出严重性。
    -->
    <div v-if="outages.length" class="ta-outage">
      <div class="ta-outage-title">这些数据早就停更了，下面的判断别当今天的看</div>
      <div v-for="f in outages" :key="f.source" class="ta-outage-row">
        <span>{{ f.note }}</span>
        <a class="ta-outage-go" @click="goSchedules(f.source)">去看是不是没开 →</a>
      </div>
    </div>

    <!-- 数据完整性：常驻不可折叠。清单是否可信全看这一行 -->
    <div v-if="completeness" class="ta-fresh" :class="{ bad: !completeness.riskReady }">
      <span class="ta-fresh-sum">{{ completeness.summary }}</span>
      <span class="ta-fresh-dots">
        <el-tag
          v-for="f in completeness.sources"
          :key="f.source"
          size="small"
          :type="freshType(f.state)"
          effect="plain"
        >
          {{ freshText(f) }}
        </el-tag>
      </span>
    </div>

    <!--
      今日计划没生成时必须明说。它是 P2 动作的主要来源，缺了就只剩纪律类动作，
      而清单看起来仍然「正常」——用户会以为今天真的没什么可做。
      生成要调模型、花钱，所以只给入口不自动跑。
    -->
    <div v-if="planMissing" class="ta-noplan">
      今日计划还没生成，所以下面没有买点、卖点这类计划动作。
      <RouterLink to="/plan">去计划页手动生成 →</RouterLink>
      <a class="ta-outage-go" @click="goSchedules('plan')">或看看盘前定时开没开 →</a>
    </div>

    <div v-if="error" class="ta-error">⚠ 动作清单取数失败：{{ error }}（数据未到，不是功能下线）</div>

    <!-- 空清单：四种原因说法各不相同，绝不含糊成一句「暂无」 -->
    <div v-else-if="plan && actions.length === 0" class="ta-empty">
      {{ plan.emptyReason ? COCKPIT_ACTION_EMPTY_TEXT[plan.emptyReason] : '暂无动作' }}
    </div>

    <div v-for="g in groups" :key="g.priority" class="ta-tier">
      <div class="ta-tier-head" :class="tierClass(g.priority)">
        <span class="ta-tier-label">{{ g.label }}</span>
        <span class="ta-tier-count">{{ g.items.length }}</span>
      </div>
      <div
        v-for="a in g.items"
        :key="a.id"
        class="ta-card"
        :class="[tierClass(a.priority), { blocked: a.readiness === 'blocked' }]"
      >
        <div class="ta-card-top">
          <el-tag size="small" :type="a.priority === 'P0' ? 'danger' : a.priority === 'P1' ? 'warning' : 'info'">
            {{ COCKPIT_ACTION_KIND_LABELS[a.kind] }}
          </el-tag>
          <StockLink v-if="a.code" :code="a.code" :name="a.name ?? a.code" />
          <span class="ta-when">{{ a.when }}</span>
        </div>
        <div class="ta-what">{{ a.what }}</div>
        <!--
          实时叠加：日频判断说「该用什么姿态」，这一行说「现在走到哪了」。
          取不到时如实说未更新，绝不显示一个不标时间的旧价——那会让人误判还差多远
        -->
        <div class="ta-live">
          <template v-if="a.live">
            <span class="ta-price num" :class="dirOf(a.live.changePct)">
              {{ a.live.price.toFixed(3) }}
              <span class="ta-chg">{{ a.live.changePct >= 0 ? '+' : '' }}{{ a.live.changePct.toFixed(2) }}%</span>
            </span>
            <span v-if="distanceText(a)" class="ta-dist" :class="{ crossed: (a.distancePct ?? 1) < 0 }">
              {{ distanceText(a) }}
            </span>
          </template>
          <span v-else class="ta-dist muted">行情暂时取不到，距离未更新</span>
        </div>
        <div v-if="a.blockedReason" class="ta-blocked">{{ a.blockedReason }}</div>
        <div class="ta-why">{{ a.why }}</div>
        <div class="ta-foot">
          <!-- 只写依据来自哪套方法，不带任何准确率数字：安慰剂对照还没证明它们强于随机 -->
          <span v-if="a.basisSources.length" class="ta-basis">
            依据包含 {{ a.basisSources.join('、') }}
          </span>
          <span v-if="a.dataAt" class="ta-dataat">数据 {{ dayjs(a.dataAt).format('MM-DD HH:mm') }}</span>
          <a
            v-for="e in a.evidence"
            :key="e.route + (e.anchor ?? '')"
            class="ta-ev"
            @click="goEvidence(e)"
            >{{ e.label }} →</a
          >
        </div>
      </div>
    </div>

    <div v-if="plan && plan.omitted > 0" class="ta-omitted">
      另有 {{ plan.omitted }} 项机会类未展开（风险项从不折叠）
    </div>
  </section>
</template>

<style scoped>
.today-action {
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
  background: var(--el-bg-color-overlay);
}
.ta-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.ta-title {
  font-size: 15px;
  font-weight: 600;
}
.ta-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ta-asof {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}
.ta-fresh {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 12px;
  margin-bottom: 10px;
}
.ta-fresh.bad {
  background: var(--el-color-warning-light-9);
  border: 1px solid var(--el-color-warning-light-5);
}
.ta-fresh-sum {
  color: var(--el-text-color-regular);
}
.ta-fresh-dots {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.ta-outage {
  margin-bottom: 10px;
  padding: 8px 10px;
  border: 1px solid var(--el-color-danger-light-5);
  border-radius: 6px;
  background: var(--el-color-danger-light-9);
}
.ta-outage-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-color-danger);
  margin-bottom: 4px;
}
.ta-outage-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  font-size: 12.5px;
  line-height: 1.6;
}
.ta-outage-go {
  cursor: pointer;
  color: var(--el-color-primary);
  white-space: nowrap;
}
.ta-noplan {
  margin-bottom: 10px;
  padding: 7px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 12.5px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
}
.ta-error {
  padding: 8px;
  font-size: 13px;
  color: var(--el-color-danger);
}
.ta-empty {
  padding: 16px 8px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.ta-tier {
  margin-top: 10px;
}
.ta-tier-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  padding: 2px 0 6px;
}
.ta-tier-head.tier-p0 {
  color: var(--el-color-danger);
}
.ta-tier-head.tier-p1 {
  color: var(--el-color-warning);
}
.ta-tier-head.tier-p2,
.ta-tier-head.tier-p3 {
  color: var(--el-text-color-secondary);
}
.ta-tier-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}
.ta-card {
  border: 1px solid var(--el-border-color-lighter);
  border-left-width: 3px;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 6px;
}
.ta-card.tier-p0 {
  border-left-color: var(--el-color-danger);
}
.ta-card.tier-p1 {
  border-left-color: var(--el-color-warning);
}
.ta-card.tier-p2 {
  border-left-color: var(--el-color-primary);
}
.ta-card.tier-p3 {
  border-left-color: var(--el-border-color);
}
.ta-card.blocked {
  opacity: 0.72;
}
.ta-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ta-when {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.ta-what {
  margin-top: 4px;
  font-size: 14px;
  font-weight: 500;
}
.ta-blocked {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-color-warning);
}
.ta-live {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: baseline;
  margin-top: 3px;
  font-size: 12.5px;
}
.ta-price {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.ta-price.up {
  color: var(--el-color-danger);
}
.ta-price.down {
  color: var(--el-color-success);
}
.ta-chg {
  margin-left: 4px;
  font-weight: 400;
}
.ta-dist {
  color: var(--el-text-color-regular);
}
.ta-dist.crossed {
  /* 已越过要看得出来：这是「现在就该处理」和「还早」的分界 */
  color: var(--el-color-warning);
  font-weight: 500;
}
.ta-dist.muted {
  color: var(--el-text-color-secondary);
}
.ta-why {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  line-height: 1.5;
}
.ta-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.ta-ev {
  cursor: pointer;
  color: var(--el-color-primary);
}
.ta-omitted {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
