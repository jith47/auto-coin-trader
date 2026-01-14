/**
 * Delta Strategy Engine
 *
 * Converts your trading strategy rules from current_strategy.md and grok_strategy.md
 * into executable code using real-time delta data from Binance API.
 *
 * This is a TEMPLATE - customize the thresholds to match your exact strategy.
 */

import DeltaDataClient from "./binance_delta_client.js";

// Strategy Configuration (from your strategy docs)
const STRATEGY_CONFIG = {
    // Correlation thresholds
    CORRELATION_HIGH: 0.9,
    CORRELATION_MEDIUM_LOW: 0.75,
    CORRELATION_SPIKE_LOW: 0.865,
    CORRELATION_SPIKE_HIGH: 0.938,

    // Lag Score thresholds (from grok_strategy.md)
    LAG_SCORE_LONG: 2.65, // LONG when DOGE is lagging hard
    LAG_SCORE_SHORT: 0.37, // SHORT when DOGE is leading

    // Delta thresholds (from grok_strategy.md)
    BTC_DELTA_3_CANDLE_THRESHOLD: 580000, // +580K for long, -580K for short

    // Funding rate thresholds
    FUNDING_RATE_MAX_LONG: 0.038, // Max funding for longs
    FUNDING_RATE_MIN_SHORT: -0.008, // Min funding for shorts (avoid squeeze)

    // Relative Strength ratio
    RS_RATIO_MAX: 3.0, // DOGE/BTC 24h ratio max
    RS_RATIO_MIN: 0.2, // DOGE/BTC 24h ratio min

    // Risk management
    STOP_LOSS_PERCENT: 0.29,
    TAKE_PROFIT_1_PERCENT: 0.44,
    TAKE_PROFIT_2_PERCENT: 1.18,
    TIME_STOP_MINUTES: 9.5,
};

/**
 * StrategyEngine - Evaluates trading signals based on delta data
 */
export class StrategyEngine {
    constructor() {
        this.client = new DeltaDataClient(["BTCUSDT", "DOGEUSDT"]);
        this.correlationHistory = []; // Track correlation for spike detection
        this.lastSignal = null;
        this.lastSignalTime = 0;
    }

    /**
     * Start the strategy engine
     */
    start() {
        console.log("[StrategyEngine] Starting...");

        this.client.onData = (snapshot) => {
            this.evaluateSignals(snapshot);
        };

        this.client.connect();

        // Evaluate strategy every second
        setInterval(() => {
            const snapshot = this.client.getSnapshot();
            this.evaluateSignals(snapshot);
        }, 1000);
    }

    /**
     * Track correlation history for spike detection
     */
    updateCorrelationHistory(correlation) {
        this.correlationHistory.push({
            value: correlation,
            timestamp: Date.now(),
        });

        // Keep last 9 candles worth (about 9 minutes of data points)
        const cutoff = Date.now() - 9 * 60 * 1000;
        this.correlationHistory = this.correlationHistory.filter(
            (c) => c.timestamp > cutoff
        );
    }

    /**
     * Check if correlation spiked from low to high in last 9 candles
     * From grok_strategy: "Dipped to ≤0.865 → spiked to ≥0.938 in ≤9 candles"
     */
    hasCorrelationSpike() {
        const history = this.correlationHistory;
        if (history.length < 2) return false;

        // Find if there was a dip below 0.865 followed by spike above 0.938
        let hadDip = false;
        for (const point of history) {
            if (point.value <= STRATEGY_CONFIG.CORRELATION_SPIKE_LOW) {
                hadDip = true;
            }
        }

        // Current correlation is high
        const currentHigh =
            history[history.length - 1].value >= STRATEGY_CONFIG.CORRELATION_SPIKE_HIGH;

        return hadDip && currentHigh;
    }

    /**
     * Calculate relative strength ratio (DOGE 24h% / BTC 24h%)
     */
    getRelativeStrengthRatio(snapshot) {
        const btc24h = snapshot.btc.change24h;
        const doge24h = snapshot.doge.change24h;

        if (Math.abs(btc24h) < 0.01) return 0; // Avoid division issues

        return Math.abs(doge24h / btc24h);
    }

