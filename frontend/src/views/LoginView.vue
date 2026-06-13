<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, setToken } from '@/api';

const route = useRoute();
const router = useRouter();

const password = ref('');
const loading = ref(false);
// 首次未设密码时进入引导设密模式
const bootstrap = ref(false);
const confirm = ref('');

onMounted(async () => {
  try {
    const s = await api.authStatus();
    bootstrap.value = !s.enabled;
  } catch {
    /* 状态获取失败按已启用处理 */
  }
});

function redirectTarget(): string {
  const r = route.query.redirect;
  return typeof r === 'string' && r.startsWith('/') ? r : '/';
}

async function submit() {
  if (!password.value) {
    ElMessage.warning('请输入密码');
    return;
  }
  loading.value = true;
  try {
    if (bootstrap.value) {
      if (password.value !== confirm.value) {
        ElMessage.warning('两次输入的密码不一致');
        return;
      }
      const r = await api.setPassword(password.value);
      setToken(r.token);
      ElMessage.success('已设置访问密码');
    } else {
      const r = await api.login(password.value);
      setToken(r.token);
    }
    router.replace(redirectTarget());
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '登录失败');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-card">
      <div class="brand">
        <div class="brand-mark">
          <span class="bar b1" />
          <span class="bar b2" />
          <span class="bar b3" />
        </div>
        <div class="brand-text">
          <div class="brand-name">选股 Agent</div>
          <div class="brand-tag">QUANT TERMINAL</div>
        </div>
      </div>

      <div class="title">{{ bootstrap ? '设置访问密码' : '请输入访问密码' }}</div>
      <div class="sub">
        {{ bootstrap ? '系统尚未设置密码，请设置后进入' : '本系统已启用访问保护' }}
      </div>

      <el-input
        v-model="password"
        type="password"
        show-password
        size="large"
        placeholder="密码"
        @keyup.enter="submit"
      />
      <el-input
        v-if="bootstrap"
        v-model="confirm"
        type="password"
        show-password
        size="large"
        placeholder="确认密码"
        class="confirm"
        @keyup.enter="submit"
      />

      <el-button
        type="primary"
        size="large"
        class="submit"
        :loading="loading"
        @click="submit"
      >
        {{ bootstrap ? '设置并进入' : '登 录' }}
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.login-wrap {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.login-card {
  width: 100%;
  max-width: 380px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 32px 28px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 26px;
}
.brand-mark {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 26px;
}
.brand-mark .bar {
  width: 5px;
  border-radius: 2px;
  background: var(--brand);
  box-shadow: 0 0 10px var(--brand-glow);
}
.brand-mark .b1 {
  height: 12px;
  background: var(--down);
  box-shadow: none;
}
.brand-mark .b2 {
  height: 24px;
}
.brand-mark .b3 {
  height: 17px;
  background: var(--up);
  box-shadow: none;
}
.brand-name {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 16px;
  letter-spacing: -0.01em;
}
.brand-tag {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.22em;
  color: var(--text-2);
}
.title {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 6px;
}
.sub {
  color: var(--text-2);
  font-size: 12.5px;
  margin-bottom: 22px;
}
.confirm {
  margin-top: 12px;
}
.submit {
  width: 100%;
  margin-top: 20px;
}
</style>
