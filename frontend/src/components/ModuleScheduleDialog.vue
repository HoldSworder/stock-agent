<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Timer, VideoPlay, EditPen } from '@element-plus/icons-vue';
import { CronElementPlus } from '@vue-js-cron/element-plus';
import '@vue-js-cron/element-plus/dist/element-plus.css';
import dayjs from 'dayjs';
import { api } from '@/api';
import type { ModuleScheduleJob } from '@stock-agent/shared';

// 各模块通用「模块内定时」管理：页头时钟按钮触发 Dialog，用可视化 cron 编辑器配置，
// 不占页面黄金位。module 为 API 前缀（trendradar / review / research / market）。

const props = defineProps<{ module: string }>();

const visible = ref(false);
const jobs = ref<ModuleScheduleJob[]>([]);
const loading = ref(false);
// 各 job 的 cron 编辑缓冲（id -> 表达式），可视化编辑器与高级原始输入共用同一缓冲
const cronEdit = ref<Record<string, string>>({});
// 各 job 的 cron 校验错误（来自编辑器 @error），非空时禁止保存
const cronError = ref<Record<string, string>>({});
const busy = ref<Record<string, boolean>>({});
// 展开「高级（原始 cron）」输入的 job 集合
const rawOpen = ref<Record<string, boolean>>({});
// 防抖保存定时器
const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {};

const hasEnabled = computed(() => jobs.value.some((j) => j.enabled));

const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');
const fmt = (iso: string | null) => (iso ? dayjs(iso).format('MM-DD HH:mm') : '—');

async function load() {
  loading.value = true;
  try {
    jobs.value = await api.moduleSchedules.list(props.module);
    for (const j of jobs.value) cronEdit.value[j.id] = j.cronExpr;
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    loading.value = false;
  }
}

function syncJob(updated: ModuleScheduleJob) {
  const i = jobs.value.findIndex((j) => j.id === updated.id);
  if (i >= 0) jobs.value[i] = updated;
  cronEdit.value[updated.id] = updated.cronExpr;
}

async function toggle(job: ModuleScheduleJob, enabled: boolean) {
  busy.value[job.id] = true;
  try {
    syncJob(await api.moduleSchedules.update(props.module, job.id, { enabled }));
    ElMessage.success(enabled ? '已启用' : '已停用');
  } catch (e) {
    ElMessage.error(msg(e));
    await load();
  } finally {
    busy.value[job.id] = false;
  }
}

async function saveCron(job: ModuleScheduleJob) {
  const next = (cronEdit.value[job.id] ?? '').trim();
  // 无变化 / 空 / 校验未通过时不保存
  if (!next || next === job.cronExpr || cronError.value[job.id]) return;
  busy.value[job.id] = true;
  try {
    syncJob(await api.moduleSchedules.update(props.module, job.id, { cronExpr: next }));
    ElMessage.success('已保存定时表达式');
  } catch (e) {
    ElMessage.error(msg(e));
    cronEdit.value[job.id] = job.cronExpr; // 失败回退
  } finally {
    busy.value[job.id] = false;
  }
}

// 可视化编辑器变更：写入缓冲并防抖保存（与原始输入共用 saveCron）
function onCronChange(job: ModuleScheduleJob, value: string) {
  cronEdit.value[job.id] = value;
  if (saveTimers[job.id]) clearTimeout(saveTimers[job.id]);
  saveTimers[job.id] = setTimeout(() => saveCron(job), 350);
}

async function trigger(job: ModuleScheduleJob) {
  busy.value[job.id] = true;
  try {
    await api.moduleSchedules.trigger(props.module, job.id);
    ElMessage.success('已触发，结果稍后在对应模块/运行记录查看');
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    busy.value[job.id] = false;
  }
}

onMounted(load);
</script>

