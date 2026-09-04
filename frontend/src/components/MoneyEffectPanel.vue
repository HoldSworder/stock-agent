<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import * as echarts from 'echarts';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import EChart from '@/components/EChart.vue';
import type { MoneyEffectOverview } from '@stock-agent/shared';

// 首板赚钱效应面板（同花顺 883994·昨日打首板表现）：当前值 + 升温/退潮信号 + 关键读数 + 近 60 日趋势(叠 MA5)。
// 信号口径与影子战法一致：站上 MA5 且 MA5 向上 → 升温(满)，否则退潮(空)。确定性只读，仅供参考。

// SWR 缓存 120s：与后端 GET 响应级缓存对齐，切 Tab / 重进瞬显
const { data, loading, refreshing, load, reload } = useCachedResource<MoneyEffectOverview>(
  'moneyeffect:panel',
  () => api.moneyEffect.overview(),
  { ttlMs: 120_000 },
);
const ov = computed(() => data.value ?? null);

/** 取数失败原因（空串=正常）：显式呈现，避免与「后端确实没有数据」混淆成同一个空态 */
const loadError = ref('');

function toMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function refresh(): Promise<void> {
  loadError.value = '';
  try {
    await reload();
  } catch (e) {
    loadError.value = toMsg(e);
    ElMessage.error(toMsg(e));
  }
}

onMounted(() => {
  void load().catch((e) => {
    loadError.value = toMsg(e);
    ElMessage.error(toMsg(e));
  });
});

/** 升温=暖色警示、退潮=冷色 */
const signalTag = computed<'warning' | 'info'>(() => (ov.value?.signal === '升温' ? 'warning' : 'info'));

const deltaText = computed(() => {
  const d = ov.value?.delta;
  if (d == null) return '—';
  return `${d >= 0 ? '+' : ''}${d}%`;
});

/** 近 60 日收盘折线 + MA5 叠加（MA5 客户端滚动计算，缺不足按已有均值） */
const chartOption = computed<echarts.EChartsCoreOption>(() => {
  const s = ov.value?.series ?? [];
  const dates = s.map((p) => p.date.slice(5)); // MM-DD
  const closes = s.map((p) => p.close);
  const ma5: (number | null)[] = closes.map((_, i) => {
    if (i < 4) return null;
    const win = closes.slice(i - 4, i + 1);
    return Math.round((win.reduce((a, b) => a + b, 0) / 5) * 100) / 100;
  });
  return {
    grid: { top: 16, right: 12, bottom: 24, left: 44 },
    tooltip: { trigger: 'axis' },
    legend: { data: ['883994', 'MA5'], right: 8, top: 0, textStyle: { fontSize: 11 } },
    xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 10, interval: Math.ceil(dates.length / 8) } },
    yAxis: { type: 'value', scale: true, axisLabel: { fontSize: 10 } },
    series: [
      { name: '883994', type: 'line', data: closes, showSymbol: false, smooth: true, lineStyle: { width: 2 }, color: '#e6a23c' },
      { name: 'MA5', type: 'line', data: ma5, showSymbol: false, smooth: true, lineStyle: { width: 1, type: 'dashed' }, color: '#909399' },
    ],
  };
});
</script>

<template>
  <el-card v-loading="loading" shadow="never" class="me-card">
    <template #header>
      <div class="me-head">
        <span class="me-title">首板赚钱效应 · 883994（昨日打首板表现）</span>
        <el-button :icon="Refresh" size="small" text :loading="refreshing" @click="refresh">刷新</el-button>
      </div>
    </template>

    <template v-if="ov">
      <div class="me-top">
        <div class="me-main">
          <span class="me-close num">{{ ov.close }}</span>
          <el-tag :type="signalTag" effect="dark" size="large">{{ ov.signal }}</el-tag>
          <span class="me-delta num" :class="(ov.delta ?? 0) >= 0 ? 'up' : 'down'">较昨 {{ deltaText }}</span>
        </div>
        <div class="me-reads">
          <span>MA5 <b class="num">{{ ov.ma5 }}</b></span>
          <span>MA10 <b class="num">{{ ov.ma10 }}</b></span>
          <span :class="ov.aboveMa5 ? 'up' : 'down'">{{ ov.aboveMa5 ? '站上MA5' : '跌破MA5' }}</span>
          <span :class="ov.ma5SlopeUp ? 'up' : 'down'">MA5{{ ov.ma5SlopeUp ? '向上' : '走平/向下' }}</span>
        </div>
      </div>

      <p class="me-hint">
        <b :class="ov.signal === '升温' ? 'warn' : 'flat'">{{ ov.signal }}</b>：{{
          ov.signal === '升温'
            ? '打板追涨赚钱效应转强、题材短线情绪回暖，短线可积极。'
            : '首板隔日溢价走弱、赚钱效应退潮，短线宜降频降仓、控制追高。'
        }}
      </p>

      <EChart :option="chartOption" height="240px" />

      <p class="me-note">{{ ov.note }}<span v-if="ov.stale"> ⚠️ 数据没取全</span></p>
    </template>
    <p v-else-if="loadError" class="me-fail">
      ⚠ 883994 取数失败：{{ loadError }}（数据未到，不是功能下线）
    </p>
    <el-empty v-else-if="!loading" description="暂无 883994 数据" :image-size="60" />
  </el-card>
</template>

<style scoped>
.me-card { margin-top: 12px; }
.me-fail { font-size: 12.5px; color: #e6a23c; line-height: 1.6; }
.me-head { display: flex; align-items: center; justify-content: space-between; }
.me-title { font-weight: 700; }
.me-top { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center; margin-bottom: 8px; }
.me-main { display: flex; align-items: center; gap: 12px; }
.me-close { font-size: 26px; font-weight: 700; }
.me-delta { font-size: 13px; }
.me-reads { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--el-text-color-regular); }
.me-hint { margin: 4px 0 8px; font-size: 13px; color: var(--el-text-color-regular); }
.me-note { margin: 8px 0 0; font-size: 11px; color: var(--el-text-color-placeholder); }
.num { font-variant-numeric: tabular-nums; }
.up { color: var(--el-color-danger); }
.down { color: var(--el-color-success); }
.warn { color: var(--el-color-warning); }
.flat { color: var(--el-text-color-secondary); }
</style>
