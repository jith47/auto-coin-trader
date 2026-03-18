/**
 * OI Flow Rider v2.0 — Data Layer
 * Multi-asset (BTC + ETH) institutional flow data from Binance Futures & Spot APIs
 */
const SPOT_ENDPOINTS = [
    'https://api-gcp.binance.com',
    'https://api.binance.com'
];

const FUTURES_ENDPOINTS = [
    'https://fapi.binance.com',
    'https://api-gcp.binance.com' // Fallback for 451 geoblocks
];

/**
 * Robust fetch with automatic fallback to multiple endpoints on 451/5xx errors.
 */
async function fetchWithFallback(endpoints, path, options = {}) {
    let lastError = null;
    for (const base of endpoints) {
        try {
            const url = `${base}${path}`;
            const res = await fetch(url, options);
            if (res.ok) return res;

            const body = await res.text();
            lastError = `HTTP ${res.status}: ${body}`;

            if (res.status === 451 || res.status >= 500) {
                console.warn(`[Data] Fallback triggered for ${path} from ${base} (${res.status})`);
                continue;
            }
            return res;
        } catch (err) {
            lastError = `EXCEPTION: ${err.message}`;
            if (err.message.includes('Too many subrequests')) {
                throw new Error(`CRITICAL: Subrequest limit hit. ${lastError}`);
            }
            continue;
        }
    }
    throw new Error(`All endpoints failed for ${path}. Last error: ${lastError}`);
}

// Assets to track — BTC primary, ETH secondary
export const ASSETS = ['BTCUSDT', 'ETHUSDT'];

// ─── Main Data Fetch ─────────────────────────────────────────────

/**
 * Fetch all data for a single asset. Called per-asset each tick.
 */
export async function fetchAssetData(symbol) {
    // Batch 1: Spot API calls (data-api.binance.vision) — max 4 concurrent
    const [klines5m, klines1m, klines5m_older, ticker24h] = await Promise.all([
        fetchKlines(symbol, '5m', 30),
        fetchKlines(symbol, '1m', 20),
        fetchKlines(symbol, '5m', 60),
        fetch24hTicker(symbol),
    ]);

    // Batch 2: Futures API calls (www.binance.com) — max 5 concurrent
    // Kept separate from spot to stay under CF Worker's 6 concurrent fetch limit
    const [openInterest, globalLSRatio, topTraderLSRatio, takerBuySellRatio, fundingData] = await Promise.all([
        fetchOpenInterest(symbol),
        fetchGlobalLongShortRatio(symbol),
        fetchTopTraderLongShortRatio(symbol),
        fetchTakerBuySellRatio(symbol),
        fetchFundingRate(symbol),
    ]);

    return {
        symbol, openInterest, globalLSRatio, topTraderLSRatio,
        takerBuySellRatio, funding: fundingData,
        klines5m, klines1m, klines5m_older, ticker24h,
    };
}

/**
 * Fetch data for all tracked assets in parallel.
 */
export async function fetchAllAssetsData() {
    // Sequential per-asset to stay under CF Worker's 6 concurrent fetch limit
    const map = {};
    for (const s of ASSETS) {
        map[s] = await fetchAssetData(s);
    }
    return map;
}

// ─── Institutional Flow Endpoints ────────────────────────────────

export async function fetchOpenInterest(symbol) {
    try {
        const res = await fetchWithFallback(FUTURES_ENDPOINTS, `/fapi/v1/openInterest?symbol=${symbol}`);
        const data = await res.json();
        const oi = parseFloat(data.openInterest || 0);
        console.log(`[Data] OI ${symbol}: ${oi}`);
        return { openInterest: oi, time: Date.now() };
    } catch (err) {
        console.error(`[Data] fetchOI ${symbol} EXCEPTION:`, err.message);
        return { openInterest: 0, time: Date.now() };
    }
}

export async function fetchGlobalLongShortRatio(symbol) {
    try {
        const res = await fetchWithFallback(FUTURES_ENDPOINTS, `/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=3`);
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return null;
        const latest = data[data.length - 1];
        const prev = data.length > 1 ? data[data.length - 2] : null;
        return {
            longAccount: parseFloat(latest.longAccount),
            shortAccount: parseFloat(latest.shortAccount),
            longShortRatio: parseFloat(latest.longShortRatio),
            delta: prev ? parseFloat(latest.longAccount) - parseFloat(prev.longAccount) : 0,
            timestamp: latest.timestamp,
        };
    } catch (err) {
        console.error(`[Data] fetchGlobalLS ${symbol} error:`, err.message);
        return null;
    }
}

