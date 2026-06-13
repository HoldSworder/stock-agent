// 共享逻辑：配置存取、投资账本 Cookie 采集、凭据推送、后端域名按需授权。
// popup.js（UI 登录 + 触发）与 background.js（定时重推）共用。

const THS_COOKIE_DOMAIN = '.10jqka.com.cn';

// 开发环境固定后端与默认密钥（需与本地 backend/.env 的 BRIDGE_SECRET 对齐）
export const DEV_BACKEND_URL = 'http://localhost:8787';
export const DEV_BRIDGE_SECRET = 'dev-secret';

/** 读取扩展配置（环境 + 后端地址 + 推送密钥 + 是否自动重推 cookie） */
export async function getConfig() {
  const { env = 'dev', backendUrl = '', bridgeSecret = '', autoRefresh = false } =
    await chrome.storage.local.get(['env', 'backendUrl', 'bridgeSecret', 'autoRefresh']);
  return { env, backendUrl, bridgeSecret, autoRefresh };
}

export async function setConfig(patch) {
  await chrome.storage.local.set(patch);
}

/** 规范化后端地址为 origin（去尾斜杠），非法返回 null */
function normalizeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** 后端可能是任意域名：运行时按需申请该 origin 的 host 权限 */
export async function ensureBackendPermission(backendUrl) {
  const origin = normalizeOrigin(backendUrl);
  if (!origin) throw new Error('后端地址不是合法 URL');
  const pattern = `${origin}/*`;
  const has = await chrome.permissions.contains({ origins: [pattern] });
  if (has) return;
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) throw new Error('未授权访问后端域名，无法推送');
}

/**
 * 通用后端请求：走当前激活后端（dev/prod），自动按需授权域名，解析 {ok,data,error}。
 * 携带 x-bridge-secret 作为机器凭据：后端开启访问密码时据此绕过 app 登录。
 */
export async function apiFetch(path, init = {}) {
  const { backendUrl, bridgeSecret } = await getConfig();
  if (!backendUrl) throw new Error('未配置后端地址');
  await ensureBackendPermission(backendUrl);
  const origin = normalizeOrigin(backendUrl);
  const res = await fetch(`${origin}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(bridgeSecret ? { 'x-bridge-secret': bridgeSecret } : {}),
      ...(init.headers || {}),
    },
    ...init,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok || (json && json.ok === false)) {
    throw new Error(`请求失败 [${res.status}] ${json?.error ?? text.slice(0, 120)}`);
  }
  return json?.data;
}

/** 采集 .10jqka.com.cn 全部 Cookie，拼成 Cookie 头整串（含 httpOnly） */
export async function collectThsCookie() {
  const cookies = await chrome.cookies.getAll({ domain: THS_COOKIE_DOMAIN });
  if (!cookies.length) {
    throw new Error('未读到同花顺 Cookie，请先在本浏览器登录同花顺投资账本');
  }
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** 推送凭据到后端受保护端点；payload 仅含 idpToken / thsCookie 之一或两者 */
export async function pushCredentials(payload) {
  const { backendUrl, bridgeSecret } = await getConfig();
  if (!backendUrl) throw new Error('未配置后端地址');
  if (!bridgeSecret) throw new Error('未配置推送密钥');
  await ensureBackendPermission(backendUrl);
  const origin = normalizeOrigin(backendUrl);
  const res = await fetch(`${origin}/api/credentials`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-bridge-secret': bridgeSecret },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok || !json?.ok) {
    throw new Error(`推送失败 [${res.status}] ${json?.error ?? text.slice(0, 120)}`);
  }
  return json.data;
}

/** 采集并推送投资账本 Cookie，返回写入后的公开设置视图 */
export async function syncThsCookie() {
  const thsCookie = await collectThsCookie();
  return pushCredentials({ thsCookie });
}
