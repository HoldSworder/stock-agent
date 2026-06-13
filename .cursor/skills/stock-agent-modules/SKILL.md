---
name: stock-agent-modules
description: >-
  stock-agent 项目里新增页面级功能模块（如研报、热点、ETF、计划、复盘等独立特性）的约定。当新增
  一个带后端接口 + 前端页面 + 可选定时任务的功能、或为模块加定时、加前端路由时使用。覆盖自包含
  模块范式、模块定时 defineModuleSchedules、前端 view/router、shared DTO 与统一响应/错误约定。
---

# stock-agent · 新增功能模块

## 自包含模块范式

每个功能模块自成一包，可「一行接入、删除即下线」：

1. `backend/src/<module>/` 目录，`index.ts` 导出 `register<Module>Module(app: FastifyInstance)`，内部注册该模块全部 `/api/<module>/*` 路由（参考 `backend/src/research/index.ts`）。
2. 在 `backend/src/server.ts` 末尾**一行接入**并标注「独立，删除此行整模块下线」：
   ```ts
   registerMyModule(app);
   ```
3. 服务/取数/类型分文件：`service.ts`（业务）、`client.ts`（外部取数）、`repo.ts`（落库）按需拆。

## 模块定时（不写中央任务表）

模块内定时**用** `backend/src/scheduling/defineModuleSchedules.ts`，**禁止**写入中央 `scheduled_tasks`（那是任务页/`scheduler.ts` 的领域）。一次调用即获得：配置持久化覆盖（`sched_<module>` 单行 JSON）+ croner 注册 + `/api/<module>/schedules` REST + 节假日 gate + missed-run 告警 + 调度页聚合。

```ts
defineModuleSchedules({
  app,
  module: 'mymodule',
  jobs: [
    {
      id: 'mymodule.daily',        // 全局唯一，形如 module.job
      label: '每日任务（8:00）',
      defaultCron: '0 8 * * 1-5',  // 工作日；节假日由 skipHoliday 默认 gate
      defaultEnabled: true,
      run: async () => { /* 经 gateway/runTask 跑，见 stock-agent-llm-gateway */ },
    },
  ],
});
```

## 前端页面

1. `frontend/src/views/<X>View.vue`。
2. 在 `frontend/src/router.ts` 的 `routes` 注册（懒加载）：
   ```ts
   { path: '/mymodule', name: 'mymodule', component: () => import('./views/MyModuleView.vue') },
   ```
3. 前端请求统一经 `frontend/src/api.ts`，复用其鉴权头与封装。

## 共享类型

前后端公用 DTO **统一放** `shared/src/index.ts`，前后端 `import type { ... } from '@stock-agent/shared'`。**不要**在前端或后端各自重复定义同一 DTO。

## 统一响应 / 错误约定

- 成功：`{ ok: true, data }`。
- 失败：`{ ok: false, error }`，HTTP 码——外部取数/上游失败 `502`，参数校验失败 `400`，资源不存在 `404`。
- 模块内固定写法：
  ```ts
  const fail = (reply, e) => reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
  ```
- AI 调用经 gateway「永不抛错」，按 `result.status` 决定 `ok`。
- 计量 / 推送 / 写透外部（如同花顺、爱盯盘）一律 **best-effort**：失败仅 `console.warn` / 告警，**不阻断主流程**。

## 接入清单

```
- [ ] backend/src/<module>/index.ts 导出 register<Module>Module
- [ ] server.ts 末尾一行接入 + 「删除即下线」注释
- [ ] 定时用 defineModuleSchedules（如有定时）
- [ ] shared/src/index.ts 增 DTO
- [ ] frontend/src/views/<X>View.vue + router.ts 注册路由
- [ ] 新增配置项走 stock-agent-settings；新增数据源走 stock-agent-datasources；新增工具走 stock-agent-agent-tools；LLM 调用走 stock-agent-llm-gateway
```
