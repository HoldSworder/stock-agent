<script setup lang="ts">
import { QuestionFilled } from '@element-plus/icons-vue';

// 统一「强度/指数」口径标注：各页都有「强度」但口径不同（多源协同度 / 轮动强度 / 中线趋势强度 / 情绪指数），
// 量程虽同为 0–100 却不可横向直接比较。此组件给一致的 ⓘ 提示，消除非量化用户的跨页误读（§12.2）。
const props = defineProps<{
  /** 口径名称，如「多源协同度」「轮动强度」 */
  name: string;
  /** 量程，缺省 0–100 */
  range?: string;
  /** 附加一句口径说明（可空） */
  note?: string;
}>();

const text = () =>
  `口径：${props.name}（量程 ${props.range ?? '0–100'}）。各页「强度」口径不同，不可横向直接比较。${
    props.note ? ' ' + props.note : ''
  }`;
</script>

<template>
  <el-tooltip :content="text()" placement="top" effect="dark">
    <el-icon class="metric-scale-hint"><QuestionFilled /></el-icon>
  </el-tooltip>
</template>

<style scoped>
.metric-scale-hint {
  font-size: 12px;
  vertical-align: -1px;
  margin-left: 3px;
  color: var(--text-2);
  cursor: help;
}
</style>
