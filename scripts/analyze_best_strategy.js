import fs from 'fs';

const USD_INR = 85;
const FEE_PCT = 0.001;

function round(n) { return Math.round((n || 0) * 100) / 100; }

function discoverTrades(allTicks, params) {
    const symbolStates = {};
    const virtualTrades = [];

    for (const tick of allTicks) {
        const symbol = tick.symbol;
        if (!symbolStates[symbol]) symbolStates[symbol] = { lastExitTime: 0 };
        const state = symbolStates[symbol];

        // 1-minute cooldown between trades for the same symbol
        if (tick.timestamp < state.lastExitTime + 60000) continue;

        const dirOrig = (tick.direction || "").toUpperCase();
        const score = tick.accumulation_score || 0;

        // Direction logic from backtest_engine.js
        const dir = (dirOrig === 'LONG' || (dirOrig === 'UNCLEAR' && score > 0)) ? 'LONG' : (dirOrig === 'SHORT' || (dirOrig === 'UNCLEAR' && score < 0)) ? 'SHORT' : null;
        if (!dir) continue;

        const takerThresh = params.TAKER_THRESH || 0;
        const slopeThresh = params.SLOPE_THRESH || 0;
        const absThresh = params.ABSORPTION_THRESH || 0;
        const taker = tick.taker_ratio || 1.0;
        const slope = tick.price_slope || 0;

        const takerOk = takerThresh === 0 || (dir === 'LONG' ? taker > takerThresh : taker < (1 / takerThresh));
        const slopeOk = slopeThresh === 0 || (dir === 'LONG' ? slope > -0.01 : slope < -slopeThresh);
        const absOk = absThresh === 0 || (tick.tick_absorption || 0) >= absThresh;

        const crossAsset = tick.cross_asset_status || 'UNCLEAR';
        if (params.BLOCK_BOTH_QUIET && crossAsset === 'BOTH_QUIET') continue;

        if (Math.abs(score) >= (params.ACC_ENTRY_THRESHOLD || 55) &&
            (tick.minutes_accumulating || 0) >= (params.ACC_MIN_DURATION || 7) &&
            takerOk && slopeOk && absOk) {

            const slMult = params.SL_ATR_MULT || 1.5;
            const slDist = tick.price * (tick.atr_pct || 0.005) * slMult;

            virtualTrades.push({
                id: `v_${symbol}_${tick.timestamp}`,
                symbol, direction: dir, entry_time: tick.timestamp, entry_price: tick.price,
                quantity: symbol.includes('BTC') ? 0.001 : 0.01,
                sl_price: dir === 'LONG' ? tick.price - slDist : tick.price + slDist,
                acc_score_at_entry: Math.abs(score),
                taker_ratio_at_entry: taker,
                price_slope_at_entry: slope,
                tick_absorption: tick.tick_absorption || 0,
                cross_asset_status_at_entry: crossAsset,
                exit_time: tick.timestamp + 3600000 * 24 // Allow up to 24h
            });
            // Cooldown to avoid multiple entries on same signal
            state.lastExitTime = tick.timestamp + 600000;
        }
    }
    return virtualTrades;
}

