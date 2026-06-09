import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';

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

/** 结构化选股留痕 */
export const stockPicks = sqliteTable(
  'stock_picks',
  {
    id: text('id').primaryKey(),
    runId: text('run_id'),
    code: text('code').notNull(),
    name: text('name').notNull(),
    price: real('price'),
    reason: text('reason'),
    signals: text('signals'),
    tags: text('tags'),
    pickedAt: text('picked_at').notNull(),
  },
  (t) => ({
    byPicked: index('idx_picks_picked').on(t.pickedAt),
    byCode: index('idx_picks_code').on(t.code),
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
