<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { MagicStick } from '@element-plus/icons-vue';
import AiAnalysisDialog from '@/components/AiAnalysisDialog.vue';
import PositionsView from './PositionsView.vue';
import WatchlistView from './WatchlistView.vue';

// 模块级统一 AI 入口：真实持仓研判（kind=real-positions），与各大模块页头入口一致。
const dialogOpen = ref(false);

// 账户二合一：真实持仓（含场外基金）+ 自选分组。两页接口与持仓 AI 分析弹窗均不变；
// Watch 监控池 / Plan 来源 / Market 我的标的仍读同源 listWatchlist / getRealPositions。
const VALID_TABS = ['positions', 'watchlist'] as const;
type AccountTab = (typeof VALID_TABS)[number];
function normalizeTab(v: unknown): AccountTab {
  return VALID_TABS.includes(v as AccountTab) ? (v as AccountTab) : 'positions';
}

const route = useRoute();
const router = useRouter();
const tab = ref<AccountTab>(normalizeTab(route.query.tab));
watch(
  () => route.query.tab,
  (v) => {
    tab.value = normalizeTab(v);
  },
);
watch(tab, (v) => {
  if (route.query.tab !== v) router.replace({ query: { ...route.query, tab: v } });
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">持仓与自选</div>
      <div class="head-actions">
        <el-button :icon="MagicStick" type="primary" @click="dialogOpen = true">AI 分析</el-button>
      </div>
    </div>
    <div class="page-sub">
      真实持仓（股票 + 场外基金）与自选分组集中管理；监控池 / 今日计划读取同源数据。
    </div>

    <el-tabs v-model="tab" class="account-tabs">
      <el-tab-pane label="真实持仓" name="positions" lazy>
        <PositionsView embedded />
      </el-tab-pane>
      <el-tab-pane label="自选分组" name="watchlist" lazy>
        <WatchlistView embedded />
      </el-tab-pane>
    </el-tabs>

    <AiAnalysisDialog v-model="dialogOpen" kind="real-positions" title="实时持仓分析" />
  </div>
</template>

<style scoped>
.account-tabs {
  margin-top: 4px;
}
</style>
