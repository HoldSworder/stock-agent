<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '@/api';
import type { StockChipDistribution } from '@stock-agent/shared';

// S8 筹码分布面板：获利比例 / 平均成本 / 70·90% 成本区间与集中度 + 近 N 日趋势。
// 嵌入 KlineDialog「筹码」视图；按 code 懒加载。

const props = defineProps<{ code: string }>();

const data = ref<StockChipDistribution | null>(null);
const loading = ref(false);
const error = ref('');

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/** 获利比例配色：高位获利盘重(红/警示) / 低位套牢重(绿) */
const profitTone = computed(() => {
  const p = data.value?.latest?.profitRatio ?? 0;
  if (p >= 0.8) return 'is-up';
  if (p <= 0.2) return 'is-down';
  return '';
});

/** 筹码集中/发散趋势文案（70% 集中度，最旧→最新） */
const concTrend = computed(() => {
  const r = data.value?.recent ?? [];
  if (r.length < 2) return '';
  const d = r[0].concentration70 - r[r.length - 1].concentration70;
  return d <= 0 ? '趋于集中（锁筹/吸筹迹象）' : '趋于发散（派发/分歧迹象）';
});

async function load(): Promise<void> {
  if (!props.code) return;
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.stockChips(props.code);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '筹码分布加载失败';
  } finally {
    loading.value = false;
  }
}

watch(() => props.code, load, { immediate: true });
</script>

<template>
  <div v-loading="loading" class="chip-panel">
    <div v-if="error" class="chip-error">{{ error }}</div>
    <template v-else-if="data?.latest">
      <div class="chip-head">
        筹码分布 · {{ data.latest.date }}<span class="chip-sub">东财前复权</span>
      </div>

      <!-- 关键指标 -->
      <div class="chip-stats">
        <div class="chip-stat" :class="profitTone">
          <div class="chip-stat__label">获利比例</div>
          <div class="chip-stat__val num">{{ pct(data.latest.profitRatio) }}</div>
          <div class="chip-stat__hint">越低套牢盘越重</div>
        </div>
        <div class="chip-stat">
          <div class="chip-stat__label">平均成本</div>
          <div class="chip-stat__val num">{{ data.latest.avgCost.toFixed(2) }}</div>
        </div>
        <div class="chip-stat">
          <div class="chip-stat__label">90% 集中度</div>
          <div class="chip-stat__val num">{{ pct(data.latest.concentration90) }}</div>
          <div class="chip-stat__hint">越小越集中</div>
        </div>
        <div class="chip-stat">
          <div class="chip-stat__label">70% 集中度</div>
          <div class="chip-stat__val num">{{ pct(data.latest.concentration70) }}</div>
        </div>
      </div>

      <!-- 成本区间 -->
      <div class="chip-ranges">
        <div class="chip-range">
          <span class="chip-range__cap">90% 成本区间</span>
          <span class="num">{{ data.latest.cost90Low.toFixed(2) }} ~ {{ data.latest.cost90High.toFixed(2) }}</span>
        </div>
        <div class="chip-range">
          <span class="chip-range__cap">70% 成本区间</span>
          <span class="num">{{ data.latest.cost70Low.toFixed(2) }} ~ {{ data.latest.cost70High.toFixed(2) }}</span>
        </div>
      </div>

      <div v-if="concTrend" class="chip-trend-tip">近 {{ data.recent.length }} 日筹码{{ concTrend }}</div>

      <!-- 近 N 日趋势 -->
      <el-table v-if="data.recent.length" :data="data.recent" size="small" style="width: 100%">
        <el-table-column label="日期" prop="date" min-width="100" />
        <el-table-column label="获利比例" min-width="90" align="right">
          <template #default="{ row }"><span class="num">{{ pct(row.profitRatio) }}</span></template>
        </el-table-column>
        <el-table-column label="平均成本" min-width="84" align="right">
          <template #default="{ row }"><span class="num">{{ row.avgCost.toFixed(2) }}</span></template>
        </el-table-column>
        <el-table-column label="70%集中度" min-width="90" align="right">
          <template #default="{ row }"><span class="num">{{ pct(row.concentration70) }}</span></template>
        </el-table-column>
      </el-table>
    </template>
    <el-empty v-else-if="!loading" :image-size="60" description="筹码分布数据不可用" />
  </div>
</template>

<style scoped>
.chip-panel {
  min-height: 200px;
  padding: 2px;
}
.chip-error {
  color: var(--el-color-danger);
  padding: 16px;
}
.chip-head {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 10px;
}
.chip-sub {
  font-weight: 400;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-left: 6px;
}
.chip-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 12px;
}
.chip-stat {
  padding: 10px 12px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
}
.chip-stat__label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.chip-stat__val {
  font-size: 18px;
  font-weight: 600;
  margin-top: 2px;
}
.chip-stat__hint {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
}
.chip-stat.is-up .chip-stat__val {
  color: var(--el-color-danger);
}
.chip-stat.is-down .chip-stat__val {
  color: var(--el-color-success);
}
.chip-ranges {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin-bottom: 10px;
}
.chip-range {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 13px;
}
.chip-range__cap {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.chip-trend-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 10px;
}
</style>
