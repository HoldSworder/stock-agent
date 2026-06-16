<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { MagicStick, Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import MarkdownView from '@/components/MarkdownView.vue';
import AiAnalysisDialog from '@/components/AiAnalysisDialog.vue';
import type { ReviewHistoryItem } from '@stock-agent/shared';

// agent 研判结论展示：取最新一次研判成功运行的正文，作为对应页面 Tab 的顶部基准；
// 下方确定性明细由各面板自渲染。source 决定取「大盘与板块研判」还是「ETF 综合研判」（合并后单一 kind）。
// 发起 / 重新研判统一走公共 AI 分析弹窗（kind=market-board|etf-analyze），与驾驶舱中心一致。

const props = withDefaults(defineProps<{ source?: 'board' | 'rotation' }>(), {
  source: 'board',
});

// 每种来源的文案 + 历史 API + 统一 kind（保持单组件复用，避免重复造结论卡片）
const META = {
  board: {
    kind: 'market-board',
    title: '大盘与板块研判',
    emptyTip:
      '暂无大盘与板块研判。点「生成研判」由 agent 据盘面快照做大盘复盘、再基于确定性板块强弱过滤出可信主线，结论会同时作为今日计划的大盘 + 板块/中线基准。',
    list: () => api.themes.boardReviews(1),
  },
  rotation: {
    kind: 'etf-analyze',
    title: 'ETF 综合研判',
    emptyTip:
      '暂无 ETF 综合研判。点「生成研判」由 agent 综合量化信号、持仓与中线赛道轮动（该进攻/该等回踩/该回避），结论会同时作为今日计划的 ETF 基准。',
    list: () => api.rotation.reviews(1),
  },
} as const;

const meta = computed(() => META[props.source]);
const latest = ref<ReviewHistoryItem | null>(null);
const loading = ref(false);
const dialogOpen = ref(false);

async function load() {
  loading.value = true;
  try {
    latest.value = (await meta.value.list())[0] ?? null;
  } catch {
    /* 历史拉取失败不阻断面板明细 */
  } finally {
    loading.value = false;
  }
}

// 弹窗关闭后刷新最新结论（可能刚跑完一次新研判）
function onDialogToggle(open: boolean) {
  dialogOpen.value = open;
  if (!open) void load();
}

onMounted(load);
</script>

<template>
  <div class="board-review">
    <div class="br-head">
      <div class="br-title">
        <el-icon><MagicStick /></el-icon>
        {{ meta.title }}
        <span v-if="latest" class="br-time">
          {{ dayjs(latest.createdAt).format('MM-DD HH:mm') }}
        </span>
      </div>
      <el-button :icon="Refresh" size="small" @click="dialogOpen = true">
        {{ latest ? '重新研判' : '生成研判' }}
      </el-button>
    </div>
    <MarkdownView v-if="latest?.outputText" :source="latest.outputText" />
    <div v-else-if="!loading" class="br-empty">{{ meta.emptyTip }}</div>

    <AiAnalysisDialog
      :model-value="dialogOpen"
      :kind="meta.kind"
      :title="meta.title"
      @update:model-value="onDialogToggle"
    />
  </div>
</template>

<style scoped>
.board-review {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  margin-bottom: 16px;
}
.br-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.br-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--brand);
}
.br-time {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-2);
  font-family: var(--font-mono);
}
.br-empty {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.6;
}
</style>
