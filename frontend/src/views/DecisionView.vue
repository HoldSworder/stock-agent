<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { ArrowRight, CircleClose, Clock, MagicStick } from '@element-plus/icons-vue';
import { api, openWs } from '@/api';
import AgentTrace from '@/components/AgentTrace.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import { applyStepEvent, type Step } from '@/composables/agentTrace';
import type { AiAnalysisHistoryItem, DecisionIndexInfo, StreamEvent } from '@stock-agent/shared';

// 决策流水线阶段：描述本页实际执行顺序，供用户预期管理（非实时状态）
const PHASES = ['分析师研判', '多空辩论', '风控博弈', '组合裁决'];

// 多智能体辩论决策页：输入代码（个股）或选择股指 → 流式跑「分析师→多空辩论→风控→决策」流水线，
// 复用公共 ai_analyses 历史（kind=decision，refKey=代码/指数key）。WS 路径 /ws/decision。

// 资产类型：个股（6 位代码）/ 股指（白名单 secid 取数）/ ETF（6 位代码，方向研判）
const assetType = ref<'stock' | 'index' | 'etf'>('stock');
const code = ref('');
const indices = ref<DecisionIndexInfo[]>([]);
const indexKey = ref('');
const steps = ref<Step[]>([]);
const busy = ref(false);
const history = ref<AiAnalysisHistoryItem[]>([]);
const loadingHistory = ref(false);
const selected = ref<AiAnalysisHistoryItem | null>(null);

let ws: WebSocket | null = null;
let runFinished = true;
let closingByUser = false;

// 个股：合法 6 位代码按代码过滤，否则列全部；股指：按选中 key 过滤，否则列全部
async function loadHistory() {
  loadingHistory.value = true;
  try {
    if (assetType.value === 'index') {
      history.value = indexKey.value
        ? await api.listAnalyses('decision', indexKey.value)
        : await api.listAnalyses('decision', undefined, 30, true);
    } else {
      const c = code.value.trim();
      history.value = /^\d{6}$/.test(c)
        ? await api.listAnalyses('decision', c)
        : await api.listAnalyses('decision', undefined, 30, true);
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '历史加载失败');
  } finally {
    loadingHistory.value = false;
  }
}

// 输入框变化即过滤历史（debounce），与「发起决策」的回车彻底解耦
let filterTimer: ReturnType<typeof setTimeout> | null = null;
watch([code, indexKey, assetType], () => {
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(loadHistory, 300);
});

function pickHistory(item: AiAnalysisHistoryItem) {
  if (busy.value) return;
  selected.value = item;
}

function teardownWs() {
  closingByUser = true;
  ws?.close();
  ws = null;
}

function start() {
  const c = code.value.trim();
  if (assetType.value === 'index') {
    if (!indexKey.value) {
      ElMessage.warning('请选择一个股指');
      return;
    }
  } else if (!/^\d{6}$/.test(c)) {
    ElMessage.warning(assetType.value === 'etf' ? '请输入合法的 6 位 ETF 代码' : '请输入合法的 6 位股票代码');
    return;
  }
  if (busy.value) return;
  steps.value = [];
  selected.value = null;
  busy.value = true;
  runFinished = false;
  closingByUser = false;

  ws = openWs('/ws/decision');
  ws.onmessage = (ev) => {
    const e: StreamEvent = JSON.parse(ev.data);
    if (e.type === 'run_finished') {
      runFinished = true;
      busy.value = false;
      if (e.status === 'success') {
        loadHistory();
      } else if (e.status === 'canceled' && !steps.value.length) {
        steps.value.push({ kind: 'text', content: '(已停止)' });
      }
      teardownWs();
    } else if (e.type === 'error') {
      ElMessage.error(e.message);
      runFinished = true;
      busy.value = false;
    } else {
      applyStepEvent(steps.value, e);
    }
  };
  ws.onclose = () => {
    if (busy.value && !runFinished) {
      if (!steps.value.length) steps.value.push({ kind: 'text', content: '(连接中断，请重试)' });
      if (!closingByUser) ElMessage.error('连接中断，决策未完成');
    }
    busy.value = false;
  };

  const payload =
    assetType.value === 'index'
      ? JSON.stringify({ action: 'generate', assetType: 'index', code: indexKey.value })
      : assetType.value === 'etf'
        ? JSON.stringify({ action: 'generate', assetType: 'etf', code: c })
        : JSON.stringify({ action: 'generate', code: c });
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

async function loadIndices() {
  try {
    indices.value = await api.decisionAgents.indices();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '股指列表加载失败');
  }
}

const route = useRoute();
onMounted(() => {
  // 「深度辩论」跨链预填：?code=6位&asset=stock|etf（只预填代码与资产类型，不自动发起，避免意外 LLM 消耗）
  const qCode = String(route.query.code ?? '').trim();
  const qAsset = String(route.query.asset ?? '').trim();
  if (/^\d{6}$/.test(qCode)) {
    code.value = qCode;
    assetType.value = qAsset === 'etf' ? 'etf' : 'stock';
  }
  loadHistory();
  loadIndices();
});
onUnmounted(() => {
  if (filterTimer) clearTimeout(filterTimer);
  teardownWs();
});
</script>

