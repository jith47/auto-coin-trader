/**
 * DOGE Microstructure Scalper v1.0 — Data Layer
 * All data from Binance APIs (spot REST + futures funding rate)
 */
const BINANCE_SPOT = 'https://data-api.binance.vision';
const BINANCE_FUTURES = 'https://fapi.binance.com';
const SYMBOLS = { BTC: 'BTCUSDT', DOGE: 'DOGEUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };

// ─── Data Fetching ───────────────────────────────────────────────

export async function fetchAllMarketData() {
    const { BTC, DOGE, ETH, SOL } = SYMBOLS;
    const [
        dogeDepth,
        dogeKlines5m, dogeKlines1m, doge24h,
        btcKlines5m, btcKlines1h, btc24h,
        eth24h, sol24h,
        fundingData,
    ] = await Promise.all([
        fetchOrderBookDepth(DOGE, 20),
        fetchKlines(DOGE, '5m', 30),
        fetchKlines(DOGE, '1m', 70),
        fetch24hTicker(DOGE),
        fetchKlines(BTC, '5m', 30),
        fetchKlines(BTC, '1h', 3),
        fetch24hTicker(BTC),
        fetch24hTicker(ETH),
        fetch24hTicker(SOL),
        fetchFundingRate(DOGE),
    ]);

    return {
        doge: { depth: dogeDepth, klines5m: dogeKlines5m, klines1m: dogeKlines1m, ticker24h: doge24h },
        btc: { klines5m: btcKlines5m, klines1h: btcKlines1h, ticker24h: btc24h },
        eth: { ticker24h: eth24h },
        sol: { ticker24h: sol24h },
        funding: fundingData,
    };
}

export async function fetchKlines(symbol, interval, limit) {
    try {
        const url = `${BINANCE_SPOT}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const res = await fetch(url);
        if (!res.ok) {
            console.error(`[Data] fetchKlines ${symbol} ${interval} HTTP ${res.status}`);
            return [];
        }
        const data = await res.json();
        if (!Array.isArray(data)) return [];
        return data.map(k => ({
            openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
            low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
            closeTime: k[6], quoteVolume: parseFloat(k[7]), trades: k[8],
            takerBuyVolume: parseFloat(k[9]), takerBuyQuoteVolume: parseFloat(k[10]),
        }));
    } catch (err) {
        console.error(`[Data] fetchKlines ${symbol} ${interval} error:`, err.message);
        return [];
    }
}

export async function fetchOrderBookDepth(symbol, limit = 20) {
    try {
        const url = `${BINANCE_SPOT}/api/v3/depth?symbol=${symbol}&limit=${limit}`;
        const res = await fetch(url);
        if (!res.ok) {
            console.error(`[Data] fetchDepth ${symbol} HTTP ${res.status}`);
            return { bids: [], asks: [] };
        }
        const data = await res.json();
        return {
            bids: (data.bids || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
            asks: (data.asks || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
        };
    } catch (err) {
        console.error(`[Data] fetchDepth ${symbol} error:`, err.message);
        return { bids: [], asks: [] };
    }
}

export async function fetch24hTicker(symbol) {
    try {
        const url = `${BINANCE_SPOT}/api/v3/ticker/24hr?symbol=${symbol}`;
        const res = await fetch(url);
        if (!res.ok) return { priceChange: 0, priceChangePercent: 0, lastPrice: 0, highPrice: 0, lowPrice: 0, volume: 0 };
        const data = await res.json();
        return {
            priceChange: parseFloat(data.priceChange || 0),
            priceChangePercent: parseFloat(data.priceChangePercent || 0),
            lastPrice: parseFloat(data.lastPrice || 0),
            highPrice: parseFloat(data.highPrice || 0),
            lowPrice: parseFloat(data.lowPrice || 0),
            volume: parseFloat(data.volume || 0),
        };
    } catch (err) {
        console.error(`[Data] fetch24hTicker ${symbol} error:`, err.message);
        return { priceChange: 0, priceChangePercent: 0, lastPrice: 0, highPrice: 0, lowPrice: 0, volume: 0 };
    }
}

export async function fetchFundingRate(symbol) {
    try {
        const url = `${BINANCE_FUTURES}/fapi/v1/premiumIndex?symbol=${symbol}`;
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[Data] fetchFunding ${symbol} HTTP ${res.status} — falling back to neutral`);
            return { fundingRate: 0, predictedRate: 0 };
        }
        const data = await res.json();
        return {
            fundingRate: parseFloat(data.lastFundingRate || 0),
            predictedRate: parseFloat(data.nextFundingRate || data.lastFundingRate || 0),
        };
    } catch (err) {
        console.warn(`[Data] fetchFunding ${symbol} error (using neutral):`, err.message);
        return { fundingRate: 0, predictedRate: 0 };
    }
}

// ─── ATR Calculation ─────────────────────────────────────────────

