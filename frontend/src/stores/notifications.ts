import { defineStore } from 'pinia';
import { computed, ref, watch, type WatchStopHandle } from 'vue';
import { ElNotification } from 'element-plus';
import type { RunStatus, RunTrigger, TaskRun, WatchEvent } from '@stock-agent/shared';
import { openWs } from '@/api';
import type { useAgentsStore } from '@/stores/agents';

// 全局消息中心：聚合「Agent/后台任务完成」（复用 agents store 已加载的 runs）与
// 「盯盘告警」（自连 /ws/watch），统一为通知条目，供侧栏铃铛 + 抽屉 + toast 展示。
// 已读状态与最近历史用 localStorage 持久化，跨刷新存活。

export type NotificationKind = 'agent' | 'watch';
export type NotificationLevel = 'success' | 'warning' | 'error' | 'info';

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  level: NotificationLevel;
  title: string;
  summary: string;
  /** 触发时间 ISO */
  time: string;
  read: boolean;
}

const STORAGE_KEY = 'sa.notifications';
const MAX_ITEMS = 50;

const TRIGGER_LABEL: Record<RunTrigger, string> = {
  cron: '定时',
  manual: '手动',
  chat: '聊天',
  watch: '盯盘',
};

/** run 终态 → 通知级别（A股语境无关，仅成败映射） */
function levelOfStatus(s: RunStatus): NotificationLevel {
  if (s === 'success') return 'success';
  if (s === 'canceled') return 'info';
  return 'error'; // error / timeout
}

const STATUS_LABEL: Record<RunStatus, string> = {
  running: '运行中',
  success: '完成',
  error: '失败',
  timeout: '超时',
  canceled: '已取消',
};

/** 摘要截断：去除多余空白后取前 120 字 */
function brief(text: string | null | undefined, max = 120): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function loadPersisted(): NotificationItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as NotificationItem[];
    return Array.isArray(arr) ? arr.slice(0, MAX_ITEMS) : [];
  } catch {
    return [];
  }
}

export const useNotificationsStore = defineStore('notifications', () => {
  const items = ref<NotificationItem[]>(loadPersisted());
  const unreadCount = computed(() => items.value.filter((n) => !n.read).length);

  // 已处理过的 run id（避免重复入列）；首帧用作历史基线，仅入历史不弹 toast
  const seenRuns = new Set<string>();
  let runSeeded = false;
  let stopRunWatch: WatchStopHandle | null = null;
  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let inited = false;

  function persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items.value.slice(0, MAX_ITEMS)));
    } catch {
      /* 配额/隐私模式失败不阻断 */
    }
  }

  /** 入列一条通知；historical=true 表示历史基线（标记已读、不弹 toast） */
  function push(item: Omit<NotificationItem, 'read'>, historical: boolean): void {
    if (items.value.some((n) => n.id === item.id)) return;
    const full: NotificationItem = { ...item, read: historical };
    items.value = [full, ...items.value].slice(0, MAX_ITEMS);
    persist();
    if (!historical) {
      ElNotification({
        title: full.title,
        message: full.summary || STATUS_LABEL.success,
        type: full.level,
        duration: 4500,
        position: 'bottom-right',
      });
    }
  }

  function pushFromRun(run: TaskRun, historical: boolean): void {
    const name = run.taskName || `${TRIGGER_LABEL[run.trigger]}任务`;
    push(
      {
        id: `run:${run.id}`,
        kind: 'agent',
        level: levelOfStatus(run.status),
        title: `${name} · ${STATUS_LABEL[run.status]}`,
        summary: brief(run.outputText) || (run.status === 'success' ? '已完成' : STATUS_LABEL[run.status]),
        time: run.finishedAt ?? run.startedAt,
      },
      historical,
    );
  }

  function handleWatch(e: WatchEvent): void {
    if (e.type === 'alert') {
      const a = e.alert;
      push(
        {
          id: `alert:${a.id}`,
          kind: 'watch',
          level: a.severity === 'high' ? 'error' : a.severity === 'medium' ? 'warning' : 'info',
          title: `盯盘告警 · ${a.name}（${a.code}）`,
          summary: brief(a.adviceText) || brief(a.detail) || '触发盯盘信号',
          time: new Date().toISOString(),
        },
        false,
      );
    } else if (e.type === 'signal' && e.signal.severity === 'high') {
      const s = e.signal;
      push(
        {
          id: `signal:${s.code}:${s.type}:${s.at}`,
          kind: 'watch',
          level: 'warning',
          title: `盯盘信号 · ${s.name}（${s.code}）`,
          summary: brief(s.detail) || '高优先级盯盘信号',
          time: s.at,
        },
        false,
      );
    }
  }

  function openWatchSocket(): void {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = openWs('/ws/watch');
    ws.onmessage = (ev) => {
      try {
        handleWatch(JSON.parse(ev.data) as WatchEvent);
      } catch {
        /* 忽略坏帧 */
      }
    };
    ws.onclose = () => {
      if (reconnectTimer == null) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          openWatchSocket();
        }, 5000);
      }
    };
    ws.onerror = () => ws?.close();
  }

  /** 复用 agents store 已建立的 /ws/runs 流：监听 runs 增量，首帧作历史基线 */
  function init(agents: ReturnType<typeof useAgentsStore>): void {
    if (inited) return;
    inited = true;

    stopRunWatch = watch(
      () => agents.runs,
      (runs) => {
        const finished = runs.filter((r) => r.status !== 'running');
        if (!runSeeded) {
          // 首个非空快照作为基线：全部计入历史（已读、不弹）
          for (const r of finished) {
            seenRuns.add(r.id);
            pushFromRun(r, true);
          }
          if (finished.length > 0 || runs.length > 0) runSeeded = true;
          return;
        }
        for (const r of finished) {
          if (seenRuns.has(r.id)) continue;
          seenRuns.add(r.id);
          pushFromRun(r, false);
        }
      },
      { immediate: true, deep: false },
    );

    openWatchSocket();
  }

  function markRead(id: string): void {
    const it = items.value.find((n) => n.id === id);
    if (it && !it.read) {
      it.read = true;
      persist();
    }
  }

  function markAllRead(): void {
    let changed = false;
    for (const n of items.value) {
      if (!n.read) {
        n.read = true;
        changed = true;
      }
    }
    if (changed) persist();
  }

  function clearAll(): void {
    items.value = [];
    persist();
  }

  function dispose(): void {
    if (stopRunWatch) {
      stopRunWatch();
      stopRunWatch = null;
    }
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
    inited = false;
    runSeeded = false;
    seenRuns.clear();
  }

  return {
    items,
    unreadCount,
    init,
    markRead,
    markAllRead,
    clearAll,
    dispose,
  };
});
