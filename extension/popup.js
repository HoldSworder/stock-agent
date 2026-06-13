import {
  getConfig,
  setConfig,
  syncThsCookie,
  pushCredentials,
  DEV_BACKEND_URL,
  DEV_BRIDGE_SECRET,
} from './bridge.js';
import { watchlist } from './watchlist.js';

const IDP_BASE = 'https://52etf.site';
const $ = (id) => document.getElementById(id);

function log(msg, kind = '') {
  const el = $('log');
  const ts = new Date().toLocaleTimeString();
  el.textContent = `[${ts}] ${kind ? kind + ': ' : ''}${msg}\n` + el.textContent;
}

// ===== 配置 =====
const ENV_LABEL = { dev: '开发', prod: '生产' };

/**
 * 按环境切换输入框并同步「激活配置」到 storage：
 * dev 锁定为本地预填；prod 放开并回填上次生产值。
 * 同步落库是必要的：Cookie/扫码推送与后台重推都从 storage 读激活配置。
 */
async function applyEnv(env) {
  const backend = $('backendUrl');
  const secret = $('bridgeSecret');
  if (env === 'dev') {
    backend.value = DEV_BACKEND_URL;
    secret.value = DEV_BRIDGE_SECRET;
    backend.disabled = true;
    secret.disabled = true;
  } else {
    const { prodBackendUrl = '', prodBridgeSecret = '' } = await chrome.storage.local.get([
      'prodBackendUrl',
      'prodBridgeSecret',
    ]);
    backend.value = prodBackendUrl;
    secret.value = prodBridgeSecret;
    backend.disabled = false;
    secret.disabled = false;
  }
  await setConfig({ backendUrl: backend.value.trim(), bridgeSecret: secret.value });
}

async function loadConfig() {
  const cfg = await getConfig();
  $('env').value = cfg.env;
  await applyEnv(cfg.env);
  $('autoRefresh').checked = cfg.autoRefresh;
  log(`当前环境: ${ENV_LABEL[cfg.env]} (${$('backendUrl').value})`);
  const { idpTokenExpiresAt = 0 } = await chrome.storage.local.get('idpTokenExpiresAt');
  if (idpTokenExpiresAt > 0) {
    const left = idpTokenExpiresAt - Date.now();
    if (left <= 0) log('爱盯盘 token 已过期，请重新扫码登录', 'WARN');
    else if (left <= 3 * 24 * 3600 * 1000)
      log(`爱盯盘 token 即将过期（${new Date(idpTokenExpiresAt).toLocaleString()}），建议重扫`, 'WARN');
    else log(`爱盯盘 token 有效，至 ${new Date(idpTokenExpiresAt).toLocaleString()}`);
  }
}

async function onEnvChange() {
  const env = $('env').value;
  await applyEnv(env);
  await setConfig({ env });
  log(`切换到${ENV_LABEL[env]}环境`);
}

async function saveConfig() {
  const env = $('env').value;
  const backendUrl = $('backendUrl').value.trim();
  const bridgeSecret = $('bridgeSecret').value;
  await setConfig({ env, backendUrl, bridgeSecret, autoRefresh: $('autoRefresh').checked });
  // 生产环境记住手填值，便于切回时回填
  if (env === 'prod') await setConfig({ prodBackendUrl: backendUrl, prodBridgeSecret: bridgeSecret });
  // 通知后台按勾选状态调度/取消自动重推
  chrome.runtime.sendMessage({ type: 'config-updated' });
  log('配置已保存');
}

// ===== 投资账本 Cookie =====
async function onSyncCookie() {
  const btn = $('syncCookie');
  btn.disabled = true;
  try {
    const data = await syncThsCookie();
    log(`Cookie 已推送，后端 thsCookieSet=${!!data?.thsCookie}`, 'OK');
  } catch (e) {
    log(e instanceof Error ? e.message : String(e), 'ERR');
  } finally {
    btn.disabled = false;
  }
}

// ===== 爱盯盘微信扫码登录 =====
async function getWebuid() {
  const { idpWebuid } = await chrome.storage.local.get('idpWebuid');
  if (idpWebuid) return idpWebuid;
  const v = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await chrome.storage.local.set({ idpWebuid: v });
  return v;
}

