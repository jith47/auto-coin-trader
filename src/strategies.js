/**
 * Multi-Strategy Evaluators (Revamped)
 * 
 * Each strategy receives the shared `indicators` object (from computeIndicators)
 * and returns either a setup object { type, direction, score } or null.
 *
 * Strategies:
 *  1. EMA_VWAP_CONFLUENCE — Trend following with EMA 9/21 crossover + VWAP filter
 *  2. MOMENTUM_BREAKOUT — Range breakout momentum with dynamic ATR & volume expansion
 *  3. BOLLINGER_SQUEEZE — Volatility squeeze mean reversion at outer bands with RSI filter
 */

// ─── Indicator Helpers ────────────────────────────────────────────────────────

/**
 * Compute Exponential Moving Average (EMA).
 */
export function computeEMA(klines, period) {
    if (!klines || klines.length < period) return null;
    const closes = klines.map(k => k.close);
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] * k) + (ema * (1 - k));
    }
    return ema;
}

/**
 * Compute Volume-Weighted Average Price (VWAP) over a rolling window.
 */
export function computeVWAP(klines, window = 60) {
    if (!klines || klines.length === 0) return null;
    const slice = klines.slice(-window);
    let totalTypicalPriceVol = 0;
    let totalVol = 0;
    for (const k of slice) {
        const typicalPrice = (k.high + k.low + k.close) / 3;
        totalTypicalPriceVol += typicalPrice * k.volume;
        totalVol += k.volume;
    }
    return totalVol > 0 ? totalTypicalPriceVol / totalVol : slice[slice.length - 1].close;
}

/**
 * Compute Bollinger Bands (20-period, 2 std dev) and Band Width (BBW).
 */