function simulateTrade(trade, ticks, params) {
    const dir = trade.direction === 'LONG' ? 1 : -1;
    const leverage = params.LEVERAGE || 10;
    const leverageFactor = leverage / 10;

    const tradeTicks = ticks.filter(t => t.timestamp >= trade.entry_time && t.timestamp <= trade.entry_time + 3600000 * 4); // Max 4h hold for backtest
    if (tradeTicks.length === 0) return { reason: 'NO_DATA', pnl_inr: 0, hold: 0 };

    const slDist = Math.abs(trade.entry_price - trade.sl_price);
    const newTp = dir === 1 ? trade.entry_price + slDist * params.TP_SL_RATIO : trade.entry_price - slDist * params.TP_SL_RATIO;

    let maxPnl = 0;
    for (const tick of tradeTicks) {
        const holdMin = (tick.timestamp - trade.entry_time) / 60000;
        const price = tick.price;
        if (!price || price <= 0) continue;
        const pnlPct = (price - trade.entry_price) / trade.entry_price * dir;

        // Time Cut
        if (holdMin >= params.TIME_CUT_MIN && pnlPct < 0.0005) return makeExit(trade, price, 'TIME_SCRATCH', holdMin, leverageFactor);

        // Break-Even Trigger
        let currentSl = trade.sl_price;
        if (pnlPct >= (params.BE_TRIGGER_PCT || 0.001)) currentSl = trade.entry_price;

        // Exit Logic
        if (dir === 1 && price <= currentSl) return makeExit(trade, price, 'STOP_LOSS', holdMin, leverageFactor);
        if (dir === -1 && price >= currentSl) return makeExit(trade, price, 'STOP_LOSS', holdMin, leverageFactor);
        if (dir === 1 && price >= newTp) return makeExit(trade, price, 'TAKE_PROFIT', holdMin, leverageFactor);
        if (dir === -1 && price <= newTp) return makeExit(trade, price, 'TAKE_PROFIT', holdMin, leverageFactor);

        // Trailing Stop (Subtle)
        if (pnlPct > maxPnl) maxPnl = pnlPct;
        const tsTrigger = 0.005; const tsOffset = 0.003;
        if (maxPnl >= tsTrigger && pnlPct <= maxPnl - tsOffset) return makeExit(trade, price, 'TRAILING_STOP', holdMin, leverageFactor);
    }

    const last = tradeTicks[tradeTicks.length - 1];
    return makeExit(trade, last.price, 'END_OF_DATA', (last.timestamp - trade.entry_time) / 60000, leverageFactor);
}

function makeExit(trade, exitPrice, reason, holdMin, leverageFactor = 1) {
    const dir = trade.direction === 'LONG' ? 1 : -1;
    const pnl = (exitPrice - trade.entry_price) / trade.entry_price * dir;
    const basePosVal = (trade.quantity || 0.01) * trade.entry_price * USD_INR;
    const pnl_inr = (pnl * basePosVal * leverageFactor) - (basePosVal * leverageFactor * FEE_PCT);
    return { symbol: trade.symbol, direction: trade.direction, entry_time: trade.entry_time, reason, pnl_inr, hold: holdMin, exit_price: exitPrice };
}

