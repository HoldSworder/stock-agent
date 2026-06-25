<script setup lang="ts">
import { computed, onMounted } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import StockLink from '@/components/StockLink.vue';
import type {
  MainlineConsensus,
  MainlineConsensusItem,
  MainlineConsensusLevel,
  TrendState,
} from '@stock-agent/shared';

// 今日主线共识（决策区）：以确定性「板块新高宽度」为锚，叠加「多源协同」与「中线趋势」三方对齐。
// 这是「行业中线 / 市场主线」Tab 的聚焦头：先给结论（哪些主线三方共振值得跟、哪些出现分歧需警惕），
// 三块明细（新高宽度 / 主线题材 / 中线强弱）默认折叠在下方，需要时再下钻。
const { data, loading, refreshing, load, reload } = useCachedResource<MainlineConsensus>(
  'breadth:consensus',
  () => api.breadth.consensus(),
  { ttlMs: 120_000 },
);

const items = computed<MainlineConsensusItem[]>(() => data.value?.items ?? []);

const CONS_LABEL: Record<MainlineConsensusLevel, string> = {
  resonance: '三方共振',
  diverge: '出现分歧',
  watch: '观察',
};
const CONS_TAG: Record<MainlineConsensusLevel, 'danger' | 'warning' | 'info'> = {
  resonance: 'danger',
  diverge: 'warning',
  watch: 'info',
};

const VERDICT_LABEL = { confirmed: '确认', candidate: '候选', fading: '退潮', none: '—' } as const;
const TREND_LABEL: Record<TrendState, string> = {
  multi_long: '多头排列',
  up: '趋势向上',
  range: '震荡',
  down: '走弱',
};
const THEME_TREND_LABEL = { rising: '走强', flat: '走平', falling: '走弱' } as const;

function trendCls(t: TrendState | null): string {
  if (t === 'multi_long' || t === 'up') return 'up';
  if (t === 'down') return 'down';
  return '';
}

async function refresh() {
  try {
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

onMounted(() =>
  void load().catch((e) => ElMessage.error(e instanceof Error ? e.message : String(e))),
);
</script>

<template>
  <div class="consensus">
    <div class="c-head">
      <div class="c-title">
        今日主线共识
        <span v-if="data" class="as-of">更新 {{ dayjs(data.asOf).format('MM-DD HH:mm') }}</span>
      </div>
      <el-button :icon="Refresh" size="small" :loading="loading || refreshing" @click="refresh">
        刷新
      </el-button>
    </div>
    <div class="c-sub">
      三方对齐：<b>新高宽度</b>（确定性锚）+ <b>多源协同</b>（题材强度趋势）+ <b>中线趋势</b>（均线排列）。
      <el-tag size="small" type="danger" effect="plain">三方共振=值得跟</el-tag>
      <el-tag size="small" type="warning" effect="plain">分歧=有背离需警惕</el-tag>
      <el-tag size="small" type="info" effect="plain">观察=仅锚成立</el-tag>
      <span class="c-note">仅研判不下单，仅供参考</span>
    </div>

    <div v-if="items.length" class="c-grid">
      <div v-for="it in items" :key="it.board" class="c-card" :class="it.consensus">
        <div class="cc-head">
          <el-tag size="small" :type="CONS_TAG[it.consensus]" effect="dark">
            {{ CONS_LABEL[it.consensus] }}
          </el-tag>
          <span class="cc-board">{{ it.board }}</span>
          <StockLink
            v-if="it.etf"
            class="cc-etf"
            :code="it.etf.code"
            :name="it.etf.name"
          />
        </div>
        <div class="cc-metrics">
          <div class="m">
            <span class="m-cap">新高宽度</span>
            <span class="m-val" :class="{ strong: it.breadthVerdict === 'confirmed' }">
              {{ it.breadthVerdict ? VERDICT_LABEL[it.breadthVerdict] : '—' }}
              <small v-if="it.newHighCount != null">新高{{ it.newHighCount }}·居首{{ it.topDays }}日</small>
            </span>
          </div>
          <div class="m">
            <span class="m-cap">多源协同</span>
            <span class="m-val">
              <template v-if="it.themeStrength != null">
                {{ it.themeStrength }}
                <small v-if="it.themeTrend" :class="it.themeTrend === 'rising' ? 'up' : it.themeTrend === 'falling' ? 'down' : ''">
                  {{ THEME_TREND_LABEL[it.themeTrend] }}{{ it.themePhase ? '·' + it.themePhase : '' }}
                </small>
              </template>
              <span v-else class="muted">未入题材库</span>
            </span>
          </div>
          <div class="m">
            <span class="m-cap">中线趋势</span>
            <span class="m-val" :class="trendCls(it.radarTrend)">
              <template v-if="it.radarTrend">
                {{ TREND_LABEL[it.radarTrend] }}
                <small v-if="it.radarStrength != null">强度{{ it.radarStrength }}</small>
              </template>
              <span v-else class="muted">未入强弱榜</span>
            </span>
          </div>
        </div>
      </div>
    </div>

    <el-empty
      v-else-if="!loading"
      :image-size="80"
      description="暂无确认 / 候选主线（需启用「板块新高宽度」并有当日快照）"
    />
  </div>
</template>

<style scoped>
.consensus {
  margin-bottom: 12px;
}
.c-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.c-title {
  font-size: 16px;
  font-weight: 700;
}
.as-of {
  margin-left: 10px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-2);
  font-family: var(--font-mono);
}
.c-sub {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.8;
  margin-bottom: 12px;
}
.c-sub b {
  color: var(--text-1);
}
.c-sub .el-tag {
  margin: 0 2px;
}
.c-note {
  margin-left: 6px;
}
.c-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.c-card {
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--bg-2, rgba(255, 255, 255, 0.02));
}
.c-card.resonance {
  border-color: var(--danger, #f56c6c);
  box-shadow: inset 3px 0 0 var(--danger, #f56c6c);
}
.c-card.diverge {
  box-shadow: inset 3px 0 0 var(--warning, #e6a23c);
}
.cc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.cc-board {
  font-size: 15px;
  font-weight: 600;
}
.cc-etf {
  margin-left: auto;
  font-size: 12px;
}
.cc-metrics {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.m {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.m-cap {
  font-size: 12px;
  color: var(--text-2);
  flex: 0 0 auto;
}
.m-val {
  font-size: 13px;
  text-align: right;
}
.m-val.strong {
  font-weight: 700;
}
.m-val small {
  margin-left: 4px;
  font-size: 11px;
  color: var(--text-2);
}
.m-val small.up,
.m-val.up {
  color: var(--danger, #f56c6c);
}
.m-val small.down,
.m-val.down {
  color: var(--success, #67c23a);
}
.muted {
  color: var(--text-3, var(--text-2));
  font-size: 12px;
}
</style>
