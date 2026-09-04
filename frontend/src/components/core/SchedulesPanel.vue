<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Refresh, VideoPlay, Check, CaretRight } from '@element-plus/icons-vue';
import { api } from '@/api';
import type { ScheduleOverviewItem } from '@stock-agent/shared';

// 调度总览：聚合「中央任务（scheduled_tasks）+ 各模块自管定时」为统一只读总览，并就地开关 / 改 cron / 立即触发。
// 写操作按 type 分流到各自原端点（中央 /api/tasks/*，模块 /api/<module>/schedules/*），本页不新增写逻辑。

const loading = ref(false);
const items = ref<ScheduleOverviewItem[]>([]);
const cronDraft = reactive<Record<string, string>>({});
const toggling = reactive<Record<string, boolean>>({});
const triggering = reactive<Record<string, boolean>>({});
const savingCron = reactive<Record<string, boolean>>({});
const expanded = reactive<Record<string, boolean>>({});

const centralCount = computed(() => items.value.filter((i) => i.type === 'central').length);
const moduleCount = computed(() => items.value.filter((i) => i.type === 'module').length);

/**
 * 搜索与筛选。
 *
 * 这一页原本是 40 多条中央任务与模块定时的混排单列表，没有搜索也没有分组——
 * 想确认「板块宽度快照到底有没有在跑」只能拿眼睛一行行扫。
 * 实际后果是几个关键快照任务关了三周没人发现，驾驶舱一直在拿三周前的数据当今天的判断。
 */
const keyword = ref('');
const onlyAttention = ref(false);

/** 上次成功超过这么久就算「可能没在跑」，与驾驶舱的断供门槛同量级 */
const STALE_SUCCESS_MS = 3 * 24 * 3600_000;

/** 这条需要人处理吗：没启用，或启用了却长期没成功过 */
function needsAttention(i: ScheduleOverviewItem): boolean {
  if (!i.enabled) return true;
  if (!i.lastSuccessAt) return true;
  return Date.now() - new Date(i.lastSuccessAt).getTime() > STALE_SUCCESS_MS;
}

const attentionCount = computed(() => items.value.filter(needsAttention).length);

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return items.value.filter((i) => {
    if (onlyAttention.value && !needsAttention(i)) return false;
    if (!kw) return true;
    return (
      i.name.toLowerCase().includes(kw) ||
      i.id.toLowerCase().includes(kw) ||
      (i.module ?? '').toLowerCase().includes(kw)
    );
  });
});

