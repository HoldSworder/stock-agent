<script setup lang="ts">
import { computed, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { ArrowDown, ArrowUp, CopyDocument, View } from '@element-plus/icons-vue';
import StockLink from '@/components/StockLink.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import type { WatchAlert, WatchSource } from '@stock-agent/shared';

// 个股盯盘告警卡片：裁决条 / 结构化执行指令卡（买卖建议）/ 触发证据 / AI 研判（Markdown 折叠）。
// 设计范式对齐 EtfAlertCard，但个股无分层概念，价位/仓位按非空字段渲染。
const props = defineProps<{ alert: WatchAlert }>();
const emit = defineEmits<{ (e: 'open-run', runId: string): void }>();

const expanded = ref(false);

const sourceLabel = (s: WatchSource): string =>
  s === 'position' ? '持仓·卖点' : s === 'watch' ? '自选·买点' : '扫描·异动';
const sourceTag = (s: WatchSource): 'danger' | 'warning' | 'info' =>
  s === 'position' ? 'danger' : s === 'watch' ? 'warning' : 'info';

// 动作/裁决语义色：买/加=涨色，减/清=跌色，其余中性
function actionClass(a: string | null | undefined): 'up' | 'down' | 'dim' {
  if (a === '买入' || a === '加仓') return 'up';
  if (a === '减仓' || a === '清仓') return 'down';
  return 'dim';
}
const verdictTag = (a: string | null | undefined): 'success' | 'danger' | 'info' => {
  const c = actionClass(a);
  return c === 'up' ? 'success' : c === 'down' ? 'danger' : 'info';
};

const instruction = computed(() => props.alert.instruction);
// 标题动作优先用结构化动作，回退裁决枚举
const headAction = computed<string | null>(
  () => instruction.value?.action ?? props.alert.verdict ?? null,
);
const actionCls = computed(() => actionClass(headAction.value));

// 买入区间仅在买/加仓且价位有效时展示，避免观望/卖出出现 ?–?
const showEntry = computed(() => {
  const i = instruction.value;
  if (!i || (i.action !== '买入' && i.action !== '加仓')) return false;
  return i.entryLow != null || i.entryHigh != null;
});

const fmtPx = (n: number | null): string => (n != null ? n.toFixed(3) : '—');

const accentVar = computed(() => {
  const c = actionCls.value;
  return c === 'up'
    ? 'var(--el-color-success)'
    : c === 'down'
      ? 'var(--el-color-danger)'
      : 'var(--brand)';
});

// 折叠态一行研判预览：去 markdown 记号后截断
const advicePreview = computed(() => {
  const a = props.alert.adviceText;
  if (!a) return '';
  return a
    .replace(/[#*`>_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
});

async function copy() {
  const text = props.alert.adviceText || props.alert.detail || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('已复制');
  } catch {
    ElMessage.error('复制失败');
  }
}

// 仅在动作语义为买/加（涨色）时止盈展示涨色，否则中性，避免误导
const tpCls = computed(() => (actionCls.value === 'up' ? 'up' : ''));
</script>

<template>
  <div class="alert-card" :class="{ muted: !alert.shouldAlert }" :style="{ '--accent': accentVar }">
    <!-- 裁决条 -->
    <div class="t1">
      <el-tag
        v-if="headAction"
        :type="verdictTag(headAction)"
        size="small"
        effect="dark"
        class="verdict"
      >
        {{ headAction }}
      </el-tag>
      <StockLink :code="alert.code" :name="alert.name" class="name" />
      <el-tag :type="sourceTag(alert.source)" size="small" effect="plain" class="src">
        {{ sourceLabel(alert.source) }}
      </el-tag>
      <el-tag v-if="alert.strategyName" size="small" effect="plain" type="warning" class="strat-chip">
        {{ alert.strategyName }}
      </el-tag>
      <span class="spacer" />
      <span class="feed-time">{{ dayjs(alert.createdAt).format('MM-DD HH:mm') }}</span>
    </div>

    <!-- 状态标记行 -->
    <div v-if="alert.execStatus || !alert.shouldAlert || (alert.shouldAlert && !alert.delivered)" class="flags">
      <el-tag v-if="alert.execStatus === 'executed'" type="success" size="small" effect="dark">已自动卖出</el-tag>
      <el-tag v-else-if="alert.execStatus === 'skipped'" type="warning" size="small" effect="plain">自动卖出跳过</el-tag>
      <el-tag v-if="!alert.shouldAlert" type="info" size="small" effect="plain">沉默</el-tag>
      <el-tag v-if="alert.shouldAlert && !alert.delivered" type="warning" size="small" effect="plain">待补发</el-tag>
    </div>

    <!-- 执行指令卡 · 可闭眼照做 -->
    <div v-if="instruction" class="instr" :class="actionCls">
      <div class="instr-head">
        <span class="instr-action" :class="actionCls">{{ instruction.action }}</span>
        <span v-if="instruction.sizePct != null" class="instr-size num">仓位 {{ instruction.sizePct }}%</span>
      </div>
      <div class="instr-grid">
        <div v-if="showEntry" class="kv">
          <span class="k">买入区间</span>
          <span class="v num">{{ fmtPx(instruction.entryLow) }} – {{ fmtPx(instruction.entryHigh) }}</span>
        </div>
        <div v-if="instruction.stopLoss != null" class="kv">
          <span class="k">止损</span><span class="v num down">{{ fmtPx(instruction.stopLoss) }}</span>
        </div>
        <div v-if="instruction.takeProfit != null" class="kv">
          <span class="k">止盈</span><span class="v num" :class="tpCls">{{ fmtPx(instruction.takeProfit) }}</span>
        </div>
        <div v-if="instruction.invalidation" class="kv wide">
          <span class="k">失效</span><span class="v">{{ instruction.invalidation }}</span>
        </div>
        <div v-if="instruction.reason" class="kv wide">
          <span class="k">依据</span><span class="v">{{ instruction.reason }}</span>
        </div>
      </div>
    </div>

    <!-- 触发证据 -->
    <div class="t3">
      <span class="ev">触发价 {{ alert.triggerPrice ? alert.triggerPrice.toFixed(2) : '—' }}</span>
      <span v-if="alert.outcome" class="ev">
        应验 {{ alert.outcome }}{{ alert.outcomePct != null ? ` ${alert.outcomePct.toFixed(2)}%` : '' }}
      </span>
    </div>
    <div class="trigger">触发：{{ alert.detail }}</div>

    <!-- 自动卖出回执 -->
    <div
      v-if="alert.execNote"
      class="exec"
      :class="alert.execStatus === 'executed' ? 'exec-ok' : 'exec-skip'"
    >
      {{ alert.execNote }}
    </div>

    <!-- AI 研判（折叠） -->
    <div v-if="alert.adviceText" class="advice">
      <button type="button" class="advice-toggle" @click="expanded = !expanded">
        <el-icon><component :is="expanded ? ArrowUp : ArrowDown" /></el-icon>
        <span class="advice-toggle-label">AI 研判</span>
        <span v-if="!expanded" class="advice-preview">{{ advicePreview }}</span>
      </button>
      <MarkdownView v-if="expanded" :source="alert.adviceText" class="advice-body" />
    </div>

    <!-- 操作 -->
    <div class="foot">
      <span class="spacer" />
      <button v-if="alert.adviceText || alert.detail" type="button" class="act" @click="copy">
        <el-icon><CopyDocument /></el-icon>复制
      </button>
      <button v-if="alert.runId" type="button" class="act" @click="emit('open-run', alert.runId)">
        <el-icon><View /></el-icon>查看运行
      </button>
    </div>
  </div>
</template>

<style scoped>
.alert-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-1);
  border-left: 3px solid var(--accent);
  min-width: 0;
  transition: background 0.15s ease;
}
.alert-card:hover {
  background: var(--bg-hover);
}
.alert-card.muted {
  opacity: 0.62;
}

