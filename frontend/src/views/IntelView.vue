<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, Search, MagicStick } from '@element-plus/icons-vue';
import { api } from '@/api';
import AiAnalysisDialog from '@/components/AiAnalysisDialog.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import ModuleScheduleDialog from '@/components/ModuleScheduleDialog.vue';
import type {
  TrendNews,
  TrendRadarStatus,
  TrendRssItem,
  TrendTopic,
} from '@stock-agent/shared';

// embedded：作为「情报」父页的 Tab 面板嵌入时隐藏自身 page-head。
defineProps<{ embedded?: boolean }>();

const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

const activeTab = ref('trending');
const status = ref<TrendRadarStatus | null>(null);

const topics = ref<TrendTopic[]>([]);
const news = ref<TrendNews[]>([]);
const rss = ref<TrendRssItem[]>([]);
// 情报研判（合并研报机会 + 全网热点，kind=intel）：本页仅内嵌最新一条 + 统一弹窗发起/看历史。
// 原「当日/近一周热点研判」已并入情报研判，周度热点底稿仍由定时落 trend_summaries（不在此展示）。
const intelLatest = ref('');
const intelAt = ref('');
const intelDialog = ref(false);

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
// 情报研判：拉取最近一条（统一历史端点 kind=intel）
async function loadIntel() {
  loading.value.summary = true;
  try {
    const list = await api.listAnalyses('intel', undefined, 1, true);
    if (list.length > 0) {
      intelLatest.value = list[0].content;
      intelAt.value = fmtTime(list[0].createdAt);
    }
  } catch {
    /* 首屏静默 */
  } finally {
    loading.value.summary = false;
  }
}

// 弹窗关闭后刷新内嵌最新结论
function onIntelDialog(open: boolean) {
  intelDialog.value = open;
  if (!open) void loadIntel();
}

function onTab(name: string) {
  if (name === 'news') void loadNews();
  else if (name === 'rss') void loadRss();
  else if (name === 'trending') void loadTrending();
  else if (name === 'summary') void loadIntel();
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
  <div :class="{ page: !embedded }">
    <div v-if="!embedded" class="page-head">
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
    <div v-if="!embedded" class="page-sub">
      接入群晖 TrendRadar：多平台热榜 / 新闻 / RSS 实时情报，AI 研判由本系统 LLM 现场生成
    </div>
    <div v-else class="embed-bar">
      <span class="st-chip" :class="{ live: status?.online }">
        <span class="dot" />
        {{ statusText }}
        <span v-if="status?.latestRecord" class="muted">· {{ status.latestRecord }}</span>
      </span>
      <ModuleScheduleDialog module="trendradar" />
      <el-button :icon="Refresh" @click="refreshActive">刷新</el-button>
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

      <!-- 情报研判（研报机会 + 全网热点 合并，本系统 LLM 现场研判） -->
      <el-tab-pane label="情报研判" name="summary">
        <div v-loading="loading.summary" class="panel">
          <div class="panel-title">
            <span>情报研判（研报机会 + 全网热点）</span>
            <span v-if="intelAt" class="muted summary-time">{{ intelAt }}</span>
          </div>
          <div v-if="!embedded" class="summary-bar">
            <el-button type="primary" :icon="MagicStick" @click="intelDialog = true">
              {{ intelLatest ? '重新研判 / 历史' : '生成研判' }}
            </el-button>
            <span class="muted">
              由本系统 LLM 合成五类研报机会与全网热点，可能需要 20-40 秒；与今日计划的情报基准同源
            </span>
          </div>
          <MarkdownView v-if="intelLatest" :source="intelLatest" class="summary-body" />
          <el-empty
            v-else-if="!loading.summary"
            :description="embedded ? '点击右上角「AI 分析」获取情报研判' : '点击「生成研判」获取情报研判'"
            :image-size="80"
          />

          <AiAnalysisDialog
            v-if="!embedded"
            :model-value="intelDialog"
            kind="intel"
            title="情报研判"
            @update:model-value="onIntelDialog"
          />
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
.embed-bar {
  display: flex;
  align-items: center;
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
