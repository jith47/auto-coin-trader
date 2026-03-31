import fs from 'fs';

const USD_INR = 85;
const FEE_PCT = 0.001;

function round(n) { return Math.round((n || 0) * 100) / 100; }

function discoverTrades(allTicks, params) {
    const symbolStates = {};
    const virtualTrades = [];

    for (let i = 0; i < allTicks.length; i++) {
        const tick = allTicks[i];
        const symbol = tick.symbol;
        if (!symbolStates[symbol]) symbolStates[symbol] = { lastExitTime: 0 };
        const state = symbolStates[symbol];

        if (tick.timestamp < state.lastExitTime + 60000) continue;

        const score = tick.accumulation_score || 0;
        const dirOrig = (tick.direction || "").toUpperCase();
        const dir = (dirOrig === 'LONG' || (dirOrig === 'UNCLEAR' && score > 0)) ? 'LONG' : (dirOrig === 'SHORT' || (dirOrig === 'UNCLEAR' && score < 0)) ? 'SHORT' : null;
        if (!dir) continue;

        // Entry Filters (Advanced V2)
        const takerOk = (dir === 'LONG' ? tick.taker_ratio >= params.TAKER_LONG : tick.taker_ratio <= params.TAKER_SHORT);
        const slopeOk = (dir === 'LONG' ? tick.price_slope >= params.SLOPE_LONG : tick.price_slope <= params.SLOPE_SHORT);

        // OI Change Filter (The "Rich" Indicator)
        const oiOk = (dir === 'LONG' ? (tick.oi_change_1m || 0) >= params.OI_MIN : (tick.oi_change_1m || 0) <= -params.OI_MIN);

        // Exhaustion/Absorption Check
        // If price is moving but OI is stagnant/dropping, it might be exhaustion
        const exhaustion = (dir === 'LONG' && tick.price_slope > 0.02 && (tick.oi_change_1m || 0) < 0) || (dir === 'SHORT' && tick.price_slope < -0.02 && (tick.oi_change_1m || 0) > 0);
        if (params.FILTER_EXHAUSTION && exhaustion) continue;

        let biasVotes = 0;
        if (takerOk) biasVotes++;
        if (slopeOk) biasVotes++;
        if (oiOk) biasVotes++;

        if (biasVotes < (params.SIGNAL_BIAS || 2)) continue;

        const retail = tick.retail_long_pct || 0.5;
        const retailBias = dir === 'LONG' ? retail : (1 - retail);
        if (retailBias > params.RETAIL_LIMIT) continue;

        if (tick.cross_asset_status === 'BOTH_QUIET' && params.BLOCK_QUIET) continue;
        if (tick.cross_asset_status === 'CONFLICT') continue;

        if (Math.abs(score) >= params.ACC_ENTRY && (tick.minutes_accumulating || 0) >= params.ACC_DUR) {

            // Required Transition (OI Acceleration)
            if (params.REQUIRE_TRANSITION && (tick.tick_oi_acceleration || 0) < 15) continue;

            const slDistPct = Math.max(0.003, Math.min(0.012, (tick.atr_pct || 0.005) * params.SL_MULT));
            const slDist = tick.price * slDistPct;

            virtualTrades.push({
                id: `v_${symbol}_${tick.timestamp}`,
                symbol, direction: dir, entry_time: tick.timestamp, entry_price: tick.price,
                quantity: symbol.includes('BTC') ? 0.001 : 0.01,
                sl_price: dir === 'LONG' ? tick.price - slDist : tick.price + slDist,
                tp_price: dir === 'LONG' ? tick.price + slDist * params.TP_SL_RATIO : tick.price - slDist * params.TP_SL_RATIO,
                atr_at_entry: tick.atr_pct || 0.005,
                exit_time: tick.timestamp + 3600000 * 4
            });
            state.lastExitTime = tick.timestamp + 600000;
        }
    }
    return virtualTrades;
}

function simulateTrade(trade, ticks, params) {
    const dir = trade.direction === 'LONG' ? 1 : -1;
    const tradeTicks = ticks.filter(t => t.timestamp >= trade.entry_time && t.timestamp <= trade.entry_time + 3600000 * 4);
    if (tradeTicks.length === 0) return { pnl_inr: 0, reason: 'NO_DATA' };

    let maxPnl = 0;
    for (let i = 0; i < tradeTicks.length; i++) {
        const tick = tradeTicks[i];
        const holdMin = (tick.timestamp - trade.entry_time) / 60000;
        const pnlPct = (tick.price - trade.entry_price) / trade.entry_price * dir;

        if (dir === 1 && tick.price <= trade.sl_price) return makeExit(trade, tick.price, 'STOP_LOSS', holdMin);
        if (dir === -1 && tick.price >= trade.sl_price) return makeExit(trade, tick.price, 'STOP_LOSS', holdMin);
        if (dir === 1 && tick.price >= trade.tp_price) return makeExit(trade, tick.price, 'TAKE_PROFIT', holdMin);
        if (dir === -1 && tick.price <= trade.tp_price) return makeExit(trade, tick.price, 'TAKE_PROFIT', holdMin);

        // Time Cut
        if (holdMin >= params.TIME_CUT && pnlPct < 0.0005) return makeExit(trade, tick.price, 'TIME_SCRATCH', holdMin);

        // Dynamic Exit on OI reversal
        if (holdMin > 5 && (tick.oi_change_5m || 0) <= -0.5 && pnlPct > 0.002) return makeExit(trade, tick.price, 'OI_REVERSAL_EXIT', holdMin);

        if (pnlPct > maxPnl) maxPnl = pnlPct;
        const tsTrigger = 0.005; const tsOffset = 0.003;
        if (maxPnl >= tsTrigger && pnlPct <= maxPnl - tsOffset) return makeExit(trade, tick.price, 'TRAILING_STOP', holdMin);
    }
    const last = tradeTicks[tradeTicks.length - 1];
    return makeExit(trade, last.price, 'END_OF_DATA', (last.timestamp - trade.entry_time) / 60000);
}

