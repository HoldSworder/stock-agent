<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import type { UsMappingOverview, UsSectorEtf } from '@stock-agent/shared';

// 美股映射底稿：隔夜美股行业/主题 ETF 全集自动排名 → A股概念·ETF 桥接，盘前情绪/方向背景，10 分钟 TTL。
const { data: m, loading, refreshing, load, reload } = useCachedResource<UsMappingOverview>(
  'market:usmapping',
  () => api.getUsMapping(),
  { ttlMs: 600_000 },
);

const dir = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const signed = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';

// 领涨（pct>0，降序）与领跌（pct<0，升序，最弱在前）
const gainers = computed<UsSectorEtf[]>(() => (m.value?.sectors ?? []).filter((s) => s.pct > 0));
const losers = computed<UsSectorEtf[]>(() =>
  (m.value?.sectors ?? []).filter((s) => s.pct < 0).slice().reverse(),
);

async function refresh() {
  try {
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="usmap">
    <div class="usmap-head">
      <span class="usmap-tip">美股映射底稿 · 隔夜美股行业/主题 ETF 排名 → A股概念·ETF 桥接 · 盘前情绪/方向背景，非择时信号</span>
      <el-button size="small" text :loading="loading || refreshing" @click="refresh">刷新</el-button>
    </div>

    <div v-if="m && m.sectors.length" class="cols">
      <div class="col">
        <div class="col-cap up">领涨</div>
        <div v-if="gainers.length" class="rows">
          <div v-for="e in gainers" :key="e.secid" class="row">
            <span class="etf-name">{{ e.name }}</span>
            <span class="num row-pct" :class="dir(e.pct)">{{ signed(e.pct) }}</span>
            <span class="theme-tag">{{ e.theme }}</span>
            <span class="a-bridge">
              <span class="a-concept">{{ e.aConcept }}</span>
              <span v-for="a in e.aEtfs" :key="a.code" class="a-etf">{{ a.name }}<small>{{ a.code }}</small></span>
            </span>
          </div>
        </div>
        <div v-else class="col-empty">无</div>
      </div>

      <div class="col">
        <div class="col-cap down">领跌</div>
        <div v-if="losers.length" class="rows">
          <div v-for="e in losers" :key="e.secid" class="row">
            <span class="etf-name">{{ e.name }}</span>
            <span class="num row-pct" :class="dir(e.pct)">{{ signed(e.pct) }}</span>
            <span class="theme-tag">{{ e.theme }}</span>
            <span class="a-bridge">
              <span class="a-concept">{{ e.aConcept }}</span>
              <span v-for="a in e.aEtfs" :key="a.code" class="a-etf">{{ a.name }}<small>{{ a.code }}</small></span>
            </span>
          </div>
        </div>
        <div v-else class="col-empty">无</div>
      </div>
    </div>

    <div v-if="m && m.sectors.length" class="usmap-foot">{{ m.note }}</div>

    <el-empty v-else-if="!loading" :image-size="60" description="暂无美股映射数据（数据源未连通）" />
  </div>
</template>

<style scoped>
.usmap {
  margin-top: 4px;
}
.usmap-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.usmap-tip {
  font-size: 12px;
  color: var(--text-2);
}
.cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 14px;
}
.col {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
}
.col-cap {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
}
.col-cap.up {
  color: var(--up, #e5484d);
}
.col-cap.down {
  color: var(--down, #30a46c);
}
.rows {
  display: flex;
  flex-direction: column;
}
.row {
  display: grid;
  grid-template-columns: minmax(110px, 1.2fr) 64px auto 1fr;
  gap: 8px;
  align-items: baseline;
  padding: 5px 0;
  border-top: 1px dashed var(--border);
  font-size: 13px;
}
.row:first-child {
  border-top: none;
}
.etf-name {
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-pct {
  text-align: right;
  font-weight: 600;
}
.theme-tag {
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-1);
  border-radius: 5px;
  padding: 1px 6px;
  white-space: nowrap;
}
.a-bridge {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  align-items: baseline;
}
.a-concept {
  font-size: 12px;
  color: var(--text-1);
}
.a-etf {
  font-size: 11px;
  background: var(--bg-1);
  border-radius: 5px;
  padding: 1px 6px;
}
.a-etf small {
  margin-left: 3px;
  color: var(--text-2);
  font-size: 10px;
}
.col-empty {
  font-size: 13px;
  color: var(--text-2);
  padding: 6px 0;
}
.usmap-foot {
  margin-top: 14px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  padding: 10px 12px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
</style>
