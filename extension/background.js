import { getConfig, syncThsCookie } from './bridge.js';

// 可选：每 6 小时自动重推投资账本 Cookie（同花顺 Cookie 会轮换）。
// 仅在 popup 勾选「自动重推」且已配置后端时生效。

const ALARM = 'ths-cookie-refresh';
const PERIOD_MIN = 360;
// token 有效期巡检：本地检查，不联网，常驻
const TOKEN_ALARM = 'idp-token-check';
const TOKEN_CHECK_MIN = 720; // 12h
const NEAR_EXPIRY_MS = 3 * 24 * 3600 * 1000; // 临期阈值 3 天

async function reconcileAlarm() {
  const { autoRefresh, backendUrl, bridgeSecret } = await getConfig();
  const existing = await chrome.alarms.get(ALARM);
  if (autoRefresh && backendUrl && bridgeSecret) {
    if (!existing) chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MIN });
  } else if (existing) {
    chrome.alarms.clear(ALARM);
  }
  if (!(await chrome.alarms.get(TOKEN_ALARM))) {
    chrome.alarms.create(TOKEN_ALARM, { periodInMinutes: TOKEN_CHECK_MIN });
  }
  await checkTokenExpiry();
}

/** token 临期/过期时在图标上挂红色角标提醒重扫；有效期未知（0）则不提醒 */
async function checkTokenExpiry() {
  const { idpTokenExpiresAt = 0 } = await chrome.storage.local.get('idpTokenExpiresAt');
  const now = Date.now();
  const alert = idpTokenExpiresAt > 0 && idpTokenExpiresAt - now <= NEAR_EXPIRY_MS;
  await chrome.action.setBadgeText({ text: alert ? '!' : '' });
  if (alert) await chrome.action.setBadgeBackgroundColor({ color: '#e54d42' });
}

chrome.runtime.onInstalled.addListener(reconcileAlarm);
chrome.runtime.onStartup.addListener(reconcileAlarm);
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'config-updated') reconcileAlarm();
  if (msg?.type === 'token-updated') checkTokenExpiry();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === TOKEN_ALARM) {
    await checkTokenExpiry();
    return;
  }
  if (alarm.name !== ALARM) return;
  try {
    await syncThsCookie();
    console.log('[bridge] 自动重推 Cookie 成功');
  } catch (e) {
    console.warn('[bridge] 自动重推 Cookie 失败:', e instanceof Error ? e.message : e);
  }
});
