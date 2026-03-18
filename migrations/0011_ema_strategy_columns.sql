-- Migration: 0011 — Schema for EMA Scalper strategy
-- Adds columns needed by the new strategy, safely using ALTER TABLE with IF NOT EXISTS logic.

-- Add new columns to trade_logs (SQLite doesn't support IF NOT EXISTS on ALTER TABLE,
-- so these will fail silently if columns already exist in D1)

-- trail_points: ATR * trail multiplier for trailing stop
ALTER TABLE trade_logs ADD COLUMN trail_points REAL DEFAULT 0;

-- atr: ATR value at entry time
ALTER TABLE trade_logs ADD COLUMN atr REAL DEFAULT 0;

-- entry_value_usd: position value in USD
ALTER TABLE trade_logs ADD COLUMN entry_value_usd REAL DEFAULT 0;

-- pnl_usd: realized PnL in USD
ALTER TABLE trade_logs ADD COLUMN pnl_usd REAL DEFAULT 0;

-- Ensure settings table exists (for mock balance, peak prices, bars-in-trade)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Initialize mock balance if not present
INSERT OR IGNORE INTO settings (key, value) VALUES ('mock_balance_usd', '100000');
