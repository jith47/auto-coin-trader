/**
 * Multi-Strategy Evaluators
 * 
 * Each strategy receives the shared `indicators` object (from computeIndicators)
 * and returns either a setup object { type, direction, score } or null.
 *
 * Strategies:
 *  1. Directional Alignment (current) — CVD + momentum alignment
 *  2. RSI Mean Reversion — oversold/overbought extremes
 *  3. Volume Spike Momentum — high-volume directional bursts
 *  4. BTC-ETH Divergence — cross-pair lag catch-up
 *  5. Wick Reversal — rejected price levels with volume confirmation
 */

// ─── Helper: RSI Calculation ─────────────────────────────────────────────────

/**
 * Compute RSI (Relative Strength Index) from kline close prices.
 * @param {Array} klines - Array of kline objects with `.close`
 * @param {number} period - RSI period (default 14)
 * @returns {{ value: number, trend: 'rising'|'falling'|'flat' }}
 */
export function computeRSI(klines, period = 14) {
    if (!klines || klines.length < period + 2) {
        return { value: 50, trend: 'flat' };
    }

    const closes = klines.map(k => k.close);
    let gains = 0, losses = 0;

    // Initial average gain/loss
    for (let i = closes.length - period; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) gains += change;
        else losses += Math.abs(change);
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return { value: 100, trend: 'rising' };
    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));

    // Compute previous RSI for trend (2 bars ago)
    let prevGains = 0, prevLosses = 0;
    for (let i = closes.length - period - 1; i < closes.length - 1; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) prevGains += change;
        else prevLosses += Math.abs(change);
    }
    const prevAvgGain = prevGains / period;
    const prevAvgLoss = prevLosses / period;
    const prevRs = prevAvgLoss === 0 ? 100 : prevAvgGain / prevAvgLoss;
    const prevRsi = prevAvgLoss === 0 ? 100 : 100 - (100 / (1 + prevRs));

    let trend = 'flat';
    if (rsi > prevRsi + 2) trend = 'rising';
    else if (rsi < prevRsi - 2) trend = 'falling';

    return { value: rsi, trend, prevValue: prevRsi };
}

// ─── Helper: Volume Spike Detection ──────────────────────────────────────────

/**
 * Detect a volume spike in the last N candles.
 * Returns spike info if last 2-3 candles have 1.5x+ average volume with consistent direction.
 */
export function detectVolumeSpike(klines, lookback = 30, spikeMultiplier = 1.5) {
    if (!klines || klines.length < lookback + 2) {
        return { detected: false };
    }

    const avgVolume = klines.slice(-lookback - 2, -2)
        .reduce((s, k) => s + k.volume, 0) / lookback;

    const last2 = klines.slice(-2);
    const spikeVolume = last2.reduce((s, k) => s + k.volume, 0) / 2;

    if (avgVolume <= 0 || spikeVolume < avgVolume * spikeMultiplier) {
        return { detected: false };
    }

    // Check directional consistency
    const allGreen = last2.every(k => k.close > k.open);
    const allRed = last2.every(k => k.close < k.open);

    if (!allGreen && !allRed) {
        return { detected: false };
    }

    return {
        detected: true,
        direction: allGreen ? 'BUY' : 'SELL',
        volumeRatio: spikeVolume / avgVolume,
    };
}

// ─── Helper: BTC-ETH Divergence Detection ────────────────────────────────────

/**
 * Detect when BTC has moved significantly but ETH hasn't followed yet.
 * Returns divergence info if BTC moved >threshold but ETH lagged.
 */
export function detectBtcEthDivergence(btcChange5m, ethChange5m, threshold = 0.15, lagThreshold = 0.08) {
    const btcMoved = Math.abs(btcChange5m) > threshold;
    const ethLagged = Math.abs(ethChange5m) < lagThreshold;

    if (!btcMoved || !ethLagged) {
        return { detected: false };
    }

    return {
        detected: true,
        direction: btcChange5m > 0 ? 'BUY' : 'SELL',
        btcMove: btcChange5m,
        ethMove: ethChange5m,
        gap: Math.abs(btcChange5m) - Math.abs(ethChange5m),
    };
}