    /**
     * Evaluate LONG entry conditions (from grok_strategy.md v4.0)
     */
    evaluateLongConditions(snapshot) {
        const checks = {
            // □ BTC Delta last 3 candles ≥ +580K
            btcDeltaPositive: snapshot.btc.deltaSum3 >= STRATEGY_CONFIG.BTC_DELTA_3_CANDLE_THRESHOLD,

            // □ DOGE Lag Score ≥ 2.65 (DOGE still sleeping)
            lagScoreHigh: snapshot.lagScore >= STRATEGY_CONFIG.LAG_SCORE_LONG,

            // □ Correlation spiked from ≤0.865 → ≥0.938 in last 9 candles
            correlationSpike: this.hasCorrelationSpike(),

            // □ Funding rate ≤ +0.038%
            fundingOk: snapshot.doge.fundingRate <= STRATEGY_CONFIG.FUNDING_RATE_MAX_LONG,

            // □ DOGE CVD higher lows (accumulation)
            cvdHigherLows: snapshot.doge.cvdHigherLows,

            // □ Relative strength in healthy range (0.5-2.5)
            rsRatioOk: (() => {
                const ratio = this.getRelativeStrengthRatio(snapshot);
                return ratio >= 0.5 && ratio <= 2.5;
            })(),
        };

        const allPass = Object.values(checks).every(Boolean);

        return {
            signal: allPass ? "LONG" : null,
            checks,
            confidence: Object.values(checks).filter(Boolean).length / Object.keys(checks).length,
        };
    }

    /**
     * Evaluate SHORT entry conditions (from grok_strategy.md v4.0)
     */
    evaluateShortConditions(snapshot) {
        const checks = {
            // □ BTC Delta last 3 candles ≤ -580K
            btcDeltaNegative: snapshot.btc.deltaSum3 <= -STRATEGY_CONFIG.BTC_DELTA_3_CANDLE_THRESHOLD,

            // □ DOGE Lag Score ≤ 0.37 (DOGE leading = weak)
            lagScoreLow: snapshot.lagScore <= STRATEGY_CONFIG.LAG_SCORE_SHORT && snapshot.lagScore > 0,

            // □ Correlation spiked from ≤0.865 → ≥0.938 in last 9 candles
            correlationSpike: this.hasCorrelationSpike(),

            // □ Funding rate ≥ -0.008% (not extreme short squeeze risk)
            fundingOk: snapshot.doge.fundingRate >= STRATEGY_CONFIG.FUNDING_RATE_MIN_SHORT,

            // □ Relative Weakness: DOGE underperforming BTC
            relativeWeakness: (() => {
                const btc24h = snapshot.btc.change24h;
                const doge24h = snapshot.doge.change24h;
                // DOGE negative while BTC flat/positive
                return doge24h < 0 && btc24h >= -0.5;
            })(),

            // □ RS Ratio < 3.0 (move not exhausted)
            rsRatioOk: this.getRelativeStrengthRatio(snapshot) < STRATEGY_CONFIG.RS_RATIO_MAX,
        };

        const allPass = Object.values(checks).every(Boolean);

        return {
            signal: allPass ? "SHORT" : null,
            checks,
            confidence: Object.values(checks).filter(Boolean).length / Object.keys(checks).length,
        };
    }

    /**
     * Calculate entry, stop loss, and take profit levels
     */
    calculateLevels(snapshot, direction) {
        const entry = snapshot.doge.price;

        if (direction === "LONG") {
            return {
                entry,
                stopLoss: entry * (1 - STRATEGY_CONFIG.STOP_LOSS_PERCENT / 100),
                takeProfit1: entry * (1 + STRATEGY_CONFIG.TAKE_PROFIT_1_PERCENT / 100),
                takeProfit2: entry * (1 + STRATEGY_CONFIG.TAKE_PROFIT_2_PERCENT / 100),
            };
        } else {
            return {
                entry,
                stopLoss: entry * (1 + STRATEGY_CONFIG.STOP_LOSS_PERCENT / 100),
                takeProfit1: entry * (1 - STRATEGY_CONFIG.TAKE_PROFIT_1_PERCENT / 100),
                takeProfit2: entry * (1 - STRATEGY_CONFIG.TAKE_PROFIT_2_PERCENT / 100),
            };
        }
    }

