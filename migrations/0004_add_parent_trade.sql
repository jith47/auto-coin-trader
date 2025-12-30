-- Add parent_trade_id column to link exit trades to their entry trades
ALTER TABLE trade_logs ADD COLUMN parent_trade_id INTEGER;

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_parent_trade_id ON trade_logs(parent_trade_id);
