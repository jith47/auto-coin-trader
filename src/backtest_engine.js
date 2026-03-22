const USD_INR = 85;
const FEE_PCT = 0.001;

/**
 * Main Backtest Engine for Strategy v2.1
 */
export async function runBacktest(db, params) {
    const limit = params.limit || 2000;
    const btcTicks = await db.getRecentTicks('BTCUSDT', limit);
    const ethTicks = await db.getRecentTicks('ETHUSDT', limit);
    const allTicks = [...btcTicks, ...ethTicks].sort((a, b) => a.timestamp - b.timestamp);

    const oldResults = await db.getRecentTrades(limit);
    const oldSummary = summarize(oldResults.map(t => ({
        symbol: t.symbol,
        pnl_inr: t.pnl_inr,
        reason: t.exit_reason,
        hold: t.hold_time_minutes || 0
    })));

    const ticksBySymbol = {
        'BTCUSDT': btcTicks.sort((a, b) => a.timestamp - b.timestamp),
        'ETHUSDT': ethTicks.sort((a, b) => a.timestamp - b.timestamp)
    };

    const newTrades = discoverTrades(allTicks, params);
    const newResults = simulateAll(newTrades, ticksBySymbol, params);
    const newSummary = summarize(newResults);

    return {
        newSummary,
        oldSummary,
        newResultsDetailed: newResults.slice(-50), // Last 50 for table
        pnlImpact: newSummary.totalPnl - oldSummary.totalPnL,
        tradeCount: newSummary.traded
    };
}

export async function optimizeStrategy(db, options = {}) {
    const limit = options.limit || 2000;
    const btcTicks = await db.getRecentTicks('BTCUSDT', limit);
    const ethTicks = await db.getRecentTicks('ETHUSDT', limit);
    const allTicks = [...btcTicks, ...ethTicks].sort((a, b) => a.timestamp - b.timestamp);
    const ticksBySymbol = { 'BTCUSDT': btcTicks, 'ETHUSDT': ethTicks };

    const grid = {
        accEntry: [70, 75, 80, 85],
        accDur: [10, 15, 20],
        tpSl: [1.5, 2.0, 2.5],
        retailLimit: [0.65, 0.70, 0.75],
        signalBias: [2, 3]
    };

    const results = [];
    for (const acc of grid.accEntry) {
        for (const dur of grid.accDur) {
            for (const tpSl of grid.tpSl) {
                for (const rl of grid.retailLimit) {
                    for (const sb of grid.signalBias) {
                        const p = {
                            accEntryThreshold: acc, accMinDuration: dur, tpSlRatio: tpSl,
                            retailLimit: rl, signalBias: sb, requireTransition: true,
                            slAtrMult: 1.5, blockBothQuiet: true, timeCutMin: 60,
                            leverage: 10, minHoldMinutes: 5, beTriggerPct: 0.001
                        };
                        const trades = discoverTrades(allTicks, p);
                        if (trades.length < 5) continue;
                        const sim = simulateAll(trades, ticksBySymbol, p);
                        const sum = summarize(sim);

                        let score = sum.winRate * 10 + (sum.totalPnl / 100) + Math.log2(sum.traded);
                        results.push({ params: p, summary: sum, score });
                    }
                }
            }
        }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, 10);
}

export async function runHistoricalBacktest(db, params) {
    // This would typically fetch from Binance, but for this environment 
    // we fallback to the longest available local history
    return runBacktest(db, { ...params, limit: 5000 });
}

// --- Helper Functions (Private) ---

function discoverTrades(allTicks, params) {
    const symbolStates = {};
    const virtualTrades = [];

    for (const t of allTicks) {
        if (!symbolStates[t.symbol]) symbolStates[t.symbol] = { lastExitTime: 0 };
        const state = symbolStates[t.symbol];
        if (t.timestamp < state.lastExitTime + 60000) continue;

        const score = t.accumulation_score || 0;
        const dirOrig = (t.direction || "").toUpperCase();
        const dir = (dirOrig === 'LONG' || (dirOrig === 'UNCLEAR' && score > 0)) ? 'LONG' : (dirOrig === 'SHORT' || (dirOrig === 'UNCLEAR' && score < 0)) ? 'SHORT' : null;
        if (!dir) continue;

        // Pro Filters
        const takerTh = params.takerThresh || 1.03;
        const slopeTh = params.slopeThresh || 0.01;
        const ttDeltaTh = params.ttDeltaThresh || 0.005;

        const takerOk = (dir === 'LONG' ? t.taker_ratio >= takerTh : t.taker_ratio <= (1 / takerTh));
        const slopeOk = (dir === 'LONG' ? t.price_slope >= slopeTh : t.price_slope <= -slopeTh);
        const ttDeltaOk = (dir === 'LONG' ? (t.top_trader_delta || 0) >= ttDeltaTh : (t.top_trader_delta || 0) <= -ttDeltaTh);

        let biasVotes = 0;
        if (takerOk) biasVotes++;
        if (slopeOk) biasVotes++;
        if (ttDeltaOk) biasVotes++;
        if (biasVotes < (params.signalBias || 2)) continue;

        const retail = t.retail_long_pct || 0.5;
        const retailBias = dir === 'LONG' ? retail : (1 - retail);
        if (retailBias > (params.retailLimit || 0.70)) continue;

        if (params.blockBothQuiet && t.cross_asset_status === 'BOTH_QUIET') continue;
        if (t.cross_asset_status === 'CONFLICT') continue;

        if (Math.abs(score) >= (params.accEntryThreshold || 70) && (t.minutes_accumulating || 0) >= (params.accMinDuration || 15)) {
            if (params.requireTransition && (t.tick_oi_acceleration || 0) < 15) continue;

            const slDist = t.price * Math.max(0.003, Math.min(0.012, (t.atr_pct || 0.005) * (params.slAtrMult || 1.5)));
            virtualTrades.push({
                symbol: t.symbol, direction: dir, entry_time: t.timestamp, entry_price: t.price,
                score, taker: t.taker_ratio, slope: t.price_slope, retail: retailBias, oiAcc: t.tick_oi_acceleration,
                quantity: t.symbol.includes('BTC') ? 0.001 : 0.01,
                sl_price: dir === 'LONG' ? t.price - slDist : t.price + slDist,
                exit_time: t.timestamp + 3600000 * 4
            });
            state.lastExitTime = t.timestamp + 600000;
        }
    }
    return virtualTrades;
}

