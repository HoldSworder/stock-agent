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
  strategy_id TEXT,
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

CREATE TABLE IF NOT EXISTS etf_pool (
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

CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'local',
  initial_capital REAL NOT NULL,
  cash REAL NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT,
  skill_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strategy_skills (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  source_run_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_strategy_dim ON strategy_skills(strategy_id, dimension);
CREATE INDEX IF NOT EXISTS idx_skill_status ON strategy_skills(strategy_id, status);

CREATE TABLE IF NOT EXISTS sim_positions (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  qty REAL NOT NULL,
  avg_cost REAL NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_simpos_strategy ON sim_positions(strategy_id);

CREATE TABLE IF NOT EXISTS sim_position_thesis (
  strategy_id TEXT NOT NULL,
  code TEXT NOT NULL,
  thesis TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (strategy_id, code)
);

CREATE TABLE IF NOT EXISTS sim_trade_reasons (
  strategy_id TEXT NOT NULL,
  code TEXT NOT NULL,
  side TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (strategy_id, code, side, trade_date)
);

CREATE TABLE IF NOT EXISTS sim_trades (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  run_id TEXT,
  ext_id TEXT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  amount REAL NOT NULL,
  realized_profit REAL,
  reason TEXT,
  source TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_simtrade_strategy ON sim_trades(strategy_id);
CREATE INDEX IF NOT EXISTS idx_simtrade_strategy_date ON sim_trades(strategy_id, trade_date);

CREATE TABLE IF NOT EXISTS watch_alerts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  detail TEXT NOT NULL,
  run_id TEXT,
  advice_text TEXT,
  verdict TEXT,
  should_alert INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  trigger_price REAL NOT NULL DEFAULT 0,
  outcome TEXT,
  outcome_pct REAL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  strategy_id TEXT,
  strategy_name TEXT,
  exec_status TEXT,
  exec_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watch_alerts_created ON watch_alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_watch_alerts_code ON watch_alerts(code);

CREATE TABLE IF NOT EXISTS llm_calls (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  run_id TEXT,
  task_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_calls_purpose ON llm_calls(purpose);

CREATE TABLE IF NOT EXISTS daily_plans (
  id TEXT PRIMARY KEY,
  plan_date TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  market_stance TEXT,
  focus_sectors TEXT NOT NULL DEFAULT '[]',
  external_context TEXT,
  narrative TEXT,
  run_id TEXT,
  review_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_plan_items (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  asset_type TEXT NOT NULL DEFAULT 'stock',
  direction TEXT NOT NULL DEFAULT 'watch',
  thesis TEXT,
  buy_trigger TEXT,
  sell_trigger TEXT,
  stop_loss TEXT,
  take_profit TEXT,
  position_hint TEXT,
  source TEXT NOT NULL DEFAULT 'other',
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  last_note TEXT,
  debate_verdict TEXT,
  debate_confidence INTEGER,
  debate_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_items_plan ON daily_plan_items(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_items_code ON daily_plan_items(code);

CREATE TABLE IF NOT EXISTS daily_plan_events (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  item_id TEXT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT,
  run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_events_plan ON daily_plan_events(plan_id);

CREATE TABLE IF NOT EXISTS trend_summaries (
  id TEXT PRIMARY KEY,
  report_type TEXT NOT NULL,
  content TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trend_summaries_created ON trend_summaries(created_at);

CREATE TABLE IF NOT EXISTS ai_analyses (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_key TEXT,
  title TEXT,
  run_id TEXT,
  content TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_analyses_kind_ref ON ai_analyses(kind, ref_key, created_at);

CREATE TABLE IF NOT EXISTS decision_memory (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  decision_date TEXT NOT NULL,
  action TEXT NOT NULL,
  confidence INTEGER NOT NULL DEFAULT 0,
  entry_price REAL,
  target_price REAL,
  stop_loss REAL,
  position_pct REAL,
  thesis TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_at TEXT,
  review_price REAL,
  stock_return REAL,
  csi300_return REAL,
  alpha REAL,
  verdict TEXT,
  lesson TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_memory_code ON decision_memory(code, created_at);
CREATE INDEX IF NOT EXISTS idx_decision_memory_status ON decision_memory(status, decision_date);

CREATE TABLE IF NOT EXISTS screen_runs (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL DEFAULT 'multifactor',
  strategy_id TEXT NOT NULL,
  strategy_name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  market_count INTEGER NOT NULL DEFAULT 0,
  filtered_count INTEGER NOT NULL DEFAULT 0,
  top_n INTEGER NOT NULL DEFAULT 0,
  context TEXT,
  market_view TEXT,
  selection_logic TEXT,
  portfolio_risk TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_screen_runs_created ON screen_runs(created_at);

CREATE TABLE IF NOT EXISTS screen_picks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  pct REAL NOT NULL,
  industry TEXT,
  screen_score REAL NOT NULL,
  factors TEXT NOT NULL DEFAULT '[]',
  thesis TEXT,
  risk_tags TEXT NOT NULL DEFAULT '[]',
  confidence INTEGER,
  watch_items TEXT NOT NULL DEFAULT '[]',
  invalidators TEXT NOT NULL DEFAULT '[]',
  eval_price REAL,
  eval_at TEXT,
  eval_return REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_screen_picks_run ON screen_picks(run_id);

CREATE TABLE IF NOT EXISTS safety_controls (
  id TEXT PRIMARY KEY,
  kill_switch INTEGER NOT NULL DEFAULT 0,
  kill_reason TEXT,
  auto_local_sim_enabled INTEGER NOT NULL DEFAULT 0,
  auto_external_sim_enabled INTEGER NOT NULL DEFAULT 0,
  allow_manual_force_trade INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_locks (
  lock_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function ensureSchema(): void {
  sqlite.exec(DDL);
  // 选股留痕功能已下线，记录改由战法模拟承接：清理历史表与数据
  sqlite.exec('DROP TABLE IF EXISTS stock_picks');
  // 旧库增量补列（已存在则忽略）
  const addColumns = [
    "ALTER TABLE scheduled_tasks ADD COLUMN strategy_id TEXT",
    "ALTER TABLE strategies ADD COLUMN kind TEXT NOT NULL DEFAULT 'local'",
    "ALTER TABLE strategies ADD COLUMN synced_at TEXT",
    "ALTER TABLE strategies ADD COLUMN skill_enabled INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sim_trades ADD COLUMN ext_id TEXT",
    "ALTER TABLE watch_alerts ADD COLUMN trigger_price REAL NOT NULL DEFAULT 0",
    "ALTER TABLE watch_alerts ADD COLUMN outcome TEXT",
    "ALTER TABLE watch_alerts ADD COLUMN outcome_pct REAL",
    "ALTER TABLE watch_alerts ADD COLUMN prompt_tokens INTEGER",
    "ALTER TABLE watch_alerts ADD COLUMN completion_tokens INTEGER",
    "ALTER TABLE watch_alerts ADD COLUMN strategy_id TEXT",
    "ALTER TABLE watch_alerts ADD COLUMN strategy_name TEXT",
    "ALTER TABLE watch_alerts ADD COLUMN exec_status TEXT",
    "ALTER TABLE watch_alerts ADD COLUMN exec_note TEXT",
    "ALTER TABLE daily_plan_items ADD COLUMN asset_type TEXT NOT NULL DEFAULT 'stock'",
    'ALTER TABLE daily_plan_items ADD COLUMN debate_verdict TEXT',
    'ALTER TABLE daily_plan_items ADD COLUMN debate_confidence INTEGER',
    'ALTER TABLE daily_plan_items ADD COLUMN debate_note TEXT',
    "ALTER TABLE screen_runs ADD COLUMN engine TEXT NOT NULL DEFAULT 'multifactor'",
  ];
  for (const sql of addColumns) {
    try {
      sqlite.exec(sql);
    } catch {
      /* 列已存在 */
    }
  }
}
