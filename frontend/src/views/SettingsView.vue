<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '@/api';
import type { AppSettings } from '@stock-agent/shared';

const loading = ref(false);
const testing = ref(false);
const settings = ref<AppSettings | null>(null);

// 表单：留空表示不修改对应敏感字段
const form = reactive({
  llmBaseUrl: '',
  llmModel: '',
  llmApiKey: '',
  emApiKey: '',
  mxApiKey: '',
  telegramBotToken: '',
  telegramChatId: '',
  telegramThreadId: '',
  ovBaseUrl: '',
  ovApiKey: '',
  ovAccount: '',
  ovUser: '',
  ovEventsPrefix: '',
});

async function load() {
  settings.value = await api.getSettings();
  form.llmBaseUrl = settings.value.llmBaseUrl;
  form.llmModel = settings.value.llmModel;
  form.telegramChatId = settings.value.telegramChatId;
  form.telegramThreadId = settings.value.telegramThreadId;
  form.ovBaseUrl = settings.value.ovBaseUrl;
  form.ovAccount = settings.value.ovAccount;
  form.ovUser = settings.value.ovUser;
  form.ovEventsPrefix = settings.value.ovEventsPrefix;
}

async function save() {
  loading.value = true;
  try {
    const patch: Record<string, string> = {
      llmBaseUrl: form.llmBaseUrl,
      llmModel: form.llmModel,
      telegramChatId: form.telegramChatId,
      telegramThreadId: form.telegramThreadId,
      ovBaseUrl: form.ovBaseUrl,
      ovAccount: form.ovAccount,
      ovUser: form.ovUser,
      ovEventsPrefix: form.ovEventsPrefix,
    };
    // 敏感字段仅在填写了新值时提交
    if (form.llmApiKey) patch.llmApiKey = form.llmApiKey;
    if (form.emApiKey) patch.emApiKey = form.emApiKey;
    if (form.mxApiKey) patch.mxApiKey = form.mxApiKey;
    if (form.telegramBotToken) patch.telegramBotToken = form.telegramBotToken;
    if (form.ovApiKey) patch.ovApiKey = form.ovApiKey;
    settings.value = await api.updateSettings(patch);
    form.llmApiKey = '';
    form.emApiKey = '';
    form.mxApiKey = '';
    form.telegramBotToken = '';
    form.ovApiKey = '';
    ElMessage.success('已保存');
  } finally {
    loading.value = false;
  }
}

async function test() {
  testing.value = true;
  try {
    const r = await api.testLLM();
    r.ok ? ElMessage.success(r.message) : ElMessage.error(r.message);
  } finally {
    testing.value = false;
  }
}

function tag(set: boolean) {
  return set ? '已配置' : '未配置';
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head"><div class="page-title">设置</div></div>
    <div class="page-sub">密钥保存在本地 SQLite，仅返回是否已配置；留空表示不修改</div>
    <el-form v-if="settings" label-width="140px" style="max-width: 640px">
      <el-divider content-position="left">模型（OpenAI 兼容，任意服务）</el-divider>
      <el-form-item label="Base URL">
        <el-input v-model="form.llmBaseUrl" placeholder="https://your-gateway/v1" />
      </el-form-item>
      <el-form-item label="模型">
        <el-input v-model="form.llmModel" placeholder="如 gpt-4o-mini / deepseek-chat / 自定义" />
      </el-form-item>
      <el-form-item label="API Key">
        <el-input
          v-model="form.llmApiKey"
          type="password"
          show-password
          :placeholder="tag(settings.llmApiKeySet)"
        />
      </el-form-item>

      <el-divider content-position="left">妙想（东方财富）</el-divider>
      <el-form-item label="EM_API_KEY">
        <el-input
          v-model="form.emApiKey"
          type="password"
          show-password
          :placeholder="tag(settings.emApiKeySet)"
        />
      </el-form-item>
      <el-form-item label="MX_APIKEY">
        <el-input
          v-model="form.mxApiKey"
          type="password"
          show-password
          :placeholder="tag(settings.mxApiKeySet)"
        />
      </el-form-item>

      <el-divider content-position="left">Telegram</el-divider>
      <el-form-item label="Bot Token">
        <el-input
          v-model="form.telegramBotToken"
          type="password"
          show-password
          :placeholder="tag(settings.telegramBotTokenSet)"
        />
      </el-form-item>
      <el-form-item label="Chat ID">
        <el-input v-model="form.telegramChatId" />
      </el-form-item>
      <el-form-item label="Thread ID">
        <el-input v-model="form.telegramThreadId" placeholder="可选，话题 id" />
      </el-form-item>

      <el-divider content-position="left">真实持仓（OpenViking）</el-divider>
      <el-form-item label="Base URL">
        <el-input v-model="form.ovBaseUrl" placeholder="http://192.168.31.144:9109" />
      </el-form-item>
      <el-form-item label="API Key">
        <el-input
          v-model="form.ovApiKey"
          type="password"
          show-password
          :placeholder="tag(settings.ovApiKeySet)"
        />
      </el-form-item>
      <el-form-item label="Account / User">
        <el-input v-model="form.ovAccount" style="width: 49%" placeholder="user" />
        <el-input v-model="form.ovUser" style="width: 49%; margin-left: 2%" placeholder="default" />
      </el-form-item>
      <el-form-item label="快照 URI 前缀">
        <el-input v-model="form.ovEventsPrefix" placeholder="viking://user/default/memories/events" />
      </el-form-item>

      <el-form-item>
        <el-button type="primary" :loading="loading" @click="save">保存</el-button>
        <el-button :loading="testing" @click="test">测试模型连通性</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>
