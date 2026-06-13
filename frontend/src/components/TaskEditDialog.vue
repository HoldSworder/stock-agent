<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '@/api';
import type {
  NotifyChannel,
  ScheduledTask,
  ScheduledTaskInput,
  StrategyListItem,
} from '@stock-agent/shared';

const props = defineProps<{
  modelValue: boolean;
  /** 编辑的任务；为 null 表示新建 */
  task: ScheduledTask | null;
  /** 战法列表（用于「绑定战法」下拉） */
  strategies: StrategyListItem[];
  /** 锁定绑定战法 id：存在时强制绑定该战法并隐藏选择器 */
  lockedStrategyId?: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'saved'): void;
}>();

const saving = ref(false);

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
  strategyId: null,
  thinking: false,
  model: '',
});

/** 弹窗打开时根据 task / lockedStrategyId 初始化表单 */
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    const t = props.task;
    Object.assign(form, {
      name: t?.name ?? '',
      description: t?.description ?? '',
      cronExpr: t?.cronExpr ?? '',
      tz: t?.tz ?? 'Asia/Shanghai',
      prompt: t?.prompt ?? '',
      modelConfig: t?.modelConfig ?? {},
      notifyChannels: t ? [...t.notifyChannels] : (['webui'] as NotifyChannel[]),
      timeoutSec: t?.timeoutSec ?? 600,
      enabled: t?.enabled ?? false,
      strategyId: props.lockedStrategyId ?? t?.strategyId ?? null,
      thinking: t?.modelConfig.thinking ?? false,
      model: t?.modelConfig.model ?? '',
    });
  },
  { immediate: true },
);

function close() {
  emit('update:modelValue', false);
}

async function save() {
  if (!form.name.trim()) return ElMessage.warning('请输入任务名称');
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
    strategyId: props.lockedStrategyId ?? form.strategyId ?? null,
  };
  saving.value = true;
  try {
    if (props.task) await api.updateTask(props.task.id, body);
    else await api.createTask(body);
    ElMessage.success('已保存');
    emit('saved');
    close();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="task ? '编辑任务' : '新建任务'"
    width="680px"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
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
      <el-form-item v-if="!lockedStrategyId" label="绑定战法">
        <el-select
          v-model="form.strategyId"
          clearable
          placeholder="不绑定（不挂载模拟下单工具）"
          style="width: 100%"
        >
          <el-option
            v-for="s in strategies"
            :key="s.strategy.id"
            :label="s.strategy.name"
            :value="s.strategy.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="开启推理">
        <el-switch v-model="form.thinking" />
      </el-form-item>
      <el-form-item label="启用">
        <el-switch v-model="form.enabled" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>
