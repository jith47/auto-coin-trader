-- Migration number: 0012    2026-03-08T13:36:00.000Z
-- OI Flow Rider v2.0 — Tick logging, multi-asset OI, per-trade analytics

-- Tick-level signal log (every cron tick, even when no trade fires)
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
    oi_trend_consistency REAL,
    oi_acceleration REAL,
    absorption_ratio REAL,
    price_compression REAL,
    taker_ratio REAL,
    top_trader_long REAL,
    top_trader_delta REAL,
    retail_long REAL,
    funding_rate REAL,
    atr_pct REAL,
    volume_15m REAL,
    direction TEXT,
    signal_fired INTEGER DEFAULT 0,
    reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_tick_logs_ts ON tick_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tick_logs_symbol ON tick_logs(symbol, timestamp DESC);

-- Add symbol column to oi_snapshots for multi-asset
-- (already has symbol column from v1, but ensure index)
CREATE INDEX IF NOT EXISTS idx_oi_symbol_ts ON oi_snapshots(symbol, timestamp DESC);

-- Per-trade analytics columns
ALTER TABLE trade_logs ADD COLUMN accumulation_score REAL;
ALTER TABLE trade_logs ADD COLUMN accumulation_duration_min REAL;
ALTER TABLE trade_logs ADD COLUMN absorption_ratio_entry REAL;
ALTER TABLE trade_logs ADD COLUMN price_compression_entry REAL;
ALTER TABLE trade_logs ADD COLUMN oi_at_exit REAL;
ALTER TABLE trade_logs ADD COLUMN oi_deceleration_at_exit REAL;
ALTER TABLE trade_logs ADD COLUMN signals_at_entry TEXT;
ALTER TABLE trade_logs ADD COLUMN signals_at_exit TEXT;
ALTER TABLE trade_logs ADD COLUMN symbol TEXT DEFAULT 'BTCUSDT';
