<script setup lang="ts">
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import { useKlineStore } from '@/stores/kline';
import type { IndexFundFlow, IndexFundFlowResult } from '@stock-agent/shared';

// 股指主力资金流趋势面板（大盘页常驻）：7 个主要股指近 N 日主力净流入（亿）。
// 每行展示指数名 + 今日主力净流入 + 近 N 日迷你柱状图（正红负绿），点击整行开 K 线。
// 确定性只读展示，红涨绿跌，仅供参考不构成投资建议。

const kline = useKlineStore();

// SWR 缓存（120s，慢变）：与 3s 大盘轮询解耦，重进页面瞬显、过期后台静默刷新。
const { data, loading, refreshing, load, reload } = useCachedResource<IndexFundFlowResult>(
  'market:indexFundFlow',
  () => api.getIndexFundFlow(),
  { ttlMs: 120_000 },
);

const items = computed(() => (data.value?.items ?? []).filter((it) => it.days.length > 0));

// A股 红涨绿跌
const flowDir = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const flowText = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}亿`;

/** 今日（序列最后一天）主力净流入 */
const today = (it: IndexFundFlow) => it.days[it.days.length - 1];

// ===== 近 N 日主力净流入迷你柱状图（SVG，正红负绿，按组内最大绝对值缩放）=====
const BAR_W = 108;
const BAR_H = 30;
const GAP = 2;

interface Bar {
  x: number;
  y: number;
  w: number;
  h: number;
  cls: string;
}

/** 生成柱状图几何：零轴居中，正向上（红）、负向下（绿） */
function bars(it: IndexFundFlow): { bars: Bar[]; mid: number } {
  const vals = it.days.map((d) => d.main);
  const maxAbs = Math.max(...vals.map((v) => Math.abs(v)), 1e-6);
  const n = vals.length;
  const bw = Math.max(1, (BAR_W - GAP * (n - 1)) / n);
  const mid = BAR_H / 2;
  const half = BAR_H / 2 - 1;
  const out: Bar[] = vals.map((v, i) => {
    const h = (Math.abs(v) / maxAbs) * half;
    const x = i * (bw + GAP);
    return {
      x,
      w: bw,
      h: Math.max(0.5, h),
      y: v >= 0 ? mid - h : mid,
      cls: v > 0 ? 'up' : v < 0 ? 'down' : 'flat',
    };
  });
  return { bars: out, mid };
}

/** 预派生行数据：柱状图几何只算一次，避免模板里同行多次调用 bars() 重复遍历全部日数据 */
const rows = computed(() =>
  items.value.map((it) => ({
    item: it,
    today: today(it),
    ...bars(it),
  })),
);

async function refresh() {
  try {
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

void load().catch((e) => ElMessage.error(e instanceof Error ? e.message : String(e)));
</script>

<template>
  <div v-loading="loading" class="idx-flow">
    <div class="block-head">
      <div class="block-title">
        股指主力资金流
        <span class="sub">近 {{ items[0]?.days.length ?? 0 }} 日主力净流入(亿) · 确定性只读，仅供参考</span>
      </div>
      <el-button :icon="Refresh" :loading="refreshing" circle size="small" @click="refresh" />
    </div>

    <div v-if="rows.length" class="flow-grid">
      <div
        v-for="r in rows"
        :key="r.item.secid"
        class="flow-row"
        role="button"
        tabindex="0"
        @click="kline.open(r.item.code, r.item.name, r.item.secid)"
        @keydown.enter="kline.open(r.item.code, r.item.name, r.item.secid)"
      >
        <div class="flow-name">{{ r.item.name }}</div>
        <div class="flow-today num" :class="flowDir(r.today.main)">
          {{ flowText(r.today.main) }}
        </div>
        <svg class="flow-bars" :viewBox="`0 0 ${BAR_W} ${BAR_H}`" :width="BAR_W" :height="BAR_H">
          <line class="axis" :x1="0" :y1="r.mid" :x2="BAR_W" :y2="r.mid" />
          <rect
            v-for="(b, i) in r.bars"
            :key="i"
            :x="b.x"
            :y="b.y"
            :width="b.w"
            :height="b.h"
            class="bar"
            :class="b.cls"
          />
        </svg>
      </div>
    </div>
    <el-empty v-else-if="!loading" :image-size="50" description="暂无股指资金流数据" />
  </div>
</template>

<style scoped>
.idx-flow {
  min-height: 80px;
  margin-bottom: 12px;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.block-title {
  font-weight: 600;
  font-size: 14px;
}
.block-title .sub {
  font-weight: 400;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-left: 8px;
}
.flow-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
}
.flow-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.15s;
}
.flow-row:hover {
  background-color: var(--el-fill-color-light);
}
.flow-name {
  flex: 0 0 auto;
  width: 62px;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.flow-today {
  flex: 1;
  text-align: right;
  font-size: 13px;
  font-weight: 600;
}
.flow-bars {
  flex: 0 0 auto;
}
.num.up,
.bar.up {
  color: var(--el-color-danger);
}
.num.down,
.bar.down {
  color: var(--el-color-success);
}
.num.flat {
  color: var(--el-text-color-secondary);
}
.bar {
  fill: currentColor;
}
.bar.up {
  fill: var(--el-color-danger);
}
.bar.down {
  fill: var(--el-color-success);
}
.bar.flat {
  fill: var(--el-text-color-secondary);
}
.axis {
  stroke: var(--el-border-color);
  stroke-width: 0.5;
}
</style>
