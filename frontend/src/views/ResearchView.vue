<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, MagicStick, TopRight } from '@element-plus/icons-vue';
import { api } from '@/api';
import MarkdownView from '@/components/MarkdownView.vue';
import ResearchOpportunityPanel from '@/components/ResearchOpportunityPanel.vue';
import ResearchAnnouncementPanel from '@/components/ResearchAnnouncementPanel.vue';
import type {
  ResearchAiAnalysis,
  ResearchReport,
  ResearchReportDetail,
  ResearchReportType,
  ResearchStatus,
} from '@stock-agent/shared';

// embedded：作为「情报」父页的 Tab 面板嵌入时隐藏自身 page-head。
defineProps<{ embedded?: boolean }>();

const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

const TABS: { name: ResearchReportType; label: string }[] = [
  { name: 'stock', label: '个股' },
  { name: 'industry', label: '行业' },
  { name: 'strategy', label: '策略' },
  { name: 'macro', label: '宏观' },
  { name: 'morning', label: '晨报' },
];

// 顶层视图：研报分析（独立面板） / 研报库（研报列表 + 公告列表，二者同为列表）
const view = ref<'analysis' | 'library'>('analysis');
// 研报库内二级 tab：研报列表 / 公告列表
const libTab = ref<'reports' | 'announcement'>('reports');

const activeTab = ref<ResearchReportType>('stock');
const status = ref<ResearchStatus | null>(null);
const reports = ref<ResearchReport[]>([]);
const loading = ref(false);

// 筛选
const filterCode = ref('');
const filterIndustry = ref('');
const filterRating = ref('');
const filterDays = ref(30);
const RATINGS = ['', '买入', '增持', '中性', '减持', '卖出'];

// 单篇详情抽屉
const drawer = ref(false);
const current = ref<ResearchReport | null>(null);
const detail = ref<ResearchReportDetail | null>(null);
const detailLoading = ref(false);
const analysis = ref<ResearchAiAnalysis | null>(null);
const analyzing = ref(false);

const statusText = () => {
  const s = status.value;
  if (!s) return '连接中…';
  if (!s.enabled) return '模块未启用';
  if (!s.online) return '离线';
  return '在线';
};

const ratingTag = (r: string) =>
  ['买入', '增持'].includes(r) ? 'danger' : ['减持', '卖出'].includes(r) ? 'success' : 'info';

async function loadStatus() {
  try {
    status.value = await api.research.status();
  } catch {
    /* 状态失败不阻断主流程 */
  }
}

async function loadList() {
  loading.value = true;
  try {
    reports.value = await api.research.list({
      type: activeTab.value,
      code: activeTab.value === 'stock' ? filterCode.value.trim() || undefined : undefined,
      industry: activeTab.value === 'industry' ? filterIndustry.value.trim() || undefined : undefined,
      rating: filterRating.value || undefined,
      days: filterDays.value,
      pageSize: 50,
    });
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    loading.value = false;
  }
}

function onTab() {
  reports.value = [];
  void loadList();
}

async function openDetail(r: ResearchReport) {
  current.value = r;
  detail.value = null;
  analysis.value = null;
  drawer.value = true;
  detailLoading.value = true;
  try {
    detail.value = await api.research.content(r.type, r.encodeUrl, r.infoCode);
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    detailLoading.value = false;
  }
}

async function analyzeOne() {
  if (!current.value) return;
  analyzing.value = true;
  try {
    analysis.value = await api.research.analyze(current.value.type, current.value.encodeUrl, current.value.infoCode);
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    analyzing.value = false;
  }
}

onMounted(() => {
  void loadStatus();
  void loadList();
});
</script>

