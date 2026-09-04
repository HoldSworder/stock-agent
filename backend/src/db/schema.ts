import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/sqlite-core';

/** 通用 kv 设置表，运行时覆盖 .env 默认值 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 定时 / 可执行任务 */
export const scheduledTasks = sqliteTable('scheduled_tasks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  cronExpr: text('cron_expr'),
  tz: text('tz').notNull().default('Asia/Shanghai'),
  prompt: text('prompt').notNull(),
  /** ModelConfig JSON */
  modelConfig: text('model_config').notNull().default('{}'),
  /** NotifyChannel[] JSON */
  notifyChannels: text('notify_channels').notNull().default('["webui"]'),
  timeoutSec: integer('timeout_sec').notNull().default(600),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** 绑定的战法 id（可空，仅战法模拟任务有值，agent 买卖落该战法账户） */
  strategyId: text('strategy_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 运行记录 */
export const taskRuns = sqliteTable(
  'task_runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id'),
    taskName: text('task_name'),
    trigger: text('trigger').notNull(),
    status: text('status').notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    inputPrompt: text('input_prompt').notNull(),
    outputText: text('output_text'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    error: text('error'),
  },
  (t) => ({
    byTask: index('idx_runs_task').on(t.taskId),
    byStarted: index('idx_runs_started').on(t.startedAt),
  }),
);

/** 运行轨迹（完整消息流，复盘用） */
export const runMessages = sqliteTable(
  'run_messages',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    role: text('role').notNull(),
    content: text('content'),
    toolCalls: text('tool_calls'),
    toolName: text('tool_name'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byRun: index('idx_msgs_run').on(t.runId),
  }),
);

/** 聊天会话（ref_code 非空表示绑定某标的的长期跟踪会话，由 K 线详情弹窗对话栏 find-or-create） */
export const chatSessions = sqliteTable(
  'chat_sessions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    refCode: text('ref_code'),
    refName: text('ref_name'),
  },
  (t) => ({
    // 一个标的至多一个跟踪会话：唯一约束挡住 find-or-create 的并发建重（SQLite 的 NULL 不参与唯一性，
    // 普通会话可以有任意多条）
    byRefCode: uniqueIndex('idx_chat_sessions_ref_code').on(t.refCode),
  }),
);

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    bySession: index('idx_chatmsg_session').on(t.sessionId),
  }),
);

/**
 * 标的 K 线标注：agent 在标的详情对话中调 add_kline_mark 打点，长期留存供后续跟踪复核。
 * points 存 JSON 数组 `[{ time?, price? }]`：point 一个点，range/trend_line 两个点，
 * price_line 一个点是水平线、两个点是价格带（下沿 + 上沿）。
 * 计划标注按 (plan_id, plan_version, semantic_key) 幂等同步，历史版本不删，只置 historical。
 */
export const symbolMarks = sqliteTable(
  'symbol_marks',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    /** price_line | point | range | trend_line */
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    note: text('note'),
    points: text('points').notNull(),
    color: text('color'),
    sessionId: text('session_id'),
    runId: text('run_id'),
    createdAt: text('created_at').notNull(),
    /** 语义键（如 plan.support.primary），计划标注据此幂等同步，替代按 label 覆盖 */
    semanticKey: text('semantic_key'),
    /** 标注所属周期，用于各周期图上的严格过滤 */
    timeframe: text('timeframe'),
    /** support/resistance/entry/stop/target/structure */
    role: text('role'),
    planId: text('plan_id'),
    planVersion: integer('plan_version'),
    /** active | invalid | historical；失效线不删除，转 historical 供历史图层查看 */
    status: text('status'),
    invalidatedAt: text('invalidated_at'),
  },
  (t) => ({
    byCode: index('idx_symbol_marks_code').on(t.code, t.createdAt),
    byPlan: index('idx_symbol_marks_plan').on(t.planId, t.planVersion),
  }),
);

/**
 * 标的技术交易计划主表。每次重新生成都新增版本，旧版本置 superseded，不覆盖删除，
 * 这样才能复盘 agent 的判断质量。evidence_snapshot 存生成时的证据快照供口径追溯。
 */
export const symbolTradePlans = sqliteTable(
  'symbol_trade_plans',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** stock | etf | index */
    assetType: text('asset_type').notNull(),
    /** 东财 secid（如 1.000300）。指数与个股撞码，缺它求值就会拿另一只标的的 K 线判触及 */
    secid: text('secid'),
    version: integer('version').notNull(),
    /** next_session | swing */
    horizon: text('horizon').notNull(),
    status: text('status').notNull(),
    asOf: text('as_of').notNull(),
    validFrom: text('valid_from').notNull(),
    expiresAt: text('expires_at'),
    /** complete | provisional | degraded */
    dataStatus: text('data_status').notNull(),
    summary: text('summary').notNull(),
    /** 以下五项由后端从证据派生，LLM 不得提交 */
    marketPhase: text('market_phase').notNull(),
    trendState: text('trend_state').notNull(),
    chanSetup: text('chan_setup').notNull(),
    marketAction: text('market_action').notNull(),
    primaryAction: text('primary_action').notNull(),
    /** JSON 列 */
    changes: text('changes').notNull(),
    levels: text('levels').notNull(),
    scenarios: text('scenarios').notNull(),
    positionContext: text('position_context'),
    risk: text('risk').notNull(),
    exitPlan: text('exit_plan').notNull(),
    execution: text('execution').notNull(),
    benchmarks: text('benchmarks').notNull(),
    assetSpecificRisks: text('asset_specific_risks').notNull(),
    evidenceSnapshot: text('evidence_snapshot'),
    /** 口径版本，用于历史回看时不漂移 */
    evidenceVersion: text('evidence_version').notNull(),
    phaseModelVersion: text('phase_model_version').notNull(),
    candidateModelVersion: text('candidate_model_version').notNull(),
    contextId: text('context_id'),
    sessionId: text('session_id'),
    runId: text('run_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byCode: index('idx_symbol_plans_code').on(t.code, t.horizon, t.status, t.updatedAt),
    byCodeVersion: uniqueIndex('idx_symbol_plans_code_version').on(t.code, t.horizon, t.version),
    byRun: index('idx_symbol_plans_run').on(t.runId),
  }),
);

/** 计划生命周期事件：created/activated/condition_hit/triggered/invalidated/expired/reviewed/superseded */
export const symbolTradePlanEvents = sqliteTable(
  'symbol_trade_plan_events',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id').notNull(),
    planVersion: integer('plan_version').notNull(),
    kind: text('kind').notNull(),
    conditionId: text('condition_id'),
    note: text('note').notNull(),
    /**
     * 复盘归因（SymbolPlanOutcome 八枚举之一），仅 kind='reviewed' 时写。
     * 单开一列而不是塞进 note：塞在自由文本里就没法按归因聚合，
     * 而「这些计划到底错在哪一类」正是复盘唯一要回答的问题。
     */
    outcome: text('outcome'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byPlan: index('idx_symbol_plan_events_plan').on(t.planId, t.createdAt),
    byOutcome: index('idx_symbol_plan_events_outcome').on(t.kind, t.outcome),
  }),
);

/**
 * 事件类条件的锁存记录。金叉、上穿这类条件只在发生的那一根为真，
 * 而情景要求全部触发条件同时成立——不锁存的话「周线金叉 + 日线突破」永远凑不齐。
 *
 * 唯一键是 (plan_id, condition_id)：锁存语义是「这份计划的这个条件此生已达成一次」，
 * bar_time 只作记录不进键。进了键就变成每根 bar 各锁一条，锁存也就不成其为锁存。
 * 不随版本号清理：新版本本来就是新 plan_id，天然隔离。
 */
export const symbolPlanConditionLatches = sqliteTable(
  'symbol_plan_condition_latches',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id').notNull(),
    conditionId: text('condition_id').notNull(),
    /** 命中时所在的 bar 时间，仅供复盘 */
    barTime: text('bar_time'),
    latchedAt: text('latched_at').notNull(),
  },
  (t) => ({
    byPlanCond: uniqueIndex('idx_plan_latch_plan_cond').on(t.planId, t.conditionId),
  }),
);

/**
 * 情景概率预测记录（计划 S5）。
 *
 * 模型报的主观概率是个未经校准的数——界面已经这么标注了，但只标注不记录，
 * 它就永远只是个未经校准的数。每份计划的每个情景在这里存一行，到期由收盘任务
 * 自动比对实际走势判定 hit / miss，攒够样本才有可能算出「模型报 70% 时实际兑现多少」。
 *
 * 唯一键 (plan_id, scenario_id)：同一份计划的同一情景只记一次预测。
 * 计划出新版本就是新 plan_id，天然隔离，不必按版本清理。
 * outcome 为 null 表示尚未到期，settled_at 记判定时间。
 */
