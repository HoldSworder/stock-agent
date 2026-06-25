<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { Setting, Refresh, VideoPlay, Delete } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import dayjs from 'dayjs';
import { api, openWs } from '@/api';
import StockLink from '@/components/StockLink.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import AgentTrace from '@/components/AgentTrace.vue';
import EtfAlertCard from '@/components/EtfAlertCard.vue';
import RunResultDrawer from '@/components/RunResultDrawer.vue';
import { applyStepEvent, type Step } from '@/composables/agentTrace';
import { useEtfWatchStore, type EtfWatchSignalRow } from '@/stores/etfWatch';
import type {
  AiAnalysisHistoryItem,
  EtfWatchConfig,
  EtfWatchSignal,
  EtfWatchDisposition,
  EtfWatchProbe,
  EtfWatchProbeAction,
  EtfWatchProbeBase,
  EtfWatchProbeStreamEvent,
  EtfWatchTfReadout,
  TaskRun,
} from '@stock-agent/shared';

// ETF 多周期分层盯盘页：与个股盯盘解耦的独立视图。
// 展示引擎状态、各 ETF 建议持仓层、确定性信号流、买点置信度告警，并提供战法参数配置。
const store = useEtfWatchStore();

const toggling = ref(false);
const triggering = ref(false);
const configVisible = ref(false);
const savingCfg = ref(false);
const now = ref(Date.now());
let nowTimer: number | null = null;

const enabled = computed(() => store.status?.enabled ?? false);
const inSession = computed(() => store.status?.inSession ?? false);

const form = reactive<EtfWatchConfig>({
  enabled: false,
  pollSec: 60,
  includePositions: true,
  includePool: true,
  extraCodes: '',
  layer1Pct: 40,
  layer2Pct: 40,
  layer3Pct: 20,
  zeroAxisFilter: true,
  higherTfFilter: true,
  hardStopPct: 7,
  trailLookback: 3,
  trailTakeProfitPct: 12,
  chaseGuardPct: 7,
  maxTotalPct: 100,
  agentConfirmBuy: true,
  minConfidence: 55,
  cooldownMin: 30,
  pushTelegram: true,
});

const lastPollText = computed(() => {
  const at = store.status?.lastPollAt;
  if (!at) return '—';
  const sec = Math.max(0, Math.round((now.value - dayjs(at).valueOf()) / 1000));
  if (sec < 60) return `${sec}s 前`;
  return `${Math.round(sec / 60)}min 前`;
});

// ===== 展示映射 =====
const TYPE_LABEL: Record<EtfWatchSignal['type'], string> = {
  buy_layer: '建层',
  sell_layer: '撤层',
  hard_stop: '硬止损',
};
const typeTag = (t: EtfWatchSignal['type']): 'success' | 'warning' | 'danger' =>
  t === 'buy_layer' ? 'success' : t === 'sell_layer' ? 'warning' : 'danger';
const TF_LABEL: Record<EtfWatchSignal['timeframe'], string> = {
  '30m': '30分',
  '60m': '60分',
  day: '日线',
};
const DISPOSITION_LABEL: Record<EtfWatchDisposition, string> = {
  cooldown: '冷却中',
  low_confidence: '低置信',
  to_ai: '已研判',
  emitted: '已发出',
};
const dispositionTag = (d?: EtfWatchDisposition): 'success' | 'warning' | 'info' =>
  d === 'to_ai' || d === 'emitted' ? 'success' : d === 'low_confidence' ? 'warning' : 'info';

// K 线收盘时间显示：分钟级 "YYYY-MM-DD HH:mm" → "MM-DD HH:mm"；日线 "YYYY-MM-DD" → "MM-DD"
const barTimeText = (bt?: string | null): string =>
  bt ? (bt.length >= 10 ? bt.slice(5) : bt) : '';

// ===== 手动检测 =====
const TF_FULL_LABEL: Record<EtfWatchTfReadout['timeframe'], string> = {
  '30m': '30分钟',
  '60m': '60分钟',
  day: '日线',
  week: '周线',
};
const tfFull = (tf: EtfWatchTfReadout['timeframe']): string => TF_FULL_LABEL[tf];
const macdStateTag = (s: EtfWatchTfReadout['state']): 'success' | 'danger' | 'warning' | 'info' =>
  s === '金叉' ? 'success' : s === '死叉' ? 'danger' : s === '多头' ? 'info' : 'warning';
const probeActionTag = (
  a: EtfWatchProbeAction,
): 'success' | 'info' | 'warning' | 'danger' =>
  a === '建仓' || a === '加仓'
    ? 'success'
    : a === '观察'
      ? 'info'
      : a === '减仓'
        ? 'warning'
        : 'danger';

