<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh, Setting, VideoPlay, VideoPause } from '@element-plus/icons-vue';
import { api } from '@/api';
import StockLink from '@/components/StockLink.vue';
import { useWatchStore } from '@/stores/watch';
import type {
  WatchConfig,
  WatchDisposition,
  WatchSignal,
  WatchSource,
  WatchStats,
  WatchStrategyView,
} from '@stock-agent/shared';
import type { WatchSignalRow } from '@/stores/watch';

const store = useWatchStore();

const toggling = ref(false);
const configVisible = ref(false);
const savingCfg = ref(false);
const now = ref(Date.now());
const stats = ref<WatchStats | null>(null);
const strategyViews = ref<WatchStrategyView[]>([]);
const watchGroups = ref<string[]>([]);
let nowTimer: number | null = null;
let statsTimer: number | null = null;

async function loadStats() {
  try {
    stats.value = await api.getWatchStats();
  } catch {
    /* 统计失败不阻断主流程 */
  }
}

async function loadStrategyViews() {
  try {
    strategyViews.value = await api.getWatchStrategyViews();
  } catch {
    /* 战法视图失败不阻断主流程 */
  }
}

/** 仅展示有卖点档案（启用战法专属触发）的战法 */
const profiledStrategies = computed(() =>
  strategyViews.value.filter((v) => v.profile),
);

/** 分钟数转 HH:mm（尾盘了结时间展示） */
function minToHHmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const form = reactive<WatchConfig>({
  enabled: false,
  pollSec: 10,
  watchPositions: true,
  watchWatchlist: true,
  watchScan: false,
  watchGroup: '',
  drawdownPct: 4,
  surgeDropPct: 2,
  fastRisePct: 2,
  nearLimitPct: 1.5,
  sectorInflowYi: 8,
  cooldownMin: 30,
  cacheReuseMin: 20,
  maxConcurrent: 2,
  pushTelegram: true,
  adversarial: false,
  historyCompare: true,
  historyLookback: 3,
  reflection: true,
  minScore: 0,
  techContext: true,
  scanEverySec: 60,
  watchEverySec: 15,
  dailyDigest: true,
});

const enabled = computed(() => store.status?.enabled ?? false);
const inSession = computed(() => store.status?.inSession ?? false);

/** 上次轮询的相对时间 */
const lastPollText = computed(() => {
  const at = store.status?.lastPollAt;
  if (!at) return '—';
  const sec = Math.max(0, Math.round((now.value - dayjs(at).valueOf()) / 1000));
  if (sec < 60) return `${sec}s 前`;
  return `${Math.round(sec / 60)}min 前`;
});

const sourceLabel = (s: WatchSource) =>
  s === 'position' ? '持仓' : s === 'watch' ? '自选' : '扫描';
const sourceTag = (s: WatchSource) =>
  s === 'position' ? 'danger' : s === 'watch' ? 'warning' : 'info';
const sevTag = (s: string) => (s === 'high' ? 'danger' : s === 'medium' ? 'warning' : 'info');

/** 战法专属信号类型的中文标签（其余类型不展示额外标签） */
const STRATEGY_TYPE_LABELS: Partial<Record<WatchSignal['type'], string>> = {
  take_profit: '止盈',
  eod_settle: '尾盘了结',
  strategy_stop: '战法止损',
};
const typeLabel = (t: WatchSignal['type']) => STRATEGY_TYPE_LABELS[t] ?? '';
const typeTag = (t: WatchSignal['type']) =>
  t === 'take_profit' ? 'success' : t === 'eod_settle' ? 'warning' : 'danger';
const dir = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const pctText = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';

/** 信号去向中文标签：解释一条信号在确定性管道中的最终落点 */
const DISPOSITION_LABELS: Record<WatchDisposition, string> = {
  hysteresis: '迟滞静默',
  cooldown: '冷却中',
  low_score: '低于门槛',
  over_capacity: '限流丢弃',
  cache_reused: '缓存复用',
  to_ai: '已送研判',
};
const dispositionLabel = (d?: WatchDisposition) => (d ? DISPOSITION_LABELS[d] : '');
const dispositionTag = (d?: WatchDisposition) =>
  d === 'to_ai' ? 'success' : d === 'over_capacity' ? 'warning' : 'info';

function onSwitchToggle(v: string | number | boolean) {
  void onToggle(Boolean(v));
}

async function onToggle(val: boolean) {
  toggling.value = true;
  try {
    await api.toggleWatch(val);
    await store.refresh();
    ElMessage.success(val ? '盯盘引擎已启动' : '盯盘引擎已停止');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败');
  } finally {
    toggling.value = false;
  }
}

