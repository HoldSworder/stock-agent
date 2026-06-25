import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  EtfWatchAlert,
  EtfWatchEvent,
  EtfWatchLayerState,
  EtfWatchSignal,
  EtfWatchStatus,
} from '@stock-agent/shared';
import { api, openWs } from '@/api';

/** 信号流折叠行：按 code:type:layer 聚合，记录触发次数与首次时间 */
export interface EtfWatchSignalRow extends EtfWatchSignal {
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

// ETF 多周期盯盘前端状态：维护 /ws/etf-watch 长连接，聚合状态/信号流/告警/层状态。
export const useEtfWatchStore = defineStore('etfWatch', () => {
  const status = ref<EtfWatchStatus | null>(null);
  const signals = ref<EtfWatchSignalRow[]>([]);
  const alerts = ref<EtfWatchAlert[]>([]);
  const states = ref<EtfWatchLayerState[]>([]);
  const connected = ref(false);
  /** 告警范围：today 仅当日（默认）/ all 全部历史 */
  const alertScope = ref<'today' | 'all'>('today');

  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  /** 信号流归属的上海交易日；跨日首帧清空隔夜残留 */
  let feedDay = shanghaiToday();

  /** 跨日则清空信号流（隔夜残留不再展示），返回是否发生了跨日 */
  function rolloverIfNewDay(): void {
    const today = shanghaiToday();
    if (today !== feedDay) {
      feedDay = today;
      signals.value = [];
    }
  }

  function handle(e: EtfWatchEvent) {
    rolloverIfNewDay();
    if (e.type === 'status') status.value = e.status;
    else if (e.type === 'states') states.value = e.states;
    else if (e.type === 'signal') {
      const sig = e.signal;
      const k = `${sig.code}:${sig.type}:${sig.layer}`;
      const rest = signals.value.filter((r) => `${r.code}:${r.type}:${r.layer}` !== k);
      const prev = signals.value.find((r) => `${r.code}:${r.type}:${r.layer}` === k);
      const row: EtfWatchSignalRow = {
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
    ws = openWs('/ws/etf-watch');
    ws.onopen = () => {
      connected.value = true;
    };
    ws.onmessage = (ev) => {
      try {
        handle(JSON.parse(ev.data) as EtfWatchEvent);
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
    const [st, al, sts] = await Promise.all([
      api.etfWatch.status(),
      api.etfWatch.alerts(50, alertScope.value),
      api.etfWatch.states(),
    ]);
    status.value = st;
    alerts.value = al;
    states.value = sts;
  }

  /** 切换告警范围（仅当日/全部）并立即重拉 */
  async function setAlertScope(scope: 'today' | 'all') {
    alertScope.value = scope;
    alerts.value = await api.etfWatch.alerts(50, scope);
  }

  /** 清空全部建议持仓层（层状态由后端广播刷新） */
  async function clearStates() {
    await api.etfWatch.clearStates();
  }

  /** 移除单只 ETF 的建议持仓层 */
  async function deleteState(code: string) {
    await api.etfWatch.deleteState(code);
  }

  return {
    status,
    signals,
    alerts,
    states,
    connected,
    alertScope,
    connect,
    disconnect,
    refresh,
    setAlertScope,
    clearStates,
    deleteState,
  };
});