// ─── Helper: Wick Reversal Detection ─────────────────────────────────────────

/**
 * Detect a high-wick reversal candle with volume confirmation.
 * A candle with >50% wick and close opposite to wick direction is a reversal signal.
 */
export function detectWickReversal(klines, volumeLookback = 30, volumeMultiplier = 1.2) {
    if (!klines || klines.length < volumeLookback + 1) {
        return { detected: false };
    }

    const current = klines[klines.length - 1];
    const range = current.high - current.low;
    if (range <= 0) return { detected: false };

    const upperWick = (current.high - Math.max(current.open, current.close)) / range;
    const lowerWick = (Math.min(current.open, current.close) - current.low) / range;

    // Volume confirmation
    const avgVol = klines.slice(-volumeLookback - 1, -1)
        .reduce((s, k) => s + k.volume, 0) / volumeLookback;
    const hasVolume = avgVol > 0 && current.volume >= avgVol * volumeMultiplier;

    // Bullish wick reversal: long lower wick + green close + volume
    if (lowerWick > 0.5 && current.close > current.open && hasVolume) {
        return {
            detected: true,
            direction: 'BUY',
            wickRatio: lowerWick,
            volumeRatio: current.volume / avgVol,
        };
    }

    // Bearish wick reversal: long upper wick + red close + volume
    if (upperWick > 0.5 && current.close < current.open && hasVolume) {
        return {
            detected: true,
            direction: 'SELL',
            wickRatio: upperWick,
            volumeRatio: current.volume / avgVol,
        };
    }

    return { detected: false };
}

// ─── Strategy 1: Directional Alignment ───────────────────────────────────────

export function evalDirectionalAlignment(ind) {
    const ethKlines = ind.eth.klines;
    if (!ethKlines || ethKlines.length === 0) return null;

    const lastCandle = ethKlines[ethKlines.length - 1];
    const isGreenCandle = lastCandle.close > lastCandle.open;
    const isRedCandle = lastCandle.close < lastCandle.open;

    const ethVolDir = ind.eth.volumeDeltaDirection || ind.eth.cvdDirection;
    const ethVolSlope = ind.eth.volumeDeltaSlope || ind.eth.cvdSlope;

    // RSI calculation for exhaustion check
    const rsiObj = computeRSI(ethKlines, 14);
    const rsiVal = rsiObj ? rsiObj.value : 50;

    const rangePos = ind.eth.rangePosition !== undefined ? ind.eth.rangePosition : 0.5;

    // v2 §7.1 Long candidate conditions:
    // - ETH 5m return positive
    // - BTC 5m return / 1h change non-opposing
    // - Last ETH candle closes above open (green)
    // - ETH close above 20m local midpoint (rangePos > 0.5)
    // - RSI not at exhaustion range (RSI < 70)
    const isLong = ethVolDir === 'rising'
        && ind.eth.change5m > 0
        && ind.btc.change1h > -0.3
        && isGreenCandle
        && rangePos >= 0.45
        && rsiVal < 70;

    const isShort = ethVolDir === 'falling'
        && ind.eth.change5m < 0
        && ind.btc.change1h < 0.3
        && isRedCandle
        && rangePos <= 0.55
        && rsiVal > 30;

    if (isLong) {
        let score = 50;
        if (ind.btc.structure === 'sweep_reclaim_bullish' || ind.btc.structure === 'sweep_reclaim_bearish') score += 15;
        else if (ind.btc.structure === 'support_holding' || ind.btc.structure === 'rejection') score += 10;
        if (ethVolSlope === 'steep') score += 10;
        else if (ethVolSlope === 'gradual') score += 5;
        if (ind.eth.relativeStrength === 'stronger') score += 10;
        if (ind.eth.volumeRatio && ind.eth.volumeRatio > 1.2) score += 5;
        return { type: 'DIRECTIONAL_ALIGNMENT', direction: 'BUY', score, rsi: rsiVal, rangePos };
    }
    if (isShort) {
        let score = 50;
        if (ind.btc.structure === 'sweep_reclaim_bullish' || ind.btc.structure === 'sweep_reclaim_bearish') score += 15;
        else if (ind.btc.structure === 'support_holding' || ind.btc.structure === 'rejection') score += 10;
        if (ethVolSlope === 'steep') score += 10;
        else if (ethVolSlope === 'gradual') score += 5;
        if (ind.eth.relativeStrength === 'weaker') score += 10;
        if (ind.eth.volumeRatio && ind.eth.volumeRatio > 1.2) score += 5;
        return { type: 'DIRECTIONAL_ALIGNMENT', direction: 'SELL', score, rsi: rsiVal, rangePos };
    }
    return null;
}

