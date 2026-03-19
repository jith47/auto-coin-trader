/**
 * OI Flow Rider — Server-side Backtest Engine
 * Replays historical trades against stored tick data with custom parameters.
 */

const USD_INR = 85;
const FEE_PCT = 0.001;

export async function runBacktest(db, params) {
    // Fetch all trades and tick logs
    const { results: trades } = await db.prepare(
        'SELECT * FROM trades ORDER BY entry_time ASC'
    ).all();

    const { results: allTicks } = await db.prepare(
        'SELECT timestamp, symbol, price, accumulation_score, oi_change_1m, oi_change_5m, oi_change_15m, volume_ratio, direction, cross_asset_status, tick_oi_consistency, tick_oi_acceleration, tick_absorption, tick_compression, taker_ratio, price_slope, atr_pct, minutes_accumulating FROM tick_logs ORDER BY timestamp ASC'
    ).all();

    // Index ticks by symbol
    const ticksBySymbol = {};
    for (const t of allTicks) {
        if (!ticksBySymbol[t.symbol]) ticksBySymbol[t.symbol] = [];
        ticksBySymbol[t.symbol].push(t);
    }

    const oldParams = {
        VOL_WT_OI_THRESHOLD: 0.05,
        VOL_OI_DIVERGENCE: 1.5,
        MIN_HOLD_MINUTES: 0,
        BLOCK_BOTH_QUIET: false,
        TP_SL_RATIO: 2.5,
        ACC_ENTRY_THRESHOLD: 55,
        ACC_MIN_DURATION: 7,
    };

    const newParams = {
        VOL_WT_OI_THRESHOLD: parseFloat(params.volWtOiThreshold) || 0.2,
        VOL_OI_DIVERGENCE: parseFloat(params.volOiDivergence) || 1.5,
        MIN_HOLD_MINUTES: parseFloat(params.minHoldMinutes) || 5,
        BLOCK_BOTH_QUIET: params.blockBothQuiet !== false,
        TP_SL_RATIO: parseFloat(params.tpSlRatio) || 2.5,
        ACC_ENTRY_THRESHOLD: parseFloat(params.accEntryThreshold) || 55,
        ACC_MIN_DURATION: parseFloat(params.accMinDuration) || 7,
        LEVERAGE: parseFloat(params.leverage) || 10,
    };

    const oldResults = simulateAll(trades, ticksBySymbol, oldParams);
    const newResults = simulateAll(trades, ticksBySymbol, newParams);

    // Build comparison
    const comparison = [];
    for (let i = 0; i < trades.length; i++) {
        const t = trades[i];
        const o = oldResults[i];
        const n = newResults[i];
        comparison.push({
            id: t.id,
            symbol: t.symbol,
            direction: t.direction,
            entry_price: t.entry_price,
            acc_score: t.acc_score_at_entry,
            cross_asset: t.cross_asset_status_at_entry,
            old: { reason: o.reason, pnl: round(o.pnl_inr), hold: round(o.hold), exit_price: round(o.exit_price), debug: o.debug },
            new: { reason: n.reason, pnl: round(n.pnl_inr), hold: round(n.hold), exit_price: round(n.exit_price), debug: n.debug },
            diff: round(n.pnl_inr - o.pnl_inr),
        });
    }

    // Summary stats
    const oldSummary = summarize(oldResults);
    const newSummary = summarize(newResults);

    // Exit distributions
    const oldExitDist = exitDistribution(oldResults);
    const newExitDist = exitDistribution(newResults);

    return {
        tradeCount: trades.length,
        tickCount: allTicks.length,
        oldParams, newParams,
        oldSummary, newSummary,
        comparison,
        oldExitDist, newExitDist,
        pnlImpact: round(newSummary.totalPnl - oldSummary.totalPnl),
    };
}

function simulateAll(trades, ticksBySymbol, params) {
    return trades.map(t => simulateTrade(t, ticksBySymbol[t.symbol] || [], params));
}

