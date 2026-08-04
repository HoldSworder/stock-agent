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
  updated_at TEXT NOT NULL,
  ref_code TEXT,
  ref_name TEXT
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chatmsg_session ON chat_messages(session_id);

CREATE TABLE IF NOT EXISTS symbol_marks (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  note TEXT,
  points TEXT NOT NULL,
  color TEXT,
  session_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  semantic_key TEXT,
  timeframe TEXT,
  role TEXT,
  plan_id TEXT,
  plan_version INTEGER,
  status TEXT,
  invalidated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbol_marks_code ON symbol_marks(code, created_at);
-- 注意：idx_symbol_marks_plan 依赖后补的 plan_id 列，必须放到 addColumns 之后建，
-- 否则老库在 DDL 阶段就会因「no such column: plan_id」启动失败。

CREATE TABLE IF NOT EXISTS symbol_trade_plans (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  horizon TEXT NOT NULL,
  status TEXT NOT NULL,
  as_of TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  expires_at TEXT,
  data_status TEXT NOT NULL,
  summary TEXT NOT NULL,
  market_phase TEXT NOT NULL,
  trend_state TEXT NOT NULL,
  chan_setup TEXT NOT NULL,
  market_action TEXT NOT NULL,
  primary_action TEXT NOT NULL,
  changes TEXT NOT NULL,
  levels TEXT NOT NULL,
  scenarios TEXT NOT NULL,
  position_context TEXT,
  risk TEXT NOT NULL,
  exit_plan TEXT NOT NULL,
  execution TEXT NOT NULL,
  benchmarks TEXT NOT NULL,
  asset_specific_risks TEXT NOT NULL,
  evidence_snapshot TEXT,
  evidence_version TEXT NOT NULL,
  phase_model_version TEXT NOT NULL,
  candidate_model_version TEXT NOT NULL,
  context_id TEXT,
  session_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbol_plans_code ON symbol_trade_plans(code, horizon, status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_symbol_plans_code_version ON symbol_trade_plans(code, horizon, version);
CREATE INDEX IF NOT EXISTS idx_symbol_plans_run ON symbol_trade_plans(run_id);

CREATE TABLE IF NOT EXISTS symbol_trade_plan_events (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  condition_id TEXT,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbol_plan_events_plan ON symbol_trade_plan_events(plan_id, created_at);

CREATE TABLE IF NOT EXISTS watchlist (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tags TEXT,
  note TEXT,
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cockpit_focus (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
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
  auto_sim_enabled INTEGER NOT NULL DEFAULT 0,
  screen_engine TEXT,
  screen_strategy_id TEXT,
  horizon TEXT NOT NULL DEFAULT 'short',
  pick_top_n INTEGER,
  max_positions INTEGER,
  rebalance_cron TEXT,
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
  instruction_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watch_alerts_created ON watch_alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_watch_alerts_code ON watch_alerts(code);

CREATE TABLE IF NOT EXISTS etf_watch_signals (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  layer INTEGER NOT NULL DEFAULT 1,
  timeframe TEXT NOT NULL,
  position_pct REAL NOT NULL DEFAULT 0,
  detail TEXT NOT NULL,
  trigger_price REAL NOT NULL DEFAULT 0,
  dif REAL NOT NULL DEFAULT 0,
  dea REAL NOT NULL DEFAULT 0,
  confidence REAL,
  verdict TEXT,
  advice TEXT,
  bar_time TEXT,
  run_id TEXT,
  delivered INTEGER NOT NULL DEFAULT 0,
  confirm_json TEXT,
  instruction_json TEXT,
  trend_stage TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_etf_watch_signals_created ON etf_watch_signals(created_at);
CREATE INDEX IF NOT EXISTS idx_etf_watch_signals_code ON etf_watch_signals(code);

CREATE TABLE IF NOT EXISTS etf_watch_state (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  held_layers TEXT NOT NULL DEFAULT '[]',
  layer_entry_price TEXT NOT NULL DEFAULT '{}',
  layer_entry_at TEXT NOT NULL DEFAULT '{}',
  peak_price REAL NOT NULL DEFAULT 0,
  trend_stage TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS etf_share_daily (
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  shares REAL NOT NULL DEFAULT 0,
  close REAL NOT NULL DEFAULT 0,
  volume REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (code, date)
);
CREATE INDEX IF NOT EXISTS idx_etf_share_daily_code ON etf_share_daily(code);

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
  confirm_conditions TEXT NOT NULL DEFAULT '[]',
  invalid_conditions TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'other',
  confidence INTEGER,
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

CREATE TABLE IF NOT EXISTS news_catalysts (
  id TEXT PRIMARY KEY,
  theme TEXT NOT NULL,
  catalyst_type TEXT,
  direction TEXT,
  codes TEXT NOT NULL DEFAULT '[]',
  catalyst_window TEXT,
  first_seen_date TEXT NOT NULL,
  last_seen_date TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  fermented INTEGER NOT NULL DEFAULT 0,
  realized_pct REAL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_catalysts_theme ON news_catalysts(theme);
CREATE INDEX IF NOT EXISTS idx_news_catalysts_last_seen ON news_catalysts(last_seen_date);

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
  horizon TEXT NOT NULL DEFAULT 'short',
  universe_note TEXT,
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

CREATE TABLE IF NOT EXISTS position_discipline (
  account TEXT NOT NULL DEFAULT 'real',
  code TEXT NOT NULL,
  name TEXT,
  stop_loss_pct REAL,
  take_profit_pct REAL,
  max_hold_days INTEGER,
  single_max_weight_pct REAL,
  note TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account, code)
);

CREATE TABLE IF NOT EXISTS discipline_events (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL DEFAULT 'real',
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  detail TEXT NOT NULL,
  hold_rate REAL,
  event_date TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discipline_events_created ON discipline_events(created_at);
CREATE INDEX IF NOT EXISTS idx_discipline_events_dedup ON discipline_events(code, kind, event_date);
-- 「止损未执行」按 (kind, event_date) 窗口查，去重索引以 code 打头用不上，缺它就是全表扫
CREATE INDEX IF NOT EXISTS idx_discipline_events_kind_date ON discipline_events(kind, event_date);

CREATE TABLE IF NOT EXISTS market_themes (
  id TEXT PRIMARY KEY,
  theme TEXT NOT NULL UNIQUE,
  board_code TEXT,
  strength REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  phase TEXT NOT NULL DEFAULT '未知',
  sources TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '[]',
  strength_history TEXT NOT NULL DEFAULT '[]',
  first_seen_date TEXT NOT NULL,
  last_seen_date TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_themes_status ON market_themes(status);

CREATE TABLE IF NOT EXISTS decision_verdicts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  scenario TEXT NOT NULL DEFAULT 'manual',
  horizon TEXT NOT NULL DEFAULT 'short',
  action TEXT NOT NULL DEFAULT 'hold',
  confidence INTEGER NOT NULL DEFAULT 0,
  data_as_of TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  input_hash TEXT NOT NULL DEFAULT '',
  verdict_json TEXT NOT NULL DEFAULT '{}',
  invalidators TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_verdicts_key ON decision_verdicts(code, scenario, horizon);
CREATE INDEX IF NOT EXISTS idx_decision_verdicts_expiry ON decision_verdicts(expires_at);

CREATE TABLE IF NOT EXISTS strategy_samples (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  sample_date TEXT NOT NULL,
  total_asset REAL NOT NULL DEFAULT 0,
  total_profit_rate REAL NOT NULL DEFAULT 0,
  position_count INTEGER NOT NULL DEFAULT 0,
  cash REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_samples_key ON strategy_samples(strategy_id, sample_date);

CREATE TABLE IF NOT EXISTS sentiment_snapshots (
  trade_date TEXT PRIMARY KEY,
  index_score REAL NOT NULL,
  level TEXT NOT NULL,
  phase TEXT NOT NULL,
  activity REAL,
  max_streak INTEGER,
  breakdown TEXT NOT NULL DEFAULT '{}',
  components TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sentiment_snapshots_date ON sentiment_snapshots(trade_date);

CREATE TABLE IF NOT EXISTS regime_snapshots (
  trade_date TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  score REAL NOT NULL,
  tomorrow_bias TEXT NOT NULL,
  suggested_frequency TEXT NOT NULL,
  position_range TEXT NOT NULL,
  breakdown TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_regime_snapshots_date ON regime_snapshots(trade_date);

CREATE TABLE IF NOT EXISTS position_attributions (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL DEFAULT 'real',
  date TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  day_pnl REAL NOT NULL DEFAULT 0,
  day_rate REAL NOT NULL DEFAULT 0,
  weight REAL NOT NULL DEFAULT 0,
  contribution REAL NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_position_attributions_date ON position_attributions(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_position_attributions_key ON position_attributions(account, date, code);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'signal',
  label TEXT NOT NULL DEFAULT '',
  codes TEXT NOT NULL DEFAULT '[]',
  preset TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  period TEXT NOT NULL DEFAULT 'day',
  range TEXT NOT NULL DEFAULT '',
  costs TEXT NOT NULL DEFAULT '{}',
  metrics TEXT NOT NULL DEFAULT '{}',
  systems TEXT NOT NULL DEFAULT '[]',
  equity TEXT NOT NULL DEFAULT '[]',
  trades TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_created ON backtest_runs(created_at);

CREATE TABLE IF NOT EXISTS board_newhigh_snapshots (
  id TEXT PRIMARY KEY,
  trade_date TEXT NOT NULL,
  board_code TEXT NOT NULL,
  board_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  new_high_count INTEGER NOT NULL DEFAULT 0,
  cons_total INTEGER NOT NULL DEFAULT 0,
  ratio REAL NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_newhigh_date ON board_newhigh_snapshots(trade_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_newhigh_key ON board_newhigh_snapshots(trade_date, board_code);

CREATE TABLE IF NOT EXISTS kline_daily (
  code TEXT NOT NULL,
  secid TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  adj_base TEXT NOT NULL,
  provisional INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (code, secid, trade_date)
);
-- 按 code 的索引与主键前缀完全重复（纯写放大），真正需要走索引的是按 trade_date 的聚合与清理
DROP INDEX IF EXISTS idx_kline_daily_code;
CREATE INDEX IF NOT EXISTS idx_kline_daily_date ON kline_daily(trade_date);

CREATE TABLE IF NOT EXISTS research_universe (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tags TEXT,
  note TEXT,
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_modes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  tags TEXT,
  status TEXT NOT NULL DEFAULT 'experiment',
  summary TEXT,
  buy_sell_md TEXT,
  recommended_config TEXT,
  analysis_md TEXT,
  universe_note TEXT,
  risks_md TEXT,
  followed INTEGER NOT NULL DEFAULT 0,
  tracking_mode TEXT NOT NULL DEFAULT 'external',
  spec TEXT,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playbooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT,
  category TEXT,
  tags TEXT,
  horizon TEXT,
  market_env TEXT,
  source TEXT,
  source_url TEXT,
  pick_md TEXT,
  buy_md TEXT,
  sell_md TEXT,
  risk_md TEXT,
  notes_md TEXT,
  rating INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'collected',
  spec TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playbook_backtests (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL,
  label TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'system',
  range TEXT,
  pool_size INTEGER,
  metrics TEXT NOT NULL DEFAULT '{}',
  trades TEXT NOT NULL DEFAULT '[]',
  equity TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '[]',
  spec TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playbook_bt_playbook ON playbook_backtests(playbook_id);

CREATE TABLE IF NOT EXISTS research_mode_backtests (
  id TEXT PRIMARY KEY,
  mode_id TEXT NOT NULL,
  label TEXT NOT NULL,
  range TEXT,
  pool_size INTEGER,
  metrics TEXT NOT NULL DEFAULT '{}',
  cost_sensitivity TEXT NOT NULL DEFAULT '[]',
  segments TEXT NOT NULL DEFAULT '[]',
  concentration_md TEXT,
  trades_md TEXT,
  is_recommended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mode_bt_mode ON research_mode_backtests(mode_id);

CREATE TABLE IF NOT EXISTS research_mode_daily (
  id TEXT PRIMARY KEY,
  mode_id TEXT NOT NULL,
  date TEXT NOT NULL,
  holdings TEXT NOT NULL DEFAULT '[]',
  signal TEXT,
  day_return REAL,
  cum_return REAL,
  drawdown REAL,
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mode_daily_key ON research_mode_daily(mode_id, date);

CREATE TABLE IF NOT EXISTS research_mode_events (
  id TEXT PRIMARY KEY,
  mode_id TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mode_evt_mode ON research_mode_events(mode_id);

CREATE TABLE IF NOT EXISTS kol_accounts (
  uid TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'weibo',
  screen_name TEXT NOT NULL,
  red_id TEXT,
  avatar TEXT,
  verified_reason TEXT,
  followers_count TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kol_posts (
  bid TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'weibo',
  screen_name TEXT NOT NULL,
  avatar TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  url TEXT,
  is_retweet INTEGER NOT NULL DEFAULT 0,
  retweet_text TEXT,
  reposts INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  attitudes INTEGER NOT NULL DEFAULT 0,
  title_only INTEGER NOT NULL DEFAULT 0,
  images TEXT,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kol_posts_time ON kol_posts(created_at);
CREATE INDEX IF NOT EXISTS idx_kol_posts_uid ON kol_posts(uid);
`;

/**
 * 建表前的破坏性重建：主键变更 SQLite 无法用 ALTER 完成，且旧行缺少判定来源身份的列。
 * 只在「表存在且缺列」时执行一次，之后 PRAGMA 已带新列，重复执行为空操作（幂等）。
 */
function dropLegacyTables(): void {
  // kline_daily 旧主键为 (code, trade_date)：上证指数与平安银行同为 000001，两者的 K 线互相覆盖过。
  // 旧行无法回溯它到底属于哪一只，与其保留脏数据不如清空——预热任务会在下一轮全部重建（纯缓存表，无原始数据丢失）。
  try {
    const cols = sqlite.prepare('PRAGMA table_info(kline_daily)').all() as { name: string }[];
    if (cols.length > 0 && !cols.some((c) => c.name === 'secid')) {
      sqlite.exec('DROP TABLE kline_daily');
      console.warn('[migrate] kline_daily 主键改为 (code, secid, trade_date)，已清空旧缓存等待预热重建');
    }
  } catch (e) {
    console.warn('[migrate] kline_daily 旧表检查失败:', e instanceof Error ? e.message : e);
  }
}

export function ensureSchema(): void {
  dropLegacyTables();
  sqlite.exec(DDL);
  // 选股留痕功能已下线，记录改由战法模拟承接：清理历史表与数据
  sqlite.exec('DROP TABLE IF EXISTS stock_picks');
  // 旧库增量补列（已存在则忽略）
  const addColumns = [
    "ALTER TABLE scheduled_tasks ADD COLUMN strategy_id TEXT",
    'ALTER TABLE playbooks ADD COLUMN spec TEXT',
    "ALTER TABLE strategies ADD COLUMN kind TEXT NOT NULL DEFAULT 'local'",
    "ALTER TABLE strategies ADD COLUMN synced_at TEXT",
    "ALTER TABLE strategies ADD COLUMN skill_enabled INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE strategies ADD COLUMN auto_sim_enabled INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE strategies ADD COLUMN screen_engine TEXT",
    "ALTER TABLE strategies ADD COLUMN screen_strategy_id TEXT",
    "ALTER TABLE strategies ADD COLUMN horizon TEXT NOT NULL DEFAULT 'short'",
    "ALTER TABLE strategies ADD COLUMN pick_top_n INTEGER",
    "ALTER TABLE strategies ADD COLUMN max_positions INTEGER",
    "ALTER TABLE strategies ADD COLUMN rebalance_cron TEXT",
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
    'ALTER TABLE watch_alerts ADD COLUMN instruction_json TEXT',
    "ALTER TABLE daily_plan_items ADD COLUMN asset_type TEXT NOT NULL DEFAULT 'stock'",
    'ALTER TABLE daily_plan_items ADD COLUMN debate_verdict TEXT',
    'ALTER TABLE daily_plan_items ADD COLUMN debate_confidence INTEGER',
    'ALTER TABLE daily_plan_items ADD COLUMN debate_note TEXT',
    "ALTER TABLE daily_plan_items ADD COLUMN confirm_conditions TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE daily_plan_items ADD COLUMN invalid_conditions TEXT NOT NULL DEFAULT '[]'",
    'ALTER TABLE daily_plan_items ADD COLUMN confidence INTEGER',
    "ALTER TABLE screen_runs ADD COLUMN engine TEXT NOT NULL DEFAULT 'multifactor'",
    "ALTER TABLE screen_runs ADD COLUMN horizon TEXT NOT NULL DEFAULT 'short'",
    "ALTER TABLE screen_runs ADD COLUMN universe_note TEXT",
    "ALTER TABLE market_themes ADD COLUMN phase TEXT NOT NULL DEFAULT '未知'",
    "ALTER TABLE market_themes ADD COLUMN strength_history TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE daily_plans ADD COLUMN key_risks TEXT NOT NULL DEFAULT '[]'",
    'ALTER TABLE daily_plans ADD COLUMN intraday_guide TEXT',
    'ALTER TABLE etf_watch_signals ADD COLUMN verdict TEXT',
    'ALTER TABLE etf_watch_signals ADD COLUMN bar_time TEXT',
    'ALTER TABLE etf_watch_signals ADD COLUMN confirm_json TEXT',
    'ALTER TABLE etf_watch_signals ADD COLUMN instruction_json TEXT',
    'ALTER TABLE etf_watch_signals ADD COLUMN trend_stage TEXT',
    "ALTER TABLE etf_watch_state ADD COLUMN layer_entry_at TEXT NOT NULL DEFAULT '{}'",
    'ALTER TABLE etf_watch_state ADD COLUMN trend_stage TEXT',
    "ALTER TABLE kol_accounts ADD COLUMN platform TEXT NOT NULL DEFAULT 'weibo'",
    'ALTER TABLE kol_accounts ADD COLUMN red_id TEXT',
    "ALTER TABLE kol_posts ADD COLUMN platform TEXT NOT NULL DEFAULT 'weibo'",
    'ALTER TABLE kol_posts ADD COLUMN title_only INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE kol_posts ADD COLUMN images TEXT',
    "ALTER TABLE board_newhigh_snapshots ADD COLUMN core_codes TEXT NOT NULL DEFAULT '[]'",
    'ALTER TABLE screen_runs ADD COLUMN diagnostics TEXT',
    'ALTER TABLE research_modes ADD COLUMN variant_count INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE research_mode_backtests ADD COLUMN protocol TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE chat_sessions ADD COLUMN ref_code TEXT',
    'ALTER TABLE chat_sessions ADD COLUMN ref_name TEXT',
    'ALTER TABLE symbol_marks ADD COLUMN semantic_key TEXT',
    'ALTER TABLE symbol_marks ADD COLUMN timeframe TEXT',
    'ALTER TABLE symbol_marks ADD COLUMN role TEXT',
    'ALTER TABLE symbol_marks ADD COLUMN plan_id TEXT',
    'ALTER TABLE symbol_marks ADD COLUMN plan_version INTEGER',
    'ALTER TABLE symbol_marks ADD COLUMN status TEXT',
    'ALTER TABLE symbol_marks ADD COLUMN invalidated_at TEXT',
    // 迭代早期建过这三张表的开发库会因 CREATE TABLE IF NOT EXISTS 跳过后续列，永久缺列。
    // 凡是后加进 CREATE 语句的列都要在这里补 ALTER（NOT NULL 列必须带 DEFAULT，否则老库 ALTER 失败）。
    "ALTER TABLE symbol_trade_plans ADD COLUMN market_phase TEXT NOT NULL DEFAULT 'uncertain'",
    "ALTER TABLE symbol_trade_plans ADD COLUMN primary_action TEXT NOT NULL DEFAULT 'wait'",
    "ALTER TABLE symbol_trade_plans ADD COLUMN candidate_model_version TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE symbol_trade_plans ADD COLUMN context_id TEXT',
    "ALTER TABLE symbol_trade_plans ADD COLUMN trend_state TEXT NOT NULL DEFAULT 'range'",
    "ALTER TABLE symbol_trade_plans ADD COLUMN chan_setup TEXT NOT NULL DEFAULT 'insufficient'",
    "ALTER TABLE symbol_trade_plans ADD COLUMN market_action TEXT NOT NULL DEFAULT 'wait'",
    "ALTER TABLE symbol_trade_plans ADD COLUMN changes TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE symbol_trade_plans ADD COLUMN levels TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE symbol_trade_plans ADD COLUMN scenarios TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE symbol_trade_plans ADD COLUMN risk TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE symbol_trade_plans ADD COLUMN exit_plan TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE symbol_trade_plans ADD COLUMN execution TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE symbol_trade_plans ADD COLUMN benchmarks TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE symbol_trade_plans ADD COLUMN asset_specific_risks TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE symbol_trade_plans ADD COLUMN evidence_version TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE symbol_trade_plans ADD COLUMN phase_model_version TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE symbol_trade_plans ADD COLUMN position_context TEXT',
    'ALTER TABLE symbol_trade_plans ADD COLUMN evidence_snapshot TEXT',
    'ALTER TABLE symbol_trade_plans ADD COLUMN session_id TEXT',
    'ALTER TABLE symbol_trade_plans ADD COLUMN run_id TEXT',
    'ALTER TABLE symbol_trade_plan_events ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE symbol_trade_plan_events ADD COLUMN condition_id TEXT',
    "ALTER TABLE symbol_trade_plan_events ADD COLUMN note TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE playbook_backtests ADD COLUMN source TEXT NOT NULL DEFAULT 'system'",
    'ALTER TABLE playbook_backtests ADD COLUMN range TEXT',
    'ALTER TABLE playbook_backtests ADD COLUMN pool_size INTEGER',
    "ALTER TABLE playbook_backtests ADD COLUMN metrics TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE playbook_backtests ADD COLUMN trades TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE playbook_backtests ADD COLUMN equity TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE playbook_backtests ADD COLUMN notes TEXT NOT NULL DEFAULT '[]'",
    'ALTER TABLE playbook_backtests ADD COLUMN spec TEXT',
  ];
  for (const sql of addColumns) {
    try {
      sqlite.exec(sql);
    } catch {
      /* 列已存在 */
    }
  }

  // 依赖后补列的索引：必须等 addColumns 跑完才能建，否则老库在 DDL 阶段就报 no such column
  const lateIndexes = [
    'CREATE INDEX IF NOT EXISTS idx_symbol_marks_plan ON symbol_marks(plan_id, plan_version)',
    // 标的专属会话按 ref_code find-or-create，靠唯一索引挡住并发建重（NULL 不参与唯一约束，
    // 普通会话不受影响）。历史上已产生重复行的库会建索引失败，此时只告警，由用户手工合并会话。
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_ref_code ON chat_sessions(ref_code)',
  ];
  for (const sql of lateIndexes) {
    try {
      sqlite.exec(sql);
    } catch (e) {
      console.warn('[migrate] 后置索引创建失败:', e instanceof Error ? e.message : e);
    }
  }

  warnOnSchemaDrift();
}

/**
 * 防漂移自检：校验若干「改 schema.ts 时最易漏补 migrate.ts」的关键列是否真的建出来了。
 * 缺失只告警不阻断启动——提醒开发者「schema.ts 改了字段但 migrate.ts 未补对应 ALTER」，
 * 避免再次出现 `no such column` 导致启动失败、整轮 agent run 被打断。
 */
function warnOnSchemaDrift(): void {
  const required: Record<string, string[]> = {
    scheduled_tasks: ['strategy_id'],
    strategies: ['kind', 'screen_engine', 'screen_strategy_id', 'horizon', 'rebalance_cron'],
    daily_plans: ['key_risks', 'intraday_guide'],
    daily_plan_items: ['asset_type', 'confirm_conditions', 'invalid_conditions', 'confidence'],
    watch_alerts: ['strategy_id', 'exec_status', 'instruction_json'],
    screen_runs: ['engine', 'horizon', 'diagnostics'],
    market_themes: ['phase', 'strength_history'],
    kol_accounts: ['enabled', 'sort_order', 'platform', 'red_id'],
    kol_posts: ['is_retweet', 'retweet_text', 'platform', 'title_only', 'images'],
    board_newhigh_snapshots: ['core_codes'],
    kline_daily: ['secid', 'adj_base', 'provisional'],
    research_modes: ['variant_count'],
    research_mode_backtests: ['protocol'],
    chat_sessions: ['ref_code', 'ref_name'],
    symbol_marks: ['semantic_key', 'timeframe', 'role', 'plan_id', 'plan_version', 'status'],
    symbol_trade_plans: [
      'market_phase',
      'primary_action',
      'candidate_model_version',
      'context_id',
      'trend_state',
      'chan_setup',
      'market_action',
      'changes',
      'levels',
      'scenarios',
      'risk',
      'exit_plan',
      'execution',
      'benchmarks',
      'asset_specific_risks',
      'evidence_version',
      'phase_model_version',
    ],
    symbol_trade_plan_events: ['plan_version', 'condition_id', 'note'],
    playbook_backtests: ['source', 'metrics', 'trades', 'equity', 'notes', 'spec'],
  };
  for (const [table, cols] of Object.entries(required)) {
    try {
      const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      const have = new Set(rows.map((r) => r.name));
      const missing = cols.filter((c) => !have.has(c));
      if (missing.length > 0) {
        console.warn(
          `[migrate] schema 漂移：表 ${table} 缺少列 [${missing.join(', ')}]。` +
            `schema.ts 改了字段但 migrate.ts 未补对应 ALTER，请同步更新 migrate.ts 的 addColumns。`,
        );
      }
    } catch (e) {
      console.warn(`[migrate] 校验表 ${table} 失败:`, e instanceof Error ? e.message : e);
    }
  }
}
