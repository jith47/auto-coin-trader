export class D1Database {
    constructor(d1) {
        this.db = d1;
    }

    async init() {
        // D1 migrations are handled by Wrangler, but we can ensure tables exist if needed
        // For now, we assume schema is managed via migrations
        console.log("[DB] D1 initialized");
    }

    // Helper to log a trade
    async logTrade(data) {
        const stmt = this.db.prepare(`
            INSERT INTO trade_logs (
                timestamp, decision, reason, asset, price, quantity, 
                leverage, stop_loss, take_profit, raw_response, status, order_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        return await stmt.bind(
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
        ).run();
    }

    // Update trade status
    async updateTradeStatus(orderId, status, exitPrice = null, pnl = null, closeReason = null) {
        const stmt = this.db.prepare(`
            UPDATE trade_logs 
            SET status = ?, exit_price = ?, pnl = ?, close_reason = ? 
            WHERE order_id = ?
        `);
        return await stmt.bind(status, exitPrice, pnl, closeReason, orderId).run();
    }

    // Get active trade
    async getActiveTrade() {
        return await this.db.prepare("SELECT * FROM trade_logs WHERE status = 'OPEN' OR status = 'FILLED' LIMIT 1").first();
    }

    // Get recent trades
    async getRecentTrades(limit = 10) {
        const { results } = await this.db.prepare("SELECT * FROM trade_logs ORDER BY timestamp DESC LIMIT ?").bind(limit).all();
        return results;
    }

    // Get overall stats
    async getStats() {
        const stats = await this.db.prepare(`
            SELECT 
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                SUM(pnl) as total_pnl
            FROM trade_logs 
            WHERE status = 'CLOSED'
        `).first();

        const totalTrades = stats.total_trades || 0;
        const wins = stats.wins || 0;
        const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

        return {
            totalTrades,
            winRate,
            totalPnL: stats.total_pnl || 0
        };
    }
}
