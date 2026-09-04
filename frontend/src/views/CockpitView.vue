<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import dayjs from 'dayjs';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Refresh, Warning, VideoPause, VideoPlay } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useWatchStore } from '@/stores/watch';
import AiAnalysisHub from '@/components/AiAnalysisHub.vue';
import StockLink from '@/components/StockLink.vue';
import MoneyEffectBadge from '@/components/MoneyEffectBadge.vue';
import PanoramaPanel from '@/components/PanoramaPanel.vue';
import TodayActionPanel from '@/components/TodayActionPanel.vue';
import IndexFundFlowPanel from '@/components/IndexFundFlowPanel.vue';
import CockpitFocusPanel from '@/components/CockpitFocusPanel.vue';
import { EXPO_STATUS_LABEL, EXPO_STATUS_TYPE } from '@/constants/boardTags';
import type {
  BoardExposureHolding,
  CockpitEvent,
  CockpitModuleSummary,
  CockpitOverview,
  PositionAttributionReport,
  SafetyState,
  TurningCalendar,
  TurningExpect,
  AssertionAccuracyReport,
} from '@stock-agent/shared';
import { TURNING_MIN_STREAK, turningActionText } from '@stock-agent/shared';

const data = ref<CockpitOverview | null>(null);
const loading = ref(false);
const acting = ref(false);
// 当日盈亏归因（只读旁路，收盘后落库；驾驶舱仅显示账户贡献 + 最大赢/输家）
const attribution = ref<PositionAttributionReport | null>(null);
// 今日主线作战台（旁路：投影自主线共识，含操盘动作标签）
// 持仓/自选板块暴露（旁路：主线板块成分 ∩ 我的持仓/自选）
const exposure = ref<BoardExposureHolding[]>([]);

const route = useRoute();
const router = useRouter();

// 两 tab：驾驶舱主模块（只读聚合 + 急停）/ AI 分析中心（发起 + 历史 + 定时调度）。
const VALID_TABS = ['cockpit', 'ai'] as const;
type CockpitTab = (typeof VALID_TABS)[number];
function normalizeTab(v: unknown): CockpitTab {
  return VALID_TABS.includes(v as CockpitTab) ? (v as CockpitTab) : 'cockpit';
}
const tab = ref<CockpitTab>(normalizeTab(route.query.tab));
watch(
  () => route.query.tab,
  (v) => {
    tab.value = normalizeTab(v);
  },
);
watch(tab, (v) => {
  if (route.query.tab !== v) router.replace({ query: { ...route.query, tab: v } });
});

const safety = computed<SafetyState | null>(() => data.value?.safety ?? null);

// 自动成交实时流（auto_buy/auto_sell/rejected），经盯盘总线 /ws/watch 推送
const watchStore = useWatchStore();
const autoTrades = computed(() => watchStore.trades.slice(0, 8));
const moneyEffect = computed(() => data.value?.moneyEffect ?? null);
const modules = computed(() => data.value?.modules ?? []);
/**
 * 「今日各家怎么看」：情报 / 大盘板块 / ETF / 复盘 / 情绪 / 选股。
 *
 * 原本 12 张卡等权铺网格，占掉半屏却谁也不比谁重要。现在按它回答的问题分流：
 * 已经变成动作的（纪律、盯盘、计划）不再重复放卡，研究类下沉折叠。
 */
const analysisModules = computed(() => modules.value.filter((m) => m.group === 'analysis'));
/** 研究参考：与今天做什么无关，默认折叠 */
const researchModules = computed(() => modules.value.filter((m) => m.group === 'research'));
const researchOpen = ref(false);
const screenerPicks = computed(() => data.value?.screenerPicks ?? []);
const events = computed(() => data.value?.events ?? []);

/** 跳转模块全文页（带可选 query） */
function goModule(m: CockpitModuleSummary) {
  void router.push(m.routeQuery ? { path: m.route, query: m.routeQuery } : m.route);
}

const KIND_LABEL: Record<CockpitEvent['kind'], string> = {
  discipline: '持仓纪律',
  trade: '模拟成交',
  watch: '盯盘',
  decision: '研判',
  plan: '计划',
};
// 类型标签仅作分类（不参与涨跌色语义），严重度由左侧语义色点表达
const kindTag = (k: CockpitEvent['kind']) =>
  k === 'discipline'
    ? 'warning'
    : k === 'watch'
      ? 'danger'
      : k === 'decision'
        ? 'primary'
        : k === 'plan'
          ? 'success'
          : 'info';
const sevDot = (s: CockpitEvent['severity']) =>
  s === 'high' ? 'high' : s === 'warn' ? 'warn' : 'info';

