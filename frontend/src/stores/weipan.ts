import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { WeipanAlert, WeipanEvent, WeipanSignal, WeipanStatus } from '@stock-agent/shared';
import { api, openWs } from '@/api';
import { createWsRetry } from '@/composables/wsRetry';

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
  const retry = createWsRetry('尾盘套利盯盘');
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

  /**
   * @param fromRetry 是否由退避重连触发。store 是单例，退避计数跨页面存活，
   *   用户主动进页面算一次新的连接意图，必须重置计数，否则打满上限后再进来永不重连。
   */
  function connect(fromRetry = false) {
    if (!fromRetry) retry.reset();
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = openWs('/ws/weipan');
    ws.onopen = () => {
      connected.value = true;
      retry.reset();
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
      retry.schedule(() => connect(true));
    };
    ws.onerror = () => ws?.close();
  }

  function disconnect() {
    retry.cancel();
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
