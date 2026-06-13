import { sqliteTable, text, integer, real, index, primaryKey } from 'drizzle-orm/sqlite-core';

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

/** 聊天会话 */
export const chatSessions = sqliteTable('chat_sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

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

/** 自选股镜像 */
export const watchlist = sqliteTable('watchlist', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  tags: text('tags'),
  note: text('note'),
  addedAt: text('added_at').notNull(),
});

/** ETF 跟踪池（独立于自选股，ETF 模块自管买卖信号源） */
export const etfPool = sqliteTable('etf_pool', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  tags: text('tags'),
  note: text('note'),
  addedAt: text('added_at').notNull(),
});

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
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

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
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byCreated: index('idx_watch_alerts_created').on(t.createdAt),
    byCode: index('idx_watch_alerts_code').on(t.code),
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
  /** 大盘研判 MarketStance JSON */
  marketStance: text('market_stance'),
  /** 重点板块 PlanFocusSector[] JSON */
  focusSectors: text('focus_sectors').notNull().default('[]'),
  /** 隔夜外围/政策（文本） */
  externalContext: text('external_context'),
  /** 完整作战图（Markdown，供人阅读与推送） */
  narrative: text('narrative'),
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
    /** 来源：research/hotspot/sector/position/watchlist/other（体现串联来源） */
    source: text('source').notNull().default('other'),
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
    /** 来源集合 JSON（ThemeSource[]） */
    sources: text('sources').notNull().default('[]'),
    /** 证据要点 JSON（ThemeEvidence[]） */
    evidence: text('evidence').notNull().default('[]'),
    firstSeenDate: text('first_seen_date').notNull(),
    lastSeenDate: text('last_seen_date').notNull(),
    updatedAt: text('updated_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ byStatus: index('idx_market_themes_status').on(t.status) }),
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
  }),
);