export const symbolPlanForecasts = sqliteTable(
  'symbol_plan_forecasts',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id').notNull(),
    planVersion: integer('plan_version').notNull(),
    code: text('code').notNull(),
    /** 与计划同源的 secid，结算取 K 线必须用它而不是单凭 code 猜市场 */
    secid: text('secid'),
    scenarioId: text('scenario_id').notNull(),
    scenarioRank: text('scenario_rank').notNull(),
    /** 模型报的主观概率 0~100 */
    probabilityPct: real('probability_pct').notNull(),
    probabilityBasis: text('probability_basis'),
    /** 判定用的目标价与失效价，落库时冻结，事后不受计划改版影响 */
    targetPrice: real('target_price'),
    invalidPrice: real('invalid_price'),
    basePrice: real('base_price').notNull(),
    /** 到期日（含），过了这天无论如何都要判定 */
    dueDate: text('due_date').notNull(),
    /** hit=先到目标价，miss=先破失效价，timeout=到期都没到，unjudgeable=永远判不了（不计入校准分母） */
    outcome: text('outcome'),
    settledAt: text('settled_at'),
    /** 判不了的原因，仅 unjudgeable 时写；留痕以便事后追查而不是静默丢弃 */
    settleNote: text('settle_note'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byPlanScenario: uniqueIndex('idx_plan_forecast_plan_scenario').on(t.planId, t.scenarioId),
    byPending: index('idx_plan_forecast_pending').on(t.outcome, t.dueDate),
  }),
);

/**
 * 技术断言账本：每天把「可证伪的技术判断」冻结落库，到期机械核对。
 *
 * 与 symbol_plan_forecasts 的分工：那张表只管 AI 计划的情景概率，且只在生成计划时才有记录；
 * 这张表管的是每天由确定性算法算出的点位与时间窗（波浪见顶位、斐波 0.618、枢轴、中枢边界、
 * 均线支撑压力），回答的是「哪套工具在这只票上真的有用」。两张表在统计层合并展示。
 *
 * 判定参数（ATR 快照、反应窗口根数、时间容差）必须随记录冻结：日后调参不能改写历史成绩，
 * 否则统计出来的遵循率会随最后一次改参数而整体漂移，失去纵向可比性。
 */
export const symbolAssertions = sqliteTable(
  'symbol_assertions',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    /** 结算取 K 线必须用它，不能单凭 code 猜市场（指数与个股撞码） */
    secid: text('secid'),
    /** 生成日（上海交易日 YYYY-MM-DD） */
    asOf: text('as_of').notNull(),
    /** 断言所属周期，如 day / week */
    period: text('period').notNull(),
    /** level=点位断言 / time=时间断言 */
    kind: text('kind').notNull(),
    /** 依据来源：elliott / fib / pivot / chan / ma / dow —— 统计要按这一维切开 */
    source: text('source').notNull(),
    /** 人话陈述，事后下钻时直接展示，不用再从参数反推 */
    statement: text('statement').notNull(),
    /** 点位断言的价位；区间型用 price~priceHigh */
    price: real('price'),
    priceHigh: real('price_high'),
    /** 时间断言的预测窗口 */
    windowFrom: text('window_from'),
    windowTo: text('window_to'),
    /** 期望价格在触及该位后反向走的方向：up=向上反弹（支撑/见底位），down=向下受阻（压力/见顶位） */
    direction: text('direction'),
    /** 判定参数，落库即冻结 */
    atrSnapshot: real('atr_snapshot'),
    /**
     * 记录当时的收盘价。用来判断某个价位在当时是在现价上方还是下方。
     *
     * 不能靠 direction 反推：道氏来源的方向是按「前高/前低」写死的，与它相对现价的位置无关。
     * 实测 711 条道氏记录里有 115 条（16%）方向与实际位置相反——前高被跌破后仍标着压力，
     * 可它已经在现价下方了。旧记录为空，此时不展示上下分档。
     */
    closeSnapshot: real('close_snapshot'),
    reactionBars: integer('reaction_bars'),
    toleranceBars: integer('tolerance_bars'),
    /** 到期日（含），过了这天仍未触及即判 untouched */
    dueDate: text('due_date').notNull(),
    /** pending=未判 / respected=按判断走了 / violated=没按判断走 / untouched=没碰到（不计分母）/ unjudgeable=永远判不了 */
    outcome: text('outcome'),
    settledAt: text('settled_at'),
    settleNote: text('settle_note'),
    /** 溯源：具体是波浪的哪一档、斐波的哪个比例，便于下钻核对 */
    evidenceRef: text('evidence_ref'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    // 同日同标的同来源同语义只存一条，冻结任务重跑不会灌重
    bySemantic: uniqueIndex('idx_assertion_semantic').on(
      t.code,
      t.asOf,
      t.period,
      t.source,
      t.kind,
      t.evidenceRef,
    ),
    byPending: index('idx_assertion_pending').on(t.outcome, t.dueDate),
    byStats: index('idx_assertion_stats').on(t.source, t.kind, t.outcome),
  }),
);

/**
 * 各套方法的可信度权重历史。
 *
 * 每天算完存一条，既是审计留痕（页面要能回答「今天为什么这么排」），
 * 也是平滑与滞回的输入（要知道昨天是多少）。权重会影响候选价位的呈现顺序，
 * 不留痕就没法在它出错时倒查是哪天、因为什么样本被推歪的。
 */
export const assertionSourceWeights = sqliteTable(
  'assertion_source_weights',
  {
    id: text('id').primaryKey(),
    asOf: text('as_of').notNull(),
    /** 算法协议版本。映射形状/钳位/平滑参数一改就升版，跨版本的权重不可比 */
    protocolVersion: text('protocol_version').notNull(),
    source: text('source').notNull(),
    weight: real('weight').notNull(),
    prevWeight: real('prev_weight'),
    /** 比同距离随机价位强多少（点估计） */
    edge: real('edge'),
    /** 按日期分块 bootstrap 的 95% 下界，权重由它映射而来 */
    edgeLower: real('edge_lower'),
    /** 参与统计的独立日期数 */
    blocks: integer('blocks'),
    samples: integer('samples'),
    /** 人话解释，直接展示 */
    reason: text('reason').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    // 同一天同一协议版本同一来源只留一条，重跑不灌重
    byDay: uniqueIndex('idx_source_weight_day').on(t.asOf, t.protocolVersion, t.source),
  }),
);

/** 自选股镜像 */
export const watchlist = sqliteTable('watchlist', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  tags: text('tags'),
  note: text('note'),
  addedAt: text('added_at').notNull(),
});

/** 驾驶舱关注标的（独立于自选股，无同花顺/爱盯盘同步副作用，仅驾驶舱自维护） */
export const cockpitFocus = sqliteTable('cockpit_focus', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  note: text('note'),
  /** 手动排序位，越小越靠前 */
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

/** ETF 跟踪池（独立于自选股，ETF 模块自管买卖信号源） */
export const etfPool = sqliteTable('etf_pool', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  tags: text('tags'),
  note: text('note'),
  addedAt: text('added_at').notNull(),
});

// ===== 量化研究模式库（codex/cursor 经写 API 登记，WebUI 只读展示 + 关注跟踪）=====

/** 研究标的库（独立于 ETF 关注列表，供量化研究与站内跟踪引擎取用） */
export const researchUniverse = sqliteTable('research_universe', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  tags: text('tags'),
  note: text('note'),
  addedAt: text('added_at').notNull(),
});

