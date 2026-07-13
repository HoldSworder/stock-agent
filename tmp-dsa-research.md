# daily_stock_analysis 源码级调研报告

> 调研对象：https://github.com/ZhuLinsen/daily_stock_analysis
> 本报告采用边查边写方式增量补充，仅用于评估其对本地 `stock-agent` 的可借鉴点。

## 0. 调研进度

- [x] README / full-guide / 目录树
- [x] 技术栈与目录架构
- [x] 核心分析 pipeline：取数 -> LLM -> 推送
- [x] 数据源整合与降级
- [x] LLM / prompt 设计
- [x] Agent 策略实现
- [x] 通知推送抽象
- [x] GitHub Actions 定时、交易日历与断点续传
- [x] Web / API 层
- [x] 对 `stock-agent` 的落地建议
- [x] 局限与不适合照搬处

## 1. 信息源索引

已抓取并作为本报告证据的上游资料：

- README：`README.md`，定位为“基于 AI 大模型的 A股/港股/美股/日股/韩股/台股自选股智能分析系统”，主打每日自动分析和推送“决策仪表盘”。
- 完整指南：`docs/full-guide.md`，包含项目结构、Actions、环境变量、数据源、WebUI、回测、决策信号等完整契约。
- GitHub 目录树：`api.github.com/repos/ZhuLinsen/daily_stock_analysis/git/trees/main?recursive=1`，已抓取完整树；由于 JSON 压缩为单行，后续采用 `contents` API 分目录读取。
- 关键源码：`main.py`、`src/core/pipeline.py`、`src/analyzer.py`、`data_provider/base.py`、`src/notification.py`、`.github/workflows/00-daily-analysis.yml`。
- 目录结构补充：`src/agent/`、`src/core/`、`src/services/`、`api/`、`api/v1/`、`apps/dsa-web/`、`apps/dsa-web/src/`。

## 2. 技术栈与目录架构

### 2.1 技术栈

DSA 是 Python 为主、React Web 为辅的“轻部署股票分析产品”：

- 后端/CLI：Python 3.10+，主入口 `main.py`，业务主流程在 `src/core/pipeline.py`。
- Web/API：FastAPI，入口目录 `api/`，版本化路由在 `api/v1/`。
- 前端：`apps/dsa-web/`，React + TypeScript + Vite + Tailwind，具备 Web 工作台、历史报告、Agent 问股、配置管理等页面。
- LLM：`src/analyzer.py` 和 `src/llm/`，文档显示底层支持 LiteLLM 路由、OpenAI 兼容、Gemini、Claude、DeepSeek、Ollama 等。
- 数据源：`data_provider/`，包含 `akshare_fetcher.py`、`tushare_fetcher.py`、`tickflow_fetcher.py`、`yfinance_fetcher.py`、`longbridge_fetcher.py`、`baostock_fetcher.py`、`pytdx_fetcher.py`、`efinance_fetcher.py` 等。
- 通知：`src/notification.py` + `src/notification_sender/`，覆盖企业微信、飞书、Telegram、Discord、Slack、邮件、PushPlus、Server酱、ntfy、Gotify、自定义 Webhook 等。
- 自动化：`.github/workflows/00-daily-analysis.yml`，默认工作日北京时间 18:00 触发，支持手动 `workflow_dispatch` 和 `force_run`。

### 2.2 目录架构

`docs/full-guide.md` 给出的主结构是：

```text
daily_stock_analysis/
├── main.py
├── src/
│   ├── analyzer.py
│   ├── config.py
│   ├── notification.py
│   └── ...
├── data_provider/
├── bot/
├── api/
├── apps/dsa-web/
├── docker/
├── docs/
└── .github/workflows/
```

源码目录进一步显示：

- `src/core/pipeline.py`：`StockAnalysisPipeline` 主流程，负责取数、增强上下文、调用 LLM、保存历史、推送。
- `src/core/trading_calendar.py`：交易日与市场阶段推断。
- `src/analysis_context_pack_prompt.py` / `src/analysis_context_pack_overview.py`：把数据质量、缺失字段、来源状态做成低敏 Prompt 和 Web 可见摘要。
- `src/phase_decision_guardrail.py` / `src/daily_market_context_guardrail.py`：报告生成后的阶段化决策护栏。
- `src/agent/`：策略问股的 Agent 框架，包含 `executor.py`、`orchestrator.py`、`factory.py`、`runner.py`、`tools/`、`strategies/`、`skills/`。
- `api/v1/endpoints/`：FastAPI 的业务接口目录；`api/v1/router.py` 汇总版本路由。
- `apps/dsa-web/src/pages`、`components`、`stores`、`api`、`types`：前端页面、状态、接口封装和类型。

### 2.3 对 stock-agent 的架构启发

值得借鉴的是“产品化契约层”，不是 Python 技术栈本身。

- DSA 把复杂分析结果收敛为稳定的“决策仪表盘”字段，并通过 Web、通知、历史、回测复用；这适合落地到 `backend/src/decision/` 和 `shared/src/index.ts`，形成我们自己的 `DecisionDashboard` DTO。
- DSA 的 `analysis_context_pack` 思路很适合增强我们的数据源透明度：可落到 `backend/src/datasource/` 的调用结果摘要，以及 `backend/src/agent/tools.ts` 给 LLM 的工具结果压缩说明。
- DSA 的模块边界不够干净，大量逻辑集中在 `src/analyzer.py`、`src/core/pipeline.py`、`data_provider/base.py`、`src/notification.py` 等大文件；我们不应照搬文件组织，应该按现有 `backend/src/<module>/index.ts + service/client/repo` 自包含模块范式落地。

## 3. 核心分析 Pipeline

### 3.1 入口

`main.py` 的 `parse_arguments()` 支持 CLI、定时、Web/API 多种运行方式：

- `python main.py`
- `--market-review` / `--no-market-review`
- `--dry-run`
- `--no-notify`
- `--schedule`
- `--force-run`
- `--webui` / `--webui-only`
- `--serve` / `--serve-only`
- `--workers`

