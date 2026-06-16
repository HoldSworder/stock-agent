<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import type { ClsTelegraph } from '@stock-agent/shared';

// embedded：作为「情报」父页的 Tab 面板嵌入时隐藏自身 page-head。
defineProps<{ embedded?: boolean }>();

const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

const symbol = ref<'全部' | '重点'>('全部');

// 电报走 SWR 缓存：重进瞬显；后端直连失效时兜底链降级慢，缓存避免每次重等十几秒。
// 始终拉全量（含 important 加红标记），「全部/重点」由前端本地筛选切换，零额外请求。
const {
  data,
  loading,
  refreshing,
  load,
  reload,
} = useCachedResource<ClsTelegraph[]>(
  () => 'cls:telegraph',
  () => api.cls.telegraph(50),
  { ttlMs: 60_000 },
);
const list = computed(() => data.value ?? []);

// 加红重点（level A/B）数量；切到「重点」仅展示这些
const importantCount = computed(() => list.value.filter((t) => t.important).length);
// 当前展示列表：按本地 symbol 筛选
const shown = computed(() =>
  symbol.value === '重点' ? list.value.filter((t) => t.important) : list.value,
);

// 实际来源（取首条），非「财联社」即为降级
const curSource = computed(() => list.value[0]?.source || '');
const degraded = computed(() => !!curSource.value && curSource.value !== '财联社');

// 切换全部/重点：纯本地筛选，不触发网络请求
function onSymbol(v: '全部' | '重点') {
  symbol.value = v;
}

// 刷新按钮：强制拉最新
async function refresh() {
  try {
    await reload();
  } catch (e) {
    ElMessage.error(msg(e));
  }
}

// 仅取 HH:mm，跨日时补 MM-DD
const fmtTime = (iso: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return sameDay ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
};

onMounted(() => void load().catch((e) => ElMessage.error(msg(e))));
</script>

<template>
  <div :class="{ page: !embedded }">
    <div v-if="!embedded" class="page-head">
      <div class="page-title">财联社电报</div>
      <div class="head-actions">
        <el-radio-group :model-value="symbol" size="small" @change="onSymbol">
          <el-radio-button label="全部" />
          <el-radio-button label="重点">重点{{ importantCount ? ` (${importantCount})` : '' }}</el-radio-button>
        </el-radio-group>
        <el-button :icon="Refresh" :loading="loading || refreshing" @click="refresh">刷新</el-button>
      </div>
    </div>
    <div v-if="!embedded" class="page-sub">
      财联社实时电报（经 AKShare 透传），盘中消息面快讯，捕捉题材异动与政策催化
    </div>
    <div v-else class="embed-bar">
      <el-radio-group :model-value="symbol" size="small" @change="onSymbol">
        <el-radio-button label="全部" />
        <el-radio-button label="重点">重点{{ importantCount ? ` (${importantCount})` : '' }}</el-radio-button>
      </el-radio-group>
      <el-button :icon="Refresh" size="small" :loading="loading || refreshing" @click="refresh">刷新</el-button>
    </div>

    <div v-if="curSource" class="source-bar">
      <el-tag size="small" :type="degraded ? 'warning' : 'success'" effect="plain">
        来源：{{ curSource }}快讯
      </el-tag>
      <span v-if="degraded" class="muted degraded-hint">
        财联社电报源暂不可用，已降级显示{{ curSource }}快讯（升级群晖 aktools 的 akshare 后自动恢复）
      </span>
    </div>

    <div v-loading="loading" class="panel">
      <div v-if="shown.length" class="tele-list">
        <component
          :is="t.url ? 'a' : 'div'"
          v-for="t in shown"
          :key="t.id"
          class="tele-row"
          :class="{ 'tele-link': t.url, 'is-important': t.important }"
          :href="t.url || undefined"
          :target="t.url ? '_blank' : undefined"
          rel="noopener"
        >
          <span class="tele-time num">{{ fmtTime(t.time) }}</span>
          <div class="tele-body">
            <span v-if="t.title" class="tele-title">{{ t.title }}</span>
            <span class="tele-content">{{ t.content }}</span>
          </div>
        </component>
      </div>
      <el-empty
        v-else-if="!loading && symbol === '重点' && degraded"
        description="重点筛选依赖财联社源，当前为降级源，暂无加红重点"
        :image-size="80"
      />
      <el-empty
        v-else-if="!loading && symbol === '重点'"
        description="当前暂无加红重点电报"
        :image-size="80"
      />
      <el-empty v-else-if="!loading" description="暂无快讯数据" :image-size="80" />
    </div>
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
  margin-bottom: 8px;
}
.source-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.muted {
  color: var(--text-2);
}
.degraded-hint {
  font-size: 12px;
}
.panel {
  background: var(--bg-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: 8px 18px;
}
.tele-list {
  display: flex;
  flex-direction: column;
}
.tele-row {
  display: flex;
  gap: 14px;
  padding: 12px 4px;
  border-bottom: 1px solid var(--border-soft);
  text-decoration: none;
  color: inherit;
}
.tele-row:last-child {
  border-bottom: none;
}
.tele-link {
  transition: background 0.14s ease;
  cursor: pointer;
}
.tele-link:hover {
  background: var(--bg-hover);
}
.tele-time {
  flex-shrink: 0;
  width: 64px;
  font-size: 12.5px;
  color: var(--brand);
  padding-top: 1px;
}
.tele-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tele-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-0);
}
.tele-content {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text-1);
}
/* 财联社加红重点（level A/B）：红色文本 + 左侧红边，仅承载真实语义状态 */
.tele-row.is-important {
  border-left: 2px solid var(--up);
  padding-left: 8px;
}
.tele-row.is-important .tele-time,
.tele-row.is-important .tele-title,
.tele-row.is-important .tele-content {
  color: var(--up);
}
</style>
