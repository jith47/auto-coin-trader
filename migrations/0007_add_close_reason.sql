-- Migration number: 0007 	 2025-12-31T10:00:00.000Z
ALTER TABLE trade_logs ADD COLUMN close_reason TEXT;
