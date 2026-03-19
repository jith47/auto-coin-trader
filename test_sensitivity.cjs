#!/usr/bin/env node
const fs = require('fs');
const tradesRaw = JSON.parse(fs.readFileSync('/tmp/trades_export.json', 'utf8'));
const ticksRaw = JSON.parse(fs.readFileSync('/tmp/ticks_export.json', 'utf8'));
const trades = tradesRaw[0]?.results || [];
const allTicks = ticksRaw[0]?.results || [];

const ticksBySymbol = {};
for (const t of allTicks) {
    if (!ticksBySymbol[t.symbol]) ticksBySymbol[t.symbol] = [];
    ticksBySymbol[t.symbol].push(t);
}

function simulateTrade(trade, ratio) {
    const ticks = ticksBySymbol[trade.symbol] || [];
    const dir = trade.direction === 'LONG' ? 1 : -1;
    const slDist = Math.abs(trade.entry_price - trade.sl_price);
    const tpPrice = trade.entry_price + (slDist * ratio * dir);

    const tradeTicks = ticks.filter(t => t.timestamp >= trade.entry_time && t.timestamp <= trade.exit_time + 60000);
    if (tradeTicks.length === 0) return { action: 'BLOCKED' };

    for (const tick of tradeTicks) {
        if (dir === 1 && tick.price <= trade.sl_price) return { action: 'LOSS', pnl: -1 };
        if (dir === -1 && tick.price >= trade.sl_price) return { action: 'LOSS', pnl: -1 };
        if (dir === 1 && tick.price >= tpPrice) return { action: 'WIN', pnl: ratio };
        if (dir === -1 && tick.price <= tpPrice) return { action: 'WIN', pnl: ratio };
    }
    const last = tradeTicks[tradeTicks.length - 1];
    const pnlFix = (last.price - trade.entry_price) / trade.entry_price * dir / (slDist / trade.entry_price);
    return { action: 'END', pnl: pnlFix };
}

console.log('Ratio'.padEnd(10) + 'WinRate'.padEnd(10) + 'Net R:R');
for (let r = 1.0; r <= 4.1; r += 0.5) {
    let net = 0, wins = 0, count = 0;
    for (const t of trades) {
        const res = simulateTrade(t, r);
        if (res.action !== 'BLOCKED') {
            count++;
            net += res.pnl;
            if (res.action === 'WIN') wins++;
        }
    }
    console.log(r.toFixed(1).padEnd(10) + (wins / count * 100).toFixed(1) + '%' + ' '.repeat(5) + net.toFixed(2));
}