/** 从轮询响应里稳健提取 Iron token 与过期时间 */
function extractToken(data) {
  const sess = data?.session;
  let token = null;
  let expiresAt = 0;
  if (typeof sess === 'string' && sess.startsWith('Fe26')) {
    token = sess;
  } else if (sess && typeof sess === 'object') {
    token =
      [sess.token, sess.value, sess.session, sess.id].find(
        (v) => typeof v === 'string' && v.startsWith('Fe26'),
      ) || null;
    if (typeof sess.maxAgeSec === 'number' && sess.maxAgeSec > 0) {
      expiresAt = Date.now() + sess.maxAgeSec * 1000;
    } else {
      const e = sess.expiresAt ?? sess.expireAt ?? sess.exp;
      if (typeof e === 'number') expiresAt = e < 2e10 ? e * 1000 : e;
      else if (typeof e === 'string') {
        const p = Date.parse(e);
        if (!Number.isNaN(p)) expiresAt = p;
      }
    }
  }
  if (!token) {
    const m = JSON.stringify(data).match(/Fe26\.2\*\*[A-Za-z0-9\-_*]{200,}/);
    if (m) token = m[0];
  }
  return { token, expiresAt };
}

let polling = false;
async function startLogin() {
  if (polling) return;
  const cfg = await getConfig();
  if (!cfg.backendUrl || !cfg.bridgeSecret) {
    log('请先填写并保存后端地址与推送密钥', 'ERR');
    return;
  }
  const btn = $('startLogin');
  btn.disabled = true;
  polling = true;
  try {
    const webuid = await getWebuid();
    const uuid =
      (crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const platform = 'chrome';
    const qs = `uuid=${encodeURIComponent(uuid)}&webuid=${encodeURIComponent(webuid)}&platform=${platform}`;
    const qr = await fetch(`${IDP_BASE}/api/wechat-qrcode?${qs}`).then((r) => r.json());
    const res = qr.res ?? qr.data ?? qr;
    const ticket = res.ticket;
    const url = res.url;
    if (!ticket || !url) throw new Error('取二维码失败');
    $('qrImg').src = url;
    $('qrBox').classList.remove('hidden');
    log('二维码已生成，请用微信扫码');

    const expireMs = (res.expire_seconds ?? 600) * 1000;
    const deadline = Date.now() + expireMs;
    const sqs = `ticket=${encodeURIComponent(ticket)}&webuid=${encodeURIComponent(webuid)}&platform=${platform}`;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      let st;
      try {
        st = await fetch(`${IDP_BASE}/api/wechat-qrcode-status?${sqs}`).then((r) => r.json());
      } catch {
        continue;
      }
      const { token, expiresAt } = extractToken(st);
      if (token) {
        await chrome.storage.local.set({ idpTokenExpiresAt: expiresAt || 0 });
        const data = await pushCredentials({ idpToken: token });
        chrome.runtime.sendMessage({ type: 'token-updated' });
        const until = expiresAt ? `，有效期至 ${new Date(expiresAt).toLocaleString()}` : '';
        log(`token 已推送，后端 idpTokenSet=${!!data?.idpToken}${until}`, 'OK');
        $('qrBox').classList.add('hidden');
        return;
      }
      if (st && st.pending === false && st.loggedIn === false) {
        log('二维码已失效或被拒绝，请重试', 'ERR');
        $('qrBox').classList.add('hidden');
        return;
      }
    }
    log('二维码超时，请重试', 'ERR');
    $('qrBox').classList.add('hidden');
  } catch (e) {
    log(e instanceof Error ? e.message : String(e), 'ERR');
    $('qrBox').classList.add('hidden');
  } finally {
    polling = false;
    btn.disabled = false;
  }
}

// ===== Tab 切换：自选股懒加载 + 切走时暂停轮询 =====
function switchView(view) {
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('active', t.dataset.view === view);
  }
  $('viewWatch').classList.toggle('hidden', view !== 'viewWatch');
  $('viewSettings').classList.toggle('hidden', view !== 'viewSettings');
  if (view === 'viewWatch') watchlist.activate($('viewWatch'));
  else watchlist.deactivate();
}
for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => switchView(t.dataset.view));
}

// ===== 绑定 =====
$('env').addEventListener('change', onEnvChange);
$('saveConfig').addEventListener('click', saveConfig);
$('syncCookie').addEventListener('click', onSyncCookie);
$('startLogin').addEventListener('click', startLogin);
// 先确保后端配置已落库（dev 默认地址在 loadConfig→applyEnv 中持久化），再进入自选股面板
loadConfig().then(() => switchView('viewWatch'));
