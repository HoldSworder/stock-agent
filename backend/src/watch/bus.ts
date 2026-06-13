import type { WatchEvent } from '@stock-agent/shared';

// 盯盘专用事件总线：独立于 ws.ts 的 StreamEvent 广播，互不耦合。
type Listener = (e: WatchEvent) => void;

const listeners = new Set<Listener>();

export function subscribeWatch(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function broadcastWatch(e: WatchEvent): void {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      // 单订阅者异常不影响其他人
    }
  }
}
