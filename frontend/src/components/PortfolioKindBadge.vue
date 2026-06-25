<script setup lang="ts">
import { computed } from 'vue';

// 统一持仓视图徽标（§12.2）：系统里并存三套「持仓」语义，非量化用户易混淆「这是我真买的，还是系统假设的」。
// 在各持仓视图顶部用一致徽标 + tooltip 明确标明：真实账户 / 模拟盘 / 信号建议。
const props = defineProps<{ kind: 'real' | 'sim' | 'signal' }>();

const META: Record<
  'real' | 'sim' | 'signal',
  { label: string; type: 'danger' | 'warning' | 'info'; tip: string }
> = {
  real: { label: '真实账户', type: 'danger', tip: '同花顺真实持仓 · 真金白银，盈亏为实际' },
  sim: { label: '模拟盘', type: 'warning', tip: '本地虚拟账户 · 仅记录在本系统，不下真实/妙想单' },
  signal: { label: '信号建议', type: 'info', tip: '系统建议持仓层 · 仅研判信号，非真实/模拟成交' },
};

const meta = computed(() => META[props.kind]);
</script>

<template>
  <el-tooltip :content="meta.tip" placement="top" effect="dark">
    <el-tag :type="meta.type" size="small" effect="dark" class="pf-kind-badge">
      {{ meta.label }}
    </el-tag>
  </el-tooltip>
</template>

<style scoped>
.pf-kind-badge {
  cursor: help;
  letter-spacing: 0.5px;
}
</style>
