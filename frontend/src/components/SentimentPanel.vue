<script setup lang="ts">
import { computed, onMounted } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import type {
  SentimentOverview,
  SentimentPhase,
  SentimentLevel,
  SentimentHistoryItem,
} from '@stock-agent/shared';

const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

interface SentimentData {
  ov: SentimentOverview;
  history: SentimentHistoryItem[];
}

// SWR 缓存（120s）：情绪总览取数较重且慢变，重进/切 Tab 瞬显，避免每次重拉
const { data, loading, refreshing, load, reload } = useCachedResource<SentimentData>(
  'sentiment:panel',
  async () => {
    const [ov, history] = await Promise.all([api.sentiment.overview(), api.sentiment.history(30)]);
    return { ov, history };
  },
  { ttlMs: 120_000 },
);
const ov = computed(() => data.value?.ov ?? null);
const history = computed(() => data.value?.history ?? []);

// 周期阶段配色：高潮偏暖警示、恢复偏暖、退潮偏冷、冰点最冷
const PHASE_TAG: Record<SentimentPhase, 'danger' | 'warning' | 'success' | 'info'> = {
  高潮: 'danger',
  恢复: 'success',
  退潮: 'warning',
  冰点: 'info',
  震荡: 'info',
};
const LEVEL_TAG: Record<SentimentLevel, 'danger' | 'warning' | 'success' | 'info'> = {
  高潮: 'danger',
  活跃: 'success',
  平稳: 'warning',
  低迷: 'info',
  冰点: 'info',
};

/** 指数仪表盘配色：高位红、活跃橙、中性蓝、低迷灰 */
const gaugeColor = computed(() => {
  const v = ov.value?.index ?? 0;
  if (v >= 80) return '#f56c6c';
  if (v >= 60) return '#e6a23c';
  if (v >= 40) return '#409eff';
  if (v >= 20) return '#909399';
  return '#5c6b7a';
});

const deltaText = computed(() => {
  const d = ov.value?.delta;
  if (d == null) return '无历史对比';
  if (d > 0) return `较上一交易日 +${d}`;
  if (d < 0) return `较上一交易日 ${d}`;
  return '较上一交易日持平';
});
const deltaClass = computed(() => {
  const d = ov.value?.delta;
  if (d == null) return 'flat';
  return d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
});

// 刷新按钮：强制拉最新；初次/缓存命中走 SWR
async function refresh() {
  try {
    await reload();
  } catch (e) {
    ElMessage.error(msg(e));
  }
}

onMounted(() => void load().catch((e) => ElMessage.error(msg(e))));
</script>

