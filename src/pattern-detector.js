/**
 * Pattern Detector — Pure candle pattern recognition.
 * No indicators. Only raw OHLCV data.
 */

/**
 * Analyze closed candles and return all detected patterns.
 * @param {Array} candles - Array of closed candle objects (oldest first)
 * @returns {Array} Array of pattern objects { type, direction, confidence, description }
 */
export function detectPatterns(candles) {
    if (!candles || candles.length < 5) return [];

    const patterns = [];
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const prevPrev = candles.length >= 3 ? candles[candles.length - 3] : null;

    // Volume context (not an indicator — just raw comparison)
    const avgVolume = getAvgVolume(candles, 10);
    const volumeOk = last.volume >= avgVolume * 0.8;
    const volumeStrong = last.volume >= avgVolume * 1.5;

    // Skip if market is dead (last 5 candles all < 0.03% range)
    if (isDeadMarket(candles)) return [];

    // 1. Bullish Engulfing
    if (isBullishEngulfing(last, prev) && volumeOk) {
        patterns.push({
            type: 'bullish_engulfing',
            direction: 'BUY',
            confidence: volumeStrong ? 'high' : 'medium',
            description: `Green candle engulfs previous red candle${volumeStrong ? ' with strong volume' : ''}`,
            price: last.close,
        });
    }

    // 2. Bearish Engulfing
    if (isBearishEngulfing(last, prev) && volumeOk) {
        patterns.push({
            type: 'bearish_engulfing',
            direction: 'SELL',
            confidence: volumeStrong ? 'high' : 'medium',
            description: `Red candle engulfs previous green candle${volumeStrong ? ' with strong volume' : ''}`,
            price: last.close,
        });
    }

    // 3. Bullish Pin Bar (hammer)
    if (isBullishPinBar(last) && volumeOk) {
        patterns.push({
            type: 'bullish_pin_bar',
            direction: 'BUY',
            confidence: volumeStrong ? 'high' : 'medium',
            description: `Hammer — long lower wick rejection${volumeStrong ? ' with strong volume' : ''}`,
            price: last.close,
        });
    }

    // 4. Bearish Pin Bar (shooting star)
    if (isBearishPinBar(last) && volumeOk) {
        patterns.push({
            type: 'bearish_pin_bar',
            direction: 'SELL',
            confidence: volumeStrong ? 'high' : 'medium',
            description: `Shooting star — long upper wick rejection${volumeStrong ? ' with strong volume' : ''}`,
            price: last.close,
        });
    }

    // 5. Momentum Up
    if (isMomentumCandle(last, 'up') && volumeStrong) {
        patterns.push({
            type: 'momentum_up',
            direction: 'BUY',
            confidence: 'high',
            description: `Strong bullish momentum candle with volume surge`,
            price: last.close,
        });
    }

    // 6. Momentum Down
    if (isMomentumCandle(last, 'down') && volumeStrong) {
        patterns.push({
            type: 'momentum_down',
            direction: 'SELL',
            confidence: 'high',
            description: `Strong bearish momentum candle with volume surge`,
            price: last.close,
        });
    }

    // 7. Inside Bar Breakout (needs 3 candles)
    if (prevPrev) {
        const insideBreakout = detectInsideBarBreakout(last, prev, prevPrev);
        if (insideBreakout && volumeOk) {
            patterns.push({
                type: insideBreakout.direction === 'BUY' ? 'inside_bar_breakout_up' : 'inside_bar_breakout_down',
                direction: insideBreakout.direction,
                confidence: volumeStrong ? 'high' : 'medium',
                description: insideBreakout.description,
                price: last.close,
            });
        }
    }

    return patterns;
}

// --- Pattern Functions ---

function isBullishEngulfing(current, previous) {
    const currBody = current.close - current.open;
    const prevBody = previous.open - previous.close;
    // Current must be green, previous must be red
    if (currBody <= 0 || prevBody <= 0) return false;
    // Current body must fully engulf previous body
    return current.open <= previous.close && current.close >= previous.open;
}

function isBearishEngulfing(current, previous) {
    const currBody = current.open - current.close;
    const prevBody = previous.close - previous.open;
    // Current must be red, previous must be green
    if (currBody <= 0 || prevBody <= 0) return false;
    // Current body must fully engulf previous body
    return current.open >= previous.close && current.close <= previous.open;
}

function isBullishPinBar(candle) {
    const range = candle.high - candle.low;
    if (range <= 0) return false;
    const body = Math.abs(candle.close - candle.open);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    // Lower wick > 65% of range, body in top 35%, green preferred
    return (lowerWick / range) > 0.65
        && (body / range) < 0.35
        && (upperWick / range) < 0.15
        && candle.close >= candle.open; // green close
}

function isBearishPinBar(candle) {
    const range = candle.high - candle.low;
    if (range <= 0) return false;
    const body = Math.abs(candle.close - candle.open);
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    // Upper wick > 65% of range, body in bottom 35%, red preferred
    return (upperWick / range) > 0.65
        && (body / range) < 0.35
        && (lowerWick / range) < 0.15
        && candle.close <= candle.open; // red close
}

function isMomentumCandle(candle, direction) {
    const range = candle.high - candle.low;
    if (range <= 0) return false;
    const body = Math.abs(candle.close - candle.open);
    const bodyRatio = body / range;
    if (bodyRatio < 0.75) return false; // body must dominate

    if (direction === 'up') return candle.close > candle.open;
    if (direction === 'down') return candle.close < candle.open;
    return false;
}

function detectInsideBarBreakout(current, prev, prevPrev) {
    // prev must be an inside bar (contained within prevPrev)
    const isInside = prev.high <= prevPrev.high && prev.low >= prevPrev.low;
    if (!isInside) return null;

    // Current breaks out of the mother bar (prevPrev)
    if (current.close > prevPrev.high && current.close > current.open) {
        return {
            direction: 'BUY',
            description: 'Inside bar breakout — price broke above mother bar high',
        };
    }
    if (current.close < prevPrev.low && current.close < current.open) {
        return {
            direction: 'SELL',
            description: 'Inside bar breakout — price broke below mother bar low',
        };
    }
    return null;
}

// --- Utility Functions ---

function getAvgVolume(candles, lookback) {
    const slice = candles.slice(-Math.min(lookback, candles.length));
    if (slice.length === 0) return 0;
    return slice.reduce((sum, c) => sum + c.volume, 0) / slice.length;
}

function isDeadMarket(candles) {
    const last5 = candles.slice(-5);
    return last5.every(c => {
        const range = c.high - c.low;
        const pctRange = (range / c.low) * 100;
        return pctRange < 0.03;
    });
}