// 趋势阶段 / 资金确认 / 指令动作的语义色（与告警卡一致）
const trendCls = (t?: string | null): string =>
  t === '主升中' || t === '趋势初期' ? 'up' : t === '趋势破坏' ? 'down' : 'warn';
const confirmCls = (l?: string | null): string =>
  l === '健康' ? 'up' : l === '背离' ? 'warn' : l === '派发警惕' ? 'down' : 'dim';
const instrCls = (a?: string | null): string =>
  a === '建仓' || a === '加仓' ? 'up' : a === '减仓' || a === '清仓' ? 'down' : 'dim';
const fmtPx = (n: number | null): string => (n != null ? n.toFixed(3) : '—');
const showProbeEntry = (i: { action: string; entryLow: number | null; entryHigh: number | null }): boolean =>
  (i.action === '建仓' || i.action === '加仓') && ((i.entryLow ?? 0) > 0 || (i.entryHigh ?? 0) > 0);

const probeVisible = ref(false);
const probeTitle = ref('');
const probeCode = ref('');
// 最终结构化裁决（实时收敛 / 历史回看）
const probe = ref<EtfWatchProbe | null>(null);
// 确定性读数（先于 AI 立即渲染读数表/持仓）
const probeBase = ref<EtfWatchProbeBase | null>(null);
// AI 研判流式轨迹
const probeSteps = ref<Step[]>([]);
const probeBusy = ref(false);
const probeError = ref('');
const probeHistory = ref<AiAnalysisHistoryItem[]>([]);
const probeHistLoading = ref(false);
const probeSelectedId = ref<string | null>(null);

let probeWs: WebSocket | null = null;
let probeRunFinished = true;
let probeClosingByUser = false;

// 头部/读数表数据源：实时态优先用最终 probe，未到则用确定性 base
const probeView = computed<EtfWatchProbe | EtfWatchProbeBase | null>(
  () => probe.value ?? probeBase.value,
);

function teardownProbeWs() {
  probeClosingByUser = true;
  probeWs?.close();
  probeWs = null;
}

async function loadProbeHistory(code: string) {
  probeHistLoading.value = true;
  try {
    probeHistory.value = await api.listAnalyses('etf-watch-probe', code);
  } catch {
    /* 历史拉取失败不阻塞实时检测 */
  } finally {
    probeHistLoading.value = false;
  }
}

function startProbe(code: string) {
  if (probeBusy.value) return;
  probe.value = null;
  probeBase.value = null;
  probeSteps.value = [];
  probeError.value = '';
  probeSelectedId.value = null;
  probeBusy.value = true;
  probeRunFinished = false;
  probeClosingByUser = false;

  probeWs = openWs('/ws/etf-watch/probe');
  probeWs.onmessage = (ev) => {
    const e: EtfWatchProbeStreamEvent = JSON.parse(ev.data);
    if (e.type === 'probe_base') {
      probeBase.value = e.base;
    } else if (e.type === 'probe_done') {
      probe.value = e.probe;
      probeBusy.value = false;
      probeRunFinished = true;
      loadProbeHistory(code);
      teardownProbeWs();
    } else if (e.type === 'run_finished') {
      // 仅熄灭忙碌态；最终裁决随后由 probe_done 补齐（成功）或已由 error 处理
      probeBusy.value = false;
    } else if (e.type === 'error') {
      probeError.value = e.message;
      probeBusy.value = false;
      probeRunFinished = true;
      teardownProbeWs();
    } else {
      applyStepEvent(probeSteps.value, e);
    }
  };
  probeWs.onclose = () => {
    if (!probeClosingByUser && probeBusy.value && !probeRunFinished) {
      probeError.value = probeError.value || '连接中断，检测未完成';
    }
    probeBusy.value = false;
  };

  const payload = JSON.stringify({ action: 'generate', code });
  if (probeWs.readyState === WebSocket.OPEN) probeWs.send(payload);
  else probeWs.addEventListener('open', () => probeWs?.send(payload), { once: true });
}

function openProbe(row: { code: string; name: string }) {
  probeTitle.value = `${row.name}(${row.code})`;
  probeCode.value = row.code;
  probeVisible.value = true;
  loadProbeHistory(row.code);
  startProbe(row.code);
}

function reRunProbe() {
  if (probeCode.value) startProbe(probeCode.value);
}

function stopProbe() {
  if (probeWs && probeWs.readyState === WebSocket.OPEN) {
    probeWs.send(JSON.stringify({ action: 'stop' }));
  }
  probeBusy.value = false;
  probeRunFinished = true;
}

// 回看历史：内容存的是 EtfWatchProbe JSON，解析后还原结构化报告
function pickProbeHistory(item: AiAnalysisHistoryItem) {
  if (probeBusy.value) return;
  probeSelectedId.value = item.id;
  probeSteps.value = [];
  probeError.value = '';
  try {
    probe.value = JSON.parse(item.content) as EtfWatchProbe;
    probeBase.value = null;
  } catch {
    probe.value = null;
    probeBase.value = null;
    probeError.value = '该历史记录无法解析为结构化报告';
  }
}

