/**
 * V7 ADAPTIVE TOURNAMENT STRATEGY ENGINE — 15 Diverse Market Strategies
 * 
 * Predatory & Institutional Strategies:
 *  1. SWEEP_RECLAIM        — Liquidity Sweep & Reclaim (Structural)
 *  2. STOP_HUNT            — Stop Loss Hunter (Microstructure Range Reversal)
 *  3. OI_TRAP              — Open Interest Trap (Positioning Fade)
 *  4. SESSION_OPEN         — Session Open Momentum (Institutional Timing)
 *  5. FUNDING_SQUEEZE      — Funding Rate Squeeze (Cascade Reversal)
 *  6. LIQUIDATION_CASCADE  — Liquidation Cascade Rider (Structural Momentum)
 *  7. ABSORPTION_REVERSAL  — Smart Money Absorption (Order Flow Reversal)
 *  8. RETAIL_FADE          — Retail Sentiment Fade (Contrarian Cascade)
 *  9. WHALE_IMBALANCE      — Whale Imbalance Detection (Order Flow Follow)
 * 10. MICRO_SCALP          — Micro Momentum Scalp (3-Bar Acceleration)
 * 
 * Proven Legacy Strategies:
 * 11. MOMENTUM_5M          — 5M Momentum Surge with Volume Expansion
 * 12. TAKER_SURGE          — Aggressive Taker Order Flow Surge
 * 13. CVD_PRICE_DIV        — Cumulative Volume Delta Divergence vs Price
 * 14. BTC_FOLLOW           — BTC Trend Leader Exploitation
 * 15. RANGE_BOUNCE         — Range Boundary Fade & Reversal
 */

// ── 1. SWEEP_RECLAIM (Structural Liquidity Sweep & Reclaim) ──
export function evalSweepReclaim(ind) {
    const btcStruct = ind.btc.structure;
    const liqEvent = ind.liquidations?.recentEvent;
    const klines = ind.eth.klines;

    // Check BTC structure triggers first
    if (btcStruct === 'sweep_reclaim_bullish' || liqEvent === 'longs_flushed') {
        const score = 72 + (liqEvent === 'longs_flushed' ? 10 : 0);
        return { type: 'SWEEP_RECLAIM', direction: 'BUY', score };
    }
    if (btcStruct === 'sweep_reclaim_bearish' || liqEvent === 'shorts_squeezed') {
        const score = 72 + (liqEvent === 'shorts_squeezed' ? 10 : 0);
        return { type: 'SWEEP_RECLAIM', direction: 'SELL', score };
    }

    // Microstructure check on ETH 1m klines (look back 15 candles)
    if (!klines || klines.length < 16) return null;
    const lookback = klines.slice(-16, -1);
    const current = klines[klines.length - 1];
    const prev = klines[klines.length - 2];

    const swingLow = Math.min(...lookback.map(k => k.low));
    const swingHigh = Math.max(...lookback.map(k => k.high));

    // Bullish reclaim: previous or current wick pierced swing low, but current close reclaims above
    const sweptLow = prev.low < swingLow || current.low < swingLow;
    if (sweptLow && current.close > swingLow && current.close > current.open) {
        const depth = ((swingLow - Math.min(prev.low, current.low)) / swingLow) * 100;
        return { type: 'SWEEP_RECLAIM', direction: 'BUY', score: 68 + Math.min(22, Math.round(depth * 50)) };
    }

    // Bearish reclaim: previous or current wick pierced swing high, but current close rejects below
    const sweptHigh = prev.high > swingHigh || current.high > swingHigh;
    if (sweptHigh && current.close < swingHigh && current.close < current.open) {
        const depth = ((Math.max(prev.high, current.high) - swingHigh) / swingHigh) * 100;
        return { type: 'SWEEP_RECLAIM', direction: 'SELL', score: 68 + Math.min(22, Math.round(depth * 50)) };
    }

    return null;
}

