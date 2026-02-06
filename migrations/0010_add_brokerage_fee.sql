-- Migration: Add brokerage_fee column to trade_logs
ALTER TABLE trade_logs ADD COLUMN brokerage_fee REAL DEFAULT 0;
