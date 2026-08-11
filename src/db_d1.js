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
            // Use the numeric ID primarily if it's passed, or try to match by order_id as fallback
            const isUuid = typeof tradeId === 'string' && tradeId.includes('-');
            
            const stmt = this.db.prepare(`
                UPDATE trade_logs
                SET status = ?, exit_price = ?, pnl = ?, close_reason = ?, exit_value_inr = ?, pnl_inr = ?,
                    closed_at = COALESCE(closed_at, ?)
                WHERE ${isUuid ? 'order_id' : 'id'} = ?
            `);
            const result = await stmt.bind(status, exitPrice, pnl, closeReason, exitValueInr, pnlInr, closedAt, tradeId).run();
            console.log(`[DB] updateTradeStatus for ${tradeId} to ${status}: ${result.success ? 'Success' : 'Failed'}`);
            return result;
        } catch (err) {
            console.error(`[DB] updateTradeStatus error for ${tradeId}:`, err.message);
            throw err;
        }
    }

    // Update TP levels status
    async updateTPLevels(tradeId, tpLevels) {
        const isUuid = typeof tradeId === 'string' && tradeId.includes('-');
        const stmt = this.db.prepare(`
            UPDATE trade_logs
            SET tp_levels = ?
            WHERE ${isUuid ? 'order_id' : 'id'} = ?
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
        // Use UPSERT pattern
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

    // Get detailed per-strategy statistics
    async getStrategyStats() {
        const KNOWN_STRATEGIES = [
            {
                key: 'EMA_VWAP_CONFLUENCE',
                name: 'EMA/VWAP Confluence',
                description: 'EMA-9/21 momentum crossover confirmed by VWAP fair value position and RSI',
                regimes: ['TREND_UP', 'TREND_DOWN'],
            },
            {
                key: 'MOMENTUM_BREAKOUT',
                name: 'Momentum Breakout',
                description: '20-candle high/low breakouts with dynamic ATR filter, EMA trend, and volume expansion',
                regimes: ['TREND_UP', 'TREND_DOWN'],
            },
            {
                key: 'BOLLINGER_SQUEEZE',
                name: 'Bollinger Squeeze Reversion',
                description: 'Band compression mean reversion at lower/upper bands with RSI extremes',
                regimes: ['RANGE'],
            },
            {
                key: 'DIRECTIONAL_ALIGNMENT',
                name: 'Directional Alignment (Legacy)',
                description: 'Volume Delta + Momentum alignment on closed candles (Legacy)',
                regimes: ['TREND_UP', 'TREND_DOWN'],
            },
            {
                key: 'RSI_MEAN_REVERSION',
                name: 'RSI Mean Reversion (Legacy)',
                description: 'Overbought / Oversold reversals in ranging conditions (Legacy)',
                regimes: ['RANGE'],
            },
            {
                key: 'VOLUME_SPIKE',
                name: 'Volume Spike Momentum (Legacy)',
                description: 'High-volume directional bursts on completed 1m candles (Legacy)',
                regimes: ['TREND_UP', 'TREND_DOWN'],
            },
            {
                key: 'BTC_ETH_DIVERGENCE',
                name: 'BTC-ETH Divergence (Legacy)',
                description: 'Cross-pair lag catch-up when BTC moves >0.15% (Legacy)',
                regimes: ['TREND_UP', 'TREND_DOWN'],
            },
            {
                key: 'WICK_REVERSAL',
                name: 'Wick Reversal (Legacy)',
                description: 'High upper/lower wick rejection candles (Legacy)',
                regimes: ['RANGE'],
            }
        ];

        const { results } = await this.db.prepare(`
            SELECT 
                CASE 
                    WHEN reason LIKE '%EMA_VWAP_CONFLUENCE%' THEN 'EMA_VWAP_CONFLUENCE'
                    WHEN reason LIKE '%MOMENTUM_BREAKOUT%' THEN 'MOMENTUM_BREAKOUT'
                    WHEN reason LIKE '%BOLLINGER_SQUEEZE%' THEN 'BOLLINGER_SQUEEZE'
                    WHEN reason LIKE '%DIRECTIONAL_ALIGNMENT%' OR reason LIKE '%TREND_CONTINUATION%' OR reason LIKE '%RELATIVE_%' THEN 'DIRECTIONAL_ALIGNMENT'
                    WHEN reason LIKE '%RSI_MEAN_REVERSION%' THEN 'RSI_MEAN_REVERSION'
                    WHEN reason LIKE '%VOLUME_SPIKE%' THEN 'VOLUME_SPIKE'
                    WHEN reason LIKE '%BTC_ETH_DIVERGENCE%' THEN 'BTC_ETH_DIVERGENCE'
                    WHEN reason LIKE '%WICK_REVERSAL%' OR reason LIKE '%SWEEP_RECLAIM%' THEN 'WICK_REVERSAL'
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
                regimes: strat.regimes,
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
