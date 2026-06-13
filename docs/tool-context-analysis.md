# 工具上下文量化与渐进式披露决策报告

> 数据采集日：2026-06-12。口径：复用 `backend/src/agent/loop.ts` 的 CJK 加权 token 估算（CJK 0.6 token/字、其余 0.25 token/字、单条 +4 结构开销），即系统实际用于上下文预算与压缩触发的口径。token 为估算值，非某具体模型 BPE 实测。

## 1. 结论速览

- **当前架构无「按任务限定工具」**：`runAgent` 的工具集只由 `thinking` / `strategyId` / `skillEnabled` 决定（[backend/src/agent/loop.ts](../backend/src/agent/loop.ts) L441、L568），所有定时任务与 Chat 都拿到同一套基础工具的完整定义，每步全量下发。
- **基础工具集 24 个，约 3,805 tokens / 次调用**，占默认上下文窗口（128000）约 **3.0%**；最大集（战法+skill+thinking，28 个）约 4,421 tokens（≈3.5%）。
- **按 context 预算判：暂不迫切**。业界判据「任务上下文 < 窗口 5–10% 则前置全量更简单」，当前 3.0% 在阈值内。
- **按工具数量/选择准确率判：已接近临界**。24–28 个工具逼近业界「30+ 即明显退化」的分水岭，且 Top5 工具占基础集 46%，单个 `save_today_plan` 就占 18.3%。
- **定时任务存在大量常驻浪费**：每个定时任务实际只用 2–7 个工具（均值 ~4.4），却被下发全部 24 个；其中约 9 个工具任何定时任务都用不到。

## 2. 工具 token 成本明细

### 2.1 运行组合总量（每次 LLM 调用常驻）

| 组合 | 工具数 | ~tokens | chars | 占 128k 窗 |
| --- | --- | --- | --- | --- |
| Chat 默认 / 定时任务（thinking off, 无战法） | 24 | 3,805 | 11,365 | 3.0% |
| + thinking | 25 | 3,936 | 11,718 | 3.1% |
| + 战法（simTools） | 26 | 4,102 | 12,214 | 3.2% |
| 最大集（战法 + skill + thinking） | 28 | 4,421 | 13,097 | 3.5% |

> 注：若实际配置更小窗口（如 DeepSeek 64k），基础集占比翻倍至 ~5.9%，已踩 5–10% 阈值下沿。占比随 `llmContextWindow` 设置变化。

### 2.2 Top 占用工具（基础集，按 token 降序）

| 排名 | tokens | chars | 工具 | 占基础集 |
| --- | --- | --- | --- | --- |
| 1 | 697 | 2,458 | `save_today_plan` | 18.3% |
| 2 | 399 | 1,224 | `research_reports` | 10.5% |
| 3 | 283 | 839 | `mx_trade` | 7.4% |
| 4 | 189 | 530 | `eastmoney_datacenter` | 5.0% |
| 5 | 188 | 487 | `decision_debate` | 4.9% |

- Top5 合计 ~1,756 tokens，占基础集 **46.1%**。
- 重头 `save_today_plan` 的成本来自其超大嵌套 schema（marketStance/focusSectors/items 多层 properties）；`research_reports` 来自超长多 action 描述。

## 3. 任务 → 工具映射

> 工具全集（24）：`mx_finance_data` `mx_assistant_ask` `mx_screener` `mx_search` `mx_self_select` `mx_simulator` `real_positions` `stock_quotes` `sync_ths_watchlist` `mx_trade` `mx_cancel` `trendradar_hotspots` `research_reports` `decision_debate` `notify_telegram` `market_snapshot` `get_plan_context` `get_latest_review_stance` `etf_signals` `eastmoney_datacenter` `save_today_plan` `get_today_plan` `update_plan_item` `close_today_plan`。战法另挂 `sim_positions` `sim_trade`；skill 另挂 `propose_skill_update`；thinking 另挂 `think`。

### 3.1 各定时任务实际所需工具（静态解析 prompt 得出）

| 任务 | 来源 | 实际所需工具 | 数量 |
| --- | --- | --- | --- |
| 妙想-0933-开盘选股买入 | cronTasks | mx_screener, mx_simulator, mx_finance_data, mx_trade | 4 |
| 妙想-1015-卖点检查一 | cronTasks | mx_simulator, mx_finance_data, mx_trade, mx_screener | 4 |
| 妙想-1443-卖点检查二 | cronTasks | mx_simulator, mx_finance_data, mx_trade | 3 |
| 妙想-1505-收盘复盘 | cronTasks | mx_simulator, mx_search | 2 |
| 尾盘选股-1445-动能套利 | cronTasks（战法 local） | mx_screener, sim_positions, sim_trade | 3 |
| 旺财-1445-盘中卖点（个股） | cronTasks | get_today_plan, update_plan_item, real_positions, mx_finance_data, mx_search | 5 |
| 旺财-1600-持仓日终（个股） | cronTasks | get_today_plan, real_positions, mx_finance_data, mx_search, trendradar_hotspots | 5 |
| 计划生成 plan.generate | plan 模块 | get_plan_context, mx_screener, real_positions, mx_self_select, mx_finance_data, etf_signals, save_today_plan | 7 |
| 计划复盘 plan.review | plan 模块 | get_today_plan, real_positions, market_snapshot, mx_finance_data, update_plan_item, close_today_plan | 6 |
| 研报机会 research.dailyAnalysis | research 模块 | research_reports, mx_finance_data | 2 |
| ETF-0900-开盘前规划 | etf 模块 | etf_signals, mx_finance_data, real_positions, mx_search, trendradar_hotspots | 5 |
| ETF-0950-早盘机会扫描 | etf 模块 | etf_signals, real_positions, mx_finance_data, mx_search, trendradar_hotspots | 5 |
| ETF-1445-盘中卖点检查 | etf 模块 | get_today_plan, update_plan_item, real_positions, etf_signals, mx_finance_data | 5 |
| ETF-1600-持仓日终监控 | etf 模块 | get_today_plan, real_positions, etf_signals, mx_finance_data | 4 |

