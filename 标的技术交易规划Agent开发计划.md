# 标的技术交易规划 Agent 开发计划

> 状态：审查合并版 v2，待实现  
> 目标位置：标的详情页 `KlineDialog` 右侧 Agent 区域  
> 核心目标：基于量价关系、道氏结构与可验证的缠论候选结构，把复杂证据收敛为“当前阶段 + 唯一主动作 + 触发/失效/止盈止损”，为个股、ETF及可分析指数生成“下一交易日 + 后续一段时间”可执行、可失效、可复盘的通用技术交易计划，并同步在 K 线图上绘制辅助线。  
> 产品边界：只做分析、规划、提醒和复盘，不自动下单，不把模型推演包装成确定性预测。

## 一、最终交付形态

用户打开任一个股或ETF的 K 线弹窗后，可以在右侧看到一张持续更新的“标的交易计划”，而不只是一次性的 Agent 对话文本。指数可以生成市场参考计划，但必须明确其不可直接交易；实际动作要落到对应ETF、股票或其他可交易载体。

每份计划必须回答七个问题：

1. 当前主要趋势是什么：上涨、下跌还是震荡。
2. 当前价格处于什么结构位置：支撑、压力、中枢内部、突破区或趋势延伸区。
3. 下一交易日应该做什么：观察、试错、加仓、持有、减仓或退出。
4. 什么条件触发动作：必须是可验证的价格、量能和结构条件。
5. 什么条件证明判断错误：必须有结构失效位和时间失效条件。
6. 后续一段时间有哪些路径：主路径、转强路径、转弱路径分别如何应对。
7. 对当前用户该怎么做：结合无仓/持仓、成本、仓位、可用数量和账户总风险给唯一主动作。

计划生成后，系统自动把以下内容同步到 K 线：

- 支撑区、压力区；
- 入场触发线、加仓确认线；
- 结构失效线、止损线；
- 第一目标区、第二目标区；
- 关键顶底分型、趋势线、中枢候选区；
- 当前计划版本与各辅助线的有效/失效状态。

计划不是预测报告，而是一组条件分支：

```text
如果满足触发条件 → 执行计划动作
如果仍在观察区 → 等待，不提前猜底或追突破
如果满足失效条件 → 取消原计划并进入防守
如果超过有效期仍未触发 → 计划过期，重新评估
```

## 二、当前代码基线

当前工作区已经具备较好的实现基础，Cursor 应基于现状增量开发，不要重建平行页面或回退现有改动。

| 能力 | 当前实现 | 后续用途 |
|---|---|---|
| 全局 K 线弹窗 | `frontend/src/components/KlineDialog.vue` | 承载图表、计划卡、标注图层和 Agent 对话 |
| 标的长期会话 | `frontend/src/components/SymbolChatPanel.vue`、`/api/chat/sessions/by-symbol/:code` | 保存针对单一标的的长期分析上下文 |
| 多周期 K 线 | `KlinePeriod` 已支持 5m/15m/30m/60m/120m/日/周/月 | 日线定方向、60分钟定结构、15分钟找触发 |
| K 线标注 | `backend/src/symbolMarks/`、`SymbolMark` | 已支持价位线、点位、区间、趋势线 |
| Agent 画线工具 | `list_kline_marks`、`add_kline_mark`、`remove_kline_mark` | 保留为底层通用工具，计划生成改走原子化同步 |
| 今日计划 | `backend/src/plan/`、`frontend/src/views/PlanView.vue` | 作为全账户当日作战层，后续引用标的计划快照 |
| 战法 DSL | `backend/src/playbook/`、`PlaybookSpec` | 后续用于把稳定规则转成回测规则，不承担首期计划存储 |
| 数据调度与缓存 | `backend/src/datasource/`、`backend/src/market/eastmoney.ts` | 获取复权 K 线、行情和缓存状态 |
| 大盘阶段 | `backend/src/regime/`、`MarketRegimePhase` | 复用“主升/反弹/退潮/震荡”作为账户风险闸门，不在标的模块重复计算 |
| 风险预算 | `backend/src/positions/riskBudget.ts`、`PositionSizing` | 复用ATR、跳空、费用缓冲和仓位上限计算 |
| 持仓纪律 | `backend/src/positions/discipline.ts` | 读取成本、仓位、可用数量和账户集中度，把市场判断转换成个人动作 |
| ETF信号 | `backend/src/etf/service.ts` | ETF适配层复用IOPV、折溢价、动量、波动率和网格信息，但不直接沿用其简化买卖结论 |
| 板块宽度 | `backend/src/breadth/` | 判断ETF或个股所在板块的上涨是否有广度支持，避免少数权重/龙头造成假强势 |

当前缺口：

- Agent 输出以自然语言为主，无法被稳定监控和复盘；
- 标注只按 `code + label` 管理，没有计划版本、周期、语义和有效状态；
- 标注在各周期图上缺少严格的周期过滤；
- “今日计划”一天一份，不适合保存单标的跨日交易逻辑；
- 缺少确定性技术证据层，LLM 容易自行计算或混用指标；
- 缺少计划版本、触发、失效、过期、复盘的完整生命周期；
- 缺少通用“交易标的—所属板块—跟踪/参考指数—宽基基准”映射语义；恒生科技指数与A股恒科ETF只是其中一个典型案例。

### 2.1 对审查意见的吸收决策

`标的技术交易规划Agent开发计划-审查意见.md` 作为审查记录保留，本文是Cursor后续实施的唯一主计划。审查项处置如下：

| 编号 | 决策 | 并入主计划的结果 |
|---|---|---|
| R1 | 采纳 | 新增 `SymbolTradePlanProposal`；LLM只写摘要和选候选ID，完整计划由后端编译 |
| R2/R15 | 采纳 | 完成定义拆为MVP必达与数据增强，无数据源时显式降级 |
| R3 | 采纳 | 广度只读 `board_newhigh_snapshots` 日频快照，生成计划时禁止实时全市场遍历 |
| R4/R5 | 采纳 | 并发取数、核心/可选分层降级、日线120根MVP口径、工具输出6000字符硬上限 |
| R6/R7 | 采纳 | 补工具可发现性、结构化重试与无线位 `draft` 降级 |
| R8/R12 | 采纳 | 复用 `market/levels.ts`、`market/indicators.ts`、`modes/factors.ts`，只补缺失算法 |
| R9 | 采纳 | 计划条件直接复用/扩展 `PlaybookRule`，不建第二套DSL |
| R10 | 采纳 | 扩展 `watch/rules.ts::evalPlanSignals`，复用现有告警管道 |
| R11 | 采纳 | 保留标的级阶段机，把真正滞回计入新增工作量，明确三层阶段冲突优先级 |
| R13 | 采纳削减 | 波浪首期仅允许出现在解释文本，不进DTO、图层、状态机和验收门禁 |
| R14 | 采纳约束 | 缠论统一为 `candidate/insufficient`，不得单独产生入场动作 |
| R16 | 采纳（阻塞级） | Phase 1新增确定性候选目录生成器，定义来源、聚类、排序、数量上限和条件展开白名单 |
| R17 | 采纳 | 新增 `list_symbol_plan_candidates`独立工具；技术上下文只返回 `contextId`与目录摘要，候选目录独立预算 |
| R18 | 采纳 | 保持旧 `PlaybookRuleGroup` 和已存spec可读；新规则声明可回测能力，`assertRunnableSpec` 明确拒绝不可回测规则 |
| R19 | 采纳 | 实时求值拆为tick级价格条件和bar级技术条件，按 `code+period+barTime+planVersion` 去重并缓存序列 |
| R20 | 采纳 | 保留 `getStockIndicators(code, signal?)` 的60根日线默认行为，新增可配多周期入口供计划模块使用 |

对东财分钟线深度、ETF成分映射、五档行情与未来事件日历不作乐观假设，统一在Phase 0先实测、再决定是否打开增强能力。

## 三、模型的统一分工

技术模型不能平级投票。高点降低、低点降低在道氏和缠论候选结构中出现，本质上是同一条价格证据，不能算作多次独立确认。

系统固定采用以下层级：

| 层级 | 主要模型 | 系统职责 | 是否直接产生交易动作 |
|---|---|---|---|
| 方向 | 道氏理论 | 判断高低点结构和上涨/下跌/震荡状态 | 否，决定只做顺势、等待或防守 |
| 参与度 | 量价关系 | 判断突破、回踩、止跌是否获得资金确认 | 是，作为触发条件的一部分 |
| 结构 | 缠论简化结构 | 识别分型、笔、候选中枢及买卖点候选 | 否，只提供结构候选，必须和量价确认同时成立 |
| 路径 | 条件情景 | 把已编译条件组织为主路径、转强路径和风险路径 | 否，只解释“如果…则…”的预案 |
| 风险 | ATR + 结构止损 | 计算防守距离、仓位上限和时间止损 | 是，决定最大可承受仓位 |

### 统一决策顺序

```text
日线道氏方向
  → 价格所处关键区域
  → 60分钟缠论/高低点结构
  → 15分钟或日线触发信号
  → 成交额确认
  → 结构失效位与风险收益比
  → 条件情景补充主路径与风险路径
```

只有“位置 + 结构 + 触发 + 防守”同时明确时，计划才允许给出 `probe/add/reduce/exit`；否则统一输出 `wait`。

## 四、技术证据必须由代码确定性计算

LLM 负责解释、组合和生成条件分支，不负责手工计算指标。新建确定性技术证据服务，为 Agent 提供带来源和时间戳的结构化输入。

