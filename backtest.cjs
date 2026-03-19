#!/usr/bin/env node
/**
 * OI Flow Rider — Backtest Replay
 * 
 * Replays historical tick data with OLD vs NEW parameters to compare outcomes.
 * Uses exported D1 data from /tmp/trades_export.json and /tmp/ticks_export.json.
 */

const fs = require('fs');

// ─── Load Data ─────────────────────────────────────────────────
const tradesRaw = JSON.parse(fs.readFileSync('/tmp/trades_export.json', 'utf8'));
const ticksRaw = JSON.parse(fs.readFileSync('/tmp/ticks_export.json', 'utf8'));

const trades = tradesRaw[0]?.results || [];
const allTicks = ticksRaw[0]?.results || [];

console.log(`Loaded ${trades.length} trades, ${allTicks.length} ticks\n`);

// ─── Parameter Sets ─────────────────────────────────────────────
const OLD_PARAMS = {
    name: 'OLD (Current)',
    ABSORPTION_FLIP_PRICE_CHANGE: 0.02,  // 0.02 in priceChange()
    VOL_WT_OI_THRESHOLD: 0.05,           // abs(oiChange5m) < 0.05
    VOL_OI_DIVERGENCE: 1.5,
    MIN_HOLD_MINUTES: 0,                  // No grace period
    BLOCK_BOTH_QUIET: false,
    TAKER_LONG: 1.03,
    SLOPE_LONG: 0.01,
    TP_SL_RATIO: 2.5,
    OI_DECEL_REQUIRE_PROFIT: false,       // Current: only checks pnlPct > 0
    OI_DECEL_MIN_PROFIT_PCT: 0,
};

const NEW_PARAMS = {
    name: 'NEW (Proposed)',
    ABSORPTION_FLIP_PRICE_CHANGE: 0.005,  // Raised to 0.5%
    VOL_WT_OI_THRESHOLD: 0.2,            // Raised to 0.2%
    VOL_OI_DIVERGENCE: 1.5,
    MIN_HOLD_MINUTES: 5,                  // 5-min grace period
    BLOCK_BOTH_QUIET: true,               // Block BOTH_QUIET entries
    TAKER_LONG: 1.05,                     // Tighter
    SLOPE_LONG: 0.02,                     // Tighter
    TP_SL_RATIO: 1.8,                     // Reduced
    OI_DECEL_REQUIRE_PROFIT: false,
    OI_DECEL_MIN_PROFIT_PCT: 0,
};

const USD_INR = 85;
const FEE_PCT = 0.001;

// ─── Build tick index by symbol ────────────────────────────────
const ticksBySymbol = {};
for (const t of allTicks) {
    if (!ticksBySymbol[t.symbol]) ticksBySymbol[t.symbol] = [];
    ticksBySymbol[t.symbol].push(t);
}

