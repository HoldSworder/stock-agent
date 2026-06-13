<script setup lang="ts">
import * as echarts from 'echarts';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

// 轻量 echarts 包装：负责 init / setOption / 自适应尺寸 / 销毁。
const props = defineProps<{ option: echarts.EChartsCoreOption; height?: string }>();

const el = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;
let ro: ResizeObserver | null = null;

function render() {
  if (!chart) return;
  // 数据集变化时清空旧 series，避免残留
  chart.setOption(props.option, true);
}

onMounted(() => {
  if (!el.value) return;
  chart = echarts.init(el.value, undefined, { renderer: 'canvas' });
  render();
  ro = new ResizeObserver(() => chart?.resize());
  ro.observe(el.value);
});

watch(() => props.option, render, { deep: true });

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div ref="el" class="echart" :style="{ height: height ?? '280px' }" />
</template>

<style scoped>
.echart {
  width: 100%;
}
</style>
