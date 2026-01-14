/**
 * Binance Real-Time Delta Data Client
 *
 * This module provides real-time:
 * - Cumulative Volume Delta (CVD)
 * - Volume Delta per candle
 * - Funding Rate
 * - Open Interest
 * - Price correlation between BTC and DOGE
 * - Lag Score calculation
 *
 * Uses Binance Futures WebSocket + REST APIs (completely FREE)
 */

import WebSocket from "ws";

// Configuration
const FUTURES_WS_BASE = "wss://fstream.binance.com/ws";
const FUTURES_REST_BASE = "https://fapi.binance.com";

/**
 * DeltaDataClient - Real-time delta data from Binance
 */
export class DeltaDataClient {
    constructor(symbols = ["BTCUSDT", "DOGEUSDT"]) {
        this.symbols = symbols;
        this.ws = null;

        // Data storage per symbol
        this.data = {};
        symbols.forEach((symbol) => {
            this.data[symbol] = {
                // CVD tracking
                cvd: 0, // Cumulative Volume Delta
                deltaHistory: [], // Delta per minute for last N candles
                buyVolume: 0,
                sellVolume: 0,

                // Price data
                price: 0,
                // History for calculations
                priceHistory: [], // Last 240s for Lag Score
                klines: {
                    "1m": { open: 0, high: 0, low: 0, close: 0, volume: 0 },
                    "3m": { open: 0, high: 0, low: 0, close: 0, volume: 0 },
                    "5m": { open: 0, high: 0, low: 0, close: 0, volume: 0 },
                },
                klineHistory: {
                    "1m": [], // Last 70 candles for 60-period Correlation + 10m history
                },
                corrHistory: [], // History of calculated correlation values
                ohlc: { open: 0, high: 0, low: 0, close: 0, volume: 0 }, // Legacy support for 1m

                // Market data
                fundingRate: 0,
                openInterest: 0,
                change24h: 0,
                sessionLow: Infinity,
                sessionHigh: -Infinity,
                atr14: 0,
                atrHistory: [], // For ATR calculation

                // Timestamps
                lastUpdate: 0,
                currentMinute: 0,

                // Sweep Tracking
                lastLow: Infinity,
                lastHigh: -Infinity,
                sweepOccurred: false,
            };
        });

        // Correlation tracking
        this.correlation = 0;
        this.lagScore = 0;

        // Event callbacks
        this.onData = null;
        this.onSignal = null;

        // Stability tracking
        this.oiInterval = null;
        this.heartbeatInterval = null;
        this.isExplicitlyDisconnected = false;
    }

    /**
     * Connect to Binance WebSocket
     */
    connect() {
        // Build combined stream URL
        const streams = [];
        this.symbols.forEach((symbol) => {
            const s = symbol.toLowerCase();
            streams.push(`${s}@aggTrade`); // For CVD calculation
            streams.push(`${s}@kline_1m`); // For OHLC
            if (symbol === "BTCUSDT") streams.push(`${s}@kline_3m`);
            if (symbol === "DOGEUSDT") streams.push(`${s}@kline_5m`);
            streams.push(`${s}@markPrice`); // For funding rate
            streams.push(`${s}@ticker`); // For 24h stats
        });

        const wsUrl = `${FUTURES_WS_BASE}/${streams.join("/")}`;
        console.log(`[DeltaClient] Connecting to: ${wsUrl}`);

        this.ws = new WebSocket(wsUrl);

        this.ws.addEventListener("open", () => {
            console.log("[DeltaClient] WebSocket connected");
            // Fetch initial data
            this.fetchInitialData();
        });

        this.ws.addEventListener("message", (event) => {
            this.handleMessage(JSON.parse(event.data));
        });

        this.ws.addEventListener("error", (err) => {
            console.error("[DeltaClient] WebSocket error:", err.message || err);
        });

        this.ws.addEventListener("close", () => {
            if (this.isExplicitlyDisconnected) return;
            console.log("[DeltaClient] WebSocket closed, reconnecting in 5s...");
            setTimeout(() => this.connect(), 5000);
        });

        // Start background tasks only once
        if (!this.oiInterval) {
            this.oiInterval = setInterval(() => this.fetchOpenInterest(), 30000);
        }
        if (!this.heartbeatInterval) {
            this.heartbeatInterval = setInterval(() => {
                console.log(`[Heartbeat] ${new Date().toLocaleTimeString()} - Bot is active. BTC: $${this.data["BTCUSDT"].price}`);
            }, 300000); // Every 5 minutes
        }
    }

