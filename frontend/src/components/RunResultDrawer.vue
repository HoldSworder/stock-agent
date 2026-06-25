<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import dayjs from 'dayjs';
import { api, openWs } from '@/api';
import MarkdownView from '@/components/MarkdownView.vue';
import type { MessageRole, RunMessage, StreamEvent, TaskRun } from '@stock-agent/shared';

const props = defineProps<{
  modelValue: boolean;
  run: TaskRun | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
}>();

const traceMessages = ref<RunMessage[] | null>(null);
const traceLoading = ref(false);
const traceCollapse = ref<string[]>([]);

// 实时流式状态
type LiveTraceItem = { role: MessageRole | 'tool'; toolName?: string; content: string; time: string };
const liveText = ref('');
const liveTrace = ref<LiveTraceItem[]>([]);
const streaming = ref(false);
const finalRun = ref<TaskRun | null>(null);
let liveWs: WebSocket | null = null;

// 优先展示结束后拉取的完整 run，否则用传入快照
const displayRun = computed(() => finalRun.value ?? props.run);

function resetLive() {
  liveText.value = '';
  liveTrace.value = [];
  finalRun.value = null;
  traceMessages.value = null;
  traceCollapse.value = [];
}

function stopLiveWs() {
  liveWs?.close();
  liveWs = null;
}

function startLiveWs() {
  stopLiveWs();
  liveWs = openWs('/ws/runs');
  liveWs.onmessage = async (ev) => {
    const e: StreamEvent = JSON.parse(ev.data);
    const now = new Date().toISOString();
    switch (e.type) {
      case 'token':
        liveText.value += e.text;
        break;
      case 'tool_call':
        liveTrace.value.push({ role: 'assistant', toolName: e.name, content: e.args, time: now });
        break;
      case 'tool_result':
        liveTrace.value.push({ role: 'tool', toolName: e.name, content: e.preview, time: now });
        break;
      case 'message':
        liveTrace.value.push({ role: e.role, content: e.content, time: now });
        break;
      case 'run_finished':
        if (props.run && e.runId === props.run.id) {
          streaming.value = false;
          try {
            const d = await api.getRun(props.run.id);
            finalRun.value = d.run;
            traceMessages.value = d.messages;
          } catch {
            // 拉取失败时保留实时内容
          }
          stopLiveWs();
        }
        break;
      default:
        break;
    }
  };
}

/**
 * 回填运行中已落库的轨迹：/ws/runs 无回放，进入运行时已发生的事件全靠此补齐。
 * 把持久化的 messages 转为 LiveTraceItem 前插到 liveTrace，并用 assistant 文本拼出 liveText 初值。
 * 前插确保快照排在订阅期间已到达的实时事件之前；token 属未落库的在途步骤，不会与回填重复。
 */
async function backfillRunning(runId: string) {
  let messages: RunMessage[];
  try {
    const d = await api.getRun(runId);
    messages = d.messages;
  } catch {
    return; // 回填失败不影响后续实时流
  }
  // run/id 在 await 期间可能已切换，丢弃过期结果
  if (props.run?.id !== runId) return;

  const seeded: LiveTraceItem[] = [];
  let seededText = '';
  for (const m of messages) {
    const time = m.createdAt;
    if (m.role === 'user') continue;
    if (m.role === 'tool') {
      seeded.push({ role: 'tool', toolName: m.toolName ?? undefined, content: m.content ?? '', time });
      continue;
    }
    // assistant
    if (m.content) {
      seeded.push({ role: 'assistant', content: m.content, time });
      seededText += m.content;
    }
    if (m.toolCalls) {
      try {
        const calls = JSON.parse(m.toolCalls) as { name: string; args: string }[];
        for (const c of calls) {
          seeded.push({ role: 'assistant', toolName: c.name, content: c.args ?? '', time });
        }
      } catch {
        // toolCalls 解析失败则跳过该节点
      }
    }
  }
  liveTrace.value = [...seeded, ...liveTrace.value];
  liveText.value = seededText + liveText.value;
}

// 打开/切换 run 时初始化；运行中订阅实时流
watch(
  () => [props.modelValue, props.run?.id],
  () => {
    if (!props.modelValue || !props.run) {
      stopLiveWs();
      streaming.value = false;
      return;
    }
    resetLive();
    if (props.run.status === 'running') {
      streaming.value = true;
      traceCollapse.value = ['trace'];
      startLiveWs();
      void backfillRunning(props.run.id);
    } else {
      streaming.value = false;
    }
  },
  { immediate: true },
);

onUnmounted(stopLiveWs);

const statusType = (s: string) =>
  s === 'success' ? 'success' : s === 'running' ? 'warning' : 'danger';