function makeExit(trade, price, reason, holdMin) {
    const dir = trade.direction === 'LONG' ? 1 : -1;
    const pnl = (price - trade.entry_price) / trade.entry_price * dir;
    const baseVal = (trade.quantity || 0.01) * trade.entry_price * USD_INR;
    const pnl_inr = (pnl * baseVal * 10) - (baseVal * 10 * FEE_PCT);
    return { pnl_inr, reason, hold: holdMin };
}

async function runAdvancedAnalysis() {
    const data = JSON.parse(fs.readFileSync('tick_logs.json'));
    const allTicks = data[0].results.sort((a, b) => a.timestamp - b.timestamp);
    const ticksBySymbol = {};
    allTicks.forEach(t => { if (!ticksBySymbol[t.symbol]) ticksBySymbol[t.symbol] = []; ticksBySymbol[t.symbol].push(t); });

    console.log(`Analyzing ${allTicks.length} ticks for Advanced opportunities...`);

    const grid = {
        accEntry: [85, 90],
        accDur: [15, 20],
        tpSl: [1.5, 2.0],
        oiMin: [0.1, 0.2, 0.3], // Test different OI change requirements
        signalBias: [2, 3],
        filterExhaustion: [true, false],
        timeCut: [60, 90]
    };

    const results = [];
    for (const acc of grid.accEntry) {
        for (const dur of grid.accDur) {
            for (const tpSl of grid.tpSl) {
                for (const oi of grid.oiMin) {
                    for (const sb of grid.signalBias) {
                        for (const fe of grid.filterExhaustion) {
                            for (const cut of grid.timeCut) {
                                const p = {
                                    ACC_ENTRY: acc, ACC_DUR: dur, TP_SL_RATIO: tpSl, SL_MULT: 1.5,
                                    OI_MIN: oi, SIGNAL_BIAS: sb, FILTER_EXHAUSTION: fe,
                                    TIME_CUT: cut, BLOCK_QUIET: true, REQUIRE_TRANSITION: true,
                                    TAKER_LONG: 1.05, TAKER_SHORT: 0.95, // Tightened
                                    SLOPE_LONG: 0.02, SLOPE_SHORT: -0.02, // Tightened
                                    RETAIL_LIMIT: 0.65
                                };
                                const trades = discoverTrades(allTicks, p);
                                if (trades.length < 5) continue;
                                const sim = trades.map(t => simulateTrade(t, ticksBySymbol[t.symbol], p));
                                let wins = 0, pnl = 0;
                                sim.forEach(r => { pnl += r.pnl_inr; if (r.pnl_inr > 0) wins++; });
                                const wr = (wins / sim.length) * 100;

                                const btcTrades = trades.filter(t => t.symbol === 'BTCUSDT');
                                const ethTrades = trades.filter(t => t.symbol === 'ETHUSDT');
                                const btcWins = sim.filter((r, idx) => trades[idx].symbol === 'BTCUSDT' && r.pnl_inr > 0).length;
                                const ethWins = sim.filter((r, idx) => trades[idx].symbol === 'ETHUSDT' && r.pnl_inr > 0).length;

                                const score = wr * 30 + pnl + (sim.length * 5); // Reward consistency and count more
                                results.push({
                                    params: p, wr, pnl, count: sim.length, score,
                                    btcWR: btcTrades.length ? (btcWins / btcTrades.length) * 100 : 0,
                                    ethWR: ethTrades.length ? (ethWins / ethTrades.length) * 100 : 0,
                                    btcCount: btcTrades.length,
                                    ethCount: ethTrades.length
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    const sorted = results.sort((a, b) => b.pnl - a.pnl);
    console.log('\n--- ADVANCED BEST (Max Profit) ---');
    if (sorted[0]) {
        console.log(`WR: ${sorted[0].wr.toFixed(1)}%, PnL: ₹${sorted[0].pnl.toFixed(2)}, Trades: ${sorted[0].count}`);
        console.log(`Params: ${JSON.stringify(sorted[0].params)}`);
    }

    const maxWR = results.filter(r => r.count >= 10).sort((a, b) => b.wr - a.wr)[0];
    console.log('\n--- BEST FOR WIN RATE (Min 10 trades) ---');
    if (maxWR) {
        console.log(`Overall WR: ${maxWR.wr.toFixed(1)}%, PnL: ₹${maxWR.pnl.toFixed(2)}, Trades: ${maxWR.count}`);
        console.log(`BTC WR: ${maxWR.btcWR.toFixed(1)}% (${maxWR.btcCount} trades), ETH WR: ${maxWR.ethWR.toFixed(1)}% (${maxWR.ethCount} trades)`);
        console.log(`Params: ${JSON.stringify(maxWR.params)}`);
    }

    const highFreq = results.sort((a, b) => b.count - a.count)[0];
    console.log('\n--- HIGHEST FREQUENCY ---');
    if (highFreq) {
        console.log(`WR: ${highFreq.wr.toFixed(1)}%, PnL: ₹${highFreq.pnl.toFixed(2)}, Trades: ${highFreq.count}`);
        console.log(`Params: ${JSON.stringify(highFreq.params)}`);
    }
}

runAdvancedAnalysis().catch(console.error);
