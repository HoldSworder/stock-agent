# DSA 借鉴方案批判性 Review

> 评审对象：从 `daily_stock_analysis` 借鉴到本地 `stock-agent` 的 5 项设计方案。
> 评审原则：最小改动、复用优先、不过度抽象；发现不贴合现有代码或过度设计处直接指出。

## 0. 背景与现有代码核对进度

- [x] 已读：`A股每日作战台与板块主线中枢优化规划.md`
- [x] 已读：`tmp-dsa-research.md`
- [x] 已核对：`shared/src/index.ts` 相关 DTO
- [x] 已核对：`backend/src/boards/*`
- [x] 已核对：`backend/src/agent/promptConfig.ts`
- [x] 已核对：`backend/src/agent/gateway.ts`
- [x] 已核对：`backend/src/watch/dispatcher.ts`
- [x] 已核对：`backend/src/etfwatch/dispatcher.ts`
- [x] 已核对：`backend/src/notify/telegram.ts`
- [x] 已核对：`backend/src/settings.ts`
- [x] 已补充核对：`backend/src/market/calendar.ts`、`backend/src/util.ts`、`backend/src/watch/engine.ts`、`backend/src/etfwatch/engine.ts`

## 1. 总体结论

5 项里真正值得落地的是“轻量行动输出稳定化 + 少量 DSA 护栏句 + 确定性时段/数据质量后处理”。不建议照搬 DSA 的大字段模板、全局数据质量工程、复杂通知调度器。

最务实的路径：先把 `board-action` 这一条轻量 oneshot 做稳，包括 prompt 约束、占位补全、动作兜底；再补一个可复用的 A 股 session 工具；然后只在板块详情链路上做最小数据质量标注。推送降噪应先收敛 `watch` / `etfwatch` 已有冷却能力，不要一上来做全局 `reserve/record` 通知门。

## 2. 逐项 Review

### ① 阶段化字段与阶段护栏

- 贴合度：中。规划明确要求按盘前/盘中/盘后组织每日决策流，DSA 的 `phase_decision` 思路方向正确；但当前 `backend/src/market/schedule.ts` 只是大盘模块定时注册，不是交易时段工具。现有可复用点在 `backend/src/market/calendar.ts` 的 `isTradingDay()` / `shanghaiTimeStr()`，以及 `backend/src/util.ts` 的 `isAShareTradingTime()` / `shanghaiClock()`；`watch/engine.ts` 与 `etfwatch/engine.ts` 还各自私有实现了 `isTradingSession()`。
- 问题/风险：如果按方案直接“复用/扩展 `market/schedule.ts`”，会改错边界；应新建或移动到 `market/calendar.ts` / `market/session.ts` 这类纯时间工具。`SessionPhase` 可新增，但不要再造一套和 `ThemePhase` 混淆的生命周期状态；它是交易时段，不是板块阶段。`AiActionVerdict.phase` 若做成复杂对象，会让轻量板块行动卡变重，前端展示和 prompt 解析都会被迫扩散。
- 更懒替代：先实现一个确定性 `getAShareSessionPhase(now)`，返回 `premarket/intraday/lunch/closing/postmarket/nonTrading` 和默认 `nextCheckTime`；`boards/aiAction.ts` 的 `buildContext()` 只追加 2-3 行“当前时段/交易日/下一检查点”。LLM 输出不必第一版就新增完整 `AiActionPhase`，可以先只在后处理时根据 `detail.item.actionTag` 与时段改写 `action`/`conclusion`/`invalidators`。等前端真的要展示独立时段卡，再补 `phase` 字段。
- 边界/并发/回退遗漏：A 股集合竞价口径现有不一致：`watch/engine.ts` 把 9:15-9:30 算交易 session，`etfwatch/engine.ts` 从 9:30 开始，`util.ts` 只算连续竞价且不排节假日。统一工具要显式区分 `auction` 是否并入 `premarket` 或 `intraday`，否则同一时刻不同模块行为继续不一致。午间 `lunch`、15:00 后 `closing/postmarket` 的 nextCheckTime 也应纯确定性生成，LLM 不应自由发挥。
- 与规划冲突：不冲突，但要避免把“阶段化交易时段”扩展成新的板块生命周期状态机。规划已经强调 `ThemePhase` 5 态不乱扩，周期视角与生命周期正交；`SessionPhase` 也应作为第三个正交维度，而不是混进 `ThemePhase`。
- 风险分级：中。风险主要来自时段口径统一会影响 watch/etfwatch/AI 三处行为，若只注入 board-action 则风险可降到低。
- 推荐顺序：第 2 位。先做提示词/占位稳定，再把时段护栏加到行动建议链路。