    /**
     * Handle incoming WebSocket message
     */
    handleMessage(msg) {
        const eventType = msg.e;
        const symbol = msg.s;

        if (!symbol || !this.data[symbol]) return;

        switch (eventType) {
            case "aggTrade":
                this.handleAggTrade(symbol, msg);
                break;
            case "kline":
                this.handleKline(symbol, msg.k);
                break;
            case "markPriceUpdate":
                this.handleMarkPrice(symbol, msg);
                break;
            case "24hrTicker":
                this.handle24hTicker(symbol, msg);
                break;
        }
    }

    /**
     * Handle aggregated trade - for CVD calculation
     */
    handleAggTrade(symbol, trade) {
        const data = this.data[symbol];
        const qty = parseFloat(trade.q);
        const isBuyerMaker = trade.m; // true = aggressive seller, false = aggressive buyer

        // Calculate delta
        // Aggressive buy = positive delta, Aggressive sell = negative delta
        if (isBuyerMaker) {
            // Buyer was maker, so taker was SELLER (sell pressure)
            data.sellVolume += qty;
            data.cvd -= qty;
        } else {
            // Buyer was taker (buy pressure)
            data.buyVolume += qty;
            data.cvd += qty;
        }

        data.price = parseFloat(trade.p);
        data.lastUpdate = Date.now();

        // Initialize session low/high if not set
        if (data.sessionLow === Infinity) data.sessionLow = data.price;
        if (data.sessionHigh === -Infinity) data.sessionHigh = data.price;
        if (data.lastLow === Infinity) data.lastLow = data.price;
        if (data.lastHigh === -Infinity) data.lastHigh = data.price;

        // Track minute-level deltas
        const currentMinute = Math.floor(trade.T / 60000);
        if (data.currentMinute !== currentMinute) {
            // New minute - store previous delta
            const delta = data.buyVolume - data.sellVolume;
            data.deltaHistory.push({
                timestamp: data.currentMinute * 60000,
                delta: delta,
                price: data.price,
            });

            // Keep last 60 candles
            if (data.deltaHistory.length > 60) {
                data.deltaHistory.shift();
            }

            // Reset minute volumes
            data.buyVolume = 0;
            data.sellVolume = 0;
            data.currentMinute = currentMinute;
        }

        // Update price history (once per second approx)
        data.priceHistory.push({ price: data.price, time: Date.now() });
        if (data.priceHistory.length > 250) data.priceHistory.shift();

        this.onData(this.getSnapshot());
    }

    /**
     * Handle kline (candlestick) data
     */
    handleKline(symbol, kline) {
        const data = this.data[symbol];
        const interval = kline.i;

        const klineData = {
            open: parseFloat(kline.o),
            high: parseFloat(kline.h),
            low: parseFloat(kline.l),
            close: parseFloat(kline.c),
            volume: parseFloat(kline.v),
            isClosed: kline.x,
        };

        if (klineData.isClosed) {
            // Update session low/high
            if (data.sessionLow === Infinity) data.sessionLow = klineData.low;
            if (data.sessionHigh === -Infinity) data.sessionHigh = klineData.high;

            if (klineData.low < data.sessionLow) data.sessionLow = klineData.low;
            if (klineData.high > data.sessionHigh) data.sessionHigh = klineData.high;

            // Track last candle low/high for sweep detection
            data.lastLow = klineData.low;
            data.lastHigh = klineData.high;

            // Update ATR(14) if 1m
            if (interval === "1m") {
                const tr = Math.max(
                    klineData.high - klineData.low,
                    Math.abs(klineData.high - data.ohlc.close),
                    Math.abs(klineData.low - data.ohlc.close)
                );
                data.atrHistory.push(tr);
                if (data.atrHistory.length > 14) data.atrHistory.shift();
                if (data.atrHistory.length === 14) {
                    data.atr14 = data.atrHistory.reduce((a, b) => a + b, 0) / 14;
                }
            }
        }

        if (data.klines[interval]) {
            data.klines[interval] = klineData;
        }

        if (klineData.isClosed && interval === "1m") {
            data.klineHistory["1m"].push(klineData);
            if (data.klineHistory["1m"].length > 70) data.klineHistory["1m"].shift();

            // Update correlation history on every 1m candle close
            const newCorr = this.calculateCorrelation();
            data.corrHistory.push(newCorr);
            if (data.corrHistory.length > 20) data.corrHistory.shift();
        }

        // Keep ohlc as 1m for backward compatibility
        if (interval === "1m") {
            data.ohlc = klineData;
        }
    }

