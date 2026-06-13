// LLM 调用的统一瞬时错误退避重试（agent 流式与 oneshot 共用，避免重复实现）。
// 约定：abort（中止）与上下文超长不在此重试，交由调用方处理。

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 是否为可重试的瞬时错误（限流 429 / 网关 5xx / 网络抖动） */
export function isTransientError(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true;
  const code = (e as { code?: string })?.code ?? '';
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND'].includes(code);
}

/** 是否为运行中止错误（AbortSignal 触发） */
export function isAbortError(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? '';
  return name === 'AbortError' || name === 'APIUserAbortError';
}

/** 从错误响应头解析建议等待时长（429 限流尊重 Retry-After / retry-after-ms），无则返回 null */
export function retryAfterMs(e: unknown): number | null {
  const h = (e as { headers?: unknown })?.headers;
  if (!h) return null;
  const get = (k: string): string | null => {
    const hh = h as { get?: (k: string) => string | null } & Record<string, unknown>;
    if (typeof hh.get === 'function') return hh.get(k);
    const v = hh[k];
    return typeof v === 'string' ? v : null;
  };
  const ms = get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const ra = get('retry-after');
  if (ra) {
    const sec = Number(ra);
    if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  return null;
}

/**
 * 对一次 LLM 调用施加指数退避重试（限流优先尊重 Retry-After，退避上限 30s）。
 * 仅吸收瞬时错误；abort 与非瞬时错误立即上抛。
 */
export async function withLlmRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === maxRetries || !isTransientError(e) || isAbortError(e)) throw e;
      await sleep(Math.min(retryAfterMs(e) ?? 500 * 2 ** attempt, 30000));
    }
  }
  throw lastErr;
}