### ② 数据质量元数据与低质量降置信护栏

- 贴合度：中高。DSA 的数据质量约束非常适合降低 LLM 伪确定性；本项目也已有局部 `stale` 信号：`MarketOverview.stale/dataAsOf`、`BoardBreadthOverview.stale`、`HotConceptOverview.stale`、`CockpitModuleSummary.stale` 等。当前确实没有统一 `DataQualityMeta`，`DataQuality` 搜索为空。
- 问题/风险：方案把 `missingFields` 放在 `boards/service.ts` 的 detail 层，来源却在 `boards/resolver.ts` 的 `resolveBoardPicks()`：`fundScore/trendScore` 是逐只股票字段，不是板块 detail 的天然字段。若只在 service 里事后扫描，会丢失“为什么缺失”（快照无行、因子 enrichment 失败、fundFlow 源失败、候选被市值截断未 enrich）。此外“低质量不得高置信”目前 `AiActionVerdict` 没有 `confidence` 字段，设计里却说降置信，这会引出额外 schema 变更；如果只是阻止“加仓候选”，就不应叫降置信。
- 更懒替代：第一版不加全局 `DataQualityMeta`。在 `BoardWorkbenchDetail` 增一个最小 `dataQuality?: { stale: boolean; missingFields: string[]; note: string }` 即可，字段从现有结果派生：`leaders/laggards` 中 `trendScore/fundScore` 大面积为 null、`buildBreadthOverview().stale` 为 true、`resolveBoardPicks()` 返回空时标注。`buildContext()` 加“数据质量”段；后处理只做一条硬规则：若核心字段缺失且 action 为 `加仓候选/试错`，改为 `观察/等待` 并追加 invalidator。
- 边界/并发/回退遗漏：需要定义“核心项”而不是把所有 null 都当风险。板块无 ETF、无持仓暴露不应压低行动；但成分取数为空、趋势/资金因子全空、breadth stale 才应降级。缓存也是边界：`buildBoardDetail()` 使用 `boards:detail:${boardCode}` 120 秒缓存、`breadth:overview` 30 分钟缓存，`dataQuality.fetchedAt` 若写当前时间会误导，应标注为快照/缓存口径，不要假装代表上游真实时间。
- 与规划冲突：不冲突，但不要一上来扩展到 `backend/src/datasource/` 全链路。规划 P0/P1 的真实主线是稳定 boardCode、一致聚合产物、板块下钻和 exposure；数据质量应服务这些链路，不要变成横跨所有数据源的大工程。
- 风险分级：中。schema 增字段会影响 shared/frontend/backend，但若做成可选最小对象，风险可控。
- 推荐顺序：第 3 位。先把 AI 行动输出稳定住，再接入数据质量护栏。

### ③ AiActionVerdict 完整性校验与占位补全

