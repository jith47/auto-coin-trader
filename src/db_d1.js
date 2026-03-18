export class D1Database {
    constructor(d1) {
        this.db = d1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Trade Logging
    // ─────────────────────────────────────────────────────────────────────────

    async logTrade(data) {
        const stmt = this.db.prepare(`
            INSERT INTO trade_logs (
                timestamp, decision, reason, asset, price, quantity,
                stop_loss, take_profit, trail_points, atr,
                entry_value_usd, status, order_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        return await stmt.bind(
            Date.now(),
            data.decision,
            data.reason,
            data.asset || 'BTCUSDT',
            data.entry || 0,
            data.quantity || 0,
            data.stopLoss || 0,
            data.takeProfit || 0,
            data.trailPoints || 0,
            data.atr || 0,
            data.entryValueUsd || 0,
            'OPEN',
            data.orderId || null,
        ).run();
    }

    async updateTradeStatus(orderId, status, exitPrice = null, pnlPct = null, closeReason = null, pnlUsd = null) {
        return await this.db.prepare(`
            UPDATE trade_logs
            SET status = ?, exit_price = ?, pnl = ?, close_reason = ?, pnl_usd = ?
            WHERE order_id = ?
        `).bind(status, exitPrice, pnlPct, closeReason, pnlUsd, orderId).run();
    }

    async getActiveTrade() {
        const trade = await this.db.prepare(
            "SELECT * FROM trade_logs WHERE status = 'OPEN' ORDER BY timestamp DESC LIMIT 1"
        ).first();
        if (!trade) return null;
        // Attach peak price from settings if available
        const peak = await this.getSetting(`peak_${trade.order_id}`);
        if (peak) trade.peak_price = parseFloat(peak);
        return trade;
    }

    async getRecentTrades(limit = 20) {
        const { results } = await this.db.prepare(
            'SELECT * FROM trade_logs ORDER BY timestamp DESC LIMIT ?'
        ).bind(limit).all();
        return results;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Stats
    // ─────────────────────────────────────────────────────────────────────────

    async getStats() {
        const stats = await this.db.prepare(`
            SELECT
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
                SUM(pnl_usd) as total_pnl_usd,
                AVG(pnl) as avg_pnl_pct
            FROM trade_logs
            WHERE status = 'CLOSED'
        `).first();

        const balance = await this.getMockBalance();
        const totalTrades = stats?.total_trades || 0;
        const wins = stats?.wins || 0;
        const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

        return {
            totalTrades,
            wins,
            losses: stats?.losses || 0,
            winRate: parseFloat(winRate.toFixed(1)),
            totalPnlUsd: parseFloat((stats?.total_pnl_usd || 0).toFixed(2)),
            avgPnlPct: parseFloat((stats?.avg_pnl_pct || 0).toFixed(3)),
            balance: parseFloat(balance.toFixed(2)),
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mock Balance
    // ─────────────────────────────────────────────────────────────────────────

    async getMockBalance() {
        const result = await this.db.prepare(
            "SELECT value FROM settings WHERE key = 'mock_balance_usd'"
        ).first();
        return parseFloat(result?.value || '100000');
    }

    async updateMockBalance(newBalance) {
        // Upsert pattern
        const existing = await this.db.prepare(
            "SELECT value FROM settings WHERE key = 'mock_balance_usd'"
        ).first();
        if (existing) {
            return await this.db.prepare(
                "UPDATE settings SET value = ? WHERE key = 'mock_balance_usd'"
            ).bind(newBalance.toFixed(2)).run();
        } else {
            return await this.db.prepare(
                "INSERT INTO settings (key, value) VALUES ('mock_balance_usd', ?)"
            ).bind(newBalance.toFixed(2)).run();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Bars-in-trade counter (for time stop)
    // ─────────────────────────────────────────────────────────────────────────

    async getBarsInTrade(orderId) {
        const val = await this.getSetting(`bars_${orderId}`);
        return parseInt(val || '0');
    }

    async updateBarsInTrade(orderId, bars) {
        return await this.updateSetting(`bars_${orderId}`, bars);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Generic Settings (key-value store)
    // ─────────────────────────────────────────────────────────────────────────

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

    async deleteSetting(key) {
        return await this.db.prepare(
            "DELETE FROM settings WHERE key = ?"
        ).bind(key).run();
    }
}