/** 按模块分组，中央任务归到一组置顶。组内保持后端给的顺序 */
const groups = computed(() => {
  const map = new Map<string, ScheduleOverviewItem[]>();
  for (const i of filtered.value) {
    const key = i.type === 'central' ? '中央任务' : (i.module ?? '其他');
    map.set(key, [...(map.get(key) ?? []), i]);
  }
  const entries = [...map.entries()];
  entries.sort((a, b) => {
    if (a[0] === '中央任务') return -1;
    if (b[0] === '中央任务') return 1;
    return a[0].localeCompare(b[0]);
  });
  return entries.map(([name, rows]) => ({
    name,
    rows,
    attention: rows.filter(needsAttention).length,
  }));
});

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function modelSummary(i: ScheduleOverviewItem): string {
  const c = i.modelConfig;
  if (!c) return '';
  const parts: string[] = [];
  parts.push(c.model || '默认模型');
  parts.push(c.thinking ? '深思开' : '深思关');
  if (c.maxSteps) parts.push(`${c.maxSteps}步`);
  return parts.join(' · ');
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    items.value = await api.schedules.list();
    for (const i of items.value) cronDraft[i.id] = i.cronExpr ?? '';
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function cronDirty(i: ScheduleOverviewItem): boolean {
  return (cronDraft[i.id] ?? '').trim() !== (i.cronExpr ?? '').trim();
}

async function toggle(i: ScheduleOverviewItem, enabled: boolean): Promise<void> {
  toggling[i.id] = true;
  try {
    if (i.type === 'central') await api.updateTask(i.id, { enabled });
    else await api.moduleSchedules.update(i.module!, i.id, { enabled });
    ElMessage.success(`${i.name} 已${enabled ? '启用' : '停用'}`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '切换失败');
    toggling[i.id] = false;
  }
}

async function saveCron(i: ScheduleOverviewItem): Promise<void> {
  const next = (cronDraft[i.id] ?? '').trim();
  savingCron[i.id] = true;
  try {
    if (i.type === 'central') await api.updateTask(i.id, { cronExpr: next || null });
    else await api.moduleSchedules.update(i.module!, i.id, { cronExpr: next });
    ElMessage.success(`${i.name} cron 已更新`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '更新失败');
  } finally {
    savingCron[i.id] = false;
  }
}

async function trigger(i: ScheduleOverviewItem): Promise<void> {
  triggering[i.id] = true;
  try {
    if (i.type === 'central') await api.triggerTask(i.id);
    else await api.moduleSchedules.trigger(i.module!, i.id);
    ElMessage.success(`${i.name} 已触发`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '触发失败');
  } finally {
    triggering[i.id] = false;
  }
}

/**
 * 支持从驾驶舱的断供提示带条件跳进来。
 *
 * `?q=breadth` 直接定位到板块宽度那一条，`?attention=1` 只看需要处理的。
 * 没有这个，提示里说「去调度页开启」等于把人丢进 40 多条列表里自己找。
 */
const route = useRoute();
onMounted(() => {
  const q = route.query.q;
  if (typeof q === 'string') keyword.value = q;
  if (route.query.attention === '1') onlyAttention.value = true;
  void load();
});
</script>

<template>
  <div class="schedules-panel">
    <div class="panel-head">
      <div class="panel-sub">
        全部唤起 agent 的定时来源：中央任务（带 prompt / 战法 / 模型配置）+ 各模块内置流程定时。可就地开关、改 cron、立即触发。
      </div>
      <div class="head-actions">
        <el-input
          v-model="keyword"
          size="small"
          clearable
          placeholder="搜任务名 / 模块"
          style="width: 180px"
        />
        <el-checkbox v-model="onlyAttention" size="small">
          只看需要处理<span v-if="attentionCount" class="att-n">{{ attentionCount }}</span>
        </el-checkbox>
        <span class="head-stat">中央 {{ centralCount }} · 模块 {{ moduleCount }}</span>
        <el-button size="small" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>
    <!-- 「需要处理」= 没启用，或启用了却超过 3 天没成功过。
         关掉的定时不会报错，只会让数据安静地停在某一天，这个筛选是唯一能主动发现它的入口 -->
    <div class="attention-hint">
      需要处理 = 没启用，或启用了但超过 3 天没成功过。定时关掉不会报错，只会让数据停更。
    </div>

    <el-skeleton v-if="loading" :rows="6" animated style="margin-top: 16px" />

    <div v-else class="list">
      <div class="list-head">
        <span class="c-name">名称</span>
        <span class="c-cron">Cron</span>
        <span class="c-time">下次</span>
        <span class="c-time">上次成功</span>
        <span class="c-toggle">启用</span>
        <span class="c-act">操作</span>
      </div>

      <template v-for="g in groups" :key="g.name">
        <div class="group-head">
          <span class="g-name">{{ g.name }}</span>
          <span class="g-count">{{ g.rows.length }} 条</span>
          <span v-if="g.attention" class="g-att">{{ g.attention }} 条需处理</span>
        </div>
        <template v-for="i in g.rows" :key="i.id">
        <div class="row" :class="{ off: !i.enabled, attention: needsAttention(i) }">
          <div class="c-name">
            <div class="name-line">
              <button
                v-if="i.type === 'central'"
                type="button"
                class="exp"
                :class="{ open: expanded[i.id] }"
                @click="expanded[i.id] = !expanded[i.id]"
              >
                <el-icon><CaretRight /></el-icon>
              </button>
              <span class="name-text">{{ i.name }}</span>
              <span class="type-tag" :class="i.type">{{ i.type === 'central' ? '中央' : '模块' }}</span>
              <span v-if="i.module" class="mod-tag">{{ i.module }}</span>
            </div>
            <div v-if="i.type === 'central' && (i.strategyId || modelSummary(i))" class="name-meta">
              <span v-if="i.strategyId" class="meta-chip">战法绑定</span>
              <span v-if="modelSummary(i)" class="meta-chip">{{ modelSummary(i) }}</span>
            </div>
            <div v-if="i.supersededBy || i.risk === 'time_conflict'" class="name-meta">
              <el-tooltip
                v-if="i.supersededBy"
                content="此任务已停用，职能由下方说明的对象承担；打开右侧开关即可恢复本地副本"
                placement="top"
              >
                <span class="superseded-chip">已并入：{{ i.supersededBy }}</span>
              </el-tooltip>
              <el-tooltip
                v-if="i.risk === 'time_conflict'"
                :content="`与其他启用任务在同一 cron 时刻（${i.cronExpr}）触发，可能重复研判 / 推送，建议停用其一`"
                placement="top"
              >
                <span class="conflict-chip">⚠ 同刻重复</span>
              </el-tooltip>
            </div>
          </div>

          <div class="c-cron">
            <el-input v-model="cronDraft[i.id]" size="small" placeholder="仅手动" class="cron-input" />
            <el-button
              v-if="cronDirty(i)"
              size="small"
              type="primary"
              :icon="Check"
              circle
              :loading="savingCron[i.id]"
              @click="saveCron(i)"
            />
          </div>

          <span class="c-time">{{ fmt(i.nextRunAt) }}</span>
          <span class="c-time">{{ fmt(i.lastSuccessAt) }}</span>

          <div class="c-toggle">
            <el-switch
              :model-value="i.enabled"
              :loading="toggling[i.id]"
              size="small"
              @change="(v: any) => toggle(i, v === true)"
            />
          </div>

          <div class="c-act">
            <el-button
              size="small"
              :icon="VideoPlay"
              :loading="triggering[i.id]"
              @click="trigger(i)"
            >
              触发
            </el-button>
          </div>
        </div>

        <!-- 中央任务可展开看完整 prompt（模块定时为内置流程，无 prompt） -->
        <div v-if="i.type === 'central' && expanded[i.id]" class="prompt-box">
          <pre class="prompt-text">{{ i.prompt || '（无 prompt）' }}</pre>
        </div>
        </template>
      </template>

      <el-empty
        v-if="!filtered.length"
        :description="items.length ? '没有符合条件的调度' : '暂无调度'"
        :image-size="64"
      />
    </div>
  </div>
</template>

<style scoped>
.panel-head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}
.panel-sub {
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.6;
  flex: 1;
}
.head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
}
.head-stat {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
}
.att-n {
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--el-color-warning);
  color: #fff;
  font-size: 11px;
  font-family: var(--font-mono);
}
.attention-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-2);
}
.group-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 12px 4px;
  background: var(--bg-1, transparent);
  border-top: 1px solid var(--border);
}
.g-name {
  font-weight: 600;
  font-size: 12.5px;
}
.g-count,
.g-att {
  font-size: 11.5px;
  color: var(--text-2);
  font-family: var(--font-mono);
}
.g-att {
  color: var(--el-color-warning);
}
.row.attention .c-name {
  /* 需要处理的行给一条左边线，扫一眼就能定位，不必逐行读「上次成功」 */
  box-shadow: inset 2px 0 0 var(--el-color-warning);
  padding-left: 6px;
}

