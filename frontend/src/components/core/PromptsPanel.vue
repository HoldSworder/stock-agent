<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, RefreshLeft } from '@element-plus/icons-vue';
import { api } from '@/api';
import type { PromptInfo } from '@stock-agent/shared';

// 全局提示词管理：把硬编码在 loop.ts 的三段提示词（基础 system / 深思指令 / 压缩器 system）
// 显式化为可查看 + 可覆盖。覆盖优先、留空回退代码默认，对所有 agent 运行全局生效。

const loading = ref(false);
const prompts = ref<PromptInfo[]>([]);
// 每段编辑草稿（key -> 文本；空串=清除覆盖回落默认）
const drafts = reactive<Record<string, string>>({});
const saving = reactive<Record<string, boolean>>({});

async function load(): Promise<void> {
  loading.value = true;
  try {
    prompts.value = await api.prompts.list();
    for (const p of prompts.value) drafts[p.key] = p.overridden ? p.content : '';
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function isDirty(p: PromptInfo): boolean {
  const current = p.overridden ? p.content : '';
  return (drafts[p.key] ?? '').trim() !== current.trim();
}

function replacePrompt(info: PromptInfo): void {
  const i = prompts.value.findIndex((p) => p.key === info.key);
  if (i >= 0) prompts.value[i] = info;
  drafts[info.key] = info.overridden ? info.content : '';
}

async function save(p: PromptInfo): Promise<void> {
  saving[p.key] = true;
  try {
    replacePrompt(await api.prompts.config(p.key, { content: drafts[p.key] ?? '' }));
    ElMessage.success(`${p.label} 已保存`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    saving[p.key] = false;
  }
}

async function restore(p: PromptInfo): Promise<void> {
  saving[p.key] = true;
  try {
    replacePrompt(await api.prompts.config(p.key, { content: '' }));
    ElMessage.success(`${p.label} 已恢复默认`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '恢复失败');
  } finally {
    saving[p.key] = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="prompts-panel">
    <div class="panel-head">
      <div class="panel-sub">
        约束所有 agent 行为的全局提示词。覆盖优先、留空即回退代码默认；保存后对尾盘 / 持仓 / 计划 / 对话 / 压缩等所有运行立即生效。
      </div>
      <el-button size="small" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-skeleton v-if="loading" :rows="6" animated style="margin-top: 16px" />

    <div v-else class="cards">
      <article v-for="p in prompts" :key="p.key" class="card">
        <header class="card-head">
          <div class="card-title">
            <span class="title-text">{{ p.label }}</span>
            <span class="key">{{ p.key }}</span>
            <span v-if="p.overridden" class="tag-override">已覆盖</span>
            <span v-else class="tag-default">默认</span>
          </div>
        </header>
        <div class="hint">{{ p.hint }}</div>

        <el-input
          v-model="drafts[p.key]"
          type="textarea"
          :autosize="{ minRows: 6, maxRows: 20 }"
          :placeholder="p.baseContent"
        />

        <div class="actions">
          <span v-if="isDirty(p)" class="dirty-hint">未保存</span>
          <el-button
            size="small"
            :icon="RefreshLeft"
            :disabled="!p.overridden || saving[p.key]"
            @click="restore(p)"
          >
            恢复默认
          </el-button>
          <el-button
            size="small"
            type="primary"
            :loading="saving[p.key]"
            :disabled="!isDirty(p)"
            @click="save(p)"
          >
            保存
          </el-button>
        </div>
      </article>
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
.cards {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 16px;
}
.card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-2);
  padding: 16px 18px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-title {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.title-text {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-0);
}
.key {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
}
.tag-override {
  font-size: 10.5px;
  color: var(--brand);
  border: 1px solid color-mix(in srgb, var(--brand) 45%, transparent);
  border-radius: 4px;
  padding: 0 5px;
}
.tag-default {
  font-size: 10.5px;
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
}
.hint {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.55;
  margin: 8px 0 12px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}
.dirty-hint {
  margin-right: auto;
  font-size: 11.5px;
  color: var(--brand-2);
  font-family: var(--font-mono);
}
</style>
