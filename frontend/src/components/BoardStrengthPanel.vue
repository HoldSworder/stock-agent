<script setup lang="ts">
import { onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh, QuestionFilled } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import StockLink from '@/components/StockLink.vue';
import ScoreBreakdownPopover from '@/components/ScoreBreakdownPopover.vue';
import StrengthMethodologyDrawer from '@/components/StrengthMethodologyDrawer.vue';
import type { RadarOverview, TrendMetrics, TrendState } from '@stock-agent/shared';

// 行业中线强弱明细（确定性下钻）：取数面为东财行业 + 概念涨幅榜（N≈40），
// 按中线 strengthScore（均线/动量口径，非当日涨幅）排序。持仓趋势/中线候选不在此呈现
// （分别与 /positions、/screener 重叠），主线研判结论见顶部 BoardReviewConclusion。

// SWR 缓存（120s，中线强弱慢变）：重进/切 Tab 瞬显，复用 ETF 指标层取数较重
const { data, loading, refreshing, load, reload } = useCachedResource<RadarOverview>(
  'radar:overview',
  () => api.radar.overview(),
  { ttlMs: 120_000 },
);
const methodology = ref<InstanceType<typeof StrengthMethodologyDrawer>>();

function trendRule(m: TrendMetrics): string {
  const f = (v: number | null) => (v == null ? '—' : v.toFixed(2));
  return `现价 ${f(m.price)} / MA20 ${f(m.ma20)} / MA60 ${f(m.ma60)} / MA250 ${f(m.ma250)}`;
}

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

// 刷新按钮：强制拉最新；初次/缓存命中走 SWR
async function refresh() {
  try {
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

onMounted(() => void load().catch((e) => ElMessage.error(e instanceof Error ? e.message : String(e))));
</script>

<template>
  <div class="panel-block">
    <div class="block-head">
      <div class="block-title">
        行业 / 概念中线强弱
        <span v-if="data" class="as-of">扫描于 {{ dayjs(data.asOf).format('MM-DD HH:mm') }}</span>
      </div>
      <div class="block-actions">
        <el-button :icon="QuestionFilled" text size="small" @click="methodology?.open('mid')">
          方法论
        </el-button>
        <el-button :icon="Refresh" size="small" :loading="loading || refreshing" @click="refresh">刷新</el-button>
      </div>
    </div>
    <StrengthMethodologyDrawer ref="methodology" />
    <div class="block-sub">
      取数面：东财行业 + 概念「今日涨幅榜 + 60日中线强势榜」合并，按中线强度排序（强度 = 龙头中线动能(20/60日代理) + 板块60日持续性，非当日涨幅），仅研判不下单。板块日 K 不可得时以领涨/龙头个股 K 线代理趋势。
    </div>

    <el-table
      v-if="data?.industries.length"
      v-loading="loading"
      :data="data.industries"
      stripe
      style="width: 100%"
    >
      <el-table-column label="板块" min-width="150">
        <template #default="{ row }">
          <span>{{ row.name }}</span>
          <el-tag
            size="small"
            effect="plain"
            :type="row.boardKind === 'concept' ? 'warning' : 'info'"
            class="kind-tag"
          >
            {{ row.boardKind === 'concept' ? '概念' : '行业' }}
          </el-tag>
        </template>
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
          <ScoreBreakdownPopover
            :title="`${row.name} 强度构成`"
            :parts="row.breakdown.parts"
            :total="row.breakdown.total"
            block
          >
            <div class="strength-cell">
              <div class="bar">
                <div
                  class="bar-fill"
                  :class="strengthClass(row.strengthScore)"
                  :style="{ width: `${row.strengthScore}%` }"
                />
              </div>
              <span class="num">{{ row.strengthScore }}</span>
            </div>
            <template #extra>趋势分级依据：{{ trendRule(row.metrics) }}</template>
          </ScoreBreakdownPopover>
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
      <el-table-column label="60日" width="90" align="right">
        <template #default="{ row }">
          <span :class="(row.ret60 ?? 0) >= 0 ? 'up' : 'down'">{{ fmtPct(row.ret60) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="年线偏离" width="100" align="right">
        <template #default="{ row }">{{ fmtPct(row.metrics.maDeviation) }}</template>
      </el-table-column>
      <el-table-column label="龙头" min-width="120">
        <template #default="{ row }">
          <StockLink
            v-if="/^\d{6}$/.test(row.leadStockCode)"
            :code="row.leadStockCode"
            :name="row.leadStock"
          />
          <span v-else>{{ row.leadStock || '—' }}</span>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-else-if="!loading" description="暂无板块数据" :image-size="80" />
  </div>
</template>

<style scoped>
.panel-block {
  margin-top: 4px;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.block-title {
  font-size: 15px;
  font-weight: 600;
}
.block-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.as-of {
  margin-left: 10px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-2);
  font-family: var(--font-mono);
}
.block-sub {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 12px;
  line-height: 1.5;
}
.kind-tag {
  margin-left: 6px;
}
.strength-cell {
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
</style>
