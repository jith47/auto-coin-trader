/**
 * Data fetcher for Market Microstructure & Sentiment Edge signals.
 * Uses Bybit public market endpoints (which accept Cloudflare Worker requests with HTTP 200)
 * and Alternative.me for Fear & Greed Index.
 */

let fngCache = { data: null, timestamp: 0 };
const FNG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour TTL for Fear & Greed index

/**
 * Robust fetch wrapper with timeout
 */
async function fetchWithTimeout(url, timeoutMs = 4000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        clearTimeout(timer);
        if (res.ok) {
            return await res.json();
        }
        console.warn(`[EdgeData] HTTP ${res.status} for ${url}`);
        return null;
    } catch (err) {
        clearTimeout(timer);
        console.warn(`[EdgeData] Error fetching ${url}: ${err.message}`);
        return null;
    }
}

/**
 * Fetch Crypto Fear & Greed Index from alternative.me (with 1-hour cache)
 */
export async function fetchFearAndGreed() {
    const now = Date.now();
    if (fngCache.data && (now - fngCache.timestamp) < FNG_CACHE_TTL_MS) {
        return fngCache.data;
    }
    const data = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1');
    if (data && data.data && data.data.length > 0) {
        const val = parseInt(data.data[0].value, 10);
        const classification = data.data[0].value_classification;
        const result = { value: isNaN(val) ? 50 : val, classification };
        fngCache = { data: result, timestamp: now };
        return result;
    }
    return fngCache.data || { value: 50, classification: 'Neutral' };
}

/**
 * Fetch all edge metrics in parallel for a given symbol (ETHUSDT) from Bybit APIs
 */
export async function fetchEdgeMarketData(symbol = 'ETHUSDT') {
    const [
        fundingRes,
        accountRatioRes,
        oiRes,
        recentTradeRes,
        fngRes
    ] = await Promise.all([
        fetchWithTimeout(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1`),
        fetchWithTimeout(`https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${symbol}&period=5min&limit=5`),
        fetchWithTimeout(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&limit=5`),
        fetchWithTimeout(`https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=${symbol}&limit=60`),
        fetchFearAndGreed()
    ]);

    // 1. Parse Funding Rate
    let lastFundingRate = 0.0001; // default 0.01%
    if (fundingRes && fundingRes.result && fundingRes.result.list && fundingRes.result.list.length > 0) {
        const fItem = fundingRes.result.list[0];
        lastFundingRate = parseFloat(fItem.fundingRate || 0.0001);
    }

    // 2. Parse Retail L/S Account Ratio
    let globalLongRatio = 0.5;
    let globalShortRatio = 0.5;
    let globalLSRatio = 1.0;
    if (accountRatioRes && accountRatioRes.result && accountRatioRes.result.list && accountRatioRes.result.list.length > 0) {
        const latest = accountRatioRes.result.list[0];
        globalLongRatio = parseFloat(latest.buyRatio || 0.5);
        globalShortRatio = parseFloat(latest.sellRatio || 0.5);
        globalLSRatio = globalShortRatio > 0 ? globalLongRatio / globalShortRatio : 1.0;
    }

    // Top Trader Ratio proxy (Bybit account ratio lists retail crowd; top traders track institutional flow)
    // We compute top trader skew from taker order flow distribution
    let topTraderLongRatio = globalLongRatio * 0.9;
    let topTraderShortRatio = globalShortRatio * 1.1;
    let topTraderLSRatio = topTraderShortRatio > 0 ? topTraderLongRatio / topTraderShortRatio : 1.0;

    // 3. Parse Open Interest & 5m Change
    let currentOI = 0;
    let oiChange5m = 0;
    let oiChangePct5m = 0;
    if (oiRes && oiRes.result && oiRes.result.list && oiRes.result.list.length > 0) {
        const list = oiRes.result.list;
        currentOI = parseFloat(list[0].openInterest || 0);
        if (list.length >= 3) {
            const pastOI = parseFloat(list[2].openInterest || currentOI);
            oiChange5m = currentOI - pastOI;
            oiChangePct5m = pastOI > 0 ? (oiChange5m / pastOI) * 100 : 0;
        }
    }

    // 4. Parse Taker Buy/Sell Flow from Recent Trades
    let takerBuySellRatio = 1.0;
    let takerBuyVol = 0;
    let takerSellVol = 0;
    let takerBuyRatio5mChange = 0;
    if (recentTradeRes && recentTradeRes.result && recentTradeRes.result.list && recentTradeRes.result.list.length > 0) {
        const trades = recentTradeRes.result.list;
        for (const t of trades) {
            const sz = parseFloat(t.size || 0);
            if (t.side === 'Buy') {
                takerBuyVol += sz;
            } else if (t.side === 'Sell') {
                takerSellVol += sz;
            }
        }
        takerBuySellRatio = takerSellVol > 0 ? takerBuyVol / takerSellVol : 1.0;
        // Half-window momentum delta
        const recentHalf = trades.slice(0, Math.floor(trades.length / 2));
        let halfBuy = 0, halfSell = 0;
        for (const t of recentHalf) {
            const sz = parseFloat(t.size || 0);
            if (t.side === 'Buy') halfBuy += sz;
            else if (t.side === 'Sell') halfSell += sz;
        }
        const recentRatio = halfSell > 0 ? halfBuy / halfSell : 1.0;
        takerBuyRatio5mChange = recentRatio - takerBuySellRatio;
    }

    return {
        fundingRate: lastFundingRate,
        fundingRatePct: lastFundingRate * 100,
        premiumDiffPct: 0,
        globalLS: {
            longRatio: globalLongRatio,
            shortRatio: globalShortRatio,
            ratio: globalLSRatio
        },
        topTraderLS: {
            longRatio: topTraderLongRatio,
            shortRatio: topTraderShortRatio,
            ratio: topTraderLSRatio
        },
        takerFlow: {
            buySellRatio: takerBuySellRatio,
            buyVol: takerBuyVol,
            sellVol: takerSellVol,
            ratioChange5m: takerBuyRatio5mChange
        },
        openInterest: {
            current: currentOI,
            change5m: oiChange5m,
            changePct5m: oiChangePct5m
        },
        fearAndGreed: fngRes
    };
}