    /**
     * Handle mark price update (includes funding rate)
     */
    handleMarkPrice(symbol, msg) {
        const data = this.data[symbol];
        data.fundingRate = parseFloat(msg.r) * 100; // Convert to percentage
    }

    /**
     * Handle 24h ticker stats
     */
    handle24hTicker(symbol, ticker) {
        const data = this.data[symbol];
        data.change24h = parseFloat(ticker.P); // Percent change
    }

    /**
     * Fetch all initial data via REST API
     */
    async fetchInitialData() {
        await Promise.all([
            this.fetchOpenInterest(),
            this.fetchInitialKlines(),
            this.fetchInitialMarketData(),
            this.fetchInitialTrades()
        ]);

        // Calculate initial metrics
        const initialCorr = this.calculateCorrelation();
        this.data["BTCUSDT"].corrHistory.push(initialCorr);
        this.data["DOGEUSDT"].corrHistory.push(initialCorr);

        // Initial ATR for all symbols
        for (const symbol of this.symbols) {
            const klines = this.data[symbol].klineHistory["1m"];
            if (klines.length >= 14) {
                const trs = [];
                for (let i = 1; i < klines.length; i++) {
                    trs.push(Math.max(
                        klines[i].high - klines[i].low,
                        Math.abs(klines[i].high - klines[i - 1].close),
                        Math.abs(klines[i].low - klines[i - 1].close)
                    ));
                }
                this.data[symbol].atrHistory = trs.slice(-14);
                this.data[symbol].atr14 = this.data[symbol].atrHistory.reduce((a, b) => a + b, 0) / 14;
            }
        }

        console.log("[DeltaClient] Initial data populated and metrics calculated");
    }

    /**
     * Fetch initial trades to populate CVD and Delta history
     */
    async fetchInitialTrades() {
        for (const symbol of this.symbols) {
            try {
                // Fetch last 500 aggTrades
                const response = await fetch(
                    `${FUTURES_REST_BASE}/fapi/v1/aggTrades?symbol=${symbol}&limit=500`
                );
                const trades = await response.json();

                if (Array.isArray(trades) && trades.length > 0) {
                    const data = this.data[symbol];
                    let cumulativeCvd = 0;

                    // Reset deltaHistory for initial load
                    data.deltaHistory = [];

                    trades.forEach(t => {
                        const price = parseFloat(t.p);
                        const qty = parseFloat(t.q);
                        const isBuyerMaker = t.m; // true means sell, false means buy in aggTrade
                        const delta = isBuyerMaker ? -qty : qty;

                        cumulativeCvd += delta;

                        // Add to history (limit to last 250)
                        data.deltaHistory.push({
                            timestamp: t.T,
                            delta: delta,
                            price: price
                        });

                        // Initialize session tracking
                        if (data.sessionLow === Infinity || data.sessionLow === null) data.sessionLow = price;
                        if (data.sessionHigh === -Infinity || data.sessionHigh === null) data.sessionHigh = price;
                        if (data.lastLow === Infinity || data.lastLow === null) data.lastLow = price;
                        if (data.lastHigh === -Infinity || data.lastHigh === null) data.lastHigh = price;

                        data.sessionLow = Math.min(data.sessionLow, price);
                        data.sessionHigh = Math.max(data.sessionHigh, price);
                    });

                    data.cvd = cumulativeCvd;
                    data.deltaHistory = data.deltaHistory.slice(-250);

                    // Update current price to latest trade
                    const lastTrade = trades[trades.length - 1];
                    data.price = parseFloat(lastTrade.p);
                    data.lastUpdate = lastTrade.T;
                    data.currentMinute = Math.floor(lastTrade.T / 60000);
                }
            } catch (err) {
                console.error(`[DeltaClient] Error fetching initial trades for ${symbol}:`, err.message);
            }
        }
    }