- 贴合度：高。`generateBoardAiAction()` 已经有雏形：解析失败返回 null，非法 action 回落 `detail.item.actionTag`，数组做 string 过滤，`invalidators` 空时回落 `detail.invalidators`。这说明设计方向不是新能力，而是把当前“失败返回 null”升级为“尽量稳定展示”。
- 问题/风险：方案说“缺必填项填占位而非返回 null”，但 `conclusion` 是前端最核心的一句话，若完全缺失也强行占位，可能把 LLM 失败伪装成有效研判。更合适的边界是：JSON 可解析但字段不完整时补占位；完全无法解析或无任何有效字段时仍返回 null，让 UI 显示“AI 行动建议生成失败/未生成”。
- 更懒替代：不新增复杂 validator。把 `generateBoardAiAction()` 末尾改成一个小的 `normalizeAiAction(parsed, detail)`：`conclusion` 缺失时用 `${detail.item.board}：${detail.item.actionTag}，等待更多确认`；`reasons/evidence` 为空时填“模型未提供，参考底稿证据”；`invalidators` 继续用 `detail.invalidators`；`action` 沿用现有兜底。这个函数不需要重试、不需要 schema 库。
- 边界/并发/回退遗漏：当前 `parseJsonObject()` 用首个 `{` 到最后一个 `}`，遇到多个 JSON 或文本里嵌套示例可能误 parse；但 board-action prompt 要求“严格只输出一个 JSON”，轻量场景可以接受。若新增占位，必须在占位文案里明确“模型未提供”，避免用户把占位当真实 AI 证据。
- 与规划冲突：一致。规划要求 AI 结论固定为行动结构，减少报告式输出；占位补全能让结构稳定，不改变主线真相源。
- 风险分级：低。只动 `boards/aiAction.ts` 和 shared 注释/可选字段时风险小。
- 推荐顺序：第 1 位。它是后续阶段护栏、数据质量护栏的承载点。

### ④ DSA 提示词借鉴

- 贴合度：高。`BOARD_ACTION_PROMPT` 当前只有基础 JSON 契约和“不编造数字”，缺少 DSA 里最有价值的稳定性、时段、数据质量、证据日期约束。补几句约束能以很小成本提升输出纪律。
- 问题/风险：新增 `PROMPT_KEYS.dataQualityGuardrail` 作为“全局提示词段”可能过早。现在真正消费的只有 `board-action`，而 `gateway.call()` 不会自动拼全局 prompt 段；如果新增 key 但只有一个调用点使用，就是多一层间接。更关键的是：提示词页的 `registerPromptDef()` 是为了业务模块注册自身 prompt，不应把每条小规则都拆成一个 key。
- 更懒替代：先直接把 4 条约束追加进 `BOARD_ACTION_PROMPT`，保持单一 prompt：不因单日涨跌剧烈切换；支撑压力之间且资金不明时输出中性；盘前/非交易日不伪造盘中走势，数据降级不得给进攻动作；证据须带日期/来源。等同类约束被 `decision/plan/watch` 至少 2-3 个模块复用，再抽 `PROMPT_KEYS.dataQualityGuardrail`。
- 边界/并发/回退遗漏：提示词只能软约束，必须配合 ①/② 的确定性后处理。特别是“数据 stale/fallback 时置信度不得为高”：当前 `AiActionVerdict` 没有 confidence，提示词应改写为“不得输出加仓候选/试错等进攻动作”，否则字段语义对不上。
- 与规划冲突：不冲突；还符合规划里“AI 输出不再报告化，直接给结论/证据/失效条件/动作”的方向。注意不要搬“个股仪表盘/精确狙击价”，这点方案判断是对的。
- 风险分级：低。prompt 文案变更可回滚，且通过提示词覆盖机制可在线调整。
- 推荐顺序：第 0 位或与 ③ 同步。最小成本最高收益。

### ⑤ 推送降噪

