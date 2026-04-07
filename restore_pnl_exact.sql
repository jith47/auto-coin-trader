
-- Restore balance to the final simulated value
UPDATE settings SET value = '4893.35' WHERE key = 'mock_balance_inr';

-- Restore Trade 38
UPDATE trade_logs SET status = 'CLOSED', exit_price = 0.103027, pnl = 11.25, pnl_inr = 179.17, exit_value_inr = 13848.60, close_reason = 'Take profit hit', reason = 'RESTORED_CORRECT_DATA' WHERE id = 38;

-- Restore Trade 39
UPDATE trade_logs SET status = 'CLOSED', exit_price = 0.10317, pnl = 11.25, pnl_inr = 192.00, exit_value_inr = 2101.82, close_reason = 'Take profit hit', reason = 'RESTORED_CORRECT_DATA' WHERE id = 39;

-- Restore Trade 40
UPDATE trade_logs SET status = 'CLOSED', exit_price = 0.102986, pnl = 11.25, pnl_inr = 205.76, exit_value_inr = 2259.61, close_reason = 'Take profit hit', reason = 'RESTORED_CORRECT_DATA' WHERE id = 40;

-- Restore Trade 41
UPDATE trade_logs SET status = 'CLOSED', exit_price = 0.102823, pnl = 11.25, pnl_inr = 220.57, exit_value_inr = 2424.82, close_reason = 'Take profit hit', reason = 'RESTORED_CORRECT_DATA' WHERE id = 41;

-- Restore Trade 42
UPDATE trade_logs SET status = 'CLOSED', exit_price = 0.102639, pnl = 11.25, pnl_inr = 236.39, exit_value_inr = 2603.11, close_reason = 'Take profit hit', reason = 'RESTORED_CORRECT_DATA' WHERE id = 42;

-- Restore Trade 43
UPDATE trade_logs SET status = 'CLOSED', exit_price = 0.102219, pnl = 11.25, pnl_inr = 253.24, exit_value_inr = 2800.00, close_reason = 'Take profit hit', reason = 'RESTORED_CORRECT_DATA' WHERE id = 43;

-- Restore Trade 44
UPDATE trade_logs SET status = 'CLOSED', exit_price = 0.10221, pnl = 11.31, pnl_inr = 272.90, exit_value_inr = 2923.89, close_reason = 'Take profit hit', reason = 'RESTORED_CORRECT_DATA' WHERE id = 44;

-- Restore Trade 45
UPDATE trade_logs SET status = 'CLOSED', exit_price = 0.10232, pnl = 11.29, pnl_inr = 292.21, exit_value_inr = 3134.23, close_reason = 'Take profit hit', reason = 'RESTORED_CORRECT_DATA' WHERE id = 45;

-- Restore Trade 46
UPDATE trade_logs SET status = 'CLOSED', exit_price = 0.10214, pnl = 11.26, pnl_inr = 312.31, exit_value_inr = 3371.91, close_reason = 'Take profit hit', reason = 'RESTORED_CORRECT_DATA' WHERE id = 46;

-- Restore Trade 47
UPDATE trade_logs SET status = 'CLOSED', exit_price = 0.10228, pnl = 11.30, pnl_inr = 335.87, exit_value_inr = 3630.95, close_reason = 'Take profit hit', reason = 'RESTORED_CORRECT_DATA' WHERE id = 47;

-- Restore Trade 48
UPDATE trade_logs SET status = 'CLOSED', exit_price = 74742.45, pnl = 2.00, pnl_inr = 35.03, exit_value_inr = 17535, close_reason = 'MOCK_SL_HIT', reason = 'RESTORED_CORRECT_DATA' WHERE id = 48;

-- Restore Trade 49
UPDATE trade_logs SET status = 'CLOSED', exit_price = 2330.27, pnl = 1.16, pnl_inr = 26.67, exit_value_inr = 7080, close_reason = 'Take profit hit', reason = 'RESTORED_CORRECT_DATA' WHERE id = 49;

-- Restore Trade 50
UPDATE trade_logs SET status = 'CLOSED', exit_price = 2308.2, pnl = -0.53, pnl_inr = -18.30, exit_value_inr = 0, close_reason = 'MOCK_SL_HIT', reason = 'RESTORED_CORRECT_DATA' WHERE id = 50;

-- Restore Trade 51
UPDATE trade_logs SET status = 'CLOSED', exit_price = 74083.6, pnl = -0.70, pnl_inr = -38.63, exit_value_inr = 0, close_reason = 'MOCK_SL_HIT', reason = 'RESTORED_CORRECT_DATA' WHERE id = 51;

-- Restore Trade 52
UPDATE trade_logs SET status = 'CLOSED', exit_price = 2323.35, pnl = -0.90, pnl_inr = -52.44, exit_value_inr = 0, close_reason = 'MOCK_SL_HIT', reason = 'RESTORED_CORRECT_DATA' WHERE id = 52;

-- Restore Trade 53
UPDATE trade_logs SET status = 'CLOSED', exit_price = 2330.44, pnl = -0.90, pnl_inr = -51.88, exit_value_inr = 0, close_reason = 'MOCK_SL_HIT', reason = 'RESTORED_CORRECT_DATA' WHERE id = 53;
