// 通用响应级 TTL 内存缓存：用于聚合慢的「数据重读」端点（大盘/电报/ETF/情绪等）。
// 仅缓存 HTTP GET 读路径；定时任务/agent 直连底层服务，保持新鲜，不受此缓存影响。
// 进程内 Map，重启清零，与行情 15s 内存缓存同属轻量内存态，不落库（KISS）。

interface Entry<T> {
  value: T;
  /** 过期时刻（毫秒时间戳）；Date.now() 超过即视为过期，需重新拉取 */
  expiresAt: number;
}

// value 用 unknown 存储，cached() 出口按调用方泛型 T 还原（key 与 T 一一对应，调用方自证）
const store = new Map<string, Entry<unknown>>();
// 同 key 进行中的拉取 Promise，复用以防缓存击穿（并发首拉只打一次后端）
const inflight = new Map<string, Promise<unknown>>();

/**
 * 取缓存值；命中且未过期直接返回，否则调用 loader 拉取并写入。
 * - 并发去重：同 key 同时拉取复用同一 Promise。
 * - serve-stale-on-error：loader 抛错时若存在旧值（无论是否过期）回退旧值，无旧值才抛出，
 *   匹配现有 MarketOverview.stale「上游失败回退上次成功数据」的容错风格。
 */
export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expiresAt > now) return hit.value;

  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;

  const task = (async (): Promise<T> => {
    try {
      const value = await loader();
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } catch (e) {
      const stale = store.get(key) as Entry<T> | undefined;
      if (stale) return stale.value; // 回退上次成功值（含已过期）
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}
