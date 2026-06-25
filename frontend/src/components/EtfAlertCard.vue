<script setup lang="ts">
import { computed, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { ArrowDown, ArrowUp, CopyDocument, View, Promotion } from '@element-plus/icons-vue';
import StockLink from '@/components/StockLink.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import type { EtfWatchAlert, EtfWatchTimeframe, EtfWatchVerdict } from '@stock-agent/shared';

// ETF 告警卡片：三层信息层级（裁决 / 置信度 / 证据），AI 长建议默认折叠，
// 提供 Telegram 推送状态、复制、查看关联 agent 运行等交互。
const props = defineProps<{ alert: EtfWatchAlert }>();
const emit = defineEmits<{ (e: 'open-run', runId: string): void }>();

const expanded = ref(false);

const TF_LABEL: Record<EtfWatchTimeframe, string> = { '30m': '30分', '60m': '60分', day: '日线' };
const layerLabel = (l: number): string => (l === 1 ? 'L1' : l === 2 ? 'L2' : 'L3');
const verdictTag = (v: EtfWatchVerdict): 'success' | 'info' | 'warning' | 'danger' =>
  v === '建仓' ? 'success' : v === '撤层' ? 'warning' : v === '观察' ? 'info' : 'danger';
const confCls = (c: number | null): string =>
  c == null ? 'dim' : c >= 70 ? 'up' : c >= 55 ? '' : 'down';

// 执行指令：动作语义色（建/加仓=涨色，减/清仓=跌色，观望/持有=中性）
const instruction = computed(() => props.alert.instruction);
const actionCls = computed(() => {
  const a = instruction.value?.action;
  if (a === '建仓' || a === '加仓') return 'up';
  if (a === '减仓' || a === '清仓') return 'down';
  return 'dim';
});
// 资金/量价确认色
const confirm = computed(() => props.alert.confirm);
const confirmCls = computed(() => {
  const l = confirm.value?.label;
  return l === '健康' ? 'up' : l === '背离' ? 'warn' : l === '派发警惕' ? 'down' : 'dim';
});
// 趋势阶段色
const trendStage = computed(() => props.alert.trendStage);
const trendCls = computed(() => {
  const t = trendStage.value;
  return t === '主升中' || t === '趋势初期' ? 'up' : t === '趋势破坏' ? 'down' : 'warn';
});
const fmtPx = (n: number | null): string => (n != null ? n.toFixed(3) : '—');
// 仅建/加仓且价位有效时展示买入区间，避免观望/减仓出现 0.000–0.000
const showEntry = computed(() => {
  const i = instruction.value;
  if (!i || (i.action !== '建仓' && i.action !== '加仓')) return false;
  return (i.entryLow ?? 0) > 0 || (i.entryHigh ?? 0) > 0;
});
// K 线收盘时间：分钟级 "YYYY-MM-DD HH:mm" → "MM-DD HH:mm"；日线 "YYYY-MM-DD" → "MM-DD"
const barTimeText = (bt?: string | null): string => (bt ? (bt.length >= 10 ? bt.slice(5) : bt) : '');

const isBuy = computed(() => props.alert.signalType === 'buy_layer');

// 左侧强调色跟随裁决语义，便于快速扫读
const accentVar = computed(() => {
  if (!props.alert.verdict) return 'var(--brand)';
  const t = verdictTag(props.alert.verdict);
  return t === 'success'
    ? 'var(--el-color-success)'
    : t === 'warning'
      ? 'var(--el-color-warning)'
      : t === 'danger'
        ? 'var(--el-color-danger)'
        : 'var(--el-color-info)';
});

// 折叠态的一行研判预览：去掉常见 markdown 记号后截断
const advicePreview = computed(() => {
  const a = props.alert.advice;
  if (!a) return '';
  return a
    .replace(/[#*`>_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
});

async function copy() {
  const text = props.alert.advice || props.alert.detail || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('已复制');
  } catch {
    ElMessage.error('复制失败');
  }
}
</script>

<template>
  <div class="alert-card" :style="{ '--accent': accentVar }">
    <!-- Tier 1 · 裁决 -->
    <div class="t1">
      <el-tag
        v-if="alert.verdict"
        :type="verdictTag(alert.verdict)"
        size="small"
        effect="dark"
        class="verdict"
      >
        {{ alert.verdict }}
      </el-tag>
      <StockLink :code="alert.code" :name="alert.name" class="name" />
      <span class="pos num">{{ layerLabel(alert.layer) }} · {{ alert.positionPct }}%</span>
    </div>

    <!-- Tier 2 · 置信度（仅买点）-->
    <div v-if="isBuy && alert.confidence != null" class="t2">
      <span class="meter-label">置信度</span>
      <div class="meter">
        <div
          class="meter-fill"
          :class="confCls(alert.confidence)"
          :style="{ width: Math.max(2, alert.confidence) + '%' }"
        />
      </div>
      <span class="meter-num num" :class="confCls(alert.confidence)">
        {{ alert.confidence.toFixed(0) }}
      </span>
    </div>

    <!-- 执行指令卡 · 可闭眼照做 -->
    <div v-if="instruction" class="instr" :class="actionCls">
      <div class="instr-head">
        <span class="instr-action" :class="actionCls">{{ instruction.action }}</span>
        <span v-if="instruction.layer" class="instr-layer">{{ layerLabel(instruction.layer) }}</span>
        <span v-if="instruction.sizePct > 0" class="instr-size num">
          {{ instruction.sizePct }}%<template v-if="instruction.totalAfterPct != null"> → 总仓{{ instruction.totalAfterPct }}%</template>
        </span>
      </div>
      <div class="instr-grid">
        <div v-if="showEntry" class="kv">
          <span class="k">买入区间</span>
          <span class="v num">{{ fmtPx(instruction.entryLow) }} – {{ fmtPx(instruction.entryHigh) }}</span>
        </div>
        <div v-if="instruction.stopLoss != null" class="kv">
          <span class="k">止损</span><span class="v num down">{{ fmtPx(instruction.stopLoss) }}</span>
        </div>
        <div class="kv wide">
          <span class="k">失效</span><span class="v">{{ instruction.invalidation }}</span>
        </div>
        <div v-if="instruction.reason" class="kv wide">
          <span class="k">依据</span><span class="v">{{ instruction.reason }}</span>
        </div>
        <div v-if="instruction.guardrailNote" class="kv wide guard">
          <span class="k">护栏</span><span class="v">{{ instruction.guardrailNote }}</span>
        </div>
      </div>
    </div>

    <!-- Tier 3 · 证据 -->
    <div class="t3">
      <span class="ev">{{ TF_LABEL[alert.timeframe] }}·{{ layerLabel(alert.layer) }}</span>
      <span class="ev">@ {{ alert.triggerPrice ? alert.triggerPrice.toFixed(3) : '—' }}</span>
      <span v-if="trendStage" class="chip" :class="trendCls">{{ trendStage }}</span>
      <span v-if="confirm" class="chip" :class="confirmCls">
        资金{{ confirm.label }} {{ confirm.score }}
      </span>
      <span v-if="alert.barTime" class="ev">K线 {{ barTimeText(alert.barTime) }}</span>
      <span class="ev">检测 {{ dayjs(alert.createdAt).format('MM-DD HH:mm') }}</span>
    </div>
    <div v-if="confirm" class="confirm-note">{{ confirm.volPriceNote }}；{{ confirm.shareTrendNote }}</div>
    <div class="trigger">{{ alert.detail }}</div>

    <!-- AI 研判（折叠）-->
    <div v-if="alert.advice" class="advice">
      <button type="button" class="advice-toggle" @click="expanded = !expanded">
        <el-icon><component :is="expanded ? ArrowUp : ArrowDown" /></el-icon>
        <span class="advice-toggle-label">研判</span>
        <span v-if="!expanded" class="advice-preview">{{ advicePreview }}</span>
      </button>
      <MarkdownView v-if="expanded" :source="alert.advice" class="advice-body" />
    </div>

    <!-- 状态 + 操作 -->
    <div class="foot">
      <span class="tg" :class="{ on: alert.delivered }">
        <el-icon><Promotion /></el-icon>{{ alert.delivered ? '已推送' : '未推送' }}
      </span>
      <span class="spacer" />
      <button v-if="alert.advice || alert.detail" type="button" class="act" @click="copy">
        <el-icon><CopyDocument /></el-icon>复制
      </button>
      <button
        v-if="alert.runId"
        type="button"
        class="act"
        @click="emit('open-run', alert.runId)"
      >
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

/* Tier 1 · 裁决 */
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
.pos {
  margin-left: auto;
  flex: none;
  font-size: 12px;
  color: var(--text-2);
}

/* Tier 2 · 置信度 */
.t2 {
  display: flex;
  align-items: center;
  gap: 8px;
}
.meter-label {
  flex: none;
  font-size: 11px;
  color: var(--text-2);
}
.meter {
  flex: 1;
  height: 6px;
  min-width: 0;
  border-radius: 3px;
  background: var(--bg-2);
  overflow: hidden;
}
.meter-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--text-2);
}
.meter-fill.up {
  background: var(--up);
}
.meter-fill.down {
  background: var(--down);
}
.meter-num {
  flex: none;
  font-size: 12px;
  font-weight: 600;
  min-width: 24px;
  text-align: right;
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
.instr-layer {
  font-size: 12px;
  color: var(--text-2);
  font-family: var(--font-mono);
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
.kv.guard .v {
  color: var(--el-color-warning);
}

/* 徽章：趋势阶段 / 资金确认 */
.chip {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  height: 16px;
  border-radius: 8px;
  font-size: 10px;
  font-family: var(--font-sans, inherit);
  border: 1px solid currentColor;
  opacity: 0.95;
}
.chip.up {
  color: var(--up);
}
.chip.down {
  color: var(--down);
}
.chip.warn {
  color: var(--el-color-warning);
}
.chip.dim {
  color: var(--text-2);
}
.confirm-note {
  font-size: 11px;
  color: var(--text-2);
  line-height: 1.5;
}

/* Tier 3 · 证据 */
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

/* 状态 + 操作 */
.foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 2px;
}
.spacer {
  flex: 1;
}
.tg {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--text-2);
}
.tg.on {
  color: var(--up);
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
.dim {
  color: var(--text-2);
}
</style>
