<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import dayjs from 'dayjs';
import { useAgentsStore } from '@/stores/agents';
import RunResultDrawer from '@/components/RunResultDrawer.vue';
import type { RunTrigger, TaskRun } from '@stock-agent/shared';

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

const running = computed(() => store.running);

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
    title="Agent 运行中"
    size="460px"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="ap-body">
      <div class="ap-summary">
        <span class="dot" :class="{ active: running.length > 0 }" />
        当前
        <b>{{ running.length }}</b>
        个 Agent 正在运行
      </div>

      <div v-if="running.length" class="ap-list">
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

      <el-empty v-else description="当前没有正在运行的 Agent" :image-size="70" />
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