<template>
  <div class="page decision">
    <div class="page-head">
      <div class="page-title">多智能体辩论决策</div>
      <div class="actions">
        <el-radio-group v-model="assetType" :disabled="busy" size="default">
          <el-radio-button value="stock">个股</el-radio-button>
          <el-radio-button value="index">股指</el-radio-button>
          <el-radio-button value="etf">ETF</el-radio-button>
        </el-radio-group>
        <el-input
          v-if="assetType !== 'index'"
          v-model="code"
          class="code-input"
          :placeholder="assetType === 'etf' ? '6 位 ETF 代码' : '6 位股票代码'"
          maxlength="6"
          clearable
          @keyup.enter="start"
        />
        <el-select
          v-else
          v-model="indexKey"
          class="index-select"
          placeholder="选择股指"
          filterable
          clearable
        >
          <el-option v-for="it in indices" :key="it.key" :label="it.name" :value="it.key" />
        </el-select>
        <el-button type="primary" :icon="MagicStick" :loading="busy" @click="start">
          {{ busy ? '决策中' : '发起决策' }}
        </el-button>
        <el-button v-if="busy" :icon="CircleClose" @click="stop">停止</el-button>
      </div>
    </div>

    <!-- 决策流水线：展示本页 agent 实际执行顺序，运行中整条流水线呼吸提示 -->
    <div class="pipeline" :class="{ running: busy }">
      <template v-for="(p, i) in PHASES" :key="p">
        <span class="phase">{{ p }}</span>
        <el-icon v-if="i < PHASES.length - 1" class="flow"><ArrowRight /></el-icon>
      </template>
    </div>

    <div class="body">
      <aside class="hist">
        <div class="hist-title">
          <el-icon><Clock /></el-icon>
          <span>历史记录</span>
        </div>
        <div v-loading="loadingHistory" class="hist-list">
          <button
            v-for="h in history"
            :key="h.id"
            type="button"
            class="hist-item"
            :class="{ active: selected?.id === h.id }"
            :disabled="busy"
            @click="pickHistory(h)"
          >
            <span class="hist-name">{{ h.title || '决策' }}</span>
            <span class="hist-time num">{{ fmtTime(h.createdAt) }}</span>
          </button>
          <p v-if="!loadingHistory && !history.length" class="hist-empty">暂无决策历史</p>
        </div>
      </aside>

      <main class="main">
        <MarkdownView v-if="selected" :source="selected.content" />
        <template v-else-if="busy || steps.length">
          <AgentTrace :steps="steps" :busy="busy" />
        </template>
        <el-empty
          v-else
          class="main-empty"
          :image-size="92"
          description="输入个股/ETF 代码或选择股指点击「发起决策」，或从左侧选择历史记录"
        />
      </main>
    </div>
  </div>
</template>

<style scoped>
.decision {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.decision .page-head {
  flex-wrap: wrap;
  gap: 12px;
}
.actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.code-input {
  width: 160px;
}
.index-select {
  width: 180px;
}

/* ===== 决策流水线 ===== */
.pipeline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 18px;
  padding: 9px 14px;
  background: var(--bg-2);
  border: 1px solid var(--border-soft);
  border-radius: 999px;
  width: fit-content;
  max-width: 100%;
}
.pipeline .phase {
  font-size: 12.5px;
  color: var(--text-1);
  white-space: nowrap;
}
.pipeline .flow {
  color: var(--text-2);
  font-size: 13px;
}
/* 运行中：整条流水线呼吸高亮，传达「进行中」反馈 */
.pipeline.running {
  border-color: var(--brand);
  box-shadow: 0 0 0 1px var(--brand-soft), 0 0 18px var(--brand-soft);
  animation: pipeline-breathe 1.8s ease-in-out infinite;
}
.pipeline.running .phase {
  color: var(--brand-2);
}
@keyframes pipeline-breathe {
  0%,
  100% {
    box-shadow: 0 0 0 1px var(--brand-soft), 0 0 14px var(--brand-soft);
  }
  50% {
    box-shadow: 0 0 0 1px var(--brand-glow), 0 0 26px var(--brand-glow);
  }
}
@media (prefers-reduced-motion: reduce) {
  .pipeline.running {
    animation: none;
  }
}

/* ===== 主体：历史侧栏 + 内容区 ===== */
.body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 16px;
}
.hist {
  width: 208px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-right: 1px solid var(--border-soft);
  padding-right: 14px;
}
.hist-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.hist-list {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.hist-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 8px 11px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-1);
  text-align: left;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.hist-name {
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hist-time {
  font-size: 12px;
  color: var(--text-2);
}
.hist-item.active .hist-time {
  color: var(--brand-2);
}
.hist-item:hover:not(:disabled) {
  background: var(--bg-hover);
}
.hist-item.active {
  background: var(--brand-soft);
  border-color: var(--brand);
  color: var(--brand-2);
}
.hist-item:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.hist-empty {
  margin: 8px 2px 0;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.6;
}
.main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 2px 8px;
}
.main-empty {
  margin-top: 6vh;
}
</style>