`main.py` 中 `_get_stock_analysis_pipeline()` 延迟导入 `src.core.pipeline.StockAnalysisPipeline`；`run_full_analysis()` 构造 `StockAnalysisPipeline(config=config, max_workers=args.workers, query_id=query_id, ...)` 后执行个股分析与可选大盘复盘。这说明 DSA 的 CLI、Web、Bot/API 最终都会汇入同一条 pipeline。

对 `stock-agent` 的借鉴：我们已有 `backend/src/runner.ts`、`backend/src/agent/gateway.ts`、`backend/src/scheduling/defineModuleSchedules.ts`，更适合把“同一任务可由手动/API/定时/推送触发”的入口统一成稳定 `runTask` 风格，而不是复制 DSA 的多 CLI 分支。

### 3.2 单股分析主流程

`src/core/pipeline.py` 的 `StockAnalysisPipeline.__init__` 初始化：

- `DataFetcherManager()`：统一数据源管理。
- `StockTrendAnalyzer()`：技术分析器。
- `GeminiAnalyzer(config=self.config, skills=self.analysis_skills)`：LLM 分析器，名称仍叫 Gemini，但实际文档显示已支持多模型/LiteLLM。
- `NotificationService(...)`：推送服务。

`analyze_stock()` 的关键流程：

1. 构建市场与阶段上下文：`get_market_for_stock()`、`build_market_phase_context()`、`render_market_phase_summary()`。
2. 获取股票名：`fetcher_manager.get_stock_name(code, allow_realtime=False)`。
3. 获取实时行情：`fetcher_manager.get_realtime_quote()`。
4. 获取筹码分布：`fetcher_manager.get_chip_distribution()`。
5. 获取基本面上下文：`fetcher_manager.get_fundamental_context()`，失败时用 `build_failed_fundamental_context()` 构造失败占位。
6. 获取/增强历史 K 线，并用实时行情补 partial bar：`_augment_historical_with_realtime()`。
7. 技术分析：`trend_analyzer.analyze(df, code)`。
8. 组装增强上下文：`_build_enhanced_context(...)`，附带实时行情、筹码、基本面、趋势、市场阶段、持仓上下文。
9. 搜索/舆情/持久化资讯注入到 `news_context`。
10. 生成 `analysis_context_pack_summary` 和 `analysis_context_pack_overview`。
11. 调用 LLM：`self.analyzer.analyze(enhanced_context, news_context=..., analysis_context_pack_summary=...)`。
12. 记录 LLM 调用诊断：`record_llm_run_started()` / `record_llm_run()`。
13. 稳定化与护栏：`stabilize_decision_with_structure()`、`apply_phase_decision_guardrails()`。
14. 保存历史：`db.save_analysis_history(...)`。
15. 触发 `DecisionSignal` 提取与可选推送。

这条 pipeline 很适合我们参考为“产品交付链路”：

- 我们现在策略/回测强，但报告链条应补一个“数据包摘要 -> 决策仪表盘 -> 决策信号资产 -> 通知/Web 复用”的统一链路。
- 建议落地路径：
  - `backend/src/decision/`：增加统一 `DecisionDashboard` / `DecisionSignal` 生成与规范化。
  - `backend/src/plan/`：把阶段化 action window、next check time、watch conditions 接入今日计划。
  - `shared/src/index.ts`：定义前后端共用 DTO。
  - `frontend/src/views/`：在现有决策/今日计划页面展示数据质量和阶段化动作，不新增复杂量化概念。

### 3.3 不适合照搬处

- DSA 的单股 pipeline 过长，`analyze_stock()` 承担取数、上下文构建、LLM、护栏、历史、信号、推送等职责；我们应保持现有模块化拆分。
- DSA 的“LLM 每股分析”更偏日报产品，对我们已有的 ETF 主线轮动和回测模式库不是替代，只适合作为交付层包装。
- DSA 在 Python 中大量依赖运行时 dict；我们是 TS 全栈，应在 `shared/src/index.ts` 建类型，避免自由 JSON 蔓延。

## 4. 数据源整合与降级

### 4.1 数据源适配结构

DSA 的多源能力集中在 `data_provider/base.py` 的 `DataFetcherManager`，各源在 `data_provider/*_fetcher.py` 内独立实现：

- A 股/港股：`EfinanceFetcher`、`TencentFetcher`、`AkshareFetcher`、`TushareFetcher`、`TickFlowFetcher`、`PytdxFetcher`、`BaostockFetcher`。
- 美股/港股/日韩台：`YfinanceFetcher`、`LongbridgeFetcher`。
- 美股补充：`FinnhubFetcher`、`AlphaVantageFetcher`。
- 基本面：`fundamental_adapter.py`、`yfinance_fundamental_adapter.py`。

`DataFetcherManager._init_default_fetchers()` 的源码证据：

- 默认实例化 `EfinanceFetcher`、`TencentFetcher`、`AkshareFetcher`、`PytdxFetcher`、`BaostockFetcher`、`YfinanceFetcher`。
- 仅当配置存在时实例化可选源：`TUSHARE_TOKEN`、`TICKFLOW_API_KEY`、Longbridge OAuth/Legacy 凭据、`FINNHUB_API_KEY`、`ALPHAVANTAGE_API_KEY`。
- 所有 fetcher 按 `priority` 排序，日志输出 `已初始化 N 个数据源（按优先级）`。

这一点与我们 `backend/src/datasource/registry.ts` 的理念类似，但 DSA 更强调“取数路由与降级链”，我们更强调“数据源元数据、健康检查、配置页、统计”。可以借鉴它的路由策略，但实现应落到现有 `backend/src/datasource/`：

- 在 `SourceDef.description` 中显式写出“适用市场、字段能力、兜底顺位”。
- 在实际取数 client/service 中记录 `fallback_from`、`fallback_to`、`latency_ms`、`record_count`，再接入 `backend/src/datasource/metrics.ts`。
- 对实时行情返回结果增加“字段补齐来源”元数据，方便前端解释为什么价格来自 A 源、换手率来自 B 源。

### 4.2 日线数据降级

`get_daily_data()` 的核心策略：

