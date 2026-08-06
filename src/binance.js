/**
 * Market data source: CoinDCX futures first, Binance futures only as a fallback.
 * Real trades execute on CoinDCX futures, and Binance endpoints can be blocked
 * from Cloudflare Workers, so production should prefer CoinDCX futures values.
 */
const SYMBOLS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
const CVD_STEEP_THRESHOLD = 0.5;
const CVD_GRADUAL_THRESHOLD = 0.15;
const SWEEP_LOOKBACK_1M = 60;
const SWEEP_LOOKBACK_5M = 20;
const SWEEP_MIN_DEPTH = 0.15;
const CVD_WINDOW = 30;

/**
 * Robust fetch helper to query multiple Binance API mirrors in case of transient 500s/rate limits.
 */
async function fetchBinanceWithFallback(path) {
    const bases = [
        'https://fapi.binance.com'
    ];
    let lastStatus = 0;
    let lastText = "";
    for (const base of bases) {
        const url = base + path;
        try {
            const res = await fetch(url);
            if (res.ok) {
                return { ok: true, data: await res.json() };
            } else {
                lastStatus = res.status;
                lastText = await res.text();
                console.warn(`[Binance] ${path} failed on ${base}: HTTP ${lastStatus} - ${lastText.slice(0, 100)}`);
            }
        } catch (err) {
            console.warn(`[Binance] ${path} fetch error on ${base}: ${err.message}`);
        }
    }
    return { ok: false, status: lastStatus, text: lastText };
}

/**
 * Estimate liquidation events from BTC price action.
 * A sharp wick below recent swing lows (with recovery) signals longs were flushed.
 * A sharp wick above recent swing highs (with rejection) signals shorts were squeezed.
 */
export function estimateLiquidationEvents(btcKlines) {
    if (!btcKlines || btcKlines.length < SWEEP_LOOKBACK_1M + 5) {
        return { recentEvent: 'none', longLiqCount: 0, shortLiqCount: 0 };
    }
    const lookback = btcKlines.slice(-(SWEEP_LOOKBACK_1M + 5), -5);
    const recent = btcKlines.slice(-5);
    const swingLow = Math.min(...lookback.map(k => k.low));
    const swingHigh = Math.max(...lookback.map(k => k.high));

    // Check recent candles for wicks below swing low (longs flushed)
    const wickedBelow = recent.some(k => k.low < swingLow);
    const recoveredAbove = recent[recent.length - 1].close > swingLow;
    if (wickedBelow && recoveredAbove) {
        return { recentEvent: 'longs_flushed', longLiqCount: 1, shortLiqCount: 0 };
    }

    // Check recent candles for wicks above swing high (shorts squeezed)
    const wickedAbove = recent.some(k => k.high > swingHigh);
    const rejectedBelow = recent[recent.length - 1].close < swingHigh;
    if (wickedAbove && rejectedBelow) {
        return { recentEvent: 'shorts_squeezed', longLiqCount: 0, shortLiqCount: 1 };
    }

    return { recentEvent: 'none', longLiqCount: 0, shortLiqCount: 0 };
}

export async function fetchAllMarketData() {
    const { BTC, ETH, SOL } = SYMBOLS;
    const [
        btcKlines1m, btcKlines5m, btc24h,
        ethKlines1m, eth24h,
        sol24h
    ] = await Promise.all([
        fetchKlines(BTC, '1m', 70),
        fetchKlines(BTC, '5m', 30),
        fetch24hTicker(BTC),
        fetchKlines(ETH, '1m', 70),
        fetch24hTicker(ETH),
        fetch24hTicker(SOL),
    ]);
    const liquidations = estimateLiquidationEvents(btcKlines1m);
    return {
        btc: { klines1m: btcKlines1m, klines5m: btcKlines5m, ticker24h: btc24h },
        eth: { klines1m: ethKlines1m, ticker24h: eth24h, liquidations },
        sol: { ticker24h: sol24h },
    };
}

