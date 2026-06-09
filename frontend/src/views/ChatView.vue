<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, openWs } from '@/api';
import type { ChatMessage, ChatSession, StreamEvent } from '@stock-agent/shared';

interface UIMsg {
  role: 'user' | 'assistant';
  content: string;
  tools?: string[];
}

const sessions = ref<ChatSession[]>([]);
const currentId = ref<string | null>(null);
const messages = ref<UIMsg[]>([]);
const input = ref('');
const busy = ref(false);
const listRef = ref<HTMLElement | null>(null);
let ws: WebSocket | null = null;

async function loadSessions() {
  sessions.value = await api.listSessions();
}

async function selectSession(id: string) {
  currentId.value = id;
  const list: ChatMessage[] = await api.listMessages(id);
  messages.value = list
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  scrollBottom();
}

async function newSession() {
  const s = await api.createSession();
  await loadSessions();
  await selectSession(s.id);
}

function scrollBottom() {
  nextTick(() => {
    if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight;
  });
}

function connectWs() {
  ws = openWs('/ws/chat');
  ws.onmessage = (ev) => {
    const e: StreamEvent = JSON.parse(ev.data);
    const last = messages.value[messages.value.length - 1];
    if (e.type === 'token') {
      if (last?.role === 'assistant') last.content += e.text;
      scrollBottom();
    } else if (e.type === 'tool_call') {
      if (last?.role === 'assistant') (last.tools ??= []).push(e.name);
    } else if (e.type === 'run_finished') {
      busy.value = false;
    } else if (e.type === 'error') {
      ElMessage.error(e.message);
      busy.value = false;
    }
  };
  ws.onclose = () => {
    busy.value = false;
  };
}

async function send() {
  const content = input.value.trim();
  if (!content || busy.value) return;
  if (!currentId.value) await newSession();
  if (!ws || ws.readyState !== WebSocket.OPEN) connectWs();
  messages.value.push({ role: 'user', content });
  messages.value.push({ role: 'assistant', content: '', tools: [] });
  input.value = '';
  busy.value = true;
  scrollBottom();

  const trySend = () => {
    ws!.send(JSON.stringify({ sessionId: currentId.value, content }));
  };
  if (ws!.readyState === WebSocket.OPEN) trySend();
  else ws!.addEventListener('open', trySend, { once: true });
}

onMounted(async () => {
  await loadSessions();
  if (sessions.value.length) await selectSession(sessions.value[0].id);
  connectWs();
});
onUnmounted(() => ws?.close());
</script>

<template>
  <div class="chat-shell">
    <aside class="sessions">
      <el-button type="primary" class="new-btn" @click="newSession">
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
          {{ s.title }}
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
            <div v-if="m.tools && m.tools.length" class="tools">
              <el-icon><Tools /></el-icon>{{ m.tools.join(' · ') }}
            </div>
            <div class="mono content">
              {{ m.content || (busy && i === messages.length - 1 ? '思考中…' : '') }}
            </div>
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
          @keydown.enter.exact.prevent="send"
        />
        <el-button type="primary" :loading="busy" class="send-btn" @click="send">
          发送
        </el-button>
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
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.session-item:hover {
  background: var(--bg-hover);
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
}
.tools {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-2);
  margin-bottom: 6px;
}

.composer {
  display: flex;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-2);
}
.send-btn {
  height: auto;
  align-self: stretch;
  padding-left: 22px;
  padding-right: 22px;
}
</style>
