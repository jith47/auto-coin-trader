/**
 * V5 EDGE STRATEGIES — 10 distinct, non-overlapping strategies
 * 
 * Kept Strategy:
 *  1. MOMENTUM_5M — Proven working strategy (ETH 5m price momentum with volume)
 * 
 * New Technical & Market Microstructure Strategies:
 *  2. VWAP_CROSS — Price cross of 20-candle Volume Weighted Average Price
 *  3. EMA_RIBBON — Fast EMA (5) vs Slow EMA (20) trend alignment & momentum
 *  4. BOLLINGER_SQUEEZE — Volatility compression followed by breakout expansion
 *  5. RSI_DIVERGENCE — 14-period RSI divergence & extreme reversal
 *  6. DELTA_FLIP — Order flow / CVD direction flip with taker volume confirmation
 *  7. ABSORPTION — High volume surge with tight candle range (liquidity absorption)
 *  8. MEAN_REVERT_Z — Statistical Z-score deviation (> 1.8 std dev) from SMA
 *  9. MOMENTUM_DIVERGE — Price momentum vs Volume momentum exhaustion divergence
 * 10. MULTI_TF_ALIGN — Confluence across BTC 1h trend, ETH 5m momentum & taker flow
 */

// ── INDICATOR HELPER FUNCTIONS ──

function getCloses(klines) {
    if (!klines || !Array.isArray(klines)) return [];
    return klines.map(k => k.close).filter(c => typeof c === 'number' && !isNaN(c));
}

function calculateSMA(closes, period) {
    if (closes.length < period) return null;
    const slice = closes.slice(closes.length - period);
    const sum = slice.reduce((a, b) => a + b, 0);
    return sum / period;
}

function calculateEMA(closes, period) {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] * k) + (ema * (1 - k));
    }
    return ema;
}

