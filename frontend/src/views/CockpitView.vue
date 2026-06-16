<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import dayjs from 'dayjs';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Refresh, Warning, VideoPause, VideoPlay, TopRight } from '@element-plus/icons-vue';
import { api } from '@/api';
import AiAnalysisHub from '@/components/AiAnalysisHub.vue';
import StockLink from '@/components/StockLink.vue';
import type {
  CockpitEvent,
  CockpitModuleSummary,
  CockpitOverview,
  SafetyState,
} from '@stock-agent/shared';

const data = ref<CockpitOverview | null>(null);
const loading = ref(false);
const acting = ref(false);

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
const plan = computed(() => data.value?.plan ?? null);
const planStance = computed(() => data.value?.planStance ?? null);
const themes = computed(() => data.value?.themes ?? []);
const modules = computed(() => data.value?.modules ?? []);
const screenerPicks = computed(() => data.value?.screenerPicks ?? []);
const events = computed(() => data.value?.events ?? []);

/** 跳转模块全文页（带可选 query） */
function goModule(m: CockpitModuleSummary) {
  void router.push(m.routeQuery ? { path: m.route, query: m.routeQuery } : m.route);
}

// 大盘方向标签（与计划页一致：偏多红 / 偏空绿 / 中性）
const BIAS_META: Record<'bull' | 'bear' | 'neutral', { label: string; cls: string }> = {
  bull: { label: '偏多', cls: 'up' },
  bear: { label: '偏空', cls: 'down' },
  neutral: { label: '中性', cls: '' },
};

function goPlan() {
  void router.push('/plan');
}

const KIND_LABEL: Record<CockpitEvent['kind'], string> = {
  discipline: '持仓纪律',
  trade: '模拟成交',
  watch: '盯盘',
  decision: '研判',
};
// 类型标签仅作分类（不参与涨跌色语义），严重度由左侧语义色点表达
const kindTag = (k: CockpitEvent['kind']) =>
  k === 'discipline' ? 'warning' : k === 'watch' ? 'danger' : k === 'decision' ? 'primary' : 'info';
const sevDot = (s: CockpitEvent['severity']) =>
  s === 'high' ? 'high' : s === 'warn' ? 'warn' : 'info';
// 强度热度分级，与中线雷达保持一致（hot/mid/low）
const strengthClass = (v: number) => (v >= 70 ? 'hot' : v >= 50 ? 'mid' : 'low');
const fmtPct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