/** 策略模式主表：买卖逻辑 / 推荐配置 / 分析 / 关注 / 跟踪方式（system 声明式自跟踪 / external 外部推送） */
export const researchModes = sqliteTable('research_modes', {
  /** slug，如 etf-mainline-profit-runner */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category'),
  tags: text('tags'),
  /** experiment / recommended / baseline / retired */
  status: text('status').notNull().default('experiment'),
  summary: text('summary'),
  /** 买卖逻辑（markdown） */
  buySellMd: text('buy_sell_md'),
  /** 推荐配置串，如 wrot-keep|rs90|noabs|70%/30%|ma60trail12 */
  recommendedConfig: text('recommended_config'),
  /** 相关分析（markdown） */
  analysisMd: text('analysis_md'),
  universeNote: text('universe_note'),
  risksMd: text('risks_md'),
  /** 手动关注（关注后纳入每日跟踪） */
  followed: integer('followed', { mode: 'boolean' }).notNull().default(false),
  /** system：站内声明式自跟踪；external：外部 cron 推送 */
  trackingMode: text('tracking_mode').notNull().default('external'),
  /** 声明式策略规格 JSON（system 模式必填；external 可空） */
  spec: text('spec'),
  /** 来源标记，如 codex / cursor */
  source: text('source'),
  /**
   * 该模式是从多少个参数/规则变体中挑出来的（0 = 未申报）。
   * 多重检验惩罚用：从 30 个变体里挑最好的一个，即便全是噪声，最好那个的曲线也会很漂亮。
   */
  variantCount: integer('variant_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 一个模式的多版本回测结果（推荐版 / 基准版 / 最高收益版等） */
export const researchModeBacktests = sqliteTable(
  'research_mode_backtests',
  {
    id: text('id').primaryKey(),
    modeId: text('mode_id').notNull(),
    /** 配置串 / 版本标签 */
    label: text('label').notNull(),
    /** 区间描述，如 2025-01-02 ~ 2026-06-26 */
    range: text('range'),
    poolSize: integer('pool_size'),
    /** 核心指标 JSON：return/annualized/maxDrawdown/trades/avgPos/maxPos/winRate */
    metrics: text('metrics').notNull().default('{}'),
    /** 成本敏感性 JSON 数组 */
    costSensitivity: text('cost_sensitivity').notNull().default('[]'),
    /** 分段复核 JSON 数组 */
    segments: text('segments').notNull().default('[]'),
    concentrationMd: text('concentration_md'),
    /** 交易记录 markdown（惰性返回，列表不带） */
    tradesMd: text('trades_md'),
    isRecommended: integer('is_recommended', { mode: 'boolean' }).notNull().default(false),
    /**
     * 回测协议号，如 etf-mainline-v3。规则一改就换号，旧协议的结果不再作为当前证据。
     * 没有这个字段时，改完规则的新结果和旧结果会混在同一个版本列表里，看上去像是同一套策略的多次验证。
     */
    protocol: text('protocol').notNull().default(''),
    /**
     * 引擎语义版本（protocol 串的一部分，单列一份便于按版本过滤与回填）。
     * 改造前的历史记录统一回填 v1-legacy：那批结果出自「supertrend 恒不触发 + 零成本回放」的引擎，
     * 与新版收益不可横向比较。
     */
    engineVersion: text('engine_version'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ byMode: index('idx_mode_bt_mode').on(t.modeId) }),
);

/** 关注模式的每日跟踪快照（system 引擎产出或 external 推送），按 (modeId,date) 幂等 */
export const researchModeDaily = sqliteTable(
  'research_mode_daily',
  {
    id: text('id').primaryKey(),
    modeId: text('mode_id').notNull(),
    date: text('date').notNull(),
    /** 当日应持仓 JSON：[{code,name,weight}] */
    holdings: text('holdings').notNull().default('[]'),
    /** 当日买卖信号 JSON */
    signal: text('signal'),
    dayReturn: real('day_return'),
    cumReturn: real('cum_return'),
    drawdown: real('drawdown'),
    /** system / external */
    source: text('source').notNull().default('system'),
    // ===== 引擎协议标记 =====
    // 引擎规则一改（修好一条从未触发的离场、给回放加上成本），同一份 spec 就会跑出不同曲线。
    // 旧行不删不改，靠这几列区分口径，晋级门只取「与最新快照同协议的连续区段」，避免新旧样本混算。
    /** 完整口径串，如 v2-2026.08|themeFirst|univ=db-etf-pool:71440cd7…:53|cost=b25/s25bps */
    protocolVersion: text('protocol_version'),
    /** 引擎语义版本；null / v1-legacy = 加列之前的历史行 */
    engineVersion: text('engine_version'),
    /** db-etf-pool / research-fallback / custom */
    universePolicy: text('universe_policy'),
    /** 排序后实际引擎输入的哈希（含影响主题归类的规范化名称） */
    universeHash: text('universe_hash'),
    poolSize: integer('pool_size'),
    costBuyBps: real('cost_buy_bps'),
    costSellBps: real('cost_sell_bps'),
    /** 与该模式研究基准池是否同源；null = 未知（历史行或 modeId 无研究基准） */
    sameAsResearchPool: integer('same_as_research_pool', { mode: 'boolean' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ byKey: uniqueIndex('idx_mode_daily_key').on(t.modeId, t.date) }),
);

/** 关注模式的信号/持仓变化事件（enter/exit/switch），供时间线与消息提醒 */
export const researchModeEvents = sqliteTable(
  'research_mode_events',
  {
    id: text('id').primaryKey(),
    modeId: text('mode_id').notNull(),
    date: text('date').notNull(),
    /** enter / exit / switch */
    kind: text('kind').notNull(),
    detail: text('detail'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ byMode: index('idx_mode_evt_mode').on(t.modeId) }),
);

// ===== 战法库（手工收录外部收集的战法，纯知识收藏，不参与跟踪/回测）=====

/** 收集的战法条目：来源 / 适用环境 / 选股·买点·卖点·风控 markdown / 标签星级 */
export const playbooks = sqliteTable('playbooks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** 一句话核心 */
  summary: text('summary'),
  /** 类型：打板 / 低吸 / 趋势 / 套利 / 中线… 自由文本 */
  category: text('category'),
  /** 逗号分隔标签 */
  tags: text('tags'),
  /** short / mid / long */
  horizon: text('horizon'),
  /** 适用环境逗号串，对齐大盘阶段口径：主升 / 反弹 / 退潮 / 震荡 */
  marketEnv: text('market_env'),
  /** 出处：书名 / 公众号 / 大V */
  source: text('source'),
  sourceUrl: text('source_url'),
  /** 选股口径（markdown） */
  pickMd: text('pick_md'),
  /** 买点（markdown） */
  buyMd: text('buy_md'),
  /** 卖点（markdown） */
  sellMd: text('sell_md'),
  /** 风控（markdown） */
  riskMd: text('risk_md'),
  /** 个人心得（markdown） */
  notesMd: text('notes_md'),
  /** 0-5 星 */
  rating: integer('rating').notNull().default(0),
  /** collected / testing / adopted / retired */
  status: text('status').notNull().default('collected'),
  /** PlaybookSpec JSON：可执行回测规则，空则只能导入外部回测结果 */
  spec: text('spec'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 战法回测记录：站内引擎跑（source=system）与外部导入（external）共用一张表 */
export const playbookBacktests = sqliteTable(
  'playbook_backtests',
  {
    id: text('id').primaryKey(),
    playbookId: text('playbook_id').notNull(),
    label: text('label').notNull(),
    /** system | external */
    source: text('source').notNull().default('system'),
    range: text('range'),
    poolSize: integer('pool_size'),
    /** PlaybookBacktestMetrics JSON */
    metrics: text('metrics').notNull().default('{}'),
    /** PlaybookTrade[] JSON */
    trades: text('trades').notNull().default('[]'),
    /** PlaybookEquityPoint[] JSON */
    equity: text('equity').notNull().default('[]'),
    /** string[] JSON：口径说明 */
    notes: text('notes').notNull().default('[]'),
    /** PlaybookSpec JSON 快照 */
    spec: text('spec'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ byPlaybook: index('idx_playbook_bt_playbook').on(t.playbookId) }),
);

/** 持仓快照（真实 + 模拟） */
export const positions = sqliteTable(
  'positions',
  {
    id: text('id').primaryKey(),
    /** real | sim */
    account: text('account').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    qty: real('qty'),
    avgCost: real('avg_cost'),
    price: real('price'),
    marketValue: real('market_value'),
    profit: real('profit'),
    snapshotAt: text('snapshot_at').notNull(),
  },
  (t) => ({
    bySnapshot: index('idx_pos_snapshot').on(t.snapshotAt),
  }),
);

/** 战法（策略）—— 独立的本地虚拟纸上交易账户 */
export const strategies = sqliteTable('strategies', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  /** 账户类型：local 本地虚拟盘 / miaoxiang 妙想东财模拟盘镜像 */
  kind: text('kind').notNull().default('local'),
  /** 初始资金 */
  initialCapital: real('initial_capital').notNull(),
  /** 当前可用现金 */
  cash: real('cash').notNull(),
  /** 归档（软删除） */
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  /** 最近同步时间（仅 miaoxiang 镜像账户） */
  syncedAt: text('synced_at'),
  /** 是否启用 Skill 自迭代（复盘可提案调整选股/买入/卖出打法） */
  skillEnabled: integer('skill_enabled', { mode: 'boolean' }).notNull().default(false),
  /** 是否纳入自动模拟白名单（默认 false；仍受全局 simAutoEnabled 总闸约束） */
  autoSimEnabled: integer('auto_sim_enabled', { mode: 'boolean' }).notNull().default(false),
  /** 买入关联的选股链路 id（如 nl；为空表示不关联） */
  screenEngine: text('screen_engine'),
  /** 买入关联的选股预设/策略 id */
  screenStrategyId: text('screen_strategy_id'),
  /** 持有视角：short 短线（默认）/ mid 中线，决定盯盘规则集与卖点档案口径 */
  horizon: text('horizon').notNull().default('short'),
  /** 自动建仓每次取选股 TopN 只数（M4 调仓编排器用） */
  pickTopN: integer('pick_top_n'),
  /** 自动建仓持仓数上限（M4 调仓编排器用） */
  maxPositions: integer('max_positions'),
  /** 自动调仓 cron（为空走模块默认调度） */
  rebalanceCron: text('rebalance_cron'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 战法前向样本：每交易日收盘记录一次权益快照，累积 3-6 个月前向验证轨迹（只读、不交易） */
export const strategySamples = sqliteTable(
  'strategy_samples',
  {
    id: text('id').primaryKey(),
    strategyId: text('strategy_id').notNull(),
    sampleDate: text('sample_date').notNull(),
    totalAsset: real('total_asset').notNull().default(0),
    totalProfitRate: real('total_profit_rate').notNull().default(0),
    positionCount: integer('position_count').notNull().default(0),
    cash: real('cash').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ byKey: uniqueIndex('idx_strategy_samples_key').on(t.strategyId, t.sampleDate) }),
);

/**
 * 战法 Skill（打法）版本链：三维度（选股/买入/卖出）共表、追加式版本化。
 * 每个 (strategyId, dimension) 至多一行 active；pending 为待用户确认的修订提案。
 */
export const strategySkills = sqliteTable(
  'strategy_skills',
  {
    id: text('id').primaryKey(),
    strategyId: text('strategy_id').notNull(),
    /** pick 选股 / buy 买入 / sell 卖出 */
    dimension: text('dimension').notNull(),
    /** 版本号（审批通过时按维度递增分配；pending 时为 0 占位） */
    version: integer('version').notNull().default(0),
    content: text('content').notNull(),
    /** active 生效 / pending 待确认 / archived 历史 / rejected 已驳回 */
    status: text('status').notNull(),
    /** 变更理由（agent 复盘理由或用户备注） */
    reason: text('reason'),
    /** 来源运行 id（agent 提案时记录，手动编辑为空） */
    sourceRunId: text('source_run_id'),
    createdAt: text('created_at').notNull(),
    /** 审批/驳回时间 */
    decidedAt: text('decided_at'),
  },
  (t) => ({
    byStrategyDim: index('idx_skill_strategy_dim').on(t.strategyId, t.dimension),
    byStatus: index('idx_skill_status').on(t.strategyId, t.status),
  }),
);

/** 战法持仓（可卖数由当日买入流水推导 T+1，不另存列） */
export const simPositions = sqliteTable(
  'sim_positions',
  {
    id: text('id').primaryKey(),
    strategyId: text('strategy_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    qty: real('qty').notNull(),
    avgCost: real('avg_cost').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byStrategy: index('idx_simpos_strategy').on(t.strategyId),
  }),
);

/**
 * 战法持仓「持有逻辑」（position 级，如金属钨涨价）。
 * 与 sim_positions 解耦：妙想镜像同步会清空重写 sim_positions，但本表按 (strategyId, code)
 * 独立留存，不被同步清掉；快照按 code 关联回显。
 */
export const simPositionThesis = sqliteTable(
  'sim_position_thesis',
  {
    strategyId: text('strategy_id').notNull(),
    code: text('code').notNull(),
    thesis: text('thesis').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.strategyId, t.code] }),
  }),
);

/**
 * 妙想镜像成交「操作原因」（trade 级）持久化兜底。
 * 妙想同步会删除并重写 source=miaoxiang 成交（reason 丢失），故 mx_trade 时按
 * (strategyId, code, side, tradeDate) 落本表，同步重插成交时回填 reason。
 */
export const simTradeReasons = sqliteTable(
  'sim_trade_reasons',
  {
    strategyId: text('strategy_id').notNull(),
    code: text('code').notNull(),
    side: text('side').notNull(),
    tradeDate: text('trade_date').notNull(),
    reason: text('reason').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.strategyId, t.code, t.side, t.tradeDate] }),
  }),
);

