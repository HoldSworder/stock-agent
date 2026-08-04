<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '@/api';
import AgentTrace from '@/components/AgentTrace.vue';
import { useChatStream, type UIMsg } from '@/composables/chatStream';
import type { Step } from '@/composables/agentTrace';
import type { ChatMessage, SymbolPlanHorizon } from '@stock-agent/shared';

/**
 * 标的专属对话栏：按 code find-or-create 一个长期跟踪会话，历史随标的常驻。
 * agent 在此对话中可用 add_kline_mark 往 K 线图打点，一轮结束后 emit 通知父组件重载标注。
 */
const props = defineProps<{ code: string; name?: string }>();
const emit = defineEmits<{ marksChanged: [] }>();

const sessionId = ref<string | null>(null);
const loading = ref(false);
/** 会话加载失败原因（如后端未更新导致接口 404），非空时在面板内显式提示 */
const loadError = ref('');

const {
  messages,
  input,
  busy,
  deepThinking,
  ctxWindow,
  ctxUsed,
  ctxCompacted,
  ctxPct,
  listRef,
  toggleThinking,
  connectWs,
  abortForSessionSwitch,
  scrollBottom,
  send,
  stop,
} = useChatStream({
  sessionId: () => sessionId.value,
  // 会话在切标的时已预建，理论上不会走到这里；兜底再取一次并回写，
  // 不回写的话后续「当前会话」判定会一直看到 null
  ensureSession: async () => {
    const s = await api.sessionBySymbol(props.code, props.name);
    sessionId.value = s.id;
    return s.id;
  },
  // 一轮结束后拉一次标注：agent 可能刚在图上打了点
  onRunFinished: () => emit('marksChanged'),
});

/**
 * 当前这次会话加载的 promise。genPlan 从计划页签跳过来时可能赶在加载完成前触发，
 * 不等它会被 `messages.value = []` 把刚推入的气泡清掉。
 */
let loadPromise: Promise<void> = Promise.resolve();

/**
 * 请求令牌：连续切标的时先发后到的响应必须整体丢弃，
 * 否则旧标的的 sessionId / 历史消息会覆盖新面板，之后发的消息会落到上一只票的会话里。
 */
let loadToken = 0;

/** 切标的：取该标的会话并回放历史消息 */
async function loadSymbolSession(): Promise<void> {
  if (!props.code) return;
  const t = ++loadToken;
  // 先中止上一个标的在飞的 run：否则它的流式 token 会继续追加到新标的的历史气泡上
  abortForSessionSwitch();
  loading.value = true;
  loadError.value = '';
  messages.value = [];
  sessionId.value = null;
  try {
    const s = await api.sessionBySymbol(props.code, props.name);
    if (t !== loadToken) return;
    sessionId.value = s.id;
    const list: ChatMessage[] = await api.listMessages(s.id);
    if (t !== loadToken) return;
    messages.value = list
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map<UIMsg>((m) => {
        const role = m.role as 'user' | 'assistant';
        // 历史消息不含轨迹：assistant 映射为单个 text 步骤渲染
        const steps: Step[] = role === 'assistant' ? [{ kind: 'text', content: m.content }] : [];
        return { role, content: m.content, steps };
      });
    scrollBottom();
  } catch (e) {
    if (t !== loadToken) return;
    // 会话取不到时显式呈现，避免面板看着正常但发送无反应
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (t === loadToken) loading.value = false;
  }
}

/** 常用追问，点一下即发，省得每次手打。生成计划走下方的常驻快捷按钮 */
const QUICK_ASKS = ['复核当前计划哪些条件已触发或失效', '仅更新量价与关键位置，不改原计划'];

function quickAsk(text: string): void {
  if (busy.value) return;
  void send({ content: text });
}

/** 一键生成计划的两条车道：气泡里只显示短句，完整指令由后端按 planIntent 注入 */
const PLAN_BUTTONS: Array<{ horizon: SymbolPlanHorizon; label: string; ask: string }> = [
  { horizon: 'next_session', label: '下一交易日计划', ask: '生成下一交易日的技术交易计划' },
  { horizon: 'swing', label: '1~4周波段计划', ask: '生成未来 1~4 周波段的技术交易计划' },
];

/**
 * 生成指定车道的计划。供本组件按钮与父组件（计划页签空状态）调用。
 * 本组件按钮 busy 时已置灰，但父组件那两个按钮够不到这个状态，
 * 所以在飞时要出声——否则用户点完只看到页签切过去、没有新气泡，像是点了个坏按钮。
 */
async function genPlan(horizon: SymbolPlanHorizon): Promise<void> {
  // 父组件刚切过来时会话可能还在建，等它落定再发
  if (!busy.value) await loadPromise;
  if (busy.value) {
    ElMessage.warning('当前对话还在运行，等它结束或点「停止」后再生成');
    return;
  }
  const ask = PLAN_BUTTONS.find((b) => b.horizon === horizon)?.ask ?? '生成技术交易计划';
  await send({ content: ask, planIntent: horizon });
}

watch(
  () => props.code,
  () => {
    loadPromise = loadSymbolSession();
  },
  { immediate: true },
);
connectWs();

defineExpose({ genPlan });
</script>

