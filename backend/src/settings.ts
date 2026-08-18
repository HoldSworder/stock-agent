import { eq } from 'drizzle-orm';
import type { AppSettings } from '@stock-agent/shared';
import { db, schema } from './db/client';

// 业务配置一律存 SQLite，由 WebUI 设置页维护，不再读取 .env。
// 仅 LLM Base URL / 模型保留内置默认值，其余未配置时为空串。

/** 未配置时的内置默认值（仅非敏感、有合理默认的项） */
const DEFAULTS: Partial<Record<SettingKey, string>> = {
  llmBaseUrl: 'https://api.openai.com/v1',
  llmModel: 'gpt-4o-mini',
  llmContextWindow: '128000',
  trendradarEnabled: 'true',
  researchBaseUrl: 'https://reportapi.eastmoney.com',
  researchEnabled: 'true',
  etfEnabled: 'true',
  // 行情数据源启停（参与 datasource 调度，默认全开）；集思录默认开启用于补 ETF 折溢价（公开端点被限流时可在数据源页补 cookie）
  eastmoneyEnabled: 'true',
  tencentEnabled: 'true',
  sinaEnabled: 'true',
  neteaseEnabled: 'true',
  jisiluEnabled: 'true',
  akshareEnabled: 'true',
  // 中金所股指期货持仓榜（直连 CFFEX CSV，无鉴权），默认开启
  cffexEnabled: 'true',
  // 美股映射（隔夜美股龙头/行业 → A股概念·ETF·个股，经东财 push2），默认开启
  usMapEnabled: 'true',
  // 华泰证券 AI 网关（涨乐/妙想 edge gate），默认开启并指向官方生产网关
  htscBaseUrl: 'https://ai.zhangle.com',
  htscEnabled: 'true',
  // 同花顺问财 OpenAPI（ETF 智能选股），默认开启并指向官方网关
  iwencaiBaseUrl: 'https://openapi.iwencai.com',
  iwencaiEnabled: 'true',
  iwencaiSkillId: 'hithink-etf-selector',
  // 问财个股选股：复用同一 token/网关，默认关闭（账号未开通对应 skill 时探测会报错刷红）
  iwencaiStockSkillId: 'hithink-stock-selector',
  iwencaiStockEnabled: 'false',
  // 财联社电报 / 雪球：经 AKShare(aktools) 透传，默认开启
  clsEnabled: 'true',
  xueqiuEnabled: 'true',
  // a-stock-data sidecar（mootdx 不封IP 行情 + 同花顺一致预期 + 巨潮公告 + 龙虎榜/解禁/两融等 28 端点），默认开启
  astockEnabled: 'true',
  // 微博大V博文（m.weibo.cn 免登录访客态直连），默认开启，无需凭据
  weiboEnabled: 'true',
  // 小红书博主笔记（SSR 页解析），默认开启；不填 Cookie 只能抓到标题
  xhsEnabled: 'true',
  // 大V发帖抓取窗口（天）：只收这个天数内发布的内容。
  // 小红书要拿发布时间必须逐篇请求详情页，窗口越小请求越少、越不容易触发风控。
  weiboFetchDays: '2',
  xhsFetchDays: '2',
};

const KEYS = {
  llmBaseUrl: 'llm_base_url',
  llmModel: 'llm_model',
  llmLightModel: 'llm_light_model',
  llmContextWindow: 'llm_context_window',
  llmApiKey: 'llm_api_key',
  emApiKey: 'em_api_key',
  mxApiKey: 'mx_api_key',
  telegramBotToken: 'telegram_bot_token',
  telegramChatId: 'telegram_chat_id',
  telegramThreadId: 'telegram_thread_id',
  thsCookie: 'ths_cookie',
  thsUserId: 'ths_user_id',
  thsFundKeys: 'ths_fund_keys',
  idpToken: 'idp_token',
  trendradarMcpUrl: 'trendradar_mcp_url',
  trendradarEnabled: 'trendradar_enabled',
  researchBaseUrl: 'research_base_url',
  researchEnabled: 'research_enabled',
  etfEnabled: 'etf_enabled',
  eastmoneyEnabled: 'eastmoney_enabled',
  tencentEnabled: 'tencent_enabled',
  sinaEnabled: 'sina_enabled',
  neteaseEnabled: 'netease_enabled',
  jisiluEnabled: 'jisilu_enabled',
  jisiluCookie: 'jisilu_cookie',
  akshareBaseUrl: 'akshare_base_url',
  akshareEnabled: 'akshare_enabled',
  cffexEnabled: 'cffex_enabled',
  usMapEnabled: 'us_map_enabled',
  htApiKey: 'ht_apikey',
  htscBaseUrl: 'htsc_base_url',
  htscEnabled: 'htsc_enabled',
  iwencaiApiKey: 'iwencai_api_key',
  iwencaiBaseUrl: 'iwencai_base_url',
  iwencaiEnabled: 'iwencai_enabled',
  iwencaiSkillId: 'iwencai_skill_id',
  iwencaiStockSkillId: 'iwencai_stock_skill_id',
  iwencaiStockEnabled: 'iwencai_stock_enabled',
  clsEnabled: 'cls_enabled',
  xueqiuEnabled: 'xueqiu_enabled',
  astockBaseUrl: 'astock_base_url',
  astockEnabled: 'astock_enabled',
  weiboEnabled: 'weibo_enabled',
  weiboCookie: 'weibo_cookie',
  weiboFetchDays: 'weibo_fetch_days',
  xhsFetchDays: 'xhs_fetch_days',
  xhsEnabled: 'xhs_enabled',
  xhsCookie: 'xhs_cookie',
} as const;

