import { record } from './metrics';

// 统一 HTTP 请求层：所有外部数据源（东财行情 / 同花顺 / 爱盯盘 / 妙想 / 研报 等）共用。
// 收口能力：缓存、超时、退避重试、主机兜底、鉴权失效判断、外部取消、调用打点。
// 各数据源的差异（鉴权头、反爬 UA、JSONP 剥壳、success code 校验）通过 options 表达，
// 由调用方装配；本层不注入任何业务默认头，保持通用。

export class HttpError extends Error {
  /** HTTP 状态码（网络/解析错误时为 undefined） */
  status?: number;
  /** 是否鉴权失效（cookie/token 过期），供上层提示重新配置 */
  authFailure?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RequestOptions {
  /** 数据源 id（用于调用统计打点） */
  sourceId: string;
  url: string;
  method?: 'GET' | 'POST';
  /** 完整请求头（含 UA / Referer / Cookie / apikey 等，由调用方装配） */
  headers?: Record<string, string>;
  /** 已编码的请求体（JSON 字符串 / URLSearchParams 字符串） */
  body?: string;
  /** 单次请求超时（毫秒），默认 15000 */
  timeoutMs?: number;
  /** 内存缓存 TTL（毫秒），>0 才缓存；缓存键默认 url */
  cacheTtlMs?: number;
  cacheKey?: string;
  /** 最大尝试次数（含首次），默认 1（不重试） */
  maxAttempts?: number;
  /** 退避基数（毫秒），第 N 次退避 = retryBaseMs * N，默认 500 */
  retryBaseMs?: number;
  /** 主机兜底：url 含 from 时，失败后续尝试切到 to（如 push2 → push2delay） */
  hostFallback?: { from: string; to: string };
  /** 哪些状态码可重试，默认 5xx */
  retryOnStatus?: (status: number) => boolean;
  /** 哪些状态码视为鉴权失效（直接抛出不重试），如 401/403 */
  isAuthFailure?: (status: number) => boolean;
  /** 鉴权失效时的错误信息 */
  authFailureMessage?: string;
  /**
   * 重定向处理，默认跟随。'manual' 时不跟随、由调用方读 Location（短链展开等场景），
   * 此时 3xx 视为成功响应而非错误。
   */
  redirect?: 'follow' | 'manual';
  /** 外部取消信号（如 agent 运行取消），中止时原样抛出 AbortError 不重试 */
  signal?: AbortSignal;
  /** 错误信息前缀 */
  errorLabel?: string;
  /** 把内部错误信息包装为调用方的领域错误（保留 instanceof 与中文文案） */
  makeError?: (message: string) => Error;
}

export interface JsonRequestOptions extends RequestOptions {
  /** 校验解析后的 JSON：返回错误信息字符串视为可重试失败，返回 null 视为有效 */
  validate?: (json: Record<string, unknown>) => string | null;
}

interface RunResult {
  status: number;
  text: string;
  json?: Record<string, unknown>;
  /** 响应头 Location（redirect: 'manual' 时用于读一跳跳转目标） */
  location?: string | null;
}

interface InternalOptions extends JsonRequestOptions {
  parse: 'json' | 'text';
}

/**
 * 进程内响应缓存。缓存键是完整 URL（含 secid/lmt 等参数），长跑进程里键空间实际是无界的，
 * 故必须有淘汰：写入时先清掉已过期项，仍超上限就按插入序（Map 天然保序）丢最老的。
 * ponytail: 近似 FIFO 而非 LRU——命中不刷新次序，热键被挤掉只是多回源一次；
 * 要真 LRU 就在命中时 delete + set 重新入队。
 */
const CACHE_MAX_ENTRIES = 500;

const cache = new Map<string, { at: number; expireAt: number; result: RunResult }>();

function cachePut(key: string, result: RunResult, ttlMs: number): void {
  const now = Date.now();
  if (cache.size >= CACHE_MAX_ENTRIES) {
    for (const [k, v] of cache) if (v.expireAt <= now) cache.delete(k);
    for (const k of cache.keys()) {
      if (cache.size < CACHE_MAX_ENTRIES) break;
      cache.delete(k);
    }
  }
  cache.set(key, { at: now, expireAt: now + ttlMs, result });
}

async function run(opts: InternalOptions): Promise<RunResult> {
  const {
    sourceId,
    url,
    method = 'GET',
    headers,
    body,
    timeoutMs = 15000,
    cacheTtlMs = 0,
    cacheKey,
    maxAttempts = 1,
    retryBaseMs = 500,
    hostFallback,
    redirect = 'follow',
    retryOnStatus = (s) => s >= 500,
    isAuthFailure,
    authFailureMessage,
    signal,
    parse,
    validate,
    errorLabel,
    makeError,
  } = opts;

  const label = errorLabel ?? '请求';
  const wrap = (msg: string): Error => (makeError ? makeError(msg) : new HttpError(msg));

  const key = cacheKey ?? url;
  const startedAt = Date.now();

  if (cacheTtlMs > 0) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cacheTtlMs) {
      record(sourceId, { ok: true, cacheHit: true, latencyMs: 0 });
      return hit.result;
    }
  }

  let lastErr: Error | null = null;
  let useFallback = false;
  const canFallback = !!hostFallback && url.includes(hostFallback.from);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      record(sourceId, { ok: false, latencyMs: Date.now() - startedAt, error: 'canceled' });
      throw new DOMException('Aborted', 'AbortError');
    }

    const reqUrl = useFallback && hostFallback ? url.replace(hostFallback.from, hostFallback.to) : url;
    const ctrl = new AbortController();
    const onAbort = (): void => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(reqUrl, { method, headers, body, redirect, signal: ctrl.signal });
    } catch (e) {
      // 外部取消：原样抛出，不重试
      if (signal?.aborted) {
        record(sourceId, { ok: false, latencyMs: Date.now() - startedAt, error: 'canceled' });
        throw e;
      }
      lastErr = wrap(`${label}请求失败: ${e instanceof Error ? e.message : e}`);
      if (canFallback) useFallback = true;
      if (attempt < maxAttempts) {
        await sleep(retryBaseMs * attempt);
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (isAuthFailure && isAuthFailure(res.status)) {
      const e = wrap(authFailureMessage ?? `${label} ${res.status} 鉴权失效`) as HttpError;
      e.status = res.status;
      e.authFailure = true;
      lastErr = e;
      break; // 鉴权失效为确定性失败，不重试
    }

    // redirect: 'manual' 时 3xx 是预期结果（调用方要读 Location），不算失败
    const isManualRedirect = redirect === 'manual' && res.status >= 300 && res.status < 400;
    if (!res.ok && !isManualRedirect) {
      const e = wrap(`${label} ${res.status}`) as HttpError;
      e.status = res.status;
      if (retryOnStatus(res.status) && attempt < maxAttempts) {
        lastErr = e;
        if (canFallback) useFallback = true;
        await sleep(retryBaseMs * attempt);
        continue;
      }
      lastErr = e;
      break;
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      lastErr = wrap(`${label}响应读取失败`);
      if (attempt < maxAttempts) {
        await sleep(retryBaseMs * attempt);
        continue;
      }
      break;
    }

    if (parse === 'text') {
      const result: RunResult = { status: res.status, text, location: res.headers.get('location') };
      if (cacheTtlMs > 0) cachePut(key, result, cacheTtlMs);
      record(sourceId, { ok: true, latencyMs: Date.now() - startedAt });
      return result;
    }

    // parse === 'json'：解析失败或 validate 未过视为可重试（如东财多源 schema 桩 / 妙想非成功 code）
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      lastErr = wrap(`${label}响应解析失败`);
      if (attempt < maxAttempts) {
        await sleep(retryBaseMs * attempt);
        continue;
      }
      break;
    }
    const invalid = validate ? validate(json) : null;
    if (invalid) {
      lastErr = wrap(invalid);
      if (attempt < maxAttempts) {
        await sleep(retryBaseMs * attempt);
        continue;
      }
      break;
    }
    const result: RunResult = { status: res.status, text, json };
    // 只缓存解析后的 json：requestJson 不读 text，留着等于把同一份响应存两遍
    if (cacheTtlMs > 0) cachePut(key, { status: res.status, text: '', json }, cacheTtlMs);
    record(sourceId, { ok: true, latencyMs: Date.now() - startedAt });
    return result;
  }

  const err = lastErr ?? wrap(`${label}请求失败`);
  record(sourceId, { ok: false, latencyMs: Date.now() - startedAt, error: err.message });
  throw err;
}

/** 发起请求并返回解析后的 JSON（解析/校验失败可重试） */
export async function requestJson(opts: JsonRequestOptions): Promise<Record<string, unknown>> {
  const r = await run({ ...opts, parse: 'json' });
  return r.json as Record<string, unknown>;
}

/** 发起请求并返回原始文本（HTML / JSONP / SSE 等由调用方自解析） */
export async function requestText(opts: RequestOptions): Promise<string> {
  const r = await run({ ...opts, parse: 'text' });
  return r.text;
}

/** 同 requestText，但带上状态码与 Location（短链展开这类需要读一跳重定向的场景） */
export async function requestTextDetail(
  opts: RequestOptions,
): Promise<{ status: number; text: string; location: string | null }> {
  const r = await run({ ...opts, parse: 'text' });
  return { status: r.status, text: r.text, location: r.location ?? null };
}
