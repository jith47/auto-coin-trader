/**
 * OI Flow Rider — Data Layer
 * Fetches institutional flow data from Binance Futures & Spot APIs
 */
const BINANCE_SPOT = 'https://data-api.binance.vision';
const BINANCE_FUTURES = 'https://fapi.binance.com';

// ─── Main Data Fetch ─────────────────────────────────────────────

/**
 * Fetch all market data needed for the OI Flow Rider strategy.
 * Returns institutional flow signals + price data.
 */
export async function fetchAllMarketData() {
    const symbol = 'DOGEUSDT';
    const [
        openInterest,
        globalLSRatio,
        topTraderLSRatio,
        takerBuySellRatio,
        fundingData,
        klines5m,
        klines1m,
        ticker24h,
    ] = await Promise.all([
        fetchOpenInterest(symbol),
        fetchGlobalLongShortRatio(symbol),
        fetchTopTraderLongShortRatio(symbol),
        fetchTakerBuySellRatio(symbol),
        fetchFundingRate(symbol),
        fetchKlines(symbol, '5m', 30),
        fetchKlines(symbol, '1m', 10),
        fetch24hTicker(symbol),
    ]);

    return {
        openInterest,
        globalLSRatio,
        topTraderLSRatio,
        takerBuySellRatio,
        funding: fundingData,
        klines5m,
        klines1m,
        ticker24h,
    };
}

// ─── Institutional Flow Endpoints ────────────────────────────────

/**
 * Fetch current Open Interest for a symbol.
 * This is the core signal — shows total outstanding contracts.
 */
export async function fetchOpenInterest(symbol) {
    try {
        const url = `${BINANCE_FUTURES}/fapi/v1/openInterest?symbol=${symbol}`;
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[Data] fetchOI ${symbol} HTTP ${res.status}`);
            return null;
        }
        const data = await res.json();
        return {
            openInterest: parseFloat(data.openInterest || 0),
            time: data.time,
        };
    } catch (err) {
        console.error(`[Data] fetchOI error:`, err.message);
        return null;
    }
}

/**
 * Fetch global long/short account ratio (retail sentiment).
 * High longAccount = retail is long = potential short opportunity.
 * Returns last 2 data points (each 5-min bucket).
 */
export async function fetchGlobalLongShortRatio(symbol) {
    try {
        const url = `${BINANCE_FUTURES}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=2`;
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[Data] fetchGlobalLS ${symbol} HTTP ${res.status}`);
            return null;
        }
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return null;
        const latest = data[data.length - 1];
        const prev = data.length > 1 ? data[0] : null;
        return {
            longAccount: parseFloat(latest.longAccount),
            shortAccount: parseFloat(latest.shortAccount),
            longShortRatio: parseFloat(latest.longShortRatio),
            // Delta: how much the ratio changed in the last 5 min
            delta: prev ? parseFloat(latest.longAccount) - parseFloat(prev.longAccount) : 0,
            timestamp: latest.timestamp,
        };
    } catch (err) {
        console.error(`[Data] fetchGlobalLS error:`, err.message);
        return null;
    }
}

/**
 * Fetch top trader long/short ratio (smart money / whale positioning).
 * This is the most reliable directional signal.
 * Returns last 2 data points for delta calculation.
 */
