// 通用响应级 TTL 内存缓存：用于聚合慢的「数据重读」端点（大盘/电报/ETF/情绪等）。
// 仅缓存 HTTP GET 读路径；定时任务/agent 直连底层服务，保持新鲜，不受此缓存影响。
// 进程内 Map，重启清零，与行情 15s 内存缓存同属轻量内存态，不落库（KISS）。

interface Entry<T> {
  value: T;
  /** 过期时刻（毫秒时间戳）；Date.now() 超过即视为过期，需重新拉取 */
  expiresAt: number;
  /** 该条目自己的 serve-stale 上限（由写入时的调用方决定），清扫按它判超龄 */
  maxStaleMs: number;
}

// value 用 unknown 存储，cached() 出口按调用方泛型 T 还原（key 与 T 一一对应，调用方自证）
const store = new Map<string, Entry<unknown>>();
// 同 key 进行中的拉取 Promise，复用以防缓存击穿（并发首拉只打一次后端）
const inflight = new Map<string, Promise<unknown>>();

/**
 * 条数上限。
 *
 * key 空间不封闭：concepts:stocks:${name}、sectorintel:rss:*、cls:all:*、trendradar:trending:*
 * 这些 key 都拼了未校验的用户输入，每个不同取值永久占一条缓存 + 一整份聚合结果。
 * 过期条目只是不再命中，对象仍被 Map 强引用，等于一条无界内存增长路径。
 */
const MAX_ENTRIES = 500;

/**
 * 陈旧值保留上限：过期超过此时长的条目会被清扫，且不再作为 serve-stale 回退值。
 *
 * 对交易辅助系统而言「旧数据装作新数据」比报错更危险——上游挂三天，market:overview
 * 仍安静渲染三天前的盘面，用户无从察觉。这里给容错兜底一个硬顶：超过一天的盘面
 * 一律显性报错，让 UI 走错误态而不是静默展示历史行情。
 */
const MAX_STALE_DEFAULT_MS = 24 * 3600_000;

/**
 * 写入前的惰性清扫：删掉陈旧超限的条目，仍超上限则按「最早过期」淘汰。
 * 不开定时器——缓存只在有写入时增长，写入时顺带清扫足够压住上界（KISS）。
 */
function sweep(now: number): void {
  for (const [k, e] of store) {
    // 按条目自己的上限判超龄，不能写死默认值：那会让调用方传的更大的 maxStaleMs
    // 只在读取时生效、条目却在超过默认一天时就被别的 key 的写入顺带扫掉，
    // 使这个选项实际只能调小不能调大。
    if (now - e.expiresAt > e.maxStaleMs) store.delete(k);
  }
  if (store.size < MAX_ENTRIES) return;
  // 过期最早的最不可能再被当作回退值，优先淘汰
  const victims = [...store.entries()]
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    .slice(0, store.size - MAX_ENTRIES + 1);
  for (const [k] of victims) store.delete(k);
}

export interface CachedOptions {
  /**
   * serve-stale 的最大超龄（毫秒）：旧值过期超过此时长即不再回退，直接抛出 loader 的错误。
   * 缺省 MAX_STALE_DEFAULT_MS（一天）。传 0 表示不接受任何过期回退。
   */
  maxStaleMs?: number;
}

/**
 * 取缓存值；命中且未过期直接返回，否则调用 loader 拉取并写入。
 * - 并发去重：同 key 同时拉取复用同一 Promise。
 * - serve-stale-on-error：loader 抛错时若存在旧值且超龄在 maxStaleMs 内则回退旧值，
 *   匹配现有 MarketOverview.stale「上游失败回退上次成功数据」的容错风格；
 *   超龄或无旧值一律抛出，避免上游长期挂掉时静默返回陈旧盘面。
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  opts: CachedOptions = {},
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expiresAt > now) return hit.value;

  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;

  const maxStaleMs = opts.maxStaleMs ?? MAX_STALE_DEFAULT_MS;
  const task = (async (): Promise<T> => {
    try {
      const value = await loader();
      const at = Date.now();
      sweep(at);
      store.set(key, { value, expiresAt: at + ttlMs, maxStaleMs });
      return value;
    } catch (e) {
      const stale = store.get(key) as Entry<T> | undefined;
      // 回退上次成功值（含已过期），但超龄太久的不再冒充新数据
      if (stale && Date.now() - stale.expiresAt <= maxStaleMs) return stale.value;
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/**
 * 只看缓存、不触发拉取。命中且未过期才返回，否则 undefined。
 *
 * 给「这块数据慢，但它不重要到值得让整个响应等它」的调用方用：
 * 驾驶舱动作清单里 ETF 轮动只贡献最不紧急的 P2 换仓候选，
 * 却要几分钟才算得出来。让它阻塞会把 P0 止损一起拖到超时——
 * 风险项迟到比机会项缺席危险得多。
 */
export function peek<T>(key: string): T | undefined {
  const hit = store.get(key) as Entry<T> | undefined;
  return hit && hit.expiresAt > Date.now() ? hit.value : undefined;
}

/** 缓存内部状态（仅供自检断言用，业务代码不要依赖） */
export function inspect(): { entries: number; inflight: number; maxEntries: number } {
  return { entries: store.size, inflight: inflight.size, maxEntries: MAX_ENTRIES };
}

/** 清空缓存（仅供自检隔离用例用） */
export function reset(): void {
  store.clear();
  inflight.clear();
}