- 先识别市场：美股、港股、日股、韩股、台股、A 股。
- 非 A 股会先过滤不支持该市场日线的 fetcher。
- 美股单独路由：
  - 美股指数：`YfinanceFetcher -> FinnhubFetcher`，因为 Longbridge 不提供指数 K 线。
  - 配置 Longbridge 且非指数：`LongbridgeFetcher -> FinnhubFetcher -> AlphaVantageFetcher -> YfinanceFetcher`。
  - 未配置/不偏好 Longbridge：`FinnhubFetcher -> AlphaVantageFetcher -> YfinanceFetcher -> LongbridgeFetcher`。
- 通用市场按优先级循环尝试；每次失败记录 `record_provider_run()`，包含 provider、operation、success、latency、error_type、error_message、fallback_to。
- 所有源失败时抛出包含各源失败原因的 `DataFetchError`。

这比简单“try/catch 下一个源”更产品化：用户可以知道是哪个源失败、降到哪里、最终用了谁。建议我们落地到：

- `backend/src/datasource/metrics.ts`：扩展 fallback 维度。
- `backend/src/datasource/index.ts`：数据源详情页展示最近失败原因、最近兜底链。
- `backend/src/etfwatch/`、`backend/src/backtest/`：对回测/ETF 监控取数结果记录 source，避免不同源混用导致解释困难。

### 4.3 实时行情字段补齐

`get_realtime_quote()` 更值得借鉴。它不是首源成功就停止，而是：

- 美股/港股先做专用双源路由，配置 Longbridge 后可作为首选，否则 YFinance/AkShare 首选、Longbridge 补充。
- A 股按 `realtime_source_priority` 依次尝试 `efinance`、`akshare_em`、`akshare_sina`、`tencent`、`tushare`、`tickflow` 等。
- 首个成功源作为 `primary_quote`；如果关键字段缺失，则继续尝试后续源补字段。
- `_SUPPLEMENT_FIELDS` 包括 `volume_ratio`、`turnover_rate`、`pe_ratio`、`pb_ratio`、`total_mv`、`circ_mv`、`amplitude`。
- `_enrich_realtime_quote()` 附加 `fetched_at`、`provider_timestamp`、`stale_seconds`、`is_stale`、`fallback_from`，且“不伪造 provider 时间戳”。

对 `stock-agent` 的价值很直接：我们已有板块/宽度/资金流/ETF 策略，最怕“首源有价格但缺资金字段”或“实时字段陈旧但没提示”。建议：

- 在 `backend/src/datasource/` 定义统一 `DataQualityMeta`：`source`、`fallbackFrom`、`fetchedAt`、`providerTimestamp`、`isStale`、`staleSeconds`、`missingFields`、`supplementedFields`。
- 在 `backend/src/agent/tools.ts` 的行情类工具输出里，给 LLM 返回简短质量摘要，避免模型把 fallback/partial 数据当强信号。
- 在 `frontend` 的数据源/决策页展示“主源 + 补字段源 + 陈旧状态”，增强信任感。

### 4.4 不适合照搬处

- `data_provider/base.py` 文件超过 3700 行，聚合了市场识别、路由、监控、字段补齐、降级、基础数据处理；我们不应复制这种巨型 manager。
- DSA 的数据源注册不是独立产品元数据中心，缺少我们 `backend/src/datasource/registry.ts` 这种统一健康检查/启停/凭据配置机制。
- Python pandas 数据帧式日线逻辑不适合直接搬到 Node；应只借鉴“降级链和质量元数据”，不移植实现。

## 5. LLM / Prompt 设计

### 5.1 LLM 调用结构

`src/analyzer.py` 的 `GeminiAnalyzer` 名称保留历史痕迹，但职责已经是统一 LLM 分析器：

- 文件头说明：通过 LiteLLM 统一调用 Gemini/Anthropic/OpenAI 等。
- `analyze()` 流程写明：格式化输入、调用 API（带重试和模型切换）、解析 JSON、返回 `AnalysisResult`。
- `analyze()` 先取 `system_prompt = self._get_analysis_system_prompt(...)`，再用 `_format_prompt()` 组装用户 prompt。
- 调用 `_call_litellm(..., response_validator=self._validate_json_response)`，如果所有模型返回无效 JSON，会触发 `_AllModelsFailedError` 并尝试文本 fallback。
- 生成参数使用 `temperature` 与 `max_output_tokens=8192`。
- 开启 `report_integrity_enabled` 后，会检查必要字段，缺失时追加完整性重试 prompt。

这部分我们不需要照搬，因为 `stock-agent` 已有统一 `backend/src/agent/gateway.ts`，而且规则明确所有 LLM 调用必须经 `gateway.call()`。真正值得借鉴的是它的“输出契约 + 完整性校验 + 缺失占位 + 护栏补强”。

### 5.2 决策仪表盘字段契约

`src/analyzer.py` 的 `SYSTEM_PROMPT`/`LEGACY_DEFAULT_SYSTEM_PROMPT` 明确要求输出“决策仪表盘 JSON”。关键字段包括：

- 顶层：`stock_name`、`sentiment_score`、`trend_prediction`、`operation_advice`、`decision_type`、`action`、`guardrail_reason`、`confidence_level`。
- `dashboard.core_conclusion`：`one_sentence`、`signal_type`、`time_sensitivity`、`position_advice.no_position`、`position_advice.has_position`。
- `dashboard.data_perspective`：
  - `trend_status`：均线/趋势状态。
  - `price_position`：现价、MA5/MA10/MA20、乖离率、安全/警戒/危险、支撑、压力。
  - `volume_analysis`：量比、放量/缩量/平量、换手率、量能含义。
  - `chip_structure`：获利比例、平均成本、集中度、筹码健康。
- `dashboard.intelligence`：`latest_news`、`risk_alerts`、`positive_catalysts`、`earnings_outlook`、`sentiment_summary`。
- `dashboard.battle_plan`：
  - `sniper_points`：`ideal_buy`、`secondary_buy`、`stop_loss`、`take_profit`。
  - `position_strategy`：建议仓位、入场计划、风控策略。
  - `action_checklist`：用 `✅/⚠️/❌` 呈现检查项。