async function fetchKlinesFromCoinDCX(symbol, interval, limit) {
    console.log(`[CoinDCX] Fetching klines for ${symbol} from CoinDCX...`);
    try {
        const coindcxPair = symbol === 'BTCUSDT' ? 'B-BTC_USDT' : symbol === 'ETHUSDT' ? 'B-ETH_USDT' : 'B-SOL_USDT';
        const resolution = interval === '5m' ? '5' : '1';
        const intervalSeconds = interval === '5m' ? 300 : 60;
        const to = Math.floor(Date.now() / 1000);
        const from = to - (limit + 10) * intervalSeconds;
        const url = `https://public.coindcx.com/market_data/candlesticks?pair=${coindcxPair}&from=${from}&to=${to}&resolution=${resolution}&pcode=f`;
        const res = await fetch(url);
        if (!res.ok) {
            console.error(`[CoinDCX] CoinDCX klines fetch failed for ${symbol}: HTTP ${res.status}`);
            return [];
        }
        const json = await res.json();
        if (json.s !== 'ok' || !Array.isArray(json.data)) {
            console.error(`[CoinDCX] CoinDCX klines returned unexpected format:`, JSON.stringify(json).slice(0, 200));
            return [];
        }
        const sorted = [...json.data].sort((a, b) => a.time - b.time);
        
        return sorted.slice(-limit).map(k => {
            const open = parseFloat(k.open);
            const high = parseFloat(k.high);
            const low = parseFloat(k.low);
            const close = parseFloat(k.close);
            const volume = parseFloat(k.volume);
            const relativeClose = high === low ? 0.5 : (close - low) / (high - low);
            const takerBuyVolume = volume * relativeClose;
            return {
                openTime: k.time,
                open,
                high,
                low,
                close,
                volume,
                closeTime: k.time + intervalSeconds * 1000 - 1,
                quoteVolume: volume * close,
                trades: 0,
                takerBuyVolume,
                takerBuyQuoteVolume: takerBuyVolume * close,
            };
        });
    } catch (err) {
        console.error(`[CoinDCX] CoinDCX klines error for ${symbol}:`, err.message);
        return [];
    }
}

async function fetch24hTickerFromCoinDCX(symbol) {
    console.log(`[CoinDCX] Fetching 24h futures ticker for ${symbol} from CoinDCX...`);
    try {
        const coindcxPair = symbol === 'BTCUSDT' ? 'B-BTC_USDT' : symbol === 'ETHUSDT' ? 'B-ETH_USDT' : 'B-SOL_USDT';
        const to = Math.floor(Date.now() / 1000);
        const from = to - (24 * 60 * 60);
        const url = `https://public.coindcx.com/market_data/candlesticks?pair=${coindcxPair}&from=${from}&to=${to}&resolution=60&pcode=f`;
        const res = await fetch(url);
        if (!res.ok) {
            console.error(`[CoinDCX] CoinDCX futures ticker fetch failed: HTTP ${res.status}`);
            return null;
        }
        const json = await res.json();
        if (json.s !== 'ok' || !Array.isArray(json.data) || json.data.length === 0) {
            console.error(`[CoinDCX] CoinDCX futures ticker returned unexpected format:`, JSON.stringify(json).slice(0, 200));
            return null;
        }

        const candles = [...json.data]
            .sort((a, b) => a.time - b.time)
            .map(k => ({
                open: parseFloat(k.open),
                high: parseFloat(k.high),
                low: parseFloat(k.low),
                close: parseFloat(k.close),
                volume: parseFloat(k.volume || 0),
            }));
        const first = candles[0];
        const last = candles[candles.length - 1];
        const highPrice = Math.max(...candles.map(k => k.high));
        const lowPrice = Math.min(...candles.map(k => k.low));
        const volume = candles.reduce((sum, k) => sum + k.volume, 0);
        const priceChange = last.close - first.open;
        const priceChangePercent = first.open > 0 ? (priceChange / first.open) * 100 : 0;

        return {
            priceChange,
            priceChangePercent,
            lastPrice: last.close,
            highPrice,
            lowPrice,
            volume,
        };
    } catch (err) {
        console.error(`[CoinDCX] CoinDCX futures ticker error for ${symbol}:`, err.message);
        return null;
    }
}

