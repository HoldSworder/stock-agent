import { eq } from 'drizzle-orm';
import type { AppSettings } from '@stock-agent/shared';
import { db, schema } from './db/client';
import { config } from './config';

// 运行时设置：DB 中的 kv 覆盖 .env 默认值。
// 敏感 key 存 DB，方便从 WebUI 配置而无需改环境变量重启。
// 模型为任意 OpenAI 兼容服务。

const KEYS = {
  llmBaseUrl: 'llm_base_url',
  llmModel: 'llm_model',
  llmApiKey: 'llm_api_key',
  emApiKey: 'em_api_key',
  mxApiKey: 'mx_api_key',
  telegramBotToken: 'telegram_bot_token',
  telegramChatId: 'telegram_chat_id',
  telegramThreadId: 'telegram_thread_id',
  ovBaseUrl: 'ov_base_url',
  ovApiKey: 'ov_api_key',
  ovAccount: 'ov_account',
  ovUser: 'ov_user',
  ovEventsPrefix: 'ov_events_prefix',
} as const;

type SettingKey = keyof typeof KEYS;

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

/** 读取有效值：DB 优先，回退 .env */
export function getValue(key: SettingKey): string {
  const fromDb = readRaw(key);
  if (fromDb && fromDb.length > 0) return fromDb;
  switch (key) {
    case 'llmBaseUrl':
      return config.llm.baseUrl;
    case 'llmModel':
      return config.llm.model;
    case 'llmApiKey':
      return config.llm.apiKey;
    case 'emApiKey':
      return config.miaoxiang.emApiKey;
    case 'mxApiKey':
      return config.miaoxiang.mxApiKey;
    case 'telegramBotToken':
      return config.telegram.botToken;
    case 'telegramChatId':
      return config.telegram.chatId;
    case 'telegramThreadId':
      return config.telegram.threadId;
    case 'ovBaseUrl':
      return config.openviking.baseUrl;
    case 'ovApiKey':
      return config.openviking.apiKey;
    case 'ovAccount':
      return config.openviking.account;
    case 'ovUser':
      return config.openviking.user;
    case 'ovEventsPrefix':
      return config.openviking.eventsPrefix;
    default:
      return '';
  }
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

/** 对外暴露的设置视图，敏感字段仅返回是否已配置 */
export function getPublicSettings(): AppSettings {
  return {
    llmBaseUrl: getValue('llmBaseUrl'),
    llmModel: getValue('llmModel'),
    llmApiKeySet: getValue('llmApiKey').length > 0,
    emApiKeySet: getValue('emApiKey').length > 0,
    mxApiKeySet: getValue('mxApiKey').length > 0,
    telegramBotTokenSet: getValue('telegramBotToken').length > 0,
    telegramChatId: getValue('telegramChatId'),
    telegramThreadId: getValue('telegramThreadId'),
    ovBaseUrl: getValue('ovBaseUrl'),
    ovApiKeySet: getValue('ovApiKey').length > 0,
    ovAccount: getValue('ovAccount'),
    ovUser: getValue('ovUser'),
    ovEventsPrefix: getValue('ovEventsPrefix'),
  };
}

export interface SettingsUpdate {
  llmBaseUrl?: string;
  llmModel?: string;
  llmApiKey?: string;
  emApiKey?: string;
  mxApiKey?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramThreadId?: string;
  ovBaseUrl?: string;
  ovApiKey?: string;
  ovAccount?: string;
  ovUser?: string;
  ovEventsPrefix?: string;
}

export function updateSettings(patch: SettingsUpdate): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    setValue(k as SettingKey, v);
  }
}
