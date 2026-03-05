-- Migration number: 0010 	 2026-03-04T16:00:00.000Z
-- Microstructure Scalper v1.0 columns

ALTER TABLE trade_logs ADD COLUMN atr_pct REAL;
ALTER TABLE trade_logs ADD COLUMN supporting_modules INTEGER;
ALTER TABLE trade_logs ADD COLUMN module_states TEXT;
ALTER TABLE trade_logs ADD COLUMN entry_time INTEGER;
ALTER TABLE trade_logs ADD COLUMN hold_time_seconds INTEGER;
ALTER TABLE trade_logs ADD COLUMN partial_closed_pct REAL DEFAULT 0;
