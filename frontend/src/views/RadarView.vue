<script setup lang="ts">
import { onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import StockLink from '@/components/StockLink.vue';
import ModuleScheduleDialog from '@/components/ModuleScheduleDialog.vue';
import type { RadarOverview, TrendState } from '@stock-agent/shared';

const data = ref<RadarOverview | null>(null);
const loading = ref(false);

const TREND_LABEL: Record<TrendState, string> = {
  multi_long: '多头排列',
  up: '趋势向上',
  range: '震荡',
  down: '走弱',
};
const trendLabel = (t: TrendState) => TREND_LABEL[t];
const trendTag = (t: TrendState) =>
  t === 'multi_long' ? 'success' : t === 'up' ? 'success' : t === 'down' ? 'danger' : 'info';
const strengthClass = (v: number) => (v >= 70 ? 'hot' : v >= 50 ? 'mid' : 'low');
const fmtPct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

async function load() {
  loading.value = true;
  try {
    data.value = await api.radar.overview();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">中线雷达</div>
      <div class="head-actions">
        <ModuleScheduleDialog module="radar" />
        <el-button :icon="Refresh" type="primary" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>
    <div class="page-sub">
      行业强弱 + 持仓趋势 + 中线候选，基于均线排列/动量等确定性指标，仅研判不下单。
      <span v-if="data" class="as-of">扫描于 {{ dayjs(data.asOf).format('MM-DD HH:mm') }}</span>
    </div>

    <div v-loading="loading">
      <!-- 行业强弱雷达 -->
      <div class="section">
        <div class="section-title">行业强弱雷达</div>
        <el-table v-if="data?.industries.length" :data="data.industries" stripe style="width: 100%">
          <el-table-column label="行业" min-width="120">
            <template #default="{ row }">{{ row.name }}</template>
          </el-table-column>
          <el-table-column label="趋势" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="trendTag(row.trend)" effect="plain">
                {{ trendLabel(row.trend) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="强度" width="140">
            <template #default="{ row }">
              <div class="strength-cell">
                <div class="bar">
                  <div class="bar-fill" :class="strengthClass(row.strengthScore)" :style="{ width: `${row.strengthScore}%` }" />
                </div>
                <span class="num">{{ row.strengthScore }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="动量排名" width="90" align="center">
            <template #default="{ row }">{{ row.momentumRank ?? '—' }}</template>
          </el-table-column>
          <el-table-column label="今日" width="90" align="right">
            <template #default="{ row }">
              <span :class="(row.pct ?? 0) >= 0 ? 'up' : 'down'">{{ fmtPct(row.pct) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="年线偏离" width="100" align="right">
            <template #default="{ row }">{{ fmtPct(row.metrics.maDeviation) }}</template>
          </el-table-column>
          <el-table-column label="龙头" min-width="120">
            <template #default="{ row }">
              <StockLink v-if="/^\d{6}$/.test(row.leadStockCode)" :code="row.leadStockCode" :name="row.leadStock" />
              <span v-else>{{ row.leadStock || '—' }}</span>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-else-if="!loading" description="暂无行业数据" :image-size="80" />
      </div>

      <!-- 持仓趋势 -->
      <div class="section">
        <div class="section-title">持仓趋势状态</div>
        <el-table v-if="data?.positions.length" :data="data.positions" stripe style="width: 100%">
          <el-table-column label="标的" min-width="140">
            <template #default="{ row }"><StockLink :code="row.code" :name="row.name" /></template>
          </el-table-column>
          <el-table-column label="趋势" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="trendTag(row.trend)" effect="plain">
                {{ trendLabel(row.trend) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="持有盈亏" width="100" align="right">
            <template #default="{ row }">
              <span :class="(row.holdRate ?? 0) >= 0 ? 'up' : 'down'">{{ fmtPct(row.holdRate) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="仓位" width="80" align="right">
            <template #default="{ row }">{{ row.positionRate == null ? '—' : `${row.positionRate.toFixed(1)}%` }}</template>
          </el-table-column>
          <el-table-column label="距MA60" width="90" align="right">
            <template #default="{ row }">{{ fmtPct(row.toMa60Pct) }}</template>
          </el-table-column>
          <el-table-column label="跟随建议" min-width="220">
            <template #default="{ row }"><span class="advice">{{ row.advice }}</span></template>
          </el-table-column>
        </el-table>
        <el-empty v-else-if="!loading" description="无持仓或同花顺数据不可用" :image-size="80" />
      </div>

      <!-- 中线候选池 -->
      <div class="section">
        <div class="section-title">中线候选池</div>
        <div v-if="data?.candidates.length" class="cand-grid">
          <div v-for="c in data.candidates" :key="c.code" class="cand-card">
            <div class="cand-top">
              <StockLink :code="c.code" :name="c.name" />
              <el-tag size="small" effect="plain" :type="c.kind === 'etf' ? 'warning' : ''">
                {{ c.kind === 'etf' ? 'ETF' : '行业龙头' }}
              </el-tag>
            </div>
            <div class="cand-strength">
              <div class="bar">
                <div class="bar-fill" :class="strengthClass(c.strengthScore)" :style="{ width: `${c.strengthScore}%` }" />
              </div>
              <span class="num">{{ Math.round(c.strengthScore) }}</span>
            </div>
            <div class="cand-reason">{{ c.reason }}</div>
          </div>
        </div>
        <el-empty v-else-if="!loading" description="暂无中线候选" :image-size="80" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.as-of {
  margin-left: 10px;
  font-size: 12px;
  color: var(--text-2);
  font-family: var(--font-mono);
}
.section {
  margin-top: 20px;
}
.section-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 10px;
}
.strength-cell,
.cand-strength {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bar {
  flex: 1;
  height: 6px;
  background: var(--bg-3, rgba(255, 255, 255, 0.08));
  border-radius: 3px;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 3px;
}
.bar-fill.hot {
  background: var(--danger, #f56c6c);
}
.bar-fill.mid {
  background: var(--warning, #e6a23c);
}
.bar-fill.low {
  background: var(--text-2);
}
.num {
  font-size: 13px;
  min-width: 26px;
  text-align: right;
  font-family: var(--font-mono);
}
.up {
  color: var(--danger, #f56c6c);
}
.down {
  color: var(--success, #67c23a);
}
.advice {
  font-size: 12.5px;
  color: var(--text-2);
}
.cand-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.cand-card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cand-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.cand-reason {
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.45;
}
</style>