// ── 2. STOP_HUNT (Stop Loss Hunter at 20-Candle Extremes) ──
export function evalStopHunt(ind) {
    const klines = ind.eth.klines;
    if (!klines || klines.length < 5) return null;

    const current = klines[klines.length - 1];
    const rangeHigh = ind.eth.rangeHigh20 || current.high;
    const rangeLow = ind.eth.rangeLow20 || current.low;
    const pos = ind.eth.rangePosition != null ? ind.eth.rangePosition : 0.5;

    const candleRange = current.high - current.low;
    if (candleRange <= 0) return null;

    const lowerWick = (Math.min(current.open, current.close) - current.low) / candleRange;
    const upperWick = (current.high - Math.max(current.open, current.close)) / candleRange;

    // Lower stop hunt: price dipped to/below rangeLow with long lower wick (> 40%) & closed green/inside
    if ((current.low <= rangeLow * 1.0002 || pos < 0.15) && lowerWick >= 0.40 && current.close >= current.open) {
        return { type: 'STOP_HUNT', direction: 'BUY', score: 66 + Math.round(lowerWick * 20) };
    }

    // Upper stop hunt: price reached to/above rangeHigh with long upper wick (> 40%) & closed red/inside
    if ((current.high >= rangeHigh * 0.9998 || pos > 0.85) && upperWick >= 0.40 && current.close <= current.open) {
        return { type: 'STOP_HUNT', direction: 'SELL', score: 66 + Math.round(upperWick * 20) };
    }

    return null;
}

// ── 3. OI_TRAP (Open Interest Trap) ──
export function evalOiTrap(ind) {
    const oi = ind.edge?.openInterest;
    if (!oi) return null;

    const oiChangePct = oi.changePct5m || 0;
    const eth5m = ind.eth.change5m || 0;
    const taker = ind.edge?.takerFlow?.buySellRatio || 1.0;
    const ethCvd = ind.eth.cvdDirection;

    // Condition: Significant OI expansion (> 0.20%) but price stagnating / absorbing (|eth5m| < 0.12%)
    if (Math.abs(oiChangePct) >= 0.20 && Math.abs(eth5m) < 0.12) {
        // Retail longs trapped: buying flow high or CVD rising, but price couldn't rally -> trap!
        if (taker >= 1.20 || ethCvd === 'rising') {
            return { type: 'OI_TRAP', direction: 'SELL', score: 68 + Math.min(22, Math.round(Math.abs(oiChangePct) * 15)) };
        }
        // Retail shorts trapped: selling flow high or CVD falling, but price refused to dump -> trap!
        if (taker <= 0.80 || ethCvd === 'falling') {
            return { type: 'OI_TRAP', direction: 'BUY', score: 68 + Math.min(22, Math.round(Math.abs(oiChangePct) * 15)) };
        }
    }

    return null;
}

// ── 4. SESSION_OPEN (Session Open Momentum) ──
export function evalSessionOpen(ind) {
    const hour = ind.session?.hour ?? (new Date().getUTCHours() + new Date().getUTCMinutes() / 60);
    // London Open window: 07:00 - 08:30 UTC
    // US / New York Open window: 12:30 - 14:30 UTC
    const isLondon = hour >= 7.0 && hour <= 8.5;
    const isUS = hour >= 12.5 && hour <= 14.5;

    if (!isLondon && !isUS) return null;

    const btc5m = ind.btc.change5m || 0;
    const eth5m = ind.eth.change5m || 0;

    // Directional alignment across BTC & ETH with conviction
    if (btc5m > 0.08 && eth5m > 0.08) {
        const bonus = Math.min(18, Math.round((btc5m + eth5m) * 25));
        return { type: 'SESSION_OPEN', direction: 'BUY', score: 70 + bonus };
    }
    if (btc5m < -0.08 && eth5m < -0.08) {
        const bonus = Math.min(18, Math.round(Math.abs(btc5m + eth5m) * 25));
        return { type: 'SESSION_OPEN', direction: 'SELL', score: 70 + bonus };
    }

    return null;
}

