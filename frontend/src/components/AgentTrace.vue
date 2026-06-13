<script setup lang="ts">
import MarkdownView from '@/components/MarkdownView.vue';
import type { Step } from '@/composables/agentTrace';

// agent 流式轨迹纯渲染组件：按步序渲染文本 / 思考 / 工具调用。
// 数据累积由 composables/agentTrace.ts 的 applyStepEvent 负责，本组件只展示。
defineProps<{
  steps: Step[];
  /** 运行中且无任何步骤时显示「思考中…」占位 */
  busy?: boolean;
}>();
</script>

<template>
  <div class="agent-trace">
    <template v-for="(s, si) in steps" :key="si">
      <MarkdownView v-if="s.kind === 'text' && s.content" :source="s.content" />
      <div v-else-if="s.kind === 'think'" class="think-step">
        <div class="think-head">
          <el-icon><Cpu /></el-icon><span>思考</span>
        </div>
        <div class="think-body">{{ s.content }}</div>
      </div>
      <div v-else-if="s.kind === 'tool'" class="tool-step" :class="{ open: s.open }">
        <div class="tool-head" @click="s.open = !s.open">
          <el-icon class="tool-ico"><Tools /></el-icon>
          <span class="tool-name">{{ s.name }}</span>
          <span class="tool-status">
            <el-icon v-if="!s.done" class="spin"><Loading /></el-icon>
            <el-icon v-else-if="s.ok" class="ok"><CircleCheck /></el-icon>
            <el-icon v-else class="fail"><CircleClose /></el-icon>
          </span>
          <el-icon class="caret" :class="{ rot: s.open }"><ArrowRight /></el-icon>
        </div>
        <div v-if="s.open" class="tool-detail">
          <div class="tool-block">
            <div class="tool-label">入参</div>
            <pre class="tool-pre">{{ s.args || '{}' }}</pre>
          </div>
          <div v-if="s.done" class="tool-block">
            <div class="tool-label">结果<span class="tool-hint">（预览，最多 300 字）</span></div>
            <pre class="tool-pre">{{ s.result || '(空)' }}</pre>
          </div>
        </div>
      </div>
    </template>
    <div v-if="busy && !steps.length" class="trace-placeholder">思考中…</div>
  </div>
</template>

<style scoped>
.trace-placeholder {
  font-family: var(--font-body);
  color: var(--text-2);
}

/* ===== agent 轨迹：思考步骤 ===== */
.think-step {
  margin: 6px 0;
  padding: 8px 10px;
  border-left: 2px solid var(--brand, #f0b429);
  background: rgba(240, 180, 41, 0.06);
  border-radius: 0 6px 6px 0;
}
.think-head {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--brand, #f0b429);
  margin-bottom: 4px;
}
.think-body {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.55;
  white-space: pre-wrap;
}

/* ===== agent 轨迹：工具调用 ===== */
.tool-step {
  margin: 6px 0;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-1, rgba(255, 255, 255, 0.02));
  overflow: hidden;
}
.tool-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  cursor: pointer;
  font-size: 12px;
  user-select: none;
}
.tool-head:hover {
  background: var(--bg-hover);
}
.tool-ico {
  color: var(--text-2);
}
.tool-name {
  font-family: var(--font-mono);
  color: var(--text-1);
  flex: 1;
  min-width: 0;
}
.tool-status .spin {
  animation: spin 0.8s linear infinite;
  color: var(--brand, #f0b429);
}
.tool-status .ok {
  color: var(--success, #67c23a);
}
.tool-status .fail {
  color: var(--danger, #f56c6c);
}
.caret {
  color: var(--text-2);
  transition: transform 0.15s ease;
}
.caret.rot {
  transform: rotate(90deg);
}
.tool-detail {
  padding: 8px 10px;
  border-top: 1px solid var(--border);
}
.tool-block + .tool-block {
  margin-top: 8px;
}
.tool-label {
  font-size: 11px;
  color: var(--text-2);
  margin-bottom: 3px;
}
.tool-hint {
  color: var(--text-3, var(--text-2));
  opacity: 0.7;
}
.tool-pre {
  margin: 0;
  padding: 7px 9px;
  background: var(--bg-2);
  border-radius: 5px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-1);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 280px;
  overflow: auto;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