export function computeATR(klines5m, periods = 12) {
    if (!klines5m || klines5m.length < periods + 1) return { atr: 0, atrPct: 0 };
    const trs = [];
    for (let i = klines5m.length - periods; i < klines5m.length; i++) {
        const k = klines5m[i];
        const prevClose = klines5m[i - 1].close;
        const tr = Math.max(
            k.high - k.low,
            Math.abs(k.high - prevClose),
            Math.abs(k.low - prevClose)
        );
        trs.push(tr);
    }
    const atr = trs.reduce((s, v) => s + v, 0) / trs.length;
    const currentPrice = klines5m[klines5m.length - 1].close;
    const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
    return { atr, atrPct };
}

export function getVolatilityRegime(atrPct) {
    if (atrPct < 0.15) return 'low';
    if (atrPct <= 0.45) return 'normal';
    return 'high';
}

// ─── Order Book Imbalance (Module 1A) ────────────────────────────

export function computeOrderBookImbalance(depth, midPrice, rangePct = 0.3) {
    if (!depth || !depth.bids.length || !depth.asks.length || midPrice <= 0) {
        return 0;
    }
    const rangeDecimal = rangePct / 100;
    const bidFloor = midPrice * (1 - rangeDecimal);
    const askCeil = midPrice * (1 + rangeDecimal);

    const bidVolume = depth.bids
        .filter(b => b.price >= bidFloor)
        .reduce((s, b) => s + b.qty, 0);
    const askVolume = depth.asks
        .filter(a => a.price <= askCeil)
        .reduce((s, a) => s + a.qty, 0);

    const total = bidVolume + askVolume;
    if (total === 0) return 0;
    return (bidVolume - askVolume) / total; // -1 to +1
}

// ─── Trade Flow Imbalance (Module 1B) — from kline taker volume ──

export function computeTradeFlowImbalance(klines1m, windowMinutes = 5) {
    if (!klines1m || klines1m.length < windowMinutes + 2) {
        return { tfi: 0, tfiSlope: 0 };
    }

    const calcTFI = (slice) => {
        let buyVol = 0, sellVol = 0;
        for (const k of slice) {
            buyVol += k.takerBuyVolume;
            sellVol += (k.volume - k.takerBuyVolume);
        }
        const total = buyVol + sellVol;
        return total > 0 ? (buyVol - sellVol) / total : 0;
    };

    // Current TFI: last windowMinutes candles
    const currentSlice = klines1m.slice(-windowMinutes);
    const tfi = calcTFI(currentSlice);

    // TFI from ~1 minute ago for slope calculation
    const pastSlice = klines1m.slice(-(windowMinutes + 1), -1);
    const pastTfi = calcTFI(pastSlice);
    const tfiSlope = tfi - pastTfi;

    return { tfi, tfiSlope };
}

// ─── EMA Calculation ─────────────────────────────────────────────