- 贴合度：中。推送降噪确实是 DSA 值得借鉴的点，但本项目高频路径已经有不少控制：`watch/dispatcher.ts` 有 `cooldown` Map、`cooldownMsFor()`、`cacheReuseMin`、`minScore`、`maxConcurrent`、初筛门；`etfwatch/dispatcher.ts` 有 `buyCooldown`、`minConfidence`、低置信降级、死信重投；`etfwatch/engine.ts` 还有 `seenBar` 防同根 K 重复。
- 问题/风险：新增 `notify/noise.ts` 的五类抑制容易和现有模块冷却重复，尤其 `dedup/cooldown` 会叠两层，导致真正该推的卖点/硬止损被吞。`NotifySeverity=info/warning/critical` 与现有 `WatchSeverity=low/medium/high` 也不是同一套，需要映射；ETF 信号甚至没有 severity。`quietHours` 对交易告警很危险，硬止损/补发应默认绕过。`reserve/record/release` 两段式在单进程 Node + 当前串行 dispatch 下偏过度设计，主要价值只是在并发发送同一 key 时避免竞态，但现有引擎已经有 `running/ticking` 与冷却。
- 更懒替代：先不做全局通知门。把 `watch/dispatcher.ts` 的本地冷却抽成一个小工具（例如 `notify/cooldown.ts` 或留在 watch 内），让 `etfwatch/dispatcher.ts` 的买点/卖点共用相同的 key 规则即可。第一版只加两个能力：`dedupKey`（短 TTL，同文案同标的去重）和 `cooldownKey`（同标的同动作冷却），且只包 `pushAlert()`，不包 `sendTelegram()` 全局。死信重投保持直发是对的。
- 边界/并发/回退遗漏：`sendTelegram()` 会把长文本切成多条，若做 reserve/record，应在所有 chunk 都成功后才 record；部分成功时会造成用户收到半条但系统 release 后下轮又发全量。进程内 Map 重启丢状态，与现有 cooldown 一样可接受，但不要承诺持久降噪。fail-open 要明确：降噪配置解析失败/未知 severity 时应发送，不应静默。
- 与规划冲突：不直接冲突，但不属于 P0/P1 主线能力。规划核心是驾驶舱/板块主线/暴露反查/AI 行动结构，推送降噪应排在这些后面。
- 风险分级：中高。不是因为代码难，而是容易误吞交易关键告警，且会横切多个发送路径。
- 推荐顺序：第 5 位。等 board-action 稳定后，只在 watch/etfwatch 高频路径做局部最小化改造。

## 3. 特别关注点结论

- `SessionPhase` 与 `market/schedule.ts` 是否重复：不与 `market/schedule.ts` 重复，因为该文件是模块定时注册；但会与 `market/calendar.ts`、`util.ts`、`watch/engine.ts`、`etfwatch/engine.ts` 里的交易日/交易时段判断重复。正确做法是抽一个纯 session 工具，反向替换私有 `isTradingSession()`。
- `AiActionVerdict` 与既有 `DecisionResult` 是否可复用：不能直接复用。`DecisionResult` 是个股/ETF 多智能体交易裁决，含价格、仓位、分析师报告、风险辩论、叙述等重字段；`AiActionVerdict` 是板块卡片轻量行动结构。可复用的是“action/confidence/keyRisks/traderPlan”思想，不应把板块卡强行升级成 `DecisionResult`。
- 降噪 `reserve/record` 两段式是否过度设计：当前是过度设计。单进程、串行 dispatcher、已有 cooldown/seenBar 的前提下，用一次 `shouldSend()` + 成功后 `markSent()` 就够；除非未来多个模块并发同 key 推送，或要跨进程持久降噪，才需要两阶段 reserve。
- `missingFields` 是否已有现成来源：没有统一来源，但有局部信号。`stale` 已在 breadth/concepts/market/cockpit 等 DTO 中存在；`fundScore/trendScore` 是否缺失只能从 `resolveBoardPicks()` 的结果和因子 enrich 失败推断。第一版应派生，不要新增全局数据源协议。

## 4. 推荐实施顺序

1. ④ + ③：先增强 `BOARD_ACTION_PROMPT`，再加 `normalize/fillAiActionPlaceholders()`。风险低、收益最高。
2. ①：抽 `getAShareSessionPhase()`，先只注入 `board-action` 上下文和后处理；后续再替换 watch/etfwatch 私有时段判断。
3. ②：只在 `BoardWorkbenchDetail` 加最小可选 `dataQuality`，由现有 `stale` 与 `fundScore/trendScore` 缺失派生，并做“核心数据缺失不得进攻”的确定性 action 降级。
4. ⑤：最后做，且先做局部高频路径。不要先上全局 `notifyGuarded`、全局 settings 四键、`reserve/record` 两段式；先复用/统一现有 `cooldownMin`、`cacheReuseMin`、`seenBar` 和死信重投。

最终建议：不要把这 5 项作为一次大重构。按“prompt/占位 → session → 数据质量 → 局部推送降噪”的顺序小步落地，每一步都保持行为可解释、默认不吞关键交易告警。

