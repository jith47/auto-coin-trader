export class D1Database {
    constructor(d1) {
        this.db = d1;
    }

    // Log a trade
    async logTrade(data) {
        const stmt = this.db.prepare(`
            INSERT INTO trade_logs (
                timestamp, decision, reason, asset, price, quantity,
                leverage, stop_loss, take_profit, tp_levels, raw_response, status, order_id,
                entry_value_inr, atr_pct, supporting_modules, module_states, entry_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        return await stmt.bind(
            Date.now(),
            data.decision,
            data.reason,
            data.asset || 'B-DOGE_USDT',
            data.entry || 0,
            data.quantity || 0,
            data.leverage || 0,
            data.stopLoss || 0,
            data.takeProfit || 0,
            data.tpLevels ? JSON.stringify(data.tpLevels) : null,
            JSON.stringify(data),
            data.status || 'OPEN',
            data.orderId || null,
            data.entryValueInr || 0,
            data.atrPct || 0,
            data.supportingModules || 0,
            data.moduleStates || null,
            data.entryTime || Date.now()
        ).run();
    }

    // Update trade status on close
    async updateTradeStatus(orderId, status, exitPrice = null, pnl = null, closeReason = null, exitValueInr = null, pnlInr = null, holdTimeSec = null) {
        const stmt = this.db.prepare(`
            UPDATE trade_logs
            SET status = ?, exit_price = ?, pnl = ?, close_reason = ?,
                exit_value_inr = ?, pnl_inr = ?, hold_time_seconds = ?
            WHERE order_id = ?
        `);
        return await stmt.bind(status, exitPrice, pnl, closeReason, exitValueInr, pnlInr, holdTimeSec, orderId).run();
    }

    // Update TP levels status
    async updateTPLevels(orderId, tpLevels) {
        const stmt = this.db.prepare(`
            UPDATE trade_logs SET tp_levels = ? WHERE order_id = ?
        `);
        return await stmt.bind(JSON.stringify(tpLevels), orderId).run();
    }

    // Update partial close percentage
    async updatePartialClose(orderId, partialPct) {
        const stmt = this.db.prepare(`
            UPDATE trade_logs SET partial_closed_pct = ? WHERE order_id = ?
        `);
        return await stmt.bind(partialPct, orderId).run();
    }

    // Get active trade
    async getActiveTrade() {
        return await this.db.prepare(
            "SELECT * FROM trade_logs WHERE status = 'OPEN' OR status = 'FILLED' ORDER BY timestamp DESC LIMIT 1"
        ).first();
    }

    // Get recent trades
    async getRecentTrades(limit = 10) {
        const { results } = await this.db.prepare(
            'SELECT * FROM trade_logs ORDER BY timestamp DESC LIMIT ?'
        ).bind(limit).all();
        return results;
    }

    // Get overall stats
    async getStats() {
        const stats = await this.db.prepare(`
            SELECT
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                SUM(pnl) as total_pnl,
                AVG(hold_time_seconds) as avg_hold_time
            FROM trade_logs
            WHERE status = 'CLOSED'
        `).first();

        const totalTrades = stats?.total_trades || 0;
        const wins = stats?.wins || 0;
        const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
        const currentBalance = await this.getMockBalance();

        return {
            totalTrades,
            winRate: parseFloat(winRate.toFixed(1)),
            totalPnL: stats?.total_pnl || 0,
            avgHoldTime: stats?.avg_hold_time || 0,
            balance: currentBalance,
        };
    }

    // Get today's trade count (UTC day)
    async getTodayTradeCount() {
        const todayStart = this.getTodayStartMs();
        const result = await this.db.prepare(
            'SELECT COUNT(*) as count FROM trade_logs WHERE timestamp >= ?'
        ).bind(todayStart).first();
        return result?.count || 0;
    }

    // Get today's loss count
    async getTodayLossCount() {
        const todayStart = this.getTodayStartMs();
        const result = await this.db.prepare(
            "SELECT COUNT(*) as count FROM trade_logs WHERE timestamp >= ? AND status = 'CLOSED' AND pnl < 0"
        ).bind(todayStart).first();
        return result?.count || 0;
    }

    // Get last loss timestamp
    async getLastLossTime() {
        const result = await this.db.prepare(
            "SELECT timestamp FROM trade_logs WHERE status = 'CLOSED' AND pnl < 0 ORDER BY timestamp DESC LIMIT 1"
        ).first();
        return result?.timestamp || null;
    }

    // Helper: get today's start timestamp in ms (UTC midnight)
    getTodayStartMs() {
        const now = new Date();
        return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    }

    // Mock Balance Management
    async getMockBalance() {
        const result = await this.db.prepare(
            "SELECT value FROM settings WHERE key = 'mock_balance_inr'"
        ).first();
        return parseFloat(result?.value || '2500');
    }

    async updateMockBalance(newBalance) {
        return await this.db.prepare(
            "UPDATE settings SET value = ? WHERE key = 'mock_balance_inr'"
        ).bind(newBalance.toFixed(2)).run();
    }

    // Generic Setting Management
    async getSetting(key, defaultValue = null) {
        const result = await this.db.prepare(
            "SELECT value FROM settings WHERE key = ?"
        ).bind(key).first();
        return result?.value || defaultValue;
    }

    async updateSetting(key, value) {
        const existing = await this.getSetting(key);
        if (existing !== null) {
            return await this.db.prepare(
                "UPDATE settings SET value = ? WHERE key = ?"
            ).bind(value.toString(), key).run();
        } else {
            return await this.db.prepare(
                "INSERT INTO settings (key, value) VALUES (?, ?)"
            ).bind(key, value.toString()).run();
        }
    }
}
