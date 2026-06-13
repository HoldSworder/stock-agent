---
name: stock-agent-agent-tools
description: >-
  stock-agent 项目里新增 / 修改 Agent 可调用工具（function tool）的约定。当在
  backend/src/agent/tools.ts 增删工具、调整工具描述或挂载条件时使用。确保新工具同步到
  工具页 /tools（自动罗列 / 启停 / 描述覆盖），并正确归入分组与挂载条件。
---

# stock-agent · 新增 Agent 工具

## 改哪些文件

只动一个文件：`backend/src/agent/tools.ts`。新增工具需同步三处：

1. 在对应数组注册 `ToolDef`：
   - `tools[]`：常规工具（`availability='always'`，恒挂载）。
   - `simTools`：战法相关（仅绑定战法时挂载，`availability='strategy'`）。
   - `skillTools`：战法 Skill 自迭代（`availability='strategy_skill'`）。
   - `thinkTool`：仅 thinking 模式挂载（`availability='thinking'`）。
2. `TOOL_GROUP`：工具名 → 分组（工具页 `/tools` 分区展示）。未列出回落「其他」。
3. `TOOL_AVAILABILITY`：默认按数组归类自动派生；新增数组或特殊挂载条件时显式补。

## ToolDef 结构

```ts
export interface ToolDef {
  definition: OpenAI.Chat.Completions.ChatCompletionTool; // type:'function' + function{name,description,parameters}
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>; // 始终返回 string
}
```

`ToolContext` 提供：`runId` / `strategyId` / `skillEnabled` / `forceTrade` / `signal`。

## 编写约定

- `run` **始终返回 string**（结构化结果用 `JSON.stringify`）。
- 入参用 `asString(args.x)` 等辅助做防御性取值，不直接信任 LLM 传值。
- 网络类工具**透传 `ctx.signal`** 给底层 fetch，运行被 abort 时即时中断、省请求与 token。
- 大输出用 `preview(value, max)` 智能截断（保头尾），避免撑爆上下文。
- `description` 要写清能力边界与用法（LLM 据此决定何时调用），可在工具页被运行时覆盖。

## 最小骨架

```ts
// 1) 注册到 tools[]
{
  definition: {
    type: 'function',
    function: {
      name: 'my_tool',
      description: '一句话说清能力与用法，给 LLM 看。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '查询语句' } },
        required: ['query'],
      },
    },
  },
  run: async (args, ctx) => preview(await myService(asString(args.query), ctx.signal)),
},
```

```ts
// 2) TOOL_GROUP 补一行
const TOOL_GROUP: Record<string, string> = {
  // ...
  my_tool: '研报热点', // 选已有分组或新建
};
```

挂载到 `tools[]` 的工具 `availability` 会自动派生为 `'always'`，无需手动改 `TOOL_AVAILABILITY`。

## 自动生效

工具页后端在 `backend/src/agent/toolsModule.ts`（`/api/tools`）+ `backend/src/agent/toolConfig.ts`（启停/描述覆盖存 settings 的 `tool_overrides` 单行 JSON）。`listToolInfo()` 合并代码定义与用户覆盖。**新增工具无需改前端**，工具页自动罗列、可启停、可覆盖描述。