建议目录：

```text
backend/src/symbolPlans/
  index.ts
  service.ts
  repo.ts
  technicalEvidence.ts
  structure.ts
  volumePrice.ts
  candidateCatalog.ts
  markSync.ts
  prompt.ts
```

新目录是聚合与编排层，不是重写指标库。必须直接复用：

- `backend/src/market/levels.ts`：ATR(14)、枢轴支撑压力、斐波那契、MA与主导波段；
- `backend/src/market/indicators.ts`：复用MACD/KDJ/RSI/BOLL纯计算函数；保持旧 `getStockIndicators(code, signal?)` 签名、60根日线取数和默认输出不变，新增 `getIndicatorsMulti` 或等价可配入口供计划模块指定 `period/limit/secid/signal`；
- `backend/src/positions/riskBudget.ts`：ATR、跳空、费用缓冲和个股/ETF仓位上限；
- `backend/src/modes/factors.ts`：相对强弱计算基础。

MVP真正新增的技术计算只有：成交额比与收盘位置、确认摆动点与道氏状态机、分型/简化笔/候选中枢。禁止在 `technicalEvidence.ts` 内复制ATR、均线、枢轴位、斐波那契或MACD算法。

### 4.1 数据窗口

每次生成计划按“核心必需、适配可选”读取。所有上游请求使用 `Promise.allSettled` 并发执行，单项失败不得拖垮整份计划：

- 周线：120根，用于主要趋势背景；
- 日线：MVP读取120根，与现有 `PREWARM_BARS=120` 缓存口径对齐，用于道氏结构、均线、ATR和关键区间；若后续需要250根，先修改并验证预热策略；
- 60分钟：目标上限320根，用于分型、笔、候选中枢和二买/三买结构；
- 15分钟：目标上限320根，用于次日具体触发；
- 实时行情：最新价、昨收、成交额、量比、振幅；
- ETF可选补充：现有数据可提供的IOPV、折溢价和基金规模；跟踪指数、成分权重、跟踪误差、折算事件在未接入可验证数据源前一律标记缺失；
- 个股可选补充：现有数据可提供的所属板块、涨跌停制度、ST、停复牌、除权除息、解禁/增减持、筹码和近期跳空风险；未来财报预约/业绩预告日历在无稳定数据源时标记缺失。

核心证据是多周期 K 线、价格结构、量价和 ATR；适配器证据可缺省并进入 `warnings`。单工具总时间受现有30秒超时约束，聚合服务应设置更短的内部截止时间并优先返回核心证据。东财实际可返回的15m/60m深度必须在Phase 0实测，不足320根时使用实际样本并明示降级。周线降级到不复权数据源时，必须写入 `EvidenceMeta.warnings`。

每组数据都要返回：

```ts
interface EvidenceMeta {
  asOf: string;
  source: string;
  period: KlinePeriod;
  adjusted: boolean;
  completeBar: boolean;
  stale: boolean;
  warnings: string[];
}
```

盘中日 K 线必须标记为未完成，不能把盘中累计成交量直接与完整日均量比较。盘中量能优先使用同时间累计量或量比；收盘后才使用完整成交额/成交量判断。

### 4.2 量价标准

所有标的都同时计算成交额和成交量；ETF默认以成交额为主、成交量为辅，个股则结合换手率判断成交量变化是否具有可比性：

```text
amountRatio20 = 当日成交额 / 前20个完整交易日成交额中位数
volumeRatio20 = 当日成交量 / 前20个完整交易日成交量中位数
```

注意：分母不包含当日。ETF跨基金份额拆分日期、个股跨除权除息/送转扩股日期比较成交量前必须调整；无法调整时只使用成交额、换手率并写入数据警告。

默认阈值：

| 比值 | 状态 |
|---|---|
| < 0.65 | 极度缩量 |
| 0.65～0.80 | 明显缩量 |
| 0.80～0.90 | 温和缩量 |
| 0.90～1.10 | 正常 |
| 1.10～1.35 | 温和放量 |
| 1.35～1.70 | 明显放量 |
| > 1.70 | 极端放量 |

同时计算收盘位置：

```text
closeLocation = (close - low) / (high - low)
```

- 突破确认：成交额比值建议 ≥ 1.20，收盘位置 ≥ 0.67；
- 健康回踩：成交额缩至突破日的 70%～80%以内，结构支撑不破；
- 放量滞涨：明显放量但未突破前高、收盘位置偏低；
- 放量下跌：明显放量且收盘接近最低，优先判为风险而非“资金进场”。

### 4.3 道氏结构

由代码基于确认后的摆动高低点输出：

```ts
type TrendState = 'uptrend' | 'downtrend' | 'range' | 'transition';

interface SwingPoint {
  id: string;
  period: KlinePeriod;
  kind: 'high' | 'low';
  time: string;
  price: number;
  confirmed: boolean;
}
```

规则至少覆盖：

- 更高高点 + 更高低点：上涨；
- 更低高点 + 更低低点：下跌；
- 仅低点抬高但尚未突破前高：转折观察；
- 仅突破前高但尚未形成回踩低点：突破待确认；
- 结构结论必须引用具体 `SwingPoint.id`，不能只给文字。

### 4.4 缠论结构

首期不要宣称实现“严格缠论全自动划分”。缠论存在包含处理、笔定义和中枢级别的流派差异，MVP采用可解释、版本化的“缠论简化结构”：

- 固定K线包含处理算法；
- 确认顶分型、底分型；
- 连接交替分型形成简化笔；
- 基于三个次级别摆动的共同重叠计算“候选中枢”；
- 输出一买/二买/三买及一卖/二卖/三卖的“候选”状态；
- 证据不足时返回 `insufficient`，禁止强行标点。

建议状态：

```ts
type ChanSetup =
  | 'none'
  | 'first_buy_candidate'
  | 'second_buy_candidate'
  | 'third_buy_candidate'
  | 'first_sell_candidate'
  | 'second_sell_candidate'
  | 'third_sell_candidate'
  | 'insufficient';
```

二买至少满足：首次低点 `L1` 后出现反弹高点 `H1`，回踩低点 `L2 > L1`，且小级别重新转强。三买至少满足：向上离开候选中枢后，回踩不重新进入中枢，再次转强。

所有缠论结果都必须保留 `candidate` 语义。买点候选不得单独导出 `probe/add`；只有与同周期或触发周期的量价确认同时成立，且风险收益与执行闸门通过时，后端才能把市场动作升级。

### 4.5 条件情景（MVP）与波浪边界

MVP只保留与可执行条件直接相关的主路径、转强路径和风险路径。情景中的条件必须来自后端候选条件目录，不允许 LLM 自由发明价格或指标。

波浪理论首期不进入结构化DTO、状态机、结构化情景、图层或验收门禁。LLM可在 `summary` 中把它作为辅助路径语言，但不得出现“根据波浪所以买入/卖出”。自动波浪计数只能在MVP闭环稳定后作为独立实验项目评估。

### 4.6 统一市场阶段状态机

为了降低用户心智负担，各技术证据层最终不能各自输出结论。系统必须把所有证据收敛成一个唯一的标的阶段，并给出与阶段绑定的默认应对。

```ts
export type SymbolMarketPhase =
  | 'decline'       // 下跌防守
  | 'bottoming'     // 筑底观察
  | 'recovery'      // 右侧修复
  | 'uptrend'       // 上升持有
  | 'acceleration'  // 加速谨慎
  | 'distribution'  // 高位分歧/派发
  | 'uncertain';    // 数据不足或证据冲突
```

阶段必须由确定性证据驱动，建议规则如下：

| 阶段 | 必要结构 | 辅助证据 | 默认动作 |
|---|---|---|---|
| 下跌防守 | 更低高点+更低低点，或跌破关键低点 | 价格在MA20/MA60下方、均线向下 | 无仓等待；持仓减仓/退出；禁止补跌 |
| 筑底观察 | 下跌速度减弱，暂未确认低点抬高 | 底分型候选、缩量、背驰候选 | 等待；触发后仅小仓试错 |
| 右侧修复 | 形成低点抬高，突破小级别下降结构 | MA20走平、二买候选、量价改善 | 试错或小幅加仓 |
| 上升持有 | 更高高点+更高低点 | MA20/MA60向上、回踩缩量 | 持有；仅在健康回踩时加仓 |
| 加速谨慎 | 趋势延续但偏离均线/ATR过大 | 放量急涨、情绪过热 | 持有并移动保护；禁止追高 |
| 高位分歧/派发 | 新高失败或高点降低 | 放量滞涨、顶分型、二卖候选、广度转弱 | 分批止盈/减仓 |
| 不确定 | 周期冲突或关键数据缺失 | 模型互相矛盾 | 等待并列出下一确认条件 |

阶段转换必须有滞回机制，避免一天一变：

- 日线阶段只在完整日K收盘后确认；
- 盘中60分钟/15分钟只改变“预警状态”，不能直接改写日线阶段；
- 连续满足确认条件，或关键结构被一次有效突破/跌破后才迁移阶段；
- 从上升直接跳到下跌必须记录触发的结构破坏，不能只因单根阴线改变；
- 数据冲突时进入 `uncertain`，不做分数平均。

`SymbolMarketPhase` 只由标的自身价格结构、量价和完整K线确定。它与板块阶段、大盘阶段的冲突处理固定为：