export async function fetchTopTraderLongShortRatio(symbol) {
    try {
        const res = await fetchWithFallback(FUTURES_ENDPOINTS, `/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=5m&limit=3`);
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return null;
        const latest = data[data.length - 1];
        const prev = data.length > 1 ? data[data.length - 2] : null;
        return {
            longAccount: parseFloat(latest.longAccount),
            shortAccount: parseFloat(latest.shortAccount),
            longShortRatio: parseFloat(latest.longShortRatio),
            delta: prev ? parseFloat(latest.longAccount) - parseFloat(prev.longAccount) : 0,
            timestamp: latest.timestamp,
        };
    } catch (err) {
        console.error(`[Data] fetchTopTraderLS ${symbol} error:`, err.message);
        return null;
    }
}

export async function fetchTakerBuySellRatio(symbol) {
    try {
        const res = await fetchWithFallback(FUTURES_ENDPOINTS, `/futures/data/takerlongshortRatio?symbol=${symbol}&period=5m&limit=3`);
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return null;
        const latest = data[data.length - 1];
        const prev = data.length > 1 ? data[data.length - 2] : null;
        return {
            buySellRatio: parseFloat(latest.buySellRatio),
            buyVol: parseFloat(latest.buyVol),
            sellVol: parseFloat(latest.sellVol),
            delta: prev ? parseFloat(latest.buySellRatio) - parseFloat(prev.buySellRatio) : 0,
            timestamp: latest.timestamp,
        };
    } catch (err) {
        console.error(`[Data] fetchTakerRatio ${symbol} error:`, err.message);
        return null;
    }
}

export async function fetchFundingRate(symbol) {
    try {
        const res = await fetchWithFallback(FUTURES_ENDPOINTS, `/fapi/v1/premiumIndex?symbol=${symbol}`);
        const data = await res.json();
        return { fundingRate: parseFloat(data.lastFundingRate || 0) };
    } catch (err) {
        console.warn(`[Data] fetchFunding ${symbol} error:`, err.message);
        return { fundingRate: 0 };
    }
}

// ─── Price Data ──────────────────────────────────────────────────

export async function fetchKlines(symbol, interval, limit) {
    try {
        const res = await fetchWithFallback(SPOT_ENDPOINTS, `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
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

export async function fetch24hTicker(symbol) {
    try {
        const res = await fetchWithFallback(SPOT_ENDPOINTS, `/api/v3/ticker/24hr?symbol=${symbol}`);
        const data = await res.json();
        return {
            lastPrice: parseFloat(data.lastPrice || 0),
            highPrice: parseFloat(data.highPrice || 0),
            lowPrice: parseFloat(data.lowPrice || 0),
            priceChangePercent: parseFloat(data.priceChangePercent || 0),
            volume: parseFloat(data.volume || 0),
        };
    } catch (err) {
        return { lastPrice: null, highPrice: null, lowPrice: null, priceChangePercent: 0, volume: 0 };
    }
}

// ─── Technical Helpers ───────────────────────────────────────────

/**
 * ATR from 5-minute klines.
 */
export function computeATR(klines5m, periods = 12) {
    if (!klines5m || klines5m.length < periods + 1) return { atr: 0, atrPct: 0 };
    const trs = [];
    for (let i = klines5m.length - periods; i < klines5m.length; i++) {
        const k = klines5m[i];
        const prevClose = klines5m[i - 1].close;
        trs.push(Math.max(k.high - k.low, Math.abs(k.high - prevClose), Math.abs(k.low - prevClose)));
    }
    const atr = trs.reduce((s, v) => s + v, 0) / trs.length;
    const currentPrice = klines5m[klines5m.length - 1].close;
    return { atr, atrPct: currentPrice > 0 ? (atr / currentPrice) * 100 : 0 };
}

/**
 * ATR at an earlier offset — for price compression comparison.
 * Computes ATR using klines ending at `offsetFromEnd` candles back.
 */
export function computeATRAtOffset(klines5m, offsetFromEnd, periods = 12) {
    const endIdx = klines5m.length - offsetFromEnd;
    if (endIdx < periods + 1) return { atr: 0, atrPct: 0 };
    const slice = klines5m.slice(0, endIdx);
    return computeATR(slice, periods);
}

/**
 * Linear regression slope of close prices over N candles.
 * Returns slope as percentage change per candle.
 */
export function linearRegressionSlope(klines, periods) {
    if (!klines || klines.length < periods) return 0;
    const slice = klines.slice(-periods);
    const n = slice.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += slice[i].close;
        sumXY += i * slice[i].close;
        sumXX += i * i;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const avgPrice = sumY / n;
    return avgPrice > 0 ? (slope / avgPrice) * 100 : 0; // % per candle
}

/**
 * Sum volume over last N 1-minute candles.
 */
export function sumVolume(klines1m, periods) {
    if (!klines1m || klines1m.length < periods) return 0;
    return klines1m.slice(-periods).reduce((s, k) => s + k.quoteVolume, 0);
}

/**
 * Price change over last N candles (percentage).
 */
export function priceChange(klines, periods) {
    if (!klines || klines.length < periods + 1) return 0;
    const current = klines[klines.length - 1].close;
    const past = klines[klines.length - 1 - periods]?.close;
    if (!past || past === 0) return 0;
    return ((current - past) / past) * 100;
}