export async function fetchTopTraderLongShortRatio(symbol) {
    try {
        const url = `${BINANCE_FUTURES}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=5m&limit=2`;
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[Data] fetchTopTraderLS ${symbol} HTTP ${res.status}`);
            return null;
        }
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return null;
        const latest = data[data.length - 1];
        const prev = data.length > 1 ? data[0] : null;
        return {
            longAccount: parseFloat(latest.longAccount),
            shortAccount: parseFloat(latest.shortAccount),
            longShortRatio: parseFloat(latest.longShortRatio),
            delta: prev ? parseFloat(latest.longAccount) - parseFloat(prev.longAccount) : 0,
            timestamp: latest.timestamp,
        };
    } catch (err) {
        console.error(`[Data] fetchTopTraderLS error:`, err.message);
        return null;
    }
}

/**
 * Fetch taker buy/sell volume ratio (aggressive order flow).
 * buySellRatio > 1 = more aggressive buying, < 1 = more aggressive selling.
 * This is the hardest signal to fake — shows actual executed trades.
 */
export async function fetchTakerBuySellRatio(symbol) {
    try {
        const url = `${BINANCE_FUTURES}/futures/data/takerlongshortRatio?symbol=${symbol}&period=5m&limit=2`;
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[Data] fetchTakerRatio ${symbol} HTTP ${res.status}`);
            return null;
        }
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return null;
        const latest = data[data.length - 1];
        const prev = data.length > 1 ? data[0] : null;
        return {
            buySellRatio: parseFloat(latest.buySellRatio),
            buyVol: parseFloat(latest.buyVol),
            sellVol: parseFloat(latest.sellVol),
            delta: prev ? parseFloat(latest.buySellRatio) - parseFloat(prev.buySellRatio) : 0,
            timestamp: latest.timestamp,
        };
    } catch (err) {
        console.error(`[Data] fetchTakerRatio error:`, err.message);
        return null;
    }
}

/**
 * Fetch funding rate — kept from previous strategy.
 * Extreme funding = crowded trade = contrarian signal.
 */
export async function fetchFundingRate(symbol) {
    try {
        const url = `${BINANCE_FUTURES}/fapi/v1/premiumIndex?symbol=${symbol}`;
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[Data] fetchFunding ${symbol} HTTP ${res.status} — fallback to neutral`);
            return { fundingRate: 0 };
        }
        const data = await res.json();
        return {
            fundingRate: parseFloat(data.lastFundingRate || 0),
        };
    } catch (err) {
        console.warn(`[Data] fetchFunding error (using neutral):`, err.message);
        return { fundingRate: 0 };
    }
}

// ─── Price Data ──────────────────────────────────────────────────

/**
 * Fetch kline (candlestick) data from Binance Spot.
 */
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

/**
 * Fetch 24h ticker stats for kill switch checks.
 */
export async function fetch24hTicker(symbol) {
    try {
        const url = `${BINANCE_SPOT}/api/v3/ticker/24hr?symbol=${symbol}`;
        const res = await fetch(url);
        if (!res.ok) return { lastPrice: 0, highPrice: 0, lowPrice: 0, priceChangePercent: 0, volume: 0 };
        const data = await res.json();
        return {
            lastPrice: parseFloat(data.lastPrice || 0),
            highPrice: parseFloat(data.highPrice || 0),
            lowPrice: parseFloat(data.lowPrice || 0),
            priceChangePercent: parseFloat(data.priceChangePercent || 0),
            volume: parseFloat(data.volume || 0),
        };
    } catch (err) {
        console.error(`[Data] fetch24hTicker error:`, err.message);
        return { lastPrice: 0, highPrice: 0, lowPrice: 0, priceChangePercent: 0, volume: 0 };
    }
}

// ─── Technical Helpers ───────────────────────────────────────────

/**
 * Compute ATR (Average True Range) from 5-minute klines.
 * Used for position sizing — SL/TP distances scale with volatility.
 */
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

/**
 * Compute price change over the last N 1-minute candles.
 * Used for price momentum confirmation.
 */
export function priceChange(klines, periods) {
    if (!klines || klines.length < periods + 1) return 0;
    const current = klines[klines.length - 1].close;
    const past = klines[klines.length - 1 - periods]?.close;
    if (!past || past === 0) return 0;
    return ((current - past) / past) * 100;
}

/**
 * Compute average volume over the last N candles.
 */
export function avgVolume(klines, periods) {
    if (!klines || klines.length < periods) return 0;
    const slice = klines.slice(-periods);
    return slice.reduce((sum, k) => sum + k.volume, 0) / periods;
}
