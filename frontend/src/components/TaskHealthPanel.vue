<script setup lang="ts">
/**
 * 系统自己有没有在干活。
 *
 * 为什么这块要放在首页最上面，而不是藏进设置页的定时列表里：
 * 定时任务失败只会写进服务端日志和一条推送，界面上看不出任何异常。
 * 实测有任务连续四个交易日没跑、无人察觉；也有任务被关掉三个月、同样无人察觉。
 * 两者都会让后面攒的记录中间出现空洞，而空洞是事后才发现的——
 * 那时整段记录已经作废。所以这不是运维信息，是所有结论的前提。
 *
 * 三种「没在跑」必须分开显示，混成一句「暂无数据」就等于没说。
 */
import { computed, onMounted, ref } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { TASK_HEALTH_LABELS, type TaskHealthItem, type TaskHealthOverview } from '@stock-agent/shared';
import { api } from '@/api';

const data = ref<TaskHealthOverview | null>(null);
const loading = ref(false);
const failed = ref('');
/** 正常与已关闭的明细默认收起：平时只该看见异常 */
const expanded = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  failed.value = '';
  try {
    data.value = await api.schedules.health();
  } catch (e) {
    failed.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const overdue = computed<TaskHealthItem[]>(
  () => data.value?.items.filter((i) => i.status === 'overdue') ?? [],
);
const others = computed<TaskHealthItem[]>(
  () => data.value?.items.filter((i) => i.status !== 'overdue') ?? [],
);

/** 一句话总结，让人不用读表格就知道要不要管 */
const summary = computed(() => {
  const d = data.value;
  if (!d) return '';
  const n = d.overdueCount;
  if (n === 0) return `该跑的都跑了，另有 ${d.disabledCount} 项是你关掉的`;
  return `有 ${n} 项该跑却没跑，需要处理`;
});

const TAG_TYPE = {
  ok: 'success',
  overdue: 'danger',
  disabled: 'info',
  idle: 'warning',
} as const;

/** ISO → 'MM-DD HH:mm'，空值给一个说得清的占位而不是横杠 */
function at(iso: string | null): string {
  if (!iso) return '从没成功过';
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function stale(item: TaskHealthItem): string {
  if (item.status !== 'overdue') return '';
  return item.staleDays >= 1 ? `落后 ${item.staleDays} 天` : '今天没跑';
}
</script>

<template>
  <el-card class="health" shadow="never">
    <template #header>
      <div class="hd">
        <span class="title">系统在干活吗</span>
        <el-tag
          v-if="data"
          size="small"
          effect="plain"
          :type="data.overdueCount > 0 ? 'danger' : 'success'"
        >
          {{ summary }}
        </el-tag>
        <el-button :icon="Refresh" text size="small" :loading="loading" @click="load">
          重新检查
        </el-button>
      </div>
    </template>

    <el-alert v-if="failed" type="error" :closable="false" show-icon>
      检查不了：{{ failed }}
    </el-alert>

    <template v-else-if="data">
      <!-- 异常常显，不折叠。这是这块唯一需要被看见的东西 -->
      <el-table v-if="overdue.length" :data="overdue" size="small" :show-header="false">
        <el-table-column prop="name" min-width="180" />
        <el-table-column width="110">
          <template #default="{ row }">
            <el-tag size="small" type="danger" effect="plain">{{ stale(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column min-width="220">
          <template #default="{ row }">
            <span class="dim">
              本该 {{ at(row.expectedAt) }} 跑，最后一次成功是 {{ at(row.lastSuccessAt) }}
            </span>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="fine">该跑的任务都跑过了。</div>

      <div class="more">
        <el-button text size="small" @click="expanded = !expanded">
          {{ expanded ? '收起' : `展开其余 ${others.length} 项` }}
        </el-button>
      </div>

      <el-table v-if="expanded" :data="others" size="small">
        <el-table-column prop="name" label="任务" min-width="180" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="TAG_TYPE[row.status as keyof typeof TAG_TYPE]" effect="plain">
              {{ TASK_HEALTH_LABELS[row.status as keyof typeof TASK_HEALTH_LABELS] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="上次成功" width="130">
          <template #default="{ row }">{{ at(row.lastSuccessAt) }}</template>
        </el-table-column>
        <el-table-column label="下次" width="130">
          <template #default="{ row }">{{ row.nextRunAt ? at(row.nextRunAt) : '不会自动跑' }}</template>
        </el-table-column>
      </el-table>
    </template>
  </el-card>
</template>

<style scoped>
.hd {
  display: flex;
  align-items: center;
  gap: 10px;
}
.title {
  font-weight: 600;
}
.hd .el-button {
  margin-left: auto;
}
.dim {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.fine {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.more {
  margin-top: 6px;
}
</style>