type SettingKey = keyof typeof KEYS;

// 敏感字段：对外掩码、空串不覆盖，防止无鉴权读接口泄露与误清空
const SECRET_KEYS = new Set<SettingKey>([
  'llmApiKey',
  'emApiKey',
  'mxApiKey',
  'telegramBotToken',
  'thsCookie',
  'idpToken',
  'jisiluCookie',
  'htApiKey',
  'iwencaiApiKey',
  'weiboCookie',
  'xhsCookie',
]);

const SECRET_MASK_PREFIX = '••••';

/** 把敏感值转换为统一可识别的掩码；空值保持为空 */
export function maskSecret(value: string): string {
  return value ? `${SECRET_MASK_PREFIX}${value.slice(-4)}` : '';
}

/** 判断设置页提交值是否为服务端生成的敏感字段掩码 */
export function isSecretMask(value: string): boolean {
  return value.startsWith(SECRET_MASK_PREFIX);
}

function readRawByName(name: string): string | undefined {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, name))
    .get();
  return row?.value;
}

function readRaw(key: SettingKey): string | undefined {
  return readRawByName(KEYS[key]);
}

/** 读取有效值：DB 优先，未配置回退内置默认值（无默认则空串） */
export function getValue(key: SettingKey): string {
  const fromDb = readRaw(key);
  if (fromDb && fromDb.length > 0) return fromDb;
  return DEFAULTS[key] ?? '';
}

/** 主模型上下文窗口（token）；非法/未配置回退 128000 */
export function getContextWindow(): number {
  const n = Number.parseInt(getValue('llmContextWindow'), 10);
  return Number.isFinite(n) && n > 0 ? n : 128000;
}

export function setValue(key: SettingKey, value: string): void {
  const now = new Date().toISOString();
  db.insert(schema.settings)
    .values({ key: KEYS[key], value, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value, updatedAt: now },
    })
    .run();
}

// ===== 内部元数据 kv =====
// 供调度器等内部模块持久化运行态（任意键），不进 SettingKey 枚举、不进用户设置视图。

/** 读取内部元数据（任意键），未设置返回 undefined */
export function getMeta(name: string): string | undefined {
  return readRawByName(name);
}

/** 写入内部元数据（任意键） */
export function setMeta(name: string, value: string): void {
  const now = new Date().toISOString();
  db.insert(schema.settings)
    .values({ key: name, value, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value, updatedAt: now },
    })
    .run();
}

/** 把早期 deepseek_* 设置迁移到通用 llm_* 键，避免已配置值丢失 */
export function migrateLegacySettings(): void {
  const map: Array<[string, SettingKey]> = [
    ['deepseek_base_url', 'llmBaseUrl'],
    ['deepseek_model', 'llmModel'],
    ['deepseek_api_key', 'llmApiKey'],
  ];
  for (const [oldName, newKey] of map) {
    const oldVal = readRawByName(oldName);
    const newVal = readRaw(newKey);
    if (oldVal && !(newVal && newVal.length > 0)) {
      setValue(newKey, oldVal);
    }
  }
}

/** 读取对外设置值；敏感字段只返回统一掩码，不泄露明文 */
function getPublicValue(key: SettingKey): string {
  const value = getValue(key);
  return SECRET_KEYS.has(key) ? maskSecret(value) : value;
}

