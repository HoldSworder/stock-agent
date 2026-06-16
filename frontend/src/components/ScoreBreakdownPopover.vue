<script setup lang="ts">
import { computed } from 'vue';
import type { ScorePart } from '@stock-agent/shared';

const props = defineProps<{
  title: string;
  parts: ScorePart[];
  /** 合计分（一般等于各 part 之和裁剪后的结果） */
  total?: number | null;
  /** 触发方式，默认悬停 */
  trigger?: 'hover' | 'click';
  width?: number;
  /** 触发元素占满整行（用于包裹宽度条等块级内容） */
  block?: boolean;
}>();

// 各项贡献条按绝对值归一，便于横向比较正/负贡献
const maxAbs = computed(() =>
  Math.max(1, ...props.parts.map((p) => Math.abs(p.value))),
);
const barWidth = (v: number) => `${(Math.abs(v) / maxAbs.value) * 100}%`;
const signed = (v: number) => `${v >= 0 ? '+' : ''}${v}`;
</script>

<template>
  <el-popover :trigger="trigger ?? 'hover'" :width="width ?? 260" placement="top">
    <template #reference>
      <span class="trigger" :class="{ block }"><slot /></span>
    </template>
    <div class="bd">
      <div class="bd-title">{{ title }}</div>
      <div class="bd-rows">
        <div v-for="(p, i) in parts" :key="i" class="bd-row">
          <span class="bd-label">{{ p.label }}</span>
          <span class="bd-bar">
            <i :class="p.value >= 0 ? 'pos' : 'neg'" :style="{ width: barWidth(p.value) }" />
          </span>
          <span class="bd-val" :class="p.value >= 0 ? 'pos' : 'neg'">{{ signed(p.value) }}</span>
        </div>
      </div>
      <div v-if="total != null" class="bd-total">
        <span>合计</span>
        <span class="bd-total-num">{{ total }}</span>
      </div>
      <div v-if="$slots.extra" class="bd-extra"><slot name="extra" /></div>
    </div>
  </el-popover>
</template>

<style scoped>
.trigger {
  cursor: help;
}
.trigger.block {
  display: block;
}
.bd-title {
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 8px;
}
.bd-rows {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.bd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.bd-label {
  flex: 0 0 96px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bd-bar {
  flex: 1;
  height: 6px;
  background: var(--el-fill-color);
  border-radius: 3px;
  overflow: hidden;
}
.bd-bar i {
  display: block;
  height: 100%;
  border-radius: 3px;
}
.bd-bar i.pos {
  background: var(--el-color-danger);
}
.bd-bar i.neg {
  background: var(--el-color-success);
}
.bd-val {
  flex: 0 0 40px;
  text-align: right;
  font-family: var(--font-mono, monospace);
}
.bd-val.pos {
  color: var(--el-color-danger);
}
.bd-val.neg {
  color: var(--el-color-success);
}
.bd-total {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--el-border-color-lighter);
  font-size: 12.5px;
  font-weight: 600;
}
.bd-total-num {
  font-family: var(--font-mono, monospace);
}
.bd-extra {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--el-border-color-lighter);
  font-size: 11.5px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}
</style>
