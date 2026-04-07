-- Reset corrupted mock balance
UPDATE settings SET value = '2500.00' WHERE key = 'mock_balance_inr';

-- Mark corrupted trades as FAILED or similar to hide them from the dashboard stats
-- Anything with astronomical PnL > 100% or < -100% is likely rogue
UPDATE trade_logs 
SET status = 'FAILED', 
    reason = 'CORRUPTED_DATA_RESET',
    pnl = 0,
    pnl_inr = 0,
    exit_value_inr = 0
WHERE ABS(pnl) > 1000 OR ABS(pnl_inr) > 100000;

-- Reset one-time fix flag if needed (optional)
UPDATE settings SET value = 'true' WHERE key = 'balance_restored_mar_04';
