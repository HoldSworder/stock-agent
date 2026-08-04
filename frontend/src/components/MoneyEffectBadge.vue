<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { QuestionFilled } from '@element-plus/icons-vue';
import { api } from '@/api';
import type { MoneyEffectOverview } from '@stock-agent/shared';

// 首板赚钱效应徽标（883994·昨日打首板表现）：一行展示当前值 + 升温/退潮 + MA5/MA10/较昨。
// 用法：<MoneyEffectBadge :money-effect="data.moneyEffect" />（驾驶舱等已聚合）或 <MoneyEffectBadge auto-load />（大盘页自取）。
// 确定性只读，仅供参考不构成投资建议。

const props = withDefaults(
  defineProps<{
    moneyEffect?: MoneyEffectOverview | null;
    autoLoad?: boolean;
  }>(),
  { moneyEffect: null, autoLoad: false },
);

const loaded = ref<MoneyEffectOverview | null>(null);
const me = computed<MoneyEffectOverview | null>(() => props.moneyEffect ?? loaded.value);

async function load() {
  try {
    loaded.value = await api.moneyEffect.overview();
  } catch {
    /* best-effort：取数失败静默隐藏 */
  }
}
defineExpose({ reload: load });

onMounted(() => {
  if (props.autoLoad && !props.moneyEffect) void load();
});

const cls = computed(() => (me.value?.signal === '升温' ? 'warn' : 'down'));
const icon = computed(() => (me.value?.signal === '升温' ? '▲' : '▼'));
const deltaText = computed(() => {
  const d = me.value?.delta;
  if (d == null) return '';
  return `${d >= 0 ? '+' : ''}${d}%`;
});
</script>

<template>
  <div v-if="me" class="me-badge" :class="cls">
    <span class="meb-title"><span class="meb-icon">{{ icon }}</span>首板赚钱效应</span>
    <span class="meb-close num">{{ me.close }}</span>
    <span class="meb-signal">{{ me.signal }}</span>
    <span v-if="deltaText" class="meb-delta num" :class="(me.delta ?? 0) >= 0 ? 'up' : 'down'">{{ deltaText }}</span>
    <el-popover placement="bottom-start" :width="300" trigger="hover">
      <template #reference>
        <el-icon class="meb-help"><QuestionFilled /></el-icon>
      </template>
      <div class="meb-detail">
        <div class="meb-dt-title">883994 · 昨日打首板表现 · {{ me.tradeDate }}</div>
        <div class="meb-row"><span>收盘</span><b class="num">{{ me.close }}</b></div>
        <div class="meb-row"><span>MA5</span><b class="num" :class="me.ma5SlopeUp ? 'up' : 'down'">{{ me.ma5 }}（{{ me.ma5SlopeUp ? '向上' : '走平/向下' }}）</b></div>
        <div class="meb-row"><span>MA10</span><b class="num">{{ me.ma10 }}</b></div>
        <div class="meb-row"><span>信号</span><b :class="me.signal === '升温' ? 'warn' : 'flat'">{{ me.signal }}（{{ me.aboveMa5 ? '站上' : '跌破' }}MA5）</b></div>
        <p class="meb-note">{{ me.note }}</p>
      </div>
    </el-popover>
  </div>
</template>

<style scoped>
.me-badge {
  display: inline-flex; align-items: center; gap: 8px;
  border-radius: 8px; padding: 6px 12px;
  border: 1px solid var(--el-border-color-light);
  background: var(--el-fill-color-lighter);
  border-left-width: 4px; font-size: 13px;
}
.me-badge.warn { border-left-color: var(--el-color-warning); }
.me-badge.down { border-left-color: var(--el-color-success); }
.meb-title { font-weight: 700; }
.me-badge.warn .meb-title { color: var(--el-color-warning); }
.me-badge.down .meb-title { color: var(--el-color-success); }
.meb-icon { margin-right: 2px; }
.meb-close { font-weight: 700; font-size: 15px; }
.meb-signal { font-weight: 600; }
.me-badge.warn .meb-signal { color: var(--el-color-warning); }
.me-badge.down .meb-signal { color: var(--el-color-success); }
.meb-help { cursor: pointer; color: var(--el-text-color-secondary); }
.meb-detail { font-size: 12px; line-height: 1.7; }
.meb-dt-title { font-weight: 700; margin-bottom: 4px; }
.meb-row { display: flex; justify-content: space-between; gap: 12px; }
.meb-row > span { color: var(--el-text-color-secondary); }
.meb-note { margin: 6px 0 0; color: var(--el-text-color-placeholder); font-size: 11px; }
.num { font-variant-numeric: tabular-nums; }
.up { color: var(--el-color-danger); }
.down { color: var(--el-color-success); }
.warn { color: var(--el-color-warning); }
.flat { color: var(--el-text-color-secondary); }
</style>
