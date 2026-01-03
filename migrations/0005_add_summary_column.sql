-- Migration: Add summary column to trade_logs
ALTER TABLE trade_logs ADD COLUMN summary TEXT;