// ── 5. FUNDING_SQUEEZE (Funding Rate Squeeze) ──
export function evalFundingSqueeze(ind) {
    const funding = ind.edge?.fundingRate;
    if (funding == null) return null;

    const eth5m = ind.eth.change5m || 0;
    const ethCvd = ind.eth.cvdDirection;

    // Extreme positive funding (longs paying heavily > 0.025% per 8h)
    // When momentum turns down, leveraged longs are liquidated
    if (funding >= 0.00025 && (eth5m < -0.04 || ethCvd === 'falling')) {
        const bonus = Math.min(20, Math.round(funding * 40000));
        return { type: 'FUNDING_SQUEEZE', direction: 'SELL', score: 66 + bonus };
    }

    // Negative funding (shorts paying heavily < -0.008% per 8h)
    // When momentum turns up, shorts are squeezed violently
    if (funding <= -0.00008 && (eth5m > 0.04 || ethCvd === 'rising')) {
        const bonus = Math.min(20, Math.round(Math.abs(funding) * 50000));
        return { type: 'FUNDING_SQUEEZE', direction: 'BUY', score: 66 + bonus };
    }

    return null;
}

// ── 6. LIQUIDATION_CASCADE (Liquidation Cascade Rider) ──
export function evalLiquidationCascade(ind) {
    const liqEvent = ind.liquidations?.recentEvent;
    const volRatio = ind.eth.volumeRatio || 1.0;
    const eth5m = ind.eth.change5m || 0;

    // Direct liquidation alert from tracker
    if (liqEvent === 'longs_flushed') {
        return { type: 'LIQUIDATION_CASCADE', direction: 'SELL', score: 76 };
    }
    if (liqEvent === 'shorts_squeezed') {
        return { type: 'LIQUIDATION_CASCADE', direction: 'BUY', score: 76 };
    }

    // Microstructure cascade: high volume surge (> 1.8x) combined with rapid breakout momentum
    if (volRatio >= 1.8) {
        if (eth5m > 0.18) {
            return { type: 'LIQUIDATION_CASCADE', direction: 'BUY', score: 68 + Math.min(22, Math.round(eth5m * 20)) };
        }
        if (eth5m < -0.18) {
            return { type: 'LIQUIDATION_CASCADE', direction: 'SELL', score: 68 + Math.min(22, Math.round(Math.abs(eth5m) * 20)) };
        }
    }

    return null;
}

// ── 7. ABSORPTION_REVERSAL (Smart Money Absorption) ──
export function evalAbsorptionReversal(ind) {
    const volRatio = ind.eth.volumeRatio || 1.0;
    const klines = ind.eth.klines;
    if (!klines || klines.length < 3) return null;

    const lastK = klines[klines.length - 1];
    if (!lastK.open || lastK.open <= 0) return null;

    const candleBodyPct = (Math.abs(lastK.close - lastK.open) / lastK.open) * 100;
    const taker = ind.edge?.takerFlow?.buySellRatio || 1.0;
    const ethCvd = ind.eth.cvdDirection;

    // High volume (> 1.5x) with tiny candle body (< 0.05%) indicates aggressive absorption
    if (volRatio >= 1.5 && candleBodyPct < 0.05) {
        // Smart money absorbing selling into bids: trade with buyers
        if (taker >= 1.15 || ethCvd === 'rising') {
            return { type: 'ABSORPTION_REVERSAL', direction: 'BUY', score: 66 + Math.min(22, Math.round((volRatio - 1.5) * 15)) };
        }
        // Smart money absorbing buying into asks: trade with sellers
        if (taker <= 0.85 || ethCvd === 'falling') {
            return { type: 'ABSORPTION_REVERSAL', direction: 'SELL', score: 66 + Math.min(22, Math.round((volRatio - 1.5) * 15)) };
        }
    }

    return null;
}

