/**
 * V5 Strategy Runner — 10 parallel strategies with toggle support
 */

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
} from './edge_strategies.js';

// Re-export for any external consumers
export {
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
};

/**
 * Run all enabled strategies. Return best signal.
 * @param {Object} ind - Indicators object from computeIndicators
 * @param {number} minScore - Minimum required strategy score (default 55)
 * @param {boolean} isParallelMock - Mock mode flag
 * @param {Set<string>|Array<string>} disabledStrategies - Set of strategy keys that are paused/disabled
 */
export function runAllStrategies(ind, minScore = 55, isParallelMock = false, disabledStrategies = new Set()) {
    const disabledSet = disabledStrategies instanceof Set ? disabledStrategies : new Set(disabledStrategies || []);

    const allStrategies = [
        { key: 'MOMENTUM_5M', name: 'Momentum5m', fn: evalMomentum5m },
        { key: 'VWAP_CROSS', name: 'VwapCross', fn: evalVwapCross },
        { key: 'EMA_RIBBON', name: 'EmaRibbon', fn: evalEmaRibbon },
        { key: 'BOLLINGER_SQUEEZE', name: 'BollingerSqueeze', fn: evalBollingerSqueeze },
        { key: 'RSI_DIVERGENCE', name: 'RsiDivergence', fn: evalRsiDivergence },
        { key: 'DELTA_FLIP', name: 'DeltaFlip', fn: evalDeltaFlip },
        { key: 'ABSORPTION', name: 'Absorption', fn: evalAbsorption },
        { key: 'MEAN_REVERT_Z', name: 'MeanRevertZ', fn: evalMeanRevertZ },
        { key: 'MOMENTUM_DIVERGE', name: 'MomentumDiverge', fn: evalMomentumDiverge },
        { key: 'MULTI_TF_ALIGN', name: 'MultiTfAlign', fn: evalMultiTfAlign },
    ];

    const results = [];
    let evaluatedCount = 0;

    for (const strat of allStrategies) {
        if (disabledSet.has(strat.key)) {
            console.log(`[V5] ⏸ ${strat.key} is DISABLED by user toggle. Skipping.`);
            continue;
        }

        evaluatedCount++;
        try {
            const result = strat.fn(ind);
            if (result && result.score >= minScore) {
                results.push(result);
                console.log(`[V5] ✓ ${strat.key}: ${result.direction} score=${result.score}`);
            }
        } catch (err) {
            console.error(`[V5] ${strat.key} error:`, err.message);
        }
    }

    if (results.length === 0) {
        console.log(`[V5] No strategy triggered (${evaluatedCount}/${allStrategies.length} active evaluated)`);
        return null;
    }

    // Sort by score, pick the best
    results.sort((a, b) => b.score - a.score);
    const best = results[0];
    console.log(`[V5] WINNER: ${best.type} ${best.direction} score=${best.score} (${results.length}/${evaluatedCount} active triggered)`);
    return best;
}