- 任何单个定时任务最多用 **7/24** 工具（plan.generate），均值约 **4.4**。
- 即便最重的任务，全量下发也浪费 ≥17 个工具定义。

### 3.2 定时任务从不使用的工具（常驻纯浪费）

以下 9 个工具不被任何启用中的定时任务 prompt 引用，主要服务于交互式 Chat 或战法-skill：

`mx_assistant_ask`、`mx_cancel`、`stock_quotes`、`sync_ths_watchlist`、`decision_debate`、`get_latest_review_stance`（仅遗留 plan 生成旧文案用到）、`notify_telegram`（平台自动推送，模型不主动调）、`eastmoney_datacenter`、`propose_skill_update`（仅战法+skill）。

> 注意：重头工具 `save_today_plan`（697t）仅 plan.generate 用、`research_reports`（399t）仅 research.dailyAnalysis 用、`decision_debate`（188t）无定时任务用——却对所有运行常驻。

## 4. 三种路线对比

| 维度 | A. 保持现状 | B. 轻量静态过滤（推荐） | C. search_tools 元工具 |
| --- | --- | --- | --- |
| 机制 | 全量下发 | 按任务/分组在 `getToolDefinitions` 入口静态裁剪可用集 | 注入 1 个搜索元工具 + 少量核心工具，模型按需发现并注入 schema |
| 改动量 | 0 | 小（复用现有 `getToolDefinitions` 条件挂载 + `TOOL_GROUP` + override 基建） | 中（新增元工具、运行时增量挂载、消息历史扫描已发现工具） |
| 定时任务收益 | — | 显著：每任务工具从 24 砍到 2–7，省 ~60–80% 工具 token，且选择更准 | 显著但有额外 1 轮发现往返开销 |
| Chat 收益 | — | 有限（Chat 仍需宽工具面，可按分组开关或全量） | 最佳（宽工具库下仍只暴露搜索入口） |
| 风险 | 工具数继续增长后选择退化 | 任务声明的工具集需维护，漏配会缺能力 | 小模型对「先搜后用」两段式适配差；多一轮往返延迟 |
| 适配本系统 | — | 高：定时任务工具需求窄且可预知，天然契合 | 中：当前 24 工具规模收益/复杂度比不如 B |

## 5. 是否值得改 · 建议

- **触发改造的不是 context 预算（3.0% 仍宽裕），而是两点**：① 工具数 24–28 逼近选择准确率退化阈值；② 定时任务全量下发造成 60–80% 的工具定义浪费，且会随业务增长持续恶化。
- **推荐路线 B（轻量静态过滤）**，按任务/分组在 `getToolDefinitions` 入口裁剪可用工具集——复用现有 `TOOL_AVAILABILITY` / `TOOL_GROUP` / `applyOverrides` 基建，改动小、对定时任务收益最大、对 Chat 无损（Chat 可保留全量或按分组）。
- **暂不上路线 C / Anthropic `defer_loading` / sandbox code-execution**：当前 24 工具规模下，元工具的两段式开销与适配风险不划算；待工具数显著增长（如 >40）或接入大量外部 MCP 时再评估。

### 落地建议（下一阶段，本报告不含实现）
1. 为定时任务（或任务的 `modelConfig`）增加可选 `toolGroups` / `toolAllowlist` 字段，缺省=全量（向后兼容）。
2. `getToolDefinitions` 增加按 allowlist/分组过滤分支，与现有 `thinking`/`strategy` 条件挂载叠加。
3. 按本报告 §3.1 的映射为各定时任务预置最小工具集；Chat 维持全量或暴露分组开关。
4. 复测：改造后用同口径重跑测量，验证各定时任务工具 token 降幅。

## 附录 · 复现方法

测量脚本为一次性产物，已按计划清理。复现步骤：
1. 临时脚本逐工具序列化 `getToolDefinitions` 各组合（`toolDefinitions` / `simTools` / `skillTools` / `thinkTool` 的 `.definition`），用 §0 的 CJK 加权口径计 token。
2. 因后端 `better-sqlite3` 原生模块按 Node 22 编译，需用 Node 22 运行：`~/.nvm/versions/node/v22.12.0/bin/node --import tsx scripts/measure-tools.ts`（cwd=backend）。