1. 标的阶段描述对象事实，板块和大盘不得篡改它；
2. 板块阶段和大盘阶段只能“收紧不放大”账户动作和风险上限；
3. 执行硬阻断（停牌、不可交易、关键数据错乱）优先级最高，其次是大盘风险档、板块阶段，最后才是标的默认动作；
4. `primaryAction` 取所有闸门限制后的最保守结果，不由LLM填写。

### 4.7 相对强弱与市场广度

通用技术分析必须区分“自身上涨”和“相对变强”。新增两个相对独立的证据维度：

1. **相对强弱**：从 `backend/src/modes/factors.ts` 抽取 `rsret/alphaOf`为通用结构化函数，输出 `{rs5, rs20, rs60}`；个股相对所属板块/行业与宽基，ETF在已知可验证跟踪指数时再对比跟踪指数/同类ETF与宽基。
2. **市场广度**：标的计划生成时只读取日频 `board_newhigh_snapshots`，禁止实时遍历全市场板块成分。快照由收盘后统一任务生成；任务未开启、快照过期或无映射时返回缺失。

判断原则：

- 标的上涨且相对强弱、板块/成分股广度同步改善：趋势质量较高；
- 标的上涨但广度下降：ETF可能由少数权重股推动，个股可能只是孤立上涨，均降低加仓等级；
- 标的下跌但相对强弱改善、广度止跌：只进入筑底观察，不直接认定反转；
- 广度数据缺失时必须标注，不能用单一标的K线替代广度证据。

现有广度快照只按板块存储，因此MVP仅支持能稳定映射到板块的个股广度。ETF/指数成分广度需在取得可验证的跟踪指数及成分数据后再启用；不得把基金季报前十大持仓冒充完整指数成分。具体基准代码从标的元数据解析，无映射时只返回宽基对比并显式降级，不在提示词中硬编码。

### 4.8 标的交易质量与事件风险

技术形态成立不等于适合成交。所有标的先检查已有数据可确认的通用交易质量：日均成交额、停牌状态、异常波动和数据完整性。盘口价差与冲击成本在五档数据源稳定性实测通过前属于可选增强，不得作为MVP必达条件。

个股适配层额外检查：

- 涨跌停价格、ST或特殊交易制度；
- 停复牌、除权除息、送转扩股和增减持/解禁等供给事件；
- 业绩预告、财报、重大公告日造成的跳空风险；若未来事件日历不可用，必须显式标注“未覆盖”而非默认无事件；
- 近60日向下跳空分位、个股流动性和单票集中度；
- 所属板块强弱、龙头/跟随关系和相对强弱。

ETF适配层额外检查：

- 实时IOPV与折溢价；
- 日均成交额；盘口价差和冲击成本有稳定五档数据时才计算；
- 基金规模变化；跟踪误差有跟踪指数历史序列后才计算；
- 基金份额拆分、分红等导致的复权/成交量口径变化；
- 跨境ETF的交易日错位、汇率、境外市场休市与隔夜跳空；
- 重要指数调仓、生效日和主要成分股财报/事件日仅在可验证数据源已接入时展示。

这些维度只作为执行闸门和风险提示，不得用基本面或消息面覆盖已经失效的价格结构。

### 4.9 市场判断与账户动作分离

同一张K线，对无仓用户和已持仓用户的动作不同。系统必须同时输出两层结论：

```text
市场判断：标的当前处于什么阶段
账户动作：结合用户是否持有、成本、仓位和可用数量，今天具体怎么做
```

持仓上下文至少包括：

```ts
interface SymbolPositionContext {
  state: 'none' | 'holding';
  quantity: number;
  availableQuantity: number;
  avgCost: number | null;
  currentWeightPct: number;
  unrealizedPnlPct: number | null;
  allowedWeightPct: number | null;
  concentrationWarnings: string[];
}
```

市场阶段不受用户成本影响；账户动作必须考虑成本、已有仓位、总仓上限和恒科/半导体之间的相关敞口。系统禁止给所有用户输出同一句“买入/卖出”。

### 4.10 计划质量与历史校准

“分析更准确”不能只靠增加模型，必须用历史计划结果校准。系统应按计划版本记录：

- 触发率：计划是否在有效期内触发；
- 确认率：盘中预警最终有多少得到收盘确认；
- 假突破率：触发后重新跌回原结构的比例；
- 失效率：触发后命中结构止损或时间止损的比例；
- MFE/MAE：触发后的最大有利/不利波动；
- 最终R倍数：实际或模拟结果相对初始风险的收益；
- 阶段迁移正确性：进入修复/上升后是否继续形成更高高点，进入分歧后是否发生破位；
- 数据降级率：多少计划是在缺数据或未完成K线下生成；
- 计划遵守率：用户是否按触发/止损执行，只做行为复盘，不评价用户。

前端只展示容易理解的历史标签，例如“近20次：有效触发12次、假突破3次、平均+0.6R”，详细统计放入证据抽屉。严禁用少量样本包装成胜率保证。

阶段阈值、量价阈值和ATR参数必须版本化。调整参数后，旧计划继续绑定旧算法版本，避免历史回看口径漂移。能够严格定义的条件直接使用扩展后的 `PlaybookRule` 在历史bar上验证；主观波浪计数不纳入胜率统计。

### 4.11 候选价位与候选条件目录

候选目录是 R1 架构的阻塞级前置能力，必须在Phase 1由后端确定性生成，不能等到Phase 3再由Agent工具临时拼装。

#### 4.11.1 原始候选来源

| 来源 | 原始数量 | MVP入选约束 |
|---|---:|---|
| 确认摆动高/低点 | 取最近若干 | 最近且已确认，保留最近2个高点和2个低点 |
| 候选中枢上/下沿 | 每中枢2个 | 只保留当前有效且距现价最近的1个中枢 |
| 前高/前低与区间边界 | 多个 | 只保留当前结构直接相关的最近边界 |
| MA5/10/20/60/120/250 | 最多6个 | 只保留数据充足、在当前周期有效且与现价距离合理的最外3个 |
| 经典枢轴 PP/R1-R3/S1-S3 | 最多7个 | 只取现价上下最近各1个；PP只在位于当前价格区间时保留 |
| 斐波那契回撤/扩展 | 最多7个 | 回撤最外2个、顺势扩展最外1个，且必须与当前主导波段方向一致 |
| 资产适配器价位 | 不定 | 仅允许可验证的涨跌停价、IOPV偏离闸门等执行位，不与技术支撑/压力混为一类 |

#### 4.11.2 价位聚类、评分与上限

先聚类后排序，禁止把相近的MA、斐波那契与摆动点当成三个独立价位。

```text
clusterTolerance = max(2 × tickSize, 0.15 × ATR, currentPrice × 0.20%)
```

同一容差内的价位合并为一个价格区，保留全部 `sourceEvidenceIds`。聚类和排序参数必须记入 `candidateModelVersion`。

默认评分为：

```text
score = 0.30 × structureImportance
      + 0.25 × historicalTouchScore
      + 0.20 × distanceScore
      + 0.15 × confluenceScore
      + 0.10 × recencyScore
```

- `historicalTouchScore`：近120根内K线高/低/收盘进入聚类容差的触碰次数，连续相邻K线只记1次；
- `distanceScore`：使用距现价的ATR倍距离归一，超出计划期限可触达范围的价位降分；
- `confluenceScore`：同一区域获得两种及以上独立来源时提高，但不重复计算相同摆动事实；
- 确认的当前结构失效位和最近摆动高/低点是保底候选，不因总分略低而被删除。

数量硬上限：

- `next_session`：最外12个价位区，现价上下原则上各不超过6个；
- `swing`：最外16个价位区，现价上下原则上各不超过8个；
- 同一价位可有多个 `compatibleRoles`，但在目录中只占1条。

#### 4.11.3 候选条件展开规则

条件不做“价位 × 全部operator × 全部周期”笛卡尔积。只按价位的语义角色展开白名单：

| 价位角色 | 允许的MVP条件 |
|---|---|
| 压力/前高 | 收盘有效站上、盘中上穿预警 |
| 支撑/前低/中枢下沿 | 收盘保持上方、盘中下穿风险 |
| 入场/加仓候选 | 上穿预警 + 收盘确认，不自动展开反向operator |
| 失效/止损候选 | 下穿预警 + 收盘失效，不自动展开买入operator |
| 目标位 | 触及或收盘站上，不展开入场operator |

非价格条件按目的限量：量价确认最外4个，结构确认/失效最外4个，时间/有效期最外2个，基准/折溢价/流动性/事件闸门合计最外4个。总条件上限：`next_session=24`、`swing=32`。

每个候选包含 `candidateId`、`contextId`、`candidateModelVersion`、所属周期、语义角色、人类可读说明和源证据ID。`save_symbol_trade_plan` 只接受同一 `contextId` 且未过期的候选ID，禁止跨快照混用。

## 五、标的交易计划数据模型

不要直接扩充 `daily_plans` 来承载跨日逻辑。新增“标的交易计划”，今日计划只引用其当前版本快照。

建议在 `shared/src/index.ts` 增加：