- `dashboard.phase_decision`：`phase_context`、`action_window`、`immediate_action`、`watch_conditions`、`next_check_time`、`confidence_reason`、`data_limitations`。
- `dashboard.signal_attribution`：技术指标、新闻舆情、基本面、市场环境贡献度，以及最强看多/看空信号。
- 叙事字段：`analysis_summary`、`key_points`、`risk_warning`、`buy_reason`、`trend_analysis`、`short_term_outlook`、`medium_term_outlook`、`technical_analysis`、`fundamental_analysis` 等。

对我们最有价值的不是字段多，而是字段分层：

- `core_conclusion`：给用户一眼结论。
- `data_perspective`：解释结论依赖的数据。
- `intelligence`：风险/催化/新闻。
- `battle_plan`：可执行价格与风控。
- `phase_decision`：把盘前、盘中、盘后动作区分开。
- `signal_attribution`：解释“为什么这么判断”。

建议落地：

- `shared/src/index.ts`：新增 `DecisionDashboard`、`DecisionAction`、`DecisionPhaseContext`、`SignalAttribution` 类型。
- `backend/src/decision/`：新增 dashboard normalizer，负责把策略/回测/LLM 输出归一成这套 DTO。
- `backend/src/plan/`：消费 `phase_decision` 生成今日计划与下一次检查点。
- `frontend/src/views/`：在决策/计划页用卡片展示“结论、作战计划、风险、数据质量”，降低用户理解成本。

### 5.3 Prompt 原文中最值得保留的约束

DSA Prompt 的高价值约束包括：

- “核心结论先行”：一句话说清该买、该卖、该等。
- “分持仓建议”：空仓者和持仓者给不同建议。
- “精确狙击点”：必须给出具体价格，不说模糊的话。
- “检查清单可视化”：用 `✅/⚠️/❌` 标明每项检查结果。
- “风险优先级”：舆情风险点醒目标出。
- “不得仅因为单日涨跌或评分跨线就在买入/卖出之间剧烈切换。”
- “股价位于支撑与压力之间、资金流不明确时，优先输出持有/震荡/观望/洗盘观察。”
- “只有在接近支撑确认或有效突破压力，且资金流/量价配合时，才能给出买入；接近压力且资金流出时不得追买。”
- “盘前、非交易日或未知阶段不得伪造今日盘中走势；quote/daily_bars/technical 存在 stale、fallback、missing、fetch_failed、partial 或 estimated 时，置信度不得为高。”
- 新闻时间规则：输出到 `risk_alerts` / `positive_catalysts` / `latest_news` 的每条都必须带日期，超出窗口或时间未知的新闻忽略。
- ETF/指数约束：指数 ETF 风险只关注指数走势、跟踪误差、市场流动性，严禁把基金公司经营新闻当作 ETF 标的风险。

这些约束适合放入我们已有提示词系统：

- `backend/src/agent/promptConfig.ts`：注册全局“决策仪表盘输出规范”和“数据质量/阶段化护栏”提示词。
- `backend/src/agent/gateway.ts` 调用侧：所有决策类 oneshot/agent 走 `getPrompt()` 注入，不在业务文件里硬编码。
- `backend/src/agent/tools.ts`：工具返回时附 `data_limitations`，让 Prompt 中的约束有数据依据。

### 5.4 完整性校验与占位补全

`check_content_integrity()` 明确检查：

- `sentiment_score`
- `operation_advice`
- `analysis_summary`
- `dashboard.core_conclusion.one_sentence`
- `dashboard.intelligence.risk_alerts`
- 对 buy/hold 决策要求 `dashboard.battle_plan.sniper_points.stop_loss`
- 当存在市场阶段上下文时要求 `dashboard.phase_decision` 七字段

缺失时 `apply_placeholder_fill()` 会填入“模型未提供阶段化行动窗口/即时动作/下一次检查点/置信度理由”等占位，而不是让前端崩掉。

这非常适合我们补齐产品稳定性：

- `backend/src/decision/`：实现 `validateDecisionDashboard()` 与 `fillDecisionDashboardPlaceholders()`。
- `shared/src/index.ts`：把必填/可选字段显式类型化。
- `frontend`：可安全渲染“数据缺失/模型未提供”而不是空白。

### 5.5 不适合照搬处

- Prompt 太长、字段太多，单股报告可能过重；我们的 ETF 主线/今日计划更适合“核心结论 + 作战计划 + 数据质量 + 下一步检查”轻量版。
- DSA 的系统提示词硬编码在 `src/analyzer.py` 巨型字符串内；我们已有 `backend/src/agent/promptConfig.ts`，应走可配置提示词页。
- “狙击点位精确到分”对 A 股个股日报有产品感，但对 ETF 主线轮动和量化模式库不一定合适，避免制造伪精确。

## 6. Agent 策略实现

### 6.1 单 Agent：ReAct 工具循环

`src/agent/executor.py` 的文件头把 Agent loop 写得很清楚：

1. 构建 system prompt：persona + tools + skills。
2. 将工具声明发给 LLM。
3. 如果返回 tool call，执行工具并把结果喂回模型。
4. 如果返回文本，解析为最终答案。
5. 循环到最终答案或 `max_steps`。

`AgentExecutor.run()` 用于 dashboard 分析，`AgentExecutor.chat()` 用于自由问答；二者都调用 `_run_loop()`，真正执行委托给 `src.agent.runner`。`chat()` 还会：

- 通过 `resolve_stock_scope()` 解析用户问题涉及的股票。
- 读取 `conversation_manager` 历史。
- 构造可见聊天上下文 `build_agent_chat_context_bundle()`。
- 持久化用户消息和 assistant 回复。
- 把 provider trace 与 tool call 记录到会话上下文。

对我们的意义：

