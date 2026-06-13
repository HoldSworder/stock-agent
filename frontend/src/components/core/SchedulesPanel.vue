<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
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

onMounted(load);
</script>

<template>
  <div class="schedules-panel">
    <div class="panel-head">
      <div class="panel-sub">
        全部唤起 agent 的定时来源：中央任务（带 prompt / 战法 / 模型配置）+ 各模块内置流程定时。可就地开关、改 cron、立即触发。
      </div>
      <div class="head-actions">
        <span class="head-stat">中央 {{ centralCount }} · 模块 {{ moduleCount }}</span>
        <el-button size="small" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
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

      <template v-for="i in items" :key="i.id">
        <div class="row" :class="{ off: !i.enabled }">
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

      <el-empty v-if="!items.length" description="暂无调度" :image-size="64" />
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
