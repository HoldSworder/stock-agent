<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import dayjs from 'dayjs';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Refresh, MagicStick, TopRight, VideoPlay, Check } from '@element-plus/icons-vue';
import { api } from '@/api';
import AiAnalysisDialog from '@/components/AiAnalysisDialog.vue';
import type {
  AiAnalysisGroup,
  AiAnalysisKindInfo,
  ScheduleOverviewItem,
} from '@stock-agent/shared';

// AI 分析中心：一处发起 + 看历史（能力区），并把各能力对应的底层模块定时聚合呈现（定时调度区），
// 可就地开关 / 改 cron / 立即触发。定时写操作分流到各模块原端点（/api/<module>/schedules/*），
// 本组件不新增调度逻辑，仅据 catalog 的 scheduleId join /api/schedules 总览做统一视图。

const catalog = ref<AiAnalysisKindInfo[]>([]);
const catalogLoading = ref(false);

const router = useRouter();

// 顶层展示类目（按新导航收敛：板块主线归大盘，研报+热点归情报）
const DISPLAY_ORDER = ['复盘', '大盘', 'ETF', '情报', '持仓', '决策'] as const;
type DisplayGroup = (typeof DISPLAY_ORDER)[number];
// 后端语义分组 → 顶层展示类目（三模块合并后：大盘=大盘与板块研判，ETF=综合研判，情报=研报+热点合一）
const DISPLAY_OF: Record<AiAnalysisGroup, DisplayGroup> = {
  复盘: '复盘',
  大盘: '大盘',
  板块主线: '大盘',
  ETF: 'ETF',
  研报: '情报',
  热点: '情报',
  情报: '情报',
  持仓: '持仓',
  决策: '决策',
};
// 结构化富渲染的 kind → 渲染器（其余默认 markdown；合并后情报/大盘/ETF 均为 markdown 散文）
const RENDERER: Record<string, 'review' | 'research'> = {
  review: 'review',
};
// perStock 类需个股，中心不一键发起，改引导去对应页
const PERSTOCK_ROUTE: Record<string, string> = { decision: '/decision' };

const groupedCatalog = computed(() => {
  const groups = new Map<DisplayGroup, AiAnalysisKindInfo[]>();
  for (const info of catalog.value) {
    const display = DISPLAY_OF[info.group] ?? '情报';
    const list = groups.get(display) ?? [];
    list.push(info);
    groups.set(display, list);
  }
  return DISPLAY_ORDER.filter((g) => groups.has(g)).map((g) => ({ group: g, items: groups.get(g)! }));
});

// 统一弹窗状态（动态 kind / title / renderer）
const dialogOpen = ref(false);
const dialogKind = ref('');
const dialogTitle = ref('');
const dialogRenderer = ref<'markdown' | 'review' | 'research'>('markdown');

function openKind(info: AiAnalysisKindInfo) {
  if (info.scope === 'perStock') {
    const path = PERSTOCK_ROUTE[info.kind];
    if (path) void router.push(path);
    return;
  }
  dialogKind.value = info.kind;
  dialogTitle.value = info.title;
  dialogRenderer.value = RENDERER[info.kind] ?? 'markdown';
  dialogOpen.value = true;
}

function onDialogToggle(open: boolean) {
  dialogOpen.value = open;
  if (!open) void loadCatalog();
}

async function loadCatalog() {
  catalogLoading.value = true;
  try {
    catalog.value = await api.analysisCatalog();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    catalogLoading.value = false;
  }
}

// ===== 定时调度：能力（scheduleId）join /api/schedules 总览 =====
const schedules = ref<ScheduleOverviewItem[]>([]);
const scheduleLoading = ref(false);
const cronDraft = reactive<Record<string, string>>({});
const toggling = reactive<Record<string, boolean>>({});
const triggering = reactive<Record<string, boolean>>({});
const savingCron = reactive<Record<string, boolean>>({});

interface ScheduleRow {
  kind: string;
  title: string;
  group: DisplayGroup;
  module: string;
  scheduleId: string;
  job: ScheduleOverviewItem | null;
}

