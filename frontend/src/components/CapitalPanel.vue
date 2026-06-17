<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '@/api';
import type { StockCapitalDetail, CapitalSeat, CapitalSeatTag } from '@stock-agent/shared';

// S7 资金面面板：个股龙虎榜净额趋势 + 最近一次席位拆分（游资/机构/北向辨识）。
// 嵌入 KlineDialog「资金面」视图；按 code 懒加载，仅在切到本视图时取数。

const props = defineProps<{ code: string }>();

const data = ref<StockCapitalDetail | null>(null);
const loading = ref(false);
const error = ref('');

const SEAT_TAG: Record<CapitalSeatTag, 'danger' | 'warning' | 'info' | ''> = {
  游资: 'danger',
  机构: 'warning',
  北向: '',
  其他: 'info',
};

const wan = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(0)}`;

/** 席位按净额绝对值排序取前 5 */
const topSeats = (seats: CapitalSeat[]): CapitalSeat[] =>
  seats.slice().sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 5);

async function load(): Promise<void> {
  if (!props.code) return;
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.capital.stock(props.code);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '资金面加载失败';
  } finally {
    loading.value = false;
  }
}

watch(() => props.code, load, { immediate: true });
defineExpose({ reload: load });
</script>

<template>
  <div v-loading="loading" class="capital-panel">
    <div v-if="error" class="cap-error">{{ error }}</div>
    <template v-else-if="data">
      <!-- 净额趋势 -->
      <div class="cap-block">
        <div class="cap-title">龙虎榜净额趋势</div>
        <el-table v-if="data.recent.length" :data="data.recent" size="small" style="width: 100%">
          <el-table-column label="上榜日" prop="date" min-width="100" />
          <el-table-column label="涨跌" min-width="76" align="right">
            <template #default="{ row }">
              <span class="num" :class="row.pct >= 0 ? 'up' : 'down'">{{ row.pct.toFixed(2) }}%</span>
            </template>
          </el-table-column>
          <el-table-column label="净买入(万)" min-width="96" align="right">
            <template #default="{ row }">
              <span class="num" :class="row.net >= 0 ? 'up' : 'down'">{{ wan(row.net) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="换手" min-width="72" align="right">
            <template #default="{ row }"><span class="num">{{ row.turnover.toFixed(1) }}%</span></template>
          </el-table-column>
          <el-table-column label="上榜原因" prop="reason" min-width="160" show-overflow-tooltip />
        </el-table>
        <el-empty v-else :image-size="50" description="近期无龙虎榜上榜记录" />
      </div>

      <!-- 席位拆分 -->
      <div v-if="data.seats" class="cap-block">
        <div class="cap-title">
          最近一次席位拆分
          <span class="cap-sub">{{ data.seats.date }}<template v-if="data.seats.reason"> · {{ data.seats.reason }}</template></span>
        </div>
        <div class="seats-grid">
          <div class="seats-col">
            <div class="seats-cap up">买方 TOP5</div>
            <div v-for="s in topSeats(data.seats.buys)" :key="s.name" class="seat-row">
              <el-tag :type="SEAT_TAG[s.tag]" size="small" effect="plain" class="seat-tag">{{ s.tag }}</el-tag>
              <span class="seat-name" :title="s.name">{{ s.name }}</span>
              <span class="num up">{{ wan(s.net) }}万</span>
            </div>
            <el-empty v-if="!data.seats.buys.length" :image-size="40" description="无" />
          </div>
          <div class="seats-col">
            <div class="seats-cap down">卖方 TOP5</div>
            <div v-for="s in topSeats(data.seats.sells)" :key="s.name" class="seat-row">
              <el-tag :type="SEAT_TAG[s.tag]" size="small" effect="plain" class="seat-tag">{{ s.tag }}</el-tag>
              <span class="seat-name" :title="s.name">{{ s.name }}</span>
              <span class="num down">{{ wan(s.net) }}万</span>
            </div>
            <el-empty v-if="!data.seats.sells.length" :image-size="40" description="无" />
          </div>
        </div>
      </div>
      <div v-else-if="data.recent.length" class="cap-hint">该标的暂无可用席位拆分明细。</div>
    </template>
  </div>
</template>

<style scoped>
.capital-panel {
  min-height: 200px;
  padding: 2px;
}
.cap-error {
  color: var(--el-color-danger);
  padding: 16px;
}
.cap-block {
  margin-bottom: 16px;
}
.cap-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 8px;
}
.cap-sub {
  font-weight: 400;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-left: 6px;
}
.cap-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.num.up {
  color: var(--el-color-danger);
}
.num.down {
  color: var(--el-color-success);
}
.seats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.seats-cap {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.seats-cap.up {
  color: var(--el-color-danger);
}
.seats-cap.down {
  color: var(--el-color-success);
}
.seat-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.seat-tag {
  flex: 0 0 auto;
  transform: scale(0.88);
}
.seat-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.seat-row .num {
  flex: 0 0 auto;
  font-weight: 600;
}
</style>