/** 实时盯盘告警（独立模块，自管读写） */
export const watchAlerts = sqliteTable(
  'watch_alerts',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** position | watch | scan */
    source: text('source').notNull(),
    signalType: text('signal_type').notNull(),
    /** low | medium | high */
    severity: text('severity').notNull(),
    detail: text('detail').notNull(),
    runId: text('run_id'),
    adviceText: text('advice_text'),
    verdict: text('verdict'),
    /** 终审是否值得推送 */
    shouldAlert: integer('should_alert', { mode: 'boolean' }).notNull().default(false),
    /** Telegram 是否已投递（死信重试用） */
    delivered: integer('delivered', { mode: 'boolean' }).notNull().default(false),
    /** 触发时现价（结果反思回看基准） */
    triggerPrice: real('trigger_price').notNull().default(0),
    /** 事后应验：hit | miss | flat | null */
    outcome: text('outcome'),
    /** 事后涨跌幅 % */
    outcomePct: real('outcome_pct'),
    /** 研判消耗 token */
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    /** 所属战法（持仓来自战法时有值） */
    strategyId: text('strategy_id'),
    strategyName: text('strategy_name'),
    /** 本地战法自动卖出执行状态：executed | skipped | null */
    execStatus: text('exec_status'),
    /** 自动卖出回执或跳过原因 */
    execNote: text('exec_note'),
    /** 结构化执行指令 JSON（WatchInstruction） */
    instructionJson: text('instruction_json'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byCreated: index('idx_watch_alerts_created').on(t.createdAt),
    byCode: index('idx_watch_alerts_code').on(t.code),
  }),
);

/** ETF 多周期分层盯盘告警（独立于个股盯盘 watch_alerts） */
export const etfWatchSignals = sqliteTable(
  'etf_watch_signals',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** buy_layer | sell_layer | hard_stop */
    signalType: text('signal_type').notNull(),
    /** 1 | 2 | 3 */
    layer: integer('layer').notNull().default(1),
    /** 30m | 60m | day */
    timeframe: text('timeframe').notNull(),
    /** 该层目标仓位 / 撤出比例 % */
    positionPct: real('position_pct').notNull().default(0),
    detail: text('detail').notNull(),
    triggerPrice: real('trigger_price').notNull().default(0),
    dif: real('dif').notNull().default(0),
    dea: real('dea').notNull().default(0),
    /** 0-100 混合置信度（仅买点） */
    confidence: real('confidence'),
    /** 最终裁决：建仓|观察|放弃|撤层|硬止损 */
    verdict: text('verdict'),
    /** agent 一句话研判（仅买点） */
    advice: text('advice'),
    /** 触发周期最新收盘 K 线时间（区分检测时刻 created_at） */
    barTime: text('bar_time'),
    runId: text('run_id'),
    delivered: integer('delivered', { mode: 'boolean' }).notNull().default(false),
    /** 资金/量价确认读数 JSON（EtfConfirm） */
    confirmJson: text('confirm_json'),
    /** 可闭眼照做的执行指令 JSON（EtfExecInstruction） */
    instructionJson: text('instruction_json'),
    /** 触发时趋势阶段 */
    trendStage: text('trend_stage'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byCreated: index('idx_etf_watch_signals_created').on(t.createdAt),
    byCode: index('idx_etf_watch_signals_code').on(t.code),
  }),
);

/** ETF 多周期盯盘逻辑层状态（按引擎自身信号维护「建议持仓层」） */
export const etfWatchState = sqliteTable('etf_watch_state', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  /** 已建层 JSON 数组，如 [1,2] */
  heldLayers: text('held_layers').notNull().default('[]'),
  /** 各层建仓价 JSON，如 {"1":1.23} */
  layerEntryPrice: text('layer_entry_price').notNull().default('{}'),
  /** 各层建仓时间 JSON，如 {"1":"2026-06-23T..."}（持仓起始日/隔日标识用） */
  layerEntryAt: text('layer_entry_at').notNull().default('{}'),
  /** 持有以来最高价 */
  peakPrice: real('peak_price').notNull().default(0),
  /** 趋势阶段（确定性合成，每轮评估刷新） */
  trendStage: text('trend_stage'),
  updatedAt: text('updated_at').notNull(),
});

