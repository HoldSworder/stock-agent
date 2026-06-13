<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import type { EChartsCoreOption } from 'echarts';
import { api } from '@/api';
import EChart from '@/components/EChart.vue';
import {
  USAGE_PURPOSE_LABELS,
  type LlmCallRecord,
  type UsagePurpose,
  type UsageSummary,
} from '@stock-agent/shared';

// 主题色（与 style.css 保持一致）
const C = {
  brand: '#f0b429',
  prompt: '#3b82f6',
  completion: '#f0b429',
  axis: '#788694',
  split: 'rgba(120,134,148,0.15)',
  palette: ['#f0b429', '#3b82f6', '#1fc77f', '#f6465d', '#a78bfa', '#22d3ee', '#fb923c', '#e879f9', '#94a3b8', '#34d399'],
};

const days = ref(30);
const summary = ref<UsageSummary | null>(null);
const calls = ref<LlmCallRecord[]>([]);
const purposeFilter = ref<string>('');
const loading = ref(false);

function purposeLabel(p: string): string {
  return USAGE_PURPOSE_LABELS[p as UsagePurpose] ?? p;
}

const fmt = (n: number) => n.toLocaleString('en-US');

async function load() {
  loading.value = true;
  try {
    const [s, c] = await Promise.all([
      api.usage.summary(days.value),
      api.usage.calls(200, purposeFilter.value || undefined),
    ]);
    summary.value = s;
    calls.value = c;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function reloadCalls() {
  try {
    calls.value = await api.usage.calls(200, purposeFilter.value || undefined);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

onMounted(load);

const totals = computed(() => summary.value?.totals ?? null);

// 用途筛选可选项（取总览中出现过的用途）
const purposeOptions = computed(() =>
  (summary.value?.byPurpose ?? []).map((p) => ({ value: p.purpose, label: purposeLabel(p.purpose) })),
);

// 每日趋势：prompt / completion 堆叠面积
const dailyOption = computed<EChartsCoreOption>(() => {
  const d = summary.value?.daily ?? [];
  return {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    legend: { data: ['输入 token', '输出 token'], textStyle: { color: C.axis }, top: 0 },
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: d.map((x) => x.date.slice(5)),
      axisLine: { lineStyle: { color: C.split } },
      axisLabel: { color: C.axis },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: C.split } },
      axisLabel: { color: C.axis },
    },
    series: [
      {
        name: '输入 token',
        type: 'line',
        stack: 'tok',
        areaStyle: { opacity: 0.18 },
        smooth: true,
        showSymbol: false,
        lineStyle: { color: C.prompt },
        itemStyle: { color: C.prompt },
        data: d.map((x) => x.promptTokens),
      },
      {
        name: '输出 token',
        type: 'line',
        stack: 'tok',
        areaStyle: { opacity: 0.18 },
        smooth: true,
        showSymbol: false,
        lineStyle: { color: C.completion },
        itemStyle: { color: C.completion },
        data: d.map((x) => x.completionTokens),
      },
    ],
  };
});

// 按用途：横向条形（总 token）
const purposeOption = computed<EChartsCoreOption>(() => {
  const rows = [...(summary.value?.byPurpose ?? [])].sort((a, b) => a.totalTokens - b.totalTokens);
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = params as { name: string; value: number; dataIndex: number }[];
        const p = arr[0];
        const row = rows[p.dataIndex];
        return `${p.name}<br/>总 token：${fmt(p.value)}<br/>调用：${row?.calls ?? 0} 次`;
      },
    },
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    xAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: C.split } },
      axisLabel: { color: C.axis },
    },
    yAxis: {
      type: 'category',
      data: rows.map((r) => purposeLabel(r.purpose)),
      axisLine: { lineStyle: { color: C.split } },
      axisLabel: { color: C.axis },
    },
    series: [
      {
        type: 'bar',
        data: rows.map((r, i) => ({
          value: r.totalTokens,
          itemStyle: { color: C.palette[i % C.palette.length], borderRadius: [0, 4, 4, 0] },
        })),
        barWidth: '60%',
      },
    ],
  };
});

// 按模型：环形
const modelOption = computed<EChartsCoreOption>(() => {
  const rows = summary.value?.byModel ?? [];
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      formatter: (p: unknown) => {
        const o = p as { name: string; value: number; percent: number };
        return `${o.name}<br/>总 token：${fmt(o.value)}（${o.percent}%）`;
      },
    },
    legend: { type: 'scroll', bottom: 0, textStyle: { color: C.axis } },
    series: [
      {
        type: 'pie',
        radius: ['42%', '68%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#11151c', borderWidth: 2 },
        label: { color: C.axis, formatter: '{b}' },
        data: rows.map((r, i) => ({
          name: r.model,
          value: r.totalTokens,
          itemStyle: { color: C.palette[i % C.palette.length] },
        })),
      },
    ],
  };
});

