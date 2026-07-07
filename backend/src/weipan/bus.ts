import type { WeipanEvent } from '@stock-agent/shared';

// 尾盘盯盘专用事件总线：独立于个股盯盘 bus 与 ETF 盯盘 bus，互不耦合。
type Listener = (e: WeipanEvent) => void;

const listeners = new Set<Listener>();

export function subscribeWeipan(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function broadcastWeipan(e: WeipanEvent): void {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      // 单订阅者异常不影响其他人
    }
  }
}
