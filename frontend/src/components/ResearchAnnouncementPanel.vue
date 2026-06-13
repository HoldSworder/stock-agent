<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, TopRight } from '@element-plus/icons-vue';
import { api } from '@/api';
import StockLink from '@/components/StockLink.vue';
import type { ResearchAnnouncementItem } from '@stock-agent/shared';

const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

// 近 N 天：默认 2（对齐后端 discoverWindowDays 的周一窗口口径）
const days = ref(2);
const list = ref<ResearchAnnouncementItem[]>([]);
const loading = ref(false);

// 正文抽屉（点开时实时抓 notice_content，不留存）
const drawer = ref(false);
const current = ref<ResearchAnnouncementItem | null>(null);
const content = ref<string | null>(null);
const contentLoading = ref(false);

async function load() {
  loading.value = true;
  try {
    list.value = await api.research.announcements({ days: days.value });
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    loading.value = false;
  }
}

async function openDetail(row: ResearchAnnouncementItem) {
  current.value = row;
  content.value = null;
  drawer.value = true;
  contentLoading.value = true;
  try {
    const r = await api.research.announcementContent(row.artCode);
    content.value = r.text;
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    contentLoading.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="ann">
    <div class="ann-head">
      <div class="ann-sub">全市场重大公告（业绩预增 / 重组 / 中标 / 回购 / 增减持 / 问询等），实时抓取不留存</div>
      <div class="head-actions">
        <el-select v-model="days" class="f-days" @change="load">
          <el-option :label="'近 1 天'" :value="1" />
          <el-option :label="'近 2 天'" :value="2" />
          <el-option :label="'近 3 天'" :value="3" />
          <el-option :label="'近 7 天'" :value="7" />
        </el-select>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </div>
    </div>

    <div v-loading="loading" class="panel">
      <el-table v-if="list.length" :data="list" size="small" @row-click="openDetail">
        <el-table-column prop="time" label="时间" width="130" />
        <el-table-column label="标的" width="150">
          <template #default="{ row }">
            <span v-if="row.name">
              <StockLink :code="row.code" :name="row.name" /><span class="muted">({{ row.code }})</span>
            </span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="type" label="类型" width="160" show-overflow-tooltip>
          <template #default="{ row }">
            <el-tag v-if="row.type" size="small" effect="plain">{{ row.type }}</el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="280" show-overflow-tooltip />
      </el-table>
      <el-empty v-else-if="!loading" description="暂无重大公告，调整时间范围后重试" :image-size="80" />
    </div>

    <!-- 正文抽屉 -->
    <el-drawer v-model="drawer" :title="current?.title || '公告详情'" size="58%">
      <div v-if="current" class="detail">
        <div class="detail-meta">
          <span v-if="current.name">{{ current.name }}<span class="muted">({{ current.code }})</span></span>
          <el-tag v-if="current.type" size="small" effect="plain">{{ current.type }}</el-tag>
          <span class="muted">· {{ current.time }}</span>
        </div>
        <div class="detail-actions">
          <a v-if="current.url" class="open-link" :href="current.url" target="_blank" rel="noopener">
            原文详情 <el-icon><TopRight /></el-icon>
          </a>
        </div>
        <div v-loading="contentLoading" class="content-block">
          <pre v-if="content" class="content-text">{{ content }}</pre>
          <el-empty
            v-else-if="!contentLoading"
            description="未能抓取正文，请查看原文"
            :image-size="70"
          />
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.ann-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.ann-sub {
  font-size: 13px;
  color: var(--text-2);
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.f-days {
  width: 120px;
}
.muted {
  color: var(--text-2);
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
.content-block {
  margin-bottom: 18px;
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