/** ETF 份额日快照（按日累积，份额无历史接口，趋势从上线起累积） */
export const etfShareDaily = sqliteTable(
  'etf_share_daily',
  {
    code: text('code').notNull(),
    /** 上海交易日 YYYY-MM-DD */
    date: text('date').notNull(),
    /** 最新份额（份） */
    shares: real('shares').notNull().default(0),
    /** 当日收盘价（量价对照） */
    close: real('close').notNull().default(0),
    /** 当日成交量（手） */
    volume: real('volume').notNull().default(0),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.code, t.date] }),
    byCode: index('idx_etf_share_daily_code').on(t.code),
  }),
);

/** LLM 调用记录（统一计量：每一次 chat.completions 请求一行，按用途区分） */
export const llmCalls = sqliteTable(
  'llm_calls',
  {
    id: text('id').primaryKey(),
    /** 用途分类（见 UsagePurpose） */
    purpose: text('purpose').notNull(),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    /** 单次请求耗时 ms */
    latencyMs: integer('latency_ms').notNull().default(0),
    success: integer('success', { mode: 'boolean' }).notNull().default(true),
    error: text('error'),
    /** 关联 agent 运行 id（非 agent 调用为空） */
    runId: text('run_id'),
    /** 任务名（便于明细展示，非 agent 调用为空） */
    taskName: text('task_name'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byCreated: index('idx_llm_calls_created').on(t.createdAt),
    byPurpose: index('idx_llm_calls_purpose').on(t.purpose),
  }),
);

/** 今日计划（一天一行，串联研报/热点/板块/持仓/大盘/外围的中央作战图） */
export const dailyPlans = sqliteTable('daily_plans', {
  id: text('id').primaryKey(),
  /** 计划日 YYYY-MM-DD（Asia/Shanghai），唯一 */
  planDate: text('plan_date').notNull().unique(),
  /** draft 草稿 / active 生效 / closed 已收盘复盘 */
  status: text('status').notNull().default('active'),
  /** 大盘研判 MarketStance JSON（含 timingLevel 择时档位） */
  marketStance: text('market_stance'),
  /** 重点板块 PlanFocusSector[] JSON */
  focusSectors: text('focus_sectors').notNull().default('[]'),
  /** 隔夜外围/政策（文本） */
  externalContext: text('external_context'),
  /** 完整作战图（Markdown，供人阅读与推送） */
  narrative: text('narrative'),
  /** 今日风险清单 string[] JSON（AI 产出） */
  keyRisks: text('key_risks').notNull().default('[]'),
  /** 盘中分时作战指引 IntradayGuide JSON（AI 产出，可空） */
  intradayGuide: text('intraday_guide'),
  /** 生成它的 agent 运行 id */
  runId: text('run_id'),
  /** 盘后复盘总结（收盘复盘回填） */
  reviewSummary: text('review_summary'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 今日计划标的项（结构化触发价，供盘中盯盘程序化对照） */
export const dailyPlanItems = sqliteTable(
  'daily_plan_items',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** 资产类型：stock 个股 / etf 基金（落库时按代码前缀自动判定） */
    assetType: text('asset_type').notNull().default('stock'),
    /** buy 买入 / hold 持有 / reduce 减仓 / sell 卖出 / watch 观察 */
    direction: text('direction').notNull().default('watch'),
    thesis: text('thesis'),
    /** PlanTrigger JSON：买入触发价 */
    buyTrigger: text('buy_trigger'),
    /** PlanTrigger JSON：卖出触发价 */
    sellTrigger: text('sell_trigger'),
    /** PlanTrigger JSON：止损价 */
    stopLoss: text('stop_loss'),
    /** PlanTrigger JSON：止盈价 */
    takeProfit: text('take_profit'),
    /** 建议仓位 */
    positionHint: text('position_hint'),
    /** 右侧确认条件 string[] JSON（突破确认 / 回踩转强等） */
    confirmConditions: text('confirm_conditions').notNull().default('[]'),
    /** 逻辑失效条件 string[] JSON（满足则当天取消/降级） */
    invalidConditions: text('invalid_conditions').notNull().default('[]'),
    /** 来源：research/hotspot/sector/screener/position/watchlist/other（体现串联来源） */
    source: text('source').notNull().default('other'),
    /** 计划 agent 综合置信度 0-100（盘前打分，null=未给） */
    confidence: integer('confidence'),
    priority: integer('priority').notNull().default(0),
    /** pending 待触发 / triggered 已触发 / done 已完成 / invalid 已失效 */
    status: text('status').notNull().default('pending'),
    /** 盘中对照备注 */
    lastNote: text('last_note'),
    /** 多 agent 辩论结论（落库后增强，个股自动跑决策引擎）：持有/减仓/清仓 */
    debateVerdict: text('debate_verdict'),
    /** 辩论置信度（0-100） */
    debateConfidence: integer('debate_confidence'),
    /** 辩论一句话要点（组合经理 thesis） */
    debateNote: text('debate_note'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byPlan: index('idx_plan_items_plan').on(t.planId),
    byCode: index('idx_plan_items_code').on(t.code),
  }),
);

/** 今日计划事件（审计与闭环：触发命中 / 备注 / 复盘 / 重新生成） */
export const dailyPlanEvents = sqliteTable(
  'daily_plan_events',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id').notNull(),
    itemId: text('item_id'),
    ts: text('ts').notNull(),
    /** trigger_hit / note / review / regenerated / created */
    kind: text('kind').notNull(),
    /** 事件载荷 JSON */
    payload: text('payload'),
    runId: text('run_id'),
  },
  (t) => ({
    byPlan: index('idx_plan_events_plan').on(t.planId),
  }),
);

/**
 * 消息催化结构化记录（情报研判落库 → 今日计划读取）：按题材去重，
 * 追踪「首次出现 / 重复次数 / 是否已发酵 / 已兑现涨幅」，供选股识别「起爆前·未发酵」催化。
 */
export const newsCatalysts = sqliteTable(
  'news_catalysts',
  {
    id: text('id').primaryKey(),
    /** 题材/板块名（去重键，唯一） */
    theme: text('theme').notNull(),
    /** 催化类型：政策/订单/事件/业绩/资金等 */
    catalystType: text('catalyst_type'),
    /** 受益方向描述 */
    direction: text('direction'),
    /** 相关标的 string[] JSON（代码或名称） */
    codes: text('codes').notNull().default('[]'),
    /** 预计兑现/发酵时间窗描述 */
    catalystWindow: text('catalyst_window'),
    /** 首次出现日 YYYY-MM-DD（Asia/Shanghai） */
    firstSeenDate: text('first_seen_date').notNull(),
    /** 最近出现日 YYYY-MM-DD */
    lastSeenDate: text('last_seen_date').notNull(),
    /** 累计出现次数（重复上报递增） */
    seenCount: integer('seen_count').notNull().default(1),
    /** 是否已发酵/高位（true=追高风险；false=起爆前未发酵） */
    fermented: integer('fermented', { mode: 'boolean' }).notNull().default(false),
    /** 已兑现涨幅 %（agent 估算，供发酵程度判断） */
    realizedPct: real('realized_pct'),
    /** 备注/催化要点 */
    note: text('note'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byTheme: uniqueIndex('idx_news_catalysts_theme').on(t.theme),
    bySeen: index('idx_news_catalysts_last_seen').on(t.lastSeenDate),
  }),
);

/** 热点 AI 研判历史（每次生成一行，按需与定时共用） */
export const trendSummaries = sqliteTable(
  'trend_summaries',
  {
    id: text('id').primaryKey(),
    /** daily 当日 / weekly 近一周 */
    reportType: text('report_type').notNull(),
    /** Markdown 研判正文 */
    content: text('content').notNull(),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byCreated: index('idx_trend_summaries_created').on(t.createdAt),
  }),
);

/**
 * 公共 AI 分析历史（通用弹窗各 kind 共表）：每次成功的流式分析落一行。
 * 按 (kind, refKey) 划分历史作用域：refKey 为空表示该 kind 的全局历史（如真实持仓），
 * 非空表示按目标的历史（如自选单股研判按股票代码）。
 */
export const aiAnalyses = sqliteTable(
  'ai_analyses',
  {
    id: text('id').primaryKey(),
    /** 分析类型（如 real-positions） */
    kind: text('kind').notNull(),
    /** 历史作用域键（如股票代码），全局类为 null */
    refKey: text('ref_key'),
    /** 展示标题（取自 kind 的 taskName） */
    title: text('title'),
    /** 关联 agent 运行 id */
    runId: text('run_id'),
    /** 分析最终正文（Markdown） */
    content: text('content').notNull(),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byKindRef: index('idx_ai_analyses_kind_ref').on(t.kind, t.refKey, t.createdAt),
  }),
);