<template>
  <div :class="{ page: !embedded }">
    <div v-if="!embedded" class="page-head">
      <div class="page-title">研报</div>
      <div class="head-actions">
        <span class="st-chip" :class="{ live: status?.online }">
          <span class="dot" />
          {{ statusText() }}
        </span>
        <el-button
          v-if="view === 'library' && libTab === 'reports'"
          :icon="Refresh"
          @click="loadList"
        >刷新</el-button>
      </div>
    </div>
    <div v-else class="embed-bar">
      <span class="st-chip" :class="{ live: status?.online }">
        <span class="dot" />
        {{ statusText() }}
      </span>
      <el-button
        v-if="view === 'library' && libTab === 'reports'"
        :icon="Refresh"
        @click="loadList"
      >刷新</el-button>
    </div>

    <el-radio-group v-model="view" class="mode-switch">
      <el-radio-button value="analysis">研报分析</el-radio-button>
      <el-radio-button value="library">研报库</el-radio-button>
    </el-radio-group>

    <!-- 研报分析：独立面板（含全市场研判 + 自选股综述 + 定时） -->
    <ResearchOpportunityPanel v-if="view === 'analysis'" />

    <!-- 研报库：研报列表 / 公告列表 -->
    <template v-else>
    <el-tabs v-model="libTab" class="lib-tabs">
      <el-tab-pane label="研报列表" name="reports" />
      <el-tab-pane label="公告列表" name="announcement" />
    </el-tabs>

    <!-- 公告列表 -->
    <ResearchAnnouncementPanel v-if="libTab === 'announcement'" />

    <!-- 研报列表 -->
    <template v-else>
    <div class="page-sub">接入东方财富研报中心：个股 / 行业 / 策略 / 宏观 / 券商晨报，正文交本系统 AI 研判</div>

    <el-tabs v-model="activeTab" @tab-change="onTab">
      <el-tab-pane v-for="t in TABS" :key="t.name" :label="t.label" :name="t.name" />
    </el-tabs>

    <div class="filters">
      <el-input
        v-if="activeTab === 'stock'"
        v-model="filterCode"
        placeholder="股票代码，如 600519"
        clearable
        class="f-input"
        @keyup.enter="loadList"
      />
      <el-input
        v-if="activeTab === 'industry'"
        v-model="filterIndustry"
        placeholder="行业代码（可空）"
        clearable
        class="f-input"
        @keyup.enter="loadList"
      />
      <el-select v-model="filterRating" placeholder="评级" class="f-rating">
        <el-option v-for="r in RATINGS" :key="r" :label="r || '全部评级'" :value="r" />
      </el-select>
      <el-select v-model="filterDays" class="f-days">
        <el-option :label="'近 7 天'" :value="7" />
        <el-option :label="'近 30 天'" :value="30" />
        <el-option :label="'近 90 天'" :value="90" />
      </el-select>
      <el-button type="primary" @click="loadList">查询</el-button>
    </div>

    <div v-loading="loading" class="panel">
      <el-table v-if="reports.length" :data="reports" size="small" @row-click="openDetail">
        <el-table-column prop="publishDate" label="日期" width="100" />
        <el-table-column v-if="activeTab === 'stock'" label="标的" width="140">
          <template #default="{ row }">
            <span v-if="row.stockName">{{ row.stockName }}<span class="muted">({{ row.stockCode }})</span></span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="240" show-overflow-tooltip />
        <el-table-column prop="orgName" label="机构" width="120" show-overflow-tooltip />
        <el-table-column label="评级" width="120">
          <template #default="{ row }">
            <el-tag v-if="row.rating" :type="ratingTag(row.rating)" size="small" effect="plain">
              {{ row.rating }}
            </el-tag>
            <span v-if="row.ratingChange" class="muted change">{{ row.ratingChange }}</span>
          </template>
        </el-table-column>
        <el-table-column label="目标价" width="80">
          <template #default="{ row }">
            <span v-if="row.targetPriceHigh ?? row.targetPriceLow" class="num">
              {{ row.targetPriceHigh ?? row.targetPriceLow }}
            </span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="EPS(本/次年)" width="120">
          <template #default="{ row }">
            <span class="num muted">{{ row.epsThisYear ?? '—' }} / {{ row.epsNextYear ?? '—' }}</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else-if="!loading" description="暂无研报，调整筛选后重试" :image-size="80" />
    </div>

    <!-- 单篇详情 -->
    <el-drawer v-model="drawer" :title="current?.title || '研报详情'" size="58%">
      <div v-if="current" class="detail">
        <div class="detail-meta">
          <span>{{ current.orgName }}</span>
          <span v-if="current.researcher" class="muted">· {{ current.researcher }}</span>
          <span class="muted">· {{ current.publishDate }}</span>
          <el-tag v-if="current.rating" :type="ratingTag(current.rating)" size="small" effect="plain">
            {{ current.rating }}{{ current.ratingChange ? '·' + current.ratingChange : '' }}
          </el-tag>
        </div>
        <div class="detail-actions">
          <el-button type="primary" :icon="MagicStick" :loading="analyzing" @click="analyzeOne">
            AI 分析本篇
          </el-button>
          <a
            v-if="detail?.detailUrl"
            class="open-link"
            :href="detail.detailUrl"
            target="_blank"
            rel="noopener"
          >
            原文详情 <el-icon><TopRight /></el-icon>
          </a>
          <a
            v-if="detail?.pdfUrl"
            class="open-link"
            :href="detail.pdfUrl"
            target="_blank"
            rel="noopener"
          >
            PDF <el-icon><TopRight /></el-icon>
          </a>
        </div>

        <div v-if="analysis" class="ai-block">
          <div class="ai-title">AI 研判</div>
          <MarkdownView :source="analysis.content" />
        </div>

        <div v-loading="detailLoading" class="content-block">
          <div class="ai-title">研报正文</div>
          <pre v-if="detail?.text" class="content-text">{{ detail.text }}</pre>
          <el-empty
            v-else-if="!detailLoading"
            description="未能抽取正文，请查看原文/PDF"
            :image-size="70"
          />
        </div>
      </div>
    </el-drawer>

    </template>
    </template>
  </div>
</template>

<style scoped>
.mode-switch {
  margin-bottom: 16px;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.embed-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-bottom: 4px;
}
.st-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-1);
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
}
.st-chip .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-2);
}
.st-chip.live .dot {
  background: var(--down);
  box-shadow: 0 0 8px var(--down);
}
.muted {
  color: var(--text-2);
}
.num {
  font-variant-numeric: tabular-nums;
}
.change {
  margin-left: 5px;
  font-size: 11.5px;
}

.filters {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.f-input {
  max-width: 220px;
}
.f-rating {
  width: 130px;
}
.f-days {
  width: 120px;
}

.panel {
  background: var(--bg-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: 8px 10px;
  min-height: 200px;
}
:deep(.el-table__row) {
  cursor: pointer;
}

.detail-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 12px;
}
.detail-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
}
.open-link {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  color: var(--brand);
  text-decoration: none;
}
.ai-block,
.content-block {
  margin-bottom: 18px;
}
.ai-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-0);
  margin-bottom: 8px;
}
.content-text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-1);
  background: var(--bg-1);
  border-radius: var(--radius-sm);
  padding: 14px;
  margin: 0;
  font-family: inherit;
}
</style>
