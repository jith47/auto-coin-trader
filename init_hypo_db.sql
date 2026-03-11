-- Full Schema Initialization for Crypto Autobot (Hypothetical Mode)

-- 1. Settings Table
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('mock_balance_inr', '25000');

-- 2. OI Snapshots Table
CREATE TABLE IF NOT EXISTS oi_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    open_interest REAL NOT NULL,
    price REAL NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_oi_snapshots_timestamp ON oi_snapshots(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_oi_symbol_ts ON oi_snapshots(symbol, timestamp DESC);

-- 3. Tick Logs Table (Full Spec)
CREATE TABLE IF NOT EXISTS tick_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    price REAL NOT NULL,
    open_interest REAL,
    oi_change_1m REAL,
    oi_change_5m REAL,
    oi_change_15m REAL,
    accumulation_score REAL,
    tick_oi_consistency REAL,
    tick_oi_acceleration REAL,
    tick_absorption REAL,
    tick_compression REAL,
    direction TEXT,
    taker_ratio REAL,
    top_trader_delta REAL,
    retail_long_pct REAL,
    price_slope REAL,
    funding_rate REAL,
    atr_pct REAL,
    volume_ratio REAL,
    phase TEXT,
    minutes_accumulating INTEGER,
    cross_asset_status TEXT,
    trade_action TEXT,
    block_reason TEXT,
    would_exhaustion_block INTEGER DEFAULT 0,
    would_vol_regime_block INTEGER DEFAULT 0,
    would_oi_stagnation_block INTEGER DEFAULT 0,
    would_strict_cross_asset_block INTEGER DEFAULT 0,
    would_score_60_block INTEGER DEFAULT 0,
    would_duration_10_block INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_tick_logs_ts ON tick_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tick_logs_symbol ON tick_logs(symbol, timestamp DESC);

-- 4. Trades Table (Authoritative)
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  symbol TEXT,
  direction TEXT,
  entry_price REAL,
  exit_price REAL,
  entry_time INTEGER,
  exit_time INTEGER,
  quantity REAL,
  leverage REAL,
  sl_price REAL,
  tp_price REAL,
  pnl_inr REAL,
  exit_reason TEXT,
  acc_score_at_entry REAL,
  acc_duration_at_entry INTEGER,
  oi_at_entry REAL,
  oi_at_exit REAL,
  cross_asset_status_at_entry TEXT,
  direction_signals_at_entry TEXT,
  partial_tp_hit INTEGER DEFAULT 0,
  hold_time_minutes REAL,
  status TEXT DEFAULT 'OPEN',
  created_at INTEGER DEFAULT (unixepoch())
);

-- 5. Signal Log Table (Hypothetical Mode)
CREATE TABLE IF NOT EXISTS signal_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  accumulation_score REAL,
  minutes_accumulating INTEGER,
  cross_asset_status TEXT,
  entry_price REAL,
  hypothetical_tp REAL,
  hypothetical_sl REAL,
  price_after_15m REAL,
  price_after_30m REAL,
  price_after_45m REAL,
  outcome TEXT,
  filters_that_would_have_blocked TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

-- 6. Daily Stats Table
CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY,
  trades_taken INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  total_pnl_inr REAL DEFAULT 0,
  peak_balance REAL DEFAULT 0,
  mock_balance REAL DEFAULT 0
);