const hasData = computed(() => (summary.value?.totals.calls ?? 0) > 0);
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-head">
      <div class="page-title">调用记录</div>
      <div class="head-actions">
        <el-radio-group v-model="days" @change="load">
          <el-radio-button :value="7">近 7 天</el-radio-button>
          <el-radio-button :value="30">近 30 天</el-radio-button>
          <el-radio-button :value="90">近 90 天</el-radio-button>
        </el-radio-group>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </div>
    </div>
    <div class="page-sub">
      统计本系统内所有 LLM 调用与 token 消耗，按用途区分（对话 / 复盘 / 盯盘 / 研报 / 定时任务等）
    </div>

    <!-- 总览卡片 -->
    <div class="cards" v-if="totals">
      <div class="card">
        <div class="c-label">总调用次数</div>
        <div class="c-value">{{ fmt(totals.calls) }}</div>
      </div>
      <div class="card">
        <div class="c-label">总 token</div>
        <div class="c-value brand">{{ fmt(totals.totalTokens) }}</div>
      </div>
      <div class="card">
        <div class="c-label">输入 / 输出 token</div>
        <div class="c-value sm">
          <span class="prompt">{{ fmt(totals.promptTokens) }}</span>
          <span class="sep">/</span>
          <span class="completion">{{ fmt(totals.completionTokens) }}</span>
        </div>
      </div>
      <div class="card">
        <div class="c-label">成功率</div>
        <div class="c-value">
          {{ totals.successRate === null ? '—' : totals.successRate + '%' }}
        </div>
      </div>
    </div>

    <el-empty v-if="!hasData && !loading" description="统计窗口内暂无调用记录" />

    <template v-if="hasData">
      <!-- 图表区 -->
      <div class="chart-grid">
        <div class="panel span2">
          <div class="panel-title">每日 token 趋势</div>
          <EChart :option="dailyOption" height="300px" />
        </div>
        <div class="panel">
          <div class="panel-title">按用途消耗</div>
          <EChart :option="purposeOption" height="300px" />
        </div>
        <div class="panel">
          <div class="panel-title">按模型消耗</div>
          <EChart :option="modelOption" height="300px" />
        </div>
      </div>

      <!-- 明细表 -->
      <div class="panel">
        <div class="panel-title-row">
          <div class="panel-title">调用明细（最近 200 条）</div>
          <el-select
            v-model="purposeFilter"
            placeholder="全部用途"
            clearable
            size="small"
            style="width: 160px"
            @change="reloadCalls"
          >
            <el-option
              v-for="o in purposeOptions"
              :key="o.value"
              :label="o.label"
              :value="o.value"
            />
          </el-select>
        </div>
        <el-table :data="calls" size="small" stripe height="440">
          <el-table-column label="时间" width="160">
            <template #default="{ row }">
              {{ dayjs(row.createdAt).format('MM-DD HH:mm:ss') }}
            </template>
          </el-table-column>
          <el-table-column label="用途" width="110">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ purposeLabel(row.purpose) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="taskName" label="任务" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">{{ row.taskName || '—' }}</template>
          </el-table-column>
          <el-table-column prop="model" label="模型" min-width="140" show-overflow-tooltip />
          <el-table-column label="输入" width="90" align="right">
            <template #default="{ row }">{{ fmt(row.promptTokens) }}</template>
          </el-table-column>
          <el-table-column label="输出" width="90" align="right">
            <template #default="{ row }">{{ fmt(row.completionTokens) }}</template>
          </el-table-column>
          <el-table-column label="合计" width="100" align="right">
            <template #default="{ row }">
              <span class="brand">{{ fmt(row.totalTokens) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="耗时" width="90" align="right">
            <template #default="{ row }">{{ (row.latencyMs / 1000).toFixed(1) }}s</template>
          </el-table-column>
          <el-table-column label="状态" width="80" align="center">
            <template #default="{ row }">
              <el-tag :type="row.success ? 'success' : 'danger'" size="small" effect="dark">
                {{ row.success ? '成功' : '失败' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.page {
  padding: 22px 26px 40px;
}
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.page-title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.page-sub {
  margin-top: 4px;
  color: var(--text-2);
  font-size: 13px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-top: 18px;
}
.card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 14px 16px;
}
.c-label {
  color: var(--text-2);
  font-size: 12px;
}
.c-value {
  margin-top: 8px;
  font-family: var(--font-mono);
  font-size: 26px;
  font-weight: 700;
  color: var(--text-0);
}
.c-value.sm {
  font-size: 18px;
}
.c-value.brand,
.brand {
  color: var(--brand);
}
.c-value .prompt {
  color: #3b82f6;
}
.c-value .completion {
  color: var(--brand);
}
.c-value .sep {
  color: var(--text-2);
  margin: 0 6px;
}

.chart-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-top: 16px;
}
.panel {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 14px 16px;
  margin-top: 14px;
}
.chart-grid .panel {
  margin-top: 0;
}
.panel.span2 {
  grid-column: 1 / -1;
}
.panel-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-0);
  margin-bottom: 8px;
}
.panel-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
@media (max-width: 900px) {
  .cards {
    grid-template-columns: repeat(2, 1fr);
  }
  .chart-grid {
    grid-template-columns: 1fr;
  }
}
</style>