<template>
  <div class="sym-chat">
    <div class="sym-chat__head">
      <span class="sym-chat__title">跟踪对话</span>
      <span class="sym-chat__sub">{{ code }} 专属会话 · 历史长期留存</span>
    </div>
    <div ref="listRef" v-loading="loading" class="sym-chat__list">
      <div v-if="loadError" class="sym-chat__error">
        会话加载失败：{{ loadError }}
        <div class="sym-chat__error-hint">后端可能未加载新接口，重启后端后重开弹窗即可。</div>
      </div>
      <div v-else-if="!messages.length" class="sym-chat__empty">
        <div class="sym-chat__empty-title">开始跟踪这只标的</div>
        <div class="sym-chat__empty-sub">
          分析结论可由 agent 直接标到左侧 K 线图上，长期留存供后续复核。
        </div>
        <div class="sym-chat__quick">
          <el-button
            v-for="q in QUICK_ASKS"
            :key="q"
            size="small"
            text
            bg
            class="sym-chat__quick-btn"
            @click="quickAsk(q)"
          >
            {{ q }}
          </el-button>
        </div>
      </div>
      <div v-for="(m, i) in messages" :key="i" class="sym-chat__msg" :class="m.role">
        <div class="sym-chat__bubble">
          <div v-if="m.role === 'user'" class="sym-chat__text">{{ m.content }}</div>
          <AgentTrace v-else :steps="m.steps" :busy="busy && i === messages.length - 1" />
        </div>
      </div>
    </div>
    <div class="sym-chat__composer">
      <div class="sym-chat__plan">
        <el-button
          v-for="b in PLAN_BUTTONS"
          :key="b.horizon"
          size="small"
          type="primary"
          plain
          :disabled="busy || loading"
          class="sym-chat__plan-btn"
          @click="genPlan(b.horizon)"
        >
          生成{{ b.label }}
        </el-button>
      </div>
      <el-input
        v-model="input"
        type="textarea"
        :rows="2"
        resize="none"
        placeholder="问点什么，回车发送，Shift+回车换行"
        @keydown.enter.exact.prevent="send()"
      />
      <div class="sym-chat__actions">
        <el-switch
          v-model="deepThinking"
          size="small"
          inline-prompt
          active-text="深思"
          inactive-text="深思"
          @change="toggleThinking"
        />
        <div
          v-if="ctxWindow > 0"
          class="sym-chat__ctx"
          :title="`上下文 ${ctxUsed} / ${ctxWindow} token`"
        >
          <div class="sym-chat__ctx-bar">
            <div class="sym-chat__ctx-fill" :style="{ width: ctxPct + '%' }" />
          </div>
          <span class="sym-chat__ctx-text">
            {{ ctxPct }}%<span v-if="ctxCompacted" class="sym-chat__ctx-tag">已压缩</span>
          </span>
        </div>
        <el-button v-if="busy" size="small" @click="stop">停止</el-button>
        <el-button v-else type="primary" size="small" @click="send()">发送</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sym-chat {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
  overflow: hidden;
}
.sym-chat__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.sym-chat__title {
  font-size: 13px;
  font-weight: 600;
  color: #cfd3dc;
}
.sym-chat__sub {
  font-size: 11px;
  color: var(--text-2);
}
.sym-chat__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sym-chat__empty {
  padding: 16px 4px;
  color: var(--text-2);
}
.sym-chat__error {
  padding: 12px 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-color-danger);
}
.sym-chat__error-hint {
  margin-top: 4px;
  color: var(--text-2);
}
.sym-chat__empty-title {
  font-size: 13px;
  font-weight: 600;
  color: #cfd3dc;
  margin-bottom: 4px;
}
.sym-chat__empty-sub {
  font-size: 12px;
  line-height: 1.6;
}
.sym-chat__quick {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}
.sym-chat__quick-btn {
  justify-content: flex-start;
  height: auto;
  padding: 7px 10px;
  white-space: normal;
  text-align: left;
  font-size: 12px;
  line-height: 1.5;
}
.sym-chat__msg {
  display: flex;
}
.sym-chat__msg.user {
  justify-content: flex-end;
}
.sym-chat__bubble {
  max-width: 92%;
  font-size: 12px;
  line-height: 1.65;
}
.sym-chat__msg.user .sym-chat__bubble {
  padding: 7px 10px;
  border-radius: 8px;
  background: rgba(31, 111, 235, 0.16);
  border: 1px solid rgba(31, 111, 235, 0.28);
}
.sym-chat__text {
  color: #cfd3dc;
  white-space: pre-wrap;
  word-break: break-word;
}
.sym-chat__composer {
  padding: 8px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.sym-chat__plan {
  display: flex;
  gap: 6px;
  margin-bottom: 7px;
}
.sym-chat__plan-btn {
  flex: 1;
  font-size: 12px;
}
.sym-chat__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 7px;
}
.sym-chat__ctx {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
}
.sym-chat__ctx-bar {
  width: 52px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
}
.sym-chat__ctx-fill {
  height: 100%;
  background: #1f6feb;
}
.sym-chat__ctx-text {
  font-size: 11px;
  color: var(--text-2);
}
.sym-chat__ctx-tag {
  margin-left: 4px;
  color: #ffb000;
}
</style>
