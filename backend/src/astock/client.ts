import { requestText } from '../datasource/httpClient';
import { getValue } from '../settings';

// a-stock-data 通用透传客户端：经专属 Python sidecar 调用其 28 端点。
// sidecar 把每个端点暴露为 GET /api/call/<endpoint>?param=value，返回 JSON。
// 与 market/akshare.ts 的 callAkshare 形状一致（单源 + by-name 透传），便于将来整体替代 aktools。

export class AstockError extends Error {}

/** sidecar 返回多为记录数组/对象；统一收口为 unknown 交上层处理 */
type AstockResult = unknown;

/** sidecar 基址（去尾斜杠）；未配置抛中文错误，提示去数据源页填写 */
function baseUrl(): string {
  const raw = getValue('astockBaseUrl' as never).trim();
  if (!raw) throw new AstockError('a-stock-data 未配置 Base URL（请在数据源页填写 sidecar 地址，如 http://a-stock-data:9119）');
  return raw.replace(/\/+$/, '');
}

/** 把参数对象编码为查询串（跳过空值；数字转字符串；数组用逗号连接） */
function toQuery(params: Record<string, string | number | string[] | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * 调用 a-stock-data sidecar 的任一端点，返回解析后的 JSON。
 * sourceId 默认归在 'astockdata'，便于数据源页统计调用。
 * timeoutMs/maxAttempts 可覆盖默认（30s / 2 次）；mootdx TCP 偶发慢，故默认放宽。
 */
export async function callAstock(
  endpoint: string,
  params: Record<string, string | number | string[] | undefined | null> = {},
  signal?: AbortSignal,
  sourceId = 'astockdata',
  timeoutMs = 30_000,
  maxAttempts = 2,
): Promise<AstockResult> {
  const name = endpoint.trim();
  if (!name) throw new AstockError('a-stock-data 端点名为空');
  const url = `${baseUrl()}/api/call/${encodeURIComponent(name)}${toQuery(params)}`;
  const text = await requestText({
    sourceId,
    url,
    timeoutMs,
    maxAttempts,
    retryBaseMs: 800,
    signal,
    errorLabel: `a-stock-data ${name}`,
    makeError: (m) => new AstockError(m),
  });
  try {
    return JSON.parse(text) as AstockResult;
  } catch {
    throw new AstockError(`a-stock-data ${name} 返回非 JSON：${text.slice(0, 200)}`);
  }
}

/** 健康探测：调 sidecar /health（内部跑一次 mootdx 取数），连通即在线 */
export async function pingAstock(): Promise<void> {
  const text = await requestText({
    sourceId: 'astockdata',
    url: `${baseUrl()}/health`,
    timeoutMs: 15_000,
    maxAttempts: 1,
    errorLabel: 'a-stock-data health',
    makeError: (m) => new AstockError(m),
  });
  let ok = false;
  try {
    ok = (JSON.parse(text) as { ok?: boolean }).ok === true;
  } catch {
    throw new AstockError(`a-stock-data /health 返回非 JSON：${text.slice(0, 120)}`);
  }
  if (!ok) throw new AstockError('a-stock-data 连通但 mootdx 探活失败（检查 sidecar 与国内网络）');
}

/** 端点目录（供 Agent 工具描述/自检）；失败抛错 */
export async function getAstockManifest(): Promise<unknown> {
  const text = await requestText({
    sourceId: 'astockdata',
    url: `${baseUrl()}/api/manifest`,
    timeoutMs: 15_000,
    maxAttempts: 1,
    errorLabel: 'a-stock-data manifest',
    makeError: (m) => new AstockError(m),
  });
  return JSON.parse(text) as unknown;
}
