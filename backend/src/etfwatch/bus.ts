import type { EtfWatchEvent } from '@stock-agent/shared';

// ETF 盯盘专用事件总线：独立于个股盯盘 bus 与 ws.ts，互不耦合。
type Listener = (e: EtfWatchEvent) => void;

const listeners = new Set<Listener>();

export function subscribeEtfWatch(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function broadcastEtfWatch(e: EtfWatchEvent): void {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      // 单订阅者异常不影响其他人
    }
  }
}
