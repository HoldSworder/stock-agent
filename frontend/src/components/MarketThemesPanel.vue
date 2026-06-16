<script setup lang="ts">
import { onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh, QuestionFilled } from '@element-plus/icons-vue';
import { api } from '@/api';
import StrengthMethodologyDrawer from '@/components/StrengthMethodologyDrawer.vue';
import type { MarketTheme, ThemeSource } from '@stock-agent/shared';

// 市场主线明细（确定性下钻）：以东财真实板块为主源沉淀的 market_themes，复盘/热点为证据 overlay。
// 主线研判结论见顶部 BoardReviewConclusion；此处展示归并后的主线全集与多源证据，可手动归档噪声。

const themes = ref<MarketTheme[]>([]);
const loading = ref(false);
const refreshing = ref(false);
const showArchived = ref(false);
const methodology = ref<InstanceType<typeof StrengthMethodologyDrawer>>();

const SOURCE_LABEL: Record<ThemeSource, string> = {
  board: '板块',
  review: '复盘',
  hotspot: '热点',
  research: '研报',
};
const STATUS_LABEL = { active: '活跃', fading: '退潮中', archived: '已归档' } as const;
const statusTag = (s: MarketTheme['status']) =>
  s === 'active' ? 'success' : s === 'fading' ? 'warning' : 'info';
// 复盘验证回流的生命周期阶段（「未知」不展示，避免噪声）
const phaseTag = (p: MarketTheme['phase']) =>
  p === '加速' ? 'danger' : p === '启动' ? 'success' : p === '分歧' ? 'warning' : 'info';
const strengthClass = (v: number) => (v >= 80 ? 'hot' : v >= 60 ? 'mid' : 'low');

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
  <div class="panel-block">
    <div class="block-head">
      <div class="block-title">市场主线明细</div>
      <div class="block-actions">
        <el-button :icon="QuestionFilled" text size="small" @click="methodology?.open('theme')">
          方法论
        </el-button>
        <el-checkbox v-model="showArchived" @change="load">含已归档</el-checkbox>
        <el-button :icon="Refresh" size="small" :loading="refreshing" @click="refresh">
          聚合刷新
        </el-button>
      </div>
    </div>
    <StrengthMethodologyDrawer ref="methodology" />
    <div class="block-sub">
      以东财行业 / 概念涨幅榜 + 主力净流入为主源，复盘重点板块、热点话题作为证据叠加，多源协同提升强度。
    </div>

    <div v-loading="loading" class="theme-grid">
      <div v-for="t in themes" :key="t.id" class="theme-card" :class="t.status">
        <div class="theme-top">
          <span class="theme-name">{{ t.theme }}</span>
          <div class="theme-tags">
            <el-tag
              v-if="t.phase && t.phase !== '未知'"
              size="small"
              :type="phaseTag(t.phase)"
              effect="light"
              title="复盘验证阶段"
            >
              {{ t.phase }}
            </el-tag>
            <el-tag size="small" :type="statusTag(t.status)" effect="plain">
              {{ STATUS_LABEL[t.status] }}
            </el-tag>
          </div>
        </div>
        <div class="theme-strength">
          <div class="bar">
            <div
              class="bar-fill"
              :class="strengthClass(t.strength)"
              :style="{ width: `${t.strength}%` }"
            />
          </div>
          <el-popover trigger="hover" :width="250" placement="top">
            <template #reference>
              <span class="strength-num num trigger">{{ Math.round(t.strength) }}</span>
            </template>
            <div class="str-pop">
              <div class="str-pop-title">强度构成</div>
              <p>强度 = 各来源最高强度提示 + 多源协同加成（每新增一个来源 +8）。</p>
              <p>
                命中来源
                <b>{{ t.sources.map((s) => SOURCE_LABEL[s]).join(' · ') }}</b>
                （{{ t.sources.length }} 源）
              </p>
              <p class="str-pop-note">板块涨幅排名越前、主力净流入越大、来源越多，强度越高。</p>
            </div>
          </el-popover>
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

    <el-empty v-if="!loading && themes.length === 0" description="暂无主线，点「聚合刷新」生成" />
  </div>
</template>

<style scoped>
.panel-block {
  margin-top: 4px;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.block-title {
  font-size: 15px;
  font-weight: 600;
}
.block-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.block-sub {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 12px;
  line-height: 1.5;
}
.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
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
.theme-tags {
  display: flex;
  align-items: center;
  gap: 6px;
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
  font-family: var(--font-mono);
}
.strength-num.trigger {
  cursor: help;
}
.str-pop-title {
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 6px;
}
.str-pop p {
  margin: 4px 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-2);
}
.str-pop-note {
  color: var(--text-2);
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