async function load() {
  loading.value = true;
  try {
    data.value = await api.cockpit.overview();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
  // 以下三块为只读旁路，独立拉取。失败时记下原因并在对应位置显示说明——
  // 从前是 catch 后置空导致整块 section 凭空消失，用户看到的是「功能没了」而不是「数据没来」。
  try {
    attribution.value = await api.attribution();
    sideErrors.attribution = '';
  } catch (e) {
    attribution.value = null;
    sideErrors.attribution = e instanceof Error ? e.message : String(e);
  }
  try {
    exposure.value = (await api.boards.exposure()).holdings;
    sideErrors.exposure = '';
  } catch (e) {
    exposure.value = [];
    sideErrors.exposure = e instanceof Error ? e.message : String(e);
  }
}

/**
 * 转折日历单独拉，不挂在上面那条串行链后面。
 *
 * 实测挂在链尾时它要等归因与板块暴露都回来才发请求，整整 40 秒后才出现——
 * 而这张卡的全部意义就是「盘前扫一眼就知道这几天哪天可能转折」，等 40 秒等于没有。
 * 它只读账本、不依赖上面任何一块的结果，本来就没有串行的理由。
 */
async function loadTurning(): Promise<void> {
  try {
    turning.value = await api.assertions.calendar({ days: TURNING_DAYS });
    sideErrors.turning = '';
  } catch (e) {
    turning.value = null;
    sideErrors.turning = e instanceof Error ? e.message : String(e);
  }
}

/** 驾驶舱只看未来一周多一点：更远的转折不影响今天要做的事，完整清单去 /calendar */
const TURNING_DAYS = 10;
const turning = ref<TurningCalendar | null>(null);

/**
 * 说准率总体一句话。
 *
 * 只在这里给一个总数与入口，不在动作卡上标任何单来源比例——
 * 安慰剂对照显示六套画线方法没有一套强于同距离随机价位，
 * 把「黄金分割 51%」贴在动作旁边等于暗示它有预测力。完整统计去 /accuracy。
 */
const accuracy = ref<AssertionAccuracyReport | null>(null);
async function loadAccuracy(): Promise<void> {
  try {
    accuracy.value = await api.assertions.report();
  } catch {
    accuracy.value = null;
  }
}

/** 技术观察折叠区：只报待观察的数量与入口，不参与今天的买卖排序 */
const techOpen = ref(false);
const weeklyTurnCount = computed(() => turning.value?.weekly.entries.length ?? 0);
// 与转折日历页逐字一致：同一条预测在两个页面读到不同说法，比措辞不好更糟
const EXPECT_LABEL: Record<TurningExpect, string> = {
  high: '可能见高点',
  low: '可能见低点',
  unknown: '方向说不准',
};
/** 「8月26日 周三」——带星期，判断「是不是这周内」比看月日快 */
const TURN_WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function turnDateText(iso: string): string {
  const d = dayjs(iso);
  return `${d.month() + 1}月${d.date()}日 ${TURN_WEEKDAY[d.day()]}`;
}

/** 旁路区块的取数失败原因（空串=正常）；显式呈现，避免区块静默消失 */
const sideErrors = reactive({ attribution: '', exposure: '', turning: '' });

/**
 * L2 证据区的展开状态，记在 localStorage。
 *
 * 默认折叠：这些区块回答的是「为什么」，与动作清单同屏摊开会把「做什么」淹掉。
 * 但用户一旦展开过就说明他想常看，下次进来不该又给他收上。
 */
const EVIDENCE_KEY = 'cockpit:evidenceOpen';
const evidenceOpen = ref(localStorage.getItem(EVIDENCE_KEY) === '1');
function toggleEvidence(): void {
  evidenceOpen.value = !evidenceOpen.value;
  localStorage.setItem(EVIDENCE_KEY, evidenceOpen.value ? '1' : '0');
}

/**
 * 带 #ev-xxx 锚点进来时自动展开证据区并滚过去。
 *
 * 没有这一步的话，动作卡上的「查看 →」跳回本页会什么都不发生——
 * 目标区块正折叠着，用户只会以为链接坏了。
 */
function revealAnchor(): void {
  const id = location.hash.replace(/^#/, '');
  if (!id.startsWith('ev-')) return;
  evidenceOpen.value = true;
  // 等 v-show 那一帧渲染完再滚，否则量到的是折叠状态下的位置
  requestAnimationFrame(() => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}


// 贡献（小数）格式化为百分点文本：+0.42pct / -0.18pct
const contribText = (v: number) => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + 'pct';
// A股 红涨绿跌：正 -> up(红)，负 -> down(绿)
const dir = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

async function doKill() {
  try {
    const { value } = await ElMessageBox.prompt(
      '拉下安全总闸后，系统自己下的模拟动作（本地战法、妙想模拟、盯盘自动卖出）将被立即拒绝。\n注意：它管不到你在券商的真实持仓，该止损的还是要自己去止损。可填写原因：',
      '急停确认',
      { confirmButtonText: '确认急停', cancelButtonText: '取消', inputPlaceholder: '急停原因（可选）' },
    );
    acting.value = true;
    const s = await api.safety.kill(value || undefined);
    if (data.value) data.value.safety = s;
    ElMessage.success('已拉下安全总闸');
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    acting.value = false;
  }
}

async function doResume() {
  try {
    await ElMessageBox.confirm('确认解除安全总闸？解除后将恢复受各自动开关约束的交易/模拟。', '解除急停', {
      confirmButtonText: '解除',
      cancelButtonText: '取消',
    });
    acting.value = true;
    const s = await api.safety.resume();
    if (data.value) data.value.safety = s;
    ElMessage.success('已解除安全总闸');
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    acting.value = false;
  }
}

// 自动本地模拟总闸：开启后才允许 cron/agent 定时任务（尾盘 1445 / 妙想 0933）自动建仓
async function toggleAutoLocalSim(on: boolean) {
  try {
    acting.value = true;
    const s = await api.safety.update({ autoLocalSimEnabled: on });
    if (data.value) data.value.safety = s;
    ElMessage.success(on ? '已开启自动本地模拟' : '已关闭自动本地模拟');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    acting.value = false;
  }
}

// 自动外部（妙想）模拟总闸：开启后才允许妙想模拟盘自动下单
async function toggleAutoExternalSim(on: boolean) {
  try {
    acting.value = true;
    const s = await api.safety.update({ autoExternalSimEnabled: on });
    if (data.value) data.value.safety = s;
    ElMessage.success(on ? '已开启自动外部（妙想）模拟' : '已关闭自动外部（妙想）模拟');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    acting.value = false;
  }
}

// 手动强制成交闸：开启后手动单可跳过「非交易日/非交易时段」校验（如收盘后按收盘价补录）；关闭则手动强制单亦被拒。急停时一票否决，与本闸无关。
async function toggleManualForce(on: boolean) {
  try {
    acting.value = true;
    const s = await api.safety.update({ allowManualForceTrade: on });
    if (data.value) data.value.safety = s;
    ElMessage.success(on ? '已允许手动强制成交' : '已禁用手动强制成交');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    acting.value = false;
  }
}

const TRADE_KIND_LABEL: Record<'auto_buy' | 'auto_sell' | 'rejected', string> = {
  auto_buy: '自动买入',
  auto_sell: '自动卖出',
  rejected: '被拒',
};

onMounted(() => {
  void load();
  void loadTurning();
  void loadAccuracy();
  watchStore.connect();
  revealAnchor();
});
watch(() => route.hash, revealAnchor);

onUnmounted(() => {
  watchStore.disconnect();
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">驾驶舱</div>
      <div class="head-actions">
        <el-button :icon="Refresh" type="primary" :loading="loading" @click="load(); loadTurning()">刷新</el-button>
      </div>
    </div>
    <div class="page-sub">
      系统唯一入口：各页结论都汇总在这里，明细点各块「查看 →」展开；急停与跨模块事件时间线常驻。
      <span v-if="data" class="as-of">更新于 {{ dayjs(data.asOf).format('MM-DD HH:mm:ss') }}</span>
    </div>

    <el-tabs v-model="tab" class="cockpit-tabs">
      <el-tab-pane label="驾驶舱" name="cockpit">
        <div v-loading="loading">
          <!-- ===== L0 今日总纲：不可折叠。安全状态与数据完整性看不见，
               整份清单就没法判断可不可信 ===== -->
          <!-- 安全总闸 / 急停 -->
          <div v-if="safety" class="safety-bar" :class="{ killed: safety.killSwitch }">
            <div class="safety-state">
              <el-icon class="safety-ic">
                <Warning v-if="safety.killSwitch" />
                <VideoPlay v-else />
              </el-icon>
              <div>
                <div class="safety-title">
                  {{ safety.killSwitch ? '安全总闸已拉下（急停中）' : '安全总闸正常' }}
                  <!-- 必须点明管辖范围：这个闸只拦系统自己下的模拟单，
                       券商里的真实持仓它一点都管不到。以为拉了闸就不用管止损，是会亏钱的误解 -->
                  <span class="safety-scope">只管系统下的模拟单，管不到你在券商的真实持仓</span>
                </div>
                <div class="safety-meta">
                  <span class="sw">
                    自动本地模拟
                    <el-switch
                      :model-value="safety.autoLocalSimEnabled"
                      :disabled="acting || safety.killSwitch"
                      size="small"
                      @change="(v: boolean) => toggleAutoLocalSim(v)"
                    />
                  </span>
                  <span class="sep">/</span>
                  <span class="sw">
                    自动外部模拟
                    <el-switch
                      :model-value="safety.autoExternalSimEnabled"
                      :disabled="acting || safety.killSwitch"
                      size="small"
                      @change="(v: boolean) => toggleAutoExternalSim(v)"
                    />
                  </span>
                  <span class="sep">/</span>
                  <span class="sw">
                    手动强制成交
                    <el-switch
                      :model-value="safety.allowManualForceTrade"
                      :disabled="acting || safety.killSwitch"
                      size="small"
                      @change="(v: boolean) => toggleManualForce(v)"
                    />
                  </span>
                  <span class="sep">/</span>
                  <el-popover placement="bottom-start" :width="440" trigger="hover">
                    <template #reference>
                      <span class="gate-help">闸门流向 &amp; 全部开关位置 ⓘ</span>
                    </template>
                    <div class="gate-map">
                      <div class="gm-title">自动模拟下单 —— 逐层放行（任一层关 = 拒单）</div>
                      <ol>
                        <li>① <b>未急停</b><span class="gm-loc">本驾驶舱 · 急停按钮</span></li>
                        <li>② <b>自动本地 / 外部模拟</b> 开<span class="gm-loc">本驾驶舱 · 安全条开关</span></li>
                        <li>
                          ③ <b>自动模拟总闸</b> + 该战法 <b>白名单</b> 同时开
                          <span class="gm-loc">「战法」页 · 总闸在「用之后的新数据检验」区，白名单在战法编辑弹窗</span>
                        </li>
                        <li>④ <b>交易日 + 交易时段</b><span class="gm-loc">系统自动判定，无开关</span></li>
                      </ol>
                      <div class="gm-title">手动强制成交（本驾驶舱开关）</div>
                      <div class="gm-note">
                        仅放开「非交易日 / 非交易时段」校验，供收盘后按收盘价补录手动单；急停拉下时仍一票否决，与本闸无关。
                      </div>
                    </div>
                  </el-popover>
                  <template v-if="safety.killSwitch && safety.killReason">
                    <span class="sep">/</span><span>原因 {{ safety.killReason }}</span>
                  </template>
                </div>
                <div v-if="!safety.autoLocalSimEnabled" class="safety-hint">
                  开启后，定时任务（尾盘 1445 / 妙想 0933）方可自动为本地战法账户建仓；还需在「中枢 · 调度」启用对应任务，并在「战法」页开自动模拟总闸 + 战法白名单。仅影响虚拟战法账户，绝不触及真实持仓。
                </div>
              </div>
            </div>
            <el-button
              v-if="!safety.killSwitch"
              type="danger"
              :icon="VideoPause"
              :loading="acting"
              @click="doKill"
            >
              急停
            </el-button>
            <el-button v-else type="success" :icon="VideoPlay" :loading="acting" @click="doResume">
              解除急停
            </el-button>
          </div>

          <!-- ===== L1 今日动作清单：驾驶舱的主体 =====
               下面所有区块都降级成它的证据。先回答「今天按顺序做什么」，
               再让想深究的人往下翻「凭什么这么说」——而不是把几十个读数摊开让人自己合成 -->
          <TodayActionPanel ref="actionPanel" />

          <!-- 宽基指数资金流：只常驻一行结论，明细点开才看。
               放在动作清单之后、证据区之前——它不是买卖动作，但每天值得扫一眼，
               收进默认折叠的证据区等于看不见 -->
          <IndexFundFlowPanel compact class="cockpit-flow" />

          <!-- ===== L2 证据区：默认折叠 =====
               这些是上面每条动作的依据。折叠不是嫌它们没用，而是它们回答的是
               「为什么」而不是「做什么」，同时摊开会把动作淹掉 -->
          <div class="ev-bar">
            <button class="ev-toggle" @click="toggleEvidence">
              {{ evidenceOpen ? '收起' : '展开' }}证据区
              <span class="ev-hint">{{ evidenceOpen ? '' : '全景 · 关注 · 板块 · 归因 · 转折日' }}</span>
            </button>
          </div>

          <div v-show="evidenceOpen" class="ev-region">
            <!-- 今日全景：四层结论层，统一读模型（与大盘/纪律/计划页同源口径）。
                 大盘阶段、计划兑现、强势主线、主线作战台已并入其中，此处不再重复呈现。 -->
            <div id="ev-panorama" class="ev-block">
              <PanoramaPanel />
            </div>

            <!-- 首板赚钱效应（883994·最近一次快照，完整趋势见大盘页情绪 tab） -->
            <MoneyEffectBadge v-if="moneyEffect" :money-effect="moneyEffect" class="cockpit-me" />

          <!-- ===== 盘中：我的票有没有风险 / 下一步动作 ===== -->
          <div class="flow-head">
            <span class="flow-tag mid">盘中</span>持仓风险 · 我的票在不在主线 · 自动成交
          </div>

          <!-- 关注标的：自维护小清单，点标的直达详情弹窗（K线 + 交易规划 + 对话） -->
          <div id="ev-focus" class="ev-block">
            <CockpitFocusPanel />
          </div>

          <!-- 持仓/自选板块暴露：我的票是否处于主线 / 退潮 / 拥挤 -->
          <div v-if="sideErrors.exposure" class="side-fail panel">
            ⚠ 板块归属取数失败：{{ sideErrors.exposure }}（数据未到，不是功能下线）
          </div>
          <section v-if="exposure.length" id="ev-board-exposure" class="panel ev-block">
            <div class="panel-head">
              <span class="section-title">我的持仓 / 自选落在哪些板块</span>
              <span class="panel-meta">主线板块成分 ∩ 我的持仓/自选</span>
            </div>
            <div class="expo-list">
              <div v-for="h in exposure" :key="`${h.account}:${h.code}`" class="expo-row">
                <el-tag size="small" :type="EXPO_STATUS_TYPE[h.status]" effect="plain">
                  {{ EXPO_STATUS_LABEL[h.status] }}
                </el-tag>
                <StockLink :code="h.code" :name="h.name" class="expo-code" />
                <span class="expo-boards">{{ h.boards.map((x) => x.boardName).join('、') }}</span>
              </div>
            </div>
          </section>

          <!-- 自动成交实时流：自动建仓/卖出与总闸拒绝（经盯盘总线推送，看得见为何自动/未自动） -->
          <div v-if="autoTrades.length" class="auto-trades">
            <div class="at-head">自动成交实时流</div>
            <div class="at-list">
              <div v-for="(t, i) in autoTrades" :key="`${t.at}:${i}`" class="at-item" :class="{ rejected: t.kind === 'rejected' }">
                <span class="at-tag" :class="t.kind">{{ TRADE_KIND_LABEL[t.kind] }}</span>
                <span class="at-strategy">{{ t.strategyName || '—' }}</span>
                <StockLink :code="t.code" :name="t.name" class="at-code" />
                <span v-if="t.kind !== 'rejected'" class="at-detail num">{{ t.qty }} 股 @ {{ t.price }}</span>
                <span v-else class="at-reason">{{ t.reason }}</span>
                <span class="at-time num">{{ dayjs(t.at).format('HH:mm:ss') }}</span>
              </div>
            </div>
          </div>

          <!-- ===== 盘后：复盘归因 / 各模块产出 / 事件时间线 ===== -->
          <div class="flow-head"><span class="flow-tag post">盘后</span>盈亏归因 · 模块产出 · 事件复盘</div>

          <!-- 当日盈亏归因（精简卡）：账户当日贡献 + 最大赢家/输家，详情见持仓页 -->
          <div v-if="sideErrors.attribution" class="side-fail">
            ⚠ 当日归因取数失败：{{ sideErrors.attribution }}（数据未到，不是功能下线）
          </div>
          <div v-else-if="attribution && attribution.items.length" id="ev-attribution" class="attr-card ev-block">
            <span class="attr-card-title">当日盈亏归因</span>
            <span class="attr-card-total">
              账户贡献
              <b class="num" :class="dir(attribution.totalDayPnl)">
                {{ contribText(attribution.totalDayRate) }}
              </b>
            </span>
            <span v-if="attribution.topWinner" class="attr-card-item">
              赢家
              <StockLink :code="attribution.topWinner.code" :name="attribution.topWinner.name" />
              <b class="num up">{{ contribText(attribution.topWinner.contribution) }}</b>
            </span>
            <span v-if="attribution.topLoser" class="attr-card-item">
              输家
              <StockLink :code="attribution.topLoser.code" :name="attribution.topLoser.name" />
              <b class="num down">{{ contribText(attribution.topLoser.contribution) }}</b>
            </span>
          </div>

          <!--
            未来转折：波浪时间位算出来的转折日。系统早就在算，但此前只冻结进账本、
            没有任何页面展示——实测 8/20 就说出了 8/25 这个低点，没人看得到。
            这里只给未来 10 天的摘要，完整清单在 /calendar。
          -->
          <section v-if="turning?.daily.entries.length || sideErrors.turning" id="ev-turning" class="panel ev-block">
            <div class="panel-head">
              <span class="section-title">未来可能转折的日子</span>
              <span class="panel-meta">
                <!--
                  这里只放日线（未来几天要面对的）。周线尺度以月计、且刚开始记录还没有成绩，
                  放在这张卡里会被读成「先跌到 26 号再涨到 9 月」这种没验证过的剧本
                -->
                只看短期（日线）·
                <!-- 取接口实时值而不是写死百分比，否则样本涨上去后这里还在念旧数 -->
                <template v-if="turning?.reliability.events.rate != null">
                  日子说准约 {{ (turning.reliability.events.rate * 100).toFixed(0) }}%（{{
                    turning.reliability.events.settled
                  }}
                  次独立预测）·
                </template>
                往哪边转还没验出准头 ·
                <RouterLink to="/calendar">完整日历</RouterLink>
              </span>
            </div>
            <div v-if="sideErrors.turning" class="side-fail">
              ⚠ 转折日历取数失败：{{ sideErrors.turning }}（数据未到，不是功能下线）
            </div>
            <div v-else class="turn-list">
              <div
                v-for="e in turning!.daily.entries"
                :key="e.date"
                class="turn-row"
                :class="{ 'is-weak': e.maxStreak < TURNING_MIN_STREAK || e.superseded }"
              >
                <span class="turn-date">{{ turnDateText(e.date) }}</span>
                <!--
                  方向还没跑赢基线（系统 12/24，不动脑筋永远猜见高是 14/24），
                  所以标成实验判断、用中性色，不能拿红绿暗示涨跌结论
                -->
                <span class="turn-expect" title="实验性判断，方向尚未验出准头">
                  实验 · {{ EXPECT_LABEL[e.expect] }}
                </span>
                <span v-if="e.superseded" class="turn-streak is-warn">最新分析没再提它</span>
                <span
                  v-else
                  class="turn-streak"
                  :class="e.maxStreak < TURNING_MIN_STREAK ? 'is-warn' : 'is-strong'"
                >
                  {{ e.maxStreak < TURNING_MIN_STREAK ? '首次给出' : `连续 ${e.maxStreak} 天没改口` }}
                </span>
                <span class="turn-when num">
                  {{ e.inDays === 0 ? '就是今天' : `${e.inDays} 个交易日后` }}
                </span>
                <span class="turn-codes">
                  <StockLink
                    v-for="i in e.items"
                    :key="i.code"
                    :code="i.code"
                    :name="i.label"
                    :secid="i.secid ?? undefined"
                    class="turn-code"
                  />
                </span>
                <!-- 文案取自 shared：同一条预测在驾驶舱与日历页读到不同说法比措辞不好更糟 -->
                <span class="turn-action">{{ turningActionText(e.maxStreak, e.superseded) }}</span>
              </div>
            </div>
          </section>

          </div>
          <!-- ↑ L2 证据区结束 -->

          <!-- ===== L3 产出与执行记录 =====
               这层回答的是「系统都产出了什么、我做过什么」，与今天该做什么无关，
               所以放在最后。仍未解除的风险不会只留在这里——那种必须进上面的动作区 -->
          <!-- 今日分析摘要：各家怎么看，一项一行。
               纪律 / 盯盘 / 计划三类不在这里——它们已经是上面动作清单里的动作，
               再放一张卡等于同一件事说两遍 -->
          <section class="panel module-panel">
            <div class="panel-head">
              <span class="section-title">今日分析摘要</span>
              <span class="panel-meta">各模块最新产出 · 点一行看全文</span>
            </div>
            <div class="ana-list">
              <button
                v-for="m in analysisModules"
                :key="m.key"
                class="ana-row"
                :class="{ stale: m.stale, empty: !m.createdAt }"
                type="button"
                @click="goModule(m)"
              >
                <span class="ana-title">{{ m.title }}</span>
                <span class="ana-body">
                  <b v-if="m.headline" class="ana-headline">{{ m.headline }}</b>
                  <span class="ana-excerpt">{{ m.excerpt }}</span>
                </span>
                <span v-if="m.stale && m.createdAt" class="mc-stale">非当日</span>
                <span class="ana-time num">{{ m.createdAt ? dayjs(m.createdAt).format('MM-DD HH:mm') : '—' }}</span>
              </button>
            </div>

            <!-- 研究参考：与今天做什么无关，默认折叠 -->
            <div v-if="researchModules.length" class="research-fold">
              <button class="ev-toggle" @click="researchOpen = !researchOpen">
                {{ researchOpen ? '收起' : '展开' }}研究参考
                <span class="ev-hint">{{ researchModules.map((m) => m.title).join(' · ') }}</span>
              </button>
              <div v-show="researchOpen" class="ana-list">
                <button
                  v-for="m in researchModules"
                  :key="m.key"
                  class="ana-row"
                  :class="{ stale: m.stale, empty: !m.createdAt }"
                  type="button"
                  @click="goModule(m)"
                >
                  <span class="ana-title">{{ m.title }}</span>
                  <span class="ana-body">
                    <b v-if="m.headline" class="ana-headline">{{ m.headline }}</b>
                    <span class="ana-excerpt">{{ m.excerpt }}</span>
                  </span>
                  <span class="ana-time num">{{ m.createdAt ? dayjs(m.createdAt).format('MM-DD HH:mm') : '—' }}</span>
                </button>
              </div>
            </div>
            <!-- 最新选股候选速览 -->
            <div v-if="screenerPicks.length" class="screener-picks">
              <div class="sp-head">最新选股候选 Top {{ screenerPicks.length }}</div>
              <div class="sp-list">
                <div v-for="p in screenerPicks" :key="p.code" class="sp-item">
                  <span class="sp-rank num">{{ p.rank }}</span>
                  <StockLink :code="p.code" :name="p.name" class="sp-name" />
                  <span class="sp-score num">{{ p.screenScore }}</span>
                  <span v-if="p.confidence != null" class="sp-conf num">信心{{ p.confidence }}</span>
                  <span v-if="p.thesis" class="sp-thesis">{{ p.thesis }}</span>
                </div>
              </div>
            </div>
          </section>

          <!--
            技术观察：波浪 / 共振 / 周线转折。
            默认折叠且**只报数量与入口**，不进今天的买卖排序——
            安慰剂对照显示这几套画线方法还没证明强于同距离随机价位，
            让它们独立生成买卖动作是拿没验证过的东西指挥仓位。
          -->
          <section class="panel tech-panel">
            <button class="ev-toggle" @click="techOpen = !techOpen">
              {{ techOpen ? '收起' : '展开' }}技术观察
              <span class="ev-hint">周线转折 {{ weeklyTurnCount }} 个 · 波浪与共振 · 说准率</span>
            </button>
            <div v-show="techOpen" class="tech-body">
              <div class="tech-row">
                <span class="tech-k">周线级转折</span>
                <span class="tech-v">
                  {{ weeklyTurnCount ? `${weeklyTurnCount} 个待观察日` : '暂无' }}，时间尺度以月计，只作记号不据此买卖
                </span>
                <RouterLink to="/calendar" class="tech-go">完整日历 →</RouterLink>
              </div>
              <div class="tech-row">
                <span class="tech-k">波浪与共振</span>
                <span class="tech-v">
                  按标的看：点任一标的打开详情弹窗，勾选波浪图层，速读卡里有共振价位与破位确认条件
                </span>
              </div>
              <div class="tech-row">
                <span class="tech-k">说准率</span>
                <span class="tech-v">
                  <template v-if="accuracy">
                    已判定 {{ accuracy.overall.settled }} 条，说准
                    {{ accuracy.overall.rate != null ? `${(accuracy.overall.rate * 100).toFixed(0)}%` : '样本还不够' }}。
                    各方法之间的差别尚未证明强于随机同距离价位，所以动作卡上不标单项比例
                  </template>
                  <template v-else>统计还没取到</template>
                </span>
                <RouterLink to="/accuracy" class="tech-go">完整统计 →</RouterLink>
              </div>
            </div>
          </section>

          <!-- 事件时间线 -->
          <section class="panel timeline-panel">
            <div class="panel-head">
              <span class="section-title">事件时间线</span>
              <span class="panel-meta">最近 {{ events.length }} 条 · 纪律 / 成交 / 盯盘 / 研判</span>
            </div>
            <div v-if="events.length" class="timeline">
              <div v-for="e in events" :key="e.id" class="tl-item">
                <span class="tl-dot" :class="sevDot(e.severity)" />
                <div class="tl-body">
                  <div class="tl-line">
                    <el-tag size="small" effect="plain" :type="kindTag(e.kind)">{{ KIND_LABEL[e.kind] }}</el-tag>
                    <el-tag v-if="e.auto" size="small" type="success" effect="dark" class="auto-badge">自动</el-tag>
                    <span class="tl-title">{{ e.title }}</span>
                    <StockLink v-if="e.code" :code="e.code" :name="e.name ?? undefined" class="tl-code" />
                    <span class="tl-time num">{{ dayjs(e.at).format('MM-DD HH:mm') }}</span>
                  </div>
                  <div class="tl-detail">{{ e.detail }}</div>
                </div>
              </div>
            </div>
            <el-empty v-else :image-size="80" description="暂无事件" />
          </section>
        </div>
      </el-tab-pane>

      <el-tab-pane label="AI 分析中心" name="ai" lazy>
        <AiAnalysisHub />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.as-of {
  margin-left: 10px;
  font-size: 12px;
  color: var(--text-2);
  font-family: var(--font-mono);
}
.cockpit-tabs {
  margin-top: 4px;
}

/* ---- 今日分析摘要（原 12 张等权卡网格改为一项一行）---- */
.ana-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ana-row {
  display: grid;
  grid-template-columns: 96px 1fr auto auto;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-bottom: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: var(--el-text-color-primary);
}
.ana-row:hover {
  background: var(--el-fill-color-light);
}
.ana-row.empty {
  opacity: 0.55;
}
.ana-title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.ana-body {
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--el-text-color-regular);
}
.ana-headline {
  margin-right: 6px;
  color: var(--el-text-color-primary);
}
.ana-excerpt {
  /* 摘要只给一行：它的作用是判断要不要点进去，不是在这里读完 */
  display: -webkit-box;
  -webkit-line-clamp: 1;
  line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ana-time {
  font-size: 11.5px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.research-fold {
  margin-top: 10px;
}
@media (max-width: 900px) {
  .ana-row {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}

/* ---- 技术观察折叠区 ---- */
.tech-body {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tech-row {
  display: grid;
  grid-template-columns: 88px 1fr auto;
  gap: 10px;
  align-items: baseline;
  font-size: 12.5px;
  line-height: 1.6;
}
.tech-k {
  font-weight: 600;
  color: var(--el-text-color-primary);
  white-space: nowrap;
}
.tech-v {
  color: var(--el-text-color-regular);
}
.tech-go {
  white-space: nowrap;
}
@media (max-width: 900px) {
  .tech-row {
    grid-template-columns: 1fr;
  }
}

/* ---- L2 证据区 ---- */
.ev-bar {
  margin: 4px 0 12px;
}
.ev-toggle {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 12px;
  border: 1px dashed var(--el-border-color);
  border-radius: 6px;
  background: transparent;
  color: var(--el-text-color-regular);
  font-size: 13px;
  cursor: pointer;
}
.ev-toggle:hover {
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
}
.ev-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
/* 锚点跳转后留出顶部余量，否则标题会贴在视口最上沿被导航挡住 */
.ev-block {
  scroll-margin-top: 72px;
}

/* 资金面常驻行：贴着动作清单，与下方证据区留出间距 */
.cockpit-flow {
  margin: 12px 0 4px;
}

/* ---- 安全总闸 / 急停 ---- */
.cockpit-me {
  margin: 0 0 12px;
}
.safety-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  margin-bottom: 18px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background:
    linear-gradient(90deg, rgba(31, 199, 127, 0.08), transparent 70%),
    var(--bg-2);
  border-left: 3px solid var(--status-ok);
}
.safety-bar.killed {
  border-color: var(--border);
  border-left-color: var(--status-err);
  background:
    linear-gradient(90deg, rgba(246, 70, 93, 0.1), transparent 70%),
    var(--bg-2);
}
.safety-state {
  display: flex;
  align-items: center;
  gap: 14px;
}
.safety-ic {
  font-size: 22px;
  color: var(--status-ok);
}
.safety-bar.killed .safety-ic {
  color: var(--status-err);
}
.safety-title {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 14.5px;
  color: var(--text-0);
}
.safety-scope {
  margin-left: 8px;
  font-family: var(--font-body, inherit);
  font-weight: 400;
  font-size: 12px;
  color: var(--text-2, var(--el-text-color-secondary));
}
.safety-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  margin-top: 3px;
}
.safety-meta .sep {
  color: var(--border);
}
.safety-meta b {
  font-weight: 600;
  font-family: var(--font-mono);
}
.safety-meta b.on {
  color: var(--status-warn);
}
.safety-meta b.off {
  color: var(--text-1);
}
.safety-meta .sw {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.safety-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
  max-width: 760px;
}
.gate-help {
  cursor: help;
  color: var(--brand, #409eff);
  border-bottom: 1px dashed currentColor;
}
.gate-map {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-1);
}
.gate-map .gm-title {
  font-weight: 600;
  margin: 2px 0 4px;
}
.gate-map ol {
  margin: 0 0 8px;
  padding-left: 4px;
  list-style: none;
}
.gate-map ol li {
  margin-bottom: 4px;
}
.gate-map .gm-loc {
  display: block;
  font-size: 11px;
  color: var(--text-2);
  padding-left: 14px;
}
.gate-map .gm-note {
  color: var(--text-2);
}

/* ---- 自动成交实时流 ---- */
.auto-trades {
  margin-bottom: 18px;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-2);
}
.attr-card {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 20px;
  margin-bottom: 18px;
  padding: 10px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-2);
  font-size: 13px;
}
.attr-card-title {
  font-weight: 600;
}
.attr-card-total,
.attr-card-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
}
.attr-card .num.up {
  color: var(--up, #f56c6c);
}
.attr-card .num.down {
  color: var(--down, #67c23a);
}
.at-head {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 8px;
}
.at-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.at-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}
.at-tag {
  flex-shrink: 0;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 4px;
  font-weight: 600;
}
.at-tag.auto_buy {
  color: var(--up);
  background: rgba(246, 70, 93, 0.12);
}
.at-tag.auto_sell {
  color: var(--down, #1fc77f);
  background: rgba(31, 199, 127, 0.12);
}
.at-tag.rejected {
  color: var(--status-warn);
  background: rgba(240, 180, 41, 0.12);
}
.at-strategy {
  color: var(--text-2);
  flex-shrink: 0;
}
.at-code {
  flex-shrink: 0;
}
.at-detail {
  color: var(--text-1);
}
.at-reason {
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}
.at-time {
  margin-left: auto;
  color: var(--text-2);
  flex-shrink: 0;
}
.auto-badge {
  flex-shrink: 0;
}

/* ---- 概览面板 ---- */
@media (max-width: 900px) {
}
.panel {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.section-title {
  font-size: 15px;
  font-weight: 600;
}
.panel-meta {
  font-size: 12px;
  color: var(--text-2);
}
.panel-head-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 计划兑现 */
.stance-bias.up {
  color: var(--el-color-danger, #f56c6c);
}
.stance-bias.down {
  color: var(--el-color-success, #67c23a);
}

/* 强势主线 */
.bar-fill.hot {
  background: var(--up);
}
.bar-fill.mid {
  background: var(--brand);
}
.bar-fill.low {
  background: var(--text-2);
}

/* ---- 模块总结卡 ---- */
.module-panel {
  margin-top: 16px;
}
.module-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.module-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: left;
  padding: 12px 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-3);
  cursor: pointer;
  font: inherit;
  color: inherit;
  transition:
    border-color 0.18s ease,
    background-color 0.18s ease;
}
.module-card:hover {
  border-color: var(--brand);
  background: var(--bg-hover);
}
.module-card.empty {
  opacity: 0.62;
}
.mc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.mc-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-0);
}
.mc-stale {
  font-size: 11px;
  color: var(--status-warn);
  border: 1px solid var(--status-warn);
  border-radius: 4px;
  padding: 0 4px;
  line-height: 1.5;
}
.mc-headline {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--brand);
}
.mc-excerpt {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.mc-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 2px;
}
.mc-time {
  font-size: 11.5px;
  color: var(--text-2);
}
.mc-link {
  font-size: 11.5px;
  color: var(--brand);
}

/* 选股候选速览 */
.screener-picks {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border-soft);
}
.sp-head {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 8px;
}
.sp-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}
.sp-rank {
  width: 18px;
  text-align: center;
  color: var(--text-2);
  flex-shrink: 0;
}
.sp-name {
  flex-shrink: 0;
}
.sp-score {
  color: var(--brand);
  font-weight: 600;
  flex-shrink: 0;
}
.sp-conf {
  color: var(--text-2);
  flex-shrink: 0;
}
.sp-thesis {
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* ---- 事件时间线 ---- */
.timeline-panel {
  margin-top: 16px;
}
.timeline {
  display: flex;
  flex-direction: column;
}
.tl-item {
  display: flex;
  gap: 12px;
  padding: 9px 6px 9px 2px;
  border-bottom: 1px solid var(--border-soft);
  transition: background-color 0.18s ease;
}
.tl-item:last-child {
  border-bottom: none;
}
.tl-item:hover {
  background: var(--bg-hover);
}
.tl-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-top: 7px;
  flex-shrink: 0;
  background: var(--text-2);
}
.tl-dot.warn {
  background: var(--status-warn);
  box-shadow: 0 0 6px rgba(240, 180, 41, 0.5);
}
.tl-dot.high {
  background: var(--status-err);
  box-shadow: 0 0 6px rgba(246, 70, 93, 0.5);
}
.tl-body {
  flex: 1;
  min-width: 0;
}
.tl-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tl-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-0);
}
.tl-code {
  font-size: 12px;
}
.tl-time {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-2);
}
.tl-detail {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 3px;
  line-height: 1.5;
}