function calculateStdDev(closes, period, sma) {
    if (closes.length < period) return null;
    const slice = closes.slice(closes.length - period);
    const mean = sma ?? (slice.reduce((a, b) => a + b, 0) / period);
    const squaredDiffs = slice.map(val => Math.pow(val - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
    return Math.sqrt(variance);
}

function calculateVWAP(klines, period = 20) {
    if (!klines || klines.length < period) return null;
    const slice = klines.slice(klines.length - period);
    let cumulativeTPV = 0;
    let cumulativeVol = 0;
    for (const k of slice) {
        const tp = (k.high + k.low + k.close) / 3;
        const vol = k.volume || 1;
        cumulativeTPV += tp * vol;
        cumulativeVol += vol;
    }
    return cumulativeVol > 0 ? cumulativeTPV / cumulativeVol : null;
}

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// ── 1. MOMENTUM_5M (KEPT WORKING STRATEGY) ──
export function evalMomentum5m(ind) {
    const eth5m = ind.eth.change5m || 0;
    const volRatio = ind.eth.volumeRatio || 1;
    
    if (eth5m > 0.12 && volRatio > 0.8) {
        return { type: 'MOMENTUM_5M', direction: 'BUY', score: 62 + Math.min(28, Math.round(eth5m * 20 + (volRatio - 0.8) * 10)) };
    }
    if (eth5m < -0.12 && volRatio > 0.8) {
        return { type: 'MOMENTUM_5M', direction: 'SELL', score: 62 + Math.min(28, Math.round(Math.abs(eth5m) * 20 + (volRatio - 0.8) * 10)) };
    }
    return null;
}

// ── 2. VWAP_CROSS ──
export function evalVwapCross(ind) {
    const klines = ind.eth.klines;
    if (!klines || klines.length < 20) return null;

    const vwap = calculateVWAP(klines, 20);
    if (!vwap) return null;

    const curr = klines[klines.length - 1];
    const prev = klines[klines.length - 2];
    const volRatio = ind.eth.volumeRatio || 1.0;

    // Bullish cross over VWAP with volume
    if (prev.close <= vwap && curr.close > vwap && volRatio >= 0.7) {
        return { type: 'VWAP_CROSS', direction: 'BUY', score: 64 + Math.min(20, Math.round((volRatio - 0.7) * 15)) };
    }
    // Bearish cross under VWAP with volume
    if (prev.close >= vwap && curr.close < vwap && volRatio >= 0.7) {
        return { type: 'VWAP_CROSS', direction: 'SELL', score: 64 + Math.min(20, Math.round((volRatio - 0.7) * 15)) };
    }

    // Extended away from VWAP with momentum
    const distPct = ((curr.close - vwap) / vwap) * 100;
    if (distPct > 0.15 && ind.eth.change5m > 0.08) {
        return { type: 'VWAP_CROSS', direction: 'BUY', score: 62 };
    }
    if (distPct < -0.15 && ind.eth.change5m < -0.08) {
        return { type: 'VWAP_CROSS', direction: 'SELL', score: 62 };
    }

    return null;
}

// ── 3. EMA_RIBBON ──
export function evalEmaRibbon(ind) {
    const closes = getCloses(ind.eth.klines);
    if (closes.length < 20) return null;

    const ema5 = calculateEMA(closes, 5);
    const ema20 = calculateEMA(closes, 20);
    if (!ema5 || !ema20) return null;

    const eth5m = ind.eth.change5m || 0;
    const spreadPct = ((ema5 - ema20) / ema20) * 100;

    // Fast EMA above slow EMA & current price moving up
    if (spreadPct > 0.04 && eth5m > 0.04) {
        return { type: 'EMA_RIBBON', direction: 'BUY', score: 63 + Math.min(25, Math.round(spreadPct * 50)) };
    }
    // Fast EMA below slow EMA & current price moving down
    if (spreadPct < -0.04 && eth5m < -0.04) {
        return { type: 'EMA_RIBBON', direction: 'SELL', score: 63 + Math.min(25, Math.round(Math.abs(spreadPct) * 50)) };
    }

    return null;
}

// ── 4. BOLLINGER_SQUEEZE ──
export function evalBollingerSqueeze(ind) {
    const closes = getCloses(ind.eth.klines);
    if (closes.length < 20) return null;

    const sma = calculateSMA(closes, 20);
    const stdDev = calculateStdDev(closes, 20, sma);
    if (!sma || !stdDev || sma === 0) return null;

    const upperBand = sma + (2 * stdDev);
    const lowerBand = sma - (2 * stdDev);
    const bandwidthPct = ((upperBand - lowerBand) / sma) * 100;
    const lastClose = closes[closes.length - 1];
    const eth5m = ind.eth.change5m || 0;

    // Squeeze condition (narrow bands < 0.8%) followed by breakout
    if (bandwidthPct < 0.8) {
        if (lastClose > sma && eth5m > 0.05) {
            return { type: 'BOLLINGER_SQUEEZE', direction: 'BUY', score: 66 };
        }
        if (lastClose < sma && eth5m < -0.05) {
            return { type: 'BOLLINGER_SQUEEZE', direction: 'SELL', score: 66 };
        }
    }

    // Outer band touch / breakout
    if (lastClose >= upperBand && eth5m > 0.08) {
        return { type: 'BOLLINGER_SQUEEZE', direction: 'BUY', score: 65 };
    }
    if (lastClose <= lowerBand && eth5m < -0.08) {
        return { type: 'BOLLINGER_SQUEEZE', direction: 'SELL', score: 65 };
    }

    return null;
}

// ── 5. RSI_DIVERGENCE ──
export function evalRsiDivergence(ind) {
    const closes = getCloses(ind.eth.klines);
    if (closes.length < 25) return null;

    const rsi = calculateRSI(closes, 14);
    const eth5m = ind.eth.change5m || 0;

    // Oversold reversal (< 35) with positive 5m change
    if (rsi < 35 && eth5m > 0.03) {
        return { type: 'RSI_DIVERGENCE', direction: 'BUY', score: 65 + Math.round((35 - rsi) * 0.8) };
    }
    // Overbought reversal (> 65) with negative 5m change
    if (rsi > 65 && eth5m < -0.03) {
        return { type: 'RSI_DIVERGENCE', direction: 'SELL', score: 65 + Math.round((rsi - 65) * 0.8) };
    }

    // Divergence check over last 15 bars
    const recentPrices = closes.slice(closes.length - 5);
    const olderPrices = closes.slice(closes.length - 15, closes.length - 5);
    const minRecentPrice = Math.min(...recentPrices);
    const minOlderPrice = Math.min(...olderPrices);
    const maxRecentPrice = Math.max(...recentPrices);
    const maxOlderPrice = Math.max(...olderPrices);

    const rsiOlder = calculateRSI(closes.slice(0, closes.length - 5), 14);

    // Bullish Divergence: Lower price low, but higher RSI
    if (minRecentPrice < minOlderPrice && rsi > rsiOlder + 3) {
        return { type: 'RSI_DIVERGENCE', direction: 'BUY', score: 68 };
    }
    // Bearish Divergence: Higher price high, but lower RSI
    if (maxRecentPrice > maxOlderPrice && rsi < rsiOlder - 3) {
        return { type: 'RSI_DIVERGENCE', direction: 'SELL', score: 68 };
    }

    return null;
}

// ── 6. DELTA_FLIP ──
export function evalDeltaFlip(ind) {
    const edge = ind.edge;
    const cvd = ind.eth.cvdDirection;
    const eth5m = ind.eth.change5m || 0;

    const takerRatio = edge?.takerFlow?.buySellRatio ?? 1.0;

    // Rising CVD & Taker Buy dominance > 1.15
    if (cvd === 'rising' && takerRatio > 1.15 && eth5m >= 0) {
        return { type: 'DELTA_FLIP', direction: 'BUY', score: 65 + Math.min(25, Math.round((takerRatio - 1.15) * 40)) };
    }
    // Falling CVD & Taker Sell dominance < 0.85
    if (cvd === 'falling' && takerRatio < 0.85 && eth5m <= 0) {
        return { type: 'DELTA_FLIP', direction: 'SELL', score: 65 + Math.min(25, Math.round((0.85 - takerRatio) * 40)) };
    }

    return null;
}

// ── 7. ABSORPTION ──
export function evalAbsorption(ind) {
    const klines = ind.eth.klines;
    if (!klines || klines.length < 5) return null;

    const curr = klines[klines.length - 1];
    const range = curr.high - curr.low;
    if (range <= 0) return null;

    const body = Math.abs(curr.close - curr.open);
    const bodyRatio = body / range;
    const volRatio = ind.eth.volumeRatio || 1.0;
    const rangePos = ind.eth.rangePosition ?? 0.5;

    // High volume (> 1.3x) with compressed body (< 35% of range) = Heavy absorption
    if (volRatio > 1.3 && bodyRatio < 0.35) {
        // Absorption near range low = smart money buying bottom -> BUY
        if (rangePos < 0.4) {
            return { type: 'ABSORPTION', direction: 'BUY', score: 66 + Math.min(20, Math.round((volRatio - 1.3) * 20)) };
        }
        // Absorption near range high = smart money selling top -> SELL
        if (rangePos > 0.6) {
            return { type: 'ABSORPTION', direction: 'SELL', score: 66 + Math.min(20, Math.round((volRatio - 1.3) * 20)) };
        }
    }

    return null;
}

// ── 8. MEAN_REVERT_Z ──
export function evalMeanRevertZ(ind) {
    const closes = getCloses(ind.eth.klines);
    if (closes.length < 20) return null;

    const sma = calculateSMA(closes, 20);
    const stdDev = calculateStdDev(closes, 20, sma);
    if (!sma || !stdDev || stdDev === 0) return null;

    const lastClose = closes[closes.length - 1];
    const zScore = (lastClose - sma) / stdDev;
    const eth5m = ind.eth.change5m || 0;

    // Severe downside stretch (Z < -1.8) with bounce sign -> BUY
    if (zScore < -1.8 && eth5m > -0.10) {
        return { type: 'MEAN_REVERT_Z', direction: 'BUY', score: 64 + Math.min(25, Math.round(Math.abs(zScore) * 6)) };
    }
    // Severe upside stretch (Z > 1.8) with rejection sign -> SELL
    if (zScore > 1.8 && eth5m < 0.10) {
        return { type: 'MEAN_REVERT_Z', direction: 'SELL', score: 64 + Math.min(25, Math.round(zScore * 6)) };
    }

    return null;
}

// ── 9. MOMENTUM_DIVERGE ──
export function evalMomentumDiverge(ind) {
    const eth5m = ind.eth.change5m || 0;
    const volRatio = ind.eth.volumeRatio || 1.0;

    // Price pushing UP strong (> +0.10%) but volume collapsing (< 0.6x) = Exhaustion -> SELL
    if (eth5m > 0.10 && volRatio < 0.65) {
        return { type: 'MOMENTUM_DIVERGE', direction: 'SELL', score: 64 + Math.round((0.65 - volRatio) * 30) };
    }
    // Price pushing DOWN strong (< -0.10%) but volume collapsing (< 0.6x) = Exhaustion -> BUY
    if (eth5m < -0.10 && volRatio < 0.65) {
        return { type: 'MOMENTUM_DIVERGE', direction: 'BUY', score: 64 + Math.round((0.65 - volRatio) * 30) };
    }

    return null;
}

// ── 10. MULTI_TF_ALIGN ──
export function evalMultiTfAlign(ind) {
    const btc1h = ind.btc?.change1h || 0;
    const eth5m = ind.eth?.change5m || 0;
    const takerRatio = ind.edge?.takerFlow?.buySellRatio ?? 1.0;

    // Bullish alignment across macro (BTC 1h > +0.15%), micro (ETH 5m > +0.05%), and order flow (Taker > 1.05)
    if (btc1h > 0.15 && eth5m > 0.05 && takerRatio >= 1.05) {
        return { type: 'MULTI_TF_ALIGN', direction: 'BUY', score: 68 + Math.min(20, Math.round(btc1h * 15)) };
    }
    // Bearish alignment across macro (BTC 1h < -0.15%), micro (ETH 5m < -0.05%), and order flow (Taker < 0.95)
    if (btc1h < -0.15 && eth5m < -0.05 && takerRatio <= 0.95) {
        return { type: 'MULTI_TF_ALIGN', direction: 'SELL', score: 68 + Math.min(20, Math.round(Math.abs(btc1h) * 15)) };
    }

    return null;
}
