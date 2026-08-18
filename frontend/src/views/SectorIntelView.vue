<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, MagicStick } from '@element-plus/icons-vue';
import { api } from '@/api';
import MarkdownView from '@/components/MarkdownView.vue';
import type { SectorDef, SectorRssItem } from '@stock-agent/shared';

// 赛道资讯（吸收 investment-news）：12 赛道全球源经 TrendRadar RSS 取数，
// 本系统 LLM 现场提炼「今日要点」（中文 + 英文翻译 + 溯源）。纯资讯，不荐股。
const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

const sectors = ref<SectorDef[]>([]);
const active = ref('');
const items = ref<SectorRssItem[]>([]);
const digest = ref('');
const digestAt = ref('');

const loading = ref({ rss: false, digest: false, gen: false });

const fmtTime = (iso: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function loadSectors() {
  try {
    sectors.value = await api.sectorintel.sectors();
    if (sectors.value.length && !active.value) {
      active.value = sectors.value[0].id;
      await selectSector(active.value);
    }
  } catch (e) {
    ElMessage.error(msg(e));
  }
}

async function loadRss() {
  // 连点赛道 A→B 且 A 后返回时，若不比对 id，右侧会显示 A 的资讯而左侧高亮在 B
  const id = active.value;
  loading.value.rss = true;
  try {
    const list = await api.sectorintel.rss(id, 2);
    if (id !== active.value) return;
    items.value = list;
  } catch (e) {
    if (id !== active.value) return;
    ElMessage.error(msg(e));
  } finally {
    // loading 归属最新那一发，被切走后不要抢着复位
    if (id === active.value) loading.value.rss = false;
  }
}

async function loadDigest() {
  const id = active.value;
  loading.value.digest = true;
  digest.value = '';
  digestAt.value = '';
  try {
    const d = await api.sectorintel.latestDigest(id);
    if (id !== active.value) return;
    if (d) {
      digest.value = d.content;
      digestAt.value = fmtTime(d.createdAt);
    }
  } catch {
    /* 首屏静默 */
  } finally {
    if (id === active.value) loading.value.digest = false;
  }
}

async function selectSector(id: string) {
  active.value = id;
  await Promise.all([loadRss(), loadDigest()]);
}

async function generate() {
  if (!active.value) return;
  loading.value.gen = true;
  try {
    const d = await api.sectorintel.digest(active.value);
    digest.value = d.content;
    digestAt.value = fmtTime(d.createdAt);
    ElMessage.success('今日要点已生成');
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    loading.value.gen = false;
  }
}

onMounted(() => void loadSectors());
</script>

<template>
  <div class="sector-intel">
    <!-- 左：赛道列表 -->
    <div class="sector-nav">
      <div
        v-for="s in sectors"
        :key="s.id"
        class="sector-item"
        :class="{ active: s.id === active }"
        @click="selectSector(s.id)"
      >
        <span class="sector-name">{{ s.label }}</span>
        <span class="sector-count num">{{ s.feedCount }}</span>
      </div>
    </div>

    <!-- 右：今日要点 + 源列表 -->
    <div class="sector-main">
      <div v-loading="loading.digest || loading.gen" class="panel">
        <div class="panel-title">
          <span>今日要点（AI 提炼 · 跨源去重 · 中文翻译 · 溯源）</span>
          <span v-if="digestAt" class="muted t">{{ digestAt }}</span>
        </div>
        <div class="gen-bar">
          <el-button type="primary" :icon="MagicStick" :loading="loading.gen" @click="generate">
            {{ digest ? '重新提炼' : '生成今日要点' }}
          </el-button>
          <span class="muted">由本系统 LLM 基于该赛道近两天全球资讯现场提炼，可能需 20-40 秒</span>
        </div>
        <MarkdownView v-if="digest" :source="digest" class="digest-body" />
        <el-empty v-else-if="!loading.digest" description="点击「生成今日要点」获取该赛道最新进展" :image-size="80" />
      </div>

      <div v-loading="loading.rss" class="panel">
        <div class="panel-title">
          <span>原始资讯（近两天 · 双语）</span>
          <el-button size="small" :icon="Refresh" text @click="loadRss">刷新</el-button>
        </div>
        <div v-if="items.length" class="news-list">
          <a
            v-for="(r, i) in items"
            :key="i"
            class="news-row"
            :href="r.url || undefined"
            :target="r.url ? '_blank' : undefined"
            rel="noopener"
          >
            <el-tag size="small" effect="plain" type="warning" class="news-plat">{{ r.feedName }}</el-tag>
            <span class="news-title">{{ r.title }}</span>
            <span v-if="r.publishedAt" class="news-date muted">{{ r.publishedAt.slice(5, 16).replace('T', ' ') }}</span>
          </a>
        </div>
        <el-empty v-else-if="!loading.rss" description="该赛道暂无资讯" :image-size="80" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.sector-intel {
  display: grid;
  grid-template-columns: 180px 1fr;
  gap: 16px;
  margin-top: 4px;
}
.sector-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--bg-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: 8px;
  height: fit-content;
  position: sticky;
  top: 8px;
}
.sector-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-1);
  transition: background 0.14s ease;
}
.sector-item:hover {
  background: var(--bg-hover);
}
.sector-item.active {
  background: var(--brand-soft, var(--bg-3));
  color: var(--brand);
  font-weight: 600;
}
.sector-count {
  font-size: 11.5px;
  color: var(--text-2);
}
.sector-item.active .sector-count {
  color: var(--brand);
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
.panel-title .t {
  font-size: 12px;
  font-weight: 400;
}
.muted {
  color: var(--text-2);
}
.gen-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  font-size: 12px;
}
.digest-body {
  margin-top: 6px;
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
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
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
</style>