@media (prefers-reduced-motion: reduce) {
  .tl-item {
    transition: none;
  }
}

/* 交易日节奏分组标题（盘前/盘中/盘后） */
.flow-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 18px 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.flow-tag {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  color: #fff;
}
.flow-tag.pre {
  background: var(--brand, #409eff);
}
.flow-tag.mid {
  background: var(--status-warn, #e6a23c);
}
.flow-tag.post {
  background: var(--text-2, #909399);
}

/* 主线作战台行 */
.side-fail {
  font-size: 12.5px;
  color: #e6a23c;
  line-height: 1.6;
  margin: 8px 0;
}
/* 未来转折：每个预测日一行 */
.turn-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.turn-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 5px 0;
  font-size: 12.5px;
  border-bottom: 1px dashed var(--border);
}
.turn-row:last-child {
  border-bottom: none;
}
/* 连续天数不够的条目实测只有 20% 命中，压暗不让它抢注意力 */
.turn-row.is-weak {
  opacity: 0.7;
}
.turn-date {
  min-width: 108px;
  font-weight: 600;
  color: var(--text-0);
}
.turn-when {
  color: var(--text-2);
  font-size: 11.5px;
}
/* 动作提示独占一行，缩进到日期之后 */
.turn-action {
  flex-basis: 100%;
  margin-left: 108px;
  color: var(--text-1);
  font-size: 11.5px;
}
.turn-expect {
  padding: 0 6px;
  border-radius: 3px;
  font-size: 11.5px;
}
/* A 股红涨绿跌：见高点用红、见低点用绿 */
.turn-expect.is-high {
  background: rgba(246, 70, 93, 0.12);
  color: var(--up, #f6465d);
}
.turn-expect.is-low {
  background: rgba(31, 199, 127, 0.12);
  color: var(--down, #1fc77f);
}
.turn-expect.is-unknown {
  color: var(--text-2);
}
/* 连续天数是本卡唯一有实测支撑的强弱信号 */
.turn-streak {
  font-size: 11.5px;
  color: var(--text-2);
}
.turn-streak.is-strong {
  color: var(--status-warn);
  font-weight: 600;
}
.turn-streak.is-warn {
  color: var(--text-2);
}
.turn-codes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-left: auto;
}
/* 持仓板块暴露行 */
.expo-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.expo-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.expo-boards {
  font-size: 12px;
  color: var(--text-2);
}
</style>
