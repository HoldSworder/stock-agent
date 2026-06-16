<script setup lang="ts">
import { onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { MagicStick } from '@element-plus/icons-vue';
import { api } from '@/api';
import AiAnalysisDialog from '@/components/AiAnalysisDialog.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import ModuleScheduleDialog from '@/components/ModuleScheduleDialog.vue';
import type { ResearchAiAnalysis } from '@stock-agent/shared';

// 统一 AI 分析中心：情报研判（研报机会 + 全网热点 合并）发起 / 历史走统一弹窗（kind=intel），本面板仅内嵌最新结论卡。
const dialogOpen = ref(false);
const latestText = ref('');
const finishedAt = ref('');
const loadingLatest = ref(false);

// 自选股机构观点综述（独立 REST 分析，保留）
const batchDialog = ref(false);
const batchResult = ref<ResearchAiAnalysis | null>(null);
const batchLoading = ref(false);

async function runBatch() {
  batchDialog.value = true;
  batchResult.value = null;
  batchLoading.value = true;
  try {
    batchResult.value = await api.research.analyzeBatch({ scope: 'watchlist', limit: 6 });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    batchLoading.value = false;
  }
}

/** 拉取最近一次情报研判结论（统一历史端点） */
async function loadLatest() {
  loadingLatest.value = true;
  try {
    const list = await api.listAnalyses('intel', undefined, 1, true);
    if (list.length > 0) {
      latestText.value = list[0].content;
      finishedAt.value = dayjs(list[0].createdAt).format('MM-DD HH:mm');
    }
  } catch {
    /* 首屏静默 */
  } finally {
    loadingLatest.value = false;
  }
}

// 弹窗关闭后刷新内嵌最新结论
function onDialogToggle(open: boolean) {
  dialogOpen.value = open;
  if (!open) void loadLatest();
}

onMounted(() => {
  void loadLatest();
});
</script>

<template>
  <div class="rop">
    <div class="rop-head">
      <div class="rop-sub">
        情报研判：近一日五类研报与全市场重大公告 + 全网热点，合并研判板块 / 个股机会与题材风口
        <span v-if="finishedAt"> · 最新 {{ finishedAt }}</span>
      </div>
      <div class="head-actions">
        <el-button :icon="MagicStick" :loading="batchLoading" @click="runBatch">
          自选股综述分析
        </el-button>
        <ModuleScheduleDialog module="research" />
        <el-button :icon="MagicStick" type="primary" @click="dialogOpen = true">
          {{ latestText ? '重新分析 / 历史' : '开始分析' }}
        </el-button>
      </div>
    </div>

    <!-- 空态 -->
    <el-empty
      v-if="!loadingLatest && !latestText"
      description="点击「开始分析」，AI 将聚合五类研报、全市场重大公告与全网热点，输出情报研判"
    />

    <!-- 内嵌最新结论卡（情报研判为 Markdown 散文） -->
    <MarkdownView v-else-if="latestText" :source="latestText" />

    <!-- 统一 AI 分析弹窗：发起 / 流式轨迹 / 历史 -->
    <AiAnalysisDialog
      :model-value="dialogOpen"
      kind="intel"
      title="情报研判"
      @update:model-value="onDialogToggle"
    />

    <!-- 自选股机构观点综述 -->
    <el-dialog v-model="batchDialog" title="自选股研报机构观点综述" width="58%" top="6vh">
      <div v-loading="batchLoading" class="batch-body">
        <MarkdownView v-if="batchResult?.content" :source="batchResult.content" />
        <el-empty v-else-if="!batchLoading" description="暂无可分析的研报" :image-size="80" />
        <div v-if="batchResult" class="muted batch-foot">基于 {{ batchResult.reportCount }} 篇研报</div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.rop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.rop-sub {
  font-size: 13px;
  color: var(--text-2);
}
.head-actions {
  display: flex;
  gap: 8px;
}
.batch-body {
  min-height: 120px;
}
.muted {
  color: var(--text-2);
}
.batch-foot {
  font-size: 12px;
  margin-top: 10px;
}
</style>
