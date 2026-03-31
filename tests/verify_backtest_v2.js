import { D1Database } from '../src/db_d1.js';
import { runBacktest } from '../src/backtest_engine.js';
import fs from 'fs';

// Mock DB for local testing with tick_logs.json
class MockDB {
    async getRecentTicks(symbol, limit) {
        const data = JSON.parse(fs.readFileSync('tick_logs.json'));
        // Return latest ticks based on timestamp ASC for backtest engine sorting
        return data[0].results
            .filter(t => t.symbol === symbol)
            .sort((a, b) => b.timestamp - a.timestamp) // DESC latest first
            .slice(0, limit);
    }
    async getRecentTrades(limit) {
        return [];
    }
}

async function test() {
    const db = new MockDB();
    const params = {
        accEntryThreshold: 90,
        accMinDuration: 15,
        oiMin: 0.2,
        tpSlRatio: 1.5,
        takerThresh: 1.05,
        slopeThresh: 0.02,
        filterExhaustion: true,
        timeCutMin: 90,
        requireTransition: true,
        limit: 20000
    };

    console.log('Running backtest with optimized parameters...');
    const result = await runBacktest(db, params);

    console.log('\n--- BACKTEST RESULTS ---');
    console.log(`Win Rate: ${result.newSummary.winRate}%`);
    console.log(`PnL: ₹${result.newSummary.totalPnL.toFixed(2)}`);
    console.log(`Trades: ${result.newSummary.traded}`);

    console.log('\n--- TRADE DETAILS ---');
    result.newResultsDetailed.forEach(r => {
        const type = r.pnl_inr > 0 ? 'WIN' : 'LOSS';
        console.log(`${type}: ${r.symbol} | Reason: ${r.reason} | PnL: ₹${r.pnl_inr.toFixed(2)} | Hold: ${r.hold.toFixed(1)}m | Score: ${r.score.toFixed(0)}`);
    });
}

test().catch(console.error);