<template>
  <el-badge is-dot :hidden="!hasEnabled" class="sched-badge">
    <el-button :icon="Timer" title="模块定时" @click="visible = true">定时</el-button>
  </el-badge>

  <el-dialog
    v-model="visible"
    title="模块定时"
    width="520"
    append-to-body
    class="sched-dialog"
    @open="load"
  >
    <div class="sched-body" v-loading="loading">
      <p class="sched-hint">仅本模块管理，不进「任务」页</p>

      <div v-if="jobs.length === 0" class="sched-empty">暂无可配置的定时项</div>

      <section v-for="job in jobs" :key="job.id" class="sched-card" :class="{ on: job.enabled }">
        <header class="sched-card-head">
          <el-switch
            :model-value="job.enabled"
            :loading="busy[job.id]"
            @update:model-value="(v: any) => toggle(job, Boolean(v))"
          />
          <span class="sched-label">{{ job.label }}</span>
          <el-button
            class="sched-trigger"
            size="small"
            text
            :icon="VideoPlay"
            :loading="busy[job.id]"
            @click="trigger(job)"
          >立即执行</el-button>
        </header>

        <div class="sched-field-label">执行频率</div>
        <div class="cron-field" :class="{ error: cronError[job.id] }">
          <cron-element-plus
            :model-value="cronEdit[job.id]"
            locale="zh"
            :button-props="{ size: 'small' }"
            @update:model-value="(v: string) => onCronChange(job, v)"
            @error="cronError[job.id] = $event || ''"
          />
        </div>

        <div class="sched-sub">
          <code class="cron-raw num">{{ cronEdit[job.id] }}</code>
          <el-button
            text
            size="small"
            :icon="EditPen"
            class="sched-adv-toggle"
            @click="rawOpen[job.id] = !rawOpen[job.id]"
          >{{ rawOpen[job.id] ? '收起' : '手动输入' }}</el-button>
        </div>

        <el-input
          v-if="rawOpen[job.id]"
          v-model="cronEdit[job.id]"
          size="small"
          class="sched-raw-input num"
          placeholder="cron 表达式，如 0 8 * * 1-5"
          @keyup.enter="saveCron(job)"
          @blur="saveCron(job)"
        />

        <footer class="sched-meta">
          <span class="meta-item">
            <span class="meta-k">下次</span>
            <span class="meta-v num" :class="{ active: job.enabled }">{{ job.enabled ? fmt(job.nextRunAt) : '未启用' }}</span>
          </span>
          <span class="meta-item">
            <span class="meta-k">上次成功</span>
            <span class="meta-v num">{{ fmt(job.lastSuccessAt) }}</span>
          </span>
        </footer>
      </section>
    </div>
  </el-dialog>
</template>

<style scoped>
.sched-badge :deep(.el-badge__content.is-dot) {
  top: 6px;
  right: 6px;
}

.sched-hint {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--text-2);
}
.sched-empty {
  color: var(--text-2);
  font-size: 13px;
  padding: 16px 0;
  text-align: center;
}

/* 每个定时项一块：subtle 边框分组，启用时左缘金色脊柱 */
.sched-card {
  position: relative;
  padding: 14px 16px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-3);
  transition: border-color 0.16s ease;
}
.sched-card + .sched-card {
  margin-top: 12px;
}
.sched-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 14px;
  bottom: 14px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: var(--border);
  transition: background 0.16s ease, box-shadow 0.16s ease;
}
.sched-card.on::before {
  background: linear-gradient(var(--brand-2), var(--brand));
  box-shadow: 0 0 10px var(--brand-glow);
}

.sched-card-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sched-label {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-0);
}
.sched-trigger {
  margin-left: auto;
}

.sched-field-label {
  margin: 12px 0 6px;
  font-size: 12px;
  color: var(--text-2);
}

/* cron 编辑器外层做成一块完整字段，统一圆角/边框/聚焦态 */
.cron-field {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  line-height: 2.1;
  font-size: 14px;
  color: var(--text-1);
}
.cron-field.error {
  border-color: var(--up);
}
/* 句子内可编辑值 = 金色 token（可点击编辑提示），其余文字为弱化正文 */
.cron-field :deep(.vcron-el-spacer) {
  padding: 0 2px;
}
.cron-field :deep(.el-button) {
  height: auto;
  padding: 2px 9px;
  border-radius: var(--radius-sm);
  background: var(--brand-soft);
  border: 1px solid rgba(240, 180, 41, 0.25);
  color: var(--brand-2);
  font-weight: 600;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.cron-field :deep(.el-button:hover) {
  background: rgba(240, 180, 41, 0.2);
  border-color: var(--brand);
  color: var(--brand);
}
.cron-field :deep(.el-button:active) {
  transform: translateY(1px);
}

/* 原始表达式 + 手动输入入口 */
.sched-sub {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}
.cron-raw {
  font-size: 12px;
  color: var(--text-2);
  background: var(--bg-1);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
}
.sched-adv-toggle {
  margin-left: auto;
  padding: 0;
  height: auto;
  font-size: 12px;
}
.sched-raw-input {
  margin-top: 8px;
}

/* 状态元信息 */
.sched-meta {
  display: flex;
  gap: 24px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border-soft);
}
.meta-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.meta-k {
  font-size: 11px;
  color: var(--text-2);
}
.meta-v {
  font-size: 12.5px;
  color: var(--text-1);
}
.meta-v.active {
  color: var(--text-0);
}
</style>
