/**
 * V7 Strategy Tournament Runner — 15 Diverse Edge Strategies
 * 
 * Evaluates all 15 strategies, tracks shadow signals in D1,
 * monitors rolling win-rate health, and trades only with currently HOT strategies.
 */

import {
    evalSweepReclaim,
    evalStopHunt,
    evalOiTrap,
    evalSessionOpen,
    evalFundingSqueeze,
    evalLiquidationCascade,
    evalAbsorptionReversal,
    evalRetailFade,
    evalWhaleImbalance,
    evalMicroScalp,
    evalMomentum5m,
    evalTakerSurge,
    evalCvdPriceDiv,
    evalBtcFollow,
    evalRangeBounce
} from './edge_strategies.js';

// Re-export for external consumers
export {
    evalSweepReclaim,
    evalStopHunt,
    evalOiTrap,
    evalSessionOpen,
    evalFundingSqueeze,
    evalLiquidationCascade,
    evalAbsorptionReversal,
    evalRetailFade,
    evalWhaleImbalance,
    evalMicroScalp,
    evalMomentum5m,
    evalTakerSurge,
    evalCvdPriceDiv,
    evalBtcFollow,
    evalRangeBounce
};

export const STRATEGY_REGISTRY = [
    { key: 'SWEEP_RECLAIM', name: 'SweepReclaim', fn: evalSweepReclaim },
    { key: 'STOP_HUNT', name: 'StopHunt', fn: evalStopHunt },
    { key: 'OI_TRAP', name: 'OiTrap', fn: evalOiTrap },
    { key: 'SESSION_OPEN', name: 'SessionOpen', fn: evalSessionOpen },
    { key: 'FUNDING_SQUEEZE', name: 'FundingSqueeze', fn: evalFundingSqueeze },
    { key: 'LIQUIDATION_CASCADE', name: 'LiquidationCascade', fn: evalLiquidationCascade },
    { key: 'ABSORPTION_REVERSAL', name: 'AbsorptionReversal', fn: evalAbsorptionReversal },
    { key: 'RETAIL_FADE', name: 'RetailFade', fn: evalRetailFade },
    { key: 'WHALE_IMBALANCE', name: 'WhaleImbalance', fn: evalWhaleImbalance },
    { key: 'MICRO_SCALP', name: 'MicroScalp', fn: evalMicroScalp },
    { key: 'MOMENTUM_5M', name: 'Momentum5m', fn: evalMomentum5m },
    { key: 'TAKER_SURGE', name: 'TakerSurge', fn: evalTakerSurge },
    { key: 'CVD_PRICE_DIV', name: 'CvdPriceDiv', fn: evalCvdPriceDiv },
    { key: 'BTC_FOLLOW', name: 'BtcFollow', fn: evalBtcFollow },
    { key: 'RANGE_BOUNCE', name: 'RangeBounce', fn: evalRangeBounce },
];

/**
 * Evaluate all strategies in the pool without skipping any.
 * @param {Object} ind - Indicator object
 * @param {number} minScore - Minimum required score
 * @returns {Array<Object>} Array of triggered setups
 */
export function evaluateAll(ind, minScore = 55) {
    const triggered = [];
    for (const strat of STRATEGY_REGISTRY) {
        try {
            const res = strat.fn(ind);
            if (res && res.score >= minScore) {
                triggered.push({
                    ...res,
                    key: strat.key,
                });
            }
        } catch (err) {
            console.error(`[Tournament] Error evaluating ${strat.key}:`, err.message);
        }
    }
    return triggered;
}

/**
 * Run Tournament:
 * 1. Evaluate ALL 15 strategies (no skipping)
 * 2. Log shadow signals for all triggered strategies into D1
 * 3. Resolve pending shadow signals with current price
 * 4. Fetch rolling strategy health
 * 5. Trade ONLY with HOT / qualifying strategies that aren't paused by user toggle
 */