/**
 * 决策交易记忆（反思闭环）：每次决策写一条 pending（含入场价快照），
 * 反思定时任务到期后回填个股/CSI300 收益、Alpha、定性与教训（status=reviewed）。
 * 后续同标的决策据此注入历史教训，形成学习闭环。
 */
export const decisionMemory = sqliteTable(
  'decision_memory',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** 决策日 YYYY-MM-DD（Asia/Shanghai） */
    decisionDate: text('decision_date').notNull(),
    action: text('action').notNull(),
    confidence: integer('confidence').notNull().default(0),
    /** 决策时入场价快照 */
    entryPrice: real('entry_price'),
    targetPrice: real('target_price'),
    stopLoss: real('stop_loss'),
    positionPct: real('position_pct'),
    thesis: text('thesis'),
    /** pending 待复盘 / reviewed 已复盘 */
    status: text('status').notNull().default('pending'),
    reviewedAt: text('reviewed_at'),
    reviewPrice: real('review_price'),
    stockReturn: real('stock_return'),
    csi300Return: real('csi300_return'),
    alpha: real('alpha'),
    verdict: text('verdict'),
    lesson: text('lesson'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byCode: index('idx_decision_memory_code').on(t.code, t.createdAt),
    byStatus: index('idx_decision_memory_status').on(t.status, t.decisionDate),
  }),
);

/** 选股运行（一次三层漏斗的元信息；候选明细见 screen_picks） */
export const screenRuns = sqliteTable(
  'screen_runs',
  {
    id: text('id').primaryKey(),
    /** 产出该次运行的选股链路（默认多因子） */
    engine: text('engine').notNull().default('multifactor'),
    strategyId: text('strategy_id').notNull(),
    strategyName: text('strategy_name').notNull(),
    trigger: text('trigger').notNull(),
    /** 全市场快照只数（L0） */
    marketCount: integer('market_count').notNull().default(0),
    /** 硬筛后候选数（L1） */
    filteredCount: integer('filtered_count').notNull().default(0),
    /** 最终输出 TopN 数 */
    topN: integer('top_n').notNull().default(0),
    /** 题材上下文（透传 LLM） */
    context: text('context'),
    /** LLM 全局大盘观 */
    marketView: text('market_view'),
    /** LLM 选股总体逻辑 */
    selectionLogic: text('selection_logic'),
    /** LLM 组合风险提示 */
    portfolioRisk: text('portfolio_risk'),
    /** 关联运行 id（计量） */
    runId: text('run_id'),
    /** 持有视角：short 短线（默认）/ mid 中线下钻 */
    horizon: text('horizon').notNull().default('short'),
    /** 下钻 universe 来源说明（全市场为空） */
    universeNote: text('universe_note'),
    /** 漏斗诊断 JSON（ScreenFunnelDiagnostics）：被硬筛刷掉的那部分留痕，只读研究统计 */
    diagnostics: text('diagnostics'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byCreated: index('idx_screen_runs_created').on(t.createdAt),
  }),
);

/** 选股候选明细（一次运行多行；含因子分、LLM thesis 与 T+N 复盘回填） */
export const screenPicks = sqliteTable(
  'screen_picks',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    rank: integer('rank').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** 选股快照价（T+N 复盘基准） */
    price: real('price').notNull(),
    pct: real('pct').notNull(),
    industry: text('industry'),
    /** 确定性多因子总分 0-100 */
    screenScore: real('screen_score').notNull(),
    /** ScreenFactorScore[] JSON */
    factors: text('factors').notNull().default('[]'),
    /** LLM 选股逻辑 */
    thesis: text('thesis'),
    /** 风险标签 string[] JSON */
    riskTags: text('risk_tags').notNull().default('[]'),
    /** LLM 信心分 0-100 */
    confidence: integer('confidence'),
    /** 跟踪要点 string[] JSON */
    watchItems: text('watch_items').notNull().default('[]'),
    /** 失效条件 string[] JSON */
    invalidators: text('invalidators').notNull().default('[]'),
    /** T+N 复盘：最新价 */
    evalPrice: real('eval_price'),
    evalAt: text('eval_at'),
    /** 区间收益率 % */
    evalReturn: real('eval_return'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byRun: index('idx_screen_picks_run').on(t.runId),
  }),
);

/** 战法成交流水 */
export const simTrades = sqliteTable(
  'sim_trades',
  {
    id: text('id').primaryKey(),
    strategyId: text('strategy_id').notNull(),
    /** 关联的 agent 运行 id（手动下单为空） */
    runId: text('run_id'),
    /** 外部成交单号（妙想 order id，本地下单为空） */
    extId: text('ext_id'),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** buy | sell */
    side: text('side').notNull(),
    qty: real('qty').notNull(),
    price: real('price').notNull(),
    /** 成交金额 = qty * price */
    amount: real('amount').notNull(),
    /** 卖出已实现盈亏（买入为 null） */
    realizedProfit: real('realized_profit'),
    reason: text('reason'),
    /** cron | manual | agent */
    source: text('source').notNull(),
    /** 成交日 YYYY-MM-DD（Asia/Shanghai，用于 T+1 判定） */
    tradeDate: text('trade_date').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byStrategy: index('idx_simtrade_strategy').on(t.strategyId),
    byStrategyDate: index('idx_simtrade_strategy_date').on(t.strategyId, t.tradeDate),
  }),
);

/**
 * 全局安全控制（单行，id 固定 'global'）：交易/模拟动作的总闸。
 * kill switch 一票否决所有交易；自动模拟默认关闭，须显式开启 agent/cron 才能落单。
 */
export const safetyControls = sqliteTable('safety_controls', {
  id: text('id').primaryKey(),
  /** 总急停：开启后拒绝一切交易/模拟动作（含手动） */
  killSwitch: integer('kill_switch', { mode: 'boolean' }).notNull().default(false),
  killReason: text('kill_reason'),
  /** 自动本地模拟交易开关（cron/agent/watch 触发的 sim_trade），默认关闭 */
  autoLocalSimEnabled: integer('auto_local_sim_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  /** 自动外部模拟交易开关（cron/agent 触发的 mx_trade 妙想模拟盘），默认关闭 */
  autoExternalSimEnabled: integer('auto_external_sim_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  /** 是否允许手动强制成交（跳过交易日/时段校验），默认允许 */
  allowManualForceTrade: integer('allow_manual_force_trade', { mode: 'boolean' })
    .notNull()
    .default(true),
  updatedAt: text('updated_at').notNull(),
});

/** 作业互斥锁（防止同 key 任务被中央/模块/手动多入口并发重复执行） */
export const jobLocks = sqliteTable('job_locks', {
  lockKey: text('lock_key').primaryKey(),
  owner: text('owner').notNull(),
  /** 过期时间（ISO），到期视为可抢占，避免死锁 */
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
});

/**
 * 真实持仓「逐票纪律覆盖」：账户级默认纪律见 settings(position_discipline_config)，
 * 此表仅存被用户单独定制的标的（留空字段回退账户默认）。account 当前固定 'real'。
 */
export const positionDiscipline = sqliteTable(
  'position_discipline',
  {
    account: text('account').notNull().default('real'),
    code: text('code').notNull(),
    name: text('name'),
    /** 成本止损线（%，正数，如 8=跌破成本 8% 止损）；null 用账户默认 */
    stopLossPct: real('stop_loss_pct'),
    /** 止盈线（%）；null 用账户默认 */
    takeProfitPct: real('take_profit_pct'),
    /** 最长持有交易日；null 用账户默认（账户默认也可 null=不限） */
    maxHoldDays: integer('max_hold_days'),
    /** 单票最大仓位占比（%）；null 用账户默认 */
    singleMaxWeightPct: real('single_max_weight_pct'),
    note: text('note'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.account, t.code] }) }),
);

/**
 * 结构化市场主线（themes 模块）：把复盘计划 focusSectors / 热点雷达 / 研报里的板块判断
 * 按主线名归并沉淀，多源叠加强度，供计划、决策、中线雷达统一复用。theme 唯一。
 */
