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
}

interface InternalOptions extends JsonRequestOptions {
  parse: 'json' | 'text';
}

const cache = new Map<string, { at: number; result: RunResult }>();

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
      res = await fetch(reqUrl, { method, headers, body, signal: ctrl.signal });
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

    if (!res.ok) {
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
      const result: RunResult = { status: res.status, text };
      if (cacheTtlMs > 0) cache.set(key, { at: Date.now(), result });
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
    if (cacheTtlMs > 0) cache.set(key, { at: Date.now(), result });
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
