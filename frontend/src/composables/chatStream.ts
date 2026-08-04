import { computed, nextTick, onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { openWs } from '@/api';
import { applyStepEvent, type Step } from '@/composables/agentTrace';
import type { StreamEvent, SymbolPlanHorizon } from '@stock-agent/shared';

/** 对话气泡：用户为纯文本，助手按 agent 轨迹步序渲染 */
export interface UIMsg {
  role: 'user' | 'assistant';
  content: string;
  steps: Step[];
}

const THINKING_KEY = 'sa_chat_thinking';

export interface SendOptions {
  /**
   * 直接发这段内容，不取输入框、也不清空输入框。
   * 快捷按钮用它，避免把用户正在打的草稿冲掉。
   */
  content?: string;
  /**
   * 一键生成标的计划的车道。后端据此注入钉死 horizon 的标准指令，
   * 落库与气泡里仍只是用户那句短话。
   */
  planIntent?: SymbolPlanHorizon;
}

export interface ChatStreamOptions {
  /** 取当前会话 id；返回 null 时由 ensureSession 补建 */
  sessionId: () => string | null;
  /** 会话不存在时创建并返回 id（全局聊天页新建会话 / 标的会话 find-or-create） */
  ensureSession: () => Promise<string>;
  /** 一轮运行收尾（含中止与出错）后回调：用于刷新会话列表、重载 K 线标注等 */
  onRunFinished?: () => void;
}

/**
 * /ws/chat 流式多轮对话：连接管理、断线重连、事件归约、上下文预算、中止。
 * 全局聊天页与标的详情对话栏共用，两处只负责各自的会话选取与布局。
 */
export function useChatStream(opts: ChatStreamOptions) {
  const messages = ref<UIMsg[]>([]);
  const input = ref('');
  const busy = ref(false);
  /** 深思开关：默认开启，记忆用户选择 */
  const deepThinking = ref<boolean>(localStorage.getItem(THINKING_KEY) !== '0');
  // 上下文预算（来自后端 context 事件，展示本轮 token 占用 / 窗口 / 是否触发压缩）
  const ctxUsed = ref(0);
  const ctxWindow = ref(0);
  const ctxCompacted = ref(false);
  const ctxPct = computed(() =>
    ctxWindow.value > 0 ? Math.min(100, Math.round((ctxUsed.value / ctxWindow.value) * 100)) : 0,
  );
  const listRef = ref<HTMLElement | null>(null);

  let ws: WebSocket | null = null;
  // 当前 run 是否已正常收尾（run_finished）；用于区分「正常结束的断开」与「run 中途断开」
  let runFinished = true;
  // 主动关闭（卸载组件）标记，避免触发自动重连
  let closingByUser = false;
  // 重连退避与句柄：无退避的每秒重连在后端挂掉或 token 失效时会一直打
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryCount = 0;
  const RETRY_BASE_MS = 1000;
  const RETRY_MAX_MS = 30_000;
  const RETRY_MAX_TIMES = 8;
  /**
   * run 世代号。切会话或新建会话时自增，使旧 run 作废。
   * 不能用「当前 sessionId 是否等于发起时的 sessionId」判断归属——
   * 它区分不了「旧 run 的迟到事件」和「新 run 的事件」，切回原会话时还会误判。
   */
  let runGen = 0;
  /** 当前 socket 上正在接收的 run 属于哪一代；0 表示没有在飞 run */
  let activeGen = 0;
  /** 握手期间挂起的发送，切会话时要能取消 */
  let pendingSend: AbortController | null = null;

  function toggleThinking(v: boolean): void {
    localStorage.setItem(THINKING_KEY, v ? '1' : '0');
  }

  /** 取末尾 assistant 消息（流式写入目标） */
  function lastAssistant(): UIMsg | null {
    const last = messages.value[messages.value.length - 1];
    return last?.role === 'assistant' ? last : null;
  }

  function scrollBottom(): void {
    void nextTick(() => {
      if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight;
    });
  }

  function connectWs(): void {
    // 允许 disconnect 之后再次连接（弹窗关闭再打开），否则自动重连会被永久禁用
    closingByUser = false;
    // 先关掉旧连接：直接覆盖引用会留下一条前端够不到、也永不关闭的孤儿连接，
    // 它的 onmessage 仍绑在同一批响应式 state 上，会造成重复写入。
    if (ws) {
      const stale = ws;
      stale.onmessage = null;
      stale.onclose = null;
      stale.onerror = null;
      try {
        stale.close();
      } catch {
        /* 已关闭时忽略 */
      }
    }
    ws = openWs('/ws/chat');
    ws.onopen = () => {
      retryCount = 0;
    };
    ws.onmessage = (ev) => {
      // 非 JSON 帧（心跳/代理注入等）不能让异常从事件回调抛出：
      // 那样后面的归约全被跳过，busy 也不会结束，气泡会永远卡在「运行中」。
      let e: StreamEvent;
      try {
        e = JSON.parse(ev.data) as StreamEvent;
      } catch {
        console.warn('[chatStream] 收到非 JSON 帧，已忽略');
        return;
      }
      // 本轮 run 是否已被切会话作废。内容类事件必须丢弃，
      // 但 run_finished / error 这类收尾事件要照常处理，否则 busy 会永久卡在「运行中」。
      const stale = activeGen !== runGen;

      if (e.type === 'run_finished') {
        if (!stale && e.status === 'canceled') {
          // 用户停止：补一句占位，避免空气泡
          const cur = lastAssistant();
          if (cur && !cur.content.trim()) cur.steps.push({ kind: 'text', content: '(已停止)' });
        }
        runFinished = true;
        busy.value = false;
        activeGen = 0;
        if (!stale) opts.onRunFinished?.();
        return;
      }
      if (e.type === 'error') {
        if (!stale) ElMessage.error(e.message);
        runFinished = true;
        busy.value = false;
        activeGen = 0;
        // 出错前 agent 可能已经落库了标注或计划，同样要通知调用方刷新
        if (!stale) opts.onRunFinished?.();
        return;
      }

      if (stale) return; // 以下都是内容类事件，作废的 run 一律丢弃
      if (e.type === 'context') {
        ctxUsed.value = e.usedTokens;
        ctxWindow.value = e.contextWindow;
        ctxCompacted.value = e.compacted;
        return;
      }
      // 轨迹类事件（token/reasoning/tool_call/tool_result）交由共享归约器累积
      const msg = lastAssistant();
      if (!msg) return;
      applyStepEvent(msg.steps, e);
      if (e.type === 'token') msg.content += e.text;
      if (e.type === 'token' || e.type === 'reasoning' || e.type === 'tool_call') scrollBottom();
    };
    ws.onerror = () => {
      // 中断收尾（提示/清理/重连）统一在 onclose 处理，onerror 后必触发 onclose，避免重复弹窗
    };
    ws.onclose = () => {
      // run 进行中被动断开（如后端热重启）：给出提示并清理半截气泡，避免空白卡死
      if (busy.value && !runFinished) {
        const msg = lastAssistant();
        if (msg && !msg.content.trim()) {
          msg.steps.push({ kind: 'text', content: '(连接中断，未完成，请重发)' });
        }
        ElMessage.error('连接中断，回答未完成，请重新发送');
      }
      busy.value = false;
      // 非主动关闭时静默重连，便于后端重启后下一条无感续上。
      // 指数退避 + 次数上限：token 失效或后端长期不可用时，每秒重连只会一直打无效握手。
      if (closingByUser) return;
      if (retryCount >= RETRY_MAX_TIMES) {
        ElMessage.error('连接多次失败，请刷新页面重试');
        return;
      }
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** retryCount);
      retryCount += 1;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!closingByUser && (!ws || ws.readyState === WebSocket.CLOSED)) connectWs();
      }, delay);
    };
  }

  /** 停止当前运行：通知后端 abort 在飞 run（及时止损省 token） */
  function stop(): void {
    if (!busy.value) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'stop' }));
    }
  }

  async function send(sendOpts?: SendOptions): Promise<void> {
    // 指定了内容就发指定的那份，输入框里的草稿原样留着
    const override = sendOpts?.content;
    const content = (override ?? input.value).trim();
    if (!content || busy.value) return;
    let sessionId: string;
    try {
      sessionId = opts.sessionId() ?? (await opts.ensureSession());
    } catch (e) {
      // 会话建不出来（后端未更新 / 接口 404 / 鉴权失效）时明确报错，
      // 否则点发送毫无反应，无从判断是前端卡住还是后端问题
      ElMessage.error(`会话初始化失败，无法发送：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // CONNECTING 时不能重连：那会丢弃正在握手的连接、白建一条。只有确实已断才重建。
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      connectWs();
    }
    // 用户主动发送视为一次新的连接意图，重置退避计数，
    // 否则后端曾长时间不可用后计数打满，手动重试一次失败就再也不会自动重连
    retryCount = 0;
    activeGen = ++runGen;
    const thinking = deepThinking.value;
    const planIntent = sendOpts?.planIntent;
    messages.value.push({ role: 'user', content, steps: [] });
    messages.value.push({ role: 'assistant', content: '', steps: [] });
    if (override == null) input.value = '';
    runFinished = false;
    busy.value = true;
    scrollBottom();

    // 捕获当时的 socket 实例：握手期间若换过连接，不能对新 socket 发旧内容
    const target = ws!;
    const gen = activeGen;
    const trySend = (): void => {
      // 切会话已把这轮作废，或连接已被替换，就不要再发出去凭空起一轮 run
      if (gen !== runGen || target.readyState !== WebSocket.OPEN) return;
      target.send(JSON.stringify({ sessionId, content, thinking, planIntent }));
    };
    if (target.readyState === WebSocket.OPEN) {
      trySend();
      return;
    }
    pendingSend?.abort();
    pendingSend = new AbortController();
    target.addEventListener('open', trySend, { once: true, signal: pendingSend.signal });
  }

  /** 供外部关闭连接（弹窗关闭等场景） */
  function disconnect(): void {
    closingByUser = true;
    pendingSend?.abort();
    pendingSend = null;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    ws?.close();
    ws = null;
  }

  /**
   * 切换会话（如 K 线弹窗换标的）：作废在飞 run 并尽力通知后端中止。
   * 只递增世代号使旧 run 的内容事件失效——不能清空标记，那等于把过滤器自己关掉，
   * 旧 run 的 token 又会追加到新标的的历史气泡上。
   */
  function abortForSessionSwitch(): void {
    pendingSend?.abort();
    pendingSend = null;
    // stop() 只在 ws 为 OPEN 时发得出去；发不出去也没关系，世代号已让旧事件失效
    if (busy.value) stop();
    runGen += 1;
    busy.value = false;
    runFinished = true;
  }

  onUnmounted(disconnect);

  return {
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
    disconnect,
    abortForSessionSwitch,
    scrollBottom,
    send,
    stop,
  };
}
