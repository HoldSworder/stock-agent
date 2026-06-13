<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Refresh, Delete, Brush } from '@element-plus/icons-vue';
import { api } from '@/api';
import type { OpsDbStats, RetentionConfig } from '@stock-agent/shared';

// 运维·SQLite 体积治理：库体积/各表行数总览、按表设保留天数（0=不自动清理）、单表手动清理、VACUUM 回收、自动清理定时开关。
// 仅治理日志/历史表；配置/账本/学习闭环表不在此暴露，永久保留。

const loading = ref(false);
const stats = ref<OpsDbStats | null>(null);
// 各表保留天数草稿（既是自动清理策略，也用作「立即清理早于 N 天」）
const retentionDraft = reactive<Record<string, number>>({});
const savingRetention = ref(false);
const cleaningAll = ref(false);
const vacuuming = ref(false);
const togglingAuto = ref(false);
const cleaningOne = reactive<Record<string, boolean>>({});

function formatBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

const dbSizeText = computed(() => formatBytes(stats.value?.dbSizeBytes ?? 0));
const totalRowsText = computed(() => (stats.value?.totalRows ?? 0).toLocaleString('zh-CN'));

async function load(): Promise<void> {
  loading.value = true;
  try {
    const s = await api.ops.stats();
    stats.value = s;
    for (const t of s.tables) {
      if (t.cleanable) retentionDraft[t.table] = t.retentionDays;
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function retentionDirty(): boolean {
  if (!stats.value) return false;
  return stats.value.tables.some(
    (t) => t.cleanable && (retentionDraft[t.table] ?? 0) !== t.retentionDays,
  );
}

async function saveRetention(): Promise<void> {
  if (!stats.value) return;
  savingRetention.value = true;
  try {
    const patch: RetentionConfig = {};
    for (const t of stats.value.tables) {
      if (t.cleanable) patch[t.table] = Math.max(0, Math.floor(retentionDraft[t.table] ?? 0));
    }
    await api.ops.setRetention(patch);
    ElMessage.success('保留策略已保存');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    savingRetention.value = false;
  }
}

async function cleanupTable(table: string, label: string): Promise<void> {
  const days = Math.floor(retentionDraft[table] ?? 0);
  if (days <= 0) {
    ElMessage.warning('请先设置大于 0 的保留天数');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将删除「${label}」中早于 ${days} 天的记录，不可恢复。是否继续？`,
      '确认清理',
      { type: 'warning', confirmButtonText: '清理', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  cleaningOne[table] = true;
  try {
    const res = await api.ops.cleanup({ table, days });
    ElMessage.success(`已清理 ${res.total} 行`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '清理失败');
  } finally {
    cleaningOne[table] = false;
  }
}

async function cleanupByRetention(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '将按各表保留天数（>0）删除超期记录，不可恢复。是否继续？',
      '确认清理',
      { type: 'warning', confirmButtonText: '清理', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  cleaningAll.value = true;
  try {
    const res = await api.ops.cleanup();
    ElMessage.success(`已按策略清理 ${res.total} 行`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '清理失败');
  } finally {
    cleaningAll.value = false;
  }
}

async function vacuum(): Promise<void> {
  vacuuming.value = true;
  try {
    const res = await api.ops.vacuum();
    ElMessage.success(`VACUUM 完成，库体积 ${formatBytes(res.dbSizeBytes)}`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : 'VACUUM 失败');
  } finally {
    vacuuming.value = false;
  }
}

async function toggleAuto(enabled: boolean): Promise<void> {
  togglingAuto.value = true;
  try {
    await api.moduleSchedules.update('ops', 'ops.retention', { enabled });
    ElMessage.success(`自动清理已${enabled ? '启用' : '停用'}`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '切换失败');
  } finally {
    togglingAuto.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">运维</div>
      <el-button size="small" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>
    <div class="page-sub">
      SQLite 体积治理：清理累积的日志 / 历史记录并回收空间。配置 / 账本 / 战法学习闭环等表永久保留，不在此暴露。
    </div>

    <el-skeleton v-if="loading && !stats" :rows="6" animated />

    <template v-else-if="stats">
      <!-- 概览卡 -->
      <div class="cards">
        <div class="ov-card">
          <div class="ov-label">数据库体积</div>
          <div class="ov-value">{{ dbSizeText }}</div>
        </div>
        <div class="ov-card">
          <div class="ov-label">日志/历史总行数</div>
          <div class="ov-value">{{ totalRowsText }}</div>
        </div>
        <div class="ov-card auto">
          <div class="ov-label">自动清理（每日 03:30，可在中枢·调度改 cron）</div>
          <div class="ov-switch">
            <el-switch
              :model-value="stats.autoEnabled"
              :loading="togglingAuto"
              inline-prompt
              active-text="开"
              inactive-text="关"
              @change="(v: any) => toggleAuto(v === true)"
            />
            <span class="auto-note">按保留策略清理 + VACUUM</span>
          </div>
        </div>
      </div>

      <!-- 操作区 -->
      <div class="ops-bar">
        <el-button
          type="primary"
          size="small"
          :loading="savingRetention"
          :disabled="!retentionDirty()"
          @click="saveRetention"
        >
          保存保留策略
        </el-button>
        <el-button size="small" :icon="Delete" :loading="cleaningAll" @click="cleanupByRetention">
          立即按策略清理
        </el-button>
        <el-button size="small" :icon="Brush" :loading="vacuuming" @click="vacuum">
          VACUUM 回收空间
        </el-button>
      </div>

      <!-- 表清单 -->
      <div class="tbl">
        <div class="tbl-head">
          <span class="c-name">表 / 说明</span>
          <span class="c-rows">行数</span>
          <span class="c-days">保留天数（0=不自动清理）</span>
          <span class="c-act">手动清理</span>
        </div>
        <div v-for="t in stats.tables" :key="t.table" class="tbl-row" :class="{ locked: !t.cleanable }">
          <div class="c-name">
            <span class="t-table">{{ t.table }}</span>
            <span class="t-label">{{ t.label }}</span>
          </div>
          <span class="c-rows">{{ t.rows.toLocaleString('zh-CN') }}</span>
          <div class="c-days">
            <el-input-number
              v-if="t.cleanable"
              v-model="retentionDraft[t.table]"
              :min="0"
              :max="3650"
              :step="7"
              size="small"
              controls-position="right"
            />
            <span v-else class="locked-tag">级联清理</span>
          </div>
          <div class="c-act">
            <el-button
              v-if="t.cleanable"
              size="small"
              :icon="Delete"
              :loading="cleaningOne[t.table]"
              :disabled="(retentionDraft[t.table] ?? 0) <= 0"
              @click="cleanupTable(t.table, t.label)"
            >
              清理超期
            </el-button>
            <span v-else class="locked-tag">—</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}
.ov-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-2);
  padding: 14px 16px;
}
.ov-label {
  font-size: 12px;
  color: var(--text-2);
}
.ov-value {
  font-family: var(--font-mono);
  font-size: 24px;
  font-weight: 600;
  color: var(--text-0);
  margin-top: 6px;
}
.ov-card.auto .ov-switch {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}
.auto-note {
  font-size: 11.5px;
  color: var(--text-2);
}

.ops-bar {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.tbl {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-2);
  overflow: hidden;
}
.tbl-head,
.tbl-row {
  display: grid;
  grid-template-columns: minmax(220px, 1.8fr) 110px 220px 130px;
  align-items: center;
  gap: 12px;
  padding: 11px 16px;
}
.tbl-head {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.12em;
  color: var(--text-2);
  border-bottom: 1px solid var(--border);
  background: var(--bg-1);
}
.tbl-row {
  border-bottom: 1px solid var(--border-soft);
}
.tbl-row.locked {
  opacity: 0.7;
}
.c-name {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.t-table {
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--text-0);
}
.t-label {
  font-size: 11.5px;
  color: var(--text-2);
}
.c-rows {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-1);
}
.locked-tag {
  font-size: 11px;
  color: var(--text-2);
}

@media (max-width: 860px) {
  .tbl-head {
    display: none;
  }
  .tbl-row {
    grid-template-columns: 1fr 1fr;
    row-gap: 8px;
  }
  .c-name {
    grid-column: 1 / -1;
  }
}
</style>