// ─── Strategy 2: RSI Mean Reversion ──────────────────────────────────────────

export function evalRSIMeanReversion(ind) {
    const ethKlines = ind.eth.klines;
    if (!ethKlines || ethKlines.length < 20) return null;

    const rsi = computeRSI(ethKlines, 14);

    // Oversold bounce: RSI < 35 and turning up
    if (rsi.value < 35 && rsi.trend === 'rising') {
        let score = 55;
        if (ind.btc.change1h > -0.2) score += 10;
        if (ind.eth.relativeStrength !== 'weaker') score += 5;
        if (rsi.value < 25) score += 5;
        return { type: 'RSI_MEAN_REVERSION', direction: 'BUY', score, rsiValue: rsi.value };
    }

    // Overbought reversal: RSI > 65 and turning down
    if (rsi.value > 65 && rsi.trend === 'falling') {
        let score = 55;
        if (ind.btc.change1h < 0.2) score += 10;
        if (ind.eth.relativeStrength !== 'stronger') score += 5;
        if (rsi.value > 75) score += 5;
        return { type: 'RSI_MEAN_REVERSION', direction: 'SELL', score, rsiValue: rsi.value };
    }

    return null;
}


// ─── Strategy 3: Volume Spike Momentum ───────────────────────────────────────

export function evalVolumeSikeMomentum(ind) {
    const ethKlines = ind.eth.klines;
    if (!ethKlines || ethKlines.length < 35) return null;

    const spike = detectVolumeSpike(ethKlines);
    if (!spike.detected) return null;

    const ethVolDir = ind.eth.volumeDeltaDirection || ind.eth.cvdDirection;

    let score = 55;
    // Bonus: Volume Delta confirms direction
    if ((spike.direction === 'BUY' && ethVolDir === 'rising') ||
        (spike.direction === 'SELL' && ethVolDir === 'falling')) {
        score += 10;
    }
    // Bonus: BTC not opposing
    if ((spike.direction === 'BUY' && ind.btc.change5m > -0.1) ||
        (spike.direction === 'SELL' && ind.btc.change5m < 0.1)) {
        score += 5;
    }
    // Bonus: higher volume spike = stronger
    if (spike.volumeRatio > 3.0) score += 5;

    return { type: 'VOLUME_SPIKE', direction: spike.direction, score, volumeRatio: spike.volumeRatio };
}

// ─── Strategy 4: BTC-ETH Divergence ──────────────────────────────────────────

export function evalBtcEthDivergence(ind) {
    const div = detectBtcEthDivergence(ind.btc.change5m, ind.eth.change5m);
    if (!div.detected) return null;

    const btcVolDir = ind.btc.volumeDeltaDirection || ind.btc.cvdDirection;

    let score = 55;
    // Bonus: BTC Volume Delta confirms direction
    if ((div.direction === 'BUY' && btcVolDir === 'rising') ||
        (div.direction === 'SELL' && btcVolDir === 'falling')) {
        score += 10;
    }
    // Bonus: larger gap = ETH has more room to catch up
    if (div.gap > 0.5) score += 5;
    // Bonus: relative strength confirms lag (ETH is weaker when BTC is up)
    if ((div.direction === 'BUY' && ind.eth.relativeStrength === 'weaker') ||
        (div.direction === 'SELL' && ind.eth.relativeStrength === 'stronger')) {
        score += 5;
    }

    return { type: 'BTC_ETH_DIVERGENCE', direction: div.direction, score, gap: div.gap };
}