export async function fetchKlines(symbol, interval, limit) {
    const coindcxData = await fetchKlinesFromCoinDCX(symbol, interval, limit);
    if (Array.isArray(coindcxData) && coindcxData.length > 0) {
        return coindcxData;
    }

    console.warn(`[Data] CoinDCX fetchKlines ${symbol} ${interval} returned no data. Trying Binance futures fallback...`);
    const path = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetchBinanceWithFallback(path);
    if (!res.ok) {
        console.warn(`[Data] fetchKlines ${symbol} ${interval} failed on all endpoints.`);
        return [];
    }

    const data = res.data;
    if (!Array.isArray(data)) {
        console.error(`[Data] fetchKlines ${symbol} unexpected:`, JSON.stringify(data).slice(0, 200));
        return [];
    }
    return data.map(k => ({
        openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
        closeTime: k[6], quoteVolume: parseFloat(k[7]), trades: k[8],
        takerBuyVolume: parseFloat(k[9]), takerBuyQuoteVolume: parseFloat(k[10]),
    }));
}

export async function fetch24hTicker(symbol) {
    const coindcxTicker = await fetch24hTickerFromCoinDCX(symbol);
    if (coindcxTicker) {
        return coindcxTicker;
    }

    console.warn(`[Data] CoinDCX fetch24hTicker ${symbol} returned no data. Trying Binance futures fallback...`);
    const path = `/fapi/v1/ticker/24hr?symbol=${symbol}`;
    const res = await fetchBinanceWithFallback(path);
    if (!res.ok) {
        console.warn(`[Data] fetch24hTicker ${symbol} failed on all endpoints.`);
        return { priceChange: 0, priceChangePercent: 0, lastPrice: 0, highPrice: 0, lowPrice: 0, volume: 0 };
    }

    const data = res.data;
    return {
        priceChange: parseFloat(data.priceChange || 0),
        priceChangePercent: parseFloat(data.priceChangePercent || 0),
        lastPrice: parseFloat(data.lastPrice || 0),
        highPrice: parseFloat(data.highPrice || 0),
        lowPrice: parseFloat(data.lowPrice || 0),
        volume: parseFloat(data.volume || 0),
        bidPrice: parseFloat(data.bidPrice || data.lastPrice || 0),
        askPrice: parseFloat(data.askPrice || data.lastPrice || 0),
    };
}

// --- Indicator computation (unchanged) ---