/** 从自选列表派生去重分组名，供重点分组下拉选择 */
async function loadWatchGroups() {
  try {
    const items = await api.listWatchlist();
    const set = new Set<string>();
    for (const it of items) {
      for (const t of (it.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
        set.add(t);
      }
    }
    watchGroups.value = [...set];
  } catch {
    /* 分组加载失败不阻断配置打开 */
  }
}

async function openConfig() {
  try {
    const cfg = await api.getWatchConfig();
    Object.assign(form, cfg);
    void loadWatchGroups();
    configVisible.value = true;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载配置失败');
  }
}

async function saveConfig() {
  savingCfg.value = true;
  try {
    await api.updateWatchConfig({ ...form });
    await store.refresh();
    configVisible.value = false;
    ElMessage.success('配置已保存并生效');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    savingCfg.value = false;
  }
}

const sortedQuotes = computed(() =>
  [...store.quotes].sort((a, b) => b.pct - a.pct),
);

function signalKey(s: WatchSignalRow) {
  return `${s.code}-${s.type}`;
}

onMounted(async () => {
  store.connect();
  try {
    await store.refresh();
  } catch {
    /* 首次拉取失败不阻断，WS 会补状态 */
  }
  nowTimer = window.setInterval(() => (now.value = Date.now()), 1000);
  void loadStats();
  void loadStrategyViews();
  statsTimer = window.setInterval(() => {
    void loadStats();
    void loadStrategyViews();
  }, 30_000);
});

onUnmounted(() => {
  if (nowTimer != null) clearInterval(nowTimer);
  if (statsTimer != null) clearInterval(statsTimer);
  store.disconnect();
});

// 引擎状态里的 config 同步到表单初值（首次）
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
      <div class="page-title">实时盯盘</div>
      <div class="head-actions">
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
      哨兵高频轮询持仓/重点自选/全市场异动，命中信号唤醒 AI 研判；本地战法持仓卖点经 AI 终审（减仓/清仓）会自动模拟卖出，其余仅出买卖建议
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
      <span class="st-item">今日告警：{{ store.status?.alertsToday ?? 0 }}</span>
      <span class="st-item">监控池：{{ store.quotes.length }} 只</span>
      <span v-if="stats" class="st-item">初筛拦截：{{ stats.screenedToday }}</span>
      <span v-if="stats" class="st-item">今日 token：{{ stats.tokensToday }}</span>
      <span v-if="stats" class="st-item">
        命中率：{{ stats.hitRate != null ? stats.hitRate.toFixed(0) + '%' : '—' }}
        <span class="muted">（{{ stats.maturedCount }} 样本）</span>
      </span>
    </div>

    <!-- 战法卖点档案：展示「按哪套标准盯」 -->
    <section v-if="profiledStrategies.length" class="strat-panel">
      <div class="strat-title">战法卖点（实时盯盘按此标准研判）</div>
      <div class="strat-list">
        <div v-for="v in profiledStrategies" :key="v.strategyId" class="strat-card">
          <div class="strat-head">
            <el-tag size="small" effect="dark" type="warning">{{ v.name }}</el-tag>
            <span class="strat-kind">{{ v.kind === 'miaoxiang' ? '镜像盘' : '本地盘' }}</span>
          </div>
          <div v-if="v.profile" class="strat-metrics">
            <span>止盈 +{{ v.profile.takeProfitPct }}%</span>
            <span>回撤 {{ v.profile.intradayDrawdownPct }}%</span>
            <span>止损 -{{ v.profile.stopLossPct }}%</span>
            <span>尾盘了结 {{ minToHHmm(v.profile.eodCutoffMin) }}</span>
          </div>
          <div v-if="v.sellSkill" class="strat-skill">{{ v.sellSkill }}</div>
        </div>
      </div>
    </section>

    <div class="grid">
      <!-- 监控池实时行情 -->
      <section class="panel">
        <div class="panel-title">监控池行情</div>
        <el-table v-if="sortedQuotes.length" :data="sortedQuotes" size="small" height="520">
          <el-table-column label="标的" min-width="150">
            <template #default="{ row }">
              <StockLink :code="row.code" :name="row.name" />
              <el-tag v-if="row.strategyName" size="small" effect="plain" type="warning" class="strat-chip">
                {{ row.strategyName }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="来源" width="70">
            <template #default="{ row }">
              <el-tag :type="sourceTag(row.source)" size="small" effect="plain">
                {{ sourceLabel(row.source) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="现价" width="80" align="right">
            <template #default="{ row }">
              <span class="num" :class="dir(row.pct)">{{ row.price.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="涨跌" width="80" align="right">
            <template #default="{ row }">
              <span class="num" :class="dir(row.pct)">{{ pctText(row.pct) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="日高" width="80" align="right">
            <template #default="{ row }">
              <span class="num dim">{{ row.dayHigh.toFixed(2) }}</span>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="暂无监控数据（开启引擎并在交易时段后显示）" :image-size="80" />
      </section>

      <!-- 信号流 -->
      <section class="panel">
        <div class="panel-title">信号流（Hot Path）</div>
        <div v-if="store.signals.length" class="feed">
          <div v-for="s in store.signals" :key="signalKey(s)" class="feed-row">
            <el-tag :type="sevTag(s.severity)" size="small" effect="dark">{{ sourceLabel(s.source) }}</el-tag>
            <div class="feed-body">
              <div class="feed-head">
                <StockLink :code="s.code" :name="s.name" />
                <el-tag v-if="typeLabel(s.type)" :type="typeTag(s.type)" size="small" effect="dark">
                  {{ typeLabel(s.type) }}
                </el-tag>
                <el-tag
                  v-if="s.disposition"
                  :type="dispositionTag(s.disposition)"
                  size="small"
                  effect="plain"
                >
                  {{ dispositionLabel(s.disposition) }}
                </el-tag>
                <span v-if="s.count > 1" class="feed-count">×{{ s.count }}</span>
                <el-tag v-if="s.strategyName" size="small" effect="plain" type="warning" class="strat-chip">
                  {{ s.strategyName }}
                </el-tag>
                <span class="num" :class="dir(s.pct)">{{ pctText(s.pct) }}</span>
                <span class="feed-time">{{ dayjs(s.at).format('HH:mm:ss') }}</span>
              </div>
              <div class="feed-detail">{{ s.detail }}</div>
            </div>
          </div>
        </div>
        <el-empty v-else description="暂无触发信号" :image-size="80" />
      </section>

      <!-- AI 建议 -->
      <section class="panel">
        <div class="panel-title">AI 建议（已终审推送）</div>
        <div v-if="store.alerts.length" class="feed">
          <div v-for="a in store.alerts" :key="a.id" class="alert-card" :class="{ muted: !a.shouldAlert }">
            <div class="alert-head">
              <StockLink :code="a.code" :name="a.name" />
              <el-tag v-if="a.strategyName" size="small" effect="plain" type="warning" class="strat-chip">
                {{ a.strategyName }}
              </el-tag>
              <el-tag v-if="a.verdict" :type="a.source === 'position' ? 'danger' : 'success'" size="small">
                {{ a.verdict }}
              </el-tag>
              <el-tag v-if="a.execStatus === 'executed'" type="success" size="small" effect="dark">已自动卖出</el-tag>
              <el-tag v-else-if="a.execStatus === 'skipped'" type="warning" size="small" effect="plain">自动卖出跳过</el-tag>
              <el-tag v-if="!a.shouldAlert" type="info" size="small" effect="plain">沉默</el-tag>
              <el-tag v-if="a.shouldAlert && !a.delivered" type="warning" size="small" effect="plain">待补发</el-tag>
              <span class="feed-time">{{ dayjs(a.createdAt).format('MM-DD HH:mm') }}</span>
            </div>
            <div class="alert-trigger">触发：{{ a.detail }}</div>
            <div
              v-if="a.execNote"
              class="alert-exec"
              :class="a.execStatus === 'executed' ? 'exec-ok' : 'exec-skip'"
            >
              {{ a.execNote }}
            </div>
            <div v-if="a.adviceText" class="alert-advice">{{ a.adviceText }}</div>
          </div>
        </div>
        <el-empty v-else description="暂无 AI 建议" :image-size="80" />
      </section>
    </div>

    <!-- 配置抽屉 -->
    <el-drawer v-model="configVisible" title="盯盘配置" size="420px">
      <el-form label-width="120px" label-position="left">
        <el-divider content-position="left">监控范围</el-divider>
        <el-form-item label="持仓（卖点）">
          <el-switch v-model="form.watchPositions" />
        </el-form-item>
        <el-form-item label="自选（买点）">
          <el-switch v-model="form.watchWatchlist" />
        </el-form-item>
        <el-form-item label="重点分组">
          <el-select
            v-model="form.watchGroup"
            placeholder="选择重点分组"
            clearable
            filterable
            allow-create
            :disabled="!form.watchWatchlist"
            style="width: 100%"
          >
            <el-option v-for="g in watchGroups" :key="g" :label="g" :value="g" />
          </el-select>
          <span class="form-hint">仅纳入该重点分组的自选股；留空则不盯自选</span>
        </el-form-item>
        <el-form-item label="全市场扫描">
          <el-switch v-model="form.watchScan" />
        </el-form-item>

        <el-divider content-position="left">轮询与限流</el-divider>
        <el-form-item label="轮询间隔(秒)">
          <el-input-number v-model="form.pollSec" :min="3" :max="60" />
        </el-form-item>
        <el-form-item label="单轮最多研判">
          <el-input-number v-model="form.maxConcurrent" :min="1" :max="5" />
        </el-form-item>
        <el-form-item label="同类冷却(分)">
          <el-input-number v-model="form.cooldownMin" :min="1" :max="240" />
        </el-form-item>
        <el-form-item label="缓存复用(分)">
          <el-input-number v-model="form.cacheReuseMin" :min="0" :max="240" />
        </el-form-item>

        <el-divider content-position="left">触发阈值</el-divider>
        <el-form-item label="回撤阈值(%)">
          <el-input-number v-model="form.drawdownPct" :min="0.5" :max="20" :step="0.5" />
        </el-form-item>
        <el-form-item label="急跌阈值(%)">
          <el-input-number v-model="form.surgeDropPct" :min="0.5" :max="10" :step="0.5" />
        </el-form-item>
        <el-form-item label="涨速阈值(%)">
          <el-input-number v-model="form.fastRisePct" :min="0.5" :max="10" :step="0.5" />
        </el-form-item>
        <el-form-item label="临近涨停(%)">
          <el-input-number v-model="form.nearLimitPct" :min="0.1" :max="5" :step="0.1" />
        </el-form-item>
        <el-form-item label="板块流入(亿)">
          <el-input-number v-model="form.sectorInflowYi" :min="1" :max="100" />
        </el-form-item>

        <el-divider content-position="left">AI 研判</el-divider>
        <el-form-item label="多空对辩">
          <el-switch v-model="form.adversarial" />
        </el-form-item>
        <el-form-item label="历史对比">
          <el-switch v-model="form.historyCompare" />
        </el-form-item>
        <el-form-item label="历史取条数">
          <el-input-number v-model="form.historyLookback" :min="1" :max="10" />
        </el-form-item>
        <el-form-item label="结果反思">
          <el-switch v-model="form.reflection" />
        </el-form-item>
        <el-form-item label="确定性门槛">
          <el-input-number v-model="form.minScore" :min="0" :max="100" :step="5" />
          <span class="form-hint">信号分低于此值直接沉默，0=不拦截</span>
        </el-form-item>
        <el-form-item label="技术指标">
          <el-switch v-model="form.techContext" />
        </el-form-item>

        <el-divider content-position="left">节奏与推送</el-divider>
        <el-form-item label="自选分频(秒)">
          <el-input-number v-model="form.watchEverySec" :min="3" :max="300" />
        </el-form-item>
        <el-form-item label="扫描分频(秒)">
          <el-input-number v-model="form.scanEverySec" :min="10" :max="600" />
        </el-form-item>
        <el-form-item label="推送 Telegram">
          <el-switch v-model="form.pushTelegram" />
        </el-form-item>
        <el-form-item label="当日摘要">
          <el-switch v-model="form.dailyDigest" />
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
  padding: 22px 26px;
}
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
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
.strat-panel {
  margin-bottom: 16px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
}
.strat-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 10px;
}
.strat-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.strat-card {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-1);
  border-left: 3px solid var(--brand);
}
.strat-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.strat-kind {
  font-size: 11px;
  color: var(--text-2);
}
.strat-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 8px 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-1);
}
.strat-skill {
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  color: var(--text-2);
}
.strat-chip {
  margin-left: 6px;
}
.grid {
  display: grid;
  grid-template-columns: 1.1fr 1fr 1.1fr;
  gap: 16px;
}
.panel {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-2);
  padding: 14px;
  min-height: 560px;
}
.panel-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 10px;
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
}
.alert-card {
  padding: 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-1);
  border-left: 3px solid var(--brand);
}
.alert-card.muted {
  opacity: 0.6;
  border-left-color: var(--border);
}
.st-item .muted {
  color: var(--text-2);
  font-size: 11px;
}
.form-hint {
  margin-left: 8px;
  font-size: 11px;
  color: var(--text-2);
}
.alert-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.alert-trigger {
  margin: 6px 0;
  font-size: 12px;
  color: var(--text-2);
}
.alert-exec {
  margin: 6px 0;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}
.alert-exec.exec-ok {
  color: var(--up);
  background: color-mix(in srgb, var(--up) 12%, transparent);
}
.alert-exec.exec-skip {
  color: var(--text-2);
  background: var(--bg-2);
}
.alert-advice {
  font-size: 13px;
  white-space: pre-wrap;
  line-height: 1.6;
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
@media (max-width: 1100px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
