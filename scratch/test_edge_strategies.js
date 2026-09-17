import { fetchAllMarketData, computeIndicators } from '../src/binance.js';
import { runAllStrategies } from '../src/strategies.js';
import {
    evalMomentum5m,
    evalVwapCross,
    evalEmaRibbon,
    evalBollingerSqueeze,
    evalRsiDivergence,
    evalDeltaFlip,
    evalAbsorption,
    evalMeanRevertZ,
    evalMomentumDiverge,
    evalMultiTfAlign
} from '../src/edge_strategies.js';

async function testEdgeSystem() {
    console.log('--- FETCHING MARKET & EDGE DATA ---');
    const start = Date.now();
    const data = await fetchAllMarketData();
    const fetchMs = Date.now() - start;
    console.log(`Fetched in ${fetchMs}ms`);

    console.log('\n--- COMPUTING INDICATORS ---');
    const indStart = Date.now();
    const ind = computeIndicators(data);
    const indMs = Date.now() - indStart;
    console.log(`Computed indicators in ${indMs}ms`);

    console.log('\n--- EVALUATING ALL 10 V5 STRATEGIES INDIVIDUALLY ---');
    const strategies = [
        { key: 'MOMENTUM_5M', fn: evalMomentum5m },
        { key: 'VWAP_CROSS', fn: evalVwapCross },
        { key: 'EMA_RIBBON', fn: evalEmaRibbon },
        { key: 'BOLLINGER_SQUEEZE', fn: evalBollingerSqueeze },
        { key: 'RSI_DIVERGENCE', fn: evalRsiDivergence },
        { key: 'DELTA_FLIP', fn: evalDeltaFlip },
        { key: 'ABSORPTION', fn: evalAbsorption },
        { key: 'MEAN_REVERT_Z', fn: evalMeanRevertZ },
        { key: 'MOMENTUM_DIVERGE', fn: evalMomentumDiverge },
        { key: 'MULTI_TF_ALIGN', fn: evalMultiTfAlign },
    ];

    let triggeredCount = 0;
    for (const strat of strategies) {
        try {
            const res = strat.fn(ind);
            if (res) {
                triggeredCount++;
                console.log(`  ✅ [${strat.key}] TRIGGERED -> Direction: ${res.direction}, Score: ${res.score}`);
            } else {
                console.log(`  ⚪️ [${strat.key}] No Signal`);
            }
        } catch (err) {
            console.error(`  ❌ [${strat.key}] ERROR:`, err.message);
        }
    }

    console.log(`\n--- SUMMARY: ${triggeredCount}/${strategies.length} strategies triggered signals ---`);

    console.log('\n--- RUNNING RUNALLSTRATEGIES (ALL ENABLED) ---');
    const winnerAll = runAllStrategies(ind, 50, true);
    console.log('Winner with all enabled:', winnerAll);

    console.log('\n--- RUNNING RUNALLSTRATEGIES (WITH MOMENTUM_5M PAUSED) ---');
    const winnerPaused = runAllStrategies(ind, 50, true, new Set(['MOMENTUM_5M']));
    console.log('Winner with MOMENTUM_5M paused:', winnerPaused);
}

testEdgeSystem().catch(err => {
    console.error('❌ ERROR:', err);
    process.exit(1);
});
