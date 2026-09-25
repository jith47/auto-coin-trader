import { fetchAllMarketData, computeIndicators } from '../src/binance.js';
import { runTournament, runAllStrategies, evaluateAll, STRATEGY_REGISTRY } from '../src/strategies.js';

async function testV7TournamentSystem() {
    console.log('=== V7 ADAPTIVE TOURNAMENT STRATEGY ENGINE TEST ===\n');

    console.log('--- 1. FETCHING MARKET & EDGE DATA ---');
    const start = Date.now();
    const data = await fetchAllMarketData();
    const fetchMs = Date.now() - start;
    console.log(`Fetched live market data in ${fetchMs}ms`);

    console.log('\n--- 2. COMPUTING INDICATORS ---');
    const indStart = Date.now();
    const ind = computeIndicators(data);
    const indMs = Date.now() - indStart;
    console.log(`Computed indicators in ${indMs}ms`);
    console.log(`ETH Price: $${ind.eth.price}, 5m Chg: ${ind.eth.change5m?.toFixed(2)}%, 1h Chg: ${ind.eth.change1h?.toFixed(2)}%`);
    console.log(`BTC Price: $${ind.btc.price}, 5m Chg: ${ind.btc.change5m?.toFixed(2)}%, CVD: ${ind.btc.cvdDirection}`);

    console.log(`\n--- 3. EVALUATING ALL 15 STRATEGIES INDIVIDUALLY ---`);
    let triggeredCount = 0;
    for (const strat of STRATEGY_REGISTRY) {
        try {
            const res = strat.fn(ind);
            if (res) {
                triggeredCount++;
                console.log(`  ✅ [${strat.key}] TRIGGERED -> ${res.direction}, Score: ${res.score}`);
            } else {
                console.log(`  ⚪️ [${strat.key}] No Signal`);
            }
        } catch (err) {
            console.error(`  ❌ [${strat.key}] ERROR:`, err.message);
        }
    }
    console.log(`Total Triggered: ${triggeredCount}/${STRATEGY_REGISTRY.length}`);

    console.log('\n--- 4. TESTING evaluateAll() ---');
    const allSetups = evaluateAll(ind, 55);
    console.log(`evaluateAll returned ${allSetups.length} setups with score >= 55:`);
    allSetups.forEach(s => console.log(`  - ${s.key}: ${s.direction} (Score: ${s.score})`));

    console.log('\n--- 5. TESTING runTournament WITH MOCK DB ---');
    const mockShadowDB = {
        shadowLogs: [],
        resolvedLogs: [],
        async logShadowSignal(key, dir, score, price) {
            this.shadowLogs.push({ key, dir, score, price, time: Date.now() });
            console.log(`  [MockDB] Logged shadow signal: ${key} ${dir} @ $${price} (score: ${score})`);
        },
        async resolveShadowSignals(price) {
            console.log(`  [MockDB] Checked resolution at price $${price}`);
            return 0;
        },
        async getAllStrategyHealth() {
            const health = {};
            for (const s of STRATEGY_REGISTRY) {
                // Simulate some sample health statuses
                health[s.key] = {
                    key: s.key,
                    status: s.key === 'MOMENTUM_5M' ? 'HOT' : s.key === 'SWEEP_RECLAIM' ? 'COLD' : 'WARM',
                    winRate: s.key === 'MOMENTUM_5M' ? 65.0 : s.key === 'SWEEP_RECLAIM' ? 35.0 : 50.0,
                    totalResolved: s.key === 'SWEEP_RECLAIM' ? 10 : 2,
                    wins: s.key === 'MOMENTUM_5M' ? 13 : 3,
                    losses: s.key === 'MOMENTUM_5M' ? 7 : 7,
                };
            }
            return health;
        }
    };

    const tournamentWinner = await runTournament(ind, mockShadowDB, new Set());
    console.log('Tournament Winner:', tournamentWinner ? `${tournamentWinner.type} ${tournamentWinner.direction} (Score: ${tournamentWinner.score})` : 'None');

    console.log('\n--- 6. TESTING BACKWARDS-COMPATIBLE runAllStrategies ---');
    const syncWinner = runAllStrategies(ind, 55, true);
    console.log('Sync Winner:', syncWinner ? `${syncWinner.type} ${syncWinner.direction} (Score: ${syncWinner.score})` : 'None');

    console.log('\n✅ All tests completed successfully!');
}

testV7TournamentSystem().catch(err => {
    console.error('❌ ERROR:', err);
    process.exit(1);
});