<template>
  <div class="sentiment-panel" v-loading="loading">
    <div class="panel-head">
      <span class="panel-tip">
        S1 短线择时总开关 · 确定性 0-100 情绪指数 + 周期阶段（乐咕活跃度 + 东财涨停池合成）
      </span>
      <el-button :icon="Refresh" :loading="loading || refreshing" size="small" @click="refresh">刷新</el-button>
    </div>

    <template v-if="ov">
      <div class="grid">
        <!-- 情绪指数仪表盘 -->
        <el-card shadow="never" class="gauge-card">
          <el-progress
            type="dashboard"
            :percentage="ov.index"
            :width="180"
            :stroke-width="14"
            :color="gaugeColor"
          >
            <template #default>
              <div class="gauge-inner">
                <div class="gauge-num" :style="{ color: gaugeColor }">{{ ov.index }}</div>
                <div class="gauge-unit">情绪指数</div>
              </div>
            </template>
          </el-progress>
          <div class="tags">
            <el-tag :type="LEVEL_TAG[ov.level]" effect="dark" size="large">水位 · {{ ov.level }}</el-tag>
            <el-tag :type="PHASE_TAG[ov.phase]" effect="dark" size="large">周期 · {{ ov.phase }}</el-tag>
          </div>
          <div class="delta" :class="deltaClass">{{ deltaText }}</div>
          <div class="as-of">数据时间 {{ dayjs(ov.asOf).format('MM-DD HH:mm') }}</div>
        </el-card>

        <!-- 白话仓位倾向 + 构成拆解 -->
        <el-card shadow="never" class="advice-card">
          <div class="card-title">仓位倾向（白话）</div>
          <div class="advice">{{ ov.advice }}</div>

          <div class="card-title" style="margin-top: 16px">指数构成（贡献点数，合计≈指数）</div>
          <div class="breakdown">
            <div v-for="p in ov.breakdown.parts" :key="p.label" class="bd-row">
              <span class="bd-label">{{ p.label }}</span>
              <el-progress
                class="bd-bar"
                :percentage="Math.min(Math.max((p.value / ov.index) * 100, 0), 100)"
                :show-text="false"
                :stroke-width="8"
                color="#409eff"
              />
              <span class="bd-val">{{ p.value }}</span>
            </div>
          </div>
        </el-card>
      </div>

      <!-- 原始构成指标 -->
      <el-card shadow="never" class="raw-card">
        <div class="card-title">原始盘面指标</div>
        <div class="metrics">
          <div class="metric"><span>上涨</span><b class="up">{{ ov.components.up ?? '—' }}</b></div>
          <div class="metric"><span>下跌</span><b class="down">{{ ov.components.down ?? '—' }}</b></div>
          <div class="metric"><span>平盘</span><b>{{ ov.components.flat ?? '—' }}</b></div>
          <div class="metric"><span>真实涨停</span><b class="up">{{ ov.components.realLimitUp ?? ov.components.limitUp ?? '—' }}</b></div>
          <div class="metric"><span>真实跌停</span><b class="down">{{ ov.components.realLimitDown ?? ov.components.limitDown ?? '—' }}</b></div>
          <div class="metric"><span>最高连板</span><b>{{ ov.components.maxStreak != null ? ov.components.maxStreak + ' 板' : '—' }}</b></div>
          <div class="metric"><span>炸板率</span><b>{{ ov.components.brokenRate != null ? ov.components.brokenRate.toFixed(1) + '%' : '—' }}</b></div>
          <div class="metric"><span>活跃度</span><b>{{ ov.components.activity != null ? ov.components.activity + '%' : '—' }}</b></div>
          <div class="metric"><span>停牌</span><b>{{ ov.components.suspended ?? '—' }}</b></div>
        </div>
        <el-alert
          v-if="ov.stale"
          type="warning"
          :closable="false"
          show-icon
          title="部分数据源降级，情绪指数为不完整估计（请到数据源页检查 AKShare 配置）。"
          style="margin-top: 12px"
        />
        <div class="note">{{ ov.note }}</div>
      </el-card>

      <!-- 历史趋势 -->
      <el-card shadow="never" class="hist-card">
        <div class="card-title">情绪指数历史（近 {{ history.length }} 个交易日）</div>
        <el-table v-if="history.length" :data="history" size="small" stripe>
          <el-table-column prop="tradeDate" label="交易日" width="120" />
          <el-table-column label="情绪指数" width="160">
            <template #default="{ row }">
              <el-progress
                :percentage="row.index"
                :stroke-width="10"
                :color="row.index >= 80 ? '#f56c6c' : row.index >= 60 ? '#e6a23c' : row.index >= 40 ? '#409eff' : '#909399'"
              />
            </template>
          </el-table-column>
          <el-table-column label="水位" width="100">
            <template #default="{ row }">
              <el-tag :type="LEVEL_TAG[row.level as SentimentLevel]" size="small">{{ row.level }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="周期">
            <template #default="{ row }">
              <el-tag :type="PHASE_TAG[row.phase as SentimentPhase]" size="small" effect="plain">{{ row.phase }}</el-tag>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="暂无历史快照（收盘定时或每次打开本页会累积，明日起可对比方向）" />
      </el-card>
    </template>
  </div>
</template>

<style scoped>
.sentiment-panel {
  padding-top: 4px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  gap: 12px;
}
.panel-tip {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.grid {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 16px;
  margin-bottom: 16px;
}
@media (max-width: 800px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
.gauge-card {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.gauge-card :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: 100%;
}
.gauge-inner {
  text-align: center;
}
.gauge-num {
  font-size: 42px;
  font-weight: 700;
  line-height: 1;
}
.gauge-unit {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
.tags {
  display: flex;
  gap: 8px;
}
.delta {
  font-size: 14px;
  font-weight: 600;
}
.delta.up {
  color: #f56c6c;
}
.delta.down {
  color: #67c23a;
}
.delta.flat {
  color: var(--el-text-color-secondary);
}
.as-of {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.card-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 10px;
}
.advice {
  line-height: 1.7;
  font-size: 14px;
  color: var(--el-text-color-primary);
  background: var(--el-fill-color-light);
  border-radius: 6px;
  padding: 12px;
}
.breakdown {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bd-row {
  display: grid;
  grid-template-columns: 130px 1fr 44px;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.bd-label {
  color: var(--el-text-color-regular);
}
.bd-val {
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}
.raw-card {
  margin-bottom: 16px;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 10px;
}
.metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  padding: 10px;
}
.metric span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.metric b {
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.metric b.up {
  color: #f56c6c;
}
.metric b.down {
  color: #67c23a;
}
.note {
  margin-top: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
