---
name: stock-agent-settings
description: >-
  stock-agent 项目里新增 / 修改用户配置项（设置页可填的 key，如凭据、Base URL、启停开关）的约定。
  当需要在设置页暴露一个新配置、或为数据源/模块新增凭据键时使用。确保 settings.ts 多处同步与
  shared 类型对齐，避免读不到 / 不掩码 / 不回显的遗漏。
---

# stock-agent · 新增配置项

## 原则

业务配置一律存 SQLite（`settings` 表），由设置页维护，**不再读 `.env`**。新增一个用户可填配置项，需在 `backend/src/settings.ts` 同步五处 + shared 类型一处，缺一处就会读不到 / 不掩码 / 设置页看不到。

## 五处同步（backend/src/settings.ts）

| # | 位置 | 改什么 |
|---|------|--------|
| 1 | `KEYS` | 增 `camelCaseKey: 'snake_case_db_key'` 映射（DB 列名用 snake_case） |
| 2 | `DEFAULTS` | 仅当有合理默认值且非敏感时增（如 `myEnabled: 'true'`） |
| 3 | `SECRET_KEYS` | 敏感字段（key/token/cookie/密码）加入；触发掩码与「空串不覆盖」 |
| 4 | `getPublicSettings()` | 增 `myKey: getValue('myKey')`，使设置页能读到 |
| 5 | `SettingsUpdate` | 增 `myKey?: string`，使设置页能写入 |

## 第六处：shared 类型

`shared/src/index.ts` 的 `AppSettings` 接口增 `myKey: string`，前后端类型对齐（`getPublicSettings` 返回值即 `AppSettings`）。

## 关键语义

- `getValue(key)`：DB 优先，未配置回退 `DEFAULTS`，再无则空串。
- 敏感字段：设置页提交**空串表示「不修改」**（避免掩码回显被原样存回导致清空）——这由 `updateSettings` 对 `SECRET_KEYS` 的判断保证，所以敏感键务必进 `SECRET_KEYS`。
- 主模型上下文窗口等数值用专用 getter（如 `getContextWindow()`）。

## 内部运行态 ≠ 用户配置

调度水位线、catch-up 时间戳等内部状态用 `getMeta(name)` / `setMeta(name, value)`（任意键，不进 `SettingKey` 枚举、不进设置视图）。**不要**把这类运行态塞进 `KEYS`。

## 最小骨架

```ts
// 1) KEYS
const KEYS = {
  // ...
  myApiKey: 'my_api_key',
  myEnabled: 'my_enabled',
} as const;

// 2) DEFAULTS（非敏感、有默认）
const DEFAULTS: Partial<Record<SettingKey, string>> = { /* ... */ myEnabled: 'true' };

// 3) SECRET_KEYS（敏感）
const SECRET_KEYS = new Set<SettingKey>([/* ... */ 'myApiKey']);

// 4) getPublicSettings()
return { /* ... */ myApiKey: getValue('myApiKey'), myEnabled: getValue('myEnabled') };

// 5) SettingsUpdate
export interface SettingsUpdate { /* ... */ myApiKey?: string; myEnabled?: string; }

// 6) shared/src/index.ts -> AppSettings
export interface AppSettings { /* ... */ myApiKey: string; myEnabled: string; }
```
