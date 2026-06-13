<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Refresh, Warning, VideoPause, VideoPlay } from '@element-plus/icons-vue';
import { api } from '@/api';
import StockLink from '@/components/StockLink.vue';
import type { CockpitEvent, CockpitOverview, SafetyState } from '@stock-agent/shared';

const data = ref<CockpitOverview | null>(null);
const loading = ref(false);
const acting = ref(false);

const safety = computed<SafetyState | null>(() => data.value?.safety ?? null);
const plan = computed(() => data.value?.plan ?? null);
const themes = computed(() => data.value?.themes ?? []);
const events = computed(() => data.value?.events ?? []);

const KIND_LABEL: Record<CockpitEvent['kind'], string> = {
  discipline: '持仓纪律',
  trade: '模拟成交',
  watch: '盯盘',
  decision: '研判',
};
const kindTag = (k: CockpitEvent['kind']) =>
  k === 'discipline' ? 'warning' : k === 'trade' ? 'success' : k === 'watch' ? 'danger' : 'info';
const sevDot = (s: CockpitEvent['severity']) =>
  s === 'high' ? 'high' : s === 'warn' ? 'warn' : 'info';
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

onMounted(load);
</script>

<template>
  <div class="cockpit" v-loading="loading">
    <div class="page-head">
      <div>
        <h2 class="page-title">驾驶舱</h2>
        <span class="page-sub">一屏概览 · 急停 · 跨模块事件时间线</span>
      </div>
      <div class="head-actions">
        <span v-if="data" class="as-of">{{ dayjs(data.asOf).format('MM-DD HH:mm:ss') }}</span>
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <!-- 安全总闸 / 急停 -->
    <div v-if="safety" class="safety-bar" :class="{ killed: safety.killSwitch }">
      <div class="safety-state">
        <el-icon class="safety-ic"><Warning v-if="safety.killSwitch" /><VideoPlay v-else /></el-icon>
        <div>
          <div class="safety-title">
            {{ safety.killSwitch ? '安全总闸已拉下（急停中）' : '安全总闸正常' }}
          </div>
          <div class="safety-meta">
            自动本地模拟：{{ safety.autoLocalSimEnabled ? '开' : '关' }} ·
            自动外部模拟：{{ safety.autoExternalSimEnabled ? '开' : '关' }} ·
            手动强制：{{ safety.allowManualForceTrade ? '允许' : '禁用' }}
            <template v-if="safety.killSwitch && safety.killReason"> · 原因：{{ safety.killReason }}</template>
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
          <span class="panel-title">今日计划兑现</span>
          <span v-if="plan" class="panel-meta">{{ plan.planDate }}</span>
        </div>
        <div v-if="plan" class="plan-body">
          <div class="hit-rate">
            <span class="hit-value">{{ fmtPct(plan.hitRate) }}</span>
            <span class="hit-label">兑现率</span>
          </div>
          <div class="plan-stats">
            <div class="ps"><span class="ps-n">{{ plan.total }}</span><span class="ps-l">标的</span></div>
            <div class="ps"><span class="ps-n">{{ plan.triggered }}</span><span class="ps-l">已触发</span></div>
            <div class="ps"><span class="ps-n">{{ plan.done }}</span><span class="ps-l">已完成</span></div>
            <div class="ps"><span class="ps-n">{{ plan.pending }}</span><span class="ps-l">待触发</span></div>
            <div class="ps"><span class="ps-n">{{ plan.invalid }}</span><span class="ps-l">已失效</span></div>
          </div>
        </div>
        <el-empty v-else :image-size="60" description="今日暂无计划" />
      </section>

      <!-- 强势主线 -->
      <section class="panel">
        <div class="panel-head">
          <span class="panel-title">强势主线</span>
          <span class="panel-meta">Top {{ themes.length }}</span>
        </div>
        <div v-if="themes.length" class="themes">
          <div v-for="t in themes" :key="t.id" class="theme-row">
            <span class="theme-name">{{ t.theme }}</span>
            <div class="theme-bar">
              <div class="theme-bar-fill" :style="{ width: `${Math.min(t.strength, 100)}%` }" />
            </div>
            <span class="theme-strength num">{{ t.strength }}</span>
          </div>
        </div>
        <el-empty v-else :image-size="60" description="暂无活跃主线" />
      </section>
    </div>

    <!-- 事件时间线 -->
    <section class="panel timeline-panel">
      <div class="panel-head">
        <span class="panel-title">事件时间线</span>
        <span class="panel-meta">最近 {{ events.length }} 条 · 持仓纪律 / 成交 / 盯盘 / 研判</span>
      </div>
      <div v-if="events.length" class="timeline">
        <div v-for="e in events" :key="e.id" class="tl-item">
          <span class="tl-dot" :class="sevDot(e.severity)" />
          <div class="tl-body">
            <div class="tl-line">
              <el-tag size="small" effect="plain" :type="kindTag(e.kind)">{{ KIND_LABEL[e.kind] }}</el-tag>
              <span class="tl-title">{{ e.title }}</span>
              <StockLink v-if="e.code" :code="e.code" :name="e.name ?? undefined" class="tl-code" />
              <span class="tl-time">{{ dayjs(e.at).format('MM-DD HH:mm') }}</span>
            </div>
            <div class="tl-detail">{{ e.detail }}</div>
          </div>
        </div>
      </div>
      <el-empty v-else :image-size="80" description="暂无事件" />
    </section>
  </div>
