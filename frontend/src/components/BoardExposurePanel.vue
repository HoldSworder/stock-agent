<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import StockLink from '@/components/StockLink.vue';
import { EXPO_STATUS_LABEL, EXPO_STATUS_TYPE } from '@/constants/boardTags';
import type { BoardExposure, BoardExposureHolding } from '@stock-agent/shared';

// 持仓 / 自选 板块暴露（懒相交）：反查我的标的是否处于主线 / 退潮 / 拥挤。
// 无主线关联的标的不展示（后端已过滤），无命中时整块隐藏，避免噪声。
const { data, load } = useCachedResource<BoardExposure>('boards:exposure', () => api.boards.exposure(), {
  ttlMs: 60_000,
});

const holdings = computed<BoardExposureHolding[]>(() => data.value?.holdings ?? []);

onMounted(() =>
  void load().catch((e) => ElMessage.error(e instanceof Error ? e.message : String(e))),
);
</script>

<template>
  <div v-if="holdings.length" class="expo">
    <div class="expo-title">
      持仓 / 自选板块暴露
      <span class="muted">主线板块成分 ∩ 我的标的 · 仅研判</span>
    </div>
    <div class="expo-list">
      <div v-for="h in holdings" :key="`${h.account}:${h.code}`" class="expo-row">
        <el-tag size="small" :type="EXPO_STATUS_TYPE[h.status]" effect="plain">{{ EXPO_STATUS_LABEL[h.status] }}</el-tag>
        <StockLink :code="h.code" :name="h.name" class="expo-code" />
        <span class="expo-boards">{{ h.boards.map((x) => x.boardName).join('、') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.expo {
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
  padding: 10px 14px;
  margin-bottom: 12px;
  background: var(--bg-2, rgba(255, 255, 255, 0.02));
}
.expo-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 8px;
}
.muted {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-2);
}
.expo-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.expo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.expo-boards {
  font-size: 12px;
  color: var(--text-2);
}
</style>
