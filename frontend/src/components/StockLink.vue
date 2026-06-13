<script setup lang="ts">
import { useKlineStore } from '@/stores/kline';

const props = defineProps<{
  code: string;
  name?: string;
  /** 展示内容：默认展示 name（无则 code）；设为 'code' 则展示代码 */
  show?: 'name' | 'code';
  /** 大盘指数须显式 secid（code 与个股撞码）；个股/板块留空 */
  secid?: string;
}>();

const store = useKlineStore();

// 有 secid（指数）或 code 为个股 6 位 / 板块 BKxxxx 才可点
const valid = () => !!props.secid || /^(\d{6}|BK\d+)$/i.test(props.code);
const text = () => (props.show === 'code' ? props.code : props.name || props.code);

function onClick() {
  if (valid()) store.open(props.code, props.name, props.secid);
}
</script>

<template>
  <span
    v-if="valid()"
    class="stock-link"
    role="button"
    tabindex="0"
    @click="onClick"
    @keydown.enter="onClick"
    >{{ text() }}</span
  >
  <span v-else>{{ text() }}</span>
</template>

<style scoped>
.stock-link {
  cursor: pointer;
  border-bottom: 1px dashed transparent;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.stock-link:hover {
  color: var(--brand);
  border-bottom-color: var(--brand);
}
</style>