</template>

<style scoped>
.cockpit {
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.page-title {
  margin: 0;
  font-size: 20px;
}
.page-sub {
  font-size: 12px;
  color: var(--text-2);
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.as-of {
  font-size: 12px;
  color: var(--text-2);
}
.safety-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid var(--el-color-success-light-5, #b3e19d);
  background: var(--el-color-success-light-9, #f0f9eb);
}
.safety-bar.killed {
  border-color: var(--el-color-danger-light-5, #fab6b6);
  background: var(--el-color-danger-light-9, #fef0f0);
}
.safety-state {
  display: flex;
  align-items: center;
  gap: 12px;
}
.safety-ic {
  font-size: 22px;
}
.safety-bar.killed .safety-ic {
  color: var(--el-color-danger, #f56c6c);
}
.safety-title {
  font-weight: 600;
}
.safety-meta {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 2px;
}
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
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  padding: 14px 16px;
  background: var(--fill-1, #fafafa);
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.panel-title {
  font-weight: 600;
  font-size: 14px;
}
.panel-meta {
  font-size: 12px;
  color: var(--text-2);
}
.plan-body {
  display: flex;
  align-items: center;
  gap: 20px;
}
.hit-rate {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 90px;
}
.hit-value {
  font-size: 28px;
  font-weight: 700;
}
.hit-label {
  font-size: 12px;
  color: var(--text-2);
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
}
.ps-n {
  font-size: 18px;
  font-weight: 600;
}
.ps-l {
  font-size: 12px;
  color: var(--text-2);
}
.themes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.theme-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.theme-name {
  width: 96px;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.theme-bar {
  flex: 1;
  height: 8px;
  border-radius: 4px;
  background: var(--fill-2, #eceff5);
  overflow: hidden;
}
.theme-bar-fill {
  height: 100%;
  border-radius: 4px;
  background: linear-gradient(90deg, #f5a623, #f56c6c);
}
.theme-strength {
  width: 32px;
  text-align: right;
  font-size: 13px;
}
.timeline {
  display: flex;
  flex-direction: column;
}
.tl-item {
  display: flex;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--border, #eceff5);
}
.tl-item:last-child {
  border-bottom: none;
}
.tl-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 6px;
  flex-shrink: 0;
  background: var(--el-color-info, #909399);
}
.tl-dot.warn {
  background: var(--el-color-warning, #e6a23c);
}
.tl-dot.high {
  background: var(--el-color-danger, #f56c6c);
}
.tl-body {
  flex: 1;
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
  margin-top: 2px;
}
.num {
  font-variant-numeric: tabular-nums;
}
</style>