export function computeIndicators(data, config = {}) {
    const btcK = data.btc.klines1m;
    const btcK5m = data.btc.klines5m || [];
    const ethK = data.eth.klines1m;
    const btcPrice = btcK.length > 0 ? btcK[btcK.length - 1].close : 0;
    const ethPrice = ethK.length > 0 ? ethK[ethK.length - 1].close : 0;
    const btcChange1h = percentChange(btcK, 60);
    const ethChange1h = percentChange(ethK, 60);
    const btcChange5m = percentChange(btcK, 5);
    const ethChange5m = percentChange(ethK, 5);
    const btc24h = data.btc.ticker24h || {};
    const eth24h = data.eth.ticker24h || {};
    const btcDistHigh = btc24h.highPrice > 0 ? ((btc24h.highPrice - btcPrice) / btcPrice) * 100 : 0;
    const btcDistLow = btc24h.lowPrice > 0 ? ((btcPrice - btc24h.lowPrice) / btcPrice) * 100 : 0;
    const ethDistHigh = eth24h.highPrice > 0
        ? ((eth24h.highPrice - ethPrice) / ethPrice) * 100 : 0;
    const ethDistLow = eth24h.lowPrice > 0 ? ((ethPrice - eth24h.lowPrice) / ethPrice) * 100 : 0;
    const btcCvd = computeCVD(btcK);
    const ethCvd = computeCVD(ethK);
    // Use 5m klines for structure (more meaningful patterns), 1m for CVD/momentum
    const btcStructure = detectPriceStructure(btcK5m, SWEEP_LOOKBACK_5M);
    const btcKeyLevel = detectKeyLevel(btcPrice, btc24h.highPrice, btc24h.lowPrice);
    const relativeStrength = computeRelativeStrength(ethChange1h, btcChange1h);
    const ethChange = eth24h.priceChangePercent || 0;
    const solChange = data.sol?.ticker24h?.priceChangePercent || 0;
    const sectorBias = computeSectorBias(ethChange, solChange);
    const session = getSessionType();
    const liquidations = data.eth.liquidations || { recentEvent: 'none' };
    // Volatility: 24h range as % of low
    const ethRange = eth24h.highPrice > 0 && eth24h.lowPrice > 0
        ? ((eth24h.highPrice - eth24h.lowPrice) / eth24h.lowPrice) * 100
        : 2.0;
    // Volume ratio: recent 10-candle avg vs full 1h avg
    const volumeRatio = computeVolumeRatio(ethK);
    const atr14 = computeATR(ethK, 14);
    const lastCandleCloseTime = ethK.length > 0 ? ethK[ethK.length - 1].closeTime : 0;

    // 20-candle local range & position
    const recent20 = ethK.slice(-20);
    const rangeHigh20 = recent20.length > 0 ? Math.max(...recent20.map(k => k.high)) : ethPrice;
    const rangeLow20 = recent20.length > 0 ? Math.min(...recent20.map(k => k.low)) : ethPrice;
    const rangeSpan = rangeHigh20 - rangeLow20;
    const rangePosition = rangeSpan > 0 ? (ethPrice - rangeLow20) / rangeSpan : 0.5;

    // Spread in basis points
    const bidPrice = eth24h.bidPrice || ethPrice;
    const askPrice = eth24h.askPrice || ethPrice;
    const midPrice = (bidPrice + askPrice) / 2 || ethPrice;
    const spreadBps = midPrice > 0 && askPrice >= bidPrice && (askPrice - bidPrice) > 0
        ? ((askPrice - bidPrice) / midPrice) * 10000
        : 0;

    const maxSpread = config.MAX_SPREAD_BPS || 15;
    const regime = classifyRegime(ethChange5m, atr14, btcChange5m, ethPrice, spreadBps, maxSpread);

    return {
        btc: {
            price: btcPrice,
            change1h: btcChange1h, change5m: btcChange5m,
            dailyChange: btc24h.priceChangePercent,
            distFromHigh: btcDistHigh, distFromLow: btcDistLow,
            cvdDirection: btcCvd.direction, cvdSlope: btcCvd.slope, cvdValue: btcCvd.value,
            volumeDeltaDirection: btcCvd.direction, volumeDeltaSlope: btcCvd.slope, volumeDeltaValue: btcCvd.value,
            structure: btcStructure, klines: btcK,
            keyLevel: btcKeyLevel,
        },
        eth: {
            price: ethPrice,
            change1h: ethChange1h, change5m: ethChange5m,
            dailyChange: eth24h.priceChangePercent,
            distFromHigh: ethDistHigh, distFromLow: ethDistLow,
            cvdDirection: ethCvd.direction, cvdSlope: ethCvd.slope, cvdValue: ethCvd.value,
            volumeDeltaDirection: ethCvd.direction, volumeDeltaSlope: ethCvd.slope, volumeDeltaValue: ethCvd.value,
            relativeStrength: relativeStrength,
            klines: ethK, high24h: eth24h.highPrice, low24h: eth24h.lowPrice,
            ethRange: ethRange,
            volumeRatio: volumeRatio,
            atr14: atr14,
            lastCandleCloseTime: lastCandleCloseTime,
            rangeHigh20: rangeHigh20,
            rangeLow20: rangeLow20,
            rangePosition: rangePosition,
            spreadBps: spreadBps,
            bidPrice: bidPrice,
            askPrice: askPrice,
        },
        regime: regime,
        sector: { ethChange, solChange, bias: sectorBias, solPrice: data.sol?.ticker24h?.lastPrice || 0 },
        liquidations: liquidations,
        session: session,
    };
}

