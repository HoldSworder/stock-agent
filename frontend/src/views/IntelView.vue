<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, Search, MagicStick } from '@element-plus/icons-vue';
import { api } from '@/api';
import MarkdownView from '@/components/MarkdownView.vue';
import ModuleScheduleDialog from '@/components/ModuleScheduleDialog.vue';
import type {
  TrendNews,
  TrendRadarStatus,
  TrendRssItem,
  TrendSummary,
  TrendSummaryHistoryItem,
  TrendTopic,
} from '@stock-agent/shared';

const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

const activeTab = ref('trending');
const status = ref<TrendRadarStatus | null>(null);

const topics = ref<TrendTopic[]>([]);
const news = ref<TrendNews[]>([]);
const rss = ref<TrendRssItem[]>([]);
const summary = ref<TrendSummary | TrendSummaryHistoryItem | null>(null);
const summaryType = ref<'daily' | 'weekly'>('daily');
const summaryHistory = ref<TrendSummaryHistoryItem[]>([]);
const currentSummaryId = ref<string>('');
const summaryLoaded = ref(false);

const loading = ref({
  trending: false,
  news: false,
  rss: false,
  summary: false,
});
const loaded = ref({ trending: false, news: false, rss: false });

// 关键词搜索（覆盖热榜 + RSS）
const searchKw = ref('');
const searching = ref(false);
const searchResults = ref<TrendNews[] | null>(null);

const maxFreq = computed(() => Math.max(1, ...topics.value.map((t) => t.frequency)));

const statusText = computed(() => {
  const s = status.value;
  if (!s) return '连接中…';
  if (!s.enabled) return '模块未启用';
  if (!s.online) return '离线';
  return '在线';
});

const trendTag = (t: string) =>
  t === 'rising' ? 'danger' : t === 'falling' ? 'success' : 'info';
const trendLabel = (t: string) =>
  t === 'rising' ? '升' : t === 'falling' ? '降' : t === 'stable' ? '稳' : t;

async function loadStatus() {
  try {
    status.value = await api.trendradar.status();
  } catch {
    /* 状态失败不阻断主流程 */
  }
}

async function loadTrending(force = false) {
  if (loaded.value.trending && !force) return;
  loading.value.trending = true;
  try {
    topics.value = await api.trendradar.trending(30);
    loaded.value.trending = true;
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    loading.value.trending = false;
  }
}

async function loadNews(force = false) {
  if (loaded.value.news && !force) return;
  loading.value.news = true;
  try {
    news.value = await api.trendradar.news(80);
    loaded.value.news = true;
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    loading.value.news = false;
  }
}

async function loadRss(force = false) {
  if (loaded.value.rss && !force) return;
  loading.value.rss = true;
  try {
    rss.value = await api.trendradar.rss(1);
    loaded.value.rss = true;
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    loading.value.rss = false;
  }
}

async function runSearch() {
  const q = searchKw.value.trim();
  if (!q) {
    searchResults.value = null;
    return;
  }
  searching.value = true;
  try {
    searchResults.value = await api.trendradar.search(q);
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    searching.value = false;
  }
}