// 可定时能力（catalog 声明了 scheduleId）按 DISPLAY_ORDER 排序，join 出对应调度项
const scheduleRows = computed<ScheduleRow[]>(() => {
  const byId = new Map(schedules.value.map((s) => [s.id, s]));
  return catalog.value
    .filter((info): info is AiAnalysisKindInfo & { scheduleId: string; scheduleModule: string } =>
      Boolean(info.scheduleId && info.scheduleModule),
    )
    .map((info) => ({
      kind: info.kind,
      title: info.title,
      group: DISPLAY_OF[info.group] ?? '情报',
      module: info.scheduleModule,
      scheduleId: info.scheduleId,
      job: byId.get(info.scheduleId) ?? null,
    }))
    .sort((a, b) => DISPLAY_ORDER.indexOf(a.group) - DISPLAY_ORDER.indexOf(b.group));
});

async function loadSchedules() {
  scheduleLoading.value = true;
  try {
    schedules.value = await api.schedules.list();
    for (const s of schedules.value) cronDraft[s.id] = s.cronExpr ?? '';
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    scheduleLoading.value = false;
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = dayjs(iso);
  return d.isValid() ? d.format('MM-DD HH:mm') : '—';
}

function cronDirty(row: ScheduleRow): boolean {
  return (cronDraft[row.scheduleId] ?? '').trim() !== (row.job?.cronExpr ?? '').trim();
}

async function toggleSchedule(row: ScheduleRow, enabled: boolean) {
  toggling[row.scheduleId] = true;
  try {
    await api.moduleSchedules.update(row.module, row.scheduleId, { enabled });
    ElMessage.success(`${row.title} 定时已${enabled ? '启用' : '停用'}`);
    await loadSchedules();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    toggling[row.scheduleId] = false;
  }
}

async function saveCron(row: ScheduleRow) {
  const next = (cronDraft[row.scheduleId] ?? '').trim();
  if (!next) {
    ElMessage.warning('cron 不能为空');
    return;
  }
  savingCron[row.scheduleId] = true;
  try {
    await api.moduleSchedules.update(row.module, row.scheduleId, { cronExpr: next });
    ElMessage.success(`${row.title} cron 已更新`);
    await loadSchedules();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    savingCron[row.scheduleId] = false;
  }
}

async function triggerSchedule(row: ScheduleRow) {
  triggering[row.scheduleId] = true;
  try {
    await api.moduleSchedules.trigger(row.module, row.scheduleId);
    ElMessage.success(`${row.title} 已触发`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    triggering[row.scheduleId] = false;
  }
}

async function reload() {
  await Promise.all([loadCatalog(), loadSchedules()]);
}

onMounted(reload);
</script>

<template>
  <div class="ai-hub">
    <!-- ===== 能力区：一处发起 / 看历史 ===== -->
    <section class="panel hub-panel">
      <div class="panel-head">
        <span class="section-title">AI 分析中心</span>
        <span class="panel-head-right">
          <span class="panel-meta">{{ catalog.length }} 项能力 · 一处发起 · 看历史</span>
          <el-button link type="primary" :icon="Refresh" :loading="catalogLoading" @click="reload">
            刷新
          </el-button>
        </span>
      </div>
      <div v-loading="catalogLoading">
        <div v-for="grp in groupedCatalog" :key="grp.group" class="hub-group">
          <div class="hub-group-title">{{ grp.group }}</div>
          <div class="hub-grid">
            <div v-for="info in grp.items" :key="info.kind" class="hub-card">
              <div class="hub-card-top">
                <span class="hub-card-title">{{ info.title }}</span>
                <el-tag v-if="info.scope === 'perStock'" size="small" effect="plain">个股</el-tag>
              </div>
              <div class="hub-card-snippet">
                <span v-if="info.latestAt" class="hub-card-time num">
                  {{ dayjs(info.latestAt).format('MM-DD HH:mm') }}
                </span>
                <span class="hub-card-text">{{ info.latestSnippet || '暂无结论' }}</span>
              </div>
              <el-button
                class="hub-card-btn"
                size="small"
                :type="info.scope === 'perStock' ? 'default' : 'primary'"
                :icon="info.scope === 'perStock' ? TopRight : MagicStick"
                @click="openKind(info)"
              >
                {{ info.scope === 'perStock' ? '去对应页发起' : info.latestAt ? '发起 / 看历史' : '发起分析' }}
              </el-button>
            </div>
          </div>
        </div>
        <el-empty v-if="!catalogLoading && !catalog.length" :image-size="60" description="暂无可用分析能力" />
      </div>
    </section>

    <!-- ===== 定时调度区：各能力对应的底层模块定时，可就地开关 / 改 cron / 触发 ===== -->
    <section class="panel sched-panel">
      <div class="panel-head">
        <span class="section-title">定时调度</span>
        <span class="panel-meta">据各能力底层模块定时 · 开关 / 改 cron / 立即触发</span>
      </div>
      <div v-loading="scheduleLoading">
        <div class="sched-list">
          <div class="sched-head">
            <span class="c-name">能力</span>
            <span class="c-cron">Cron</span>
            <span class="c-time">下次</span>
            <span class="c-time">上次成功</span>
            <span class="c-toggle">启用</span>
            <span class="c-act">操作</span>
          </div>
          <div
            v-for="row in scheduleRows"
            :key="row.scheduleId"
            class="sched-row"
            :class="{ off: !row.job?.enabled }"
          >
            <div class="c-name">
              <span class="name-text">{{ row.title }}</span>
              <span class="group-tag">{{ row.group }}</span>
            </div>
            <div class="c-cron">
              <el-input
                v-model="cronDraft[row.scheduleId]"
                size="small"
                placeholder="cron 表达式"
                class="cron-input"
                :disabled="!row.job"
              />
              <el-button
                v-if="row.job && cronDirty(row)"
                size="small"
                type="primary"
                :icon="Check"
                circle
                :loading="savingCron[row.scheduleId]"
                @click="saveCron(row)"
              />
            </div>
            <span class="c-time num">{{ fmtTime(row.job?.nextRunAt ?? null) }}</span>
            <span class="c-time num">{{ fmtTime(row.job?.lastSuccessAt ?? null) }}</span>
            <div class="c-toggle">
              <el-switch
                :model-value="row.job?.enabled ?? false"
                :disabled="!row.job"
                :loading="toggling[row.scheduleId]"
                size="small"
                @change="(v: any) => toggleSchedule(row, v === true)"
              />
            </div>
            <div class="c-act">
              <el-button
                size="small"
                :icon="VideoPlay"
                :disabled="!row.job"
                :loading="triggering[row.scheduleId]"
                @click="triggerSchedule(row)"
              >
                触发
              </el-button>
            </div>
          </div>
          <el-empty
            v-if="!scheduleLoading && !scheduleRows.length"
            :image-size="60"
            description="暂无可定时能力"
          />
        </div>
      </div>
    </section>

    <AiAnalysisDialog
      :model-value="dialogOpen"
      :kind="dialogKind"
      :title="dialogTitle"
      :result-renderer="dialogRenderer"
      @update:model-value="onDialogToggle"
    />
  </div>
</template>

<style scoped>
.ai-hub {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.panel {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.panel-head-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.section-title {
  font-size: 15px;
  font-weight: 600;
}
.panel-meta {
  font-size: 12px;
  color: var(--text-2);
}

/* ---- 能力区 ---- */
.hub-group {
  margin-bottom: 16px;
}
.hub-group:last-child {
  margin-bottom: 0;
}
.hub-group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 10px;
  padding-left: 8px;
  border-left: 3px solid var(--brand);
}
.hub-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.hub-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: var(--bg-1);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  transition: border-color 0.16s ease;
}
.hub-card:hover {
  border-color: var(--brand);
}
.hub-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.hub-card-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-0);
}
.hub-card-snippet {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-height: 34px;
}
.hub-card-time {
  font-size: 11.5px;
  color: var(--text-2);
}
.hub-card-text {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.hub-card-btn {
  align-self: flex-start;
}

/* ---- 定时调度区 ---- */
.sched-list {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-1);
  overflow: hidden;
}
.sched-head,
.sched-row {
  display: grid;
  grid-template-columns: minmax(200px, 1.5fr) minmax(150px, 1fr) 88px 88px 56px 88px;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
}
.sched-head {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.12em;
  color: var(--text-2);
  border-bottom: 1px solid var(--border);
  background: var(--bg-2);
}
.sched-row {
  border-bottom: 1px solid var(--border-soft);
}
.sched-row:last-child {
  border-bottom: none;
}
.sched-row.off {
  opacity: 0.62;
}
.c-name {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.name-text {
  font-size: 13px;
  color: var(--text-0);
}
.group-tag {
  font-size: 10px;
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
}
.c-cron {
  display: flex;
  align-items: center;
  gap: 6px;
}
.cron-input {
  flex: 1;
}
.c-time {
  font-size: 11.5px;
  color: var(--text-1);
}
.c-toggle,
.c-act {
  display: flex;
  align-items: center;
}

@media (max-width: 980px) {
  .sched-head {
    display: none;
  }
  .sched-row {
    grid-template-columns: 1fr 1fr;
    row-gap: 8px;
  }
  .c-name {
    grid-column: 1 / -1;
  }
}
</style>
