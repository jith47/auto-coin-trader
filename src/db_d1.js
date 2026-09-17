export class D1Database {
    constructor(d1) {
        this.db = d1;
    }

    // Log a trade
    async logTrade(data, orderId = null) {
        const stmt = this.db.prepare(`
            INSERT INTO trade_logs (
                timestamp, decision, reason, asset, price, quantity,
                leverage, stop_loss, take_profit, tp_levels, raw_response, status, order_id, entry_value_inr
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            orderId || data.orderId || null,
            data.entryValueInr || 0
        ).run();
    }

    // Update trade status
    async updateTradeStatus(tradeId, status, exitPrice = null, pnl = null, closeReason = null, exitValueInr = null, pnlInr = null) {
        try {
            const closedAt = status === 'CLOSED' ? Date.now() : null;
            const isNumericId = typeof tradeId === 'number' || (typeof tradeId === 'string' && /^\d+$/.test(tradeId));
            const col = isNumericId ? 'id' : 'order_id';
            
            const stmt = this.db.prepare(`
                UPDATE trade_logs
                SET status = ?, exit_price = ?, pnl = ?, close_reason = ?, exit_value_inr = ?, pnl_inr = ?,
                    closed_at = COALESCE(closed_at, ?)
                WHERE ${col} = ?
            `);
            const result = await stmt.bind(status, exitPrice, pnl, closeReason, exitValueInr, pnlInr, closedAt, tradeId).run();
            console.log(`[DB] updateTradeStatus (${col}=${tradeId}) to ${status}: ${result.success ? 'Success' : 'Failed'}`);
            return result;
        } catch (err) {
            console.error(`[DB] updateTradeStatus error for ${tradeId}:`, err.message);
            throw err;
        }
    }

    // Update TP levels status
    async updateTPLevels(tradeId, tpLevels) {
        const isNumericId = typeof tradeId === 'number' || (typeof tradeId === 'string' && /^\d+$/.test(tradeId));
        const col = isNumericId ? 'id' : 'order_id';
        const stmt = this.db.prepare(`
            UPDATE trade_logs
            SET tp_levels = ?
            WHERE ${col} = ?
        `);
        return await stmt.bind(JSON.stringify(tpLevels), tradeId).run();
    }

    // Get active trade
    async getActiveTrade() {
        return await this.db.prepare(
            "SELECT * FROM trade_logs WHERE status = 'OPEN' OR status = 'FILLED' ORDER BY timestamp DESC LIMIT 1"
        ).first();
    }

    // Get all active trades
    async getActiveTrades() {
        const { results } = await this.db.prepare(
            "SELECT * FROM trade_logs WHERE status = 'OPEN' OR status = 'FILLED' ORDER BY timestamp DESC"
        ).all();
        return results || [];
    }

    // Get trade by order_id
    async getTradeByOrderId(orderId) {
        return await this.db.prepare(
            "SELECT * FROM trade_logs WHERE order_id = ? LIMIT 1"
        ).bind(orderId).first();
    }

    // Get recent trades
    async getRecentTrades(limit = 10) {
        const { results } = await this.db.prepare(`
            SELECT 
                id, timestamp, decision, reason, asset, price, quantity, 
                leverage, stop_loss, take_profit, status, exit_price, 
                pnl, close_reason, entry_value_inr, exit_value_inr, 
                pnl_inr, closed_at, symbol 
            FROM trade_logs 
            ORDER BY timestamp DESC LIMIT ?
        `).bind(limit).all();
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

        const totalTrades = stats?.total_trades || 0;
        const wins = stats?.wins || 0;
        const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

        const currentBalance = await this.getMockBalance();

        return {
            totalTrades,
            winRate: parseFloat(winRate.toFixed(1)),
            totalPnL: stats?.total_pnl || 0,
            balance: currentBalance
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

    // Get today's PnL in INR
    async getTodayPnLInr() {
        const todayStart = this.getTodayStartMs();
        const result = await this.db.prepare(
            "SELECT SUM(pnl_inr) as total_pnl FROM trade_logs WHERE timestamp >= ? AND status = 'CLOSED'"
        ).bind(todayStart).first();
        return result?.total_pnl || 0;
    }

    // Helper: get today's start timestamp in ms (UTC midnight)
    getTodayStartMs() {
        const now = new Date();
        return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    }

    // Mock Balance Management (Fixed at ₹2500)
    async getMockBalance() {
        return 2500.0;
    }

    async updateMockBalance(newBalance) {
        return await this.db.prepare(
            "INSERT INTO settings (key, value) VALUES ('mock_balance_inr', '2500') ON CONFLICT(key) DO UPDATE SET value = '2500'"
        ).run();
    }

    // Generic Setting Management
    async getSetting(key, defaultValue = null) {
        const result = await this.db.prepare(
            "SELECT value FROM settings WHERE key = ?"
        ).bind(key).first();
        return result?.value || defaultValue;
    }

    async updateSetting(key, value) {
        return await this.db.prepare(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).bind(key, value.toString()).run();
    }

    async getDisabledStrategies() {
        const { results } = await this.db.prepare(
            "SELECT key, value FROM settings WHERE key LIKE 'strategy_disabled_%'"
        ).all();
        const disabled = new Set();
        if (Array.isArray(results)) {
            for (const row of results) {
                if (row.value === 'true') {
                    const stratKey = row.key.replace('strategy_disabled_', '');
                    disabled.add(stratKey);
                }
            }
        }
        return disabled;
    }

    async toggleStrategy(stratKey) {
        const key = `strategy_disabled_${stratKey}`;
        const current = await this.getSetting(key, 'false');
        const nextState = current === 'true' ? 'false' : 'true';
        await this.updateSetting(key, nextState);
        return nextState !== 'true'; // returns true if enabled, false if disabled
    }

    // Get detailed per-strategy statistics
    async getStrategyStats() {
        const KNOWN_STRATEGIES = [
            { key: 'MOMENTUM_5M', name: 'Momentum 5m', description: 'ETH 5-min price momentum with volume surge' },
            { key: 'VWAP_CROSS', name: 'VWAP Cross', description: 'Price cross of 20-period Volume Weighted Average Price' },
            { key: 'EMA_RIBBON', name: 'EMA Ribbon', description: 'Fast EMA (5) vs Slow EMA (20) trend & momentum alignment' },
            { key: 'BOLLINGER_SQUEEZE', name: 'Bollinger Squeeze', description: 'Volatility compression & breakout expansion' },
            { key: 'RSI_DIVERGENCE', name: 'RSI Divergence', description: '14-period RSI divergence & extreme reversal' },
            { key: 'DELTA_FLIP', name: 'Delta Flip', description: 'Order flow / CVD direction flip with taker volume' },
            { key: 'ABSORPTION', name: 'Absorption', description: 'Volume spike with range compression near extremes' },
            { key: 'MEAN_REVERT_Z', name: 'Mean Reversion Z-Score', description: 'Statistical Z-score deviation (> 1.8) from mean' },
            { key: 'MOMENTUM_DIVERGE', name: 'Momentum Divergence', description: 'Price momentum vs volume exhaustion divergence' },
            { key: 'MULTI_TF_ALIGN', name: 'Multi-TF Alignment', description: 'Confluence across BTC 1h, ETH 5m & Taker flow' },
        ];

        const disabledSet = await this.getDisabledStrategies();

        const { results } = await this.db.prepare(`
            SELECT 
                CASE 
                    WHEN reason LIKE '%MOMENTUM_5M%' THEN 'MOMENTUM_5M'
                    WHEN reason LIKE '%VWAP_CROSS%' THEN 'VWAP_CROSS'
                    WHEN reason LIKE '%EMA_RIBBON%' THEN 'EMA_RIBBON'
                    WHEN reason LIKE '%BOLLINGER_SQUEEZE%' THEN 'BOLLINGER_SQUEEZE'
                    WHEN reason LIKE '%RSI_DIVERGENCE%' THEN 'RSI_DIVERGENCE'
                    WHEN reason LIKE '%DELTA_FLIP%' THEN 'DELTA_FLIP'
                    WHEN reason LIKE '%ABSORPTION%' THEN 'ABSORPTION'
                    WHEN reason LIKE '%MEAN_REVERT_Z%' THEN 'MEAN_REVERT_Z'
                    WHEN reason LIKE '%MOMENTUM_DIVERGE%' THEN 'MOMENTUM_DIVERGE'
                    WHEN reason LIKE '%MULTI_TF_ALIGN%' THEN 'MULTI_TF_ALIGN'
                    ELSE 'OTHER'
                END as strat_key,
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
                SUM(CASE WHEN pnl = 0 THEN 1 ELSE 0 END) as breakevens,
                SUM(COALESCE(pnl_inr, 0)) as total_pnl_inr,
                SUM(COALESCE(pnl, 0)) as total_pnl_pct,
                AVG(pnl) as avg_pnl_pct,
                MAX(pnl) as max_pnl_pct,
                MIN(pnl) as min_pnl_pct,
                MIN(timestamp) as first_trade_time,
                MAX(timestamp) as last_trade_time,
                MIN(CASE WHEN pnl > 0 THEN timestamp END) as first_profit_time,
                MAX(CASE WHEN pnl > 0 THEN timestamp END) as last_profit_time
            FROM trade_logs
            WHERE status = 'CLOSED'
            GROUP BY strat_key
        `).all();

        const resultMap = new Map();
        if (Array.isArray(results)) {
            for (const r of results) {
                resultMap.set(r.strat_key, r);
            }
        }

        return KNOWN_STRATEGIES.map(strat => {
            const row = resultMap.get(strat.key) || {};
            const totalTrades = row.total_trades || 0;
            const wins = row.wins || 0;
            const losses = row.losses || 0;
            const breakevens = row.breakevens || 0;
            const winRate = totalTrades > 0 ? parseFloat(((wins / totalTrades) * 100).toFixed(1)) : 0;
            const totalPnlInr = parseFloat((row.total_pnl_inr || 0).toFixed(2));
            const totalPnlPct = parseFloat((row.total_pnl_pct || 0).toFixed(2));
            const avgPnlPct = totalTrades > 0 ? parseFloat((row.avg_pnl_pct || 0).toFixed(2)) : 0;
            const maxPnlPct = row.max_pnl_pct != null ? parseFloat(row.max_pnl_pct.toFixed(2)) : 0;
            const minPnlPct = row.min_pnl_pct != null ? parseFloat(row.min_pnl_pct.toFixed(2)) : 0;

            const firstTradeTime = row.first_trade_time || null;
            const lastTradeTime = row.last_trade_time || null;
            const firstProfitTime = row.first_profit_time || null;
            const lastProfitTime = row.last_profit_time || null;

            return {
                key: strat.key,
                name: strat.name,
                description: strat.description,
                enabled: !disabledSet.has(strat.key),
                totalTrades,
                wins,
                losses,
                breakevens,
                winRate,
                totalPnlInr,
                totalPnlPct,
                avgPnlPct,
                maxPnlPct,
                minPnlPct,
                firstTradeTime,
                lastTradeTime,
                firstProfitTime,
                lastProfitTime,
            };
        });
    }
}