```ts
export type SymbolPlanHorizon = 'next_session' | 'swing';
export type SymbolPlanAction = 'wait' | 'probe' | 'add' | 'hold' | 'reduce' | 'exit';
export type SymbolPlanStatus =
  | 'draft'
  | 'active'
  | 'triggered'
  | 'invalid'
  | 'completed'
  | 'expired'
  | 'superseded';

export type TradeLevelRole =
  | 'support'
  | 'resistance'
  | 'entry_trigger'
  | 'add_trigger'
  | 'invalidation'
  | 'stop'
  | 'target';

export interface TradeLevel {
  id: string;
  role: TradeLevelRole;
  timeframe: KlinePeriod;
  price?: number;
  zoneLow?: number;
  zoneHigh?: number;
  label: string;
  rationale: string;
  evidenceIds: string[];
}

export interface CandidateLevel extends TradeLevel {
  candidateId: string;
  contextId: string;
  candidateModelVersion: string;
  score: number;
  compatibleRoles: TradeLevelRole[];
  sourceKinds: string[];
}

/** 计划条件直接包装并扩展现有 PlaybookRule，不再发明第二套 kind/operator DSL */
export interface PlanCondition {
  id: string;
  rule: PlaybookRule;
  timeframe: KlinePeriod;
  description: string;
  required: boolean;
  evidenceIds: string[];
}

export interface CandidateCondition extends PlanCondition {
  candidateId: string;
  contextId: string;
  candidateModelVersion: string;
  evaluationScope: 'backtest_and_live' | 'live_only';
}

export interface TradeScenario {
  id: string;
  rank: 'primary' | 'alternative' | 'risk';
  name: string;
  conditions: PlanCondition[];
  action: SymbolPlanAction;
  invalidConditions: PlanCondition[];
  targetLevelIds: string[];
}

/** LLM唯一允许提交的缩小输入：只选后端已给出的候选ID */
export interface SymbolTradePlanProposal {
  contextId: string;
  candidateModelVersion: string;
  summary: string;
  changes: string[];
  levelSelections: Array<{
    candidateLevelId: string;
    role: TradeLevelRole;
    label?: string;
  }>;
  scenarioSelections: Array<{
    rank: 'primary' | 'alternative' | 'risk';
    name: string;
    conditionCandidateIds: string[];
    invalidConditionCandidateIds: string[];
    targetCandidateLevelIds: string[];
  }>;
}

export interface SymbolTradePlan {
  id: string;
  version: number;
  code: string;
  name: string;
  assetType: 'etf' | 'stock' | 'index';
  horizon: SymbolPlanHorizon;
  status: SymbolPlanStatus;
  asOf: string;
  validFrom: string;
  expiresAt: string | null;
  dataStatus: 'complete' | 'provisional' | 'degraded';
  /** 后端从证据直接派生；LLM不得提交 */
  marketPhase: SymbolMarketPhase;
  trendState: TrendState;
  chanSetup: ChanSetup;
  /** 标的本身的客观动作，不含用户账户状态 */
  marketAction: SymbolPlanAction;
  /** 结合持仓、风险预算后的用户主动作 */
  primaryAction: SymbolPlanAction;
  summary: string;
  /** 相比上一版本为什么变化；无上一版本时为空数组 */
  changes: string[];
  levels: TradeLevel[];
  scenarios: TradeScenario[];
  positionContext: SymbolPositionContext | null;
  risk: {
    structuralStop: number | null;
    volatilityStop: number | null;
    executionStop: number | null;
    atrPct: number | null;
    maxAccountRiskPct: number;
    suggestedPositionPct: number | null;
    timeStopBars: number | null;
    gapRiskNote: string | null;
  };
  exitPlan: {
    firstTakeProfitLevelId: string | null;
    secondTakeProfitLevelId: string | null;
    trailingRule: string | null;
    reduceFractions: number[];
    profitProtectionRule: string | null;
  };
  execution: {
    triggerMode: 'intraday_alert' | 'close_confirmed';
    chaseGuardAtr: number | null;
    maxPremiumPct: number | null;
    maxSpreadPct: number | null;
    nextReviewAt: string;
  };
  /** 个股可同时关联板块与宽基，ETF可同时关联跟踪指数、同类ETF与宽基 */
  benchmarks: Array<{
    code: string;
    name: string;
    role: 'underlying_index' | 'sector' | 'peer' | 'broad_market' | 'relative_strength';
  }>;
  assetSpecificRisks: string[];
  evidenceSnapshot: unknown;
  sessionId: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

责任边界必须按“谁计算，谁填写”执行：

| 生成方 | 字段 |
|---|---|
| 后端确定性证据/状态机 | `marketPhase`、`trendState`、`chanSetup`、`marketAction`、`dataStatus` |
| 后端风险与账户服务 | `risk`、`positionContext`、`execution`、`primaryAction`、`exitPlan` |
| 后端候选目录编译 | `levels`、`scenarios[].conditions`、`scenarios[].invalidConditions`、`scenarios[].action` |
| LLM | `summary`、`changes`、候选价位ID及候选条件ID的组合与用户可读名称 |

`PlaybookRule` 扩展必须遵守向后兼容：

1. 现有 `PlaybookRuleGroup { mode, rules: PlaybookRule[] }` 的JSON形状和语义保持不变，已落库 `spec` 无需迁移即可继续读取和回测；
2. MVP不把 `rules` 直接改成递归节点。计划的复合语义优先通过“单场景必选条件=AND、多场景=OR”表达；确需递归时新增带版本的上层表达式，不改旧结构；
3. 新增叶子规则类型必须声明 `evaluationScope: 'backtest_and_live' | 'live_only'`；成交额比、收盘位置等可逐bar计算的规则可进回测，引用当前证据快照ID的结构位、实时折溢价、事件闸门首期标为 `live_only`；
4. `assertRunnableSpec` 递归校验所有规则，发现 `live_only` 或未注册规则时明确报出规则ID/类型，延续“不可执行就报错，不静默近似”的现有纪律；
5. 为每种规则建立统一注册项，至少包含 `collectDependencies`、`evaluateBar`、可选 `evaluateTick`和 `evaluationScope`。`buildSeries` 不再依赖容易漏改的分散 `collectMaKeys/needs` 分支；
6. 自检必须遍历 `PlaybookRule['kind']` 注册表，新kind漏掉依赖收集或求值器时直接失败，不允许静默返回 `null/false`。

历史bar与实时行情必须复用同一规则语义，但不强制使用同一性能路径；样本不足继续按现有纪律返回 `null/false`，不用近似值补齐。

置信度建议显示为“证据完整度 + 高/中/低”，不要让LLM直接给看似精确的73%、81%路径概率。若需要兼容现有 `DailyPlanItem.confidence`，由代码根据数据完整性、必选条件满足数量映射，不由LLM自由打分。

## 六、数据库与版本策略

新增两张主表：

### `symbol_trade_plans`

保存计划主记录与版本：

- `id`、`code`、`name`、`asset_type`；
- `version`、`horizon`、`status`；
- `as_of`、`valid_from`、`expires_at`；
- `data_status`、`summary`；
- `market_phase`、`trend_state`、`chan_setup`、`market_action`、`primary_action`；
- `changes`、`levels`、`scenarios`、`position_context` JSON；
- `risk`、`exit_plan`、`execution`、`benchmarks`、`asset_specific_risks`、`evidence_snapshot` JSON；
- `evidence_version`、`phase_model_version`，用于历史口径追溯；
- `session_id`、`run_id`、`created_at`、`updated_at`。

索引：

- `(code, horizon, status, updated_at)`；
- `(code, version)` 唯一；
- `run_id` 普通索引。

### `symbol_trade_plan_events`

记录生命周期事件：

- `created`；
- `activated`；
- `condition_hit`；
- `triggered`；
- `invalidated`；
- `expired`；
- `reviewed`；
- `superseded`。

每次重新生成都新增版本，旧版本改为 `superseded`，不能覆盖删除。这样才能复盘Agent判断质量。

### 扩展 `symbol_marks`

新增可空字段，兼容现有数据：

- `semantic_key`：如 `plan.support.primary`，替代按label覆盖；
- `timeframe`：标注所属周期；
- `role`：support/resistance/entry/stop/target/structure；
- `plan_id`、`plan_version`；
- `status`：active/invalid/historical；
- `invalidated_at`。

当前 `add_kline_mark` 的“同名删除再新增”只适合手工标注。计划标注必须按 `planId + version + semanticKey` 幂等同步，不能删除历史版本。

数据库迁移必须沿用 `backend/src/db/migrate.ts` 的幂等方式，并保证老库升级、空库初始化都能成功。

## 七、Agent工具与原子化写入

保留现有三个标注工具作为低层能力，新增以下工具：

### 工具可发现性约束

现有Agent采用渐进式工具披露，新工具默认不一定对模型可见。因此：

- 每个新工具的 `description` 必须包含“标的技术计划、K线阶段、触发失效、计划复核”等可检索关键词；
- 为 `search_tools` 的描述/引导补充计划工具入口；
- 在 `TOOL_GROUP`中新增“标的计划”分组，不得默认落入“其他”；
- Phase 0增加“从非核心工具集通过 `search_tools` 找到并调用”的失败检查。

### `get_symbol_technical_context`

输入：

```ts
{ code, name?, secid?, assetType?, horizon, benchmarkCodes? }
```

输出：

- `contextId`、`candidateModelVersion`、候选价位/条件的数量摘要；
- 多周期K线元信息；
- 道氏结构与摆动点；
- 量价读数；
- MA20/MA60/MACD/ATR；
- 分型、简化笔、候选中枢；
- 标的统一阶段和阶段迁移证据；
- 相对强弱、市场广度与资产适配后的交易质量；
- 大盘阶段、板块阶段与事件风险；
- 用户当前持仓、允许仓位和相关性/集中度警告；
- 当前支撑/压力的极简摘要，不携带完整候选目录；
- 活跃计划与现有标注；
- 数据缺失和时效警告。

该工具不返回原始K线数组。每个周期只返回一行状态读数；摆动点、分型、笔和候选中枢只返回 `id + 时间 + 价格/区间 + 确认状态`。常态目标不超过3000字符，硬上限6000字符，确保低于现有 `preview()` 8000字符静默截断线。输出必须带 `omittedCounts` 和 `warnings`，不得依赖头尾截断。

### `list_symbol_plan_candidates`

候选目录不塞进 `get_symbol_technical_context`，而是按当次证据快照独立读取。

入参：

```ts
{
  contextId: string;
  catalog: 'levels' | 'conditions';
  horizon: SymbolPlanHorizon;
  focusRoles?: TradeLevelRole[];
  cursor?: string;
}
```

返回：

```ts
{
  contextId: string;
  candidateModelVersion: string;
  catalogHash: string;
  candidates: CandidateLevel[] | CandidateCondition[];
  omittedCounts: Record<string, number>;
  nextCursor: string | null;
  warnings: string[];
}
```

- `levels` 和 `conditions` 分开调用，每次常态目标不超过4000字符、硬上限6000字符；
- 服务先按4.11的确定性排序和总量上限裁剪，再做分页；不允许随机截断；
- 发生裁剪时必须按来源/角色写入 `omittedCounts`，并保留结构失效位等保底候选；
- `contextId` 过期、`catalogHash` 不一致或候选模型版本变化时，禁止继续使用旧候选，要求重新生成上下文。

### `save_symbol_trade_plan`

输入 `SymbolTradePlanProposal`，不接收完整 `SymbolTradePlan`。后端负责：

1. 校验候选价位ID和候选条件ID属于当次证据快照；
2. 将选择编译为真实价位、`PlaybookRule`条件和确定性动作；
3. 从证据直接填充阶段、趋势、结构候选、数据状态和市场动作；
4. 计算风险收益、止盈止损、执行闸门与仓位上限；
5. 结合真实持仓和“只收紧不放大”路由生成 `primaryAction`；
6. 校验每个动作的触发、失效、有效期与至少一种防守方式；
7. 在一个事务内保存新计划版本、将旧计划置为 `superseded`、同步K线标注并写入计划事件。

首次校验失败时，工具返回结构化错误列表（字段、错误码、可用候选ID）供LLM重试一次。重试仍失败时，允许由后端落一份 `status='draft'` 的观察计划：只保留后端确定性字段、数据警告和安全摘要，不包含未通过校验的价位、情景或标注。任何情况下都不得留下半套计划与辅助线。

### `get_active_symbol_trade_plan`

读取当前标的两个周期的有效计划，供下一轮Agent复核，不重复从零分析。

### `evaluate_symbol_trade_plan`

由确定性代码对最新行情逐条计算条件状态，Agent只负责解释结果。返回：

- 哪些条件未满足；
- 哪些条件刚触发；
- 是否形成确认；
- 是否失效或过期；
- 是否需要生成新版本。

### `review_symbol_trade_plan`

收盘后写入计划兑现情况和错误归因，不直接修改历史证据。

## 八、Agent提示词协议

标的专属会话不应只提示“有点位就画线”，而应固定成以下流程：

1. 先调用 `search_tools` 检索“标的技术计划/K线阶段/触发失效”并加载计划工具，再调用 `get_symbol_technical_context`；
2. 使用返回的 `contextId` 分别调用 `list_symbol_plan_candidates(catalog='levels')` 和 `list_symbol_plan_candidates(catalog='conditions')`，获取确定性候选目录；
3. 判断数据是否完整，缺数据时明确降级；
4. 道氏只负责方向；
5. 量价只负责参与度和确认；
6. 缠论只负责结构候选和级别；
7. 缠论候选不得单独触发买卖，必须与量价确认同时成立；波浪首期只允许作为文字辅助语言；
8. 不得把同一组高低点当成多个独立证据累计置信度；
9. 每个动作必须包含触发、失效、目标和时间条件；
10. 没有确认信号时输出 `wait`，禁止为了“给结论”强行给买点；
11. 必须明确“当前阶段”与“相比上一版本发生了什么变化”；
12. 必须先给市场判断，再结合真实持仓给账户动作；
13. 止盈不能只有固定目标价，至少包含分批退出或移动保护规则；
14. 只从同一 `contextId/candidateModelVersion` 下的候选价位ID和条件ID中选择，不填写阶段、风险、仓位、价格数字或主动作；
15. 最后调用 `save_symbol_trade_plan`，不要逐条调用 `add_kline_mark` 拼装计划。

输出给用户的固定顺序：

```text
当前状态
→ 当前阶段及变化原因
→ 结合持仓后的唯一主动作
→ 触发条件
→ 防守条件
→ 后续主路径/备选路径/风险路径
→ 止盈、止损、仓位与有效期
→ 数据时点与缺失项
```

## 九、通用核心、资产适配与实例

### 9.1 通用技术分析核心

个股和ETF共用同一套核心计算与状态机：

- 相同的多周期K线、复权和完整K线口径；
- 相同的道氏高低点结构；
- 相同的量价、MA、MACD、ATR、分型、笔和候选中枢算法；
- 相同的阶段状态、触发/确认/失效/过期语义；
- 相同的结构止损、时间止损、分批止盈和R倍数评价；
- 相同的计划版本、辅助线和复盘协议。

技术模型不得根据资产类型改变定义。例如“低点抬高”在个股和ETF上必须是同一个算法；资产适配只能改变数据过滤、执行闸门、风险预算和参考基准。

建议定义统一适配接口：

```ts
interface SymbolAnalysisAdapter {
  assetType: 'stock' | 'etf' | 'index';
  resolveBenchmarks(input: SymbolIdentity): Promise<EvidenceResult<SymbolBenchmark[]>>;
  loadAssetMetadata(input: SymbolIdentity): Promise<EvidenceResult<AssetMetadata>>;
  loadBreadthEvidence(input: SymbolIdentity): Promise<EvidenceResult<BreadthEvidence | null>>;
  loadExecutionQuality(input: SymbolIdentity): Promise<EvidenceResult<ExecutionQuality>>;
  loadEventRisks(input: SymbolIdentity): Promise<EvidenceResult<AssetEventRisk[]>>;
  getRiskCaps(regime: MarketRegimePhase): RiskBudgetTier;
  validateExecutable(plan: SymbolTradePlanDraft): ExecutionGuardResult;
}
```

```ts
interface EvidenceResult<T> {
  status: 'available' | 'degraded' | 'missing';
  value: T | null;
  asOf: string | null;
  warnings: string[];
}
```

`dataStatus='complete'` 表示核心价格/结构证据完整，不代表所有增强数据都已接入。可选证据缺失必须进入 `warnings` 和能力覆盖展示，但不自动把核心完整的计划改成不可用。

目录建议：

```text
backend/src/symbolPlans/adapters/base.ts
backend/src/symbolPlans/adapters/stock.ts
backend/src/symbolPlans/adapters/etf.ts
backend/src/symbolPlans/adapters/index.ts
```

`technicalEvidence.ts` 和 `structure.ts` 不得出现“如果是ETF就换一种高低点算法”之类的分支；差异全部通过适配器输入证据和执行约束。

### 9.2 个股适配层

个股计划在通用核心外增加：

- 板块相对强弱：个股相对所属行业/概念、板块龙头和宽基是否走强；
- 板块广度：只读收盘后日频快照，个股上涨是否得到板块多数成分股支持；
- 流动性与筹码：MVP使用成交额、换手率、筹码密集区和近期套牢区；盘口价差在五档数据实测后再启用；
- 个股跳空：使用近60日向下跳空分位作为仓位缓冲；
- 涨跌停与T+1：触发后是否可成交、当日买入是否可卖、跌停时止损可能无法执行；
- 公司行动：前复权、除权除息、送转扩股前后量价不可直接比较；
- 事件日：已有解禁、增减持数据直接复用；业绩预告/财报预约/重大公告在无可验证未来日历时显式缺失；
- 集中度：个股单票上限应低于ETF，复用 `RiskBudgetTier.singleMaxStockPct`。

消息、财务和筹码只作为风险/质量维度，不改变技术结构事实。重大事件前可以降低仓位或暂停新开仓，但不能因为消息利好而把已经破位的走势重新判成上涨。

### 9.3 ETF适配层

ETF计划在通用核心外增加：

- 已能确定跟踪指数时，计算跟踪指数、同类ETF和宽基的相对强弱；否则降级为同类ETF/宽基；
- 成分股广度、头部权重集中度和指数调仓统一列为增强项，不使用季报前十大持仓替代；
- MVP直接复用IOPV、折溢价、基金规模和场内成交额；跟踪误差等数据源补齐后启用；
- 份额拆分/折算事件只有可验证台账时才作硬闸门，否则依赖复权异常告警；
- 跨境ETF的汇率、境外休市、A股/境外交易时间错位；
- ETF单票仓位上限复用 `RiskBudgetTier.singleMaxEtfPct`，但同主题ETF仍应合并计算板块敞口。

### 9.4 恒科ETF实例

恒生科技指数点位只能作为参考指数条件，不能直接成为A股ETF的下单价。

计划必须同时保存：

- `tradeSymbol`：实际交易的A股恒科ETF代码；
- `benchmarks`：恒生科技指数代码/名称，并可补充同类ETF和宽基；
- ETF自身买入、止损、目标价格；
- 指数支撑、压力和突破条件；
- 折溢价/IOPV；
- 港股是否开市、A股与港股节假日错位；
- 汇率警告；跟踪误差数据缺失时显示“未覆盖”。

正确表达示例：

```text
指数条件：恒生科技指数突破并站稳候选压力区
ETF触发：对应恒科ETF突破自身前高，折溢价不超过设定阈值
```

禁止表达：

```text
恒生科技指数突破4920，所以在A股ETF价格4920买入
```

### 9.5 半导体设备ETF 159516实例

行业ETF波动大，应默认采用：

- 日线道氏方向优先；
- 成交额MA20作为量能主参照；
- 一买只允许小仓试错；
- 二买/突破回踩是主要计划；
- ATR较高时自动降低建议仓位；
- 下跌趋势未结束时，即使RSI偏低或LLM文字上认为接近调整末端，也只能输出观察。

仓位计算统一由代码完成：

```text
建议仓位上限 = 单笔允许账户风险 / 入场价到结构止损价的跌幅
```

默认单笔账户风险建议为0.5%，允许用户在设置中调整，但不能由Agent临时提高。

### 9.6 通用分层止损体系

系统不能只给一个“跌到某价卖出”。至少区分四类止损：

| 类型 | 用途 | 规则 |
|---|---|---|
| 结构止损 | 证明交易逻辑错误 | 一买低点、二买L1、中枢下沿、突破平台等被有效破坏 |
| 波动止损 | 避免止损过近 | 结构位外增加ATR缓冲，由代码计算，不由LLM随意放宽 |
| 时间止损 | 价格不跌但逻辑迟迟不兑现 | N个完整交易日未形成预期高点/趋势，减仓或退出 |
| 市场/板块止损 | 标的未破位但系统风险显著上升 | 大盘进入退潮、主线宽度崩塌或相关指数关键结构失效 |

最终用于仓位计算的 `executionStop` 应结合结构位、ATR、跳空和费用缓冲，复用现有 `computeSizing` 口径。止损只能朝减少风险方向移动，不能在价格下跌后继续下移以维持原判断。

个股与ETF使用相同公式，但参数不同：个股计入更高的跳空、跌停无法成交和单票集中度风险；ETF计入折溢价和主题集中度风险，跟踪误差在数据源可用后再计入。具体参数来自资产元数据和风险预算档，不由Agent自行猜测。

止损触发口径必须明确：

- 波段计划默认以完整日K收盘确认；
- 极端放量长阴、跳空或流动性恶化可以使用紧急盘中风控；
- 盘中刺破后收回与收盘有效跌破必须区分；
- 用户已有超配仓位时，即使结构尚未失效，也可以先降至风险预算上限。

### 9.7 通用分批止盈与利润保护

止盈不能只使用“涨到目标价全部卖出”。计划至少提供：

1. 第一压力/第一风险收益目标：部分兑现；
2. 第二目标区：继续部分兑现；
3. 剩余仓位：使用最近一个更高低点、MA20或ATR跟踪保护；
4. 高位放量滞涨、广度转弱或二卖候选：主动减仓；
5. 突破后迅速跌回原区间：按假突破处理，不等待固定止盈价。

默认分批比例可以配置，例如 `1/3 + 1/3 + 趋势仓`，但系统应优先根据资产类型、仓位大小、第一压力距离和风险收益比生成，不应对所有标的硬套同一比例。

计划同时显示：

- 当前浮盈对应多少 `R`；
- 到第一目标的潜在收益/到止损的潜在损失；
- 风险收益比不足时，即使方向看多也输出等待；
- 获利后保护线是否已抬高到成本或最近结构低点。

### 9.8 通用次日开盘与成交执行

次日计划必须覆盖开盘偏离，避免触发价正确但执行错误：

- 高开直接越过买入触发线：若偏离超过设定ATR阈值，不追，等待15分钟结构或回踩；
- 低开接近止损：先判断是否结构性跳空，不把“价格更便宜”当成加仓理由；
- 触发突破但成交额/收盘位置未确认：只记为 `intraday_alert`；
- 波段买点原则上在收盘确认后才升级为 `triggered`；
- 折溢价或买卖价差超过闸门：市场条件满足但执行条件不满足，继续等待；
- 个股处于涨跌停、停牌、重大未决事件或盘口流动性不足：即使技术条件满足也只记录信号，不伪报可成交；
- 触发后没有合理风险收益比：取消交易，不为完成计划而下单。

## 十、前端交互设计

### 10.1 K线弹窗布局

保留现有左图右栏结构。右侧由单一对话栏升级为两个页签：

- `交易计划`：默认页签；
- `Agent`：保留现有长期对话。

不要增加“新手/专业”双模式。交易计划先展示最重要的动作与防守，专业证据按区块逐层展开。

建议新增：

```text
frontend/src/components/SymbolTradePlanPanel.vue
frontend/src/components/SymbolPlanScenarioCard.vue
frontend/src/components/SymbolPlanEvidenceDrawer.vue
frontend/src/components/KlineLayerControl.vue
```

### 10.2 首屏计划卡

首屏只展示：

- 数据截至时间；
- **当前阶段**：下跌防守/筑底观察/右侧修复/上升持有/加速谨慎/高位分歧/不确定；
- **一句话结论**：当前为什么处于该阶段；
- **相比上一版本**：只展示导致计划变化的1～3条新证据；
- **唯一主动作**：结合用户持仓后的等待/试错/加仓/持有/减仓/退出；
- **三条关键线**：触发线、结构失效线、第一目标线；
- 建议仓位上限；
- 计划有效期；
- `生成计划`、`收盘复核`、`更新计划`按钮。

首屏固定使用一条行动句式：

```text
当前处于【阶段】；你现在应【主动作】；只有【触发条件】才改变动作；跌破【失效条件】进入防守。
```

禁止首屏同时出现“可以买、也可等待、谨慎持有”等互相冲突的建议。若证据冲突，唯一动作就是等待，并明确下一确认条件。

详细区折叠展示：

- 量价证据；
- 道氏高低点结构；
- 缠论分型/笔/候选中枢；
- 条件主路径/转强路径/风险路径；
- 风险收益比；
- 历史版本和复盘。

### 10.3 用户心智负担约束

- 默认只展示一个阶段、一个主动作、三条关键线；
- 道氏、量价和缠论候选证据放在“为什么”抽屉中，不在首屏分别给结论；
- 支撑和压力优先显示为区间，只有触发/失效才显示精确线；
- 使用“观察/预警/确认/失效”四级证据语言，避免把候选写成确定信号；
- 每次更新只突出“发生了什么变化”，不要求用户重读整份报告；
- 无仓和持仓文案分开，市场判断一致但账户动作不同；
- 不显示LLM伪精确胜率；展示数据完整度、证据冲突和历史兑现记录；
- 用户可以展开专业证据，但不设置新手/专业两套产品模式。

### 10.4 K线图层

增加图层开关：

- 当前计划；
- 支撑/压力；
- 结构分型与趋势线；
- 中枢候选；
- 历史失效计划。

默认只打开“当前计划”和“支撑/压力”，避免图上信息过载。

标注渲染规则：

- `price_line` 可按配置跨周期展示；
- `point/range/trend_line` 默认只在所属周期展示；
- 当前计划实线，历史计划虚线或低透明度；
- 失效线不删除，标为灰色并在历史图层中查看；
- 点击辅助线显示来源模型、证据、计划版本、失效条件。

### 10.5 快捷问题

调整 `SymbolChatPanel.vue` 快捷问题：

- “生成下一交易日计划，并同步到K线”；
- “生成未来1～4周波段计划”；
- “复核当前计划哪些条件已触发或失效”；
- “仅更新量价与关键位置，不改原计划”。

### 10.6 决策变化与复盘卡

每个新版本显示与旧版本的差异：

- 阶段是否变化；
- 哪个关键高低点被确认或破坏；
- 量价由支持转为冲突还是相反；
- 止损是否上移；
- 建议仓位为何变化；
- 上一计划是正确等待、有效触发、假突破还是止损失效。

用户不需要判断Agent“这次为什么和上次说法不同”，系统必须主动给出变化证据。

## 十一、计划生命周期

### 下一交易日计划

- 收盘后生成，`validFrom` 为下一交易日；
- 默认在下一交易日收盘后过期；
- 盘中可以触发或失效，但不能静默改价；
- 若行情数据仍是盘中未完成状态，计划标记 `provisional`；
- 收盘后必须做一次复核，形成下一版本依据。

### 1～4周波段计划

- 以日线和60分钟结构为主；
- 只有结构发生变化、触发、失效或用户主动刷新时才生成新版本；
- 计划至少包含结构止损和时间止损；
- 允许跨日持续处于 `active`，但每个交易日更新条件状态。

### 状态转换

```text
draft → active → triggered → completed
                 └────────→ invalid
