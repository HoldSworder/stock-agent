<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import dayjs from 'dayjs';
import { Refresh } from '@element-plus/icons-vue';
import { useAgentsStore } from '@/stores/agents';
import RunResultDrawer from '@/components/RunResultDrawer.vue';
import type { RunStatus, RunTrigger, TaskRun } from '@stock-agent/shared';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

const store = useAgentsStore();

// 运行结果抽屉（复用，运行中自动订阅实时流）
const detail = ref(false);
const activeRun = ref<TaskRun | null>(null);

// 每秒跳动用于刷新「已运行时长」
const now = ref(Date.now());
let timer: number | null = null;

function startTimer() {
  if (timer != null) return;
  timer = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
}
function stopTimer() {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
}

watch(
  () => props.modelValue,
  (open) => (open ? startTimer() : stopTimer()),
  { immediate: true },
);
onUnmounted(stopTimer);

const triggerLabel: Record<RunTrigger, string> = {
  cron: '定时',
  manual: '手动',
  chat: '聊天',
  watch: '盯盘',
};
const triggerType = (t: RunTrigger) =>
  t === 'cron' ? 'primary' : t === 'manual' ? 'success' : t === 'chat' ? 'info' : 'warning';

const statusLabel: Record<RunStatus, string> = {
  running: '运行中',
  success: '成功',
  error: '失败',
  timeout: '超时',
  canceled: '已取消',
};
const statusType = (s: RunStatus) =>
  s === 'success' ? 'success' : s === 'running' ? 'warning' : s === 'canceled' ? 'info' : 'danger';

const running = computed(() => store.running);

// 历史运行客户端过滤（针对已加载的最近 100 条）
const triggerFilter = ref<RunTrigger | ''>('');
const statusFilter = ref<Exclude<RunStatus, 'running'> | ''>('');
const refreshing = ref(false);

const history = computed(() =>
  store.history.filter(
    (r) =>
      (!triggerFilter.value || r.trigger === triggerFilter.value) &&
      (!statusFilter.value || r.status === statusFilter.value),
  ),
);

async function refresh() {
  refreshing.value = true;
  try {
    await store.refresh();
  } finally {
    refreshing.value = false;
  }
}

function tokensOf(r: TaskRun): number {
  return (r.promptTokens || 0) + (r.completionTokens || 0);
}
function duration(r: TaskRun): string {
  if (!r.finishedAt) return '-';
  const sec = Math.max(0, dayjs(r.finishedAt).diff(dayjs(r.startedAt), 'second'));
  return sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`;
}

function elapsed(r: TaskRun): string {
  const sec = Math.max(0, Math.floor((now.value - dayjs(r.startedAt).valueOf()) / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`;
}
const fmtSec = (s?: string | null) => (s ? dayjs(s).format('MM-DD HH:mm:ss') : '-');

function openRun(r: TaskRun) {
  activeRun.value = r;
  detail.value = true;
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    title="智能体运行"
    size="460px"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="ap-body">
      <div class="ap-summary">
        <span class="dot" :class="{ active: running.length > 0 }" />
        当前
        <b>{{ running.length }}</b>
        个 Agent 正在运行
        <el-button
          class="ap-refresh"
          size="small"
          text
          :loading="refreshing"
          @click="refresh"
        >
          <el-icon v-if="!refreshing"><Refresh /></el-icon>刷新
        </el-button>
      </div>

      <!-- 运行中 -->
      <div v-if="running.length" class="ap-list ap-list--running">
        <div v-for="r in running" :key="r.id" class="ap-item" @click="openRun(r)">
          <div class="ap-item-head">
            <el-tag :type="triggerType(r.trigger)" size="small" effect="plain">
              {{ triggerLabel[r.trigger] }}
            </el-tag>
            <span class="ap-name">{{ r.taskName || '未命名运行' }}</span>
            <span class="ap-elapsed">{{ elapsed(r) }}</span>
          </div>
          <div class="ap-meta">开始 {{ fmtSec(r.startedAt) }}</div>
          <div v-if="r.inputPrompt" class="ap-prompt">{{ r.inputPrompt }}</div>
        </div>
      </div>

      <!-- 历史运行 -->
      <div class="ap-section">
        <div class="ap-section-head">
          <span class="ap-section-title">历史运行</span>
          <el-select
            v-model="triggerFilter"
            size="small"
            placeholder="来源"
            clearable
            class="ap-filter"
          >
            <el-option label="定时" value="cron" />
            <el-option label="手动" value="manual" />
            <el-option label="聊天" value="chat" />
            <el-option label="盯盘" value="watch" />
          </el-select>
          <el-select
            v-model="statusFilter"
            size="small"
            placeholder="状态"
            clearable
            class="ap-filter"
          >
            <el-option label="成功" value="success" />
            <el-option label="失败" value="error" />
            <el-option label="超时" value="timeout" />
            <el-option label="已取消" value="canceled" />
          </el-select>
        </div>

        <div v-if="history.length" class="ap-list">
          <div v-for="r in history" :key="r.id" class="ap-item" @click="openRun(r)">
            <div class="ap-item-head">
              <el-tag :type="triggerType(r.trigger)" size="small" effect="plain">
                {{ triggerLabel[r.trigger] }}
              </el-tag>
              <span class="ap-name">{{ r.taskName || '未命名运行' }}</span>
              <el-tag :type="statusType(r.status)" size="small">
                {{ statusLabel[r.status] }}
              </el-tag>
            </div>
            <div class="ap-meta">
              {{ fmtSec(r.startedAt) }} · 耗时 {{ duration(r) }} · {{ tokensOf(r) }} tokens
            </div>
            <div v-if="r.inputPrompt" class="ap-prompt">{{ r.inputPrompt }}</div>
          </div>
        </div>
        <el-empty v-else description="暂无历史运行" :image-size="60" />
      </div>
    </div>

    <RunResultDrawer v-model="detail" :run="activeRun" />
  </el-drawer>
</template>

<style scoped>
.ap-body {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.ap-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-1);
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.ap-summary b {
  color: var(--brand);
  font-size: 16px;
  padding: 0 2px;
}
.ap-refresh {
  margin-left: auto;
}
.ap-refresh .el-icon {
  margin-right: 4px;
}
.ap-section {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin-top: 18px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.ap-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ap-section-title {
  flex: 1;
  font-size: 13px;
  color: var(--text-1);
}
.ap-filter {
  width: 92px;
}
.ap-summary .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-2);
}
.ap-summary .dot.active {
  background: var(--up, #f0b429);
  box-shadow: 0 0 8px var(--up, #f0b429);
  animation: ap-pulse 1.4s infinite;
}
@keyframes ap-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
.ap-list {
  flex: 1;
  overflow: auto;
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 运行中列表不抢占历史区高度：内容自适应，必要时自身滚动 */
.ap-list--running {
  flex: none;
  max-height: 38%;
}
.ap-item {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  padding: 10px 12px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.ap-item:hover {
  background: var(--bg-hover);
}
.ap-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ap-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ap-elapsed {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--up, #f0b429);
}
.ap-meta {
  font-size: 11px;
  color: var(--text-2);
  margin-top: 6px;
}
.ap-prompt {
  font-size: 12px;
  color: var(--text-1);
  margin-top: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
</style>