// ── 8. RETAIL_FADE (Retail Sentiment Fade) ──
export function evalRetailFade(ind) {
    const lsRatio = ind.edge?.globalLS?.ratio;
    if (lsRatio == null) return null;

    const eth5m = ind.eth.change5m || 0;

    // Retail heavily long (> 1.60) and price starts falling -> crowd panic unwind
    if (lsRatio >= 1.60 && eth5m < -0.04) {
        const bonus = Math.min(20, Math.round((lsRatio - 1.60) * 15));
        return { type: 'RETAIL_FADE', direction: 'SELL', score: 66 + bonus };
    }

    // Retail heavily short (< 0.65) and price starts rising -> crowd squeeze unwind
    if (lsRatio <= 0.65 && eth5m > 0.04) {
        const bonus = Math.min(20, Math.round((0.65 - lsRatio) * 20));
        return { type: 'RETAIL_FADE', direction: 'BUY', score: 66 + bonus };
    }

    return null;
}

// ── 9. WHALE_IMBALANCE (Whale Imbalance Detection) ──
export function evalWhaleImbalance(ind) {
    const taker = ind.edge?.takerFlow?.buySellRatio;
    if (taker == null) return null;

    const oiChangePct = ind.edge?.openInterest?.changePct5m || 0;
    const ethCvd = ind.eth.cvdDirection;

    // Institutional aggressive buy flow (taker > 1.35) with steady/growing OI
    if (taker >= 1.35 && oiChangePct >= -0.05 && ethCvd === 'rising') {
        const score = 68 + Math.min(22, Math.round((taker - 1.35) * 25));
        return { type: 'WHALE_IMBALANCE', direction: 'BUY', score };
    }

    // Institutional aggressive sell flow (taker < 0.72) with steady/growing OI
    if (taker <= 0.72 && oiChangePct >= -0.05 && ethCvd === 'falling') {
        const score = 68 + Math.min(22, Math.round((0.72 - taker) * 25));
        return { type: 'WHALE_IMBALANCE', direction: 'SELL', score };
    }

    return null;
}

// ── 10. MICRO_SCALP (Micro Momentum Scalp) ──
export function evalMicroScalp(ind) {
    const klines = ind.eth.klines;
    if (!klines || klines.length < 4) return null;

    const c1 = klines[klines.length - 3];
    const c2 = klines[klines.length - 2];
    const c3 = klines[klines.length - 1];

    const b1 = c1.close - c1.open;
    const b2 = c2.close - c2.open;
    const b3 = c3.close - c3.open;

    // 3 consecutive bullish bars with accelerating or strong size
    if (b1 > 0 && b2 > 0 && b3 > 0) {
        const pct3 = c1.open > 0 ? ((c3.close - c1.open) / c1.open) * 100 : 0;
        if (pct3 >= 0.10) {
            return { type: 'MICRO_SCALP', direction: 'BUY', score: 65 + Math.min(25, Math.round(pct3 * 40)) };
        }
    }

    // 3 consecutive bearish bars with accelerating or strong size
    if (b1 < 0 && b2 < 0 && b3 < 0) {
        const pct3 = c1.open > 0 ? ((c1.open - c3.close) / c1.open) * 100 : 0;
        if (pct3 >= 0.10) {
            return { type: 'MICRO_SCALP', direction: 'SELL', score: 65 + Math.min(25, Math.round(pct3 * 40)) };
        }
    }

    return null;
}

// ── 11. MOMENTUM_5M (5M Momentum Surge with Volume Expansion) ──
export function evalMomentum5m(ind) {
    const eth5m = ind.eth.change5m || 0;
    const volRatio = ind.eth.volumeRatio || 1.0;

    if (eth5m > 0.12 && volRatio > 0.8) {
        const score = 62 + Math.min(28, Math.round(eth5m * 20 + (volRatio - 0.8) * 10));
        return { type: 'MOMENTUM_5M', direction: 'BUY', score };
    }
    if (eth5m < -0.12 && volRatio > 0.8) {
        const score = 62 + Math.min(28, Math.round(Math.abs(eth5m) * 20 + (volRatio - 0.8) * 10));
        return { type: 'MOMENTUM_5M', direction: 'SELL', score };
    }
    return null;
}