async function load() {
  loading.value = true;
  try {
    data.value = await api.cockpit.overview();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function doKill() {
  try {
    const { value } = await ElMessageBox.prompt(
      '拉下安全总闸后，所有交易/模拟动作（本地战法、妙想模拟、盯盘自动卖出）将被立即拒绝。可填写原因：',
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

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">驾驶舱</div>
      <div class="head-actions">
        <el-button :icon="Refresh" type="primary" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>
    <div class="page-sub">
      一屏概览 · 急停 · 跨模块事件时间线；AI 分析中心一处发起 / 看历史 / 定时调度。
      <span v-if="data" class="as-of">更新于 {{ dayjs(data.asOf).format('MM-DD HH:mm:ss') }}</span>
    </div>

    <el-tabs v-model="tab" class="cockpit-tabs">
      <el-tab-pane label="驾驶舱" name="cockpit">
        <div v-loading="loading">
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
                </div>
                <div class="safety-meta">
                  <span>自动本地模拟 <b :class="safety.autoLocalSimEnabled ? 'on' : 'off'">{{ safety.autoLocalSimEnabled ? '开' : '关' }}</b></span>
                  <span class="sep">/</span>
                  <span>自动外部模拟 <b :class="safety.autoExternalSimEnabled ? 'on' : 'off'">{{ safety.autoExternalSimEnabled ? '开' : '关' }}</b></span>
                  <span class="sep">/</span>
                  <span>手动强制 <b :class="safety.allowManualForceTrade ? 'on' : 'off'">{{ safety.allowManualForceTrade ? '允许' : '禁用' }}</b></span>
                  <template v-if="safety.killSwitch && safety.killReason">
                    <span class="sep">/</span><span>原因 {{ safety.killReason }}</span>
                  </template>
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

          <div class="grid">
            <!-- 当日计划兑现 -->
            <section class="panel">
              <div class="panel-head">
                <span class="section-title">今日计划兑现</span>
                <span class="panel-head-right">
                  <span v-if="plan" class="panel-meta num">{{ plan.planDate }}</span>
                  <el-button link type="primary" :icon="TopRight" @click="goPlan">查看完整计划</el-button>
                </span>
              </div>
              <div v-if="plan" class="plan-body">
                <!-- 大盘定调（直达计划全文的轻量摘要） -->
                <div v-if="planStance" class="plan-stance">
                  <span
                    v-if="planStance.bias"
                    class="stance-bias"
                    :class="BIAS_META[planStance.bias].cls"
                  >
                    {{ BIAS_META[planStance.bias].label }}
                  </span>
                  <span v-if="planStance.positionPct != null" class="stance-pos num">
                    仓位 {{ planStance.positionPct }}%
                  </span>
                  <span v-if="planStance.summary" class="stance-summary">{{ planStance.summary }}</span>
                </div>
                <div class="plan-metrics">
                  <div class="hit-rate">
                    <span class="hit-value num">{{ fmtPct(plan.hitRate) }}</span>
                    <span class="hit-label">兑现率</span>
                  </div>
                  <div class="plan-stats">
                    <div class="ps"><span class="ps-n num">{{ plan.total }}</span><span class="ps-l">标的</span></div>
                    <div class="ps"><span class="ps-n num">{{ plan.triggered }}</span><span class="ps-l">已触发</span></div>
                    <div class="ps"><span class="ps-n num">{{ plan.done }}</span><span class="ps-l">已完成</span></div>
                    <div class="ps"><span class="ps-n num">{{ plan.pending }}</span><span class="ps-l">待触发</span></div>
                    <div class="ps"><span class="ps-n num">{{ plan.invalid }}</span><span class="ps-l">已失效</span></div>
                  </div>
                </div>
              </div>
              <el-empty v-else :image-size="60" description="今日暂无计划" />
            </section>

            <!-- 强势主线 -->
            <section class="panel">
              <div class="panel-head">
                <span class="section-title">强势主线</span>
                <span class="panel-meta">Top {{ themes.length }}</span>
              </div>
              <div v-if="themes.length" class="themes">
                <div v-for="t in themes" :key="t.id" class="theme-row">
                  <span class="theme-name">{{ t.theme }}</span>
                  <div class="bar">
                    <div
                      class="bar-fill"
                      :class="strengthClass(t.strength)"
                      :style="{ width: `${Math.min(t.strength, 100)}%` }"
                    />
                  </div>
                  <span class="theme-strength num">{{ t.strength }}</span>
                </div>
              </div>
              <el-empty v-else :image-size="60" description="暂无活跃主线" />
            </section>
          </div>

          <!-- 模块总结卡：各模块最新一次持久化产出（只读，秒开） -->
          <section class="panel module-panel">
            <div class="panel-head">
              <span class="section-title">模块总结</span>
              <span class="panel-meta">各模块最新产出 · 点卡片查看全文</span>
            </div>
            <div class="module-grid">
              <button
                v-for="m in modules"
                :key="m.key"
                class="module-card"
                :class="{ stale: m.stale, empty: !m.createdAt }"
                type="button"
                @click="goModule(m)"
              >
                <div class="mc-head">
                  <span class="mc-title">{{ m.title }}</span>
                  <span v-if="m.stale && m.createdAt" class="mc-stale">非当日</span>
                </div>
                <div v-if="m.headline" class="mc-headline">{{ m.headline }}</div>
                <div class="mc-excerpt">{{ m.excerpt }}</div>
                <div class="mc-foot">
                  <span class="mc-time num">{{ m.createdAt ? dayjs(m.createdAt).format('MM-DD HH:mm') : '—' }}</span>
                  <span class="mc-link">查看全文 →</span>
                </div>
              </button>
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

/* ---- 安全总闸 / 急停 ---- */
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

/* ---- 概览面板 ---- */
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }
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
.plan-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.plan-stance {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.stance-bias {
  font-weight: 700;
  font-size: 15px;
}
.stance-bias.up {
  color: var(--el-color-danger, #f56c6c);
}
.stance-bias.down {
  color: var(--el-color-success, #67c23a);
}
.stance-pos {
  font-size: 13px;
  color: var(--text-2);
}
.stance-summary {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.5;
  flex: 1;
  min-width: 0;
}
.plan-metrics {
  display: flex;
  align-items: center;
  gap: 22px;
}
.hit-rate {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 92px;
  padding-right: 20px;
  border-right: 1px solid var(--border-soft);
}
.hit-value {
  font-size: 30px;
  font-weight: 700;
  line-height: 1.1;
  color: var(--brand);
}
.hit-label {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 4px;
}
.plan-stats {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
  flex: 1;
}
.ps {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}
.ps-n {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-0);
}
.ps-l {
  font-size: 11.5px;
  color: var(--text-2);
}

/* 强势主线 */
.themes {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.theme-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.theme-name {
  width: 92px;
  font-size: 13px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar {
  flex: 1;
  height: 6px;
  background: var(--bg-3);
  border-radius: 3px;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 3px;
}
.bar-fill.hot {
  background: var(--up);
}
.bar-fill.mid {
  background: var(--brand);
}
.bar-fill.low {
  background: var(--text-2);
}
.theme-strength {
  width: 30px;
  text-align: right;
  font-size: 13px;
  color: var(--text-1);
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
</style>