- `stock-agent` 已有 `backend/src/agent/loop.ts` 和 `backend/src/agent/tools.ts`，不需要复制 DSA 的 Python loop。
- 值得补的是“会话上下文与工具轨迹产品化”：把工具调用步骤、数据来源、耗时、失败原因展示到 `frontend/src/views/ChatView.vue` 或 `frontend/src/views/DecisionView.vue`。
- 工具层保持我们现有约定：只改 `backend/src/agent/tools.ts` 注册工具，并由 `/api/tools` 自动展示/启停。

### 6.2 工具注册

DSA 的 `src/agent/tools/registry.py` 定义：

- `ToolParameter`
- `ToolDefinition`
- `ToolRegistry`
- `to_openai_tool()`，统一生成 OpenAI function tools schema，让 LiteLLM 适配多 provider。

`src/agent/factory.py` 的 `get_tool_registry()` 会缓存工具注册表，并注册：

- `ALL_DATA_TOOLS`
- `ALL_ANALYSIS_TOOLS`
- `ALL_SEARCH_TOOLS`
- `ALL_MARKET_TOOLS`
- `ALL_BACKTEST_TOOLS`

`src/agent/tools/data_tools.py` 的具体工具包括：

- `get_realtime_quote`
- `get_daily_history`
- `get_chip_distribution`
- `get_analysis_context`
- `get_stock_info`
- `get_portfolio_snapshot`
- `get_capital_flow`

这与我们 `backend/src/agent/tools.ts` 非常接近。可以借鉴的点是“工具目录按能力分类 + 前端显示名映射 + SSE tool_start/tool_done 展示”。不建议照搬 `ToolRegistry`，因为我们已经由 `ToolDef` + `TOOL_GROUP` + `TOOL_AVAILABILITY` 驱动 `/tools` 页面。

落地路径：

- `backend/src/agent/tools.ts`：为行情、资金流、板块宽度、模式库、今日计划工具补更清晰的 description，明确能力边界和输出质量字段。
- `backend/src/agent/toolsModule.ts`：已有 `/api/tools`，可增加最近调用失败/耗时摘要。
- `frontend/src/views/ChatView.vue`：显示 tool_start/tool_done、工具中文名、耗时、简短结果摘要。

### 6.3 Skill 策略体系

`src/agent/factory.py` 的 `resolve_skill_prompt_state()` 做了几个有价值的产品设计：

- 支持请求级 `skills`，也支持配置级 `config.agent_skills`。
- 校验未知 skill，未知则 warning 并回退默认。
- `SkillManager` 从内置 YAML 和自定义目录加载 skill。
- `SkillManager` 原型被缓存，每次请求 `deepcopy`，避免重复读盘又避免请求间状态污染。
- 当未显式选择策略且默认是内置 `bull_trend` 时，保留 legacy prompt；显式选择后使用 skill-aware prompt。

对我们而言，`backend/src/strategy/skill.ts`、`backend/src/strategy/sim.ts`、`backend/src/modes/` 已经有更强的策略/模式资产，不必照搬 YAML Skill 系统。可借鉴的是“前端显式选择策略/模式后透传到 Agent/分析任务”，落地到：

- `backend/src/agent/tools.ts`：工具可读取当前 `strategyId`/`ctx.strategyId`。
- `backend/src/modes/service.ts`：把推荐模式的 `spec`/买卖逻辑摘要作为 Agent 可用上下文。
- `frontend/src/views/ModeLibraryView.vue` 和 `frontend/src/views/ChatView.vue`：支持“带某个模式上下文发起问答/计划”。

### 6.4 多 Agent 编排

`src/agent/orchestrator.py` 是多 Agent pipeline：

- 文件头写明生命周期：Technical -> Intel -> Risk -> Specialist -> Decision。
- 模式：
  - `quick`：Technical -> Decision，约 2 次 LLM。
  - `standard`：Technical + Intel + Risk -> Decision。
  - `full`：所有内置专家。
  - `specialist`：按激活技能插入 specialist agents。
- `AgentOrchestrator` 暴露和 `AgentExecutor` 一样的 `run()` / `chat()`，可通过 factory 无缝切换。
- 支持全局 timeout，且在剩余预算不足时跳过后续 stage，避免“明知会超时还花一次 LLM 调用”。
- `intel`、`risk`、skill agent 失败可降级，`decision` 等关键阶段失败才中断。
- SSE 事件包括 `stage_start`、`stage_done`、`pipeline_timeout`、`pipeline_budget_skipped`。

这部分很适合我们做“可解释的今日计划编排”，但不应把多 Agent 作为默认。建议：

- 保持 `backend/src/plan/oneclick.ts` 作为一键计划编排入口，拆成确定性数据准备、策略候选、LLM 总结三段即可。
- 将 DSA 的 stage event 思路接入我们“Agent 运行中”抽屉：`backend/src/agent/gateway.ts` / `backend/src/runner.ts` 记录阶段事件，`frontend` 展示进度。
- 对高成本 LLM 编排增加预算护栏：比如最多工具步数、最大耗时、低剩余预算跳过非关键总结。

### 6.5 不适合照搬处

- DSA 的 Agent 和普通分析都有自己的 prompt/skill/context 体系，边界较复杂；我们已有统一 gateway，不应新增第二套 LLM 调用路径。
- 多 Agent 编排成本高，不适合作为每日自动任务默认路径，尤其你当前更关注 ETF 主线和可维护交易纪律。
- DSA 的 Skill 与模式库结合较浅；我们的模式库更强，应让 Agent 消费现有模式，而不是另建一套策略 YAML。

## 7. 通知推送抽象

### 7.1 通知渠道和渲染

`src/notification.py` 的 `NotificationChannel` 支持：

- 企业微信 `wechat`
- 钉钉 `dingtalk`
- 飞书 `feishu`
- Telegram
- Email
- Pushover
- ntfy
- Gotify
- PushPlus
- Server酱
- Custom Webhook
- Discord
- Slack
- AstrBot

`NotificationService` 继承多个 sender mixin，并在初始化时检测所有配置渠道 `_detect_all_channels()`。报告渲染侧包含：

- `generate_dashboard_report()`：聚合 Markdown 报告。
- `generate_wechat_dashboard()`：企业微信精简版，控制长度。
- `generate_brief_report()`：简报。
- `markdown_to_image`：按渠道配置将 Markdown 转图片，失败回退文本。

