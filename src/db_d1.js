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

    // Ensure shadow_signals table exists
    async ensureShadowTable() {
        if (this._shadowTableReady) return;
        try {
            await this.db.prepare(`
                CREATE TABLE IF NOT EXISTS shadow_signals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp INTEGER NOT NULL,
                    strategy_key TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    score INTEGER NOT NULL,
                    entry_price REAL NOT NULL,
                    outcome TEXT DEFAULT 'PENDING',
                    exit_price REAL,
                    resolved_at INTEGER
                )
            `).run();
            this._shadowTableReady = true;
        } catch (e) {
            console.error('[DB] ensureShadowTable error:', e.message);
        }
    }

    // Log a shadow signal for tournament tracking (debounced 3m per strategy)
    async logShadowSignal(strategyKey, direction, score, entryPrice) {
        try {
            await this.ensureShadowTable();
            const debouncedTime = Date.now() - (3 * 60 * 1000);
            const existing = await this.db.prepare(`
                SELECT id FROM shadow_signals
                WHERE strategy_key = ? AND outcome = 'PENDING' AND timestamp > ?
                LIMIT 1
            `).bind(strategyKey, debouncedTime).first();

            if (existing) {
                return; // Already tracking a recent pending signal for this strategy
            }

            return await this.db.prepare(`
                INSERT INTO shadow_signals (timestamp, strategy_key, direction, score, entry_price, outcome)
                VALUES (?, ?, ?, ?, ?, 'PENDING')
            `).bind(Date.now(), strategyKey, direction, score, entryPrice).run();
        } catch (err) {
            console.error(`[DB] logShadowSignal error for ${strategyKey}:`, err.message);
        }
    }

    // Resolve pending shadow signals based on price action
    async resolveShadowSignals(currentPrice) {
        if (!currentPrice || currentPrice <= 0) return 0;
        try {
            await this.ensureShadowTable();
            const { results } = await this.db.prepare(`
                SELECT id, timestamp, strategy_key, direction, score, entry_price
                FROM shadow_signals
                WHERE outcome = 'PENDING'
                ORDER BY timestamp ASC
                LIMIT 50
            `).all();

            if (!results || results.length === 0) return 0;

            const now = Date.now();
            let resolvedCount = 0;

            for (const sig of results) {
                const ageMs = now - sig.timestamp;
                if (ageMs < 60 * 1000) continue; // Give it at least 1 minute

                const movePct = sig.direction === 'BUY'
                    ? ((currentPrice - sig.entry_price) / sig.entry_price) * 100
                    : ((sig.entry_price - currentPrice) / sig.entry_price) * 100;

                let outcome = null;
                // Win/Loss threshold: 0.15% move
                if (movePct >= 0.15) {
                    outcome = 'WIN';
                } else if (movePct <= -0.15) {
                    outcome = 'LOSS';
                } else if (ageMs >= 15 * 60 * 1000) {
                    // After 15 minutes, check smaller threshold
                    if (movePct >= 0.05) outcome = 'WIN';
                    else if (movePct <= -0.05) outcome = 'LOSS';
                    else outcome = 'EXPIRED';
                } else if (ageMs >= 20 * 60 * 1000) {
                    outcome = 'EXPIRED';
                }

                if (outcome) {
                    await this.db.prepare(`
                        UPDATE shadow_signals
                        SET outcome = ?, exit_price = ?, resolved_at = ?
                        WHERE id = ?
                    `).bind(outcome, currentPrice, now, sig.id).run();
                    resolvedCount++;
                }
            }

            if (resolvedCount > 0) {
                console.log(`[DB] Resolved ${resolvedCount} pending shadow signals`);
            }
            return resolvedCount;
        } catch (err) {
            console.error('[DB] resolveShadowSignals error:', err.message);
            return 0;
        }
    }

    // Get rolling health for all strategies
    async getAllStrategyHealth() {
        const KNOWN_STRATEGIES = [
            { key: 'SWEEP_RECLAIM', name: 'Sweep & Reclaim', description: 'Institutional liquidity sweep & reclaim of swing extremes' },
            { key: 'STOP_HUNT', name: 'Stop Loss Hunter', description: 'Microstructure snap-back after retail stop hunt wicks' },
            { key: 'OI_TRAP', name: 'OI Trap Fade', description: 'Fade retail positioning trap when OI surges without price progress' },
            { key: 'SESSION_OPEN', name: 'Session Open Momentum', description: 'Institutional volatility exploitation at London & US opens' },
            { key: 'FUNDING_SQUEEZE', name: 'Funding Squeeze', description: 'Ride forced unwinds when overleveraged funding side turns' },
            { key: 'LIQUIDATION_CASCADE', name: 'Liquidation Cascade', description: 'Ride cascading margin liquidations on high volume' },
            { key: 'ABSORPTION_REVERSAL', name: 'Smart Money Absorption', description: 'Follow smart money absorption into tight compression' },
            { key: 'RETAIL_FADE', name: 'Retail Sentiment Fade', description: 'Contrarian cascade when lopsided crowd gets caught' },
            { key: 'WHALE_IMBALANCE', name: 'Whale Imbalance', description: 'Follow aggressive institutional taker flow imbalances' },
            { key: 'MICRO_SCALP', name: 'Micro Scalp', description: 'Ultra-short 3-bar accelerating momentum scalp' },
            { key: 'MOMENTUM_5M', name: '5M Momentum Surge', description: 'High-volume 5-minute directional momentum breakouts' },
            { key: 'TAKER_SURGE', name: 'Taker Flow Surge', description: 'Surge in aggressive market taker orders dominating order book' },
            { key: 'CVD_PRICE_DIV', name: 'CVD Divergence', description: 'Cumulative volume delta divergence vs price direction' },
            { key: 'BTC_FOLLOW', name: 'BTC Trend Follower', description: 'Exploiting ETH lag during aggressive Bitcoin macro moves' },
            { key: 'RANGE_BOUNCE', name: 'Range Boundary Bounce', description: 'Mean reversion fade at 20-candle consolidation boundaries' },
        ];

        try {
            await this.ensureShadowTable();
            // Fetch the most recent resolved signals to calculate rolling stats
            const { results } = await this.db.prepare(`
                SELECT strategy_key, outcome
                FROM shadow_signals
                WHERE outcome IN ('WIN', 'LOSS')
                ORDER BY resolved_at DESC, timestamp DESC
                LIMIT 400
            `).all();

            // Also get pending counts
            const { results: pendingResults } = await this.db.prepare(`
                SELECT strategy_key, COUNT(*) as count
                FROM shadow_signals
                WHERE outcome = 'PENDING'
                GROUP BY strategy_key
            `).all();

            const pendingMap = new Map();
            if (Array.isArray(pendingResults)) {
                for (const p of pendingResults) {
                    pendingMap.set(p.strategy_key, p.count);
                }
            }

            const stratSignals = new Map();
            if (Array.isArray(results)) {
                for (const r of results) {
                    if (!stratSignals.has(r.strategy_key)) {
                        stratSignals.set(r.strategy_key, []);
                    }
                    const list = stratSignals.get(r.strategy_key);
                    if (list.length < 20) {
                        list.push(r.outcome);
                    }
                }
            }

            const healthMap = {};
            for (const strat of KNOWN_STRATEGIES) {
                const signals = stratSignals.get(strat.key) || [];
                const totalResolved = signals.length;
                const wins = signals.filter(o => o === 'WIN').length;
                const losses = totalResolved - wins;
                const winRate = totalResolved > 0 ? parseFloat(((wins / totalResolved) * 100).toFixed(1)) : 0;
                const pendingCount = pendingMap.get(strat.key) || 0;

                let status = 'WARM';
                if (totalResolved < 5) {
                    status = 'WARM'; // Grace period (allow testing)
                } else if (winRate >= 55) {
                    status = 'HOT';
                } else if (winRate < 45) {
                    status = 'COLD';
                } else {
                    status = 'WARM';
                }

                healthMap[strat.key] = {
                    key: strat.key,
                    name: strat.name,
                    description: strat.description,
                    status,
                    winRate,
                    wins,
                    losses,
                    totalResolved,
                    pendingCount,
                };
            }
            return healthMap;
        } catch (err) {
            console.error('[DB] getAllStrategyHealth error:', err.message);
            // Fallback default health map
            const fallback = {};
            for (const strat of KNOWN_STRATEGIES) {
                fallback[strat.key] = {
                    key: strat.key,
                    name: strat.name,
                    description: strat.description,
                    status: 'WARM',
                    winRate: 0,
                    wins: 0,
                    losses: 0,
                    totalResolved: 0,
                    pendingCount: 0
                };
            }
            return fallback;
        }
    }

    // Cleanup shadow signals older than 7 days
    async cleanupOldShadowSignals() {
        try {
            await this.ensureShadowTable();
            const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
            const res = await this.db.prepare(`
                DELETE FROM shadow_signals WHERE timestamp < ?
            `).bind(cutoff).run();
            console.log(`[DB] Cleaned up old shadow signals before ${new Date(cutoff).toISOString()}`);
            return res;
        } catch (err) {
            console.error('[DB] cleanupOldShadowSignals error:', err.message);
        }
    }

    // Get detailed per-strategy statistics (including legacy + predatory pool)
    async getStrategyStats() {
        const KNOWN_STRATEGIES = [
            { key: 'SWEEP_RECLAIM', name: 'Sweep & Reclaim', description: 'Institutional liquidity sweep & reclaim of swing extremes' },
            { key: 'STOP_HUNT', name: 'Stop Loss Hunter', description: 'Microstructure snap-back after retail stop hunt wicks' },
            { key: 'OI_TRAP', name: 'OI Trap Fade', description: 'Fade retail positioning trap when OI surges without price progress' },
            { key: 'SESSION_OPEN', name: 'Session Open Momentum', description: 'Institutional volatility exploitation at London & US opens' },
            { key: 'FUNDING_SQUEEZE', name: 'Funding Squeeze', description: 'Ride forced unwinds when overleveraged funding side turns' },
            { key: 'LIQUIDATION_CASCADE', name: 'Liquidation Cascade', description: 'Ride cascading margin liquidations on high volume' },
            { key: 'ABSORPTION_REVERSAL', name: 'Smart Money Absorption', description: 'Follow smart money absorption into tight compression' },
            { key: 'RETAIL_FADE', name: 'Retail Sentiment Fade', description: 'Contrarian cascade when lopsided crowd gets caught' },
            { key: 'WHALE_IMBALANCE', name: 'Whale Imbalance', description: 'Follow aggressive institutional taker flow imbalances' },
            { key: 'MICRO_SCALP', name: 'Micro Scalp', description: 'Ultra-short 3-bar accelerating momentum scalp' },
            { key: 'MOMENTUM_5M', name: '5M Momentum Surge', description: 'High-volume 5-minute directional momentum breakouts' },
            { key: 'TAKER_SURGE', name: 'Taker Flow Surge', description: 'Surge in aggressive market taker orders dominating order book' },
            { key: 'CVD_PRICE_DIV', name: 'CVD Divergence', description: 'Cumulative volume delta divergence vs price direction' },
            { key: 'BTC_FOLLOW', name: 'BTC Trend Follower', description: 'Exploiting ETH lag during aggressive Bitcoin macro moves' },
            { key: 'RANGE_BOUNCE', name: 'Range Boundary Bounce', description: 'Mean reversion fade at 20-candle consolidation boundaries' },
        ];

        const disabledSet = await this.getDisabledStrategies();
        const healthMap = await this.getAllStrategyHealth();

        const { results } = await this.db.prepare(`
            SELECT 
                CASE 
                    WHEN reason LIKE '%SWEEP_RECLAIM%' THEN 'SWEEP_RECLAIM'
                    WHEN reason LIKE '%STOP_HUNT%' THEN 'STOP_HUNT'
                    WHEN reason LIKE '%OI_TRAP%' THEN 'OI_TRAP'
                    WHEN reason LIKE '%SESSION_OPEN%' THEN 'SESSION_OPEN'
                    WHEN reason LIKE '%FUNDING_SQUEEZE%' THEN 'FUNDING_SQUEEZE'
                    WHEN reason LIKE '%LIQUIDATION_CASCADE%' THEN 'LIQUIDATION_CASCADE'
                    WHEN reason LIKE '%ABSORPTION_REVERSAL%' THEN 'ABSORPTION_REVERSAL'
                    WHEN reason LIKE '%RETAIL_FADE%' THEN 'RETAIL_FADE'
                    WHEN reason LIKE '%WHALE_IMBALANCE%' THEN 'WHALE_IMBALANCE'
                    WHEN reason LIKE '%MICRO_SCALP%' THEN 'MICRO_SCALP'
                    WHEN reason LIKE '%MOMENTUM_5M%' THEN 'MOMENTUM_5M'
                    WHEN reason LIKE '%TAKER_SURGE%' THEN 'TAKER_SURGE'
                    WHEN reason LIKE '%CVD_PRICE_DIV%' THEN 'CVD_PRICE_DIV'
                    WHEN reason LIKE '%BTC_FOLLOW%' THEN 'BTC_FOLLOW'
                    WHEN reason LIKE '%RANGE_BOUNCE%' THEN 'RANGE_BOUNCE'
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

            const health = healthMap[strat.key] || {
                status: 'WARM',
                winRate: 0,
                totalResolved: 0,
                pendingCount: 0
            };

            return {
                key: strat.key,
                name: strat.name,
                description: strat.description,
                enabled: !disabledSet.has(strat.key),
                tournamentStatus: health.status,
                shadowWinRate: health.winRate,
                shadowResolved: health.totalResolved,
                shadowPending: health.pendingCount,
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
