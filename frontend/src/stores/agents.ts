import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { StreamEvent, TaskRun } from '@stock-agent/shared';
import { api, openWs } from '@/api';

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
  let reconnectTimer: number | null = null;

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

  function openSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = openWs('/ws/runs');
    ws.onopen = () => {
      connected.value = true;
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
      // 断线 5s 重连
      if (reconnectTimer == null) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          openSocket();
        }, 5000);
      }
    };
    ws.onerror = () => ws?.close();
  }

  async function connect() {
    await loadRuns();
    openSocket();
  }

  function disconnect() {
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      // 主动断开：先摘除处理器，避免 onclose 重新调度 5s 重连导致断开后仍僵尸重连
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
