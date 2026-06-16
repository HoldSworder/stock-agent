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

  async function fetchInto(k: string): Promise<void> {
    const hasData = data.value != null;
    // 有旧数据→后台静默刷新（refreshing）；无数据→首次加载（loading，显示骨架/spinner）
    if (hasData) refreshing.value = true;
    else loading.value = true;
    error.value = null;
    try {
      const result = await fetcher();
      data.value = result;
      store.set(k, { data: result, fetchedAt: Date.now() });
    } catch (e) {
      error.value = e;
      // 保留已有 data（serve-stale），无旧数据时由调用方根据 error 处理
      if (!hasData) throw e;
    } finally {
      loading.value = false;
      refreshing.value = false;
    }
  }

  async function load(force = false): Promise<void> {
    const k = resolveKey();
    const entry = store.get(k) as CacheEntry<T> | undefined;
    // 切到新 key 且无缓存时清空旧数据，避免串显上一个参数的内容
    data.value = entry ? entry.data : null;
    if (entry && !force && Date.now() - entry.fetchedAt < ttlMs) return; // 新鲜且非强刷：纯内存命中
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
