<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '@/api';
import AgentTrace from '@/components/AgentTrace.vue';
import { useChatStream, type UIMsg } from '@/composables/chatStream';
import type { Step } from '@/composables/agentTrace';
import type { ChatMessage, ChatSession } from '@stock-agent/shared';

const sessions = ref<ChatSession[]>([]);
const currentId = ref<string | null>(null);

// 流式对话链路（连接/事件归约/上下文预算/中止）由共享 composable 承担，本页只管会话列表与布局
const {
  messages,
  input,
  busy,
  deepThinking,
  ctxUsed,
  ctxWindow,
  ctxCompacted,
  ctxPct,
  listRef,
  toggleThinking,
  connectWs,
  scrollBottom,
  send,
  stop,
} = useChatStream({
  sessionId: () => currentId.value,
  ensureSession: async () => {
    const s = await api.createSession();
    currentId.value = s.id;
    return s.id;
  },
  onRunFinished: () => void loadSessions(),
});

async function loadSessions() {
  sessions.value = await api.listSessions();
}

async function selectSession(id: string) {
  currentId.value = id;
  const list: ChatMessage[] = await api.listMessages(id);
  messages.value = list
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map<UIMsg>((m) => {
      const role = m.role as 'user' | 'assistant';
      // 历史消息不含轨迹：assistant 映射为单个 text 步骤渲染
      const steps: Step[] =
        role === 'assistant' ? [{ kind: 'text', content: m.content }] : [];
      return { role, content: m.content, steps };
    });
  scrollBottom();
}

function startNewSession() {
  currentId.value = null;
  messages.value = [];
}

async function removeSession(id: string) {
  await api.deleteSession(id);
  if (id === currentId.value) startNewSession();
  await loadSessions();
}

onMounted(async () => {
  await loadSessions();
  if (sessions.value.length) await selectSession(sessions.value[0].id);
  connectWs();
});
</script>

<template>
  <div class="chat-shell">
    <aside class="sessions">
      <el-button type="primary" class="new-btn" @click="startNewSession">
        <el-icon style="margin-right: 6px"><Plus /></el-icon>新对话
      </el-button>
      <div class="session-list">
        <div
          v-for="s in sessions"
          :key="s.id"
          class="session-item"
          :class="{ active: s.id === currentId }"
          @click="selectSession(s.id)"
        >
          <span class="session-title">{{ s.title }}</span>
          <el-icon class="del-icon" @click.stop="removeSession(s.id)"><Delete /></el-icon>
        </div>
        <div v-if="!sessions.length" class="empty">暂无会话</div>
      </div>
    </aside>
    <div class="conv">
      <main ref="listRef" class="msg-list">
        <div v-if="!messages.length" class="welcome">
          <div class="welcome-mark">◆</div>
          <div class="welcome-title">问点什么</div>
          <div class="welcome-sub">
            例如：帮我筛选今天尾盘有动能的机器人板块标的，带现价
          </div>
        </div>
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <div class="bubble">
            <!-- 用户消息：纯文本 -->
            <div v-if="m.role === 'user'" class="mono content">{{ m.content }}</div>
            <!-- 助手消息：按步序渲染 agent 轨迹（共享组件） -->
            <AgentTrace v-else :steps="m.steps" :busy="busy && i === messages.length - 1" />
          </div>
        </div>
      </main>
      <footer class="composer">
        <el-input
          v-model="input"
          type="textarea"
          :rows="2"
          resize="none"
          placeholder="问点什么，回车发送，Shift+回车换行"
          @keydown.enter.exact.prevent="send()"
        />
        <div class="composer-actions">
          <el-switch
            v-model="deepThinking"
            size="small"
            inline-prompt
            active-text="深思"
            inactive-text="深思"
            @change="toggleThinking"
          />
          <div v-if="ctxWindow > 0" class="ctx-budget" :title="`上下文 ${ctxUsed} / ${ctxWindow} token`">
            <div class="ctx-bar"><div class="ctx-fill" :style="{ width: ctxPct + '%' }" /></div>
            <span class="ctx-text">{{ ctxPct }}%<span v-if="ctxCompacted" class="ctx-tag">已压缩</span></span>
          </div>
          <el-button v-if="busy" class="send-btn" @click="stop">停止</el-button>
          <el-button v-else type="primary" class="send-btn" @click="send()">发送</el-button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.chat-shell {
  display: flex;
  height: 100%;
}
.sessions {
  width: 232px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  background: var(--bg-2);
}
.new-btn {
  width: 100%;
}
.session-list {
  margin-top: 12px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.session-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-1);
  transition: all 0.15s ease;
}
.session-item:hover {
  background: var(--bg-hover);
}
.session-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.del-icon {
  flex-shrink: 0;
  opacity: 0;
  color: var(--text-2);
  transition: opacity 0.15s ease, color 0.15s ease;
}
.session-item:hover .del-icon {
  opacity: 1;
}
.del-icon:hover {
  color: var(--danger, #f56c6c);
}
.session-item.active {
  background: var(--brand-soft);
  color: var(--brand);
}
.empty {
  color: var(--text-2);
  font-size: 12px;
  padding: 10px;
}

.conv {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.msg-list {
  flex: 1;
  overflow: auto;
  padding: 26px 8%;
}
.welcome {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-2);
}
.welcome-mark {
  font-size: 34px;
  color: var(--brand);
  text-shadow: 0 0 24px var(--brand-glow);
}
.welcome-title {
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 600;
  color: var(--text-0);
}
.welcome-sub {
  font-size: 13px;
  max-width: 360px;
  text-align: center;
}

.msg {
  display: flex;
  margin-bottom: 16px;
}
.msg.user {
  justify-content: flex-end;
}
.bubble {
  max-width: 78%;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  font-size: 14px;
  line-height: 1.6;
}
.msg.assistant .bubble {
  border-top-left-radius: 4px;
}
.msg.user .bubble {
  background: linear-gradient(135deg, rgba(240, 180, 41, 0.16), rgba(240, 180, 41, 0.08));
  border-color: rgba(240, 180, 41, 0.35);
  border-top-right-radius: 4px;
}
.content {
  font-family: var(--font-body);
  white-space: pre-wrap;
}

.composer {
  display: flex;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-2);
}
.composer-actions {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: space-between;
  gap: 8px;
}
.send-btn {
  flex: 1;
  height: auto;
  padding-left: 22px;
  padding-right: 22px;
}
.ctx-budget {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ctx-bar {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--border);
  overflow: hidden;
}
.ctx-fill {
  height: 100%;
  background: var(--brand, #f0b429);
  transition: width 0.3s ease;
}
.ctx-text {
  font-size: 10px;
  color: var(--text-2);
  white-space: nowrap;
}
.ctx-tag {
  margin-left: 4px;
  color: var(--brand, #f0b429);
}
</style>
