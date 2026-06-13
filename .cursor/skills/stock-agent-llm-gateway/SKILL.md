---
name: stock-agent-llm-gateway
description: >-
  stock-agent 项目里所有 LLM / agent 调用与全局提示词的统一约定。当在 backend 里发起任何
  大模型调用、新增 oneshot 分析 / agent 任务 / 定时任务 / 接口触发的 AI 研判，或新增/修改
  全局系统提示词时使用。确保调用经统一门面 gateway.call() 计入调用记录与运行管理，禁止裸调
  getLLM/runAgent/trackedChat。
---

# stock-agent · 统一 LLM 出入口与计量

## 铁律

1. 全系统所有 LLM / agent 调用**必须经** `backend/src/agent/gateway.ts` 的 `call()`。
2. 业务侧**严禁**裸调 `getLLM()` / `runAgent()` / `trackedChat()`——它们是门面内部专用（见 `backend/src/llm.ts` 头部「内部专用」注释）。绕过门面 = 调用不进计量、不进运行管理。
3. `call()` **永不抛错**，以 `GatewayResult.status`（`success`/`error`/`timeout`/`canceled`）返回，调用方据 `status` 决策。
4. 计量落库是 best-effort（`recordLlmCall` 异常仅告警），**绝不阻断主流程**。

## 两种模式

| mode | 用途 | run | 说明 |
|------|------|-----|------|
| `'agent'` | 多步带工具的 agent 循环（聊天、战法、研判、复盘） | 恒建 run | 支持流式 `onEvent`、`history`、`strategy`、`signal`、`cacheKey` |
| `'oneshot'` | 单次 chat 分析（连通测试、轻量初筛） | `recordRun` 控制 | `recordRun:false` 时仅落调用记录、不进「Agent 运行中」抽屉 |

## 必填字段

每次 `call()` 必须给：

- `purpose`：调用用途分类，落 `llm_calls.purpose`，供 `/usage` 调用记录页按用途聚合（见 `backend/src/usage.ts`）。取值用稳定、可读的 kebab/简短串（现有：`chat`/`review`/`analyze`/`research`/`strategy`/`market-review`/`connectivity` 等）。新增功能时沿用或新增一个语义明确的常量值，**不要每次随手拼新串**。
- `trigger`：`'cron' | 'manual' | 'chat' | 'watch'`（来自 `@stock-agent/shared`）。仅 `cron` 失败时门面会自动 Telegram 告警。
- `taskName`：运行管理与调用明细的展示名。

## 最小骨架

oneshot（单次分析）：

```ts
import * as gateway from '../agent/gateway';

const r = await gateway.call({
  mode: 'oneshot',
  purpose: 'my-feature',
  trigger: 'manual',
  taskName: '我的分析',
  prompt,
  // recordRun: false, // 高频初筛/连通测试时只计量不建 run
});
if (r.status !== 'success') return reply.code(502).send({ ok: false, error: r.error });
return { ok: true, data: r.outputText };
```

agent（带工具多步）——业务侧通常经 `runTask`（`backend/src/runner.ts`，内部即调 `gateway.call`），直接发起时：

```ts
const r = await gateway.call({
  mode: 'agent',
  purpose: 'my-feature',
  trigger: 'cron',
  taskName: '我的任务',
  prompt,
  modelConfig: { thinking: false, maxSteps: 12, maxTokens: 16000 },
  timeoutSec: 600,
  notifyChannels: ['webui', 'telegram'], // 成功后自动推送
});
```

## 反例（禁止）

```ts
// ❌ 裸调底层：不计量、不进运行管理
import { getLLM } from '../llm';
const { client, model } = getLLM();
const res = await client.chat.completions.create({ model, messages });
```

## 全局提示词

- 新增/修改全局系统提示词**注册到** `backend/src/agent/promptConfig.ts` 的 `DEFS`（含 `key`/`label`/`hint`/`base`），key 用 `PROMPT_KEYS` 常量。
- 运行时一律经 `getPrompt(key)` 取生效值（覆盖优先，回退默认）。
- **禁止**在 `backend/src/agent/loop.ts` 里硬编码新提示词字符串——注册到 `DEFS` 后，提示词页 `/prompts` 自动可视化 + 全局覆盖。
