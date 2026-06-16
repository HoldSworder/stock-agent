<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api, openWs } from '@/api';
import AgentTrace from '@/components/AgentTrace.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import ReviewResultView from '@/components/ReviewResultView.vue';
import ResearchResultView from '@/components/ResearchResultView.vue';
import { applyStepEvent, type Step } from '@/composables/agentTrace';
import type { AiAnalysisHistoryItem, StreamEvent } from '@stock-agent/shared';

// 公共 AI 分析弹窗：历史列表（仅最终正文）+ 发起分析实时流式轨迹。
// 各模块按 kind 复用：注册后端 kind + 放置 <AiAnalysisDialog kind=... title=... :params=...>。
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** 分析类型（对应后端注册的 kind，如 real-positions） */
    kind: string;
    /** 弹窗标题与按钮文案 */
    title: string;
    /** 发起分析时透传给后端的入参 */
    params?: Record<string, unknown>;
    /** 历史作用域键（如股票代码）；全局类不传 */
    refKey?: string;
    /** 结论渲染器：markdown（默认散文）/ review（一键复盘）/ research（研报机会）结构化富渲染 */
    resultRenderer?: 'markdown' | 'review' | 'research';
  }>(),
  { resultRenderer: 'markdown' },
);

const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

const history = ref<AiAnalysisHistoryItem[]>([]);
const loadingHistory = ref(false);
// 当前查看的历史条目；为 null 时展示实时轨迹（live）
const selected = ref<AiAnalysisHistoryItem | null>(null);
const steps = ref<Step[]>([]);
const busy = ref(false);
// 刚跑完的最终正文（review 渲染器据此在收敛后切换到结构化富渲染）
const liveFinalText = ref('');

/** 从轨迹里取最后一段纯文本作为最终结论（默认 gateway 路径不单发 message，仅累积 token） */
function finalTextFromSteps(): string {
  for (let i = steps.value.length - 1; i >= 0; i--) {
    const s = steps.value[i];
    if (s.kind === 'text' && s.content.trim()) return s.content;
  }
  return '';
}

let ws: WebSocket | null = null;
let runFinished = true;
let closingByUser = false;

function close() {
  emit('update:modelValue', false);
}

async function loadHistory(autoSelectFirst = false) {
  loadingHistory.value = true;
  try {
    history.value = await api.listAnalyses(props.kind, props.refKey);
    if (autoSelectFirst && history.value.length) selected.value = history.value[0];
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '历史加载失败');
  } finally {
    loadingHistory.value = false;
  }
}

function pickHistory(item: AiAnalysisHistoryItem) {
  if (busy.value) return;
  selected.value = item;
}

function teardownWs() {
  closingByUser = true;
  ws?.close();
  ws = null;
}

function startAnalyze() {
  if (busy.value) return;
  // 进入实时态：清空轨迹，取消历史选中
  steps.value = [];
  selected.value = null;
  liveFinalText.value = '';
  busy.value = true;
  runFinished = false;
  closingByUser = false;

  ws = openWs('/ws/analyze');
  ws.onmessage = (ev) => {
    const e: StreamEvent = JSON.parse(ev.data);
    if (e.type === 'run_finished') {
      runFinished = true;
      busy.value = false;
      if (e.status === 'success' || e.status === 'timeout' || e.status === 'error') {
        // 完成/部分完成：保留刚跑完的实时轨迹（含结论），仅后台刷新历史列表（不自动选中，避免 refetch 竞态选到旧条目）
        if (e.status === 'success') liveFinalText.value = finalTextFromSteps();
        loadHistory(false);
      } else if (e.status === 'canceled' && !steps.value.length) {
        steps.value.push({ kind: 'text', content: '(已停止)' });
      }
      teardownWs();
    } else if (e.type === 'message' && e.role === 'assistant') {
      // 自定义执行器（如热点 oneshot）直接回最终 message，作为结论正文
      liveFinalText.value = e.content;
      if (!steps.value.length) steps.value.push({ kind: 'text', content: e.content });
    } else if (e.type === 'error') {
      ElMessage.error(e.message);
      runFinished = true;
      busy.value = false;
    } else {
      applyStepEvent(steps.value, e);
    }
  };
  ws.onclose = () => {
    // 仅在非主动关闭（真实网络中断）时提示；主动关闭弹窗时任务仍在后台跑完落库
    if (!closingByUser && busy.value && !runFinished) {
      if (!steps.value.length) steps.value.push({ kind: 'text', content: '(连接中断，请重试)' });
      ElMessage.error('连接中断，分析未完成');
    }
    busy.value = false;
  };

  const payload = JSON.stringify({ action: 'generate', kind: props.kind, params: props.params ?? {} });
  if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  else ws.addEventListener('open', () => ws?.send(payload), { once: true });
}

function stop() {
  if (!busy.value) return;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'stop' }));
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 打开时拉历史；关闭时收尾 WS
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      selected.value = null;
      steps.value = [];
      loadHistory();
    } else {
      // 关闭弹窗只断开实时流，不向后端发 stop；分析任务继续后台跑完落库
      teardownWs();
    }
  },
);

onUnmounted(teardownWs);
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="900px"
    top="6vh"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="ai-dialog">
      <aside class="hist">
        <el-button type="primary" class="run-btn" :loading="busy" @click="startAnalyze">
          {{ busy ? '分析中…' : '发起分析' }}
        </el-button>
        <el-button v-if="busy" class="stop-btn" @click="stop">停止</el-button>
        <div class="hist-title">历史记录</div>
        <div v-loading="loadingHistory" class="hist-list">
          <div
            v-for="h in history"
            :key="h.id"
            class="hist-item"
            :class="{ active: selected?.id === h.id }"
            @click="pickHistory(h)"
          >
            <span class="hist-time">{{ fmtTime(h.createdAt) }}</span>
          </div>
          <div v-if="!loadingHistory && !history.length" class="hist-empty">暂无历史</div>
        </div>
      </aside>

      <main class="ai-main">
        <!-- 历史态：最终结论（review/research 走结构化富渲染，其余 Markdown） -->
        <template v-if="selected">
          <ReviewResultView
            v-if="resultRenderer === 'review'"
            :text="selected.content"
            :viewing-history="true"
          />
          <ResearchResultView
            v-else-if="resultRenderer === 'research'"
            :text="selected.content"
            :viewing-history="true"
          />
          <MarkdownView v-else :source="selected.content" />
        </template>
        <!-- 实时收敛后：结构化渲染器切换到富渲染 -->
        <ReviewResultView
          v-else-if="resultRenderer === 'review' && !busy && liveFinalText"
          :text="liveFinalText"
        />
        <ResearchResultView
          v-else-if="resultRenderer === 'research' && !busy && liveFinalText"
          :text="liveFinalText"
        />
        <!-- 实时态：流式轨迹 -->
        <template v-else>
          <AgentTrace :steps="steps" :busy="busy" />
          <div v-if="!busy && !steps.length" class="main-empty">
            点击「发起分析」开始，或从左侧选择历史记录
          </div>
        </template>
      </main>
    </div>
  </el-dialog>
</template>

<style scoped>
.ai-dialog {
  display: flex;
  gap: 14px;
  height: 66vh;
}
.hist {
  width: 200px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-right: 1px solid var(--border);
  padding-right: 12px;
}
.run-btn,
.stop-btn {
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
.hist-empty,
.main-empty {
  color: var(--text-2);
  font-size: 13px;
  padding: 12px 4px;
}
.ai-main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 4px 6px;
}
</style>