.list {
  margin-top: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-2);
  overflow: hidden;
}
.list-head,
.row {
  display: grid;
  grid-template-columns: minmax(220px, 1.6fr) minmax(150px, 1fr) 92px 92px 56px 92px;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
}
.list-head {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.12em;
  color: var(--text-2);
  border-bottom: 1px solid var(--border);
  background: var(--bg-1);
}
.row {
  border-bottom: 1px solid var(--border-soft);
}
.row.off {
  opacity: 0.62;
}
.name-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.exp {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: var(--text-2);
  display: inline-flex;
  transition: transform 0.18s;
}
.exp.open {
  transform: rotate(90deg);
}
.name-text {
  font-size: 13px;
  color: var(--text-0);
}
.type-tag {
  font-size: 10px;
  border-radius: 4px;
  padding: 0 5px;
  border: 1px solid var(--border);
}
.type-tag.central {
  color: var(--brand);
  border-color: color-mix(in srgb, var(--brand) 45%, transparent);
}
.type-tag.module {
  color: var(--text-2);
}
.mod-tag {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
}
.name-meta {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.meta-chip {
  font-size: 10.5px;
  color: var(--text-2);
  background: var(--bg-1);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  padding: 0 6px;
}
.superseded-chip {
  font-size: 10.5px;
  color: var(--text-2);
  background: var(--bg-1);
  border: 1px dashed var(--border);
  border-radius: 4px;
  padding: 0 6px;
}
.conflict-chip {
  font-size: 10.5px;
  color: var(--warning, #e6a23c);
  border: 1px solid color-mix(in srgb, var(--warning, #e6a23c) 45%, transparent);
  border-radius: 4px;
  padding: 0 6px;
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
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-1);
}
.c-toggle,
.c-act {
  display: flex;
  align-items: center;
}
.prompt-box {
  padding: 0 14px 12px 34px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-1);
}
.prompt-text {
  margin: 0;
  padding: 10px 12px;
  background: var(--bg-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-1);
  max-height: 300px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 980px) {
  .list-head {
    display: none;
  }
  .row {
    grid-template-columns: 1fr 1fr;
    row-gap: 8px;
  }
  .c-name {
    grid-column: 1 / -1;
  }
}
</style>