export async function runTournament(ind, db, disabledStrategies = new Set(), minScore = 55) {
    const disabledSet = disabledStrategies instanceof Set ? disabledStrategies : new Set(disabledStrategies || []);
    const ethPrice = ind.eth?.price || 0;

    // 1. Evaluate ALL 15 strategies
    const allSignals = evaluateAll(ind, minScore);
    console.log(`[Tournament] Evaluated 15 strategies. ${allSignals.length} triggered.`);

    // 2. Log shadow signals & resolve if DB available
    let healthMap = {};
    if (db) {
        try {
            // Log shadow signals for ALL triggered strategies
            if (ethPrice > 0) {
                for (const sig of allSignals) {
                    await db.logShadowSignal(sig.key, sig.direction, sig.score, ethPrice);
                }
                // Resolve pending signals
                await db.resolveShadowSignals(ethPrice);
            }

            // Fetch health scorecard for all strategies
            if (typeof db.getAllStrategyHealth === 'function') {
                healthMap = await db.getAllStrategyHealth();
            }
        } catch (err) {
            console.error('[Tournament] DB shadow tracking error:', err.message);
        }
    }

    if (allSignals.length === 0) {
        return null;
    }

    // 3. Filter triggered signals based on tournament status and user toggles
    const candidates = [];

    for (const sig of allSignals) {
        if (disabledSet.has(sig.key)) {
            console.log(`[Tournament] ⏸ ${sig.key} is paused by user toggle. Skipped for live trade.`);
            continue;
        }

        const health = healthMap[sig.key] || { status: 'WARM', winRate: 0, totalResolved: 0 };
        const status = health.status || 'WARM';

        // Qualification logic:
        // Tier 1: HOT (rolling win rate >= 55% over last 20 resolved)
        // Tier 2: WARM with insufficient sample (< 5 resolved signals, benefit of doubt)
        // Tier 3: WARM with high score (score >= 68)
        // Tier 0: COLD (< 45% win rate) -> BENCHED!
        if (status === 'HOT') {
            console.log(`[Tournament] 🟢 HOT strategy triggered: ${sig.key} (${health.winRate}% WR, score=${sig.score})`);
            candidates.push({ ...sig, tier: 1, health });
        } else if (health.totalResolved < 5) {
            console.log(`[Tournament] 🟡 NEW/GRACE strategy triggered: ${sig.key} (${health.totalResolved} samples, score=${sig.score})`);
            candidates.push({ ...sig, tier: 2, health });
        } else if (status === 'WARM' && sig.score >= 68) {
            console.log(`[Tournament] 🟡 WARM strategy triggered with high score: ${sig.key} (${health.winRate}% WR, score=${sig.score})`);
            candidates.push({ ...sig, tier: 3, health });
        } else {
            console.log(`[Tournament] 🔴 BENCHED: ${sig.key} is ${status} (${health.winRate}% WR on ${health.totalResolved} samples). Shadow-only.`);
        }
    }

    if (candidates.length === 0) {
        console.log('[Tournament] No qualifying HOT/active strategies among triggered signals.');
        return null;
    }

    // Sort: Tier ascending (1 > 2 > 3), then Score descending
    candidates.sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        return b.score - a.score;
    });

    const winner = candidates[0];
    console.log(`[Tournament] 🏆 WINNER: ${winner.type} ${winner.direction} (Tier ${winner.tier}, Score: ${winner.score}, Status: ${winner.health?.status || 'WARM'})`);
    return winner;
}

/**
 * Backwards-compatible synchronous runner
 */
export function runAllStrategies(ind, minScore = 55, isParallelMock = false, disabledStrategies = new Set()) {
    const disabledSet = disabledStrategies instanceof Set ? disabledStrategies : new Set(disabledStrategies || []);
    const all = evaluateAll(ind, minScore);
    const filtered = all.filter(s => !disabledSet.has(s.key));
    if (filtered.length === 0) return null;
    filtered.sort((a, b) => b.score - a.score);
    return filtered[0];
}