// ── 12. TAKER_SURGE (Aggressive Taker Order Flow Surge) ──
export function evalTakerSurge(ind) {
    const tf = ind.edge?.takerFlow;
    if (!tf) return null;
    const ratio = tf.buySellRatio || 1.0;
    const change = tf.ratioChange5m || 0;

    // Aggressive buyers taking liquidity with accelerating momentum
    if (ratio >= 1.30 && change > 0.08) {
        const score = 65 + Math.min(25, Math.round((ratio - 1.30) * 30 + change * 20));
        return { type: 'TAKER_SURGE', direction: 'BUY', score };
    }
    // Aggressive sellers taking liquidity with accelerating downward flow
    if (ratio <= 0.75 && change < -0.08) {
        const score = 65 + Math.min(25, Math.round((0.75 - ratio) * 30 + Math.abs(change) * 20));
        return { type: 'TAKER_SURGE', direction: 'SELL', score };
    }
    return null;
}

// ── 13. CVD_PRICE_DIV (Cumulative Volume Delta Divergence vs Price) ──
export function evalCvdPriceDiv(ind) {
    const eth5m = ind.eth.change5m || 0;
    const ethCvd = ind.eth.cvdDirection;
    const cvdSlope = ind.eth.cvdSlope;

    // Price falling but delta/CVD is rising -> Bullish Absorption / Divergence
    if (eth5m < -0.08 && (ethCvd === 'rising' || cvdSlope === 'rising')) {
        const score = 66 + Math.min(24, Math.round(Math.abs(eth5m) * 30));
        return { type: 'CVD_PRICE_DIV', direction: 'BUY', score };
    }
    // Price rising but delta/CVD is falling -> Bearish Exhaustion / Divergence
    if (eth5m > 0.08 && (ethCvd === 'falling' || cvdSlope === 'falling')) {
        const score = 66 + Math.min(24, Math.round(eth5m * 30));
        return { type: 'CVD_PRICE_DIV', direction: 'SELL', score };
    }
    return null;
}

// ── 14. BTC_FOLLOW (BTC Trend Leader Exploitation) ──
export function evalBtcFollow(ind) {
    const btc5m = ind.btc.change5m || 0;
    const eth5m = ind.eth.change5m || 0;

    // BTC made a strong positive move (>=0.18%) and ETH has not fully caught up
    if (btc5m >= 0.18 && eth5m < btc5m * 0.6) {
        const lag = btc5m - eth5m;
        const score = 65 + Math.min(25, Math.round(lag * 40));
        return { type: 'BTC_FOLLOW', direction: 'BUY', score };
    }
    // BTC made a strong negative dump (<=-0.18%) and ETH has not fully caught down
    if (btc5m <= -0.18 && eth5m > btc5m * 0.6) {
        const lag = eth5m - btc5m;
        const score = 65 + Math.min(25, Math.round(lag * 40));
        return { type: 'BTC_FOLLOW', direction: 'SELL', score };
    }
    return null;
}

// ── 15. RANGE_BOUNCE (Range Boundary Fade & Reversal) ──
export function evalRangeBounce(ind) {
    const rangePos = ind.eth.rangePosition;
    if (rangePos == null || isNaN(rangePos)) return null;
    const eth5m = ind.eth.change5m || 0;

    // Price at range bottom (<= 15%), rejecting further drops
    if (rangePos <= 0.15 && eth5m > -0.06) {
        const score = 64 + Math.min(26, Math.round((0.15 - rangePos) * 100));
        return { type: 'RANGE_BOUNCE', direction: 'BUY', score };
    }
    // Price at range top (>= 85%), rejecting further pumps
    if (rangePos >= 0.85 && eth5m < 0.06) {
        const score = 64 + Math.min(26, Math.round((rangePos - 0.85) * 100));
        return { type: 'RANGE_BOUNCE', direction: 'SELL', score };
    }
    return null;
}