const fmtSec = (s?: string | null) => (s ? dayjs(s).format('MM-DD HH:mm:ss') : '-');
// 时间线节点时间：仅到秒，节点已分行展示无需日期
const fmtNodeTime = (s?: string | null) => (s ? dayjs(s).format('HH:mm:ss') : '');
function duration(r: TaskRun): string {
  if (!r.finishedAt) return '-';
  const sec = dayjs(r.finishedAt).diff(dayjs(r.startedAt), 'second');
  return sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`;
}

/** 懒加载运行轨迹（仅非流式历史运行） */
async function onTraceToggle(val: string[]) {
  traceCollapse.value = val;
  if (val.includes('trace') && !traceMessages.value && !streaming.value && props.run) {
    traceLoading.value = true;
    try {
      const detail = await api.getRun(props.run.id);
      traceMessages.value = detail.messages;
    } finally {
      traceLoading.value = false;
    }
  }
}

async function copyResult() {
  const text = displayRun.value?.outputText ?? '';
  if (!text) return;
  await navigator.clipboard.writeText(text);
  ElMessage.success('已复制结果');
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    title="运行结果"
    size="600px"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div v-if="displayRun" class="run-detail">
      <div class="run-meta">
        <el-tag :type="statusType(streaming ? 'running' : displayRun.status)" size="small">
          {{ streaming ? 'running' : displayRun.status }}
        </el-tag>
        <span class="meta-sep">{{ displayRun.taskName || '聊天' }}</span>
        <span class="meta-sep">{{ fmtSec(displayRun.startedAt) }}</span>
        <span v-if="!streaming" class="meta-sep">耗时 {{ duration(displayRun) }}</span>
        <span class="meta-sep"
          >{{ (displayRun.promptTokens || 0) + (displayRun.completionTokens || 0) }} tokens</span
        >
        <el-button
          v-if="displayRun.outputText"
          size="small"
          text
          class="copy-btn"
          @click="copyResult"
        >
          <el-icon><DocumentCopy /></el-icon>复制
        </el-button>
      </div>

      <div v-if="displayRun.error" class="run-error">错误：{{ displayRun.error }}</div>

      <!-- 运行中：实时流式输出 -->
      <template v-if="streaming">
        <div class="run-live">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>运行中…</span>
        </div>
        <div v-if="liveText" class="run-result">
          <MarkdownView :source="liveText" />
        </div>
      </template>
      <!-- 结束/历史：完整结果 -->
      <template v-else>
        <div v-if="displayRun.outputText" class="run-result">
          <MarkdownView :source="displayRun.outputText" />
        </div>
        <el-empty v-else-if="!displayRun.error" description="无结果输出" :image-size="60" />
      </template>

      <el-collapse :model-value="traceCollapse" class="trace" @update:model-value="onTraceToggle">
        <el-collapse-item name="trace" title="运行轨迹">
          <!-- 运行中：实时轨迹 -->
          <el-timeline v-if="streaming && liveTrace.length">
            <el-timeline-item
              v-for="(m, i) in liveTrace"
              :key="i"
              :timestamp="fmtNodeTime(m.time) + ' · ' + m.role + (m.toolName ? ` · ${m.toolName}` : '')"
            >
              <div class="mono trace-content">{{ m.content }}</div>
            </el-timeline-item>
          </el-timeline>
          <div v-else-if="streaming" class="trace-empty">等待执行…</div>
          <!-- 历史：懒加载轨迹 -->
          <div v-else v-loading="traceLoading">
            <el-timeline v-if="traceMessages && traceMessages.length">
              <el-timeline-item
                v-for="m in traceMessages"
                :key="m.id"
                :timestamp="fmtNodeTime(m.createdAt) + ' · ' + m.role + (m.toolName ? ` · ${m.toolName}` : '')"
              >
                <div class="mono trace-content">{{ m.content || m.toolCalls || '' }}</div>
              </el-timeline-item>
            </el-timeline>
            <div v-else-if="!traceLoading" class="trace-empty">无轨迹</div>
          </div>
        </el-collapse-item>
      </el-collapse>
    </div>
  </el-drawer>
</template>

<style scoped>
.run-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: var(--text-2);
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.meta-sep {
  color: var(--text-2);
}
.copy-btn {
  margin-left: auto;
}
.copy-btn .el-icon {
  margin-right: 4px;
}
.run-error {
  margin: 12px 0;
  color: var(--danger, #f56c6c);
  font-size: 13px;
}
.run-live {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 14px 0 6px;
  font-size: 12.5px;
  color: var(--text-2);
}
.run-result {
  margin: 14px 0;
}
.trace {
  margin-top: 8px;
  border-top: 1px solid var(--border);
}
.trace-content {
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.trace-empty {
  font-size: 12px;
  color: var(--text-2);
}
</style>