/* 裁决条 */
.t1 {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.verdict {
  flex: none;
}
.name {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.src {
  flex: none;
}
.strat-chip {
  flex: none;
}
.spacer {
  flex: 1;
}
.feed-time {
  flex: none;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-2);
}

.flags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* 执行指令卡 */
.instr {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 7px 9px;
  background: var(--bg-2);
}
.instr.up {
  border-color: color-mix(in srgb, var(--up) 45%, var(--border));
  background: color-mix(in srgb, var(--up) 7%, var(--bg-2));
}
.instr.down {
  border-color: color-mix(in srgb, var(--down) 45%, var(--border));
  background: color-mix(in srgb, var(--down) 7%, var(--bg-2));
}
.instr-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.instr-action {
  font-size: 15px;
  font-weight: 700;
}
.instr-action.up {
  color: var(--up);
}
.instr-action.down {
  color: var(--down);
}
.instr-action.dim {
  color: var(--text-2);
}
.instr-size {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-1);
  font-weight: 600;
}
.instr-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 14px;
  margin-top: 5px;
}
.kv {
  display: flex;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
}
.kv.wide {
  flex-basis: 100%;
}
.kv .k {
  flex: none;
  color: var(--text-2);
}
.kv .v {
  color: var(--text-1);
  overflow-wrap: anywhere;
}

/* 触发证据 */
.t3 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-2);
}
.trigger {
  font-size: 12px;
  color: var(--text-1);
  line-height: 1.5;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.exec {
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}
.exec.exec-ok {
  color: var(--up);
  background: color-mix(in srgb, var(--up) 12%, transparent);
}
.exec.exec-skip {
  color: var(--text-2);
  background: var(--bg-2);
}

/* AI 研判 */
.advice {
  border-top: 1px dashed var(--border);
  padding-top: 6px;
}
.advice-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-2);
  font-size: 12px;
  text-align: left;
}
.advice-toggle:hover {
  color: var(--brand);
}
.advice-toggle-label {
  flex: none;
  font-weight: 600;
}
.advice-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
  font-weight: 400;
}
.advice-body {
  margin-top: 6px;
  font-size: 13px;
}

/* 操作 */
.foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 2px;
}
.act {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
}
.act:hover {
  color: var(--brand);
}
.num {
  font-family: var(--font-mono);
}
.up {
  color: var(--up);
}
.down {
  color: var(--down);
}
</style>