export function computeATR(klines, period = 14) {
    if (!klines || klines.length < period + 1) return 0;
    let trSum = 0;
    const slice = klines.slice(-(period + 1));
    for (let i = 1; i < slice.length; i++) {
        const high = slice[i].high;
        const low = slice[i].low;
        const prevClose = slice[i - 1].close;
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trSum += tr;
    }
    return trSum / period;
}

export function classifyRegime(ethChange5m, atr14, btcChange5m, ethPrice, spreadBps = 0, maxSpreadBps = 15) {
    if (!ethPrice || ethPrice === 0) return 'NO_TRADE';
    if (spreadBps > maxSpreadBps) {
        console.warn(`[Regime] Spread ${spreadBps.toFixed(1)} bps exceeds max ${maxSpreadBps} bps. Setting regime to NO_TRADE.`);
        return 'NO_TRADE';
    }
    const atrPct = (atr14 / ethPrice) * 100;
    const trendStrength = atrPct > 0 ? Math.abs(ethChange5m) / (atrPct * 2) : 0;
    const btcAligned = Math.sign(ethChange5m) === Math.sign(btcChange5m) || Math.abs(btcChange5m) < 0.05;

    if (trendStrength >= 1.0 && btcAligned) {
        return ethChange5m > 0 ? 'TREND_UP' : 'TREND_DOWN';
    } else if (trendStrength < 0.6) {
        return 'RANGE';
    }
    return 'NO_TRADE';
}

export function percentChange(klines, periods) {
    if (!klines || klines.length < periods + 1) return 0;
    const current = klines[klines.length - 1].close;
    const past = klines[klines.length - 1 - periods]?.close;
    if (!past || past === 0) return 0;
    return ((current - past) / past) * 100;
}

export function computeCVD(klines) {
    if (!klines || klines.length < CVD_WINDOW) return { direction: 'flat', slope: 'flat', value: 0 };
    const deltas = klines.map(k => {
        const sellVol = k.volume - k.takerBuyVolume;
        return k.takerBuyVolume - sellVol;
    });
    const recentN = deltas.slice(-CVD_WINDOW);
    const cvdValues = [];
    let cumulative = 0;
    for (const d of recentN) {
        cumulative += d;
        cvdValues.push(cumulative);
    }
    // Compare last 5 values vs first 5 values for smoother trend detection
    const recentAvg = cvdValues.slice(-5).reduce((s, v) => s + v, 0) / 5;
    const earlyAvg = cvdValues.slice(0, 5).reduce((s, v) => s + v, 0) / 5;
    const diff = recentAvg - earlyAvg;
    const avgVol = klines.slice(-CVD_WINDOW).reduce((s, k) => s + k.volume, 0) / CVD_WINDOW;
    const normalizedSlope = avgVol > 0 ? Math.abs(diff) / avgVol : 0;
    let direction = 'flat';
    if (diff > avgVol * 0.05) direction = 'rising';
    else if (diff < -avgVol * 0.05) direction = 'falling';
    let slope = 'flat';
    if (normalizedSlope >= CVD_STEEP_THRESHOLD) slope = 'steep';
    else if (normalizedSlope >= CVD_GRADUAL_THRESHOLD) slope = 'gradual';
    return { direction, slope, value: cumulative };
}