    /**
     * Main signal evaluation
     */
    evaluateSignals(snapshot) {
        // Update correlation history
        this.updateCorrelationHistory(snapshot.correlation);

        // Check for cooldown (avoid rapid signals)
        const cooldownMs = 60000; // 1 minute between signals
        if (Date.now() - this.lastSignalTime < cooldownMs) {
            return null;
        }

        // Evaluate conditions
        const longResult = this.evaluateLongConditions(snapshot);
        const shortResult = this.evaluateShortConditions(snapshot);

        // Determine signal
        let signal = null;
        let result = null;

        if (longResult.signal && longResult.confidence >= 0.8) {
            signal = "LONG";
            result = longResult;
        } else if (shortResult.signal && shortResult.confidence >= 0.8) {
            signal = "SHORT";
            result = shortResult;
        }

        if (signal) {
            const levels = this.calculateLevels(snapshot, signal);

            const tradeSignal = {
                decision: signal === "LONG" ? "BUY" : "SELL",
                reason: this.generateReason(signal, result),
                orderType: "MARKET",
                entry: levels.entry,
                stopLoss: levels.stopLoss,
                takeProfit: levels.takeProfit1,
                confidence: result.confidence,
                timestamp: Date.now(),
                checks: result.checks,
                snapshot: {
                    btcPrice: snapshot.btc.price,
                    dogePrice: snapshot.doge.price,
                    btcDelta3: snapshot.btc.deltaSum3,
                    dogeCvd: snapshot.doge.cvd,
                    correlation: snapshot.correlation,
                    lagScore: snapshot.lagScore,
                    fundingRate: snapshot.doge.fundingRate,
                },
            };

            this.lastSignal = tradeSignal;
            this.lastSignalTime = Date.now();

            console.log("\n🚨 TRADE SIGNAL DETECTED 🚨");
            console.log(JSON.stringify(tradeSignal, null, 2));

            return tradeSignal;
        }

        return null;
    }

    /**
     * Generate human-readable reason for the trade
     */
    generateReason(signal, result) {
        const passing = Object.entries(result.checks)
            .filter(([_, v]) => v)
            .map(([k, _]) => k);

        if (signal === "LONG") {
            return `Long signal: BTC delta positive, DOGE lagging (${result.confidence * 100}% confidence). Passing: ${passing.join(", ")}`;
        } else {
            return `Short signal: BTC delta negative, DOGE showing weakness (${result.confidence * 100}% confidence). Passing: ${passing.join(", ")}`;
        }
    }

    /**
     * Get current market state summary
     */
    getMarketState() {
        const snapshot = this.client.getSnapshot();
        const longResult = this.evaluateLongConditions(snapshot);
        const shortResult = this.evaluateShortConditions(snapshot);

        return {
            timestamp: Date.now(),
            btc: {
                price: snapshot.btc.price,
                delta3: snapshot.btc.deltaSum3,
                delta10: snapshot.btc.deltaSum10,
                fundingRate: snapshot.btc.fundingRate,
                change24h: snapshot.btc.change24h,
            },
            doge: {
                price: snapshot.doge.price,
                cvd: snapshot.doge.cvd,
                cvdHigherLows: snapshot.doge.cvdHigherLows,
                fundingRate: snapshot.doge.fundingRate,
                change24h: snapshot.doge.change24h,
            },
            correlation: snapshot.correlation,
            lagScore: snapshot.lagScore,
            rsRatio: this.getRelativeStrengthRatio(snapshot),
            longChecks: longResult.checks,
            longConfidence: longResult.confidence,
            shortChecks: shortResult.checks,
            shortConfidence: shortResult.confidence,
        };
    }

    /**
     * Stop the engine
     */
    stop() {
        this.client.disconnect();
    }
}

// Main execution for testing
if (import.meta.url === `file://${process.argv[1]}`) {
    const engine = new StrategyEngine();
    engine.start();

    // Print market state every 30 seconds
    setInterval(() => {
        const state = engine.getMarketState();
        console.log("\n📊 MARKET STATE:");
        console.log(`BTC: $${state.btc.price.toFixed(2)} | Delta(3): ${state.btc.delta3.toFixed(0)} | 24h: ${state.btc.change24h.toFixed(2)}%`);
        console.log(`DOGE: $${state.doge.price.toFixed(6)} | CVD: ${state.doge.cvd.toFixed(4)} | 24h: ${state.doge.change24h.toFixed(2)}%`);
        console.log(`Correlation: ${state.correlation.toFixed(4)} | Lag: ${state.lagScore.toFixed(4)} | RS Ratio: ${state.rsRatio.toFixed(2)}`);
        console.log(`Long Confidence: ${(state.longConfidence * 100).toFixed(0)}% | Short Confidence: ${(state.shortConfidence * 100).toFixed(0)}%`);
    }, 30000);

    // Graceful shutdown
    process.on("SIGINT", () => {
        console.log("\nShutting down strategy engine...");
        engine.stop();
        process.exit(0);
    });
}

export default StrategyEngine;
