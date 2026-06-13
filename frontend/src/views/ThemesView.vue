<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import type { MarketTheme, ThemeSource } from '@stock-agent/shared';

const themes = ref<MarketTheme[]>([]);
const loading = ref(false);
const refreshing = ref(false);
const showArchived = ref(false);

const SOURCE_LABEL: Record<ThemeSource, string> = {
  review: '复盘',
  hotspot: '热点',
  research: '研报',
};
const STATUS_LABEL = { active: '活跃', fading: '退潮中', archived: '已归档' } as const;
const statusTag = (s: MarketTheme['status']) =>
  s === 'active' ? 'success' : s === 'fading' ? 'warning' : 'info';

// 强度色阶：≥80 强 / ≥60 中 / 其余弱
const strengthClass = (v: number) => (v >= 80 ? 'hot' : v >= 60 ? 'mid' : 'low');

const visible = computed(() => themes.value);

async function load() {
  loading.value = true;
  try {
    themes.value = await api.themes.list(showArchived.value);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function refresh() {
  refreshing.value = true;
  try {
    const r = await api.themes.refresh();
    ElMessage.success(`聚合完成：更新 ${r.ingested} 条，归档 ${r.archived} 条，活跃 ${r.activeTotal} 条`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    refreshing.value = false;
  }
}

async function archive(t: MarketTheme) {
  try {
    await api.themes.setStatus(t.id, 'archived');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">市场主线</div>
      <div class="head-actions">
        <el-checkbox v-model="showArchived" @change="load">含已归档</el-checkbox>
        <el-button :icon="Refresh" type="primary" :loading="refreshing" @click="refresh">
          聚合刷新
        </el-button>
      </div>
    </div>
    <div class="page-sub">
      把复盘计划重点板块、热点雷达话题统一结构化为主线，多源叠加强度。研报来源后续接入。
    </div>

    <div v-loading="loading" class="theme-grid">
      <div v-for="t in visible" :key="t.id" class="theme-card" :class="t.status">
        <div class="theme-top">
          <span class="theme-name">{{ t.theme }}</span>
          <el-tag size="small" :type="statusTag(t.status)" effect="plain">
            {{ STATUS_LABEL[t.status] }}
          </el-tag>
        </div>
        <div class="theme-strength">
          <div class="bar">
            <div class="bar-fill" :class="strengthClass(t.strength)" :style="{ width: `${t.strength}%` }" />
          </div>
          <span class="strength-num num">{{ Math.round(t.strength) }}</span>
        </div>
        <div class="theme-sources">
          <el-tag v-for="s in t.sources" :key="s" size="small" effect="dark" class="src-tag">
            {{ SOURCE_LABEL[s] }}
          </el-tag>
          <span class="theme-date">更新 {{ dayjs(t.lastSeenDate).format('MM-DD') }}</span>
        </div>
        <ul class="theme-evidence">
          <li v-for="(e, i) in t.evidence.slice(0, 4)" :key="i">
            <span class="ev-src">[{{ SOURCE_LABEL[e.source] }}]</span> {{ e.text }}
          </li>
        </ul>
        <div v-if="t.status !== 'archived'" class="theme-actions">
          <el-button size="small" text @click="archive(t)">归档</el-button>
        </div>
      </div>
    </div>

    <el-empty v-if="!loading && visible.length === 0" description="暂无主线，点「聚合刷新」生成" />
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
  margin-top: 16px;
  min-height: 80px;
}
.theme-card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.theme-card.fading {
  opacity: 0.78;
}
.theme-card.archived {
  opacity: 0.55;
}
.theme-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.theme-name {
  font-size: 16px;
  font-weight: 600;
}
.theme-strength {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bar {
  flex: 1;
  height: 6px;
  background: var(--bg-3, rgba(255, 255, 255, 0.08));
  border-radius: 3px;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 3px;
}
.bar-fill.hot {
  background: var(--danger, #f56c6c);
}
.bar-fill.mid {
  background: var(--warning, #e6a23c);
}
.bar-fill.low {
  background: var(--text-2);
}
.strength-num {
  font-size: 13px;
  width: 28px;
  text-align: right;
}
.theme-sources {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.src-tag {
  margin: 0;
}
.theme-date {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-2);
  font-family: var(--font-mono);
}
.theme-evidence {
  margin: 0;
  padding-left: 2px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.theme-evidence li {
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.45;
}
.ev-src {
  color: var(--text-1, inherit);
  font-weight: 500;
}
.theme-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
