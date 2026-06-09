<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import dayjs from 'dayjs';
import { api } from '@/api';
import type { NotifyChannel, ScheduledTask, ScheduledTaskInput } from '@stock-agent/shared';

const tasks = ref<ScheduledTask[]>([]);
const loading = ref(false);
const dialog = ref(false);
const editingId = ref<string | null>(null);

const form = reactive<ScheduledTaskInput & { thinking: boolean; model: string }>({
  name: '',
  description: '',
  cronExpr: '',
  tz: 'Asia/Shanghai',
  prompt: '',
  modelConfig: {},
  notifyChannels: ['webui'],
  timeoutSec: 600,
  enabled: false,
  thinking: false,
  model: '',
});

async function load() {
  loading.value = true;
  try {
    tasks.value = await api.listTasks();
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editingId.value = null;
  Object.assign(form, {
    name: '',
    description: '',
    cronExpr: '',
    tz: 'Asia/Shanghai',
    prompt: '',
    notifyChannels: ['webui'] as NotifyChannel[],
    timeoutSec: 600,
    enabled: false,
    thinking: false,
    model: '',
  });
  dialog.value = true;
}

function openEdit(t: ScheduledTask) {
  editingId.value = t.id;
  Object.assign(form, {
    name: t.name,
    description: t.description ?? '',
    cronExpr: t.cronExpr ?? '',
    tz: t.tz,
    prompt: t.prompt,
    notifyChannels: [...t.notifyChannels],
    timeoutSec: t.timeoutSec,
    enabled: t.enabled,
    thinking: t.modelConfig.thinking ?? false,
    model: t.modelConfig.model ?? '',
  });
  dialog.value = true;
}

async function save() {
  const body: ScheduledTaskInput = {
    name: form.name,
    description: form.description,
    cronExpr: form.cronExpr || null,
    tz: form.tz,
    prompt: form.prompt,
    modelConfig: {
      thinking: form.thinking,
      model: form.model || undefined,
      maxSteps: form.modelConfig.maxSteps,
    },
    notifyChannels: form.notifyChannels,
    timeoutSec: form.timeoutSec,
    enabled: form.enabled,
  };
  if (editingId.value) await api.updateTask(editingId.value, body);
  else await api.createTask(body);
  dialog.value = false;
  ElMessage.success('已保存');
  await load();
}

async function toggle(t: ScheduledTask) {
  await api.updateTask(t.id, { enabled: !t.enabled });
  await load();
}

async function trigger(t: ScheduledTask) {
  await api.triggerTask(t.id);
  ElMessage.success('已触发，去「运行 / 复盘」查看进度');
}

async function remove(t: ScheduledTask) {
  await ElMessageBox.confirm(`确认删除任务「${t.name}」?`, '确认', { type: 'warning' });
  await api.deleteTask(t.id);
  ElMessage.success('已删除');
  await load();
}

const fmt = (s?: string | null) => (s ? dayjs(s).format('MM-DD HH:mm') : '-');

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">定时任务</div>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon style="margin-right: 6px"><Plus /></el-icon>新建任务
      </el-button>
    </div>
    <div class="page-sub">迁移自 openclaw 的股票任务默认禁用，核对后启用 · 时区 Asia/Shanghai</div>
    <el-table :data="tasks" v-loading="loading" stripe>
      <el-table-column prop="name" label="名称" min-width="180" />
      <el-table-column prop="cronExpr" label="Cron" width="130">
        <template #default="{ row }">{{ row.cronExpr || '手动' }}</template>
      </el-table-column>
      <el-table-column label="下次运行" width="120">
        <template #default="{ row }">{{ fmt(row.nextRunAt) }}</template>
      </el-table-column>
      <el-table-column label="推送" width="140">
        <template #default="{ row }">
          <el-tag
            v-for="c in row.notifyChannels"
            :key="c"
            size="small"
            style="margin-right: 4px"
            >{{ c }}</el-tag
          >
        </template>
      </el-table-column>
      <el-table-column label="启用" width="80">
        <template #default="{ row }">
          <el-switch :model-value="row.enabled" @change="toggle(row)" />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="220" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="trigger(row)">触发</el-button>
          <el-button size="small" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog
      v-model="dialog"
      :title="editingId ? '编辑任务' : '新建任务'"
      width="680px"
    >
      <el-form label-width="100px">
        <el-form-item label="名称">
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" />
        </el-form-item>
        <el-form-item label="Cron 表达式">
          <el-input v-model="form.cronExpr" placeholder="如 45 14 * * 1-5，留空仅手动" />
        </el-form-item>
        <el-form-item label="时区">
          <el-input v-model="form.tz" />
        </el-form-item>
        <el-form-item label="Prompt">
          <el-input v-model="form.prompt" type="textarea" :rows="5" />
        </el-form-item>
        <el-form-item label="推送渠道">
          <el-checkbox-group v-model="form.notifyChannels">
            <el-checkbox value="webui">WebUI</el-checkbox>
            <el-checkbox value="telegram">Telegram</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="超时(秒)">
          <el-input-number v-model="form.timeoutSec" :min="30" :max="1800" />
        </el-form-item>
        <el-form-item label="模型覆盖">
          <el-input v-model="form.model" placeholder="留空用全局设置" />
        </el-form-item>
        <el-form-item label="开启推理">
          <el-switch v-model="form.thinking" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
