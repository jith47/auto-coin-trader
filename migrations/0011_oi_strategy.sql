-- Migration number: 0011    2026-03-07T20:55:00.000Z
-- OI Flow Rider Strategy — OI snapshot tracking & trade enrichment

-- OI snapshot table for tracking institutional flow
CREATE TABLE IF NOT EXISTS oi_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    symbol TEXT NOT NULL DEFAULT 'DOGEUSDT',
    open_interest REAL NOT NULL,
    price REAL NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
);

-- Index for fast lookups by time range
CREATE INDEX IF NOT EXISTS idx_oi_snapshots_timestamp ON oi_snapshots(timestamp DESC);

-- Add OI-related columns to trade_logs for post-trade analysis
ALTER TABLE trade_logs ADD COLUMN oi_change_5m REAL;
ALTER TABLE trade_logs ADD COLUMN oi_at_entry REAL;
ALTER TABLE trade_logs ADD COLUMN top_trader_ratio REAL;
ALTER TABLE trade_logs ADD COLUMN taker_ratio REAL;
