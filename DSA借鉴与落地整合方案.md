# DSA 借鉴与落地整合方案

> 对象：从开源项目 [daily_stock_analysis (DSA)](https://github.com/ZhuLinsen/daily_stock_analysis) 借鉴到本地 `stock-agent` 的功能设计、评审结论与 WebUI 落地方案。
> 本文整合三部分产物：① DSA 源码级调研（见 `tmp-dsa-research.md`）；② 五项借鉴设计 + codex(gpt-5.5) 批判性评审修正（见 `tmp-dsa-review.md`）；③ 从产品角度的 WebUI 落地设计。
> 结论口径：**最小改动、复用优先、不过度抽象；不吞关键交易告警；无量化背景也能维护。**

---

## 1. 结论摘要

- DSA（54k stars，Python + React）是"每日 AI 分析 + 决策仪表盘 + 多渠道推送"的**轻量交付型产品**。它的价值对我们**不在算法/量化**（那是我们的强项），而在**产品交付层**：结构化行动输出、数据质量透明、阶段化动作、推送降噪、任务可见性。
- 本轮重构（`A股每日作战台与板块主线中枢优化规划.md`）已经把 DSA 的"骨架"吃透：`AiActionVerdict`（结论/理由/证据/失效条件/动作）、板块决策卡片、boardCode 稳定关联键、持仓暴露反查都已实现。
- **还值得补的是 DSA 的"皮肤"**：① 阶段化动作字段、② 数据质量护栏、③ 输出完整性兜底、④ 提示词纪律约束、⑤ 推送降噪。
- 五项**都不是大重构**，应按"prompt/占位 → session 时段 → 数据质量 → 局部推送降噪"小步落地，每步默认不改变现有行为。

---

## 2. DSA 概览与定位差异

| 维度 | DSA | 本地 stock-agent |
|------|-----|------------------|
| 技术栈 | Python + FastAPI + React | TypeScript/Node 全栈 + Vue |
| 定位 | 泛用每日 AI 个股报告，开箱即用 | 板块主线驱动的 A股每日决策助手，自建深度量化 |
| 强项 | 产品化交付、多市场、多渠道推送、易用性 | ETF 主线轮动回测、模式库、板块宽度、因子扫描 |
| 分析产出 | 决策仪表盘 JSON（个股级，字段极多） | 板块作战台 + AiActionVerdict（板块级，轻量行动结构） |
| 部署 | GitHub Actions 零成本 / Docker | 本地 / 群晖 NAS 常驻全栈 |

**不照搬**：Python 数据源实现、巨型 `pipeline.py`/`analyzer.py`、多市场（日韩台）、10+ 渠道、Markdown 转图片、多 Agent 编排、个股仪表盘的精确狙击价字段（对板块是伪精确）。

---

## 3. 已借鉴到位（无需再动）

| DSA 设计 | 本地已有实现（证据） |
|---|---|
| 决策仪表盘"行动结构" | `AiActionVerdict`（`shared/src/index.ts:2617`）：conclusion/reasons/evidence/invalidators/action |
| 数据源降级链 + 稳定关联键 | `buildMainlineConsensus`（`breadth/consensus.ts:39`）boardCode 优先 + `nameMatch` 兜底 + 未命中留痕 |
| 板块决策卡片（阶段/强度/操作标签） | `boards/service.ts`：`deriveActionTag`/`deriveCycleFit`/`deriveRiskTags` |
| 板块下钻龙头/补涨 | `boards/resolver.ts` + `BoardStockPick` |
| 持仓/自选暴露反查 + 快照对齐 | `boards/exposure.ts` + `snapshotDate` |
| 提示词可视化覆盖 | `promptConfig.ts`：`listPromptInfo`/`setPromptOverride`/`registerPromptDef` |
| 个股盯盘冷却去重 | `watch/dispatcher.ts`：`cooldown` Map + `cooldownMsFor`（按 severity 分级） |

> 说明：我们坚持"确定性锚（板块新高宽度）优先于软证据"，比 DSA 纯 LLM 报告更抗追高，这是我们相对 DSA 的优势，保持。

---

## 4. 五项借鉴设计（codex 评审修正后的最终版）

> 贯穿认知：**交易时段用交易日历确定性算 → 注入 prompt → LLM 产出 → 完整性兜底 → 阶段护栏校正**。LLM 不负责判断"现在几点、能不能盘中动手"。
> ⚠️ 区分两个"阶段"：`ThemePhase`（启动/加速/分歧/退潮）= 板块生命周期（已有）；`SessionPhase`（盘前/盘中/盘后）= 交易时段（新增，正交维度，**不得混入 ThemePhase**）。

### ① AiActionVerdict 补"阶段化"字段

**缺口**：`AiActionVerdict` 只有结论/动作，缺"现在该不该动手、下次何时看、�ய什么触发"。

**设计（含 codex 修正）**：
- 新增 `SessionPhase = 'premarket'|'intraday'|'lunch'|'closing'|'postmarket'|'nonTrading'`。
- **不改 `market/schedule.ts`**（那是模块定时注册，非时段工具）。真正重复的是 `market/calendar.ts`、`util.ts` 的 `isAShareTradingTime`，以及 `watch/engine.ts`/`etfwatch/engine.ts` 各自私有的 `isTradingSession`。→ **抽一个纯工具 `getAShareSessionPhase(now)`**（放 `market/calendar.ts` 或新 `market/session.ts`），后续反向替换那些私有实现。
- **集合竞价口径必须统一**：现状三处不一致（`watch/engine.ts` 把 9:15–9:30 算 session，`etfwatch/engine.ts` 从 9:30，`util.ts` 只连续竞价且不排节假日）。新工具要显式定义 `auction` 归 `premarket` 还是 `intraday`。
- **第一版不急于给 `AiActionVerdict` 加完整 `AiActionPhase` 对象**（避免轻量卡变重）。先在 `boards/aiAction.ts` 的 `buildContext()` 追加 2–3 行"当前时段/交易日/下一检查点"，产出后用 `applyPhaseGuardrail(parsed, phase, actionTag)` 后处理：
  - `phase ∈ {premarket, nonTrading}` 且 action 为进攻类（加仓候选/试错/减仓）→ 改写 `conclusion`/追加 invalidator 为"等待盘中确认，禁止追高"。
  - `nextCheckTime` 按时段确定性兜底（盘前→今日 09:30、盘中→14:30 尾盘、盘后→明日 09:30），不让 LLM 自由发挥。
- 等前端要展示独立时段卡，再补 `phase?: AiActionPhase` 字段。
- 护栏逻辑镜像 DSA `phase_decision_guardrail.py`（`CONSERVATIVE_ACTION_PHASES` + `_safe_wait_action`）。

**风险**：中（时段口径统一会影响 watch/etfwatch/AI 三处；若第一版只注入 board-action 则降到低）。

### ② 数据质量元数据 + "低质量不给进攻动作"护栏

**缺口**：只有日级 `snapshotDate`，`buildContext` 把强度/龙头当既成事实喂 LLM，不标注兜底/缺字段 → 伪确定性追高风险。

**设计（含 codex 修正）**：
- **不做全局 `DataQualityMeta`**。在 `BoardWorkbenchDetail` 加**最小可选** `dataQuality?: { stale: boolean; missingFields: string[]; note: string }`，字段从现有结果派生：`leaders/laggards` 的 `trendScore/fundScore` 大面积为 null、`buildBreadthOverview().stale` 为 true、`resolveBoardPicks()` 返回空。
- **"核心项"要显式定义**，不是所有 null 都当风险：板块无 ETF/无持仓暴露**不**压低动作；成分取数为空、趋势/资金因子全空、breadth stale 才降级。
- **术语修正**：`AiActionVerdict` **没有 confidence 字段**，不叫"降置信"。护栏改为：核心字段缺失且 action 为进攻类 → **降级为观察/等待 + 追加 invalidator**"因资金数据缺失，加仓前需人工确认"。
- 缓存口径：`boards:detail` 120s、`breadth:overview` 30min 缓存，`dataQuality` 时间应标注为"快照/缓存口径"，不冒充上游真实时间。
- `buildContext()` 追加【数据质量】段供 LLM 参考。

**风险**：中（schema 增字段影响 shared/frontend/backend；做成可选最小对象则可控）。**不扩展到 `datasource/` 全链路。**

### ③ AiActionVerdict 完整性校验 + 占位补全

**缺口**：`generateBoardAiAction` 现在失败即返回 null；字段不全时体验不稳。

**设计（含 codex 修正）**：
- 新增小函数 `normalizeAiAction(parsed, detail)`（不引 schema 库、不做 LLM 重试——board-action 是 `recordRun:false` 轻量 oneshot，重试不值）：
  - `reasons/evidence` 为空 → 填"模型未提供，参考底稿证据"（**占位文案必须明示"模型未提供"**，不能把失败伪装成研判）。
  - `invalidators` 为空 → 沿用 `detail.invalidators`；进攻类动作无失效条件时**强制**兜底。
  - `action` 非法 → 沿用现有 `detail.item.actionTag` 兜底。
- **`conclusion` 完全缺失 / JSON 完全解析失败 → 仍返回 null**，让 UI 显示"生成失败"，不强行占位。
- 关键规则：只在"能解析但字段不全"时占位。

**风险**：低（只动 `boards/aiAction.ts` + shared 可选字段）。**推荐第 1 位落地**，它是①②护栏的承载点。

### ④ DSA 提示词借鉴（只搬约束句，不搬字段模板）

**缺口**：`BOARD_ACTION_PROMPT` 只有基础 JSON 契约 + "不编造数字"，缺纪律约束。

**设计（含 codex 修正）**：
- **不新增 `PROMPT_KEYS.dataQualityGuardrail`**（只有一个调用点，过早抽象）。直接把 4 条约束追加进 `BOARD_ACTION_PROMPT`：
  1. 不因单日涨跌或评分跨线在买卖间剧烈切换。
  2. 股价位于支撑与压力之间、资金流不明确时，输出中性（观察/持有）。
  3. 盘前/非交易日不伪造盘中走势；数据 stale/fallback/缺失时**不得给加仓候选/试错等进攻动作**（注意：因无 confidence 字段，措辞是"不给进攻动作"而非"不给高置信"）。
  4. 证据须带日期/来源，超窗口或时间未知的忽略。
- 提示词纪律是**软约束**，必须配合①②的确定性后处理。
- 等同类约束被 decision/plan/watch 至少 2–3 个模块复用，再抽公共 key。

**风险**：低（prompt 可回滚，且提示词页可在线覆盖）。**推荐第 0 位或与③同步——最小成本最高收益。**

### ⑤ 推送降噪

**缺口**：ETF 盯盘 `etfwatch/dispatcher.ts` 的 `pushAlert` 直发无冷却；无统一降噪层。

**设计（含 codex 修正——砍掉过度设计）**：
- **不做全局 `notify/noise.ts` + `notifyGuarded` + `reserve/record` 两段式**。单进程串行 dispatcher + 已有 `cooldown`/`seenBar` 下，两段式是过度设计。
- 把 `watch/dispatcher.ts` 的本地冷却抽成一个**小工具**（`notify/cooldown.ts` 或留 watch 内），让 `etfwatch/dispatcher.ts` 买卖点共用相同 key 规则。
- 第一版只加两个能力，且**只包 `pushAlert()`，不包全局 `sendTelegram()`**：
  - `dedupKey`（短 TTL，同文案同标的去重）
  - `cooldownKey`（同标的同动作冷却）
- **安全红线**：硬止损/卖点/死信重投**默认绕过降噪**，`quietHours` 对交易告警很危险，务必对关键告警豁免。
- `sendTelegram` 会把长文切多条 → 若记录冷却，须所有 chunk 成功后才记；部分成功不记（保证死信重投能再来）。
- fail-open：降噪配置解析失败/未知 severity 时放行，不静默。
- 进程内 Map 重启丢状态（与现有 cooldown 一致，可接受），**不承诺持久降噪**。

**风险**：中高（不是代码难，而是容易误吞交易关键告警，且横切多发送路径）。**推荐最后落地。**

### 特别关注点结论（codex）

- `SessionPhase` 不与 `market/schedule.ts` 重复，但与 `market/calendar.ts`/`util.ts`/`watch/engine.ts`/`etfwatch/engine.ts` 的时段判断重复 → 抽纯工具反向替换。
- `AiActionVerdict` **不能**直接复用 `DecisionResult`（后者是含价格/仓位/分析师报告的重字段个股裁决）；只复用其 action/keyRisks 思想。
- 降噪 `reserve/record` 两段式在单进程下**过度设计**，`shouldSend()` + 成功 `markSent()` 足够。
- `missingFields` 无统一来源，但有局部 `stale` 信号（breadth/concepts/market/cockpit DTO）；第一版派生，不新增全局数据源协议。

---

## 5. WebUI 落地设计（产品视角）

> 贯穿原则：不新增导航（全部落进 `CockpitView`/`BoardWorkbenchPanel`/`SettingsView`）；摘要先行、详情按需；信任信号克制（灰标非报警）；专业词挂 `MetricScaleHint`；延续"空态隐藏避噪"惯例。

### ① 阶段化 → AI 行动卡"三行决策卡"
- **落点**：`BoardWorkbenchPanel.vue` 的 `aiAction` 区 + `CockpitView` 卡头。
- **形态**：`action 标签(已有色) + 板块` / `现在：盘前计划，等待 09:30 竞价` / `盯：突破 60 日线且量比>1.5` / `下次看：今日 09:30(灰字+时钟图标)`。
- **时段徽标**：卡右上 `el-tag` info 色显示盘前/盘中/盘后，一眼知道"现在能不能执行"。
- **驾驶舱决策流(P0b)**：`CockpitView` 顶部按 `getAShareSessionPhase()` 自动切折叠区——盘前展开"计划+待确认"、盘中展开"异动+持仓风险"、盘后展开"复盘"，无需手动选。
- `watchConditions` 卡面只露 1 条，其余进抽屉。

### ② 数据质量 → 灰色"可信度小标"，非报警
- **落点**：`BoardWorkbenchPanel` 详情抽屉标题旁 + AI 行动卡内。
- **形态**：灰色小标 `数据完整 / 部分缺失 / 快照较旧`，hover 出 `MetricScaleHint` 白话说明缺什么/为什么。**数据完整时不显示任何标**（延续暴露面板"无命中即隐藏"）。
- 核心数据缺失导致动作降级时，`invalidators` 出现🔒"因资金数据缺失，加仓前需人工确认"，让用户明白"不是不看好，是数据不够"。
- 用词全白话，禁用 stale/fallback/missing 黑话。

### ③ 完整性占位 → 三种明确 UI 态
- **落点**：`BoardWorkbenchPanel` 的 `genAiAction` 结果区。
- **三态**：① 正常=三行决策卡；② 字段不全=缺项显示斜体灰字"模型未提供理由"（不留空不崩）；③ 完全失败=显示"生成失败，点此重试"+ 确定性底稿兜底结论。**绝不把失败伪装成研判。**
- `aiLoading` 用骨架屏，失败态给一键重试。

### ④ 提示词约束 → 提示词中枢页可读可调
- **落点**：`SettingsView` 提示词管理（`promptConfig` 可视化覆盖机制已有）。
- "板块行动结构研判"条的 `hint` 更新为白话："已内置交易纪律（不追高、支撑压力间保持中性、数据不足不给进攻动作）"。
- 用户能看默认、一键覆盖、恢复默认——即产品级可维护性。不新增独立 key，就一段 prompt。

### ⑤ 推送降噪 → 后端降噪 + 前端"被抑制可见性"
> 产品洞察：降噪一旦静默吞消息，用户会不信任系统。**必须让"被抑制"可见。**
- **配置**：`SettingsView` → "模型与推送"Tab 加"推送降噪"折叠区：冷却时长(滑块)、静默时段(时间段)、最低推送级别(下拉)，默认全关。**明确标注"硬止损/卖点告警不受降噪影响"。**
- **可见性**：`OpsView` 加"最近被降噪抑制的推送"列表（标的/原因/时间），让用户核对"没推是因为降噪不是系统坏了"。
- **盘中告警**：`EtfWatchView` 告警流里被冷却的信号显示"已静默(冷却中)"灰标而非消失（复用已有 `disposition` 留痕机制）。
- 默认全关=零行为变化；开了也永远能看到抑制了什么。

---

## 6. 实施顺序与风险

| 顺序 | 后端改动 | 前端 UI | 后端风险 | UI 成本 |
|:--:|---|---|:--:|:--:|
| 1 | ④ 增强 `BOARD_ACTION_PROMPT` + ③ `normalizeAiAction` | AI 行动卡三态 + 失败重试 | 低 | 低 |
| 2 | ① 抽 `getAShareSessionPhase()` + `applyPhaseGuardrail`（先只注入 board-action） | 行动卡三行化 + 时段徽标 + 驾驶舱时段折叠 | 中 | 中 |
| 3 | ② `BoardWorkbenchDetail` 加最小 `dataQuality` + 派生 | 灰色可信度小标 + MetricScaleHint | 中 | 低 |
| 4 | ⑤ 局部冷却（抽小工具给 etfwatch 复用） | 降噪配置块 + Ops 被抑制列表 | 中高 | 中 |

**总原则**：不作为一次大重构。按"prompt/占位 → session 时段 → 数据质量 → 局部推送降噪"小步落地，每步行为可解释、默认不吞关键交易告警。

**落地后的用户价值**：一张板块决策卡即可读到——这是什么动作、现在能不能做、盯什么触发、数据可不可信、AI 生成成没成功，**无需任何量化知识**，把规划里"首页 30 秒回答四问"从口号变成可交互界面。

---

## 7. 附录：关键证据索引

**DSA 侧**：
- `src/analyzer.py:2013` `SYSTEM_PROMPT`（决策仪表盘字段 + 稳定性/时段/数据质量约束）
- `src/analyzer.py:284` `check_content_integrity` / `:362` `apply_placeholder_fill`
- `src/phase_decision_guardrail.py`（`apply_phase_decision_guardrails` / `CONSERVATIVE_ACTION_PHASES` / `_safe_wait_action`）
- `src/notification_noise.py`（`evaluate_notification_noise` / dedup / cooldown / quiet_hours / fail-open / reserve-record）

**本地侧**：
- `shared/src/index.ts:2617` `AiActionVerdict`、`:2514` `BoardWorkbenchItem`、`:2565` `BoardWorkbenchDetail`、`:4330` `ThemePhase`、`:4527` `CockpitOverview`
- `backend/src/boards/aiAction.ts`（`generateBoardAiAction`/`buildContext`）、`boards/service.ts`、`boards/resolver.ts`、`boards/exposure.ts`
- `backend/src/agent/promptConfig.ts`（`BOARD_ACTION_PROMPT`/`PROMPT_KEYS`/`getPrompt`）
- `backend/src/breadth/consensus.ts:39` `buildMainlineConsensus`
- `backend/src/watch/dispatcher.ts`（`cooldown`/`cooldownMsFor`）、`etfwatch/dispatcher.ts`（`pushAlert`/`retryEtfUndelivered`）
- `backend/src/market/calendar.ts`、`backend/src/util.ts`（`isAShareTradingTime`）、`watch/engine.ts`/`etfwatch/engine.ts`（私有 `isTradingSession`）
- 前端：`CockpitView.vue`、`BoardWorkbenchPanel.vue`、`BoardExposurePanel.vue`、`PlanView.vue`、`SettingsView.vue`、`OpsView.vue`、`EtfWatchView.vue`、`MetricScaleHint.vue`

> 详细调研原文见 `tmp-dsa-research.md`；codex 评审原文见 `tmp-dsa-review.md`。
