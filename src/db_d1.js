export class D1Database {
    constructor(d1) {
        this.db = d1;
    }

    // ─── OI Snapshots ────────────────────────────────────────────────

    async saveOISnapshot(timestamp, symbol, openInterest, price) {
        try {
            return await this.db.prepare(
                'INSERT INTO oi_snapshots (timestamp, symbol, open_interest, price) VALUES (?, ?, ?, ?)'
            ).bind(
                timestamp || Date.now(),
                symbol || 'UNKNOWN',
                openInterest || 0,
                price || 0
            ).run();
        } catch (err) {
            console.error('[DB ERROR] saveOISnapshot failed:', err.message);
            throw err;
        }
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

    // Delete old OI snapshots (>7 days)
    async cleanupOldOISnapshots() {
        const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 days
        return await this.db.prepare('DELETE FROM oi_snapshots WHERE timestamp < ?').bind(cutoff).run();
    }

    // ─── Tick Logging ────────────────────────────────────────────────

    // Log every tick's signal values (even when no trade fires)
    async logTick(data) {
        // console.log('[DB] Logging Tick:', JSON.stringify(data));
        try {
            return await this.db.prepare(`
                INSERT INTO tick_logs (
                    timestamp, symbol, price, open_interest,
                    oi_change_1m, oi_change_5m, oi_change_15m,
                    accumulation_score, tick_oi_consistency, tick_oi_acceleration,
                    tick_absorption, tick_compression,
                    direction, taker_ratio, top_trader_delta, retail_long_pct,
                    price_slope, funding_rate, atr_pct, volume_ratio,
                    phase, minutes_accumulating, cross_asset_status,
                    trade_action, block_reason,
                    would_exhaustion_block, would_vol_regime_block, would_oi_stagnation_block,
                    would_strict_cross_asset_block, would_score_60_block, would_duration_10_block
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
                Date.now(),
                data.symbol || 'UNKNOWN',
                data.price || 0,
                data.openInterest || 0,
                data.oi_change_1m || 0,
                data.oi_change_5m || 0,
                data.oi_change_15m || 0,
                data.accumulationScore || 0,
                data.tick_oi_consistency || 0,
                data.tick_oi_acceleration || 0,
                data.tick_absorption || 0,
                data.tick_compression || 0,
                data.direction || 'UNCLEAR',
                data.taker_ratio || 0,
                data.top_trader_delta || 0,
                data.retail_long_pct || 0,
                data.price_slope || 0,
                data.funding_rate || 0,
                data.atr_pct || 0,
                data.volume_ratio || 0,
                data.phase || null,
                data.minutesAccumulating || 0,
                data.cross_asset_status || data.crossAssetStatus || null,
                data.tradeAction || data.trade_action || null,
                data.blockReason || data.block_reason || null,
                data.would_exhaustion_block || 0,
                data.would_vol_regime_block || 0,
                data.would_oi_stagnation_block || 0,
                data.would_strict_cross_asset_block || 0,
                data.would_score_60_block || 0,
                data.would_duration_10_block || 0
            ).run();
        } catch (err) {
            console.error('[DB ERROR] logTick failed:', err.message, '| Data:', JSON.stringify(data));
            throw err;
        }
    }

    // Get recent tick logs for dashboard display
    async getRecentTicks(symbol, limit = 30) {
        const { results } = await this.db.prepare(
            'SELECT * FROM tick_logs WHERE symbol = ? ORDER BY timestamp DESC LIMIT ?'
        ).bind(symbol, limit).all();
        return results || [];
    }

    // Cleanup old tick logs (keep last 30 days for historical analysis)
    async cleanupOldTicks() {
        const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000); // 30 days
        return await this.db.prepare('DELETE FROM tick_logs WHERE timestamp < ?').bind(cutoff).run();
    }

    // ─── Authoritative Trade Tracking (Restored Spec) ────────────────

    async logTrade(data) {
        return await this.db.prepare(`
            INSERT INTO trades (
                id, symbol, direction, entry_price, quantity,
                leverage, sl_price, tp_price, status, entry_time,
                acc_score_at_entry, acc_duration_at_entry, oi_at_entry,
                cross_asset_status_at_entry, direction_signals_at_entry
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            data.orderId || data.id, data.symbol, data.decision || data.direction, data.entry || data.entryPrice || 0, data.quantity || 0,
            data.leverage || 1, data.stopLoss || data.slPrice || 0, data.takeProfit || data.tpPrice || 0, data.status || 'OPEN', Date.now(),
            data.accScoreAtEntry || 0, data.accDurationAtEntry || 0, data.oiAtEntry || 0,
            data.crossAssetStatusAtEntry || null, data.directionSignalsAtEntry || null
        ).run();
    }

    async updateTradeClose(orderId, exitPrice, pnlInr, reason, analytics = {}) {
        return await this.db.prepare(`
            UPDATE trades
            SET status = 'CLOSED', exit_price = ?, pnl_inr = ?, exit_reason = ?,
                exit_time = ?, oi_at_exit = ?, hold_time_minutes = ?
            WHERE id = ?
        `).bind(
            exitPrice || 0, pnlInr || 0, reason || 'UNKNOWN', Date.now(),
            analytics.oiAtExit || 0,
            parseFloat(analytics.holdTimeMinutes) || 0,
            orderId
        ).run();
    }

    async getActiveTrade(symbol) {
        return await this.db.prepare(
            "SELECT * FROM trades WHERE symbol = ? AND status = 'OPEN' ORDER BY entry_time DESC LIMIT 1"
        ).bind(symbol).first();
    }

    async updatePartialTP(orderId) {
        return await this.db.prepare(
            "UPDATE trades SET partial_tp_hit = 1 WHERE id = ?"
        ).bind(orderId).run();
    }

    async updateStopLoss(orderId, newSL) {
        return await this.db.prepare(
            "UPDATE trades SET sl_price = ? WHERE id = ?"
        ).bind(newSL, orderId).run();
    }

    async getRecentTrades(limit = 50) {
        const { results } = await this.db.prepare(
            'SELECT * FROM trades ORDER BY entry_time DESC LIMIT ?'
        ).bind(limit).all();
        return results;
    }

    async getStats() {
        const stats = await this.db.prepare(`
            SELECT
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl_inr > 0 THEN 1 ELSE 0 END) as wins,
                SUM(pnl_inr) as total_pnl,
                AVG(hold_time_minutes) as avg_hold_time
            FROM trades WHERE status = 'CLOSED'
        `).first();
        const totalTrades = stats?.total_trades || 0;
        const wins = stats?.wins || 0;
        const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
        const currentBalance = await this.getMockBalance();
        return {
            totalTrades, winRate: parseFloat(winRate.toFixed(1)),
            totalPnL: stats?.total_pnl || 0,
            avgHoldTime: stats?.avg_hold_time || 0,
            balance: currentBalance,
        };
    }

    async getTodayTradeCount() {
        const todayStart = this.getTodayStartMs();
        const result = await this.db.prepare(
            'SELECT COUNT(*) as count FROM trades WHERE entry_time >= ?'
        ).bind(todayStart).first();
        return result?.count || 0;
    }

    async getTodayLossCount() {
        const todayStart = this.getTodayStartMs();
        const result = await this.db.prepare(
            "SELECT COUNT(*) as count FROM trades WHERE entry_time >= ? AND status = 'CLOSED' AND pnl_inr < 0"
        ).bind(todayStart).first();
        return result?.count || 0;
    }

    async getLastLossTime() {
        const result = await this.db.prepare(
            "SELECT exit_time FROM trades WHERE status = 'CLOSED' AND pnl_inr < 0 ORDER BY exit_time DESC LIMIT 1"
        ).first();
        return result?.exit_time || null;
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

    // ─── Signal Mode ──────────────────────────────────────────────────

    async logSignal(data) {
        return await this.db.prepare(`
            INSERT INTO signal_log (
                timestamp, symbol, direction, accumulation_score,
                minutes_accumulating, cross_asset_status, entry_price,
                hypothetical_tp, hypothetical_sl, filters_that_would_have_blocked
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            Date.now(), data.symbol, data.direction, data.accumulationScore || 0,
            data.minutesAccumulating || 0, data.crossAssetStatus || null, data.entryPrice || 0,
            data.hypotheticalTP || 0, data.hypotheticalSL || 0, data.filtersBlocked || null
        ).run();
    }

    async updateSignalOutcome(id, field, value) {
        return await this.db.prepare(`UPDATE signal_log SET ${field} = ?, outcome = 'TRACKING' WHERE id = ?`)
            .bind(value || null, id).run();
    }

    async finalizeSignal(id, outcome) {
        return await this.db.prepare("UPDATE signal_log SET outcome = ? WHERE id = ?")
            .bind(outcome, id).run();
    }

    async getActiveSignals() {
        const { results } = await this.db.prepare("SELECT * FROM signal_log WHERE outcome IS NULL OR outcome = 'TRACKING'").all();
        return results || [];
    }

    // ─── Daily Stats ───────────────────────────────────────────────

    async updateDailyStats(stats) {
        const date = new Date().toISOString().split('T')[0];
        return await this.db.prepare(`
            INSERT INTO daily_stats (date, trades_taken, wins, losses, total_pnl_inr, peak_balance, mock_balance)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET
                trades_taken = excluded.trades_taken,
                wins = excluded.wins,
                losses = excluded.losses,
                total_pnl_inr = excluded.total_pnl_inr,
                peak_balance = MAX(daily_stats.peak_balance, excluded.peak_balance),
                mock_balance = excluded.mock_balance
        `).bind(
            date, stats.tradesTaken || 0, stats.wins || 0, stats.losses || 0,
            stats.totalPnLInr || 0, stats.peakBalance || 0, stats.mockBalance || 0
        ).run();
    }

    async getDailyStats() {
        const { results } = await this.db.prepare('SELECT * FROM daily_stats ORDER BY date DESC LIMIT 30').all();
        return results || [];
    }

    async getRecentSignals(limit = 30) {
        const { results } = await this.db.prepare(
            "SELECT * FROM signal_log ORDER BY timestamp DESC LIMIT ?"
        ).bind(limit).all();
        return results || [];
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
