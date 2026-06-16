import { requestText } from '../datasource/httpClient';
import { getValue } from '../settings';

// AKShare 通用透传客户端：经群晖 aktools（AKShare 官方 HTTP 包装器）调用任意 akshare 函数。
// aktools 把每个 akshare 函数暴露为 GET /api/public/<func>?param=value，返回 JSON 记录数组。
// 上千接口不逐个写强类型 provider，统一由本客户端 + akshare_call 工具按函数名透传（KISS/DRY）。

export class AkshareError extends Error {}

/** aktools 返回多为记录数组，少数为对象；统一收口为 unknown 交上层处理 */
type AkshareResult = unknown;

/** aktools 基址（去尾斜杠）；未配置抛中文错误，提示去数据源页填写 */
function baseUrl(): string {
  const raw = getValue('akshareBaseUrl' as never).trim();
  if (!raw) throw new AkshareError('AKShare 未配置 Base URL（请在数据源页填写 aktools 反代地址）');
  return raw.replace(/\/+$/, '');
}

/** 把参数对象编码为查询串（跳过空值；数字转字符串） */
function toQuery(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * 调用 akshare 任意公开函数，返回解析后的 JSON（多为记录数组）。
 * aktools 返回的可能是数组（不符合 requestJson 的 object 约定），故走 requestText 后自行 JSON.parse。
 * sourceId 默认归在 'akshare'，财联社/雪球等复用 aktools 透传的逻辑源可传各自 id 以独立计入调用统计。
 * timeoutMs/maxAttempts 可覆盖默认（30s / 2 次）：多源兜底等场景传更短超时与单次尝试以快速失败。
 */
export async function callAkshare(
  func: string,
  params: Record<string, string | number | undefined | null> = {},
  signal?: AbortSignal,
  sourceId = 'akshare',
  timeoutMs = 30_000,
  maxAttempts = 2,
): Promise<AkshareResult> {
  const name = func.trim();
  if (!name) throw new AkshareError('AKShare 函数名为空');
  const url = `${baseUrl()}/api/public/${encodeURIComponent(name)}${toQuery(params)}`;
  const text = await requestText({
    sourceId,
    url,
    timeoutMs,
    maxAttempts,
    retryBaseMs: 800,
    signal,
    errorLabel: `AKShare ${name}`,
    makeError: (m) => new AkshareError(m),
  });
  try {
    return JSON.parse(text) as AkshareResult;
  } catch {
    // aktools 函数名错误/异常时返回非 JSON 文本（如 FastAPI 报错页），原样裹错抛出
    throw new AkshareError(`AKShare ${name} 返回非 JSON：${text.slice(0, 200)}`);
  }
}

/** 健康探测：调轻量函数（交易日历）连通即在线 */
export async function pingAkshare(): Promise<void> {
  const data = await callAkshare('tool_trade_date_hist_sina');
  if (!Array.isArray(data) || data.length === 0) {
    throw new AkshareError('AKShare 连通但返回空数据（检查 aktools 服务）');
  }
}