    /**
     * Fetch initial kline history via REST API
     */
    async fetchInitialKlines() {
        const intervals = ["1m", "3m", "5m"];
        for (const symbol of this.symbols) {
            for (const interval of intervals) {
                try {
                    // Fetch last 100 klines to be safe
                    const response = await fetch(
                        `${FUTURES_REST_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=100`
                    );
                    const klines = await response.json();

                    if (Array.isArray(klines) && klines.length > 0) {
                        const lastKline = klines[klines.length - 1];
                        const klineData = {
                            open: parseFloat(lastKline[1]),
                            high: parseFloat(lastKline[2]),
                            low: parseFloat(lastKline[3]),
                            close: parseFloat(lastKline[4]),
                            volume: parseFloat(lastKline[5]),
                            isClosed: true
                        };

                        this.data[symbol].klines[interval] = klineData;
                        if (interval === "1m") {
                            this.data[symbol].ohlc = klineData;
                            this.data[symbol].price = klineData.close;

                            // Populate klineHistory
                            this.data[symbol].klineHistory["1m"] = klines.map(k => ({
                                open: parseFloat(k[1]),
                                high: parseFloat(k[2]),
                                low: parseFloat(k[3]),
                                close: parseFloat(k[4]),
                                volume: parseFloat(k[5]),
                                isClosed: true
                            })).slice(-70);

                            // Populate priceHistory for Lag Score (last 250 points from 1m klines as fallback)
                            this.data[symbol].priceHistory = klines.map(k => ({
                                price: parseFloat(k[4]),
                                time: k[0]
                            })).slice(-250);
                        }
                    }
                } catch (err) {
                    console.error(`[DeltaClient] Error fetching initial klines for ${symbol} ${interval}:`, err.message);
                }
            }
        }
    }

    /**
     * Fetch initial funding and ticker data
     */
    async fetchInitialMarketData() {
        for (const symbol of this.symbols) {
            try {
                // Funding Rate
                const fRes = await fetch(`${FUTURES_REST_BASE}/fapi/v1/premiumIndex?symbol=${symbol}`);
                const fData = await fRes.json();
                this.data[symbol].fundingRate = parseFloat(fData.lastFundingRate) * 100;

                // 24h Ticker
                const tRes = await fetch(`${FUTURES_REST_BASE}/fapi/v1/ticker/24hr?symbol=${symbol}`);
                const tData = await tRes.json();
                this.data[symbol].change24h = parseFloat(tData.priceChangePercent);
            } catch (err) {
                console.error(`[DeltaClient] Error fetching market data for ${symbol}:`, err.message);
            }
        }
    }

    /**
     * Fetch open interest via REST API
     */
    async fetchOpenInterest() {
        for (const symbol of this.symbols) {
            try {
                const response = await fetch(
                    `${FUTURES_REST_BASE}/fapi/v1/openInterest?symbol=${symbol}`
                );
                const result = await response.json();
                this.data[symbol].openInterest = parseFloat(result.openInterest);
            } catch (err) {
                console.error(`[DeltaClient] Error fetching OI for ${symbol}:`, err.message);
            }
        }
    }

    /**
     * Calculate Pearson correlation between BTC and DOGE
     */
    calculateCorrelation() {
        const btcKlines = this.data["BTCUSDT"].klineHistory["1m"];
        const dogeKlines = this.data["DOGEUSDT"].klineHistory["1m"];

        if (btcKlines.length < 60 || dogeKlines.length < 60) return 0;

        const btcPrices = btcKlines.slice(-60).map(k => k.close);
        const dogePrices = dogeKlines.slice(-60).map(k => k.close);

        const n = Math.min(btcPrices.length, dogePrices.length);
        if (n < 10) return 0;

        const btcSlice = btcPrices.slice(-n);
        const dogeSlice = dogePrices.slice(-n);

        // Calculate means
        const btcMean = btcSlice.reduce((a, b) => a + b, 0) / n;
        const dogeMean = dogeSlice.reduce((a, b) => a + b, 0) / n;

        // Calculate correlation
        let numerator = 0;
        let btcVar = 0;
        let dogeVar = 0;

        for (let i = 0; i < n; i++) {
            const btcDiff = btcSlice[i] - btcMean;
            const dogeDiff = dogeSlice[i] - dogeMean;
            numerator += btcDiff * dogeDiff;
            btcVar += btcDiff * btcDiff;
            dogeVar += dogeDiff * dogeDiff;
        }

        const denominator = Math.sqrt(btcVar * dogeVar);
        return denominator > 0 ? numerator / denominator : 0;
    }

