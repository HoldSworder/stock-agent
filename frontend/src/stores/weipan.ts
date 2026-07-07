import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { WeipanAlert, WeipanEvent, WeipanSignal, WeipanStatus } from '@stock-agent/shared';
import { api, openWs } from '@/api';

/** 信号流折叠行：按 code:reason 聚合，记录触发次数与首次时间 */
export interface WeipanSignalRow extends WeipanSignal {
  count: number;
  firstAt: string;
}

/** Asia/Shanghai 当前自然日 YYYY-MM-DD（信号流隔日清理用，与后端口径一致） */
function shanghaiToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// 尾盘套利确定性盯盘前端状态：维护 /ws/weipan 长连接，聚合状态/信号流/告警。
export const useWeipanStore = defineStore('weipan', () => {
  const status = ref<WeipanStatus | null>(null);
  const signals = ref<WeipanSignalRow[]>([]);
  const alerts = ref<WeipanAlert[]>([]);
  const connected = ref(false);

  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let feedDay = shanghaiToday();

  function rolloverIfNewDay(): void {
    const today = shanghaiToday();
    if (today !== feedDay) {
      feedDay = today;
      signals.value = [];
    }
  }

  function handle(e: WeipanEvent) {
    rolloverIfNewDay();
    if (e.type === 'status') status.value = e.status;
    else if (e.type === 'signal') {
      const sig = e.signal;
      const k = `${sig.code}:${sig.reason}`;
      const rest = signals.value.filter((r) => `${r.code}:${r.reason}` !== k);
      const prev = signals.value.find((r) => `${r.code}:${r.reason}` === k);
      const row: WeipanSignalRow = {
        ...sig,
        count: (prev?.count ?? 0) + 1,
        firstAt: prev?.firstAt ?? sig.at,
      };
      signals.value = [row, ...rest].slice(0, 100);
    } else if (e.type === 'alert') {
      alerts.value = [e.alert, ...alerts.value].slice(0, 100);
    }
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = openWs('/ws/weipan');
    ws.onopen = () => {
      connected.value = true;
    };
    ws.onmessage = (ev) => {
      try {
        handle(JSON.parse(ev.data) as WeipanEvent);
      } catch {
        /* 忽略坏帧 */
      }
    };
    ws.onclose = () => {
      connected.value = false;
      if (reconnectTimer == null) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 5000);
      }
    };
    ws.onerror = () => ws?.close();
  }

  function disconnect() {
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = null;
    }
    connected.value = false;
  }

  async function refresh() {
    const [st, al] = await Promise.all([api.weipan.status(), api.weipan.alerts(50, 'today')]);
    status.value = st;
    alerts.value = al;
  }

  return { status, signals, alerts, connected, connect, disconnect, refresh };
});