active → expired
active/triggered → superseded（新版本替代）
```

状态转换由代码条件驱动，Agent只能解释或发起新版本，不能无证据直接把计划改成“已确认”。

### 计划结果归因

计划收盘或过期后，系统必须区分结果原因：

- `correct_wait`：没有可靠触发，等待正确；
- `valid_trigger`：触发并按预期运行；
- `false_breakout`：触发后快速回到原区间；
- `structure_invalidated`：结构判断被明确破坏；
- `time_expired`：未破位但长期不兑现；
- `execution_blocked`：折溢价、价差、跳空等导致未执行；
- `data_degraded`：关键数据缺失，不能评价模型；
- `user_override`：用户主动改变执行，仅记录不混入模型准确率。

准确率统计只评价计划条件，不把“用户是否成交”和“模型判断是否有效”混成一个指标。

## 十二、与现有今日计划的连接

`symbol_trade_plans` 是单标的持续逻辑，`daily_plans` 是账户级当日作战安排，两者职责不同。

后续在 `DailyPlanItem` 增加可空字段：

```ts
symbolPlanId?: string | null;
symbolPlanVersion?: number | null;
```

今日计划生成时：

1. 读取持仓、自选个股与ETF的有效标的计划；
2. 把其中下一交易日条件作为候选；
3. 再根据当日大盘择时档位降级或保留；
4. 保存引用的计划版本，不复制为另一套互相漂移的逻辑；
5. 当日计划结束后，把实际结果写回标的计划复盘事件。

不要让标的详情页重新实现一套账户总仓位逻辑。标的计划只计算单标的风险上限，账户总仓位、相关性和集中度继续由今日计划/持仓纪律负责。

## 十三、API规划

新增路由模块 `backend/src/symbolPlans/index.ts`：

```text
GET  /api/symbol-plans/active?code=&horizon=
GET  /api/symbol-plans/history?code=&limit=
GET  /api/symbol-plans/:id
POST /api/symbol-plans/generate
POST /api/symbol-plans/:id/evaluate
POST /api/symbol-plans/:id/review
POST /api/symbol-plans/:id/expire
```

其中 `generate` 走统一 Agent gateway，并返回 `runId`；前端沿用现有流式运行/轮询能力展示进度。不要在HTTP请求里无限等待完整Agent运行。

`frontend/src/api.ts` 增加 `symbolPlans` 命名空间，不要把接口散落到根级方法。

## 十四、分阶段实施计划

### Phase 0：先建立失败检查和契约

新增最小自检脚本：

```text
backend/src/scripts/symbolTechnicalEvidence.selfcheck.ts
backend/src/scripts/symbolTradePlan.selfcheck.ts
backend/src/scripts/symbolPlanMarks.selfcheck.ts
```

先证明以下场景当前失败：

- 更低高点/更低低点能被识别为下降趋势；
- 低点抬高但未突破前高只能判为转折观察；
- 成交额中位数计算排除当日；
- 未完成日K不能使用完整日成交额结论；
- 二买候选必须满足 `L2 > L1`；
- 新计划生成不会删除旧版本标注；
- 保存计划失败时不会留下半套辅助线；
- LLM传入伪造价格或不存在的候选ID时被拒绝，且不能修改后端阶段/仓位/主动作；
- 同一份固定K线fixture连续生成两次候选目录，除 `createdAt` 等非语义时间字段外必须完全一致，`catalogHash` 相同，且价位/条件数量不超过4.11的分类与总量上限；
- 现有旧版 `PlaybookSpec` JSON可原样读取并完成回测；含 `live_only` 或未注册规则的spec被 `assertRunnableSpec` 明确拒绝，不得静默判false；
- 计划工具在非核心工具集中能被 `search_tools` 检索并调用；
- `get_symbol_technical_context` 常态不超过3000字符、硬上限6000字符且不包含原始K线数组；`list_symbol_plan_candidates` 的 `levels/conditions` 每次返回分别断言常态不超过4000字符、硬上限6000字符，截断数量必须进入 `omittedCounts`；
- 实测东财15m/60m可回溯深度、五档稳定性、ETF跟踪指数/成分映射和个股未来事件日历，产出“可用/降级/不可用”能力矩阵，不在未实测前写入MVP门禁。

### Phase 1：确定性证据层

以 `market/levels.ts`、`market/indicators.ts`、`modes/factors.ts`、`positions/riskBudget.ts` 为基础，实现多周期并发聚合、成交额比/收盘位置、道氏摆动点与状态机、分型/简化笔/候选中枢、真正滞回的标的阶段、结构化RS以及日频广度快照读取。指标部分保留 `getStockIndicators(code, signal?)` 旧签名和60根日线默认输出，另增 `getIndicatorsMulti` 等可配入口供计划模块使用。

本阶段同时实现4.11的确定性候选目录生成器：候选价位覆盖枢轴、斐波那契、MA、确认摆动点、候选中枢上下沿和前高前低；按版本化容差将近邻价位聚类合并；以距现价ATR倍距离、历史触碰次数、结构重要性、多源共振和时效性排序；执行每来源上限、`next_session=12`、`swing=16`的价位总上限；只按价位角色展开白名单operator，条件总上限分别为24和32。先不接LLM，提供内部函数和只读调试API。

完成标准：给定固定K线fixture，技术证据与候选目录完全可复现，两次生成的 `catalogHash`、候选ID、排序和展开条件一致；价位与条件不超分类/总量上限，且每项可追溯到具体K线和源证据。

### Phase 2：计划存储与生命周期

扩展 `PlaybookRule`及其求值器，再实现共享DTO、候选价位/条件目录、数据库表、repo/service、版本管理、事件记录、结构化校验和原子事务。计划在历史bar和实时行情上共用同一条件语义。

完成标准：可以手工提交一份结构化计划，生成新版本，并使用历史bar或手工注入的行情快照驱动状态机完成触发、失效、过期与历史回看；本阶段不接交易时段实时轮询。

### Phase 3：Agent生成与画线同步

实现 `get_symbol_technical_context`、`list_symbol_plan_candidates`、`save_symbol_trade_plan` 等新Agent工具、工具检索描述/`TOOL_GROUP`、缩小版 `SymbolTradePlanProposal`、结构化重试错误和 `markSync`。LLM只选择同一 `contextId/candidateModelVersion` 下的候选ID并写摘要，完整计划由后端编译并在事务中同步辅助线。

完成标准：Agent不能篡改确定性字段；首次校验失败可结构化重试，二次失败只生成无线位的 `draft`；同一版本重复保存不产生重复线；新版本不删除历史线。

### Phase 4：K线弹窗计划界面

实现阶段卡、唯一主动作、三条关键线、场景卡、止盈止损卡、版本变化、证据抽屉、图层控制、历史版本和生成/复核动作。保留现有Agent对话和手工标注能力。

完成标准：用户不打开Agent对话也能看懂“现在做什么、什么条件触发、哪里证明判断错了”。

### Phase 5：盘中评估与盘后滚动

扩展 `backend/src/watch/rules.ts` 的 `evalPlanSignals`，使其读取 `symbol_trade_plans` 的已编译条件，并复用现有个股盯盘的迟滞门、分级冷却、限流、WS/通知和死信重投。统一复用 `etfwatch` 的 `primed/seenBar` 思路，但不新建第三套轮询和推送通道。

实时求值必须分频：

- 纯价格条件（上穿/下穿、止损/止盈触及）可每个quote tick做O(1)比较，不调 `buildSeries`；
- 15m/60m/日线量价、均线、MACD和结构条件只在新的完整bar收出时求值一次；
- bar级去重键固定为 `code + period + barTime + planVersion`，引擎重启首轮只预热已收bar的键，不回放旧触发；
- 指标序列缓存键为 `code + period + adjusted + lastBarTime + evidenceVersion`，同一新bar只构建/增量更新一次，多个活跃计划复用同一序列；
- 换日、复权版本改变、数据回补或缓存超过容量/TTL时失效；计划版本变化只失效求值结果，不重建未变的底层指标序列；
- 禁止在现有默认10秒轮询的每个tick中为每个活跃计划重新拉K线或调用 `buildSeries`。

首期只更新状态，不自动修改价格或生成新计划。

完成标准：触发、失效、过期均由确定性条件产生事件，并能在K线和计划卡同步展示；同一未收bar内的非价格条件不重复求值，性能计数器能证明 `buildSeries` 调用次数与新bar数量而非quote tick数量同阶。

### Phase 6：接入今日计划

让账户级今日计划引用有效标的计划版本，加入持仓集中度和恒科/半导体相关性约束。

完成标准：同一标的在详情页与今日计划中的触发价、失效条件不存在两套互相冲突的数据。

### Phase 7：规则验证与回测（后续）

因计划条件已直接复用/扩展 `PlaybookRule`，本阶段不再做DSL映射，而是使用同一规则快照进行历史验证与计划校准。缠论只验证可严格定义的候选子规则；波浪不在MVP回测范围。

## 十五、预计涉及文件

### 修改

```text
shared/src/index.ts
backend/src/db/schema.ts
backend/src/db/migrate.ts
backend/src/agent/tools.ts
backend/src/agent/loop.ts                   # 仅若需暴露超时/输出诊断，不优先放宽全局限制
backend/src/market/indicators.ts            # 保留旧签名/默认输出，新增可配多周期入口
backend/src/modes/factors.ts                # 抽取通用RS函数
backend/src/playbook/rules.ts               # 扩展统一条件DSL与实时求值
backend/src/watch/rules.ts                  # 复用evalPlanSignals
backend/src/server.ts
backend/src/plan/service.ts                 # Phase 6
backend/src/plan/repo.ts                    # Phase 6
backend/src/positions/riskBudget.ts         # 优先复用，确需扩展个股/ETF资产适配参数时才修改
frontend/src/api.ts
frontend/src/components/KlineDialog.vue
frontend/src/components/SymbolChatPanel.vue
frontend/src/views/PlanView.vue             # Phase 6
```

### 新增

```text
backend/src/symbolPlans/index.ts
backend/src/symbolPlans/repo.ts
backend/src/symbolPlans/service.ts
backend/src/symbolPlans/technicalEvidence.ts
backend/src/symbolPlans/structure.ts
backend/src/symbolPlans/volumePrice.ts
backend/src/symbolPlans/candidateCatalog.ts
backend/src/symbolPlans/markSync.ts
backend/src/symbolPlans/prompt.ts
backend/src/symbolPlans/adapters/base.ts
backend/src/symbolPlans/adapters/stock.ts
backend/src/symbolPlans/adapters/etf.ts
backend/src/symbolPlans/adapters/index.ts
backend/src/scripts/symbolTechnicalEvidence.selfcheck.ts
backend/src/scripts/symbolTradePlan.selfcheck.ts
backend/src/scripts/symbolPlanMarks.selfcheck.ts
frontend/src/components/SymbolTradePlanPanel.vue
frontend/src/components/SymbolPlanScenarioCard.vue
frontend/src/components/SymbolPlanEvidenceDrawer.vue
frontend/src/components/KlineLayerControl.vue
```

实际实施前再次用 CodeGraph 检查调用关系。当前工作区包含大量未提交修改，Cursor不得执行reset、checkout覆盖或把现有K线/Agent能力按旧版本重写。

## 十六、核心验收用例

### 用例A：159516仍处下降趋势

给定日线更低高点、更低低点，且当日放量长阴收近最低：

- 道氏输出 `downtrend`；
- 量价输出风险确认；
- 缠论不得强行输出已确认一买；
- LLM可在摘要中说明“下跌速度减弱”，但不得用波浪计数改写后端的 `wait`；
- K线只画观察支撑、压力和失效线，不画已确认买点；
- ATR过高时建议仓位自动下降。

### 用例B：159516形成二买候选

给定 `L1 → H1 → L2` 且 `L2 > L1`，回踩缩量，随后突破小级别高点：

- 状态从 `active/wait` 转为 `triggered/probe`；
- 入场线引用突破点；
- 失效线引用L1或实际结构低点；
- 仓位由风险预算计算；
- 后续突破H1后才升级为更强趋势确认。

### 用例C：恒科指数突破但A股ETF高溢价

- 指数条件可以显示已满足；
- ETF自身触发条件和溢价条件未满足时不得给 `probe/add`；
- 图上指数点位与ETF价格必须分属不同坐标语义；
- 用户看到的最终动作应为等待溢价回落或ETF自身确认。

### 用例D：计划失效

- 触及结构失效条件后状态变为 `invalid`；
- 当前计划图层中的线变灰或隐藏；
- 历史版本仍可查看；
- Agent下一轮先解释失效原因，再创建新版本，不能悄悄移动止损线。

### 用例E：数据不完整

- 任一关键周期K线缺失时 `dataStatus=degraded`；
- 无法校正ETF拆分成交量时，只使用成交额并提示；
- 盘中未完成日K不产生“全天缩量/放量确认”；
- 数据不足时允许生成观察计划，但禁止生成确认买点。

### 用例F：相同走势、不同账户状态

给定同一个股或ETF处于右侧修复阶段：

- 无仓用户输出等待触发后试错；
- 轻仓用户输出持有或触发后加仓；
- 已超风险预算用户即使看多也输出减至允许仓位；
- 三者的市场阶段和结构价位保持一致，只有账户动作不同。

### 用例G：高开越过买点

- 次日高开直接超过买入触发线且偏离过大时，不自动标记可买；
- 状态先进入盘中预警；
- 只有回踩承接或收盘确认、折溢价和价差合格后才触发；
- 若风险收益比因高开恶化，计划保持等待或过期。

### 用例H：上涨但广度恶化

- ETF价格创新高、少数权重股上涨，但成分股MA20以上比例下降；
- 道氏仍可保持上涨，统一阶段不得直接升级为更强进攻；
- 账户动作应为持有并收紧保护，禁止因为“多个模型看多”继续追涨；
- 页面明确显示“价格强、广度弱”的证据冲突。

### 用例I：分批止盈与保护线上移

- 达到第一目标后记录部分兑现事件；
- 剩余仓位保护线只能上移，不能下调；
- 出现二卖候选或放量滞涨时触发减仓；
- 历史版本保留原始目标、实际执行和最终R倍数。

### 用例J：个股技术形态成立但事件/交易制度受限

给定某个股形成放量突破和二买确认，但次日处于重大财报窗口、已高开超过追涨阈值或接近涨停：

- 通用技术核心仍记录结构确认，不篡改趋势阶段；
- 个股执行适配层可以把账户动作降为等待；
- 页面明确区分“技术信号成立”和“当前不可合理执行”；
- 计划写明事件日、跳空、涨跌停/T+1和流动性风险；
- 事件结束后必须重新评估，不能沿用过期触发价。

### 用例K：个股上涨但板块退潮

- 个股自身仍为更高高点/更高低点，但所属板块相对强弱和广度连续恶化；
- 市场阶段可暂时保持上升，账户动作降为持有并收紧保护；
- 不允许把板块退潮直接伪装成个股已经破位；
- 若随后个股跌破更高低点，则进入高位分歧或下跌防守并记录完整因果链。

### 用例L：LLM提交伪造或冲突字段

- LLM提交不存在的候选价位ID、自由价格或与后端阶段冲突的主动作；
- 后端第一次返回结构化错误及允许的候选ID；
- 重试成功时只保存经后端编译的计划；
- 重试仍失败时只落无价位/无标注的 `draft`；
- 数据库与K线图不得出现半套状态。

### 用例M：可选数据源缺失

- ETF无跟踪指数成分、跟踪误差或折算事件台账时，核心价格结构仍可生成；
- 个股无未来财报日历或五档价差时，页面显示“未覆盖”而不是“无风险”；
- `dataStatus/warnings` 记录降级，但不因增强数据不存在而导致全部失败；
- 核心K线、复权或结构证据缺失时，才降级为仅观察 `draft`。

## 十七、完成定义

### 17.1 MVP必达（可验收）

- 结构化计划、图上辅助线、Agent文字三者来自同一计划版本；
- 所有价位可追溯到确定性数据或明确计算公式；
- 所有动作都有触发、失效和有效期；
- 首屏始终只有一个当前阶段和一个结合账户的主动作；
- 市场判断与用户成本/持仓动作严格分层；
- 同一价格证据不会被道氏和缠论候选重复计权；缠论候选不能单独导出买卖；
- LLM只提交摘要与候选ID组合，阶段、风险、仓位、主动作和真实价位由后端填充；
- 候选目录对同一fixture完全可复现，符合来源/总量上限和operator白名单，且 `contextId/candidateModelVersion/catalogHash` 能防止跨快照混用；
- 条件直接复用/扩展 `PlaybookRule`，历史与实时求值不存在两套语义；
- 旧版 `PlaybookSpec` 可原样读取回测，`live_only`/未注册规则会被 `assertRunnableSpec` 明确拒绝；
- 相对强弱作为独立证据；个股广度只读日频快照；ETF补充已有的折溢价/IOPV，个股补充已有的交易制度、解禁/增减持和筹码风险；
- 个股与ETF共用同一技术定义，只通过资产适配层处理板块基准、交易制度、事件和风险参数；
- 恒科指数与A股恒科ETF价格坐标严格分离；
- 止损覆盖结构、波动、时间和市场/板块四层，止盈支持分批与移动保护；
- 计划更新能解释相对上一版本的变化原因；
- 历史计划不可被新版本覆盖；
- 计划保存和标注同步具有事务一致性；
- 条件监控复用现有 `watch` 迟滞/冷却/推送链，不新建第三套轮询系统；
- tick级只求值纯价格条件，技术条件按新完整bar求值并复用序列缓存，不在10秒轮询中重复构建 `buildSeries`；
- 新Agent工具可通过 `search_tools` 发现，技术上下文与候选目录分别符合独立字符预算，不会被8000字符预览逻辑静默截断；
- 数据缺失、行情未完成、复权异常都有显式降级；
- 不会自动触发真实或模拟交易；
- 新增自检通过；
- `pnpm typecheck` 通过；
- `pnpm --filter ./frontend build` 通过；
- 在一个普通A股个股、159516和一个实际恒科ETF代码上完成手工端到端验收。

### 17.2 增强项（数据源就绪后验收）

- ETF跟踪指数代码、完整成分及权重、成分广度和头部集中度；
- ETF跟踪误差、指数调仓生效日和份额拆分/折算事件台账；
- 个股/ETF稳定五档价差与冲击成本；
- 个股财报预约日、业绩预告日和重大事件日历；
- 上述任一增强项未完成时，MVP可正常宣告完成，但页面和 `warnings` 必须明确显示未覆盖范围。

## 十八、Cursor执行顺序

建议Cursor严格按以下顺序实施，每一阶段完成后再继续：

1. 阅读本计划并用CodeGraph核对当前实现；
2. 建立三组失败自检，不先改生产代码；
3. 实现确定性证据层；
4. 实现DTO、数据库迁移和版本仓储；
5. 实现结构化Agent工具与事务化标注同步；
6. 实现K线弹窗计划UI和图层控制；
7. 实现条件评估、失效与收盘复核；
8. 最后接入账户级今日计划；
9. 跑自检、类型检查、前端构建，并完成个股、境内行业ETF、跨境ETF三类端到端验证；
10. 汇报实际改动、已验证能力、仍降级的模型和未解决风险。

首个可用版本应优先做准“证据—计划—辅助线—失效”的闭环，不要一开始追求完整自动波浪计数或所有缠论流派。计划是否可靠，首先取决于数据时点、结构失效和复盘能力，而不是模型数量。
