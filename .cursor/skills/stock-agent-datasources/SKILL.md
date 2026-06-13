---
name: stock-agent-datasources
description: >-
  stock-agent 项目里新增 / 修改外部数据源（行情、资讯、账本、研报、热点、MCP 等取数源）的约定。
  当接入一个新的外部接口作为数据源、调整其凭据 / 启停 / 健康检查时使用。确保新数据源同步到
  数据源页 /datasource（统一健康检查 / 凭据配置 / 启停 / 调用统计）。
---

# stock-agent · 新增数据源

## 核心原则

数据源注册中心 `backend/src/datasource/registry.ts` 的 `SOURCES[]` 是**所有外部取数的单一元数据真相**。新增数据源在此声明一项 `SourceDef`，数据源页 `/datasource` 自动获得：健康检查、凭据配置、启停、调用统计。

## SourceDef 字段

```ts
interface SourceDef {
  id: string;            // 唯一标识，调度层据此过滤 provider
  name: string;          // 展示名
  category: DataSourceCategory;  // 行情 / 资讯 / 账本 / 研报 / 热点 / 本地 ...
  protocol: DataSourceProtocol;  // http-rest / http-jsonp / mcp / local
  baseUrl: string;       // 主机/基址（展示用）
  description: string;   // 用途、鉴权方式、兜底次序等
  enabledKey?: string;   // 启停设置键；无则恒启用（不可在页面启停）
  fields: ConfigFieldDef[]; // 凭据/配置字段（key/label/secret/required/placeholder）
  healthCheck: () => Promise<void>; // 成功返回，失败抛错（错误信息作为 detail 展示）
}
```

## 接入步骤

1. **先注册依赖的设置项**（见 `stock-agent-settings` skill）：
   - 每个 `fields[].key`（凭据，如 `myApiKey`）必须先在 `backend/src/settings.ts` 的 `KEYS` 注册，敏感的进 `SECRET_KEYS`。
   - `enabledKey`（如 `myEnabled`）同样要在 `KEYS` 注册，通常在 `DEFAULTS` 给 `'true'`。
2. 在 `SOURCES[]` 追加一项 `SourceDef`。
3. `healthCheck` 复用该源已有的最小探测函数（如 `ping*()` 或一次轻量取数），**不要新写重逻辑**。
4. 取数逻辑里经 `backend/src/datasource/metrics.ts` 记录调用，使统计 `statsFor(id)` 有数据。
5. 调度层（如 K 线/报价多源兜底）用 `isSourceEnabled(id)` 过滤被禁用的源。

## 最小骨架

```ts
// settings.ts：KEYS 增 myApiKey:'my_api_key'、myEnabled:'my_enabled'；
// SECRET_KEYS 增 'myApiKey'；DEFAULTS 增 myEnabled:'true'；并同步 getPublicSettings/SettingsUpdate/AppSettings

// registry.ts：SOURCES[] 追加
{
  id: 'mysource',
  name: '我的数据源',
  category: '资讯',
  protocol: 'http-rest',
  baseUrl: 'api.example.com',
  description: '...用途与鉴权说明...',
  enabledKey: 'myEnabled',
  fields: [
    { key: 'myApiKey', label: 'API Key', secret: true, required: true, placeholder: '填入 key' },
  ],
  healthCheck: async () => { await pingMySource(); },
},
```

## 自动生效

后端 `backend/src/datasource/index.ts`（`registerDataSourceModule`）暴露 `/api/datasource/*`：`list`/`stats`/`routes`/`:id/health`/`:id/toggle`/`:id/config`。`listSources()` 自动算 `enabled`/`ready`（必需凭据齐备）/`config`（明文回显）/`stats`。**新增数据源无需改这些**，数据源页自动展示与管理。
