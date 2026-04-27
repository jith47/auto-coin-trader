-- Migration: Add closed_at column to trade_logs
ALTER TABLE trade_logs ADD COLUMN closed_at INTEGER;
