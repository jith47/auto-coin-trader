-- Migration number: 0006 	 2025-12-30T17:00:00.000Z
CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_logs_order_id ON trade_logs(order_id);
