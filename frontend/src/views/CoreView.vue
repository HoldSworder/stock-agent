<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ToolsPanel from '@/components/core/ToolsPanel.vue';
import PromptsPanel from '@/components/core/PromptsPanel.vue';
import SchedulesPanel from '@/components/core/SchedulesPanel.vue';
import DecisionAgentsPanel from '@/components/core/DecisionAgentsPanel.vue';
import UsageView from './UsageView.vue';

// 智能体中枢：把「约束 agent 的核心输入面」收拢为单页五 Tab ——
// 能调什么（工具）/ 怎么被指挥（提示词）/ 多 agent 角色（智能体）/ 谁来唤起（调度）/ 调用记录。
const VALID_TABS = ['tools', 'prompts', 'agents', 'schedules', 'usage'] as const;
type CoreTab = (typeof VALID_TABS)[number];
function normalizeTab(v: unknown): CoreTab {
  return VALID_TABS.includes(v as CoreTab) ? (v as CoreTab) : 'tools';
}

const route = useRoute();
const router = useRouter();
const tab = ref<CoreTab>(normalizeTab(route.query.tab));
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
      <div class="page-title">智能体中枢</div>
    </div>
    <div class="page-sub">
      收拢约束 agent 行为的核心配置：可调用的工具、指挥它的提示词、唤起它的调度。
    </div>

    <el-tabs v-model="tab" class="core-tabs">
      <el-tab-pane label="工具" name="tools" lazy>
        <ToolsPanel />
      </el-tab-pane>
      <el-tab-pane label="提示词" name="prompts" lazy>
        <PromptsPanel />
      </el-tab-pane>
      <el-tab-pane label="智能体" name="agents" lazy>
        <DecisionAgentsPanel />
      </el-tab-pane>
      <el-tab-pane label="调度" name="schedules" lazy>
        <SchedulesPanel />
      </el-tab-pane>
      <el-tab-pane label="调用记录" name="usage" lazy>
        <UsageView embedded />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.core-tabs {
  margin-top: 4px;
}
</style>