对我们最有价值的是“同一报告按渠道降级渲染”：

- Telegram/飞书可以用完整 Markdown。
- 企业微信/部分 webhook 需要精简或图片。
- 邮件可以承载更完整报告。

落地到 `stock-agent`：

- 如果当前多渠道推送仍只是发送同一段文本，建议在 `backend/src/plan/` 或现有推送模块旁加 `renderPlanForChannel()`。
- `frontend/src/views/SettingsView.vue` 中可提供“渠道预览/测试”。
- Telegram 输出格式应继续遵守你已有记忆中的 Telegram 渲染规范，避免 DSA 式 emoji 密集格式直接搬来。

### 7.2 路由、降噪和诊断

`send_with_results()` 是核心发送入口：

- 先尝试 `send_to_context()`：如果来自钉钉/飞书/Telegram 会话，可回复原会话。
- 再按 `route_type` 过滤渠道：report、alert、system_error 等。
- 调 `evaluate_notification_noise()` 做去重、冷却、静默时段、最低严重级别等控制。
- 按渠道决定是否转图片。
- 返回 `NotificationDispatchResult`，包含 per-channel `ChannelAttemptResult`。
- 旧 `send()` 保留 bool API，内部委托 `send_with_results()`。

这非常适合我们补“推送可观测性”：

- `backend/src/plan/`、`backend/src/decision/` 触发推送时记录每个渠道成功/失败。
- `frontend/src/views/OpsView.vue` 或 `UsageView.vue` 展示最近推送尝试。
- 高频 alert/ETF watch 可加入 `dedup_key`、`cooldown_key`，避免盘中刷屏。

### 7.3 不适合照搬处

- DSA 通知层耦合报告生成、渠道选择、上下文回复、图片转换、邮件分组，文件过大；我们应拆成 channel adapters + renderer + dispatch log。
- 渠道数量很多，但你当前核心是 Telegram/飞书/可能 WebUI，没必要一次性复制全部。
- Markdown 转图片依赖系统工具，部署复杂；除非明确有渠道不支持 Markdown，否则先不引入。

## 8. GitHub Actions 定时、交易日历与断点续传

### 8.1 GitHub Actions 定时

`.github/workflows/00-daily-analysis.yml` 的关键设计：

- `schedule`：`0 10 * * 1-5`，北京时间工作日 18:00。
- `workflow_dispatch`：支持 `mode` 和 `force_run`。
- `timeout-minutes`：来自 `ANALYSIS_TIMEOUT_MINUTES`，默认 30 分钟，防止卡死。
- `actions/setup-python@v6` 使用 pip cache。
- 显式创建 `data logs reports`。
- 大量 env 映射从 `vars` 或 `secrets` 读取，包括 LLM、搜索、通知、行情源、Longbridge、TickFlow、报告配置、交易日检查。
- `STOCK_LIST_CONFIG` 兼容 repository variables/secrets 和同名 Environment variables。
- 支持把 `LITELLM_CONFIG_YAML` 写入 `LITELLM_CONFIG` 文件。
- 运行模式：
  - `market-only` -> `python main.py --market-review`
  - `stocks-only` -> `python main.py --no-market-review`
  - 默认 -> `python main.py`
  - `force_run=true` 时追加 `--force-run`
- `actions/upload-artifact@v6` 在 `if: always()` 下上传 `reports/` 和 `logs/`，保留 30 天。

对 `stock-agent` 的借鉴：

- 你已经有本地全栈服务和 NAS 部署偏好，不需要把主系统变成 Actions-first。
- 但可以给“每日只读报告/备份任务”做一个 GitHub Actions 或本地 cron 的轻量版，关键是保留日志与报告 artifact。
- 可落到 `backend/src/scheduling/defineModuleSchedules.ts` 的模块定时配置思路：每个模块有自己的任务、启停、节假日 gate、missed-run 告警。

### 8.2 交易日历

`docs/full-guide.md` 与 `main.py` 共同说明：

- `TRADING_DAY_CHECK_ENABLED=true` 默认启用交易日检查。
- `--force-run` 或 `TRADING_DAY_CHECK_ENABLED=false` 可覆盖。
- 使用 `exchange-calendars` 区分 A/H/US/JP/KR 市场交易日历。
- 混合持仓时，每只股票只在其市场开市日分析，休市股票跳过。
- 全部相关市场非交易日时，整体跳过，不启动 pipeline、不推送。

源码证据在 `main.py`：

- `_compute_trading_day_filter()` 如果 `force_run` 或禁用检查，直接返回原 stock list。
- 否则调用 `get_open_markets_today()`，按每个 code 的 `get_market_for_stock()` 过滤。
- `compute_effective_region()` 根据开市市场决定大盘复盘区域。
- `should_skip_all = (not filtered_codes) and (effective_region or '') == ''`。
- `run_full_analysis()` 中如果 `should_skip`，日志提示“今日所有相关市场均为非交易日，跳过执行。可使用 --force-run 强制执行。”

我们已有节假日 gate 能力，建议增强：

- `backend/src/scheduling/defineModuleSchedules.ts`：保持模块定时默认 skipHoliday。
- `backend/src/etfwatch/`：ETF 关注/复盘按 A 股交易日判断，非交易日自动跳过。
- `backend/src/plan/`：今日计划明确标注“非交易日/盘前/盘中/盘后”，避免 LLM 生成不合时宜动作。

### 8.3 断点续传

DSA 的断点续传不是复杂 checkpoint，而是“最新可复用交易日”缓存复用：

- `src/core/pipeline.py` 的 `fetch_and_save_stock_data()` 先调用 `_resolve_resume_target_date(code, current_time)`。
- `_resolve_resume_target_date()` 用 `get_effective_trading_date(market, current_time)`，按市场推断可复用交易日。
- 如果 `not force_refresh and db.has_today_data(code, target_date)`，则跳过网络请求，日志写“数据已存在，跳过获取（断点续传）”。
- `run()` 冻结本轮 `resume_reference_time = current_time or datetime.now(timezone.utc)`，避免批量股票跨收盘边界时使用不同目标日。
- `dry_run` 模式也使用同一套 target date 判断数据是否存在。