/** 对外暴露的设置视图：敏感字段仅显示“已配置”掩码 */
export function getPublicSettings(): AppSettings {
  return {
    llmBaseUrl: getPublicValue('llmBaseUrl'),
    llmModel: getPublicValue('llmModel'),
    llmLightModel: getPublicValue('llmLightModel'),
    llmContextWindow: getPublicValue('llmContextWindow'),
    llmApiKey: getPublicValue('llmApiKey'),
    emApiKey: getPublicValue('emApiKey'),
    mxApiKey: getPublicValue('mxApiKey'),
    telegramBotToken: getPublicValue('telegramBotToken'),
    telegramChatId: getPublicValue('telegramChatId'),
    telegramThreadId: getPublicValue('telegramThreadId'),
    thsCookie: getPublicValue('thsCookie'),
    thsUserId: getPublicValue('thsUserId'),
    thsFundKeys: getPublicValue('thsFundKeys'),
    idpToken: getPublicValue('idpToken'),
    trendradarMcpUrl: getPublicValue('trendradarMcpUrl'),
    trendradarEnabled: getPublicValue('trendradarEnabled'),
    researchBaseUrl: getPublicValue('researchBaseUrl'),
    researchEnabled: getPublicValue('researchEnabled'),
    etfEnabled: getPublicValue('etfEnabled'),
    eastmoneyEnabled: getPublicValue('eastmoneyEnabled'),
    tencentEnabled: getPublicValue('tencentEnabled'),
    sinaEnabled: getPublicValue('sinaEnabled'),
    neteaseEnabled: getPublicValue('neteaseEnabled'),
    jisiluEnabled: getPublicValue('jisiluEnabled'),
    jisiluCookie: getPublicValue('jisiluCookie'),
    akshareBaseUrl: getPublicValue('akshareBaseUrl'),
    akshareEnabled: getPublicValue('akshareEnabled'),
    cffexEnabled: getPublicValue('cffexEnabled'),
    usMapEnabled: getPublicValue('usMapEnabled'),
    htApiKey: getPublicValue('htApiKey'),
    htscBaseUrl: getPublicValue('htscBaseUrl'),
    htscEnabled: getPublicValue('htscEnabled'),
    iwencaiApiKey: getPublicValue('iwencaiApiKey'),
    iwencaiBaseUrl: getPublicValue('iwencaiBaseUrl'),
    iwencaiEnabled: getPublicValue('iwencaiEnabled'),
    iwencaiSkillId: getPublicValue('iwencaiSkillId'),
    iwencaiStockSkillId: getPublicValue('iwencaiStockSkillId'),
    iwencaiStockEnabled: getPublicValue('iwencaiStockEnabled'),
    clsEnabled: getPublicValue('clsEnabled'),
    xueqiuEnabled: getPublicValue('xueqiuEnabled'),
    astockBaseUrl: getPublicValue('astockBaseUrl'),
    astockEnabled: getPublicValue('astockEnabled'),
    weiboEnabled: getPublicValue('weiboEnabled'),
    weiboCookie: getPublicValue('weiboCookie'),
    xhsEnabled: getPublicValue('xhsEnabled'),
    xhsCookie: getPublicValue('xhsCookie'),
    weiboFetchDays: getPublicValue('weiboFetchDays'),
    xhsFetchDays: getPublicValue('xhsFetchDays'),
  };
}

export interface SettingsUpdate {
  llmBaseUrl?: string;
  llmModel?: string;
  llmLightModel?: string;
  llmContextWindow?: string;
  llmApiKey?: string;
  emApiKey?: string;
  mxApiKey?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramThreadId?: string;
  thsCookie?: string;
  thsUserId?: string;
  thsFundKeys?: string;
  idpToken?: string;
  trendradarMcpUrl?: string;
  trendradarEnabled?: string;
  researchBaseUrl?: string;
  researchEnabled?: string;
  etfEnabled?: string;
  eastmoneyEnabled?: string;
  tencentEnabled?: string;
  sinaEnabled?: string;
  neteaseEnabled?: string;
  jisiluEnabled?: string;
  jisiluCookie?: string;
  akshareBaseUrl?: string;
  akshareEnabled?: string;
  cffexEnabled?: string;
  usMapEnabled?: string;
  htApiKey?: string;
  htscBaseUrl?: string;
  htscEnabled?: string;
  iwencaiApiKey?: string;
  iwencaiBaseUrl?: string;
  iwencaiEnabled?: string;
  iwencaiSkillId?: string;
  iwencaiStockSkillId?: string;
  iwencaiStockEnabled?: string;
  clsEnabled?: string;
  xueqiuEnabled?: string;
  astockBaseUrl?: string;
  astockEnabled?: string;
  weiboEnabled?: string;
  weiboCookie?: string;
  xhsEnabled?: string;
  xhsCookie?: string;
  weiboFetchDays?: string;
  xhsFetchDays?: string;
}

export function updateSettings(patch: SettingsUpdate): void {
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(KEYS, k) || typeof v !== 'string') continue;
    const key = k as SettingKey;
    // 敏感字段留空或回传掩码均表示“不修改”
    if (SECRET_KEYS.has(key) && (v === '' || isSecretMask(v))) continue;
    setValue(key, v);
  }
}
