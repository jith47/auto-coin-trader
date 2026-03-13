export class D1Database {
    constructor(d1) {
        this.db = d1;
    }

    // ─── OI Snapshots ────────────────────────────────────────────────

    async saveOISnapshot(timestamp, symbol, openInterest, price) {
        return await this.db.prepare(
            'INSERT INTO oi_snapshots (timestamp, symbol, open_interest, price) VALUES (?, ?, ?, ?)'
        ).bind(timestamp, symbol, openInterest, price).run();
    }

    // Get OI snapshots for the last N minutes (oldest → newest)
    async getOISnapshots(symbol, minutes = 30) {
        const cutoff = Date.now() - (minutes * 60 * 1000);
        const { results } = await this.db.prepare(
            'SELECT * FROM oi_snapshots WHERE symbol = ? AND timestamp >= ? ORDER BY timestamp ASC'
        ).bind(symbol, cutoff).all();
        return results || [];
    }

    // Get the OI snapshot closest to N minutes ago
    async getOISnapshotAt(symbol, minutesAgo) {
        const target = Date.now() - (minutesAgo * 60 * 1000);
        return await this.db.prepare(
            'SELECT * FROM oi_snapshots WHERE symbol = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1'
        ).bind(symbol, target).first();
    }

    // Delete old OI snapshots (>2 hours)
    async cleanupOldOISnapshots() {
        const cutoff = Date.now() - (2 * 60 * 60 * 1000);
        return await this.db.prepare('DELETE FROM oi_snapshots WHERE timestamp < ?').bind(cutoff).run();
    }

    // ─── Tick Logging ────────────────────────────────────────────────

    // Log every tick's signal values (even when no trade fires)
    async logTick(data) {
        return await this.db.prepare(`
            INSERT INTO tick_logs (
                timestamp, symbol, price, open_interest,
                oi_change_1m, oi_change_5m, oi_change_15m,
                accumulation_score, oi_trend_consistency, oi_acceleration,
                absorption_ratio, price_compression,
                taker_ratio, top_trader_long, top_trader_delta, retail_long,
                funding_rate, atr_pct, volume_15m,
                direction, signal_fired, reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            Date.now(), data.symbol, data.price, data.openInterest,
            data.oiChange1m, data.oiChange5m, data.oiChange15m,
            data.accumulationScore, data.oiTrendConsistency, data.oiAcceleration,
            data.absorptionRatio, data.priceCompression,
            data.takerRatio, data.topTraderLong, data.topTraderDelta, data.retailLong,
            data.fundingRate, data.atrPct, data.volume15m,
            data.direction, data.signalFired ? 1 : 0, data.reason
        ).run();
    }

    // Get recent tick logs for dashboard display
    async getRecentTicks(symbol, limit = 30) {
        const { results } = await this.db.prepare(
            'SELECT * FROM tick_logs WHERE symbol = ? ORDER BY timestamp DESC LIMIT ?'
        ).bind(symbol, limit).all();
        return results || [];
    }

    // Cleanup old tick logs (keep last 24 hours)
    async cleanupOldTicks() {
        const cutoff = Date.now() - (24 * 60 * 60 * 1000);
        return await this.db.prepare('DELETE FROM tick_logs WHERE timestamp < ?').bind(cutoff).run();
    }

    // ─── Trade Logging ───────────────────────────────────────────────

    async logTrade(data) {
        return await this.db.prepare(`
            INSERT INTO trade_logs (
                timestamp, decision, reason, asset, price, quantity,
                leverage, stop_loss, take_profit, tp_levels, raw_response, status, order_id,
                entry_value_inr, atr_pct, supporting_modules, module_states, entry_time,
                oi_change_5m, oi_at_entry, top_trader_ratio, taker_ratio,
                accumulation_score, accumulation_duration_min, absorption_ratio_entry,
                price_compression_entry, signals_at_entry, symbol
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            Date.now(), data.decision, data.reason,
            data.asset || 'B-BTC_USDT', data.entry || 0, data.quantity || 0,
            data.leverage || 0, data.stopLoss || 0, data.takeProfit || 0,
            data.tpLevels ? JSON.stringify(data.tpLevels) : null,
            JSON.stringify(data), data.status || 'OPEN', data.orderId || null,
            data.entryValueInr || 0, data.atrPct || 0,
            data.supportingModules || 0, data.moduleStates || null,
            data.entryTime || Date.now(),
            data.oiChange5m || null, data.oiAtEntry || null,
            data.topTraderRatio || null, data.takerRatio || null,
            data.accumulationScore || null, data.accumulationDurationMin || null,
            data.absorptionRatio || null, data.priceCompression || null,
            data.signalsAtEntry || null, data.symbol || 'BTCUSDT'
        ).run();
    }

    // Update trade on close with exit analytics
    async updateTradeClose(orderId, status, exitPrice, pnl, closeReason, exitValueInr, pnlInr, holdTimeSec, exitAnalytics = {}) {
        return await this.db.prepare(`
            UPDATE trade_logs
            SET status = ?, exit_price = ?, pnl = ?, close_reason = ?,
                exit_value_inr = ?, pnl_inr = ?, hold_time_seconds = ?,
                oi_at_exit = ?, oi_deceleration_at_exit = ?, signals_at_exit = ?
            WHERE order_id = ?
        `).bind(
            status, exitPrice, pnl, closeReason, exitValueInr, pnlInr, holdTimeSec,
            exitAnalytics.oiAtExit || null,
            exitAnalytics.oiDeceleration || null,
            exitAnalytics.signalsAtExit || null,
            orderId
        ).run();
    }

    async updatePartialClose(orderId, partialPct) {
        return await this.db.prepare(
            'UPDATE trade_logs SET partial_closed_pct = ? WHERE order_id = ?'
        ).bind(partialPct, orderId).run();
    }

    async getActiveTrade() {
        return await this.db.prepare(
            "SELECT * FROM trade_logs WHERE status = 'OPEN' OR status = 'FILLED' ORDER BY timestamp DESC LIMIT 1"
        ).first();
    }

    async getRecentTrades(limit = 50) {
        const { results } = await this.db.prepare(
            'SELECT * FROM trade_logs ORDER BY timestamp DESC LIMIT ?'
        ).bind(limit).all();
        return results;
    }

    async getStats() {
        const stats = await this.db.prepare(`
            SELECT
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                SUM(pnl) as total_pnl,
                AVG(hold_time_seconds) as avg_hold_time
            FROM trade_logs WHERE status = 'CLOSED'
        `).first();
        const totalTrades = stats?.total_trades || 0;
        const wins = stats?.wins || 0;
        const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
        const currentBalance = await this.getMockBalance();
        const initialBalance = 25000; // CONFIG.INITIAL_INR_BALANCE
        const totalPnL = ((currentBalance - initialBalance) / initialBalance) * 100;

        return {
            totalTrades, winRate: parseFloat(winRate.toFixed(1)),
            totalPnL: parseFloat(totalPnL.toFixed(2)),
            avgHoldTime: stats?.avg_hold_time || 0,
            balance: currentBalance,
        };
    }

    async getTodayTradeCount() {
        const todayStart = this.getTodayStartMs();
        const result = await this.db.prepare(
            'SELECT COUNT(*) as count FROM trade_logs WHERE timestamp >= ?'
        ).bind(todayStart).first();
        return result?.count || 0;
    }

    async getTodayLossCount() {
        const todayStart = this.getTodayStartMs();
        const result = await this.db.prepare(
            "SELECT COUNT(*) as count FROM trade_logs WHERE timestamp >= ? AND status = 'CLOSED' AND pnl < 0"
        ).bind(todayStart).first();
        return result?.count || 0;
    }

    async getLastLossTime() {
        const result = await this.db.prepare(
            "SELECT timestamp FROM trade_logs WHERE status = 'CLOSED' AND pnl < 0 ORDER BY timestamp DESC LIMIT 1"
        ).first();
        return result?.timestamp || null;
    }

    getTodayStartMs() {
        const now = new Date();
        return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    }

    // ─── Mock Balance ────────────────────────────────────────────────

    async getMockBalance() {
        const result = await this.db.prepare(
            "SELECT value FROM settings WHERE key = 'mock_balance_inr'"
        ).first();
        return parseFloat(result?.value || '25000');
    }

    async updateMockBalance(newBalance) {
        return await this.db.prepare(
            "UPDATE settings SET value = ? WHERE key = 'mock_balance_inr'"
        ).bind(newBalance.toFixed(2)).run();
    }

    // ─── Settings ────────────────────────────────────────────────────

    async getSetting(key, defaultValue = null) {
        const result = await this.db.prepare(
            'SELECT value FROM settings WHERE key = ?'
        ).bind(key).first();
        return result?.value || defaultValue;
    }

    async updateSetting(key, value) {
        const existing = await this.getSetting(key);
        if (existing !== null) {
            return await this.db.prepare(
                'UPDATE settings SET value = ? WHERE key = ?'
            ).bind(value.toString(), key).run();
        } else {
            return await this.db.prepare(
                'INSERT INTO settings (key, value) VALUES (?, ?)'
            ).bind(key, value.toString()).run();
        }
    }
}