export const marketThemes = sqliteTable(
  'market_themes',
  {
    id: text('id').primaryKey(),
    /** 主线名（归并键，唯一） */
    theme: text('theme').notNull().unique(),
    /** 关联东财板块代码（可空） */
    boardCode: text('board_code'),
    /** 强度 0-100 */
    strength: real('strength').notNull().default(0),
    /** active / fading / archived */
    status: text('status').notNull().default('active'),
    /** 生命周期阶段（启动/加速/分歧/退潮/未知，复盘验证回流写入） */
    phase: text('phase').notNull().default('未知'),
    /** 来源集合 JSON（ThemeSource[]） */
    sources: text('sources').notNull().default('[]'),
    /** 证据要点 JSON（ThemeEvidence[]） */
    evidence: text('evidence').notNull().default('[]'),
    /** 强度历史 JSON（{date,strength}[]，按日去重，近30日，旧→新；S5 生命周期趋势） */
    strengthHistory: text('strength_history').notNull().default('[]'),
    firstSeenDate: text('first_seen_date').notNull(),
    lastSeenDate: text('last_seen_date').notNull(),
    updatedAt: text('updated_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ byStatus: index('idx_market_themes_status').on(t.status) }),
);

/**
 * 决策裁决缓存：结构化存放一次多智能体辩论的最终裁决，按 (code,scenario,horizon) 唯一。
 * 交易判断只认本表（带 dataAsOf/expiresAt/inputHash/invalidators 校验），过期或场景/输入不一致必须重跑；
 * 严禁再用 ai_analyses 的 markdown latest 当交易缓存（markdown 仅供人读历史）。
 */
export const decisionVerdicts = sqliteTable(
  'decision_verdicts',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull().default(''),
    /** 决策场景：manual / plan / sellcheck / watch */
    scenario: text('scenario').notNull().default('manual'),
    /** 持有视角：short 短线 / mid 中线 */
    horizon: text('horizon').notNull().default('short'),
    /** 冗余裁决动作，便于快速查询/展示 */
    action: text('action').notNull().default('hold'),
    confidence: integer('confidence').notNull().default(0),
    /** 数据基准时刻（ISO） */
    dataAsOf: text('data_as_of').notNull(),
    /** 过期时刻（ISO），超过即视为失效须重跑 */
    expiresAt: text('expires_at').notNull(),
    /** 输入指纹（code+场景+context+引擎配置），不一致即重跑 */
    inputHash: text('input_hash').notNull().default(''),
    /** 完整 DecisionResult 的 JSON 快照 */
    verdictJson: text('verdict_json').notNull().default('{}'),
    /** 失效条件清单 JSON（string[]，人读 + 价格越界判定锚点） */
    invalidators: text('invalidators').notNull().default('[]'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byKey: uniqueIndex('idx_decision_verdicts_key').on(t.code, t.scenario, t.horizon),
    byExpiry: index('idx_decision_verdicts_expiry').on(t.expiresAt),
  }),
);

/**
 * 市场情绪周期日快照（S1）：每交易日收盘记录一次 0-100 情绪指数 + 水位档 + 周期阶段 + 原始构成，
 * 一天一行（trade_date 唯一），供「恢复 vs 退潮」方向判定与历史趋势图。纯只读统计，不参与交易。
 */
export const sentimentSnapshots = sqliteTable(
  'sentiment_snapshots',
  {
    /** 交易日 YYYY-MM-DD（Asia/Shanghai），唯一主键 */
    tradeDate: text('trade_date').primaryKey(),
    /** 综合情绪指数 0-100 */
    indexScore: real('index_score').notNull(),
    /** 水位档位（冰点/低迷/平稳/活跃/高潮） */
    level: text('level').notNull(),
    /** 周期阶段（冰点/恢复/高潮/退潮/震荡） */
    phase: text('phase').notNull(),
    /** 乐咕活跃度 %（直读，冗余便于查询） */
    activity: real('activity'),
    /** 最高连板高度（冗余） */
    maxStreak: integer('max_streak'),
    /** 指数构成拆解 StrengthBreakdown JSON */
    breakdown: text('breakdown').notNull().default('{}'),
    /** 原始构成指标 SentimentComponents JSON */
    components: text('components').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ byDate: index('idx_sentiment_snapshots_date').on(t.tradeDate) }),
);

/**
 * 大盘阶段日快照：每交易日记录一次大盘阶段（主升/反弹/退潮/震荡）+ 综合强度分 + 明日倾向 + 建议频率/仓位，
 * 一天一行（trade_date 唯一），供「较昨分数变动 / 阶段已持续天数」与历史趋势图。纯只读统计，不参与交易。
 */
export const regimeSnapshots = sqliteTable(
  'regime_snapshots',
  {
    /** 交易日 YYYY-MM-DD（Asia/Shanghai），唯一主键 */
    tradeDate: text('trade_date').primaryKey(),
    /** 阶段（主升/反弹/退潮/震荡） */
    phase: text('phase').notNull(),
    /** 综合强度分 0-100 */
    score: real('score').notNull(),
    /** 明日/近期方向倾向（偏强/偏弱/中性） */
    tomorrowBias: text('tomorrow_bias').notNull(),
    /** 建议交易频率（积极/正常/降低/观望） */
    suggestedFrequency: text('suggested_frequency').notNull(),
    /** 建议仓位区间（白话） */
    positionRange: text('position_range').notNull(),
    /** 各维度贡献拆解 StrengthBreakdown JSON */
    breakdown: text('breakdown').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ byDate: index('idx_regime_snapshots_date').on(t.tradeDate) }),
);

/**
 * 宽基指数主力资金流日快照：每交易日每指数一行（secid + trade_date 唯一）。
 *
 * 为什么要落库而不是每次在线取：东财只有 push2his 提供多日历史，而它的 /api/ 路径
 * 在本项目所在网络出口被连接重置（providers.ts 已记录 K 线同样 0% 成功，故改走通达信）。
 * 可达的 push2delay 镜像无视 lmt 参数、永远只回当日一条。主力净流入又是东财按单笔
 * 金额分档算出的派生指标，通达信没有等价数据。所以历史只能从今天起逐日积累——
 * 与 sidecar 的北向资金历史同一套做法。
 */
export const indexFlowSnapshots = sqliteTable(
  'index_flow_snapshots',
  {
    /** 东财 secid（市场前缀.代码），如 1.000300 */
    secid: text('secid').notNull(),
    /** 交易日 YYYY-MM-DD（Asia/Shanghai） */
    tradeDate: text('trade_date').notNull(),
    /** 主力净流入额（亿，正为净流入） */
    main: real('main').notNull(),
    /** 当日指数涨跌幅 % */
    pct: real('pct').notNull().default(0),
    /** 取数来源 host，便于日后分辨这条是当日镜像还是历史源回填的 */
    source: text('source').notNull().default(''),
    /** 实际抓取时间 ISO */
    fetchedAt: text('fetched_at').notNull(),
  },
  (t) => ({
    byKey: uniqueIndex('idx_index_flow_snapshots_key').on(t.secid, t.tradeDate),
    byDate: index('idx_index_flow_snapshots_date').on(t.tradeDate),
  }),
);

/** 真实持仓纪律事件流（确定性体检命中止损/止盈/超配/超期等时落库，供历史与智能推送去重） */
export const disciplineEvents = sqliteTable(
  'discipline_events',
  {
    id: text('id').primaryKey(),
    account: text('account').notNull().default('real'),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** stop_loss | take_profit | overweight | over_hold | near_stop */
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    detail: text('detail').notNull(),
    /** 命中时持有盈亏率快照（小数） */
    holdRate: real('hold_rate'),
    /** 命中日 YYYY-MM-DD（Asia/Shanghai，用于按日去重防刷屏） */
    eventDate: text('event_date').notNull(),
    delivered: integer('delivered', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byCreated: index('idx_discipline_events_created').on(t.createdAt),
    byCodeKindDate: index('idx_discipline_events_dedup').on(t.code, t.kind, t.eventDate),
    /** 「止损未执行」按 (kind, event_date) 窗口查，去重索引以 code 打头用不上 */
    byKindDate: index('idx_discipline_events_kind_date').on(t.kind, t.eventDate),
  }),
);

/** 日终持仓归因：逐票当日盈亏贡献（按 date+code 幂等），供「真实账户今日谁赚谁亏」复盘。 */
export const positionAttributions = sqliteTable(
  'position_attributions',
  {
    id: text('id').primaryKey(),
    account: text('account').notNull().default('real'),
    /** 归因日 YYYY-MM-DD（Asia/Shanghai） */
    date: text('date').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** 当日盈亏额（元） */
    dayPnl: real('day_pnl').notNull().default(0),
    /** 当日盈亏率（小数） */
    dayRate: real('day_rate').notNull().default(0),
    /** 仓位权重（小数，市值/总资产） */
    weight: real('weight').notNull().default(0),
    /** 当日对账户盈亏贡献（小数，dayRate×weight） */
    contribution: real('contribution').notNull().default(0),
    /** 确定性归因文本（可选） */
    note: text('note'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byDate: index('idx_position_attributions_date').on(t.date),
    byKey: uniqueIndex('idx_position_attributions_key').on(t.account, t.date, t.code),
  }),
);

