/**
 * Binance Delta Data Client v5.1 - Universal Version
 * 
 * Works in both:
 * - Node.js (uses WebSocket)
 * - Cloudflare Workers (uses REST API polling)
 */

const FUTURES_REST_BASE = "https://fapi.binance.com";
const FUTURES_WS_BASE = "wss://fstream.binance.com/ws";

// Detect environment
const isCloudflareWorker = typeof WebSocket !== 'undefined' && typeof WebSocket.prototype.accept === 'function';
const isNodeJS = typeof process !== 'undefined' && process.versions?.node;

export class DeltaDataClient {
    constructor(symbols = ["BTCUSDT", "DOGEUSDT"]) {
        this.symbols = symbols;
        this.ws = null;
        this.isRunning = false;
        this.pollInterval = null;
        this.useWebSocket = isNodeJS && !isCloudflareWorker;

        // Data storage per symbol
        this.data = {};
        symbols.forEach((symbol) => {
            this.data[symbol] = {
                cvd: 0,
                deltaHistory: [],
                buyVolume: 0,
                sellVolume: 0,
                price: 0,
                priceHistory: [],
                klines: {
                    "1m": { open: 0, high: 0, low: 0, close: 0, volume: 0 },
                },
                klineHistory: {
                    "1m": [],
                },
                ohlc: { open: 0, high: 0, low: 0, close: 0, volume: 0, isClosed: false },
                fundingRate: 0,
                openInterest: 0,
                change24h: 0,
                sessionLow: Infinity,
                sessionHigh: -Infinity,
                atr14: 0,
                atrHistory: [],
                lastUpdate: 0,
                currentMinute: 0,
                lastTradeId: 0,
            };
        });

        this.corrHistory = [];
        this.deltaPercentileHistory = { BTCUSDT: [], DOGEUSDT: [] };
        this.deltaPercentileCache = { BTCUSDT: 50, DOGEUSDT: 50 };
        this.sessionDate = new Date().getUTCDate();
        this.lastProcessedCandleTime = { BTCUSDT: 0, DOGEUSDT: 0 };

        this.onData = null;
        this.oiInterval = null;
        this.heartbeatInterval = null;
        this.isExplicitlyDisconnected = false;

        console.log(`[DeltaClient] v5.1 Initialized (Mode: ${this.useWebSocket ? 'WebSocket' : 'REST Polling'})`);
    }

    async connect() {
        if (this.useWebSocket) {
            await this.connectWebSocket();
        } else {
            await this.connectREST();
        }
    }

