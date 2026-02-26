const BINANCE_BASE = 'https://fapi.binance.com';
const SYMBOLS = { BTC: 'BTCUSDT', DOGE: 'DOGEUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
const CVD_STEEP_THRESHOLD = 0.5;
const CVD_GRADUAL_THRESHOLD = 0.15;
const SWEEP_LOOKBACK = 20;
const SWEEP_MIN_DEPTH = 0.05;
export async function fetchAllMarketData() {
    const { BTC, DOGE, ETH, SOL } = SYMBOLS;
    const [
        btcKlines1m, btcKlines1h, btc24h,
        dogeKlines1m, doge24h,
        eth24h, sol24h, dogeLiquidations
    ] = await Promise.all([
        fetchKlines(BTC, '1m', 70), fetchKlines(BTC, '1h', 5),
        fetch24hTicker(BTC),
        fetchKlines(DOGE, '1m', 70), fetch24hTicker(DOGE),
        fetch24hTicker(ETH), fetch24hTicker(SOL),
        fetchRecentLiquidations(DOGE),
    ]);
    return {
        btc: { klines1m: btcKlines1m, klines1h: btcKlines1h, ticker24h: btc24h },
        doge: { klines1m: dogeKlines1m, ticker24h: doge24h, liquidations: dogeLiquidations },
        eth: { ticker24h: eth24h },
        sol: { ticker24h: sol24h },
    };
}
export async function fetchKlines(symbol, interval, limit) {
    const res = await fetch(`${BINANCE_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map(k => ({
        openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
        closeTime: k[6], quoteVolume: parseFloat(k[7]), trades: k[8],
        takerBuyVolume: parseFloat(k[9]), takerBuyQuoteVolume: parseFloat(k[10]),
    }));
}
export async function fetch24hTicker(symbol) {
    const res = await fetch(`${BINANCE_BASE}/fapi/v1/ticker/24hr?symbol=${symbol}`);
    const data = await res.json();
    return {
        priceChange: parseFloat(data.priceChange || 0),
        priceChangePercent: parseFloat(data.priceChangePercent || 0),
        lastPrice: parseFloat(data.lastPrice || 0),
        highPrice: parseFloat(data.highPrice || 0),
        lowPrice: parseFloat(data.lowPrice || 0),
        volume: parseFloat(data.volume || 0),
    };
}
export async function fetchFunding(symbol) {
    const res = await fetch(`${BINANCE_BASE}/fapi/v1/premiumIndex?symbol=${symbol}`);
    const data = await res.json();
    return { rate: parseFloat(data.lastFundingRate || 0) * 100 };
}
export async function fetchOI(symbol) {
    const res = await fetch(`${BINANCE_BASE}/fapi/v1/openInterest?symbol=${symbol}`);
    const data = await res.json();
    return { value: parseFloat(data.openInterest || 0) };
}
export async function fetchRecentLiquidations(symbol) {
    try {
        const res = await fetch(`${BINANCE_BASE}/fapi/v1/allForceOrders?symbol=${symbol}&limit=20`);
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return { recentEvent: 'none', orders: [] };
        let longLiqCount = 0;
        let shortLiqCount = 0;
        for (const order of data) {
            if (order.side === 'SELL') longLiqCount++;   // SELL force order = long position liquidated
            if (order.side === 'BUY') shortLiqCount++;   // BUY force order = short position liquidated
        }
        let recentEvent = 'none';
        if (longLiqCount > shortLiqCount && longLiqCount >= 3) recentEvent = 'longs_flushed';
        else if (shortLiqCount > longLiqCount && shortLiqCount >= 3) recentEvent = 'shorts_squeezed';
        return { recentEvent, longLiqCount, shortLiqCount };
    } catch (err) {
        console.error('[Binance] Liquidation fetch failed:', err.message);
        return { recentEvent: 'none', longLiqCount: 0, shortLiqCount: 0 };
    }
}
// Fetch real-time delta snapshot from the Durable Object
export async function fetchDeltaFromDO(env) {
    const id = env.DELTA_FEED.idFromName('main');
    const stub = env.DELTA_FEED.get(id);
    const response = await stub.fetch('http://do/snapshot');
    return await response.json();
}
export function computeIndicators(data, config, deltaSnapshot = null) {
    const btcK = data.btc.klines1m;
    const dogeK = data.doge.klines1m;
    const btcK1h = data.btc.klines1h;
    const btcPrice = btcK.length > 0 ? btcK[btcK.length - 1].close : 0;
    const dogePrice = dogeK.length > 0 ? dogeK[dogeK.length - 1].close : 0;
    const btcChange1h = percentChange(btcK, 60);
    const dogeChange1h = percentChange(dogeK, 60);
    const btc24h = data.btc.ticker24h;
    const doge24h = data.doge.ticker24h;
    const btcDistHigh = btc24h.highPrice > 0 ? ((btc24h.highPrice - btcPrice) / btcPrice) * 100 : 0;
    const btcDistLow = btc24h.lowPrice > 0 ? ((btcPrice - btc24h.lowPrice) / btcPrice) * 100 : 0;
    const dogeDistHigh = doge24h.highPrice > 0 ? ((doge24h.highPrice - dogePrice) / dogePrice) * 100 : 0;
    const dogeDistLow = doge24h.lowPrice > 0 ? ((dogePrice - doge24h.lowPrice) / dogePrice) * 100 : 0;
    // Use real-time delta from DO if available, otherwise fall back to kline-based CVD
    let btcCvd, dogeCvd;
    if (deltaSnapshot && deltaSnapshot.connected && deltaSnapshot.btc.minutesOfData >= 3) {
        btcCvd = deltaSnapshot.btc;
        dogeCvd = deltaSnapshot.doge;
        console.log(`[Binance] Using real-time delta (${deltaSnapshot.btc.minutesOfData}min BTC, ${deltaSnapshot.doge.minutesOfData}min DOGE)`);
    } else {
        btcCvd = computeCVD(btcK);
        dogeCvd = computeCVD(dogeK);
        console.log('[Binance] Using kline-based CVD (DO unavailable or insufficient data)');
    }
    const btcStructure = detectPriceStructure(btcK);
    const relativeStrength = computeRelativeStrength(dogeChange1h, btcChange1h);
    const ethChange = data.eth.ticker24h.priceChangePercent;
    const solChange = data.sol.ticker24h.priceChangePercent;
    const sectorBias = computeSectorBias(ethChange, solChange);
    const session = getSessionType(config);
    const liquidations = data.doge.liquidations || { recentEvent: 'none' };
    return {
        btc: {
            price: btcPrice,
            change1h: btcChange1h, dailyChange: btc24h.priceChangePercent,
            distFromHigh: btcDistHigh, distFromLow: btcDistLow,
            cvdDirection: btcCvd.direction, cvdSlope: btcCvd.slope, cvdValue: btcCvd.value,
            structure: btcStructure, klines: btcK, klines1h: btcK1h,
        },
        doge: {
            price: dogePrice,
            change1h: dogeChange1h, dailyChange: doge24h.priceChangePercent,
            distFromHigh: dogeDistHigh, distFromLow: dogeDistLow,
            cvdDirection: dogeCvd.direction, cvdSlope: dogeCvd.slope, cvdValue: dogeCvd.value,
            relativeStrength: relativeStrength,
            klines: dogeK, sessionHigh: doge24h.highPrice, sessionLow: doge24h.lowPrice,
        },
        sector: { ethChange, solChange, bias: sectorBias },
        liquidations: liquidations,
        session: session,
    };
}
export function percentChange(klines, periods) {
    if (!klines || klines.length < periods + 1) return 0;
    const current = klines[klines.length - 1].close;
    const past = klines[klines.length - 1 - periods]?.close;
    if (!past || past === 0) return 0;
    return ((current - past) / past) * 100;
}
export function computeCVD(klines) {
    if (!klines || klines.length < 10) return { direction: 'flat', slope: 'flat', value: 0 };
    const deltas = klines.map(k => {
        const sellVol = k.volume - k.takerBuyVolume;
        return k.takerBuyVolume - sellVol;
    });
    const recent10 = deltas.slice(-10);
    const cvdValues = [];
    let cumulative = 0;
    for (const d of recent10) {
        cumulative += d;
        cvdValues.push(cumulative);
    }
    const recentAvg = (cvdValues[cvdValues.length - 1] + cvdValues[cvdValues.length - 2] + cvdValues[cvdValues.length - 3]) / 3;
    const earlyAvg = (cvdValues[0] + cvdValues[1] + cvdValues[2]) / 3;
    const diff = recentAvg - earlyAvg;
    const avgVol = klines.slice(-10).reduce((s, k) => s + k.volume, 0) / 10;
    const normalizedSlope = avgVol > 0 ? Math.abs(diff) / avgVol : 0;
    let direction = 'flat';
    if (diff > avgVol * 0.05) direction = 'rising';
    else if (diff < -avgVol * 0.05) direction = 'falling';
    let slope = 'flat';
    if (normalizedSlope >= CVD_STEEP_THRESHOLD) slope = 'steep';
    else if (normalizedSlope >= CVD_GRADUAL_THRESHOLD) slope = 'gradual';
    return { direction, slope, value: cumulative };
}
export function detectPriceStructure(klines) {
    if (!klines || klines.length < SWEEP_LOOKBACK + 2) return 'ranging';
    const lookback = klines.slice(-(SWEEP_LOOKBACK + 1), -1);
    const current = klines[klines.length - 1];
    const prev = klines[klines.length - 2];
    const swingLow = Math.min(...lookback.map(k => k.low));
    const swingHigh = Math.max(...lookback.map(k => k.high));
    const sweptLow = current.low < swingLow || prev.low < swingLow;
    const reclaimedAbove = current.close > swingLow;
    if (sweptLow && reclaimedAbove) {
        const depth = ((swingLow - Math.min(current.low, prev.low)) / swingLow) * 100;
        if (depth >= SWEEP_MIN_DEPTH) return 'sweep_reclaim_bullish';
    }
    const sweptHigh = current.high > swingHigh || prev.high > swingHigh;
    const rejectedBelow = current.close < swingHigh;
    if (sweptHigh && rejectedBelow) {
        const depth = ((Math.max(current.high, prev.high) - swingHigh) / swingHigh) * 100;
        if (depth >= SWEEP_MIN_DEPTH) return 'sweep_reclaim_bearish';
    }
    const wickRatio = current.high - current.low > 0
        ? (current.high - Math.max(current.open, current.close)) / (current.high - current.low) : 0;
    if (wickRatio > 0.6 && current.close < current.open) return 'rejection';
    const lowerWickRatio = current.high - current.low > 0
        ? (Math.min(current.open, current.close) - current.low) / (current.high - current.low) : 0;
    if (lowerWickRatio > 0.6 && current.close > current.open) return 'support_holding';
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
export function computeRelativeStrength(dogeChange, btcChange) {
    const diff = dogeChange - btcChange;
    if (Math.abs(diff) < 0.2) return 'aligned';
    if (Math.abs(diff) > 2) return 'decoupled';
    if (diff > 0.5) return 'stronger';
    if (diff < -0.5) return 'weaker';
    return diff > 0 ? 'stronger' : 'weaker';
}
export function computeSectorBias(ethChange, solChange) {
    if (ethChange > 1 && solChange > 1) return 'bullish';
    if (ethChange < -1 && solChange < -1) return 'bearish';
    return 'mixed';
}
export function getSessionType(config) {
    const now = new Date();
    const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
    for (const zone of config.DEAD_ZONES) {
        if (utcHour >= zone.start && utcHour < zone.end) return { type: 'DEAD_ZONE', hour: utcHour };
    }
    for (const session of config.PREFERRED_SESSIONS) {
        if (utcHour >= session.start && utcHour < session.end) return { type: 'PREFERRED', hour: utcHour };
    }
    return { type: 'CAUTION', hour: utcHour };
}
export function averageVolume(klines, periods) {
    if (!klines || klines.length < periods) return 0;
    const recent = klines.slice(-periods);
    return recent.reduce((s, k) => s + k.volume, 0) / periods;
}
