import { sqlite } from './client';

// 运行时自建表，保证容器启动即可用，无需在生产环境依赖 drizzle-kit。
// 字段需与 schema.ts 保持一致。
const DDL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  cron_expr TEXT,
  tz TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  prompt TEXT NOT NULL,
  model_config TEXT NOT NULL DEFAULT '{}',
  notify_channels TEXT NOT NULL DEFAULT '["webui"]',
  timeout_sec INTEGER NOT NULL DEFAULT 600,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  task_name TEXT,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  input_prompt TEXT NOT NULL,
  output_text TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_started ON task_runs(started_at);

CREATE TABLE IF NOT EXISTS run_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msgs_run ON run_messages(run_id);

CREATE TABLE IF NOT EXISTS stock_picks (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  price REAL,
  reason TEXT,
  signals TEXT,
  tags TEXT,
  picked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_picks_picked ON stock_picks(picked_at);
CREATE INDEX IF NOT EXISTS idx_picks_code ON stock_picks(code);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chatmsg_session ON chat_messages(session_id);

CREATE TABLE IF NOT EXISTS watchlist (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tags TEXT,
  note TEXT,
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  qty REAL,
  avg_cost REAL,
  price REAL,
  market_value REAL,
  profit REAL,
  snapshot_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pos_snapshot ON positions(snapshot_at);
`;

export function ensureSchema(): void {
  sqlite.exec(DDL);
}