// ─── Strategy 5: Wick Reversal ───────────────────────────────────────────────

export function evalWickReversal(ind) {
    const ethKlines = ind.eth.klines;
    if (!ethKlines || ethKlines.length < 35) return null;

    const wick = detectWickReversal(ethKlines);
    if (!wick.detected) return null;

    const ethVolDir = ind.eth.volumeDeltaDirection || ind.eth.cvdDirection;

    let score = 55;
    // Bonus: BTC structure supports reversal
    if ((wick.direction === 'BUY' && (ind.btc.structure === 'support_holding' || ind.btc.structure === 'sweep_reclaim_bullish')) ||
        (wick.direction === 'SELL' && (ind.btc.structure === 'rejection' || ind.btc.structure === 'sweep_reclaim_bearish'))) {
        score += 10;
    }
    // Bonus: Volume Delta confirms
    if ((wick.direction === 'BUY' && ethVolDir === 'rising') ||
        (wick.direction === 'SELL' && ethVolDir === 'falling')) {
        score += 5;
    }
    // Bonus: deeper wick = stronger rejection
    if (wick.wickRatio > 0.75) score += 5;

    return { type: 'WICK_REVERSAL', direction: wick.direction, score, wickRatio: wick.wickRatio };
}

// ─── Strategy Runner ─────────────────────────────────────────────────────────

/**
 * Run strategies and return the best signal (highest score).
 * @param {object} ind - indicators from computeIndicators()
 * @param {number} minScore - minimum score to accept (default 65)
 * @param {boolean} isParallelMock - whether in parallel mock mode
 * @returns {{ type, direction, score, ... } | null}
 */
export function runAllStrategies(ind, minScore = 65, isParallelMock = false) {
    const allStrategies = [
        { name: 'DirectionalAlignment', fn: evalDirectionalAlignment, regimes: ['TREND_UP', 'TREND_DOWN'] },
        { name: 'RSIMeanReversion', fn: evalRSIMeanReversion, regimes: ['RANGE'] },
        { name: 'VolumeSpikeMomentum', fn: evalVolumeSikeMomentum, regimes: ['TREND_UP', 'TREND_DOWN'] },
        { name: 'BtcEthDivergence', fn: evalBtcEthDivergence, regimes: ['TREND_UP', 'TREND_DOWN'] },
        { name: 'WickReversal', fn: evalWickReversal, regimes: ['RANGE'] },
    ];

    const currentRegime = ind.regime || 'RANGE';

    // In single/live mode, filter by current regime. In parallel mock mode, run all.
    let eligibleStrategies = allStrategies;
    if (!isParallelMock) {
        if (currentRegime === 'NO_TRADE') {
            console.log('[Strategies] Regime is NO_TRADE. Blocking all strategy evaluations.');
            return null;
        }
        eligibleStrategies = allStrategies.filter(s => s.regimes.includes(currentRegime));
        console.log(`[Strategies] Single/Live mode — Regime '${currentRegime}' allows ${eligibleStrategies.length} strategy(ies): ${eligibleStrategies.map(s => s.name).join(', ')}`);
    }

    const results = [];
    for (const strat of eligibleStrategies) {
        try {
            const result = strat.fn(ind);
            if (result && result.score >= minScore) {
                results.push(result);
                console.log(`[Strategies] ${strat.name}: ${result.direction} score=${result.score}`);
            } else if (result) {
                console.log(`[Strategies] ${strat.name}: ${result.direction} score=${result.score} (below threshold ${minScore})`);
            }
        } catch (err) {
            console.error(`[Strategies] ${strat.name} error:`, err.message);
        }
    }

    if (results.length === 0) {
        console.log('[Strategies] No strategy produced a valid signal above threshold.');
        return null;
    }

    // Pick the highest scoring signal
    results.sort((a, b) => b.score - a.score);
    const best = results[0];
    console.log(`[Strategies] Winner: ${best.type} ${best.direction} score=${best.score} (${results.length} candidates)`);
    return best;
}
