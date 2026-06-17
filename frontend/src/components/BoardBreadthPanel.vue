<script setup lang="ts">
import { computed, onMounted } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import type { BoardBreadthItem, BoardBreadthOverview, BoardBreadthVerdict } from '@stock-agent/shared';

// 板块新高宽度（主线识别）：各概念/行业板块内创新高个股数横向排名，
// 「新高数最多且持续多日稳居榜首」判定主线。确定性只读，零量化术语。

// SWR 缓存（120s，慢变）：重进/切 Tab 瞬显；后端逐板块取成分较重，已做 30min 响应缓存
const { data, loading, refreshing, load, reload } = useCachedResource<BoardBreadthOverview>(
  'breadth:overview',
  () => api.breadth.overview(),
  { ttlMs: 120_000 },
);

const ov = computed(() => data.value ?? null);
const mainlines = computed(() => ov.value?.mainlines ?? []);
const items = computed(() => ov.value?.items ?? []);

const VERDICT_META: Record<BoardBreadthVerdict, { label: string; type: 'danger' | 'success' | 'warning' | 'info' }> = {
  confirmed: { label: '确认主线', type: 'danger' },
  candidate: { label: '候选主线', type: 'warning' },
  fading: { label: '退潮', type: 'info' },
  none: { label: '未达标', type: 'info' },
};

const KIND_LABEL: Record<BoardBreadthItem['kind'], string> = { industry: '行业', concept: '概念' };

// 新高数热度分级（用于排名条强弱着色）
const heat = (v: number) => (v >= 15 ? 'hot' : v >= 10 ? 'mid' : 'low');
const deltaText = (d: number | null) => (d == null ? '—' : d > 0 ? `+${d}` : String(d));
const deltaClass = (d: number | null) => (d == null ? 'flat' : d > 0 ? 'up' : d < 0 ? 'down' : 'flat');

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
  <div class="panel-block" v-loading="loading">
    <div class="block-head">
      <div class="block-title">
        板块新高宽度 · 主线识别
        <span v-if="ov" class="sub">（{{ ov.window }}口径 · 全市场新高 {{ ov.marketNewHighTotal }} 只）</span>
      </div>
      <el-button :icon="Refresh" size="small" :loading="loading || refreshing" @click="refresh">刷新</el-button>
    </div>
    <div class="block-sub">
      统计每个概念/行业板块内创新高个股数并横向排名，「新高数最多且持续多日稳居榜首」判定主线（确定性只读，仅研判不下单）。
    </div>

    <template v-if="ov">
      <!-- 当前确认主线 -->
      <div class="mainline-row">
        <span class="ml-label">当前主线：</span>
        <template v-if="mainlines.length">
          <el-tag
            v-for="m in mainlines"
            :key="m.boardCode"
            type="danger"
            effect="dark"
            size="large"
            class="ml-tag"
          >
            {{ m.boardName }}（新高 {{ m.newHighCount }} 只·居首 {{ m.topDays }} 日）
            <span v-if="m.etf" class="ml-etf">→ {{ m.etf.name }} {{ m.etf.code }}</span>
          </el-tag>
        </template>
        <span v-else class="ml-empty">暂无确认主线（无板块稳居榜首足够天数，或市场处于冰点/普跌）</span>
      </div>

      <!-- 板块新高榜 -->
      <el-table :data="items" stripe size="small" style="width: 100%">
        <el-table-column label="#" width="48" align="center">
          <template #default="{ row }"><span class="num sub">{{ row.rank }}</span></template>
        </el-table-column>
        <el-table-column label="板块" min-width="150">
          <template #default="{ row }">
            <span class="board-name">{{ row.boardName }}</span>
            <el-tag size="small" effect="plain" class="kind-tag">{{ KIND_LABEL[row.kind as BoardBreadthItem['kind']] }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对应 ETF" min-width="130">
          <template #default="{ row }">
            <span v-if="row.etf" class="etf">{{ row.etf.name }} <span class="num sub">{{ row.etf.code }}</span></span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="新高数" width="120" align="right">
          <template #default="{ row }">
            <b class="num" :class="heat(row.newHighCount)">{{ row.newHighCount }}</b>
            <span class="num sub"> / {{ row.consTotal }}</span>
          </template>
        </el-table-column>
        <el-table-column label="占比" width="80" align="right">
          <template #default="{ row }">
            <span class="num">{{ row.ratio == null ? '—' : row.ratio.toFixed(1) + '%' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="较昨" width="70" align="right">
          <template #default="{ row }">
            <span class="num" :class="deltaClass(row.delta)">{{ deltaText(row.delta) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="居首/连续" width="100" align="center">
          <template #default="{ row }">
            <span class="num sub">{{ row.topDays }} / {{ row.streakDays }} 日</span>
          </template>
        </el-table-column>
        <el-table-column label="判定" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="VERDICT_META[row.verdict as BoardBreadthVerdict].type" size="small" :effect="row.verdict === 'confirmed' ? 'dark' : 'plain'">
              {{ VERDICT_META[row.verdict as BoardBreadthVerdict].label }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!items.length" description="暂无板块新高数据（创新高/成分股取数降级，请到数据源页检查 AKShare 配置）" />

      <div class="note">
        {{ ov.note }}
        <span class="as-of">· 数据时间 {{ dayjs(ov.asOf).format('MM-DD HH:mm') }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.panel-block {
  margin-top: 12px;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.block-title {
  font-weight: 600;
  font-size: 15px;
}
.block-title .sub {
  font-weight: 400;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.block-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 10px;
}
.mainline-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.ml-label {
  font-weight: 600;
}
.ml-tag {
  margin-right: 4px;
}
.ml-etf {
  opacity: 0.85;
  margin-left: 4px;
}
.ml-empty {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.board-name {
  font-weight: 600;
}
.kind-tag {
  margin-left: 6px;
}
.etf {
  color: var(--el-text-color-primary);
}
.muted {
  color: var(--el-text-color-secondary);
}
.num {
  font-variant-numeric: tabular-nums;
}
.num.sub {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.num.hot {
  color: #f56c6c;
}
.num.mid {
  color: #e6a23c;
}
.num.low {
  color: var(--el-text-color-regular);
}
.up {
  color: #f56c6c;
}
.down {
  color: #4eb61b;
}
.flat {
  color: var(--el-text-color-secondary);
}
.note {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 10px;
  line-height: 1.5;
}
.as-of {
  white-space: nowrap;
}
</style>
