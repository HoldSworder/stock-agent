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
  'htApiKey',
  'iwencaiApiKey',
]);

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

/** 对外暴露的设置视图：已登录鉴权保护，直接回显明文便于核对 */
export function getPublicSettings(): AppSettings {
  return {
    llmBaseUrl: getValue('llmBaseUrl'),
    llmModel: getValue('llmModel'),
    llmLightModel: getValue('llmLightModel'),
    llmContextWindow: getValue('llmContextWindow'),
    llmApiKey: getValue('llmApiKey'),
    emApiKey: getValue('emApiKey'),
    mxApiKey: getValue('mxApiKey'),
    telegramBotToken: getValue('telegramBotToken'),
    telegramChatId: getValue('telegramChatId'),
    telegramThreadId: getValue('telegramThreadId'),
    thsCookie: getValue('thsCookie'),
    thsUserId: getValue('thsUserId'),
    thsFundKeys: getValue('thsFundKeys'),
    idpToken: getValue('idpToken'),
    trendradarMcpUrl: getValue('trendradarMcpUrl'),
    trendradarEnabled: getValue('trendradarEnabled'),
    researchBaseUrl: getValue('researchBaseUrl'),
    researchEnabled: getValue('researchEnabled'),
    etfEnabled: getValue('etfEnabled'),
    eastmoneyEnabled: getValue('eastmoneyEnabled'),
    tencentEnabled: getValue('tencentEnabled'),
    sinaEnabled: getValue('sinaEnabled'),
    neteaseEnabled: getValue('neteaseEnabled'),
    jisiluEnabled: getValue('jisiluEnabled'),
    jisiluCookie: getValue('jisiluCookie'),
    akshareBaseUrl: getValue('akshareBaseUrl'),
    akshareEnabled: getValue('akshareEnabled'),
    htApiKey: getValue('htApiKey'),
    htscBaseUrl: getValue('htscBaseUrl'),
    htscEnabled: getValue('htscEnabled'),
    iwencaiApiKey: getValue('iwencaiApiKey'),
    iwencaiBaseUrl: getValue('iwencaiBaseUrl'),
    iwencaiEnabled: getValue('iwencaiEnabled'),
    iwencaiSkillId: getValue('iwencaiSkillId'),
    iwencaiStockSkillId: getValue('iwencaiStockSkillId'),
    iwencaiStockEnabled: getValue('iwencaiStockEnabled'),
    clsEnabled: getValue('clsEnabled'),
    xueqiuEnabled: getValue('xueqiuEnabled'),
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
}

export function updateSettings(patch: SettingsUpdate): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    // 敏感字段留空表示「不修改」，避免掩码回显被原样保存导致清空
    if (v === '' && SECRET_KEYS.has(k as SettingKey)) continue;
    setValue(k as SettingKey, v);
  }
}