function fmtProbeTime(iso: string): string {
  return dayjs(iso).format('MM-DD HH:mm');
}

function onProbeDialogClose() {
  teardownProbeWs();
}

const dir = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const pctText = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const confCls = (c: number | null) =>
  c == null ? 'dim' : c >= 70 ? 'up' : c >= 55 ? '' : 'down';

const sortedStates = computed(() =>
  [...store.states].sort((a, b) => b.heldLayers.length - a.heldLayers.length),
);

function layerLabel(l: number): string {
  return l === 1 ? 'L1' : l === 2 ? 'L2' : 'L3';
}

// Asia/Shanghai 当前自然日，用于「隔日」过期标识
const shToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const shDateOf = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));

/** 某层建仓时间（上海日期 MM-DD），无记录返回空 */
function layerEntryDate(row: { layerEntryAt?: Record<string, string> }, l: number): string {
  const at = row.layerEntryAt?.[String(l)];
  return at ? shDateOf(at).slice(5) : '';
}
/** 某层是否为隔日持仓（建仓上海日期早于今日） */
function isLayerStale(row: { layerEntryAt?: Record<string, string> }, l: number): boolean {
  const at = row.layerEntryAt?.[String(l)];
  return at ? shDateOf(at) < shToday() : false;
}
/** 整行「数据截至」展示（updatedAt → MM-DD HH:mm） */
function stateAsOf(row: { updatedAt: string }): string {
  return row.updatedAt ? dayjs(row.updatedAt).format('MM-DD HH:mm') : '—';
}

