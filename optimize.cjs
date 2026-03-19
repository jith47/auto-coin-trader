#!/usr/bin/env node
/**
 * OI Flow Rider — Parametric Sweep Optimizer
 * 
 * Runs a sweep across TP_SL_RATIO values to find the optimal balance 
 * between win rate and reward-to-risk.
 */

const fs = require('fs');

// ─── Load Data ─────────────────────────────────────────────────
const tradesRaw = JSON.parse(fs.readFileSync('/tmp/trades_export.json', 'utf8'));
const ticksRaw = JSON.parse(fs.readFileSync('/tmp/ticks_export.json', 'utf8'));

const trades = tradesRaw[0]?.results || [];
const allTicks = ticksRaw[0]?.results || [];

console.log(`Loaded ${trades.length} trades, ${allTicks.length} ticks\n`);

// ─── Constants ─────────────────────────────────────────────────
const USD_INR = 85;
const FEE_PCT = 0.001;

const ticksBySymbol = {};
for (const t of allTicks) {
    if (!ticksBySymbol[t.symbol]) ticksBySymbol[t.symbol] = [];
    ticksBySymbol[t.symbol].push(t);
}
for (const sym of Object.keys(ticksBySymbol)) {
    ticksBySymbol[sym].sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Simulation Logic ──────────────────────────────────────────
function simulateTrade(trade, tpSlRatio) {
    const ticks = ticksBySymbol[trade.symbol] || [];
    const dir = trade.direction === 'LONG' ? 1 : -1;

    // Phase 1: Block BOTH_QUIET
    if (trade.cross_asset_status_at_entry === 'BOTH_QUIET') {
        return { action: 'BLOCKED', pnl_inr: 0 };
    }

    const slDist = Math.abs(trade.entry_price - trade.sl_price);
    const newTp = dir === 1 ? trade.entry_price + (slDist * tpSlRatio) : trade.entry_price - (slDist * tpSlRatio);

    const tradeTicks = ticks.filter(t => t.timestamp >= trade.entry_time && t.timestamp <= trade.exit_time + 60000);
    if (tradeTicks.length === 0) return { action: 'NO_DATA', pnl_inr: trade.pnl_inr };

    let prevTicks = [];
    for (const tick of tradeTicks) {
        const holdMin = (tick.timestamp - trade.entry_time) / 60000;
        const pnlPct = (tick.price - trade.entry_price) / trade.entry_price * dir;

        // SL (Always active)
        if (dir === 1 && tick.price <= trade.sl_price) return exitResult(trade, tick.price, holdMin);
        if (dir === -1 && tick.price >= trade.sl_price) return exitResult(trade, tick.price, holdMin);

        // TP (Always active)
        if (dir === 1 && tick.price >= newTp) return exitResult(trade, tick.price, holdMin);
        if (dir === -1 && tick.price <= newTp) return exitResult(trade, tick.price, holdMin);

        // Grace Period (5 min)
        if (holdMin < 5) {
            prevTicks.push(tick);
            continue;
        }

        // Noise Exits (VOL_WT_OI @ 0.2%)
        if (tick.volume_ratio > 1.5 && Math.abs(tick.oi_change_5m || 0) < 0.2) {
            return exitResult(trade, tick.price, holdMin);
        }

        // OI_DECEL
        if (pnlPct > 0 && prevTicks.length >= 3) {
            const oi0 = tick.oi_change_1m || 0;
            const oi1 = prevTicks[prevTicks.length - 1]?.oi_change_1m || 0;
            const oi2 = prevTicks[prevTicks.length - 2]?.oi_change_1m || 0;
            if (false && oi0 < oi1) return exitResult(trade, tick.price, holdMin);
        }

        prevTicks.push(tick);
    }

    const lastTick = tradeTicks[tradeTicks.length - 1];
    return exitResult(trade, lastTick.price, (lastTick.timestamp - trade.entry_time) / 60000);
}

function exitResult(trade, exitPrice, holdMin) {
    const dir = trade.direction === 'LONG' ? 1 : -1;
    const pnl = (exitPrice - trade.entry_price) / trade.entry_price * dir;
    const posVal = trade.quantity * trade.entry_price * USD_INR;
    const pnlInr = (pnl * posVal) - (posVal * FEE_PCT);
    return { action: 'CLOSED', pnl_inr: pnlInr, hold: holdMin };
}

// ─── Sweep ─────────────────────────────────────────────────────
console.log('Score Thresh'.padEnd(15) + 'TOTAL P&L'.padEnd(15) + 'WIN RATE'.padEnd(12) + 'TRADES'.padEnd(10) + 'AVG P&L');
console.log('─'.repeat(60));

const sweepResults = [];

for (let threshold = 55; threshold <= 80; threshold += 5) {
    let totalPnl = 0;
    let wins = 0;
    let losses = 0;
    let taken = 0;

    for (const trade of trades) {
        // Recalculate if it would be blocked by score
        if (trade.acc_score_at_entry < threshold) continue;

        const res = simulateTrade(trade, 2.5); // Use fixed 2.5 ratio
        if (res.action === 'CLOSED') {
            taken++;
            totalPnl += res.pnl_inr;
            if (res.pnl_inr > 0) wins++;
            else losses++;
        }
    }

    const wr = taken > 0 ? ((wins / taken) * 100).toFixed(1) : '0.0';
    const avg = taken > 0 ? (totalPnl / taken).toFixed(0) : '0';

    console.log(
        threshold.toString().padEnd(15) +
        `₹${totalPnl.toFixed(0)}`.padEnd(15) +
        `${wr}%`.padEnd(12) +
        `${taken}`.padEnd(10) +
        `₹${avg}`
    );

    sweepResults.push({ threshold, totalPnl, wr: parseFloat(wr), taken, avg: parseInt(avg) });
}

const best = sweepResults.reduce((prev, current) => (prev.totalPnl > current.totalPnl) ? prev : current);
console.log('\nOPTIMAL SCORE THRESHOLD:', best.threshold, `(Total P&L: ₹${best.totalPnl.toFixed(0)})`);