/** 回测运行记录（单标的信号级 / 组合级）：曲线与流水以 JSON 列内联存储 */
export const backtestRuns = sqliteTable(
  'backtest_runs',
  {
    id: text('id').primaryKey(),
    /** signal | portfolio */
    scope: text('scope').notNull().default('signal'),
    label: text('label').notNull().default(''),
    /** string[] JSON：参与回测的标的代码 */
    codes: text('codes').notNull().default('[]'),
    preset: text('preset').notNull(),
    /** BacktestParams JSON */
    params: text('params').notNull().default('{}'),
    /** day | week */
    period: text('period').notNull().default('day'),
    /** 数据区间描述 */
    range: text('range').notNull().default(''),
    /** BacktestCosts JSON */
    costs: text('costs').notNull().default('{}'),
    /** BacktestMetricsLite JSON */
    metrics: text('metrics').notNull().default('{}'),
    /** BacktestSystemMetrics[] JSON（组合分系统绩效） */
    systems: text('systems').notNull().default('[]'),
    /** BacktestEquityPoint[] JSON */
    equity: text('equity').notNull().default('[]'),
    /** BacktestTradeLite[] JSON */
    trades: text('trades').notNull().default('[]'),
    /** string[] JSON：口径/近似说明 */
    notes: text('notes').notNull().default('[]'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byCreated: index('idx_backtest_runs_created').on(t.createdAt),
  }),
);

/**
 * 板块新高宽度日快照（主线识别）：一天一行 per 板块，沉淀「板块内 60 日新高个股数」横向排名。
 * 主线判据 = 新高数最多且持续多日稳居榜首，故必须按交易日落库以算持续天数/排名变化/退潮。
 * 按 (trade_date, board_code) 唯一，upsert 幂等。纯确定性只读统计，不下单、不调 LLM。
 */
export const boardNewHighSnapshots = sqliteTable(
  'board_newhigh_snapshots',
  {
    id: text('id').primaryKey(),
    /** 交易日 YYYY-MM-DD（Asia/Shanghai） */
    tradeDate: text('trade_date').notNull(),
    /** 板块代码（东财板块代码） */
    boardCode: text('board_code').notNull(),
    /** 板块名称 */
    boardName: text('board_name').notNull(),
    /** 板块口径：industry 行业 / concept 概念 */
    kind: text('kind').notNull(),
    /** 板块内创新高个股数 */
    newHighCount: integer('new_high_count').notNull().default(0),
    /** 板块成分股总数（算占比用） */
    consTotal: integer('cons_total').notNull().default(0),
    /** 新高占比 %（newHighCount / consTotal * 100） */
    ratio: real('ratio').notNull().default(0),
    /** 当日全榜横向排名（1 = 新高数最多） */
    rank: integer('rank').notNull().default(0),
    /**
     * 当日该板块内创新高的成分股代码 JSON（升序，上限 CORE_CODES_CAP 只）。
     * 跨日确认要看「还是不是同一批股」：只比新高数量会把「每天换一批股轮流冲高」的普涨噪声误判成持续主线。
     */
    coreCodes: text('core_codes').notNull().default('[]'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byDate: index('idx_board_newhigh_date').on(t.tradeDate),
    byKey: uniqueIndex('idx_board_newhigh_key').on(t.tradeDate, t.boardCode),
  }),
);

/**
 * 全市场日K本地缓存（前复权）：盘前预热 + 盘中增量追加，替代每次实时回源。
 * adjBase 记录写入时的复权基准日：前复权价随分红送股整体变动，只做增量追加会让历史段口径与新段不一致，
 * 故按 adjBase 分辨新旧口径，每周全量重刷时统一推进基准日并覆盖全部历史行。
 *
 * 主键含 secid：6 位代码会撞码（000001 既是上证指数也是平安银行），只按 code 建键两者会互相覆盖。
 */
export const klineDaily = sqliteTable(
  'kline_daily',
  {
    /** 6 位证券代码 */
    code: text('code').notNull(),
    /** 东财 secid（市场前缀.代码），区分同码的指数与个股 */
    secid: text('secid').notNull(),
    /** 交易日 YYYY-MM-DD */
    tradeDate: text('trade_date').notNull(),
    open: real('open').notNull(),
    high: real('high').notNull(),
    low: real('low').notNull(),
    close: real('close').notNull(),
    /** 成交量（手） */
    volume: real('volume').notNull().default(0),
    /** 成交额（元） */
    amount: real('amount').notNull().default(0),
    /** 复权基准日 YYYY-MM-DD：该行写入时所属的全量重刷批次 */
    adjBase: text('adj_base').notNull(),
    /** 1 = 盘中用实时报价合成的当日临时 bar，收盘后会被真实日线覆盖 */
    provisional: integer('provisional').notNull().default(0),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.code, t.secid, t.tradeDate] }),
    // 按 code 的索引与主键前缀重复、纯写放大；真正要走索引的是 getCacheStats 的 max(trade_date)
    // 与 pruneCache 的 trade_date < cutoff（前者挂在号称秒开的 /api/cockpit/panorama 上）
    byDate: index('idx_kline_daily_date').on(t.tradeDate),
  }),
);

// ===== 大V观点（微博大V + 小红书博主实时发帖聚合）=====

/**
 * 关注的大V名单（在「大V观点」页添加/删除）。
 * uid 不加平台前缀直接做主键：微博 UID 是纯数字、小红书 userId 是 24 位 hex，
 * 两个 ID 空间天然不重叠，省掉复合主键的建表迁移。
 */
export const kolAccounts = sqliteTable('kol_accounts', {
  /** 微博 UID / 小红书 userId */
  uid: text('uid').primaryKey(),
  /** weibo | xiaohongshu */
  platform: text('platform').notNull().default('weibo'),
  screenName: text('screen_name').notNull(),
  /** 小红书号（与 userId 是两套 ID），仅小红书有，用于和 App 里的账号核对 */
  redId: text('red_id'),
  avatar: text('avatar'),
  /** 微博认证信息 / 小红书个人简介，用于辨别真身与同名号 */
  verifiedReason: text('verified_reason'),
  /** 粉丝数展示串（微博「1313.3万」、小红书「1万+」这类，原样存） */
  followersCount: text('followers_count'),
  /** 1 参与定时抓取 / 0 暂停 */
  enabled: integer('enabled').notNull().default(1),
  /** 名单展示排序（小的在前） */
  sortOrder: integer('sort_order').notNull().default(0),
  addedAt: text('added_at').notNull(),
});

/** 大V博文/笔记（按 bid 幂等 upsert，重复抓取不产生重复行） */
export const kolPosts = sqliteTable(
  'kol_posts',
  {
    /** 微博 bid / 小红书 noteId；小红书降级模式下为「作者+标题」合成键 */
    bid: text('bid').primaryKey(),
    uid: text('uid').notNull(),
    /** weibo | xiaohongshu */
    platform: text('platform').notNull().default('weibo'),
    screenName: text('screen_name').notNull(),
    avatar: text('avatar'),
    /** 已清洗的正文（微博长文为补拉后的全文；小红书为「标题\n\n正文」） */
    text: text('text').notNull(),
    /** 发布时间 ISO；小红书降级模式下取首次入库时间 */
    createdAt: text('created_at').notNull(),
    url: text('url'),
    /** 1 转发他人 / 0 原创（小红书恒 0） */
    isRetweet: integer('is_retweet').notNull().default(0),
    /** 被转发原文（含原作者） */
    retweetText: text('retweet_text'),
    reposts: integer('reposts').notNull().default(0),
    comments: integer('comments').notNull().default(0),
    attitudes: integer('attitudes').notNull().default(0),
    /** 1 为仅有标题的降级记录（小红书未配置 Cookie 时） */
    titleOnly: integer('title_only').notNull().default(0),
    /** 配图列表 JSON（KolImage[]，已下载到本地的站内地址），无图为 null */
    images: text('images'),
    fetchedAt: text('fetched_at').notNull(),
  },
  (t) => ({
    byTime: index('idx_kol_posts_time').on(t.createdAt),
    byUid: index('idx_kol_posts_uid').on(t.uid),
  }),
);
