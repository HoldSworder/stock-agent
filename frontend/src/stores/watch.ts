import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import type {
  WatchAlert,
  WatchEvent,
  WatchQuoteItem,
  WatchSignal,
  WatchStatus,
} from '@stock-agent/shared';
import { api, openWs } from '@/api';

/** 信号流折叠行：按 code:type 聚合，记录触发次数与首次时间 */
export interface WatchSignalRow extends WatchSignal {
  /** 该 code:type 自进入信号流以来的累计触发次数 */
  count: number;
  /** 首次触发时间 ISO */
  firstAt: string;
}

// 实时盯盘前端状态：维护 /ws/watch 长连接，聚合行情/信号流/告警/引擎状态。
export const useWatchStore = defineStore('watch', () => {
  const status = ref<WatchStatus | null>(null);
  const quotes = shallowRef<WatchQuoteItem[]>([]);
  const quotesAt = ref<string>('');
  const signals = ref<WatchSignalRow[]>([]);
  const alerts = ref<WatchAlert[]>([]);
  const connected = ref(false);

  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;

  function handle(e: WatchEvent) {
    if (e.type === 'status') status.value = e.status;
    else if (e.type === 'quotes') {
      quotes.value = e.items;
      quotesAt.value = e.at;
    } else if (e.type === 'signal') {
      // 按 code:type 折叠：命中同键则累计次数并刷新为最新状态后移到队首，否则新建
      const sig = e.signal;
      const k = `${sig.code}:${sig.type}`;
      const rest = signals.value.filter((r) => `${r.code}:${r.type}` !== k);
      const prev = signals.value.find((r) => `${r.code}:${r.type}` === k);
      const row: WatchSignalRow = {
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
    ws = openWs('/ws/watch');
    ws.onopen = () => {
      connected.value = true;
    };
    ws.onmessage = (ev) => {
      try {
        handle(JSON.parse(ev.data) as WatchEvent);
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
      // 主动断开：先摘除处理器，避免 onclose 重新调度 5s 重连导致离页后仍僵尸重连
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = null;
    }
    connected.value = false;
  }

  async function refresh() {
    const [st, al] = await Promise.all([api.getWatchStatus(), api.listWatchAlerts(50)]);
    status.value = st;
    alerts.value = al;
  }

  return {
    status,
    quotes,
    quotesAt,
    signals,
    alerts,
    connected,
    connect,
    disconnect,
    refresh,
  };
});