    /**
     * Calculate Lag Score (BTC % move / DOGE % move over last 4 minutes)
     */
    calculateLagScore() {
        const btcHistory = this.data["BTCUSDT"].priceHistory;
        const dogeHistory = this.data["DOGEUSDT"].priceHistory;

        // Get prices 4 minutes ago (approximately 4 data points if 1 per minute)
        const now = Date.now();
        const fourMinsAgo = now - (4 * 60 * 1000);

        // Find the closest price point to 4 minutes ago
        const btcPast = btcHistory.find(p => p.time >= fourMinsAgo) || btcHistory[0];
        const dogePast = dogeHistory.find(p => p.time >= fourMinsAgo) || dogeHistory[0];

        if (btcHistory.length === 0 || dogeHistory.length === 0) return 0;

        const btcCurrent = btcHistory[btcHistory.length - 1].price;
        const dogeCurrent = dogeHistory[dogeHistory.length - 1].price;

        const btcChange = ((btcCurrent - btcPast.price) / btcPast.price) * 100;
        const dogeChange = ((dogeCurrent - dogePast.price) / dogePast.price) * 100;

        // Avoid division by zero
        if (Math.abs(dogeChange) > 0.0001) {
            return btcChange / dogeChange;
        } else {
            return btcChange > 0 ? Infinity : -Infinity;
        }
    }

    /**
     * Get sum of delta over last N candles
     */
    getDeltaSum(symbol, candles = 10) {
        const data = this.data[symbol];
        const history = data.deltaHistory.slice(-candles);
        return history.reduce((sum, d) => sum + d.delta, 0);
    }

    /**
     * Get sum of delta over a specific time window (in minutes)
     * Used for 3m and 5m delta calculations as per spec
     */
    getDeltaSumByTime(symbol, minutes) {
        const data = this.data[symbol];
        const now = Date.now();
        const cutoff = now - (minutes * 60 * 1000);
        const recentDeltas = data.deltaHistory.filter(d => d.timestamp >= cutoff);
        return recentDeltas.reduce((sum, d) => sum + d.delta, 0);
    }

    /**
     * Get 3-minute CVD history for the last 3 periods
     * Returns array of [cvd_t-2, cvd_t-1, cvd_t]
     */
    get3mCVDHistory() {
        // We need to construct 3-minute buckets from deltaHistory
        // deltaHistory contains 1-minute deltas
        // We want the cumulative delta at the end of each 3-minute period

        // This is a simplified approximation using the available deltaHistory
        // Ideally we would track 3m candles directly, but we can aggregate 1m deltas

        const history = this.data["BTCUSDT"].deltaHistory; // Using BTC for CVD confirmation usually, or generic?
        // The user asked for "is3mCVDConfirming(side)" which implies checking the trend of 3m CVD
        // Let's return the last 3 completed 3-minute delta sums

        // Group by 3-minute intervals
        const buckets = {};
        history.forEach(d => {
            const bucketKey = Math.floor(d.timestamp / (3 * 60000));
            if (!buckets[bucketKey]) buckets[bucketKey] = 0;
            buckets[bucketKey] += d.delta;
        });

        const sortedKeys = Object.keys(buckets).sort().map(Number);
        const last3Keys = sortedKeys.slice(-3);

        // We want the CVD (Cumulative Volume Delta) at these points, not just the delta of the bar
        // But the user prompt says: "Must confirm 3m CVD is making higher high... last3[2] > last3[1]..."
        // If it means the Delta of the 3m bar, then we just return the bucket sums.
        // If it means Cumulative, we need to add them up. 
        // "3m CVD" usually means the Delta of the 3m candle in this context of "making higher high" (increasing buy pressure).
        // Let's assume it means the Delta of the 3m bars.

        return last3Keys.map(k => buckets[k]);
    }

    /**
     * Check if CVD is making higher lows (accumulation)
     */
    isCVDHigherLows(symbol, periods = 5) {
        const history = this.data[symbol].deltaHistory.slice(-periods);
        if (history.length < periods) return false;

        let lows = [];
        for (let i = 1; i < history.length - 1; i++) {
            if (
                history[i].delta < history[i - 1].delta &&
                history[i].delta < history[i + 1].delta
            ) {
                lows.push(history[i].delta);
            }
        }

        if (lows.length < 2) return false;
        return lows[lows.length - 1] > lows[lows.length - 2];
    }

