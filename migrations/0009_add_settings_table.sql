-- Migration number: 0009 	 2026-02-25T14:21:00.000Z
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('mock_balance_inr', '2500');

-- These might fail if already exists, so we run them individually if needed
-- But putting them here for completeness
ALTER TABLE trade_logs ADD COLUMN entry_value_inr REAL;
ALTER TABLE trade_logs ADD COLUMN exit_value_inr REAL;
ALTER TABLE trade_logs ADD COLUMN pnl_inr REAL;