// Sort by timestamp
for (const sym of Object.keys(ticksBySymbol)) {
    ticksBySymbol[sym].sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Simulate Trade with Parameters ────────────────────────────
function simulateTrade(trade, params) {
    const symbol = trade.symbol;
    const ticks = ticksBySymbol[symbol] || [];
    const dir = trade.direction === 'LONG' ? 1 : -1;

    // Check entry gate
    if (params.BLOCK_BOTH_QUIET && trade.cross_asset_status_at_entry === 'BOTH_QUIET') {
        return { action: 'BLOCKED', reason: 'BOTH_QUIET_BLOCKED', pnl_inr: 0, hold: 0 };
    }

    // Recalculate TP based on new ratio
    const slDist = Math.abs(trade.entry_price - trade.sl_price);
    const newTpDist = slDist * params.TP_SL_RATIO;
    const newTp = dir === 1 ? trade.entry_price + newTpDist : trade.entry_price - newTpDist;

    // Find ticks during this trade's window
    const tradeTicks = ticks.filter(t => t.timestamp >= trade.entry_time && t.timestamp <= trade.exit_time + 60000);

    if (tradeTicks.length === 0) {
        return { action: 'NO_DATA', reason: 'NO_TICKS', pnl_inr: trade.pnl_inr, hold: trade.hold_time_minutes };
    }

    // Replay tick by tick
    let prevTicks = [];
    for (const tick of tradeTicks) {
        const holdMin = (tick.timestamp - trade.entry_time) / 60000;
        const price = tick.price;
        const pnlPct = (price - trade.entry_price) / trade.entry_price * dir;

        // SL check (always active)
        if (dir === 1 && price <= trade.sl_price) {
            return exitResult(trade, price, 'STOP_LOSS', holdMin);
        }
        if (dir === -1 && price >= trade.sl_price) {
            return exitResult(trade, price, 'STOP_LOSS', holdMin);
        }

        // TP check with new TP level
        if (dir === 1 && price >= newTp) {
            return exitResult(trade, price, 'TAKE_PROFIT', holdMin);
        }
        if (dir === -1 && price <= newTp) {
            return exitResult(trade, price, 'TAKE_PROFIT', holdMin);
        }

        // Grace period — skip other exits if within MIN_HOLD
        if (holdMin < params.MIN_HOLD_MINUTES) {
            prevTicks.push(tick);
            continue;
        }

        // VOL_WT_OI exit
        if (tick.volume_ratio > params.VOL_OI_DIVERGENCE) {
            const oiChange5m = Math.abs(tick.oi_change_5m || 0);
            if (oiChange5m < params.VOL_WT_OI_THRESHOLD) {
                return exitResult(trade, price, 'VOL_WT_OI', holdMin);
            }
        }

        // ABSORPTION_FLIP exit — check if in profit and price moved substantially
        if (pnlPct > 0 && prevTicks.length >= 3) {
            // Compute recent price change (3 ticks)
            const prev3Price = prevTicks[prevTicks.length - 3]?.price;
            if (prev3Price) {
                const recentMove = Math.abs((price - prev3Price) / prev3Price);
                if (recentMove > params.ABSORPTION_FLIP_PRICE_CHANGE) {
                    // Check volume drop (approximate)
                    return exitResult(trade, price, 'ABSORPTION_FLIP', holdMin);
                }
            }
        }

        // OI_DECEL exit
        if (pnlPct > 0 && prevTicks.length >= 3) {
            const oi0 = tick.oi_change_1m || 0;
            const oi1 = prevTicks[prevTicks.length - 1]?.oi_change_1m || 0;
            const oi2 = prevTicks[prevTicks.length - 2]?.oi_change_1m || 0;
            if (oi0 < oi1 && oi1 < oi2 && oi2 > 0) {
                return exitResult(trade, price, 'OI_DECEL', holdMin);
            }
        }

        // TIME_STOP
        if (holdMin >= 45) {
            return exitResult(trade, price, 'TIME_STOP', holdMin);
        }

        prevTicks.push(tick);
    }

    // If we ran out of ticks, use the last tick price
    const lastTick = tradeTicks[tradeTicks.length - 1];
    const finalHold = (lastTick.timestamp - trade.entry_time) / 60000;
    return exitResult(trade, lastTick.price, 'END_OF_DATA', finalHold);
}

function exitResult(trade, exitPrice, reason, holdMin) {
    const dir = trade.direction === 'LONG' ? 1 : -1;
    const pnl = (exitPrice - trade.entry_price) / trade.entry_price * dir;
    const posVal = trade.quantity * trade.entry_price * USD_INR;
    const fee = posVal * FEE_PCT;
    const pnlInr = (pnl * posVal) - fee;
    return {
        action: reason === 'BLOCKED' ? 'BLOCKED' : 'CLOSED',
        reason,
        pnl_inr: pnlInr,
        pnl_pct: (pnl * 100).toFixed(4),
        hold: holdMin.toFixed(1),
        exit_price: exitPrice,
    };
}

// ─── Run Backtest ──────────────────────────────────────────────
function runBacktest(params) {
    const results = [];
    let totalPnl = 0;
    let wins = 0;
    let losses = 0;
    let blocked = 0;

    for (const trade of trades) {
        const result = simulateTrade(trade, params);
        result.id = trade.id;
        result.symbol = trade.symbol;
        result.direction = trade.direction;
        result.entry_price = trade.entry_price;
        result.acc_score = trade.acc_score_at_entry;
        result.cross_asset = trade.cross_asset_status_at_entry;
        results.push(result);

        if (result.action === 'BLOCKED') {
            blocked++;
        } else {
            totalPnl += result.pnl_inr;
            if (result.pnl_inr > 0) wins++;
            else losses++;
        }
    }

    return { params: params.name, results, totalPnl, wins, losses, blocked };
}

// ─── Compare ───────────────────────────────────────────────────
const oldResult = runBacktest(OLD_PARAMS);
const newResult = runBacktest(NEW_PARAMS);

console.log('═══════════════════════════════════════════════════════════════');
console.log('                    BACKTEST COMPARISON');
console.log('═══════════════════════════════════════════════════════════════\n');

function printSummary(r) {
    const traded = r.wins + r.losses;
    const wr = traded > 0 ? ((r.wins / traded) * 100).toFixed(0) : '0';
    console.log(`  ┌─ ${r.params}`);
    console.log(`  │  Trades Taken:  ${traded}  (${r.blocked} blocked)`);
    console.log(`  │  W/L:           ${r.wins}W / ${r.losses}L  (${wr}% WR)`);
    console.log(`  │  Total P&L:     ₹${r.totalPnl.toFixed(2)}`);
    console.log(`  │  Avg P&L:       ₹${traded > 0 ? (r.totalPnl / traded).toFixed(2) : '0'}`);
    console.log(`  └──────────────────────────────────`);
}

printSummary(oldResult);
console.log('');
printSummary(newResult);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('                  TRADE-BY-TRADE COMPARISON');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('ID'.padEnd(35) + 'SYM'.padEnd(8) + 'DIR'.padEnd(7) +
    'OLD_EXIT'.padEnd(25) + 'OLD_PnL'.padEnd(12) + 'OLD_HOLD'.padEnd(10) +
    'NEW_EXIT'.padEnd(25) + 'NEW_PnL'.padEnd(12) + 'NEW_HOLD'.padEnd(10) + 'DIFF');
console.log('─'.repeat(145));

for (let i = 0; i < trades.length; i++) {
    const o = oldResult.results[i];
    const n = newResult.results[i];
    const diff = n.pnl_inr - o.pnl_inr;
    const diffStr = diff > 0 ? `+₹${diff.toFixed(0)}` : `₹${diff.toFixed(0)}`;
    const diffColor = diff > 0 ? '✅' : diff < 0 ? '🔻' : '➖';

    console.log(
        o.id.padEnd(35) +
        o.symbol.replace('USDT', '').padEnd(8) +
        o.direction.padEnd(7) +
        o.reason.padEnd(25) +
        `₹${o.pnl_inr.toFixed(0)}`.padEnd(12) +
        `${o.hold}m`.padEnd(10) +
        n.reason.padEnd(25) +
        `₹${n.pnl_inr.toFixed(0)}`.padEnd(12) +
        `${n.hold}m`.padEnd(10) +
        `${diffColor} ${diffStr}`
    );
}

// ─── Exit Reason Distribution ──────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('               EXIT REASON DISTRIBUTION');
console.log('═══════════════════════════════════════════════════════════════\n');

function exitDist(results) {
    const dist = {};
    for (const r of results) {
        if (!dist[r.reason]) dist[r.reason] = { count: 0, pnl: 0 };
        dist[r.reason].count++;
        dist[r.reason].pnl += r.pnl_inr;
    }
    return dist;
}

const oldDist = exitDist(oldResult.results);
const newDist = exitDist(newResult.results);

console.log('OLD Exit Distribution:');
for (const [reason, data] of Object.entries(oldDist).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${reason.padEnd(25)} ${String(data.count).padEnd(5)} ₹${data.pnl.toFixed(0)}`);
}

console.log('\nNEW Exit Distribution:');
for (const [reason, data] of Object.entries(newDist).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${reason.padEnd(25)} ${String(data.count).padEnd(5)} ₹${data.pnl.toFixed(0)}`);
}

// ─── Impact Summary ────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('                   IMPACT SUMMARY');
console.log('═══════════════════════════════════════════════════════════════\n');

const pnlDiff = newResult.totalPnl - oldResult.totalPnl;
console.log(`  P&L Impact:     ${pnlDiff > 0 ? '+' : ''}₹${pnlDiff.toFixed(2)}`);
console.log(`  Trades Blocked: ${newResult.blocked}`);
console.log(`  Win Rate Change: ${oldResult.wins + oldResult.losses > 0 ? ((oldResult.wins / (oldResult.wins + oldResult.losses)) * 100).toFixed(0) : 0}% → ${newResult.wins + newResult.losses > 0 ? ((newResult.wins / (newResult.wins + newResult.losses)) * 100).toFixed(0) : 0}%`);
