/**
 * Binance data fetcher + technical indicator computation.
 * Uses Binance public data API (data-api.binance.vision) — NOT geo-blocked from CF Workers.
 *
 * Indicators: EMA, RSI (Wilder), ATR, Volume SMA
 */

const BINANCE_BASE = 'https://data-api.binance.vision';

// ─────────────────────────────────────────────────────────────────────────────
// Data Fetching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch klines from Binance.
 * @param {string} symbol - e.g. 'BTCUSDT'
 * @param {string} interval - e.g. '5m', '1m', '15m'
 * @param {number} limit - number of candles (max 1000)
 * @returns {Array<{openTime, open, high, low, close, volume, closeTime}>}
 */
export async function fetchKlines(symbol, interval, limit = 250) {
    try {
        const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const res = await fetch(url);
        if (!res.ok) {
            console.error(`[Binance] fetchKlines ${symbol} ${interval} HTTP ${res.status}: ${await res.text()}`);
            return [];
        }
        const data = await res.json();
        if (!Array.isArray(data)) {
            console.error(`[Binance] fetchKlines unexpected response:`, JSON.stringify(data).slice(0, 200));
            return [];
        }
        return data.map(k => ({
            openTime: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            closeTime: k[6],
        }));
    } catch (err) {
        console.error(`[Binance] fetchKlines error:`, err.message);
        return [];
    }
}

/**
 * Fetch all market data needed for the strategy.
 * Returns raw klines for indicator computation.
 */
export async function fetchMarketData(symbol, interval, limit = 250) {
    const klines = await fetchKlines(symbol, interval, limit);
    return { klines };
}

// ─────────────────────────────────────────────────────────────────────────────
// Indicator Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute Exponential Moving Average (EMA).
 * Returns the full EMA series for the given close prices.
 * @param {number[]} closes - array of close prices
 * @param {number} period - EMA period
 * @returns {number[]} EMA values (same length as closes, first `period-1` are NaN)
 */
export function computeEMA(closes, period) {
    if (closes.length < period) return closes.map(() => NaN);
    const k = 2 / (period + 1);
    const ema = new Array(closes.length).fill(NaN);

    // Seed: SMA of first `period` values
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    ema[period - 1] = sum / period;

    // EMA from there onward
    for (let i = period; i < closes.length; i++) {
        ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
    }
    return ema;
}

/**
 * Compute RSI (Wilder's smoothed method).
 * @param {number[]} closes - array of close prices
 * @param {number} period - RSI period (default 14)
 * @returns {number[]} RSI values (same length, first `period` are NaN)
 */
export function computeRSI(closes, period = 14) {
    if (closes.length < period + 1) return closes.map(() => NaN);
    const rsi = new Array(closes.length).fill(NaN);

    // Calculate initial gains/losses
    let gainSum = 0, lossSum = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gainSum += diff;
        else lossSum += Math.abs(diff);
    }

    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;
    rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

    // Wilder smoothing for subsequent values
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? Math.abs(diff) : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }
    return rsi;
}

/**
 * Compute ATR (Average True Range).
 * @param {Array<{high, low, close}>} klines - candle data
 * @param {number} period - ATR period (default 14)
 * @returns {number[]} ATR values (same length, first `period` are NaN)
 */
export function computeATR(klines, period = 14) {
    if (klines.length < period + 1) return klines.map(() => NaN);
    const atr = new Array(klines.length).fill(NaN);

    // True Range for each bar (starting from index 1)
    const tr = [0]; // TR[0] is not defined (no previous close)
    for (let i = 1; i < klines.length; i++) {
        const high = klines[i].high;
        const low = klines[i].low;
        const prevClose = klines[i - 1].close;
        tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }

    // Initial ATR: SMA of first `period` true ranges (starting at index 1)
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += tr[i];
    atr[period] = sum / period;

    // Wilder smoothing
    for (let i = period + 1; i < klines.length; i++) {
        atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }
    return atr;
}

/**
 * Compute Simple Moving Average (SMA) of volume.
 * @param {number[]} volumes - array of volume values
 * @param {number} period - SMA period
 * @returns {number[]} SMA values (same length, first `period-1` are NaN)
 */
export function computeVolumeSMA(volumes, period) {
    if (volumes.length < period) return volumes.map(() => NaN);
    const sma = new Array(volumes.length).fill(NaN);

    let sum = 0;
    for (let i = 0; i < period; i++) sum += volumes[i];
    sma[period - 1] = sum / period;

    for (let i = period; i < volumes.length; i++) {
        sum += volumes[i] - volumes[i - period];
        sma[i] = sum / period;
    }
    return sma;
}

/**
 * Compute all indicators needed by the strategy.
 * Returns the latest values for entry/exit decisions.
 *
 * @param {Array} klines - candle array from fetchKlines
 * @param {Object} config - strategy config with EMA/RSI/ATR parameters
 * @returns {Object} indicators object
 */
export function computeAllIndicators(klines, config) {
    if (!klines || klines.length < config.TREND_EMA + 5) {
        console.error(`[Indicators] Not enough klines: ${klines?.length || 0} (need ${config.TREND_EMA + 5}+)`);
        return null;
    }

    const closes = klines.map(k => k.close);
    const volumes = klines.map(k => k.volume);
    const len = klines.length;
    const i = len - 1;      // latest (current) bar
    const iPrev = len - 2;  // previous bar

    // EMAs
    const fastEmaArr = computeEMA(closes, config.FAST_EMA);
    const slowEmaArr = computeEMA(closes, config.SLOW_EMA);
    const trendEmaArr = computeEMA(closes, config.TREND_EMA);

    // RSI
    const rsiArr = computeRSI(closes, config.RSI_LEN);

    // ATR
    const atrArr = computeATR(klines, config.ATR_LEN);

    // Volume SMA
    const volSmaArr = computeVolumeSMA(volumes, config.VOL_LEN);

    // Latest candle values
    const candle = klines[i];
    const prevCandle = klines[iPrev];

    return {
        // Current candle
        candle,
        prevCandle,
        price: candle.close,
        high: candle.high,
        low: candle.low,
        volume: candle.volume,

        // EMAs (current bar)
        fastEma: fastEmaArr[i],
        slowEma: slowEmaArr[i],
        trendEma: trendEmaArr[i],

        // RSI (current + previous for crossover detection)
        rsi: rsiArr[i],
        rsiPrev: rsiArr[iPrev],

        // ATR
        atr: atrArr[i],

        // Volume MA
        volumeMA: volSmaArr[i],

        // Trend states (derived)
        trendUp: fastEmaArr[i] > slowEmaArr[i],
        trendDown: fastEmaArr[i] < slowEmaArr[i],

        // Trend 200 filter
        above200: candle.close > trendEmaArr[i],
        below200: candle.close < trendEmaArr[i],

        // Pullback detection
        pullbackLong: candle.low <= fastEmaArr[i] && candle.close > fastEmaArr[i],
        pullbackShort: candle.high >= fastEmaArr[i] && candle.close < fastEmaArr[i],

        // RSI crossovers
        rsiLongCross: rsiArr[iPrev] <= config.RSI_LONG && rsiArr[i] > config.RSI_LONG,
        rsiShortCross: rsiArr[iPrev] >= config.RSI_SHORT && rsiArr[i] < config.RSI_SHORT,

        // Volume confirmation
        volumeOK: candle.volume > volSmaArr[i] * config.VOL_MULT,

        // Symbol info
        symbol: config.SYMBOL,
        interval: config.INTERVAL,
    };
}
