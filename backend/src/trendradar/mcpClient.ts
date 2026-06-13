import { getValue } from '../settings';
import { record } from '../datasource/metrics';

// 最小化 streamable-HTTP MCP 客户端（不引第三方 SDK）。
// 握手流程：initialize（取 mcp-session-id）→ notifications/initialized → tools/call。
// 服务端以 SSE 返回，正文在 `data:` 行内的 JSON-RPC 对象中。

export class TrendRadarError extends Error {}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ACCEPT = 'application/json, text/event-stream';

let cachedSession: string | null = null;
let nextId = 1;

function mcpUrl(): string {
  const url = getValue('trendradarMcpUrl').trim();
  if (!url) throw new TrendRadarError('TrendRadar MCP 地址未配置，请到设置页填写');
  return url;
}

/** 解析 SSE 文本，返回首个含 result/error 的 JSON-RPC 响应 */
function parseSse(text: string): JsonRpcResponse | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as JsonRpcResponse;
      if (obj && (obj.result !== undefined || obj.error !== undefined)) return obj;
    } catch {
      /* 非 JSON 行跳过 */
    }
  }
  return null;
}

function safeJson(text: string): JsonRpcResponse | null {
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    return null;
  }
}

async function rpc(
  url: string,
  body: unknown,
  sessionId: string | null,
  timeoutMs: number,
): Promise<{ res: Response; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: ACCEPT };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { res, text };
  } catch (e) {
    throw new TrendRadarError(`MCP 请求失败: ${e instanceof Error ? e.message : e}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 建立会话：initialize 取 mcp-session-id，再发 notifications/initialized */
async function handshake(url: string): Promise<string> {
  const { res, text } = await rpc(
    url,
    {
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'stock-agent', version: '1.0' },
      },
    },
    null,
    15000,
  );
  const sid = res.headers.get('mcp-session-id');
  if (!res.ok || !sid) {
    throw new TrendRadarError(`MCP 初始化失败 ${res.status}: ${text.slice(0, 200)}`);
  }
  // 通知服务端初始化完成（无需关心响应）
  await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid, 10000).catch(
    () => undefined,
  );
  return sid;
}

async function ensureSession(url: string): Promise<string> {
  if (cachedSession) return cachedSession;
  cachedSession = await handshake(url);
  return cachedSession;
}

/**
 * 从 tools/call 的 result 取工具产出。
 * 优先解析 content[].text（工具的规范 JSON 输出）；非 JSON（如 Markdown 报告）原样返回字符串；
 * 都拿不到时回退 structuredContent（FastMCP 会包成 { result: ... }，自动拆壳）。
 */
function extractToolResult(result: unknown): unknown {
  const r = result as {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
  const joined = (r?.content ?? [])
    .map((p) => p.text ?? '')
    .filter(Boolean)
    .join('\n');
  if (joined) {
    try {
      return JSON.parse(joined);
    } catch {
      return joined; // 非 JSON（如 Markdown 报告）原样返回
    }
  }
  const sc = r?.structuredContent;
  if (sc && typeof sc === 'object' && 'result' in (sc as Record<string, unknown>)) {
    return (sc as Record<string, unknown>).result;
  }
  if (sc !== undefined && sc !== null) return sc;
  return result;
}

/**
 * 调用一个 MCP 工具，返回解析后的产出。
 * 会话失效（服务重启 / 4xx）时自动重建一次再试。
 */
export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  timeoutMs = 60000,
): Promise<unknown> {
  const startedAt = Date.now();
  try {
    const url = mcpUrl();
    const send = (sid: string) =>
      rpc(
        url,
        { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
        sid,
        timeoutMs,
      );

    let sid = await ensureSession(url);
    let { res, text } = await send(sid);
    // 会话过期 / 服务重启：清缓存重建一次
    if (res.status === 404 || res.status === 400) {
      cachedSession = null;
      sid = await ensureSession(url);
      ({ res, text } = await send(sid));
    }
    if (!res.ok) {
      throw new TrendRadarError(`MCP 调用 ${name} 失败 ${res.status}: ${text.slice(0, 200)}`);
    }
    const rpcRes = parseSse(text) ?? safeJson(text);
    if (!rpcRes) throw new TrendRadarError(`MCP 调用 ${name} 返回无法解析`);
    if (rpcRes.error) throw new TrendRadarError(`MCP 工具 ${name} 出错: ${rpcRes.error.message}`);
    const out = extractToolResult(rpcRes.result);
    record('trendradar', { ok: true, latencyMs: Date.now() - startedAt });
    return out;
  } catch (e) {
    record('trendradar', {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}