export function computeEMA(values, period) {
    if (!values || values.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = values[0];
    for (let i = 1; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
    }
    return ema;
}

// ─── Beta Calculation (Module 3) ─────────────────────────────────

export function computeBeta(dogeReturns, btcReturns) {
    if (!dogeReturns || !btcReturns || dogeReturns.length < 2 || dogeReturns.length !== btcReturns.length) {
        return 1.0; // default beta
    }
    const n = dogeReturns.length;
    const meanDoge = dogeReturns.reduce((s, v) => s + v, 0) / n;
    const meanBtc = btcReturns.reduce((s, v) => s + v, 0) / n;

    let covariance = 0, variance = 0;
    for (let i = 0; i < n; i++) {
        const dDoge = dogeReturns[i] - meanDoge;
        const dBtc = btcReturns[i] - meanBtc;
        covariance += dDoge * dBtc;
        variance += dBtc * dBtc;
    }
    covariance /= n;
    variance /= n;

    return variance > 0 ? covariance / variance : 1.0;
}

export function computeReturns(klines, count) {
    if (!klines || klines.length < count + 1) return [];
    const returns = [];
    const start = klines.length - count;
    for (let i = start; i < klines.length; i++) {
        const prev = klines[i - 1].close;
        const curr = klines[i].close;
        returns.push(prev > 0 ? ((curr - prev) / prev) * 100 : 0);
    }
    return returns;
}

// ─── Swing Point Detection ───────────────────────────────────────

export function detectSwingPoints(klines, lookback = 20) {
    if (!klines || klines.length < 3) return { swingHighs: [], swingLows: [] };
    const slice = klines.slice(-lookback);
    const swingHighs = [];
    const swingLows = [];

    for (let i = 1; i < slice.length - 1; i++) {
        if (slice[i].high > slice[i - 1].high && slice[i].high > slice[i + 1].high) {
            swingHighs.push({ index: i, price: slice[i].high });
        }
        if (slice[i].low < slice[i - 1].low && slice[i].low < slice[i + 1].low) {
            swingLows.push({ index: i, price: slice[i].low });
        }
    }
    return { swingHighs, swingLows };
}

// ─── BTC Price Structure Detection (Module 2B) ──────────────────

export function detectBTCStructure(klines5m, swings) {
    if (!klines5m || klines5m.length < 4) {
        return { pattern: 'ranging', direction: 'neutral', points: 0 };
    }

    const recent3 = klines5m.slice(-3);
    const current = recent3[2];
    const prev = recent3[1];
    const { swingHighs, swingLows } = swings;

    const highestSwing = swingHighs.length > 0 ? Math.max(...swingHighs.map(s => s.price)) : null;
    const lowestSwing = swingLows.length > 0 ? Math.min(...swingLows.map(s => s.price)) : null;

    // Sweep-reclaim bullish: dipped below swing low then closed back above
    if (lowestSwing !== null) {
        const sweptLow = recent3.some(k => k.low < lowestSwing);
        const reclaimedAbove = current.close > lowestSwing;
        if (sweptLow && reclaimedAbove) {
            return { pattern: 'sweep_reclaim', direction: 'long', points: 15 };
        }
    }

    // Sweep-reclaim bearish: spiked above swing high then closed back below
    if (highestSwing !== null) {
        const sweptHigh = recent3.some(k => k.high > highestSwing);
        const rejectedBelow = current.close < highestSwing;
        if (sweptHigh && rejectedBelow) {
            return { pattern: 'sweep_reclaim', direction: 'short', points: 15 };
        }
    }

    // Check last 3 candles for rejection / support patterns (with invalidation)
    for (let i = 0; i < 3; i++) {
        const candle = recent3[i];
        const range = candle.high - candle.low;
        if (range <= 0) continue;

        const bodyTop = Math.max(candle.open, candle.close);
        const bodyBot = Math.min(candle.open, candle.close);
        const upperWick = (candle.high - bodyTop) / range;
        const lowerWick = (bodyBot - candle.low) / range;
        const bodyPosition = (candle.close - candle.low) / range;

        // Rejection bearish: upper wick > 60%, close in bottom 40%, near a swing high
        if (upperWick > 0.6 && bodyPosition < 0.4) {
            // Invalidation: next candle closes above rejection candle's high
            const invalidated = recent3.slice(i + 1).some(k => k.close > candle.high);
            if (!invalidated && highestSwing !== null) {
                const nearSwingH = Math.abs(candle.high - highestSwing) / highestSwing < 0.005;
                if (nearSwingH) {
                    return { pattern: 'rejection', direction: 'short', points: 10 };
                }
            }
        }

        // Rejection bullish: lower wick > 60%, close in top 40%, near a swing low
        if (lowerWick > 0.6 && bodyPosition > 0.6) {
            const invalidated = recent3.slice(i + 1).some(k => k.close < candle.low);
            if (!invalidated && lowestSwing !== null) {
                const nearSwingL = Math.abs(candle.low - lowestSwing) / lowestSwing < 0.005;
                if (nearSwingL) {
                    return { pattern: 'rejection', direction: 'long', points: 10 };
                }
            }
        }
    }

    // Breakout: close above highest swing high with volume > 1.5× avg
    if (highestSwing !== null && klines5m.length >= 20) {
        const avg20Vol = klines5m.slice(-20).reduce((s, k) => s + k.volume, 0) / 20;
        if (current.close > highestSwing && current.volume > avg20Vol * 1.5) {
            return { pattern: 'breakout', direction: 'long', points: 8 };
        }
    }

    // Breakdown: close below lowest swing low with volume > 1.5× avg
    if (lowestSwing !== null && klines5m.length >= 20) {
        const avg20Vol = klines5m.slice(-20).reduce((s, k) => s + k.volume, 0) / 20;
        if (current.close < lowestSwing && current.volume > avg20Vol * 1.5) {
            return { pattern: 'breakdown', direction: 'short', points: 8 };
        }
    }

    return { pattern: 'ranging', direction: 'neutral', points: 0 };
}

// ─── Percent Change Helper ───────────────────────────────────────

export function percentChange(klines, periods) {
    if (!klines || klines.length < periods + 1) return 0;
    const current = klines[klines.length - 1].close;
    const past = klines[klines.length - 1 - periods]?.close;
    if (!past || past === 0) return 0;
    return ((current - past) / past) * 100;
}

// ─── Volume Ratio (10-min avg vs 1-hour avg from 1m klines) ─────

export function computeVolumeRatio(klines1m) {
    if (!klines1m || klines1m.length < 60) return 1.0;
    const recent10 = klines1m.slice(-10);
    const full60 = klines1m.slice(-60);
    const avgRecent = recent10.reduce((s, k) => s + k.volume, 0) / 10;
    const avgFull = full60.reduce((s, k) => s + k.volume, 0) / 60;
    return avgFull > 0 ? avgRecent / avgFull : 1.0;
}

// ─── Sector Bias ─────────────────────────────────────────────────

export function computeSectorBias(ethChange, solChange) {
    if (ethChange > 1 && solChange > 1) return 'bullish';
    if (ethChange < -1 && solChange < -1) return 'bearish';
    return 'mixed';
}
