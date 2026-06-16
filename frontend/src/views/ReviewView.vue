<script setup lang="ts">
import { onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { MagicStick, Clock, Memo } from '@element-plus/icons-vue';
import { api } from '@/api';
import ModuleScheduleDialog from '@/components/ModuleScheduleDialog.vue';
import AiAnalysisDialog from '@/components/AiAnalysisDialog.vue';
import ReviewResultView from '@/components/ReviewResultView.vue';
import type { ReviewHistoryItem } from '@stock-agent/shared';

// 复盘页：内嵌展示最新一次「一键复盘」结论（结构化富渲染），
// 发起 / 重新复盘统一走公共 AI 分析弹窗（kind=review），与驾驶舱中心一致。

const latestText = ref('');
const finishedAt = ref('');
const viewingHistory = ref(false);
const hasReview = ref(false);

// 历史抽屉
const historyDrawer = ref(false);
const historyList = ref<ReviewHistoryItem[]>([]);
const historyLoading = ref(false);

// 统一分析弹窗
const dialogOpen = ref(false);

function applyItem(item: ReviewHistoryItem, asHistory: boolean) {
  latestText.value = item.outputText ?? '';
  finishedAt.value = dayjs(item.createdAt).format('MM-DD HH:mm');
  viewingHistory.value = asHistory;
  hasReview.value = true;
}

/** 拉最新一次复盘结论内嵌展示 */
async function loadLatest() {
  try {
    const list = await api.listReviews(1);
    if (list.length > 0) applyItem(list[0], false);
  } catch {
    /* 首屏静默：无记录或请求失败时保持空态 */
  }
}

async function openHistory() {
  historyDrawer.value = true;
  historyLoading.value = true;
  try {
    historyList.value = await api.listReviews(50);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    historyLoading.value = false;
  }
}

function viewHistory(item: ReviewHistoryItem) {
  applyItem(item, true);
  historyDrawer.value = false;
}

// 弹窗关闭后刷新最新结论（可能刚跑完一次新复盘）
function onDialogToggle(open: boolean) {
  dialogOpen.value = open;
  if (!open) void loadLatest();
}

onMounted(() => {
  void loadLatest();
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">复盘</div>
      <div class="head-actions">
        <ModuleScheduleDialog module="review" />
        <el-button :icon="Clock" @click="openHistory">历史</el-button>
        <el-button :icon="MagicStick" type="primary" @click="dialogOpen = true">
          {{ hasReview ? '重新复盘' : '生成复盘' }}
        </el-button>
      </div>
    </div>

    <div class="page-sub">
      AI 深度多维复盘 · 大盘 / 情绪周期 / 资金面 / 主线题材 / 持仓 / 自选 / 风险 / 明日策略
      <span v-if="hasReview && finishedAt"> · {{ viewingHistory ? '历史复盘' : '最新' }} {{ finishedAt }}</span>
    </div>

    <el-empty
      v-if="!hasReview"
      description="点击「生成复盘」，AI 将结合实时盘面、真实持仓与自选股做一份当日深度复盘"
    />
    <ReviewResultView v-else :text="latestText" :finished-at="finishedAt" :viewing-history="true" />

    <!-- 统一 AI 分析弹窗（结构化富渲染） -->
    <AiAnalysisDialog
      :model-value="dialogOpen"
      kind="review"
      title="一键复盘"
      result-renderer="review"
      @update:model-value="onDialogToggle"
    />

    <!-- 复盘历史抽屉 -->
    <el-drawer v-model="historyDrawer" title="复盘历史" size="360px">
      <div v-loading="historyLoading" class="hist-list">
        <div
          v-for="item in historyList"
          :key="item.id"
          class="hist-item"
          @click="viewHistory(item)"
        >
          <el-icon class="hist-ic"><Memo /></el-icon>
          <span class="hist-time">{{ dayjs(item.createdAt).format('YYYY-MM-DD HH:mm') }}</span>
        </div>
        <el-empty v-if="!historyLoading && !historyList.length" :image-size="60" description="暂无复盘记录" />
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}
.hist-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hist-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.16s ease;
}
.hist-item:hover {
  background: var(--bg-hover);
  border-color: var(--brand);
}
.hist-ic {
  color: var(--brand);
}
.hist-time {
  font-family: var(--font-mono);
  font-size: 13px;
}
</style>