这非常适合我们所有行情/宽度/资金流任务：

- 在 `backend/src/datasource/scheduler.ts` 或各业务模块 repo 中统一“目标交易日”概念，避免自然日误判。
- `backend/src/etfwatch/store.ts`、`backend/src/decision/verdictCache.ts`、`backend/src/plan/repo.ts` 可用 `(module, targetTradeDate, source)` 做幂等。
- 对行情类补数任务加 `forceRefresh` 参数，不要每次定时都重打上游。

### 8.4 不适合照搬处

- Actions 适合 DSA 这种个人日报工具，但你的 `stock-agent` 是本地全栈系统，主运行态应保留本地/NAS 定时和 Web 管理。
- DSA 的交易日历覆盖多市场，但我们目前重点 A 股/ETF，先做 A 股交易日和盘中阶段即可。
- 断点续传只判断日线存在，不等于数据完整；我们应结合数据质量元数据判断“存在但字段缺失/陈旧”。

## 9. Web / API 层

### 9.1 FastAPI 应用层

`api/app.py` 是 FastAPI 应用工厂：

- 配置 CORS，`CORS_ALLOW_ALL=true` 且未开认证时会 warning。
- 注册认证中间件和错误处理器。
- `app.include_router(api_v1_router, prefix="/api/v1")`。
- 托管前端静态文件，支持 SPA fallback。
- 对 Vite 资源做一致性自检：`index.html` 引用的 `/assets/*` 不存在时记录明确错误，避免白屏难排查。
- 对 `/assets/{asset_path}` 做路径解析和目录逃逸保护。
- 根路由在前端未构建时返回“Frontend Not Built”引导页面。

这部分产品化细节值得借鉴：

- 我们已有 Vue 前端和 Node 后端，可在 `backend/src/server.ts` 或部署层增加“前端静态资源缺失”诊断页/日志。
- `frontend/src/router.ts` 的 SPA fallback 和 API 404 要区分，避免用户看到空白。

### 9.2 API 路由

`api/v1/router.py` 聚合模块：

- `/auth`
- `/agent`
- `/analysis`
- `/history`
- `/stocks`
- `/backtest`
- `/system`
- `/usage`
- `/portfolio`
- `/alerts`
- `/decision-signals`
- `/alphasift`
- `/intelligence`
- `/health`

与我们已有功能对应关系很强：

- `/analysis` -> `backend/src/decision/`、`backend/src/plan/`
- `/agent` -> `backend/src/agent/`
- `/backtest` -> `backend/src/backtest/`
- `/portfolio` -> 持仓/账户模块
- `/alerts` -> `backend/src/etfwatch/` 和决策提醒
- `/decision-signals` -> 可落到 `backend/src/decision/`
- `/system` -> `backend/src/settings.ts` 和模块定时配置
- `/usage` -> `backend/src/usage.ts` / LLM 调用记录

### 9.3 Analysis API 与任务队列

`api/v1/endpoints/analysis.py` 的注释说明：

- `POST /api/v1/analysis/analyze` 触发分析。
- `GET /api/v1/analysis/status/{task_id}` 查询任务状态。
- `GET /api/v1/analysis/tasks` 获取任务列表。
- `GET /api/v1/analysis/tasks/stream` SSE 实时推送。

特性：

- 异步任务队列，不阻塞请求。
- 相同股票正在分析时返回 409，防重复提交。
- 批量请求会为每只股票提交一个任务。
- `analysis_phase` 会透传到任务与状态。
- `market-review` 单独提交后台任务，并用锁防重复。
- SSE 事件包括 connected、task_created、task_started、task_progress、task_completed、task_failed、heartbeat。
- `/tasks/{task_id}/flow` 返回任务数据流/信息流快照。

我们已有 `backend/src/agent/gateway.ts` 和运行管理，应借鉴“任务流快照”和“SSE 进度事件”：

- `backend/src/runner.ts`：对 `plan`、`decision`、`etfwatch`、`backtest` 任务统一记录阶段。
- `frontend/src/views/OpsView.vue` 或 `CockpitView.vue`：展示任务进行中、最近失败、每步输入输出摘要。
- 避免重复分析：对同一标的/同一日期/同一任务目的做 in-flight key。

### 9.4 Agent API

`api/v1/endpoints/agent.py` 提供：

- `GET /agent/models`：列出 Agent 模型部署。
- `GET /agent/skills`：列出可用策略技能。
- `POST /agent/chat`：同步 chat。
- `GET /agent/chat/sessions`：会话列表。
- `GET /agent/chat/sessions/{session_id}`：会话消息。
- `DELETE /agent/chat/sessions/{session_id}`。
- `POST /agent/chat/send`：把聊天内容发送到通知渠道。
- `POST /agent/research`：深度研究。
- `POST /agent/chat/stream`：SSE 流式进度，事件包括 thinking、stage_start、stage_done、tool_start、tool_done、generating、pipeline_timeout、pipeline_budget_skipped、done、error。

这对我们 `frontend/src/views/ChatView.vue` 很有参考价值。建议优先补：

- 会话列表和会话消息持久化。
- 工具调用流式展示。
- “发送到 Telegram/飞书/今日计划”的动作。

### 9.5 前端页面

`apps/dsa-web/src/App.tsx` 使用 lazy route，页面包括：

- Home
- Backtest
- Settings
- Login
- Chat
- Portfolio
- DecisionSignals
- Alerts
- TokenUsage
- StockScreening

我们本地已有更丰富 Vue 页面：

- `frontend/src/views/CockpitView.vue`
- `DecisionView.vue`
- `PlanView.vue`
- `ModeLibraryView.vue`
- `EtfWatchView.vue`
- `BacktestView.vue`
- `DataSourceView.vue`
- `ChatView.vue`
- `UsageView.vue`
- `OpsView.vue`
- `ScreenerView.vue`

因此无需照搬页面，只需吸收 DSA 的“交付型页面组织”：

