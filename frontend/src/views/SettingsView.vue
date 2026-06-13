<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, clearToken } from '@/api';
import type { AppSettings } from '@stock-agent/shared';

const router = useRouter();

const loading = ref(false);
const testing = ref(false);
const settings = ref<AppSettings | null>(null);

// 访问密码
const pwForm = reactive({ next: '', confirm: '' });
const pwLoading = ref(false);

async function savePassword() {
  if (!pwForm.next) {
    ElMessage.warning('请输入新密码');
    return;
  }
  if (pwForm.next !== pwForm.confirm) {
    ElMessage.warning('两次输入的密码不一致');
    return;
  }
  pwLoading.value = true;
  try {
    await api.setPassword(pwForm.next);
    clearToken();
    ElMessage.success('密码已更新，请重新登录');
    router.replace('/login');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '设置失败');
  } finally {
    pwLoading.value = false;
  }
}

// 系统级配置；各数据源凭据/启停已迁移到「数据源」页统一管理。
const form = reactive({
  llmBaseUrl: '',
  llmModel: '',
  llmLightModel: '',
  llmContextWindow: '',
  llmApiKey: '',
  telegramBotToken: '',
  telegramChatId: '',
  telegramThreadId: '',
  etfEnabled: 'true',
});

// 启用开关：DB 以 'true'/'false' 字符串存储，UI 用布尔切换
const etfEnabled = computed({
  get: () => form.etfEnabled !== 'false',
  set: (v: boolean) => {
    form.etfEnabled = v ? 'true' : 'false';
  },
});

function fill(s: AppSettings) {
  form.llmBaseUrl = s.llmBaseUrl;
  form.llmModel = s.llmModel;
  form.llmLightModel = s.llmLightModel;
  form.llmContextWindow = s.llmContextWindow;
  form.llmApiKey = s.llmApiKey;
  form.telegramBotToken = s.telegramBotToken;
  form.telegramChatId = s.telegramChatId;
  form.telegramThreadId = s.telegramThreadId;
  form.etfEnabled = s.etfEnabled || 'true';
}

async function load() {
  settings.value = await api.getSettings();
  fill(settings.value);
}

async function save() {
  loading.value = true;
  try {
    settings.value = await api.updateSettings({ ...form });
    fill(settings.value);
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

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head"><div class="page-title">设置</div></div>
    <div class="page-sub">
      系统级配置（模型 / Telegram / 访问密码）。各数据源凭据与启停已迁移至「数据源」页统一管理。
    </div>
    <el-form v-if="settings" label-position="top" class="s-form">
      <section class="s-card">
        <div class="s-card-head">
          <div class="s-card-title">模型</div>
          <div class="s-card-sub">OpenAI 兼容，任意服务</div>
        </div>
        <div class="s-grid">
          <el-form-item label="Base URL" class="s-full">
            <el-input v-model="form.llmBaseUrl" placeholder="https://your-gateway/v1" />
          </el-form-item>
          <el-form-item label="默认模型">
            <el-input v-model="form.llmModel" placeholder="如 gpt-4o-mini / deepseek-chat / 自定义" />
          </el-form-item>
          <el-form-item label="轻度模型">
            <el-input
              v-model="form.llmLightModel"
              placeholder="便宜模型名，用于盯盘初筛，留空=跳过初筛"
            />
          </el-form-item>
          <el-form-item label="上下文窗口(token)">
            <el-input
              v-model="form.llmContextWindow"
              placeholder="如 128000，超 75% 自动压缩历史，留空=默认 128000"
            />
          </el-form-item>
          <el-form-item label="API Key">
            <el-input v-model="form.llmApiKey" placeholder="未配置" />
          </el-form-item>
        </div>
      </section>

      <section class="s-card">
        <div class="s-card-head">
          <div class="s-card-title">Telegram</div>
          <div class="s-card-sub">通知推送</div>
        </div>
        <div class="s-grid">
          <el-form-item label="Bot Token" class="s-full">
            <el-input v-model="form.telegramBotToken" placeholder="未配置" />
          </el-form-item>
          <el-form-item label="Chat ID">
            <el-input v-model="form.telegramChatId" />
          </el-form-item>
          <el-form-item label="Thread ID">
            <el-input v-model="form.telegramThreadId" placeholder="可选，话题 id" />
          </el-form-item>
        </div>
      </section>

      <section class="s-card">
        <div class="s-card-head">
          <div class="s-card-title">ETF</div>
          <div class="s-card-sub">ETF 跟踪池与买卖信号模块</div>
        </div>
        <div class="s-grid">
          <el-form-item label="启用" class="s-full">
            <el-switch v-model="etfEnabled" active-text="开启" inactive-text="关闭" inline-prompt />
          </el-form-item>
        </div>
      </section>

      <section class="s-card">
        <div class="s-card-head">
          <div class="s-card-title">访问密码</div>
          <div class="s-card-sub">全局登录保护</div>
        </div>
        <div class="s-grid">
          <el-form-item label="新密码">
            <el-input v-model="pwForm.next" placeholder="留空不修改" />
          </el-form-item>
          <el-form-item label="确认新密码">
            <el-input v-model="pwForm.confirm" placeholder="再次输入" />
          </el-form-item>
          <el-form-item class="s-full">
            <el-button :loading="pwLoading" @click="savePassword">更新密码</el-button>
            <span class="hint" style="margin-left: 12px">更新后将退出登录，需用新密码重新进入</span>
          </el-form-item>
        </div>
      </section>

      <div class="s-actions">
        <el-button type="primary" :loading="loading" @click="save">保存</el-button>
        <el-button :loading="testing" @click="test">测试模型连通性</el-button>
      </div>
    </el-form>
  </div>
</template>

<style scoped>
.s-form {
  max-width: 880px;
}

.s-card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 18px;
  margin-bottom: 16px;
}

.s-card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-soft);
}
.s-card-title {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.s-card-sub {
  font-size: 12px;
  color: var(--text-2);
}

.s-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 18px;
}
.s-grid :deep(.el-form-item) {
  margin-bottom: 14px;
}
.s-grid :deep(.el-form-item:last-child) {
  margin-bottom: 0;
}
.s-full {
  grid-column: 1 / -1;
}

.s-actions {
  position: sticky;
  bottom: 0;
  display: flex;
  gap: 10px;
  padding: 14px 0;
  margin-top: 4px;
  background: linear-gradient(to top, var(--bg-1) 70%, transparent);
}

@media (max-width: 720px) {
  .s-grid {
    grid-template-columns: 1fr;
  }
}

.hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
}
.hint code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-1);
  font-size: 12px;
}
</style>
