-- Migration: Add tp_levels column to trade_logs
ALTER TABLE trade_logs ADD COLUMN tp_levels TEXT;
