-- Migration 0013: Final Spec V2.0 alignment

-- 1. Create signal_log table for Signal Mode hypothetical trades
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

-- 2. Create daily_stats table
CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY,
  trades_taken INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  total_pnl_inr REAL DEFAULT 0,
  peak_balance REAL DEFAULT 0,
  mock_balance REAL DEFAULT 0
);

-- 3. Update tick_logs with analytical and gate columns
ALTER TABLE tick_logs ADD COLUMN tick_oi_consistency REAL;
ALTER TABLE tick_logs ADD COLUMN tick_oi_acceleration REAL;
ALTER TABLE tick_logs ADD COLUMN tick_absorption REAL;
ALTER TABLE tick_logs ADD COLUMN tick_compression REAL;
ALTER TABLE tick_logs ADD COLUMN top_trader_delta REAL;
ALTER TABLE tick_logs ADD COLUMN retail_long_pct REAL;
ALTER TABLE tick_logs ADD COLUMN price_slope REAL;
ALTER TABLE tick_logs ADD COLUMN volume_ratio REAL;
ALTER TABLE tick_logs ADD COLUMN funding_rate REAL;
ALTER TABLE tick_logs ADD COLUMN phase TEXT;
ALTER TABLE tick_logs ADD COLUMN minutes_accumulating INTEGER;
ALTER TABLE tick_logs ADD COLUMN cross_asset_status TEXT;
ALTER TABLE tick_logs ADD COLUMN trade_action TEXT;
ALTER TABLE tick_logs ADD COLUMN block_reason TEXT;

-- 4. Add Logged-Not-Enforced filter indicators to tick_logs
ALTER TABLE tick_logs ADD COLUMN would_exhaustion_block INTEGER DEFAULT 0;
ALTER TABLE tick_logs ADD COLUMN would_vol_regime_block INTEGER DEFAULT 0;
ALTER TABLE tick_logs ADD COLUMN would_oi_stagnation_block INTEGER DEFAULT 0;
ALTER TABLE tick_logs ADD COLUMN would_strict_cross_asset_block INTEGER DEFAULT 0;
ALTER TABLE tick_logs ADD COLUMN would_score_60_block INTEGER DEFAULT 0;
ALTER TABLE tick_logs ADD COLUMN would_duration_10_block INTEGER DEFAULT 0;

-- 5. Update trade_logs (the 'trades' table in the spec) with extra fields
ALTER TABLE trade_logs ADD COLUMN cross_asset_status_at_entry TEXT;
ALTER TABLE trade_logs ADD COLUMN acc_score_at_entry REAL;
ALTER TABLE trade_logs ADD COLUMN acc_duration_at_entry INTEGER;
ALTER TABLE trade_logs ADD COLUMN absorption_at_entry REAL;
ALTER TABLE trade_logs ADD COLUMN compression_at_entry REAL;
ALTER TABLE trade_logs ADD COLUMN direction_signals_at_entry TEXT;
ALTER TABLE trade_logs ADD COLUMN hold_time_minutes REAL;
