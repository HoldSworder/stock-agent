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

onMounted(load);
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
      一屏概览 · 急停 · 跨模块事件时间线，纯只读聚合。
      <span v-if="data" class="as-of">更新于 {{ dayjs(data.asOf).format('MM-DD HH:mm:ss') }}</span>
    </div>

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
            <span v-if="plan" class="panel-meta num">{{ plan.planDate }}</span>
          </div>
          <div v-if="plan" class="plan-body">
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

/* 计划兑现 */
.plan-body {
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
