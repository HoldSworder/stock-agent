import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { StreamEvent, TaskRun } from '@stock-agent/shared';
import { api, openWs } from '@/api';
import { createWsRetry } from '@/composables/wsRetry';

// 全局 Agent 运行状态：维护 /ws/runs 长连接，聚合最近运行记录，
// 供侧栏入口展示「运行中」数量与运行列表抽屉下钻。
export const useAgentsStore = defineStore('agents', () => {
  const runs = ref<TaskRun[]>([]);
  const connected = ref(false);

  const running = computed(() => runs.value.filter((r) => r.status === 'running'));
  const runningCount = computed(() => running.value.length);
  // 历史运行：已结束（成功/失败/超时等）的运行，store.runs 已按 startedAt 倒序，直接过滤即可
  const history = computed(() => runs.value.filter((r) => r.status !== 'running'));

  let ws: WebSocket | null = null;
  const retry = createWsRetry('Agent 运行状态');

  async function loadRuns() {
    try {
      runs.value = await api.listRuns();
    } catch {
      /* 拉取失败保留旧数据 */
    }
  }

  function handle(e: StreamEvent) {
    // 仅在运行开始/结束时刷新，忽略 token / tool 等高频事件
    if (e.type === 'run_started' || e.type === 'run_finished') {
      void loadRuns();
    }
  }

  /**
   * @param fromRetry 是否由退避重连触发。store 是单例，退避计数跨页面存活，
   *   用户主动连接算一次新的连接意图，必须重置计数，否则打满上限后再也不会重连。
   */
  function openSocket(fromRetry = false) {
    if (!fromRetry) retry.reset();
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = openWs('/ws/runs');
    ws.onopen = () => {
      connected.value = true;
      retry.reset();
    };
    ws.onmessage = (ev) => {
      try {
        handle(JSON.parse(ev.data) as StreamEvent);
      } catch {
        /* 忽略坏帧 */
      }
    };
    ws.onclose = () => {
      connected.value = false;
      retry.schedule(() => openSocket(true));
    };
    ws.onerror = () => ws?.close();
  }

  async function connect() {
    await loadRuns();
    openSocket();
  }

  function disconnect() {
    retry.cancel();
    if (ws) {
      // 主动断开：先摘除处理器，避免 onclose 重新调度重连导致断开后仍僵尸重连
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = null;
    }
    connected.value = false;
  }

  return {
    runs,
    connected,
    running,
    runningCount,
    history,
    connect,
    disconnect,
    refresh: loadRuns,
  };
});