export function detectPriceStructure(klines, sweepLookback = SWEEP_LOOKBACK_5M) {
    if (!klines || klines.length < sweepLookback + 4) return 'ranging';
    const lookback = klines.slice(-(sweepLookback + 3), -3);
    const recent3 = klines.slice(-3); // last 3 candles
    const current = recent3[2];
    const swingLow = Math.min(...lookback.map(k => k.low));
    const swingHigh = Math.max(...lookback.map(k => k.high));

    // Sweep reclaim: check if any of last 3 candles swept, and current reclaimed
    const sweptLow = recent3.some(k => k.low < swingLow);
    const reclaimedAbove = current.close > swingLow;
    if (sweptLow && reclaimedAbove) {
        const lowestWick = Math.min(...recent3.map(k => k.low));
        const depth = ((swingLow - lowestWick) / swingLow) * 100;
        if (depth >= SWEEP_MIN_DEPTH) return 'sweep_reclaim_bullish';
    }
    const sweptHigh = recent3.some(k => k.high > swingHigh);
    const rejectedBelow = current.close < swingHigh;
    if (sweptHigh && rejectedBelow) {
        const highestWick = Math.max(...recent3.map(k => k.high));
        const depth = ((highestWick - swingHigh) / swingHigh) * 100;
        if (depth >= SWEEP_MIN_DEPTH) return 'sweep_reclaim_bearish';
    }

    // Rejection / Support: check last 3 candles, require no contradiction after
    for (let i = 0; i < 3; i++) {
        const candle = recent3[i];
        const range = candle.high - candle.low;
        if (range <= 0) continue;

        const upperWick = (candle.high - Math.max(candle.open, candle.close)) / range;
        const lowerWick = (Math.min(candle.open, candle.close) - candle.low) / range;

        // Rejection: long upper wick + red close, not contradicted by a green close after
        if (upperWick > 0.6 && candle.close < candle.open) {
            const contradicted = recent3.slice(i + 1).some(k => k.close > candle.high * 0.998);
            if (!contradicted) return 'rejection';
        }
        // Support: long lower wick + green close, not contradicted by a red close after
        if (lowerWick > 0.6 && candle.close > candle.open) {
            const contradicted = recent3.slice(i + 1).some(k => k.close < candle.low * 1.002);
            if (!contradicted) return 'support_holding';
        }
    }

    // Breakout/breakdown: current candle only
    if (current.close > swingHigh && current.close > current.open) return 'breakout';
    if (current.close < swingLow && current.close < current.open) return 'breakdown';
    return 'ranging';
}

export function detectKeyLevel(price, high, low) {
    if (high === 0 || low === 0) return 'mid_range';
    const range = high - low;
    if (range === 0) return 'mid_range';
    const positionInRange = (price - low) / range;
    if (positionInRange >= 0.85) return 'at_resistance';
    if (positionInRange <= 0.15) return 'at_support';
    return 'mid_range';
}

export function computeRelativeStrength(ethChange, btcChange) {
    const diff = ethChange - btcChange;
    if (Math.abs(diff) < 0.15) return 'aligned';
    if (Math.abs(diff) > 2) return 'decoupled';
    if (diff > 0.3) return 'stronger';
    if (diff < -0.3) return 'weaker';
    return 'aligned'; // 0.15-0.3 gap is noise, not conviction
}

export function computeVolumeRatio(klines) {
    if (!klines || klines.length < 60) return 1.0;
    const recent10 = klines.slice(-10);
    const full60 = klines.slice(-60);
    const avgRecent = recent10.reduce((s, k) => s + k.volume, 0) / 10;
    const avgFull = full60.reduce((s, k) => s + k.volume, 0) / 60;
    return avgFull > 0 ? avgRecent / avgFull : 1.0;
}

export function computeSectorBias(ethChange, solChange) {
    if (ethChange > 1 && solChange > 1) return 'bullish';
    if (ethChange < -1 && solChange < -1) return 'bearish';
    return 'mixed';
}

export function getSessionType() {
    const now = new Date();
    const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
    return { hour: utcHour };
}
