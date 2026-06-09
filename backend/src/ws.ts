import type { StreamEvent } from '@stock-agent/shared';

type Listener = (e: StreamEvent) => void;

// 极简事件总线：定时/手动任务运行事件全局广播，前端「运行监控」订阅。
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function broadcast(e: StreamEvent): void {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      // 单个订阅者异常不影响其他人
    }
  }
}