const fmtTime = (iso: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const summaryTypeLabel = (t: string) => (t === 'weekly' ? '近一周' : '当日');
// 历史列表按当前类型（当日/近一周）过滤，避免两种研判混在一起
const filteredHistory = computed(() =>
  summaryHistory.value.filter((h) => h.reportType === summaryType.value),
);
const historyLabel = (h: TrendSummaryHistoryItem) => fmtTime(h.createdAt);

async function loadSummaries(force = false) {
  if (summaryLoaded.value && !force) return;
  try {
    summaryHistory.value = await api.trendradar.summaries(30);
    summaryLoaded.value = true;
    // 进页面自动恢复最近一条
    if (!summary.value && summaryHistory.value.length) {
      const latest = summaryHistory.value[0];
      summary.value = latest;
      currentSummaryId.value = latest.id;
      summaryType.value = latest.reportType === 'weekly' ? 'weekly' : 'daily';
    }
  } catch {
    /* 历史加载失败不阻断主流程 */
  }
}

function selectSummary(id: string) {
  const hit = summaryHistory.value.find((h) => h.id === id);
  if (!hit) return;
  summary.value = hit;
  currentSummaryId.value = hit.id;
}

// 切换「当日/近一周」时，历史下拉与正文联动到对应类型的最新一条
watch(summaryType, () => {
  if (summary.value && summary.value.reportType === summaryType.value) return;
  const latest = filteredHistory.value[0];
  if (latest) {
    summary.value = latest;
    currentSummaryId.value = latest.id;
  } else {
    summary.value = null;
    currentSummaryId.value = '';
  }
});

async function genSummary() {
  loading.value.summary = true;
  try {
    const res = await api.trendradar.summary(summaryType.value);
    summary.value = res;
    currentSummaryId.value = res.id;
    // 新记录即时入历史顶部（去重后 unshift）
    summaryHistory.value = [
      { id: res.id, reportType: res.reportType, content: res.content, createdAt: res.createdAt },
      ...summaryHistory.value.filter((h) => h.id !== res.id),
    ];
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    loading.value.summary = false;
  }
}

function onTab(name: string) {
  if (name === 'news') void loadNews();
  else if (name === 'rss') void loadRss();
  else if (name === 'trending') void loadTrending();
  else if (name === 'summary') void loadSummaries();
}

function refreshActive() {
  void loadStatus();
  const t = activeTab.value;
  if (t === 'trending') void loadTrending(true);
  else if (t === 'news') void loadNews(true);
  else if (t === 'rss') void loadRss(true);
}

onMounted(() => {
  void loadStatus();
  void loadTrending();
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">热点雷达</div>
      <div class="head-actions">
        <span class="st-chip" :class="{ live: status?.online }">
          <span class="dot" />
          {{ statusText }}
          <span v-if="status?.latestRecord" class="muted">· {{ status.latestRecord }}</span>
        </span>
        <ModuleScheduleDialog module="trendradar" />
        <el-button :icon="Refresh" @click="refreshActive">刷新</el-button>
      </div>
    </div>
    <div class="page-sub">
      接入群晖 TrendRadar：多平台热榜 / 新闻 / RSS 实时情报，AI 研判由本系统 LLM 现场生成
    </div>

    <el-tabs v-model="activeTab" class="intel-tabs" @tab-change="onTab">
      <!-- 热榜话题 -->
      <el-tab-pane label="热榜话题" name="trending">
        <div v-loading="loading.trending" class="panel">
          <div class="panel-title">高频热点话题（最新一批）</div>
          <div v-if="topics.length" class="topic-list">
            <div v-for="t in topics" :key="t.keyword" class="topic-row">
              <span class="topic-rank num">{{ topics.indexOf(t) + 1 }}</span>
              <span class="topic-kw">{{ t.keyword }}</span>
              <span class="topic-bar">
                <span class="topic-bar-fill" :style="{ width: (t.frequency / maxFreq) * 100 + '%' }" />
              </span>
              <span class="topic-freq num">{{ t.frequency }}</span>
              <el-tag :type="trendTag(t.trend)" size="small" effect="plain" class="topic-trend">
                {{ trendLabel(t.trend) }}
              </el-tag>
            </div>
          </div>
          <el-empty v-else-if="!loading.trending" description="暂无热点话题" :image-size="80" />
        </div>
      </el-tab-pane>

      <!-- 最新新闻 -->
      <el-tab-pane label="最新新闻" name="news">
        <div class="panel">
          <div class="panel-title">
            <span>关键词搜索（热榜 + RSS）</span>
          </div>
          <div class="search-bar">
            <el-input
              v-model="searchKw"
              placeholder="输入关键词，如：英伟达 / 机器人 / 固态电池"
              clearable
              @keyup.enter="runSearch"
              @clear="searchResults = null"
            >
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <el-button type="primary" :loading="searching" @click="runSearch">搜索</el-button>
          </div>
          <div v-if="searchResults" class="news-list">
            <div class="result-hint muted">命中 {{ searchResults.length }} 条</div>
            <a
              v-for="(n, i) in searchResults"
              :key="'s' + i"
              class="news-row"
              :href="n.url || undefined"
              :target="n.url ? '_blank' : undefined"
              rel="noopener"
            >
              <el-tag size="small" effect="plain" class="news-plat">{{ n.platformName }}</el-tag>
              <span class="news-title">{{ n.title }}</span>
            </a>
            <el-empty
              v-if="!searchResults.length"
              description="未搜到相关新闻"
              :image-size="80"
            />
          </div>
        </div>

        <div v-loading="loading.news" class="panel">
          <div class="panel-title">最新一批热榜新闻</div>
          <div v-if="news.length" class="news-list">
            <a
              v-for="(n, i) in news"
              :key="'n' + i"
              class="news-row"
              :href="n.url || undefined"
              :target="n.url ? '_blank' : undefined"
              rel="noopener"
            >
              <el-tag size="small" effect="plain" class="news-plat">{{ n.platformName }}</el-tag>
              <span v-if="n.rank" class="news-rank num">#{{ n.rank }}</span>
              <span class="news-title">{{ n.title }}</span>
            </a>
          </div>
          <el-empty v-else-if="!loading.news" description="暂无新闻数据" :image-size="80" />
        </div>
      </el-tab-pane>

      <!-- RSS -->
      <el-tab-pane label="RSS 订阅" name="rss">
        <div v-loading="loading.rss" class="panel">
          <div class="panel-title">最新 RSS 文章（今日）</div>
          <div v-if="rss.length" class="news-list">
            <a
              v-for="(r, i) in rss"
              :key="'r' + i"
              class="news-row"
              :href="r.url || undefined"
              :target="r.url ? '_blank' : undefined"
              rel="noopener"
            >
              <el-tag size="small" effect="plain" type="warning" class="news-plat">
                {{ r.feedName }}
              </el-tag>
              <span class="news-title">{{ r.title }}</span>
              <span v-if="r.publishedAt" class="news-date muted">{{ r.publishedAt.slice(5, 16).replace('T', ' ') }}</span>
            </a>
          </div>
          <el-empty v-else-if="!loading.rss" description="暂无 RSS 数据" :image-size="80" />
        </div>
      </el-tab-pane>

      <!-- AI 分析（本系统 LLM 现场研判） -->
      <el-tab-pane label="AI 分析" name="summary">
        <div v-loading="loading.summary" class="panel">
          <div class="panel-title">
            <span>AI 热点研判（本系统 LLM 生成）</span>
            <span v-if="summary?.createdAt" class="muted summary-time">
              {{ fmtTime(summary.createdAt) }} · {{ summaryTypeLabel(summary.reportType) }}
            </span>
          </div>
          <div class="summary-bar">
            <el-radio-group v-model="summaryType" size="small">
              <el-radio-button label="daily">当日</el-radio-button>
              <el-radio-button label="weekly">近一周</el-radio-button>
            </el-radio-group>
            <el-button type="primary" :icon="MagicStick" :loading="loading.summary" @click="genSummary">
              生成研判
            </el-button>
            <el-select
              v-if="filteredHistory.length"
              v-model="currentSummaryId"
              size="small"
              :placeholder="`${summaryTypeLabel(summaryType)}历史`"
              class="summary-history"
              @change="selectSummary"
            >
              <el-option
                v-for="h in filteredHistory"
                :key="h.id"
                :label="historyLabel(h)"
                :value="h.id"
              />
            </el-select>
            <span class="muted">由本系统 LLM 基于 TrendRadar 热榜/新闻/RSS 现场研判，可能需要 10-30 秒</span>
          </div>
          <MarkdownView v-if="summary?.content" :source="summary.content" class="summary-body" />
          <el-empty v-else-if="!loading.summary" description="点击「生成研判」获取 AI 分析" :image-size="80" />
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
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

.panel {
  background: var(--bg-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: 16px 18px;
  margin-bottom: 16px;
}
.panel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-0);
  margin-bottom: 14px;
}
/* 热榜话题 */
.topic-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.topic-row {
  display: grid;
  grid-template-columns: 28px 150px 1fr 56px 44px;
  align-items: center;
  gap: 12px;
}
.topic-rank {
  color: var(--text-2);
  font-size: 12px;
  text-align: center;
}
.topic-kw {
  font-size: 13.5px;
  color: var(--text-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.topic-bar {
  height: 8px;
  background: var(--bg-3);
  border-radius: 4px;
  overflow: hidden;
}
.topic-bar-fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--brand), var(--brand-2));
  border-radius: 4px;
}
.topic-freq {
  font-size: 12.5px;
  text-align: right;
  color: var(--text-1);
}
.topic-trend {
  justify-self: end;
}

/* 新闻 / RSS 列表 */
.search-bar,
.summary-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.search-bar .el-input {
  max-width: 420px;
}
.result-hint {
  font-size: 12px;
  margin-bottom: 6px;
}
.news-list {
  display: flex;
  flex-direction: column;
}
.news-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 6px;
  border-bottom: 1px solid var(--border-soft);
  text-decoration: none;
  color: var(--text-0);
  transition: background 0.14s ease;
}
.news-row:hover {
  background: var(--bg-hover);
}
.news-plat {
  flex-shrink: 0;
}
.news-rank {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--brand);
}
.news-title {
  flex: 1;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.news-date {
  flex-shrink: 0;
  font-size: 11.5px;
}

.summary-bar {
  flex-wrap: wrap;
}
.summary-history {
  width: 220px;
}
.summary-time {
  font-size: 12px;
  font-weight: 400;
}
.summary-body {
  margin-top: 6px;
}
</style>
