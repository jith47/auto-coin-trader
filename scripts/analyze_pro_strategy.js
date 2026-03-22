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

        // Entry Filters (Pro Edition)
        const takerOk = (dir === 'LONG' ? tick.taker_ratio >= params.TAKER_LONG : tick.taker_ratio <= params.TAKER_SHORT);
        const slopeOk = (dir === 'LONG' ? tick.price_slope >= params.SLOPE_LONG : tick.price_slope <= params.SLOPE_SHORT);
        const ttDeltaOk = (dir === 'LONG' ? (tick.top_trader_delta || 0) >= (params.TT_DELTA || 0.005) : (tick.top_trader_delta || 0) <= -(params.TT_DELTA || 0.005));

        // Multi-signal logic (from strategy_service.js detectDirection)
        let biasVotes = 0;
        if (takerOk) biasVotes++;
        if (slopeOk) biasVotes++;
        if (ttDeltaOk) biasVotes++;
        if (biasVotes < (params.SIGNAL_BIAS || 2)) continue;

        const retail = tick.retail_long_pct || 0.5;
        const retailBias = dir === 'LONG' ? retail : (1 - retail);
        if (retailBias > params.RETAIL_LIMIT) continue;

        if (tick.cross_asset_status === 'BOTH_QUIET' && params.BLOCK_QUIET) continue;
        if (tick.cross_asset_status === 'CONFLICT') continue;

        if (Math.abs(score) >= params.ACC_ENTRY && (tick.minutes_accumulating || 0) >= params.ACC_DUR) {

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

        if (holdMin >= params.TIME_CUT && pnlPct < 0.0005) return makeExit(trade, tick.price, 'TIME_SCRATCH', holdMin);
        if (holdMin > 5 && (tick.oi_change_5m || 0) <= -0.3) return makeExit(trade, tick.price, 'OI_DROP_EXIT', holdMin);

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

async function runProAnalysis() {
    const data = JSON.parse(fs.readFileSync('tick_logs.json'));
    const allTicks = data[0].results.sort((a, b) => a.timestamp - b.timestamp);
    const ticksBySymbol = {};
    allTicks.forEach(t => { if (!ticksBySymbol[t.symbol]) ticksBySymbol[t.symbol] = []; ticksBySymbol[t.symbol].push(t); });

    console.log(`Analyzing ${allTicks.length} ticks...`);

    const grid = {
        accEntry: [75, 80, 85],
        accDur: [10, 15, 20],
        tpSl: [1.5, 2.0, 2.5],
        retailLimit: [0.60, 0.65, 0.70],
        timeCut: [45, 60, 90],
        signalBias: [2, 3],
        blockQuiet: [true],
        requireTransition: [true]
    };

    const results = [];
    for (const acc of grid.accEntry) {
        for (const dur of grid.accDur) {
            for (const tpSl of grid.tpSl) {
                for (const rl of grid.retailLimit) {
                    for (const cut of grid.timeCut) {
                        for (const sb of grid.signalBias) {
                            for (const bq of grid.blockQuiet) {
                                for (const rt of grid.requireTransition) {
                                    const p = {
                                        ACC_ENTRY: acc, ACC_DUR: dur, TP_SL_RATIO: tpSl, SL_MULT: 1.5,
                                        RETAIL_LIMIT: rl, TIME_CUT: cut, BLOCK_QUIET: bq, REQUIRE_TRANSITION: rt,
                                        TAKER_LONG: 1.03, TAKER_SHORT: 0.97, SLOPE_LONG: 0.01, SLOPE_SHORT: -0.01,
                                        TT_DELTA: 0.005, SIGNAL_BIAS: sb
                                    };
                                    const trades = discoverTrades(allTicks, p);
                                    if (trades.length < 5) continue;
                                    const sim = trades.map(t => simulateTrade(t, ticksBySymbol[t.symbol], p));
                                    let wins = 0, pnl = 0;
                                    sim.forEach(r => { pnl += r.pnl_inr; if (r.pnl_inr > 0) wins++; });
                                    const wr = (wins / sim.length) * 100;
                                    const score = wr * 20 + pnl + Math.log10(sim.length);
                                    results.push({ params: p, wr, pnl, count: sim.length, score });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    const sorted = results.sort((a, b) => b.score - a.score);
    console.log('\n--- PROFESSIONAL BEST (Max Score) ---');
    if (sorted[0]) {
        console.log(`WR: ${sorted[0].wr.toFixed(1)}%, PnL: ₹${sorted[0].pnl.toFixed(2)}, Trades: ${sorted[0].count}`);
        console.log(`Params: ${JSON.stringify(sorted[0].params)}`);
    }

    const maxWR = results.filter(r => r.count >= 10).sort((a, b) => b.wr - a.wr)[0];
    console.log('\n--- BEST FOR MAX WIN RATE (Min 10 trades) ---');
    if (maxWR) {
        console.log(`WR: ${maxWR.wr.toFixed(1)}%, PnL: ₹${maxWR.pnl.toFixed(2)}, Trades: ${maxWR.count}`);
        console.log(`Params: ${JSON.stringify(maxWR.params)}`);
    }

    const maxProfit = results.filter(r => r.count >= 10).sort((a, b) => b.pnl - a.pnl)[0];
    console.log('\n--- BEST FOR MAX PROFIT (Min 10 trades) ---');
    if (maxProfit) {
        console.log(`WR: ${maxProfit.wr.toFixed(1)}%, PnL: ₹${maxProfit.pnl.toFixed(2)}, Trades: ${maxProfit.count}`);
        console.log(`Params: ${JSON.stringify(maxProfit.params)}`);
    }
}

runProAnalysis().catch(console.error);