- 首页/驾驶舱展示今天要做什么。
- Chat 页面展示工具过程。
- DecisionSignals 页面可以转化为我们 `DecisionView.vue` 的“结构化 AI 建议资产”。
- Settings/DataSource/Ops 页面承接配置、数据源状态、运行诊断。

## 10. 对 stock-agent 的借鉴与落地路径

### 10.1 优先级最高：决策仪表盘 DTO

借鉴理由：DSA 最大价值是把 AI 分析结果做成用户能直接执行的产品化结构，而不是长篇泛泛分析。

建议落地：

- `shared/src/index.ts`：新增 `DecisionDashboard`、`DecisionAction`、`DecisionPhaseDecision`、`DecisionSignalAttribution`、`DataQualityMeta`。
- `backend/src/decision/service.ts`：增加 `buildDecisionDashboard()`，把已有策略结论、资金流、宽度、ETF 主线、LLM 输出统一成 dashboard。
- `backend/src/decision/index.ts`：暴露 dashboard API。
- `frontend/src/views/DecisionView.vue`：按“核心结论 / 作战计划 / 风险催化 / 数据质量 / 下一次检查点”展示。

最小实现建议：先不引入 DSA 的全部字段，只做：

- `coreConclusion`
- `action`
- `positionAdvice`
- `battlePlan`
- `phaseDecision`
- `riskAlerts`
- `dataLimitations`

### 10.2 数据质量元数据进入 Agent 和前端

借鉴理由：DSA 对 `stale`、`fallback`、`missing`、`partial` 的约束能显著减少 LLM 伪确定性。

建议落地：

- `backend/src/datasource/providers.ts` / `backend/src/datasource/metrics.ts`：为取数结果附加 `source`、`fallbackFrom`、`fetchedAt`、`providerTimestamp`、`isStale`、`missingFields`。
- `backend/src/agent/tools.ts`：工具返回压缩版 `dataQuality`。
- `backend/src/agent/promptConfig.ts`：新增“数据质量限制提示词”，要求低质量数据不得输出高置信。
- `frontend/src/views/DataSourceView.vue`：展示最近 fallback 链和缺失字段。

### 10.3 阶段化今日计划

借鉴理由：你核心交易关注 ETF 主线和执行纪律，盘前/盘中/盘后动作不应混在一起。

建议落地：

- `backend/src/plan/service.ts`：加入 `phaseDecision`：`premarket`、`intraday`、`postmarket`、`nonTrading`。
- `backend/src/plan/oneclick.ts`：一键计划输出下一次检查时间、观察条件、失效条件。
- `frontend/src/views/PlanView.vue` 和 `CockpitView.vue`：显示“现在该做什么/下一次什么时候看/触发什么才行动”。

### 10.4 任务流和运行诊断

借鉴理由：DSA 的 task queue + SSE + run flow snapshot 能明显改善“系统在干什么”的可见性。

建议落地：

- `backend/src/runner.ts`：统一记录 task stage：取数、计算、LLM、保存、推送。
- `backend/src/agent/gateway.ts`：将 LLM run 事件接到任务流。
- `frontend/src/views/OpsView.vue`：展示最近任务、阶段耗时、失败原因、推送结果。

### 10.5 推送降噪与渠道渲染

借鉴理由：你有多渠道推送需求，ETF/决策提醒容易刷屏。

建议落地：

- `backend/src/etfwatch/dispatcher.ts`：加入 `dedupKey` 和 `cooldownKey`。
- `backend/src/plan/service.ts`：输出适合 Telegram/飞书的不同摘要。
- `frontend/src/views/SettingsView.vue`：加渠道测试和最近发送状态。

### 10.6 不建议投入的方向

- 不建议迁移 DSA 的 Python 数据源实现；你的系统是 TS/Node，且已有 `backend/src/datasource/`。
- 不建议重做 DSA 多 Agent 框架；先把现有 Agent 的工具轨迹、数据质量、决策 DTO 做好。
- 不建议引入 Markdown 转图片，除非某个渠道明确无法接受 Markdown。
- 不建议复制其大而全的多市场能力；你的当前主线是 A 股/ETF，先把 A 股交易日、ETF 主线、板块宽度产品化。

## 11. 局限与不适合照搬处

### 11.1 DSA 的局限

- 架构大文件明显：`src/analyzer.py`、`src/core/pipeline.py`、`data_provider/base.py`、`src/notification.py` 都承担过多职责，维护成本高。
- Python dict 契约多，类型边界弱；字段很多靠运行时校验/占位补全兜底。
- 产品目标偏“每日 AI 个股报告”，不等于可验证的交易系统。
- 回测更多是对历史 AI 建议做事后验证，不如我们现有 ETF 主线轮动、模式库和因子扫描体系强。
- 多 Agent 与深度研究成本较高，容易把日常任务变慢、变贵。
- 数据源覆盖广但上游不稳定，免费源/爬虫源仍有接口变化和限流风险。
- GitHub Actions 部署适合轻用户，不适合依赖本地持久服务、NAS、WebUI 常驻和复杂状态的系统。

### 11.2 对 stock-agent 的总体判断

DSA 值得我们借鉴的是“交付层”：

- 决策仪表盘字段。
- 数据质量透明度。
- 阶段化动作和护栏。
- 多渠道推送渲染与降噪。
- 任务流/SSE/运行诊断。
- 新手友好的 Web/API 入口。

不值得照搬的是“研究/量化层”：

- 它没有超越我们现有 `backend/src/backtest/`、`backend/src/etfwatch/`、`backend/src/strategy/`、`backend/src/modes/` 的策略能力。
- 它的个股 AI 报告逻辑不能替代我们已验证的 ETF 主线模式库。
- 它的 Python 数据源代码不适合直接移植到 Node。

最推荐的下一步是做一个小闭环：在 `backend/src/decision/` 增加轻量 `DecisionDashboard` DTO 和 normalizer，把现有 ETF/决策/今日计划输出包装成“核心结论 + 作战计划 + 数据质量 + 下一次检查点”，前端先落到 `DecisionView.vue` / `PlanView.vue`，再考虑推送和 Agent 工具轨迹。