    // ============ WEBSOCKET MODE (Node.js) ============
    async connectWebSocket() {
        let WebSocket;
        try {
            const wsModule = await import("ws");
            WebSocket = wsModule.default;
        } catch (e) {
            console.warn(`[DeltaClient] WebSocket module 'ws' not found (${e.message}). Falling back to REST API polling.`);
            this.useWebSocket = false;
            return this.connectREST();
        }

        const streams = [];
        this.symbols.forEach((symbol) => {
            const s = symbol.toLowerCase();
            streams.push(`${s}@aggTrade`);
            streams.push(`${s}@kline_1m`);
            streams.push(`${s}@markPrice`);
            streams.push(`${s}@ticker`);
        });

        const wsUrl = `${FUTURES_WS_BASE}/${streams.join("/")}`;
        console.log(`[DeltaClient] Connecting WebSocket...`);

        this.ws = new WebSocket(wsUrl);

        this.ws.on("open", () => {
            console.log("[DeltaClient] ✅ WebSocket connected!");
            this.fetchInitialData();
        });

        this.ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(msg);
            } catch (err) {
                console.error("[DeltaClient] Parse error:", err.message);
            }
        });

        this.ws.on("error", (err) => {
            console.error("[DeltaClient] WebSocket error:", err.message);
        });

        this.ws.on("close", (code) => {
            if (this.isExplicitlyDisconnected) return;
            console.log(`[DeltaClient] WebSocket closed (${code}). Reconnecting...`);
            setTimeout(() => this.connectWebSocket(), 5000);
        });

        this.ws.on("ping", () => this.ws.pong());

        this.startBackgroundTasks();
    }

    // ============ REST POLLING MODE (Cloudflare Workers) ============
    async connectREST() {
        console.log("[DeltaClient] Starting REST API polling...");

        try {
            await this.fetchInitialData();
            console.log("[DeltaClient] ✅ Initial data loaded!");

            this.isRunning = true;
            this.startPolling();
        } catch (err) {
            console.error("[DeltaClient] Init error:", err.message);
            setTimeout(() => this.connectREST(), 5000);
        }
    }

    startPolling() {
        // Poll every 2 seconds
        this.pollInterval = setInterval(async () => {
            if (!this.isRunning) return;
            try {
                await Promise.all([
                    this.pollPrices(),
                    this.pollKlines(),
                ]);
                this.triggerCallback();
            } catch (err) {
                console.error("[DeltaClient] Poll error:", err.message);
            }
        }, 2000);

        // Market data every 30s
        setInterval(async () => {
            if (!this.isRunning) return;
            await this.fetchMarketData();
        }, 30000);

        console.log("[DeltaClient] ✅ Polling started");
    }

    async pollPrices() {
        for (const symbol of this.symbols) {
            try {
                const res = await fetch(`${FUTURES_REST_BASE}/fapi/v1/ticker/price?symbol=${symbol}`);
                const data = await res.json();
                const price = parseFloat(data.price);

                this.data[symbol].price = price;
                this.data[symbol].lastUpdate = Date.now();

                if (this.data[symbol].sessionLow === Infinity) this.data[symbol].sessionLow = price;
                if (this.data[symbol].sessionHigh === -Infinity) this.data[symbol].sessionHigh = price;
                if (price < this.data[symbol].sessionLow) this.data[symbol].sessionLow = price;
                if (price > this.data[symbol].sessionHigh) this.data[symbol].sessionHigh = price;

                this.data[symbol].priceHistory.push({ price, time: Date.now() });
                if (this.data[symbol].priceHistory.length > 250) {
                    this.data[symbol].priceHistory.shift();
                }
            } catch (err) {
                console.error(`[DeltaClient] Price poll error ${symbol}:`, err.message);
            }
        }
    }

    async pollKlines() {
        for (const symbol of this.symbols) {
            try {
                const res = await fetch(
                    `${FUTURES_REST_BASE}/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=5`
                );
                const klines = await res.json();
                if (!Array.isArray(klines) || klines.length === 0) continue;

                const data = this.data[symbol];
                const lastKline = klines[klines.length - 1];
                const prevKline = klines[klines.length - 2];

                data.ohlc = {
                    open: parseFloat(lastKline[1]),
                    high: parseFloat(lastKline[2]),
                    low: parseFloat(lastKline[3]),
                    close: parseFloat(lastKline[4]),
                    volume: parseFloat(lastKline[5]),
                    isClosed: Date.now() > lastKline[6],
                    closeTime: lastKline[6],
                };

                // Check for new closed candle
                const lastStoredTime = data.klineHistory["1m"].length > 0
                    ? data.klineHistory["1m"][data.klineHistory["1m"].length - 1].closeTime
                    : 0;

                if (prevKline && prevKline[6] > lastStoredTime) {
                    const closedKline = {
                        open: parseFloat(prevKline[1]),
                        high: parseFloat(prevKline[2]),
                        low: parseFloat(prevKline[3]),
                        close: parseFloat(prevKline[4]),
                        volume: parseFloat(prevKline[5]),
                        isClosed: true,
                        closeTime: prevKline[6],
                    };

                    data.klineHistory["1m"].push(closedKline);
                    if (data.klineHistory["1m"].length > 70) data.klineHistory["1m"].shift();

                    this.updateATR(symbol, closedKline);

                    if (symbol === "BTCUSDT") {
                        const corr = this.calculateCorrelation();
                        this.corrHistory.push(corr);
                        if (this.corrHistory.length > 20) this.corrHistory.shift();
                    }

                    this.updateDeltaPercentileHistory(symbol);
                    this.lastProcessedCandleTime[symbol] = prevKline[6];
                }
            } catch (err) {
                console.error(`[DeltaClient] Kline poll error ${symbol}:`, err.message);
            }
        }
    }

    // ============ MESSAGE HANDLING (WebSocket) ============
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
                this.data[symbol].fundingRate = parseFloat(msg.r) * 100;
                break;
            case "24hrTicker":
                this.data[symbol].change24h = parseFloat(msg.P);
                break;
        }
    }

    handleAggTrade(symbol, trade) {
        const data = this.data[symbol];
        const qty = parseFloat(trade.q);
        const isBuyerMaker = trade.m;

        // Daily reset check
        const today = new Date().getUTCDate();
        if (today !== this.sessionDate) {
            this.symbols.forEach(s => {
                this.data[s].sessionLow = Infinity;
                this.data[s].sessionHigh = -Infinity;
            });
            this.sessionDate = today;
        }

        if (isBuyerMaker) {
            data.sellVolume += qty;
            data.cvd -= qty;
        } else {
            data.buyVolume += qty;
            data.cvd += qty;
        }

        data.price = parseFloat(trade.p);
        data.lastUpdate = Date.now();

        if (data.sessionLow === Infinity) data.sessionLow = data.price;
        if (data.sessionHigh === -Infinity) data.sessionHigh = data.price;
        if (data.price < data.sessionLow) data.sessionLow = data.price;
        if (data.price > data.sessionHigh) data.sessionHigh = data.price;

        const currentMinute = Math.floor(trade.T / 60000);
        if (data.currentMinute !== currentMinute) {
            const delta = data.buyVolume - data.sellVolume;
            data.deltaHistory.push({
                timestamp: data.currentMinute * 60000,
                delta,
                price: data.price,
            });
            if (data.deltaHistory.length > 60) data.deltaHistory.shift();
            data.buyVolume = 0;
            data.sellVolume = 0;
            data.currentMinute = currentMinute;
        }

        if (data.priceHistory.length === 0 ||
            Date.now() - data.priceHistory[data.priceHistory.length - 1].time >= 1000) {
            data.priceHistory.push({ price: data.price, time: Date.now() });
            if (data.priceHistory.length > 250) data.priceHistory.shift();
        }

        this.triggerCallback();
    }

    handleKline(symbol, kline) {
        const data = this.data[symbol];
        const interval = kline.i;
        if (interval !== "1m") return;

        const klineData = {
            open: parseFloat(kline.o),
            high: parseFloat(kline.h),
            low: parseFloat(kline.l),
            close: parseFloat(kline.c),
            volume: parseFloat(kline.v),
            isClosed: kline.x,
            closeTime: kline.T,
        };

        data.ohlc = klineData;

        if (klineData.isClosed) {
            if (klineData.low < data.sessionLow) data.sessionLow = klineData.low;
            if (klineData.high > data.sessionHigh) data.sessionHigh = klineData.high;

            this.updateATR(symbol, klineData);

            data.klineHistory["1m"].push(klineData);
            if (data.klineHistory["1m"].length > 70) data.klineHistory["1m"].shift();

            if (symbol === "BTCUSDT") {
                const corr = this.calculateCorrelation();
                this.corrHistory.push(corr);
                if (this.corrHistory.length > 20) this.corrHistory.shift();
            }

            this.updateDeltaPercentileHistory(symbol);
            this.lastProcessedCandleTime[symbol] = klineData.closeTime;
        }
    }

    // ============ HELPER METHODS ============
    updateATR(symbol, kline) {
        const data = this.data[symbol];
        const history = data.klineHistory["1m"];
        const prevClose = history.length > 0 ? history[history.length - 1].close : kline.open;

        const tr = Math.max(
            kline.high - kline.low,
            Math.abs(kline.high - prevClose),
            Math.abs(kline.low - prevClose)
        );

        data.atrHistory.push(tr);
        if (data.atrHistory.length > 14) data.atrHistory.shift();
        data.atr14 = data.atrHistory.reduce((a, b) => a + b, 0) / data.atrHistory.length;
    }

    triggerCallback() {
        if (this.onData && typeof this.onData === 'function') {
            try {
                this.onData(this.getSnapshot());
            } catch (err) {
                console.error("[DeltaClient] Callback error:", err.message);
            }
        } else {
            // Optional: debounce or limit this log
            // console.debug("[DeltaClient] Skipping callback, onData not yet set");
        }
    }

    startBackgroundTasks() {
        if (!this.oiInterval) {
            this.oiInterval = setInterval(() => this.fetchOpenInterest(), 30000);
        }
        if (!this.heartbeatInterval) {
            this.heartbeatInterval = setInterval(() => {
                console.log(`[Heartbeat] BTC: $${this.data["BTCUSDT"].price?.toFixed(2) || 'N/A'}`);
            }, 300000);
        }
    }

    // ============ FETCH METHODS ============
    async fetchInitialData() {
        console.log("[DeltaClient] Fetching initial data...");
        await Promise.all([
            this.fetchInitialKlines(),
            this.fetchMarketData(),
            this.fetchOpenInterest(),
        ]);

        const corr = this.calculateCorrelation();
        this.corrHistory.push(corr);

        for (const symbol of this.symbols) {
            const klines = this.data[symbol].klineHistory["1m"];
            if (klines.length >= 14) {
                for (let i = 1; i < klines.length; i++) {
                    const tr = Math.max(
                        klines[i].high - klines[i].low,
                        Math.abs(klines[i].high - klines[i - 1].close),
                        Math.abs(klines[i].low - klines[i - 1].close)
                    );
                    this.data[symbol].atrHistory.push(tr);
                }
                this.data[symbol].atrHistory = this.data[symbol].atrHistory.slice(-14);
                this.data[symbol].atr14 = this.data[symbol].atrHistory.reduce((a, b) => a + b, 0) / 14;
            }
        }

        console.log("[DeltaClient] ✅ Initial data ready");
    }

    async fetchInitialKlines() {
        for (const symbol of this.symbols) {
            try {
                const res = await fetch(
                    `${FUTURES_REST_BASE}/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=70`
                );
                const klines = await res.json();

                if (Array.isArray(klines) && klines.length > 0) {
                    this.data[symbol].klineHistory["1m"] = klines.slice(0, -1).map(k => ({
                        open: parseFloat(k[1]),
                        high: parseFloat(k[2]),
                        low: parseFloat(k[3]),
                        close: parseFloat(k[4]),
                        volume: parseFloat(k[5]),
                        isClosed: true,
                        closeTime: k[6],
                    }));

                    this.data[symbol].priceHistory = klines.map(k => ({
                        price: parseFloat(k[4]),
                        time: k[0]
                    }));

                    const last = klines[klines.length - 1];
                    this.data[symbol].price = parseFloat(last[4]);
                    this.data[symbol].ohlc = {
                        open: parseFloat(last[1]),
                        high: parseFloat(last[2]),
                        low: parseFloat(last[3]),
                        close: parseFloat(last[4]),
                        volume: parseFloat(last[5]),
                        isClosed: false,
                        closeTime: last[6],
                    };

                    if (this.data[symbol].klineHistory["1m"].length > 0) {
                        this.lastProcessedCandleTime[symbol] =
                            this.data[symbol].klineHistory["1m"][this.data[symbol].klineHistory["1m"].length - 1].closeTime;
                    }
                }
            } catch (err) {
                console.error(`[DeltaClient] Klines error ${symbol}:`, err.message);
            }
        }
    }

    async fetchMarketData() {
        for (const symbol of this.symbols) {
            try {
                const fRes = await fetch(`${FUTURES_REST_BASE}/fapi/v1/premiumIndex?symbol=${symbol}`);
                const fData = await fRes.json();
                this.data[symbol].fundingRate = parseFloat(fData.lastFundingRate) * 100;

                const tRes = await fetch(`${FUTURES_REST_BASE}/fapi/v1/ticker/24hr?symbol=${symbol}`);
                const tData = await tRes.json();
                this.data[symbol].change24h = parseFloat(tData.priceChangePercent);
            } catch (err) {
                console.error(`[DeltaClient] Market data error ${symbol}:`, err.message);
            }
        }
    }

    async fetchOpenInterest() {
        for (const symbol of this.symbols) {
            try {
                const res = await fetch(`${FUTURES_REST_BASE}/fapi/v1/openInterest?symbol=${symbol}`);
                const data = await res.json();
                this.data[symbol].openInterest = parseFloat(data.openInterest);
            } catch (err) {
                console.error(`[DeltaClient] OI error ${symbol}:`, err.message);
            }
        }
    }

    // ============ CALCULATIONS ============
    calculateCorrelation() {
        const btcKlines = this.data["BTCUSDT"].klineHistory["1m"];
        const dogeKlines = this.data["DOGEUSDT"].klineHistory["1m"];

        if (btcKlines.length < 60 || dogeKlines.length < 60) return 0;

        const btcPrices = btcKlines.slice(-60).map(k => k.close);
        const dogePrices = dogeKlines.slice(-60).map(k => k.close);
        const n = Math.min(btcPrices.length, dogePrices.length);
        if (n < 10) return 0;

        const btcMean = btcPrices.reduce((a, b) => a + b, 0) / n;
        const dogeMean = dogePrices.reduce((a, b) => a + b, 0) / n;

        let num = 0, btcVar = 0, dogeVar = 0;
        for (let i = 0; i < n; i++) {
            const btcDiff = btcPrices[i] - btcMean;
            const dogeDiff = dogePrices[i] - dogeMean;
            num += btcDiff * dogeDiff;
            btcVar += btcDiff * btcDiff;
            dogeVar += dogeDiff * dogeDiff;
        }

        const denom = Math.sqrt(btcVar * dogeVar);
        return denom > 0 ? num / denom : 0;
    }

    getLagData() {
        const btcKlines = this.data["BTCUSDT"].klineHistory["1m"];
        const dogeKlines = this.data["DOGEUSDT"].klineHistory["1m"];

        if (btcKlines.length < 5 || dogeKlines.length < 5) {
            return { btcMove4m: 0, dogeMove4m: 0, lagScore: null };
        }

        const btcNow = btcKlines[btcKlines.length - 1].close;
        const btc4Ago = btcKlines[btcKlines.length - 5].close;
        const dogeNow = dogeKlines[dogeKlines.length - 1].close;
        const doge4Ago = dogeKlines[dogeKlines.length - 5].close;

        const btcMove = ((btcNow - btc4Ago) / btc4Ago) * 100;
        const dogeMove = ((dogeNow - doge4Ago) / doge4Ago) * 100;

        let lagScore = null;
        let lagReason = null;

        if (Math.abs(dogeMove) < 0.02) {
            lagReason = "FLAT";
        } else {
            const sameDir = (dogeMove > 0 && btcMove > 0) || (dogeMove < 0 && btcMove < 0);
            if (sameDir) {
                lagScore = Math.abs(btcMove) / Math.abs(dogeMove);
            } else {
                lagReason = "OPPOSITE";
            }
        }

        return { btcMove4m: btcMove, dogeMove4m: dogeMove, lagScore, lagReason };
    }

    updateDeltaPercentileHistory(symbol) {
        const delta = this.getDeltaSum(symbol, 3);
        this.deltaPercentileHistory[symbol].push(delta);
        if (this.deltaPercentileHistory[symbol].length > 500) {
            this.deltaPercentileHistory[symbol].shift();
        }
        this.deltaPercentileCache[symbol] = this.calculateDeltaPercentile(symbol);
    }

    calculateDeltaPercentile(symbol) {
        const current = this.getDeltaSum(symbol, 3);
        const history = this.deltaPercentileHistory[symbol];
        if (history.length < 50) return 50;
        return (history.filter(d => d < current).length / history.length) * 100;
    }

    getDeltaSum(symbol, candles = 10) {
        return this.data[symbol].deltaHistory.slice(-candles).reduce((s, d) => s + d.delta, 0);
    }

    hasNewCandleClosed(symbol) {
        const klines = this.data[symbol]?.klineHistory?.["1m"];
        if (!klines || klines.length === 0) return false;
        const lastTime = klines[klines.length - 1].closeTime;
        if (lastTime > this.lastProcessedCandleTime[symbol]) {
            return true;
        }
        return false;
    }

    getLastClosedCandle(symbol) {
        const klines = this.data[symbol]?.klineHistory?.["1m"];
        return klines && klines.length > 0 ? klines[klines.length - 1] : null;
    }

    getSnapshot() {
        const dogePrice = this.data["DOGEUSDT"].price;
        const dogeAtr14 = this.data["DOGEUSDT"].atr14;
        const lagData = this.getLagData();

        return {
            btc: {
                ...this.data["BTCUSDT"],
                deltaSum3: this.getDeltaSum("BTCUSDT", 3),
                deltaPercentile: this.deltaPercentileCache["BTCUSDT"] || 50,
            },
            doge: {
                ...this.data["DOGEUSDT"],
                deltaSum3: this.getDeltaSum("DOGEUSDT", 3),
                atrPercent: dogePrice > 0 ? (dogeAtr14 / dogePrice) * 100 : 0,
            },
            correlation: this.corrHistory[this.corrHistory.length - 1] || 0,
            corrHistory: this.corrHistory,
            btcMove4m: lagData.btcMove4m,
            dogeMove4m: lagData.dogeMove4m,
            lagScore: lagData.lagScore,
            lagReason: lagData.lagReason,
            timestamp: Date.now()
        };
    }

    disconnect() {
        this.isRunning = false;
        this.isExplicitlyDisconnected = true;
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.oiInterval) clearInterval(this.oiInterval);
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.ws) this.ws.close();
    }
}

export default DeltaDataClient;