async function clearStates() {
  try {
    await ElMessageBox.confirm(
      '将清空全部「建议持仓层」逻辑状态（不影响真实持仓与历史告警）。确认清空？',
      '清空建议持仓层',
      { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await store.clearStates();
    ElMessage.success('已清空建议持仓层');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '清空失败');
  }
}

async function removeState(row: { code: string; name: string }) {
  try {
    await store.deleteState(row.code);
    ElMessage.success(`已移除 ${row.name}(${row.code}) 的持仓层`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '移除失败');
  }
}

const alertScope = computed({
  get: () => store.alertScope,
  set: (v: 'today' | 'all') => void store.setAlertScope(v),
});

// ===== 告警过滤 / 交互 =====
type AlertFilter = 'all' | 'buy' | 'sellstop';
const alertFilter = ref<AlertFilter>('all');
const onlyDelivered = ref(false);
// 会话级清空：仅前端隐藏，刷新或新告警会重新出现（无后端删除接口）
const dismissedIds = ref<Set<string>>(new Set());

const filteredAlerts = computed(() =>
  store.alerts.filter((a) => {
    if (dismissedIds.value.has(a.id)) return false;
    if (onlyDelivered.value && !a.delivered) return false;
    if (alertFilter.value === 'buy') return a.signalType === 'buy_layer';
    if (alertFilter.value === 'sellstop') return a.signalType !== 'buy_layer';
    return true;
  }),
);

function clearAlerts() {
  dismissedIds.value = new Set(store.alerts.map((a) => a.id));
}

// 关联 agent 运行抽屉
const runDrawer = ref(false);
const runDetail = ref<TaskRun | null>(null);
async function openRun(runId: string) {
  try {
    const d = await api.getRun(runId);
    runDetail.value = d.run;
    runDrawer.value = true;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载运行失败');
  }
}

async function onToggle(val: boolean) {
  toggling.value = true;
  try {
    await api.etfWatch.toggle(val);
    await store.refresh();
    ElMessage.success(val ? 'ETF 多周期盯盘已启动' : '已停止');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败');
  } finally {
    toggling.value = false;
  }
}
function onSwitchToggle(v: string | number | boolean) {
  void onToggle(Boolean(v));
}

async function onTrigger() {
  triggering.value = true;
  try {
    const st = await api.etfWatch.trigger();
    await store.refresh();
    ElMessage.success(`已触发检测：跟踪 ${st.trackedCount} 只，本轮信号 ${st.lastSignalCount}`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '触发失败');
  } finally {
    triggering.value = false;
  }
}

async function openConfig() {
  try {
    Object.assign(form, await api.etfWatch.config());
    configVisible.value = true;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载配置失败');
  }
}

async function saveConfig() {
  savingCfg.value = true;
  try {
    await api.etfWatch.updateConfig({ ...form });
    await store.refresh();
    configVisible.value = false;
    ElMessage.success('配置已保存并生效');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    savingCfg.value = false;
  }
}

function signalKey(s: EtfWatchSignalRow) {
  return `${s.code}-${s.type}-${s.layer}`;
}

onMounted(async () => {
  store.connect();
  try {
    await store.refresh();
  } catch {
    /* WS 会补状态 */
  }
  nowTimer = window.setInterval(() => (now.value = Date.now()), 1000);
});
onUnmounted(() => {
  if (nowTimer != null) clearInterval(nowTimer);
  store.disconnect();
  teardownProbeWs();
});

watch(
  () => store.status?.config,
  (cfg) => {
    if (cfg && !configVisible.value) Object.assign(form, cfg);
  },
);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">ETF 多周期盯盘</div>
      <div class="head-actions">
        <el-button :icon="VideoPlay" :loading="triggering" @click="onTrigger">触发检测</el-button>
        <el-button :icon="Setting" @click="openConfig">配置</el-button>
        <el-button :icon="Refresh" @click="store.refresh">刷新</el-button>
        <el-switch
          :model-value="enabled"
          :loading="toggling"
          active-text="盯盘开启"
          inactive-text="已停止"
          inline-prompt
          @update:model-value="onSwitchToggle"
        />
      </div>
    </div>
    <div class="page-sub">
      确定性检测 30分钟 / 60分钟 / 日线 MACD 金叉死叉（收盘确认 + 大周期方向 + 零轴过滤），按 2:2:1
      分层给出建仓/撤层/硬止损告警；买点经 AI 结合主线/大盘/资金给混合置信度。仅告警不下单，按引擎自身信号维护「建议持仓层」。
    </div>

    <!-- 引擎状态条 -->
    <div class="status-bar">
      <span class="st-item">
        <span class="dot" :class="{ live: enabled && store.connected }" />
        {{ enabled ? (store.connected ? '运行中' : '连接中…') : '已停止' }}
      </span>
      <span class="st-item">交易时段：{{ inSession ? '是' : '否（空转刷新）' }}</span>
      <span class="st-item">上次轮询：{{ lastPollText }}</span>
      <span class="st-item">上轮信号：{{ store.status?.lastSignalCount ?? 0 }}</span>
      <span class="st-item">跟踪标的：{{ store.status?.trackedCount ?? 0 }} 只</span>
      <span class="st-item">持仓层标的：{{ store.states.filter((s) => s.heldLayers.length).length }}</span>
    </div>

    <div class="grid">
      <!-- 建议持仓层 -->
      <section class="panel">
        <div class="panel-head">
          <div class="panel-title">建议持仓层（引擎逻辑状态）</div>
          <el-button
            :icon="Delete"
            size="small"
            text
            :disabled="!store.states.some((s) => s.heldLayers.length)"
            title="清空全部建议持仓层（中线持仓跨日保留；如已离场或想重置可手动清空）"
            @click="clearStates"
          >
            清空持仓层
          </el-button>
        </div>
        <el-table v-if="sortedStates.length" :data="sortedStates" size="small" height="520">
          <el-table-column label="标的" min-width="150">
            <template #default="{ row }">
              <StockLink :code="row.code" :name="row.name" />
            </template>
          </el-table-column>
          <el-table-column label="已建层（建仓日）" min-width="170">
            <template #default="{ row }">
              <template v-if="row.heldLayers.length">
                <span v-for="l in row.heldLayers" :key="l" class="layer-cell">
                  <el-tag size="small" effect="dark" type="success" class="layer-chip">
                    {{ layerLabel(l) }} @ {{ (row.layerEntryPrice[String(l)] ?? 0).toFixed(3) }}
                  </el-tag>
                  <span v-if="layerEntryDate(row, l)" class="layer-date">{{ layerEntryDate(row, l) }}</span>
                  <el-tag v-if="isLayerStale(row, l)" size="small" effect="plain" type="info" class="stale-tag">隔日</el-tag>
                </span>
              </template>
              <span v-else class="dim">空仓</span>
            </template>
          </el-table-column>
          <el-table-column label="趋势阶段" width="92" align="center">
            <template #default="{ row }">
              <span v-if="row.trendStage" class="trend-chip" :class="trendCls(row.trendStage)">
                {{ row.trendStage }}
              </span>
              <span v-else class="dim">—</span>
            </template>
          </el-table-column>
          <el-table-column label="持有高点" width="84" align="right">
            <template #default="{ row }">
              <span class="num">{{ row.peakPrice ? row.peakPrice.toFixed(3) : '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="截至" width="92" align="right">
            <template #default="{ row }">
              <span class="bar-time">{{ stateAsOf(row) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="108" align="center">
            <template #default="{ row }">
              <el-button size="small" text type="primary" @click="openProbe(row)">检测</el-button>
              <el-button size="small" text type="danger" @click="removeState(row)">移除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-else :image-size="60" description="暂无跟踪标的（开启引擎并配置 ETF 池/持仓）" />
      </section>

      <!-- 信号流 -->
      <section class="panel">
        <div class="panel-title">确定性信号流</div>
        <div v-if="store.signals.length" class="feed">
          <div v-for="s in store.signals" :key="signalKey(s)" class="feed-row">
            <div class="feed-body">
              <div class="feed-head">
                <el-tag :type="typeTag(s.type)" size="small" effect="dark">
                  {{ TYPE_LABEL[s.type] }} {{ layerLabel(s.layer) }}
                </el-tag>
                <el-tag size="small" effect="plain">{{ TF_LABEL[s.timeframe] }}</el-tag>
                <StockLink :code="s.code" :name="s.name" />
                <el-tag
                  v-if="s.disposition"
                  :type="dispositionTag(s.disposition)"
                  size="small"
                  effect="plain"
                >
                  {{ DISPOSITION_LABEL[s.disposition] }}
                </el-tag>
                <span v-if="s.count > 1" class="feed-count">×{{ s.count }}</span>
                <span class="feed-time">
                  <span v-if="s.barTime" class="bar-time">K线 {{ barTimeText(s.barTime) }} · </span>检测 {{ dayjs(s.at).format('HH:mm:ss') }}
                </span>
              </div>
              <div class="feed-detail">{{ s.detail }}</div>
            </div>
          </div>
        </div>
        <el-empty v-else :image-size="60" description="等待信号（交易时段每根收盘 K 评估一次）" />
      </section>

      <!-- 告警（含买点置信度） -->
      <section class="panel panel--alerts">
        <div class="panel-head">
          <div class="panel-title">
            告警与置信度
            <span v-if="filteredAlerts.length" class="panel-count">{{ filteredAlerts.length }}</span>
          </div>
          <div class="panel-tools">
            <el-segmented
              v-model="alertScope"
              size="small"
              :options="[
                { label: '仅当日', value: 'today' },
                { label: '全部', value: 'all' },
              ]"
            />
            <el-segmented
              v-model="alertFilter"
              size="small"
              :options="[
                { label: '全部', value: 'all' },
                { label: '买点', value: 'buy' },
                { label: '卖点·止损', value: 'sellstop' },
              ]"
            />
            <el-checkbox v-model="onlyDelivered" size="small" label="仅已推送" />
            <el-button
              :icon="Delete"
              size="small"
              text
              :disabled="!filteredAlerts.length"
              title="清空当前列表（仅本次会话，刷新或新告警会重新出现）"
              @click="clearAlerts"
            >
              清空
            </el-button>
          </div>
        </div>
        <div v-if="filteredAlerts.length" class="feed">
          <EtfAlertCard
            v-for="a in filteredAlerts"
            :key="a.id"
            :alert="a"
            @open-run="openRun"
          />
        </div>
        <el-empty
          v-else
          :image-size="60"
          :description="store.alerts.length ? '当前筛选无告警' : '暂无告警'"
        />
      </section>
    </div>

    <!-- 手动检测报告（流式 + 历史可回看） -->
    <el-dialog
      v-model="probeVisible"
      :title="`即时检测 · ${probeTitle}`"
      width="900px"
      top="6vh"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      @close="onProbeDialogClose"
    >
      <div class="probe-dialog">
        <aside class="probe-hist">
          <el-button
            type="primary"
            class="probe-run-btn"
            :loading="probeBusy"
            @click="reRunProbe"
          >
            {{ probeBusy ? '检测中…' : '重新检测' }}
          </el-button>
          <el-button v-if="probeBusy" class="probe-run-btn" @click="stopProbe">停止</el-button>
          <div class="hist-title">历史记录</div>
          <div v-loading="probeHistLoading" class="hist-list">
            <div
              v-for="h in probeHistory"
              :key="h.id"
              class="hist-item"
              :class="{ active: probeSelectedId === h.id }"
              @click="pickProbeHistory(h)"
            >
              <span class="hist-time">{{ fmtProbeTime(h.createdAt) }}</span>
            </div>
            <div v-if="!probeHistLoading && !probeHistory.length" class="hist-empty">暂无历史</div>
          </div>
        </aside>

        <main class="probe-main">
          <div v-if="probeError" class="probe-error">{{ probeError }}</div>

          <!-- 确定性头部 + 读数表：base 到达即渲染 -->
          <template v-if="probeView">
            <div class="probe-head">
              <el-tag
                v-if="probe"
                :type="probeActionTag(probe.action)"
                size="small"
                effect="dark"
              >
                {{ probe.action }}
              </el-tag>
              <span
                v-if="probe && probe.confidence != null"
                class="conf-num num"
                :class="confCls(probe.confidence)"
              >
                置信 {{ probe.confidence.toFixed(0) }}
              </span>
              <span class="num" :class="dir(probeView.pct)">
                {{ probeView.price.toFixed(3) }} {{ pctText(probeView.pct) }}
              </span>
              <span class="probe-reson">共振 {{ probeView.resonance }}/3</span>
              <span v-if="probeView.trendStage" class="trend-chip" :class="trendCls(probeView.trendStage)">
                {{ probeView.trendStage }}
              </span>
              <span v-if="probeView.confirm" class="trend-chip" :class="confirmCls(probeView.confirm.label)">
                资金{{ probeView.confirm.label }} {{ probeView.confirm.score }}
              </span>
            </div>

            <!-- 执行指令卡 · 可闭眼照做（AI 研判完成后出现）-->
            <div v-if="probe && probe.instruction" class="p-instr" :class="instrCls(probe.instruction.action)">
              <div class="p-instr-head">
                <span class="p-instr-action" :class="instrCls(probe.instruction.action)">
                  {{ probe.instruction.action }}
                </span>
                <span v-if="probe.instruction.layer" class="p-instr-layer">{{ layerLabel(probe.instruction.layer) }}</span>
                <span v-if="probe.instruction.sizePct > 0" class="p-instr-size num">
                  {{ probe.instruction.sizePct }}%<template v-if="probe.instruction.totalAfterPct != null"> → 总仓{{ probe.instruction.totalAfterPct }}%</template>
                </span>
              </div>
              <div class="p-instr-grid">
                <span v-if="showProbeEntry(probe.instruction)">
                  买入区间 <b class="num">{{ fmtPx(probe.instruction.entryLow) }} – {{ fmtPx(probe.instruction.entryHigh) }}</b>
                </span>
                <span v-if="probe.instruction.stopLoss != null">
                  止损 <b class="num down">{{ fmtPx(probe.instruction.stopLoss) }}</b>
                </span>
                <span class="wide">失效：{{ probe.instruction.invalidation }}</span>
                <span v-if="probe.instruction.reason" class="wide">依据：{{ probe.instruction.reason }}</span>
                <span v-if="probe.instruction.guardrailNote" class="wide guard">护栏：{{ probe.instruction.guardrailNote }}</span>
              </div>
            </div>
            <div v-if="probeView.confirm" class="p-confirm-note">
              {{ probeView.confirm.volPriceNote }}；{{ probeView.confirm.shareTrendNote }}
            </div>

            <div class="probe-held">
              <span class="probe-label">已建层：</span>
              <template v-if="probeView.heldLayers.length">
                <el-tag
                  v-for="l in probeView.heldLayers"
                  :key="l"
                  size="small"
                  effect="dark"
                  type="success"
                  class="layer-chip"
                >
                  {{ layerLabel(l) }} @ {{ (probeView.layerEntryPrice[String(l)] ?? 0).toFixed(3) }}
                </el-tag>
              </template>
              <span v-else class="dim">空仓</span>
            </div>

            <el-table :data="probeView.readouts" size="small" class="probe-table">
              <el-table-column label="周期" width="72">
                <template #default="{ row }">{{ tfFull(row.timeframe) }}</template>
              </el-table-column>
              <el-table-column label="形态" width="72">
                <template #default="{ row }">
                  <el-tag :type="macdStateTag(row.state)" size="small" effect="plain">
                    {{ row.state }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="DIF" align="right">
                <template #default="{ row }">
                  <span class="num" :class="dir(row.dif)">{{ row.dif.toFixed(4) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="DEA" align="right">
                <template #default="{ row }">
                  <span class="num" :class="dir(row.dea)">{{ row.dea.toFixed(4) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="零轴" width="56" align="center">
                <template #default="{ row }">
                  <span :class="row.aboveZero ? 'up' : 'down'">{{ row.aboveZero ? '上' : '下' }}</span>
                </template>
              </el-table-column>
              <el-table-column label="收盘" width="92" align="right">
                <template #default="{ row }">
                  <span class="bar-time">{{ barTimeText(row.barTime) }}</span>
                </template>
              </el-table-column>
            </el-table>
          </template>

          <!-- AI 研判：完成出 advice 富渲染；运行中走流式轨迹 -->
          <MarkdownView v-if="probe && probe.advice" :source="probe.advice" class="probe-advice" />
          <template v-else>
            <AgentTrace v-if="probeSteps.length || probeBusy" :steps="probeSteps" :busy="probeBusy" />
            <div v-else-if="!probeView && !probeError" class="probe-loading">
              正在检测多周期状态并研判…
            </div>
          </template>
        </main>
      </div>
    </el-dialog>

    <!-- 关联 agent 运行 -->
    <RunResultDrawer v-model="runDrawer" :run="runDetail" />

    <!-- 配置抽屉 -->
    <el-drawer v-model="configVisible" title="ETF 多周期盯盘配置" size="440px">
      <el-form :model="form" label-width="130px" label-position="left">
        <el-divider content-position="left">引擎</el-divider>
        <el-form-item label="轮询间隔(秒)">
          <el-input-number v-model="form.pollSec" :min="15" :max="300" :step="15" />
        </el-form-item>
        <el-form-item label="纳入持仓ETF">
          <el-switch v-model="form.includePositions" />
        </el-form-item>
        <el-form-item label="纳入ETF池">
          <el-switch v-model="form.includePool" />
        </el-form-item>
        <el-form-item label="额外代码">
          <el-input v-model="form.extraCodes" placeholder="逗号分隔，如 159740,512760" />
        </el-form-item>

        <el-divider content-position="left">仓位（2:2:1）</el-divider>
        <el-form-item label="L1 试探仓 %">
          <el-input-number v-model="form.layer1Pct" :min="0" :max="100" :step="5" />
        </el-form-item>
        <el-form-item label="L2 加仓 %">
          <el-input-number v-model="form.layer2Pct" :min="0" :max="100" :step="5" />
        </el-form-item>
        <el-form-item label="L3 确认仓 %">
          <el-input-number v-model="form.layer3Pct" :min="0" :max="100" :step="5" />
        </el-form-item>

        <el-divider content-position="left">过滤与风控</el-divider>
        <el-form-item label="大周期方向过滤">
          <el-switch v-model="form.higherTfFilter" />
          <span class="form-hint">L1需60分多头/L2需日线多头/L3需周线多头；并冻结日线价&lt;MA60时建仓</span>
        </el-form-item>
        <el-form-item label="零轴过滤">
          <el-switch v-model="form.zeroAxisFilter" />
          <span class="form-hint">水下金叉(DIF&lt;0)降级观察</span>
        </el-form-item>
        <el-form-item label="硬止损 %">
          <el-input-number v-model="form.hardStopPct" :min="0" :max="20" :step="1" />
          <span class="form-hint">跌破建仓价此值或日线破MA20清该层及以下</span>
        </el-form-item>
        <el-form-item label="移动止损回看">
          <el-input-number v-model="form.trailLookback" :min="1" :max="10" :step="1" />
          <span class="form-hint">30分死叉但60分仍多头时，跌破近N根30分低点才撤</span>
        </el-form-item>

        <el-divider content-position="left">护栏（守利润 / 禁追高）</el-divider>
        <el-form-item label="移动止盈 %">
          <el-input-number v-model="form.trailTakeProfitPct" :min="0" :max="40" :step="1" />
          <span class="form-hint">盈利状态下从持有高点回撤此值，落袋清层（0=关闭）</span>
        </el-form-item>
        <el-form-item label="禁追高 %">
          <el-input-number v-model="form.chaseGuardPct" :min="0" :max="20" :step="1" />
          <span class="form-hint">当日涨幅≥此值禁止新建/加仓，降级观望（0=关闭）</span>
        </el-form-item>
        <el-form-item label="最大总仓位 %">
          <el-input-number v-model="form.maxTotalPct" :min="0" :max="100" :step="5" />
          <span class="form-hint">执行指令累计目标仓位不超此上限（0=不限制）</span>
        </el-form-item>

        <el-divider content-position="left">置信度（买点）</el-divider>
        <el-form-item label="买点调AI增信">
          <el-switch v-model="form.agentConfirmBuy" />
        </el-form-item>
        <el-form-item label="置信度门">
          <el-input-number v-model="form.minConfidence" :min="0" :max="100" :step="5" />
          <span class="form-hint">买点低于此值降级观察不推送</span>
        </el-form-item>

        <el-divider content-position="left">推送</el-divider>
        <el-form-item label="同层冷却(分)">
          <el-input-number v-model="form.cooldownMin" :min="0" :max="240" :step="5" />
        </el-form-item>
        <el-form-item label="推送Telegram">
          <el-switch v-model="form.pushTelegram" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="configVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingCfg" @click="saveConfig">保存并生效</el-button>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.page {
  padding: 20px 24px;
}
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}
.page-title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.page-sub {
  margin: 6px 0 14px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
}
.status-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  padding: 10px 14px;
  margin-bottom: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-1);
}
.st-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-2);
}
.dot.live {
  background: var(--up);
  box-shadow: 0 0 8px var(--up);
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.grid {
  display: grid;
  /* 两列：建议持仓层 + 确定性信号流（可扫读）；告警与置信度独占整行（内容最长，需宽度）。
     minmax(0,…) 让轨道可收缩到内容以下，避免 el-table / 长文本撑爆产生横向滚动条 */
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.panel {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-2);
  padding: 14px;
  min-height: 560px;
  /* 关键：允许 panel 在 grid 轨道内收缩，并裁掉子元素溢出 */
  min-width: 0;
  overflow: hidden;
}
.panel-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 10px;
}
/* 告警面板：内容最长（含 AI 长建议），独占整行；卡片自适应平铺 */
.panel--alerts {
  grid-column: 1 / -1;
  min-height: auto;
}
.panel--alerts .feed {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  align-content: start;
  gap: 10px;
  max-height: 460px;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin-bottom: 10px;
}
.panel-head .panel-title {
  margin-bottom: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.panel-count {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  color: var(--text-2);
  padding: 0 6px;
  border-radius: 8px;
  background: var(--bg-1);
}
.panel-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.layer-chip {
  margin: 2px 4px 2px 0;
}
.layer-cell {
  display: inline-flex;
  align-items: center;
  margin-right: 8px;
}
.layer-date {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-2);
  margin-right: 4px;
}
.stale-tag {
  opacity: 0.85;
}
.feed {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 520px;
  overflow: auto;
}
.feed-row {
  display: flex;
  gap: 8px;
  padding: 8px;
  border-radius: var(--radius-sm);
  background: var(--bg-1);
}
.feed-body {
  flex: 1;
  min-width: 0;
}
.feed-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.feed-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-2);
}
.feed-time {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-2);
}
.feed-detail {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-1);
  line-height: 1.5;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.bar-time {
  font-family: var(--font-mono);
  color: var(--text-2);
}
.conf-num {
  font-size: 12px;
  font-weight: 600;
}
.probe-body {
  min-height: 120px;
}
.probe-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.probe-reson {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
}