function simulateTrade(trade, ticks, params) {
    const dir = trade.direction === 'LONG' ? 1 : -1;
    const leverage = params.LEVERAGE || 10;
    const leverageFactor = leverage / 10;

    // Entry gate
    if (params.BLOCK_BOTH_QUIET && trade.cross_asset_status_at_entry === 'BOTH_QUIET') {
        return { reason: 'BLOCKED', pnl_inr: 0, hold: 0, exit_price: trade.entry_price, blocked: true };
    }
    if (trade.acc_score_at_entry < params.ACC_ENTRY_THRESHOLD) {
        return { reason: 'SCORE_BLOCKED', pnl_inr: 0, hold: 0, exit_price: trade.entry_price, blocked: true };
    }

    // Recalculate TP
    const slDist = Math.abs(trade.entry_price - trade.sl_price);
    const newTp = dir === 1 ? trade.entry_price + slDist * params.TP_SL_RATIO : trade.entry_price - slDist * params.TP_SL_RATIO;

    // Get ticks during trade window (extend 1 min past exit for END_OF_DATA comparison)
    const tradeTicks = ticks.filter(t => t.timestamp >= trade.entry_time && t.timestamp <= trade.exit_time + 60000);
    if (tradeTicks.length === 0) {
        return makeExit(trade, trade.exit_price || trade.entry_price, 'NO_DATA', trade.hold_time_minutes || 0, leverageFactor);
    }

    let prevTicks = [];
    for (const tick of tradeTicks) {
        const holdMin = (tick.timestamp - trade.entry_time) / 60000;
        const price = tick.price;
        if (!price || price <= 0) continue;
        const pnlPct = (price - trade.entry_price) / trade.entry_price * dir;

        // SL (always active)
        if (dir === 1 && price <= trade.sl_price) return makeExit(trade, price, 'STOP_LOSS', holdMin, leverageFactor);
        if (dir === -1 && price >= trade.sl_price) return makeExit(trade, price, 'STOP_LOSS', holdMin, leverageFactor);

        // TP (always active, with new TP level)
        if (dir === 1 && price >= newTp) return makeExit(trade, price, 'TAKE_PROFIT', holdMin, leverageFactor);
        if (dir === -1 && price <= newTp) return makeExit(trade, price, 'TAKE_PROFIT', holdMin, leverageFactor);

        // OI_DECEL (always active — kept outside grace period)
        if (pnlPct > 0 && prevTicks.length >= 3) {
            const oi0 = tick.oi_change_1m || 0;
            const oi1 = prevTicks[prevTicks.length - 1]?.oi_change_1m || 0;
            const oi2 = prevTicks[prevTicks.length - 2]?.oi_change_1m || 0;
            if (oi0 < oi1 && oi1 < oi2 && oi2 > 0) return makeExit(trade, price, 'OI_DECEL', holdMin, leverageFactor);
        }

        // Grace period — skip noise exits
        if (holdMin < params.MIN_HOLD_MINUTES) {
            prevTicks.push(tick);
            continue;
        }

        // VOL_WT_OI
        if (tick.volume_ratio > params.VOL_OI_DIVERGENCE) {
            const oiChg = Math.abs(tick.oi_change_5m || 0);
            if (oiChg < params.VOL_WT_OI_THRESHOLD) return makeExit(trade, price, 'VOL_WT_OI', holdMin, leverageFactor);
        }

        // ABSORPTION_FLIP (simplified — check profit + sudden volume drop approximation)
        if (pnlPct > 0 && prevTicks.length >= 3) {
            const prev3Price = prevTicks[prevTicks.length - 3]?.price;
            if (prev3Price) {
                const recentMove = Math.abs((price - prev3Price) / prev3Price);
                if (recentMove > 0.005) return makeExit(trade, price, 'ABSORPTION_FLIP', holdMin, leverageFactor);
            }
        }

        // TIME_STOP
        if (holdMin >= 45) return makeExit(trade, price, 'TIME_STOP', holdMin, leverageFactor);

        prevTicks.push(tick);
    }

    const last = tradeTicks[tradeTicks.length - 1];
    return makeExit(trade, last.price, 'END_OF_DATA', (last.timestamp - trade.entry_time) / 60000, leverageFactor);
}

function makeExit(trade, exitPrice, reason, holdMin, leverageFactor = 1) {
    const dir = trade.direction === 'LONG' ? 1 : -1;
    const pnl = (exitPrice - trade.entry_price) / trade.entry_price * dir;
    const basePosVal = trade.quantity * trade.entry_price * USD_INR;
    const simPosVal = basePosVal * leverageFactor;
    const fee = simPosVal * FEE_PCT;
    const pnl_inr = (pnl * simPosVal) - fee;

    if (trade.symbol === 'BTCUSDT' && pnl_inr > 10000) {
        console.log(`[DEBUG] Anomalous Trade: ${trade.id}, Exit: ${exitPrice}, Entry: ${trade.entry_price}, Qty: ${trade.quantity}, PNL: ${pnl}, PosVal: ${simPosVal}, res: ${pnl_inr}`);
    }

    return {
        reason,
        pnl_inr,
        hold: holdMin,
        exit_price: exitPrice,
        blocked: false,
        debug: { pnl, simPosVal, entry: trade.entry_price, exit: exitPrice, qty: trade.quantity }
    };
}

function summarize(results) {
    let wins = 0, losses = 0, blocked = 0, totalPnl = 0;
    for (const r of results) {
        if (r.blocked) { blocked++; continue; }
        totalPnl += r.pnl_inr;
        if (r.pnl_inr > 0) wins++; else losses++;
    }
    const traded = wins + losses;
    return { wins, losses, blocked, traded, totalPnl, winRate: traded > 0 ? Math.round(wins / traded * 100) : 0, avgPnl: traded > 0 ? totalPnl / traded : 0 };
}

function exitDistribution(results) {
    const dist = {};
    for (const r of results) {
        if (!dist[r.reason]) dist[r.reason] = { count: 0, pnl: 0 };
        dist[r.reason].count++;
        dist[r.reason].pnl += r.pnl_inr;
    }
    return Object.entries(dist).map(([reason, data]) => ({
        reason, count: data.count, pnl: round(data.pnl),
    })).sort((a, b) => b.count - a.count);
}

function round(n) { return Math.round((n || 0) * 100) / 100; }