async function runAnalysis() {
    console.log('Loading tick logs...');
    const data = JSON.parse(fs.readFileSync('tick_logs.json'));
    const allTicks = data[0].results.sort((a, b) => a.timestamp - b.timestamp);
    console.log(`Loaded ${allTicks.length} ticks.`);

    const ticksBySymbol = {};
    for (const t of allTicks) {
        if (!ticksBySymbol[t.symbol]) ticksBySymbol[t.symbol] = [];
        ticksBySymbol[t.symbol].push(t);
    }

    const grid = {
        accEntry: [60, 65, 70, 75, 80],
        accDuration: [7, 10, 15],
        tpSlRatio: [2.0, 2.5, 3.0, 3.5],
        slMult: [1.5, 2.0],
        timeCut: [30, 45, 60],
        takerTh: [1.03, 1.05, 1.10],
        blockQuiet: [true, false]
    };

    const results = [];
    console.log('Starting Grid Search...');

    for (const acc of grid.accEntry) {
        for (const dur of grid.accDuration) {
            for (const tpSl of grid.tpSlRatio) {
                for (const slM of grid.slMult) {
                    for (const cut of grid.timeCut) {
                        for (const taker of grid.takerTh) {
                            for (const bq of grid.blockQuiet) {
                                const p = {
                                    ACC_ENTRY_THRESHOLD: acc,
                                    ACC_MIN_DURATION: dur,
                                    TP_SL_RATIO: tpSl,
                                    SL_ATR_MULT: slM,
                                    TIME_CUT_MIN: cut,
                                    TAKER_THRESH: taker,
                                    BLOCK_BOTH_QUIET: bq,
                                    SLOPE_THRESH: 0.01,
                                    BE_TRIGGER_PCT: 0.001,
                                    LEVERAGE: 10
                                };

                                const discovered = discoverTrades(allTicks, p);
                                if (discovered.length === 0) continue;

                                const sim = discovered.map(t => simulateTrade(t, ticksBySymbol[t.symbol], p));

                                let wins = 0, totalPnl = 0;
                                for (const r of sim) {
                                    totalPnl += r.pnl_inr;
                                    if (r.pnl_inr > 0) wins++;
                                }

                                const winRate = (wins / sim.length) * 100;
                                // Scoring: prioritize Win Rate > 55% AND Trade Count > 5
                                let score = winRate * 10 + (totalPnl / USD_INR) + Math.log2(sim.length);

                                results.push({
                                    params: p,
                                    winRate,
                                    totalPnl,
                                    tradeCount: sim.length,
                                    score
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    console.log(`Analyzed ${results.length} combinations.`);

    const sorted = results.sort((a, b) => b.score - a.score);

    console.log('\n--- TOP 5 STRATEGIES ---');
    sorted.slice(0, 5).forEach((r, i) => {
        console.log(`${i + 1}. WR: ${r.winRate.toFixed(1)}%, PnL: ₹${r.totalPnl.toFixed(2)}, Trades: ${r.tradeCount}`);
        console.log(`   Params: ${JSON.stringify(r.params)}`);
    });

    const bestByWinRate = results.filter(r => r.tradeCount >= 10).sort((a, b) => b.winRate - a.winRate)[0];
    console.log('\n--- BEST FOR MAX WIN RATE (min 10 trades) ---');
    if (bestByWinRate) {
        console.log(`WR: ${bestByWinRate.winRate.toFixed(1)}%, PnL: ₹${bestByWinRate.totalPnl.toFixed(2)}, Trades: ${bestByWinRate.tradeCount}`);
        console.log(`Params: ${JSON.stringify(bestByWinRate.params)}`);
    }

    const bestByProfit = results.filter(r => r.tradeCount >= 5).sort((a, b) => b.totalPnl - a.totalPnl)[0];
    console.log('\n--- BEST FOR MAX PROFIT ---');
    if (bestByProfit) {
        console.log(`WR: ${bestByProfit.winRate.toFixed(1)}%, PnL: ₹${bestByProfit.totalPnl.toFixed(2)}, Trades: ${bestByProfit.tradeCount}`);
        console.log(`Params: ${JSON.stringify(bestByProfit.params)}`);
    }

    const currentParams = {
        ACC_ENTRY_THRESHOLD: 70,
        ACC_MIN_DURATION: 7,
        TP_SL_RATIO: 2.5,
        SL_ATR_MULT: 1.5,
        TIME_CUT_MIN: 45,
        TAKER_THRESH: 1.03,
        BLOCK_BOTH_QUIET: true,
        SLOPE_THRESH: 0.01,
        BE_TRIGGER_PCT: 0.001,
        LEVERAGE: 10
    };
    const currentDiscovered = discoverTrades(allTicks, currentParams);
    const currentSim = currentDiscovered.map(t => simulateTrade(t, ticksBySymbol[t.symbol], currentParams));
    let curWins = 0, curPnl = 0;
    for (const r of currentSim) { curPnl += r.pnl_inr; if (r.pnl_inr > 0) curWins++; }
    console.log('\n--- CURRENT PRODUCTION BASELINE (v2.0) ---');
    console.log(`WR: ${(curWins / currentSim.length * 100).toFixed(1)}%, PnL: ₹${curPnl.toFixed(2)}, Trades: ${currentSim.length}`);
}

runAnalysis().catch(console.error);
