<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { MagicStick } from '@element-plus/icons-vue';
import AiAnalysisDialog from '@/components/AiAnalysisDialog.vue';
import IntelView from './IntelView.vue';
import ResearchView from './ResearchView.vue';
import ClsTelegraphView from './ClsTelegraphView.vue';

// 模块级统一 AI 入口：情报研判（kind=intel，合并研报机会 + 全网热点），与各大模块页头入口一致。
const dialogOpen = ref(false);

// 情报二合一：热点（TrendRadar 热榜/新闻/RSS + 热点 AI 研判）+ 研报（研报库/公告 + 研报机会 AI 研判）。
// 两者底层 kind（hotspot / research-opportunity）与各自定时原样保留，今日计划照常读六源。
const VALID_TABS = ['hotspot', 'research', 'cls'] as const;
type IntelTab = (typeof VALID_TABS)[number];
function normalizeTab(v: unknown): IntelTab {
  return VALID_TABS.includes(v as IntelTab) ? (v as IntelTab) : 'hotspot';
}

const route = useRoute();
const router = useRouter();
const tab = ref<IntelTab>(normalizeTab(route.query.tab));
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
      <div class="page-title">情报</div>
      <div class="head-actions">
        <el-button :icon="MagicStick" type="primary" @click="dialogOpen = true">AI 分析</el-button>
      </div>
    </div>
    <div class="page-sub">
      多平台热点情报与机构研报集中收口；AI 研判由本系统 LLM 现场生成，并回流今日计划。
    </div>

    <el-tabs v-model="tab" class="intel-hub-tabs">
      <el-tab-pane label="热点" name="hotspot" lazy>
        <IntelView embedded />
      </el-tab-pane>
      <el-tab-pane label="研报 / 公告" name="research" lazy>
        <ResearchView embedded />
      </el-tab-pane>
      <el-tab-pane label="财联社电报" name="cls" lazy>
        <ClsTelegraphView embedded />
      </el-tab-pane>
    </el-tabs>

    <AiAnalysisDialog v-model="dialogOpen" kind="intel" title="情报研判" />
  </div>
</template>

<style scoped>
.intel-hub-tabs {
  margin-top: 4px;
}
</style>