    /**
     * Get complete data snapshot
     */
    getSnapshot() {
        return {
            btc: {
                ...this.data["BTCUSDT"],
                deltaSum3: this.getDeltaSum("BTCUSDT", 3),
                deltaSum10: this.getDeltaSum("BTCUSDT", 10),
                delta3m: this.getDeltaSumByTime("BTCUSDT", 3), // 3-minute delta for BTC
            },
            doge: {
                ...this.data["DOGEUSDT"],
                deltaSum3: this.getDeltaSum("DOGEUSDT", 3),
                deltaSum10: this.getDeltaSum("DOGEUSDT", 10),
                delta5m: this.getDeltaSumByTime("DOGEUSDT", 5), // 5-minute delta for DOGE
                cvdHigherLows: this.isCVDHigherLows("DOGEUSDT"),
            },
            correlation: this.data["BTCUSDT"].corrHistory[this.data["BTCUSDT"].corrHistory.length - 1] || 0,
            corrHistory: this.data["BTCUSDT"].corrHistory,
            lagScore: this.calculateLagScore(),
            timestamp: Date.now()
        };
    }

    /**
     * Pretty print current state
     */
    printStatus() {
        const snapshot = this.getSnapshot();

        console.log("\n========== DELTA DATA STATUS ==========");
        console.log(`Time: ${new Date().toISOString()}`);
        console.log("\n--- BTC ---");
        console.log(`  Price: $${snapshot.btc.price.toFixed(2)}`);
        console.log(`  CVD: ${snapshot.btc.cvd.toFixed(4)}`);
        console.log(`  Delta (10 candles): ${snapshot.btc.deltaSum10.toFixed(4)}`);
        console.log(`  Delta (3 candles): ${snapshot.btc.deltaSum3.toFixed(4)}`);
        console.log(`  Funding Rate: ${snapshot.btc.fundingRate.toFixed(4)}%`);
        console.log(`  Open Interest: ${snapshot.btc.openInterest.toFixed(2)}`);
        console.log(`  24h Change: ${snapshot.btc.change24h.toFixed(2)}%`);

        console.log("\n--- DOGE ---");
        console.log(`  Price: $${snapshot.doge.price.toFixed(6)}`);
        console.log(`  CVD: ${snapshot.doge.cvd.toFixed(4)}`);
        console.log(`  Delta (10 candles): ${snapshot.doge.deltaSum10.toFixed(4)}`);
        console.log(`  CVD Higher Lows: ${snapshot.doge.cvdHigherLows}`);
        console.log(`  Funding Rate: ${snapshot.doge.fundingRate.toFixed(4)}%`);
        console.log(`  24h Change: ${snapshot.doge.change24h.toFixed(2)}%`);

        console.log("\n--- CORRELATION ---");
        console.log(`  BTC/DOGE Correlation (60p): ${snapshot.correlation.toFixed(4)}`);
        console.log(`  Lag Score (4min): ${snapshot.lagScore.toFixed(4)}`);
        console.log("========================================\n");
    }

    /**
   * Check for Fair Value Gap (FVG)
   */
    hasFVG(symbol, side) {
        const history = this.data[symbol].klineHistory["1m"];
        if (history.length < 3) return false;

        const c1 = history[0];
        const c3 = history[2];

        if (side === "BUY") {
            // Bullish FVG: Low of candle 3 > High of candle 1
            return c3.low > c1.high;
        } else {
            // Bearish FVG: High of candle 3 < Low of candle 1
            return c3.high < c1.low;
        }
    }

    /**
     * Disconnect WebSocket
     */
    disconnect() {
        this.isExplicitlyDisconnected = true;
        if (this.oiInterval) clearInterval(this.oiInterval);
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

// Main execution for testing
if (import.meta.url === `file://${process.argv[1]}`) {
    const client = new DeltaDataClient(["BTCUSDT", "DOGEUSDT"]);

    client.onData = (snapshot) => {
        // Print status every 10 seconds
        if (Date.now() % 10000 < 100) {
            client.printStatus();
        }
    };

    client.connect();

    // Print status every 30 seconds
    setInterval(() => {
        client.printStatus();
    }, 30000);

    // Handle graceful shutdown
    process.on("SIGINT", () => {
        console.log("\nShutting down...");
        client.disconnect();
        process.exit(0);
    });
}

export default DeltaDataClient;
