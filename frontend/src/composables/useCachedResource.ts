import { ref, type Ref } from 'vue';

// 数据重读页面的统一 stale-while-revalidate 缓存。
// router-view 无 keep-alive，页面切走会销毁再 onMounted 重拉。本组合式用「模块级」Map
// 跨组件实例存活，重进页面时先同步赋上次结果瞬间渲染，再按 TTL 决定是否后台静默刷新，
// 配合后端响应级缓存彻底消除「每次进入都重新加载」的等待感。

interface CacheEntry<T> {
  data: T;
  /** 写入时刻（毫秒时间戳），用于判定是否超过 TTL 需刷新 */
  fetchedAt: number;
}

// 全局单例缓存：value 用 unknown 存储，出口按调用方泛型还原（key 与 T 一一对应，调用方自证）
const store = new Map<string, CacheEntry<unknown>>();

export interface UseCachedResourceOptions {
  /** 缓存新鲜期（毫秒）；超过则进页面时后台静默刷新。默认 60s */
  ttlMs?: number;
  /** 进入即自动加载（onMounted 时调用）。默认 true */
  immediate?: boolean;
}

export interface CachedResource<T> {
  /** 当前数据（命中缓存时已同步可用，否则为 null） */
  data: Ref<T | null>;
  /** 仅「无缓存的首次拉取」为 true；后台静默刷新不置 loading，避免闪屏 */
  loading: Ref<boolean>;
  /** 后台静默刷新中（有旧数据时刷新），供需要时展示细微指示 */
  refreshing: Ref<boolean>;
  error: Ref<unknown>;
  /**
   * 加载：默认遵循缓存（新鲜则跳过请求，过期则后台刷新）。
   * force=true 时无视 TTL 强制拉取（供「刷新」按钮使用）。
   */
  load: (force?: boolean) => Promise<void>;
  /** load(true) 的语义化别名 */
  reload: () => Promise<void>;
}

/**
 * @param key 缓存键（含影响结果的参数，如 symbol/limit），不同参数需用不同 key。
 *   传入 getter 可支持随响应式参数切换 key（如电报「全部/重点」切换）。
 * @param fetcher 实际拉取函数（通常是 api.xxx）
 */
export function useCachedResource<T>(
  key: string | (() => string),
  fetcher: () => Promise<T>,
  options: UseCachedResourceOptions = {},
): CachedResource<T> {
  const ttlMs = options.ttlMs ?? 60_000;
  const resolveKey = (): string => (typeof key === 'function' ? key() : key);

  const initial = store.get(resolveKey()) as CacheEntry<T> | undefined;
  const data = ref<T | null>(initial ? initial.data : null) as Ref<T | null>;
  const loading = ref(false);
  const refreshing = ref(false);
  const error = ref<unknown>(null);
  /**
   * 请求代际。key 支持 getter，快速连切参数（电报窗口、KOL 平台）时会有多发在飞，
   * 而后端 concepts/hot 之类的超时给到 60s，窗口足够大——后返回的旧请求会覆盖新数据，
   * loading/refreshing 也会被先完成的那一发提前复位。写回前必须确认自己仍是最新一发。
   */
  let token = 0;

  async function fetchInto(k: string): Promise<void> {
    const hasData = data.value != null;
    // 有旧数据→后台静默刷新（refreshing）；无数据→首次加载（loading，显示骨架/spinner）
    if (hasData) refreshing.value = true;
    else loading.value = true;
    error.value = null;
    const mine = ++token;
    /** 自己仍是最新一发、且 key 没被切走时才允许写回 data */
    const isCurrent = (): boolean => mine === token && resolveKey() === k;
    /**
     * loading/refreshing 的复位只判代际：key 已切走时 isCurrent 恒为假，
     * 若连复位也一并跳过，切回原 key（走缓存早退）后就没有任何一发会再复位，面板永久转圈。
     */
    const ownsFlags = (): boolean => mine === token;
    try {
      const result = await fetcher();
      // 缓存与 key 一一对应，落库无害；只有写回 data 需要判代际
      store.set(k, { data: result, fetchedAt: Date.now() });
      if (isCurrent()) data.value = result;
    } catch (e) {
      if (!isCurrent()) return; // 已被更新的一发接管，失败也不该冒泡干扰调用方
      error.value = e;
      // 保留已有 data（serve-stale），无旧数据时由调用方根据 error 处理
      if (!hasData) throw e;
    } finally {
      if (ownsFlags()) {
        loading.value = false;
        refreshing.value = false;
      }
    }
  }

  async function load(force = false): Promise<void> {
    const k = resolveKey();
    const entry = store.get(k) as CacheEntry<T> | undefined;
    // 切到新 key 且无缓存时清空旧数据，避免串显上一个参数的内容
    data.value = entry ? entry.data : null;
    if (entry && !force && Date.now() - entry.fetchedAt < ttlMs) {
      // 纯内存命中也要作废在飞的旧请求并收掉它的 loading：
      // 否则「切走 → 切回有缓存的 key」时，旧请求回来发现 key 已变而不复位，转圈永不停止。
      token += 1;
      loading.value = false;
      refreshing.value = false;
      return;
    }
    await fetchInto(k);
  }

  return {
    data,
    loading,
    refreshing,
    error,
    load,
    reload: () => load(true),
  };
}
