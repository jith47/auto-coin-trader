-- Migration number: 0001 	 2025-12-24T22:55:00.000Z
CREATE TABLE IF NOT EXISTS trade_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    asset TEXT,
    price REAL,
    quantity REAL,
    leverage REAL,
    stop_loss REAL,
    take_profit REAL,
    status TEXT DEFAULT 'OPEN',
    exit_price REAL,
    pnl REAL,
    raw_response TEXT,
    created_at INTEGER DEFAULT (unixepoch())
);