export function computeBollingerBands(klines, period = 20, multiplier = 2) {
    if (!klines || klines.length < period) return null;
    const slice = klines.slice(-period);
    const closes = slice.map(k => k.close);
    const mean = closes.reduce((s, c) => s + c, 0) / period;
    const variance = closes.reduce((s, c) => s + Math.pow(c - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    const upper = mean + (multiplier * stdDev);
    const lower = mean - (multiplier * stdDev);
    const bbw = mean > 0 ? (upper - lower) / mean : 0;
    return { middle: mean, upper, lower, bbw, stdDev };
}

/**
 * Compute RSI (Relative Strength Index) from kline close prices.
 */
export function computeRSI(klines, period = 14) {
    if (!klines || klines.length < period + 2) {
        return { value: 50, trend: 'flat' };
    }

    const closes = klines.map(k => k.close);
    let gains = 0, losses = 0;

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


// ─── Strategy 1: EMA/VWAP Confluence ─────────────────────────────────────────

export function evalEmaVwapConfluence(ind) {
    const ethKlines = ind.eth.klines;
    if (!ethKlines || ethKlines.length < 30) return null;

    const ema9 = computeEMA(ethKlines, 9);
    const ema21 = computeEMA(ethKlines, 21);
    const vwap = computeVWAP(ethKlines, 60);
    const rsi = computeRSI(ethKlines, 14);

    if (!ema9 || !ema21 || !vwap) return null;

    const lastCandle = ethKlines[ethKlines.length - 1];
    const price = lastCandle.close;
    const isGreen = lastCandle.close > lastCandle.open;
    const isRed = lastCandle.close < lastCandle.open;

    // LONG: EMA9 > EMA21, price above VWAP, green candle, RSI between 40 and 68
    const isLong = ema9 > ema21
        && price > vwap
        && isGreen
        && rsi.value >= 40 && rsi.value <= 68
        && ind.btc.change1h > -0.3;

    // SHORT: EMA9 < EMA21, price below VWAP, red candle, RSI between 32 and 60
    const isShort = ema9 < ema21
        && price < vwap
        && isRed
        && rsi.value >= 32 && rsi.value <= 60
        && ind.btc.change1h < 0.3;

    if (isLong) {
        let score = 60;
        const distEma9 = Math.abs(price - ema9) / price;
        if (distEma9 < 0.003) score += 10;
        if (ind.eth.volumeRatio && ind.eth.volumeRatio > 1.15) score += 10;
        if (ind.eth.relativeStrength === 'stronger') score += 10;
        return { type: 'EMA_VWAP_CONFLUENCE', direction: 'BUY', score, ema9, ema21, vwap, rsi: rsi.value };
    }

    if (isShort) {
        let score = 60;
        const distEma9 = Math.abs(price - ema9) / price;
        if (distEma9 < 0.003) score += 10;
        if (ind.eth.volumeRatio && ind.eth.volumeRatio > 1.15) score += 10;
        if (ind.eth.relativeStrength === 'weaker') score += 10;
        return { type: 'EMA_VWAP_CONFLUENCE', direction: 'SELL', score, ema9, ema21, vwap, rsi: rsi.value };
    }

    return null;
}


// ─── Strategy 2: Momentum Breakout ───────────────────────────────────────────

export function evalMomentumBreakout(ind) {
    const ethKlines = ind.eth.klines;
    if (!ethKlines || ethKlines.length < 35) return null;

    const recent20 = ethKlines.slice(-21, -1);
    if (recent20.length < 20) return null;

    const high20 = Math.max(...recent20.map(k => k.high));
    const low20 = Math.min(...recent20.map(k => k.low));

    const lastCandle = ethKlines[ethKlines.length - 1];
    const price = lastCandle.close;
    const atr = ind.eth.atr14 || (price * 0.002);
    const volumeRatio = ind.eth.volumeRatio || 1.0;

    const ema9 = computeEMA(ethKlines, 9);
    const ema21 = computeEMA(ethKlines, 21);

    if (!ema9 || !ema21) return null;

    // LONG breakout: price closes above high20 + 0.25*ATR, green candle, volume > 1.2x avg, EMA9 > EMA21
    const isLong = price > high20 + (0.25 * atr)
        && lastCandle.close > lastCandle.open
        && volumeRatio >= 1.2
        && ema9 > ema21;

    // SHORT breakdown: price closes below low20 - 0.25*ATR, red candle, volume > 1.2x avg, EMA9 < EMA21
    const isShort = price < low20 - (0.25 * atr)
        && lastCandle.close < lastCandle.open
        && volumeRatio >= 1.2
        && ema9 < ema21;

    if (isLong) {
        let score = 65;
        if (volumeRatio > 1.6) score += 10;
        if (ind.eth.relativeStrength === 'stronger') score += 10;
        return { type: 'MOMENTUM_BREAKOUT', direction: 'BUY', score, high20, low20, volumeRatio };
    }

    if (isShort) {
        let score = 65;
        if (volumeRatio > 1.6) score += 10;
        if (ind.eth.relativeStrength === 'weaker') score += 10;
        return { type: 'MOMENTUM_BREAKOUT', direction: 'SELL', score, high20, low20, volumeRatio };
    }

    return null;
}


// ─── Strategy 3: Bollinger Squeeze Reversion ─────────────────────────────────

export function evalBollingerSqueeze(ind) {
    const ethKlines = ind.eth.klines;
    if (!ethKlines || ethKlines.length < 35) return null;

    const bb = computeBollingerBands(ethKlines, 20, 2);
    if (!bb) return null;

    const rsi = computeRSI(ethKlines, 14);
    const lastCandle = ethKlines[ethKlines.length - 1];

    // Squeeze filter: BBW should be compressed (< 1.8% of price)
    const isSqueezed = bb.bbw <= 0.018;
    if (!isSqueezed) return null;

    // LONG: Low touched or pierced lower band, RSI < 38 & rising, BTC not dumping
    const isLong = lastCandle.low <= bb.lower * 1.0008
        && rsi.value < 38 && rsi.trend === 'rising'
        && ind.btc.change5m > -0.3;

    // SHORT: High touched or pierced upper band, RSI > 62 & falling, BTC not pumping
    const isShort = lastCandle.high >= bb.upper * 0.9992
        && rsi.value > 62 && rsi.trend === 'falling'
        && ind.btc.change5m < 0.3;

    if (isLong) {
        let score = 60;
        if (rsi.value < 28) score += 10;
        if (bb.bbw < 0.010) score += 10;
        return { type: 'BOLLINGER_SQUEEZE', direction: 'BUY', score, rsi: rsi.value, bbw: bb.bbw };
    }

    if (isShort) {
        let score = 60;
        if (rsi.value > 72) score += 10;
        if (bb.bbw < 0.010) score += 10;
        return { type: 'BOLLINGER_SQUEEZE', direction: 'SELL', score, rsi: rsi.value, bbw: bb.bbw };
    }

    return null;
}


// ─── Strategy Runner ─────────────────────────────────────────────────────────

/**
 * Run active strategies and return the best signal (highest score).
 * @param {object} ind - indicators from computeIndicators()
 * @param {number} minScore - minimum score to accept (default 65)
 * @param {boolean} isParallelMock - whether in parallel mock mode
 * @returns {{ type, direction, score, ... } | null}
 */
export function runAllStrategies(ind, minScore = 65, isParallelMock = false) {
    const allStrategies = [
        { name: 'EmaVwapConfluence', fn: evalEmaVwapConfluence, regimes: ['TREND_UP', 'TREND_DOWN'] },
        { name: 'MomentumBreakout', fn: evalMomentumBreakout, regimes: ['TREND_UP', 'TREND_DOWN'] },
        { name: 'BollingerSqueeze', fn: evalBollingerSqueeze, regimes: ['RANGE'] },
    ];

    const currentRegime = ind.regime || 'RANGE';

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

    results.sort((a, b) => b.score - a.score);
    const best = results[0];
    console.log(`[Strategies] Winner: ${best.type} ${best.direction} score=${best.score} (${results.length} candidates)`);
    return best;
}
