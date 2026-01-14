import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, "..", "trades.db");

class TradeDatabase {
    constructor() {
        this.db = new Database(DB_PATH);
        this.init();
    }

    init() {
        console.log("[DB] Initializing database...");

        // 1. Create migrations table if it doesn't exist
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS _migrations (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at INTEGER DEFAULT (unixepoch())
            )
        `);

        // 2. Get applied migrations
        const applied = new Set(
            this.db.prepare("SELECT name FROM _migrations").all().map(m => m.name)
        );

        // 3. Read migration files
        const migrationsDir = path.join(__dirname, "..", "migrations");
        const files = fs.readdirSync(migrationsDir)
            .filter(f => f.endsWith(".sql"))
            .sort();

        // 4. Apply new migrations
        for (const file of files) {
            if (!applied.has(file)) {
                console.log(`[DB] Applying migration: ${file}`);
                const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");

                // Execute migration in a transaction
                const transaction = this.db.transaction(() => {
                    this.db.exec(sql);
                    this.db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
                });
                transaction();
            }
        }

        console.log("[DB] Database initialization complete.");
    }

    // Helper to log a trade
    logTrade(data) {
        const stmt = this.db.prepare(`
            INSERT INTO trade_logs (
                timestamp, decision, reason, asset, price, quantity, 
                leverage, stop_loss, take_profit, raw_response, status, order_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        return stmt.run(
            Date.now(),
            data.decision,
            data.reason,
            data.asset || "B-DOGE_USDT",
            data.entry || 0,
            data.quantity || 0,
            data.leverage || 0,
            data.stopLoss || 0,
            data.takeProfit || 0,
            JSON.stringify(data),
            data.status || "OPEN",
            data.orderId || null
        );
    }

    // Update trade status
    updateTradeStatus(orderId, status, exitPrice = null, pnl = null, closeReason = null) {
        const stmt = this.db.prepare(`
            UPDATE trade_logs 
            SET status = ?, exit_price = ?, pnl = ?, close_reason = ? 
            WHERE order_id = ?
        `);
        return stmt.run(status, exitPrice, pnl, closeReason, orderId);
    }

    // Get active trade
    getActiveTrade() {
        return this.db.prepare("SELECT * FROM trade_logs WHERE status = 'OPEN' OR status = 'FILLED' LIMIT 1").get();
    }

    // Get recent trades
    getRecentTrades(limit = 10) {
        return this.db.prepare("SELECT * FROM trade_logs ORDER BY timestamp DESC LIMIT ?").all(limit);
    }
}

export const db = new TradeDatabase();
export default db;