/* 趋势/资金徽章（持仓表 + 检测头部共用） */
.trend-chip {
  display: inline-flex;
  align-items: center;
  padding: 0 7px;
  height: 18px;
  border-radius: 9px;
  font-size: 11px;
  border: 1px solid currentColor;
}
.trend-chip.up {
  color: var(--up);
}
.trend-chip.down {
  color: var(--down);
}
.trend-chip.warn {
  color: var(--el-color-warning);
}
.trend-chip.dim {
  color: var(--text-2);
}

/* 检测弹窗 · 执行指令卡 */
.p-instr {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 9px 11px;
  margin-bottom: 10px;
  background: var(--bg-1);
}
.p-instr.up {
  border-color: color-mix(in srgb, var(--up) 45%, var(--border));
  background: color-mix(in srgb, var(--up) 7%, var(--bg-1));
}
.p-instr.down {
  border-color: color-mix(in srgb, var(--down) 45%, var(--border));
  background: color-mix(in srgb, var(--down) 7%, var(--bg-1));
}
.p-instr-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.p-instr-action {
  font-size: 17px;
  font-weight: 700;
}
.p-instr-action.up {
  color: var(--up);
}
.p-instr-action.down {
  color: var(--down);
}
.p-instr-action.dim {
  color: var(--text-2);
}
.p-instr-layer {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-2);
}
.p-instr-size {
  margin-left: auto;
  font-size: 13px;
  font-weight: 600;
}
.p-instr-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin-top: 6px;
  font-size: 13px;
  color: var(--text-1);
}
.p-instr-grid .wide {
  flex-basis: 100%;
}
.p-instr-grid .guard {
  color: var(--el-color-warning);
}
.p-confirm-note {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 10px;
  line-height: 1.5;
}
.probe-held {
  margin-bottom: 10px;
  font-size: 13px;
}
.probe-label {
  color: var(--text-2);
}
.probe-table {
  margin-bottom: 12px;
}
.probe-advice {
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
.probe-loading {
  color: var(--text-2);
  font-size: 13px;
  text-align: center;
  padding: 30px 0;
}
.probe-dialog {
  display: flex;
  gap: 14px;
  height: 66vh;
}
.probe-hist {
  width: 180px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-right: 1px solid var(--border);
  padding-right: 12px;
}
.probe-run-btn {
  width: 100%;
  margin-left: 0;
}
.hist-title {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 4px;
}
.hist-list {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.hist-item {
  padding: 8px 10px;
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-1);
  transition: background 0.15s ease;
}
.hist-item:hover {
  background: var(--bg-hover);
}
.hist-item.active {
  background: var(--brand-soft);
  color: var(--brand);
}
.hist-time {
  font-family: var(--font-mono);
}
.hist-empty {
  color: var(--text-2);
  font-size: 13px;
  padding: 12px 4px;
}
.probe-main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 4px 6px;
}
.probe-error {
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-1);
  border-left: 3px solid var(--down);
  color: var(--down);
  font-size: 13px;
}
.form-hint {
  margin-left: 8px;
  font-size: 11px;
  color: var(--text-2);
}
.num {
  font-family: var(--font-mono);
}
.dim {
  color: var(--text-2);
}
.up {
  color: var(--up);
}
.down {
  color: var(--down);
}
/* 窄屏 / 单栏：持仓层与信号流也堆叠 */
@media (max-width: 1024px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .panel {
    min-height: auto;
  }
}
</style>