function simulateAll(trades, ticksBySymbol, params) {
    return trades.map(t => simulateTrade(t, ticksBySymbol[t.symbol] || [], params));
}

function simulateTrade(trade, ticks, params) {
    const dir = trade.direction === 'LONG' ? 1 : -1;
    const tradeTicks = ticks.filter(t => t.timestamp >= trade.entry_time && t.timestamp <= trade.entry_time + 3600000 * 4);
    if (!tradeTicks.length) return { reason: 'NO_DATA', pnl_inr: 0 };

    const slDist = Math.abs(trade.entry_price - trade.sl_price);
    const tp_price = dir === 1 ? trade.entry_price + slDist * (params.tpSlRatio || 2.0) : trade.entry_price - slDist * (params.tpSlRatio || 2.0);

    let maxPnl = 0;
    for (const tick of tradeTicks) {
        const holdMin = (tick.timestamp - trade.entry_time) / 60000;
        const pnlPct = (tick.price - trade.entry_price) / trade.entry_price * dir;

        if (dir === 1 && tick.price <= trade.sl_price) return calcExit(trade, tick.price, 'STOP_LOSS', holdMin);
        if (dir === -1 && tick.price >= trade.sl_price) return calcExit(trade, tick.price, 'STOP_LOSS', holdMin);
        if (dir === 1 && tick.price >= tp_price) return calcExit(trade, tick.price, 'TAKE_PROFIT', holdMin);
        if (dir === -1 && tick.price <= tp_price) return calcExit(trade, tick.price, 'TAKE_PROFIT', holdMin);

        if (holdMin >= (params.timeCutMin || 60) && pnlPct < 0.0005) return calcExit(trade, tick.price, 'TIME_SCRATCH', holdMin);
        if (holdMin > 5 && (tick.oi_change_5m || 0) <= -0.3) return calcExit(trade, tick.price, 'OI_DROP_EXIT', holdMin);

        if (pnlPct > maxPnl) maxPnl = pnlPct;
        if (maxPnl >= 0.005 && pnlPct <= maxPnl - 0.003) return calcExit(trade, tick.price, 'TRAILING_STOP', holdMin);
    }
    const last = tradeTicks[tradeTicks.length - 1];
    return calcExit(trade, last.price, 'END_OF_DATA', (last.timestamp - trade.entry_time) / 60000);
}

function calcExit(trade, price, reason, hold) {
    const pnl = (price - trade.entry_price) / trade.entry_price * (trade.direction === 'LONG' ? 1 : -1);
    const val = trade.quantity * trade.entry_price * USD_INR;
    return {
        symbol: trade.symbol, direction: trade.direction, entry_time: trade.entry_time,
        entry_price: trade.entry_price,
        score: trade.score, taker: trade.taker, slope: trade.slope, retail: trade.retail, oiAcc: trade.oiAcc,
        reason, pnl_inr: (pnl * val * 10) - (val * 10 * FEE_PCT), hold
    };
}

function summarize(results) {
    let wins = 0, totalPnl = 0, blocked = 0;
    const bySymbol = {};
    for (const r of results) {
        if (r.reason === 'BLOCKED') { blocked++; continue; }
        totalPnl += r.pnl_inr;
        if (r.pnl_inr > 0) wins++;
        if (!bySymbol[r.symbol]) bySymbol[r.symbol] = { wins: 0, traded: 0, pnl: 0 };
        bySymbol[r.symbol].traded++;
        bySymbol[r.symbol].pnl += r.pnl_inr;
        if (r.pnl_inr > 0) bySymbol[r.symbol].wins++;
    }
    const traded = results.length - blocked;
    return {
        traded, wins, totalPnL: totalPnl,
        winRate: traded > 0 ? Math.round(wins / traded * 100) : 0,
        avgPnl: traded > 0 ? totalPnl / traded : 0,
        blocked, bySymbol
    };
}
