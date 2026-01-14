/**
 * Grok Strategy Engine v4.0
 *
 * Implements the exact rules from grok_strategy.md:
 * - BTC/DOGE Correlation + Lag Engine
 * - Multi-Timeframe Matrix (1H, 1M)
 * - Precise Entry Triggers (Liquidity sweeps, Delta explosions)
 * - Exit Strategy (The Reaper 2.0)
 */

import DeltaDataClient from "./binance_delta_client.js";

const STRATEGY_CONFIG = {
    // Correlation thresholds
    CORR_DIP_THRESHOLD: 0.865,
    CORR_SPIKE_THRESHOLD: 0.938,
    CORR_LOOKBACK: 9, // candles

    // Lag Score thresholds
    LAG_LONG_MIN: 2.65,
    LAG_SHORT_MAX: 0.37,
    LAG_WINDOW_MINUTES: 4, // Explicitly set to 4 minutes

    // BTC Delta thresholds
    BTC_DELTA_EXPLOSION: 580000, // last 3 candles sum
    BTC_DELTA_EXIT_FLIP: 720000,

    // Volume thresholds
    BTC_VOLUME_MA_MULTIPLIER: 3.4,

    // DOGE specific
    DOGE_FLAT_MAX_MOVE: 0.26, // Tightened from 0.28
    DOGE_ENTRY_MIN_MOVE: 0.31, // 1m candle min % to enter
    DOGE_ATR_MIN: 0.00075,

    // Funding
    FUNDING_LONG_MAX: 0.038,
    FUNDING_SHORT_MIN: -0.008,

    // Risk
    BE_TRIGGER_PERCENT: 0.26, // Move SL to BE at +0.26%
    STOP_LOSS: 0.29,
    TP1_PERCENT: 0.44,
    TP1_RATIO: 0.78, // close 78%
    TP2_PERCENT: 1.18,
    TIME_STOP_MS: 9.5 * 60 * 1000, // 9m 30s
    DOGE_CATCHUP_RATIO: 0.79, // Exit if DOGE catches up 79% of BTC move
    MAX_TRADES_PER_DAY: 5, // Default limit
    TAKER_FEE: 0.04 // CoinDCX taker fee %
};

export class GrokStrategyEngine {
    constructor() {
        this.client = new DeltaDataClient(["BTCUSDT", "DOGEUSDT"]);
        this.corrHistory = [];
        this.activeTrade = null;
        this.btc1hEMA21 = null;
        this.btcVolumeMA20 = 0;
        this.lastStatusLog = 0;

        // Daily limit tracking
        this.tradesTakenToday = 0;
        this.lastTradeResetDate = new Date().getUTCDate();

        this.currentStatus = "INITIALIZING";

        // Track previous price for sweep detection (crossing logic)
        this.btcPreviousPrice = 0;
        console.log("[GrokEngine] BTC Previous Price:", this.btcPreviousPrice);
    }

    async start() {
        console.log("[GrokEngine] Initializing...");

        // Fetch historical data for EMA and Volume MA
        await this.initHistoricalData();

        this.lastEvalTime = 0;
        this.client.onData = (snapshot) => {
            const now = Date.now();

            // Initialize previous price on first data
            if (this.btcPreviousPrice === 0) {
                this.btcPreviousPrice = snapshot.btc.price;
                this.lastEvalTime = now;
                return;
            }

            // Run analysis every 8 seconds
            if (now - this.lastEvalTime >= 8000) {
                this.lastEvalTime = now; // Update time FIRST to prevent retry loops if evaluate throws
                try {
                    this.evaluate(snapshot);
                    this.btcPreviousPrice = snapshot.btc.price;
                } catch (err) {
                    console.error("[GrokEngine] Error in evaluate:", err);
                }
            }
        };

        this.client.connect();
    }

    async initHistoricalData() {
        // Fetch BTC 1H klines for EMA21
        try {
            const res = await fetch("https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=100");
            const klines = await res.json();
            const closes = klines.map(k => parseFloat(k[4]));
            this.btc1hEMA21 = this.calculateEMA(closes, 21);
            console.log(`[GrokEngine] BTC 1H EMA21: ${this.btc1hEMA21.toFixed(2)}`);

            // Fetch BTC 1m klines for Volume MA20
            const res1m = await fetch("https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=21");
            const klines1m = await res1m.json();
            const volumes = klines1m.slice(0, 20).map(k => parseFloat(k[5]));
            this.btcVolumeMA20 = volumes.reduce((a, b) => a + b, 0) / 20;
            console.log(`[GrokEngine] BTC 1m Vol MA20: ${this.btcVolumeMA20.toFixed(2)}`);
        } catch (e) {
            console.error("[GrokEngine] Error fetching historical data:", e);
        }
    }

    calculateEMA(data, period) {
        const k = 2 / (period + 1);
        let ema = data[0];
        for (let i = 1; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
        }
        return ema;
    }

    updateCorrHistory(corr) {
        // No longer needed as client provides corrHistory
    }

    hasCorrSpike(snapshot) {
        const history = snapshot.corrHistory || [];
        if (history.length < STRATEGY_CONFIG.CORR_LOOKBACK) return false;

        // Check last 9 candles
        const h = history.slice(-STRATEGY_CONFIG.CORR_LOOKBACK);
        const minInPeriod = Math.min(...h);
        const current = h[h.length - 1];

        // Strict check: Min <= 0.865 AND Current >= 0.938
        return minInPeriod <= STRATEGY_CONFIG.CORR_DIP_THRESHOLD && current >= STRATEGY_CONFIG.CORR_SPIKE_THRESHOLD;
    }

    // Correct Sweep Logic: Sweep the actual swing low of last 12–20 candles
    hasLiquiditySweepLong(snapshot) {
        const klines = this.client.data["BTCUSDT"].klineHistory["1m"];

        if (klines.length < 20) return false;

        const lows = klines.slice(-20, -1).map(k => k.low);
        const swingLow = Math.min(...lows);
        console.log("[GrokEngine] Swing Low:", snapshot.btc.price, "<", swingLow, "&&", this.btcPreviousPrice, ">", swingLow);

        // Price must dip below swing low and previous price must be above it (crossing down)
        // OR just currently below it? The requirement says: "return btc.price < swingLow && btc.pricePrevious > swingLow"
        // This implies a fresh cross.
        return snapshot.btc.price < swingLow && this.btcPreviousPrice > swingLow;
    }

    hasLiquiditySweepShort(snapshot) {
        const klines = this.client.data["BTCUSDT"].klineHistory["1m"];
        if (klines.length < 20) return false;

        const highs = klines.slice(-20, -1).map(k => k.high);
        const swingHigh = Math.max(...highs);

        return snapshot.btc.price > swingHigh && this.btcPreviousPrice < swingHigh;
    }

    // Correct FVG Detection
    detectFVG(side) {
        const klines = this.client.data["BTCUSDT"].klineHistory["1m"];
        if (klines.length < 3) return null;
        const [c1, c2, c3] = klines.slice(-3); // c1 = oldest

        if (side === "BUY") {
            return c1.low > c3.high ? c1.low : null; // Bullish FVG
        } else {
            return c1.high < c3.low ? c1.high : null; // Bearish FVG
        }
    }

    // 3-Minute Delta Confirmation
    is3mCVDConfirming(side) {
        const cvdHistory = this.client.get3mCVDHistory();
        if (cvdHistory.length < 3) return false;

        const last3 = cvdHistory.slice(-3);
        if (side === "BUY") {
            return last3[2] > last3[1] && last3[1] > last3[0];
        } else {
            return last3[2] < last3[1] && last3[1] < last3[0];
        }
    }

    // FINAL CONFLUENCE FILTER – THE 1% EDGE
    isBTCPreCompressed() {
        const klines = this.client.data["BTCUSDT"].klineHistory["1m"].slice(-15, -3); // before the explosion
        if (klines.length < 12) return false;

        const ranges = klines.map(k => (k.high - k.low) / k.low);
        const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;

        // BTC must have been in extreme compression before the sweep
        return avgRange < 0.00038; // ~0.038% average range = coiled spring
    }

    evaluate(snapshot) {
        // 1. Reset daily limit if it's a new day (UTC)
        const today = new Date().getUTCDate();
        if (this.lastTradeResetDate !== today) {
            console.log(`[GrokEngine] New day detected. Resetting daily trade count.`);
            this.tradesTakenToday = 0;
            this.lastTradeResetDate = today;
        }

        // 2. If trade is active, ONLY check for exits
        if (this.activeTrade) {
            console.log("[GrokEngine] Trade is active. Checking for exits.");
            this.checkExit(snapshot);
            return; // Skip entry analysis while in a trade
        }

        // 3. Check daily limit
        if (this.tradesTakenToday >= STRATEGY_CONFIG.MAX_TRADES_PER_DAY) {
            return; // Limit reached
        }


        // // // 4. Filter: ATR(14)
        // if (snapshot.doge.atr14 < STRATEGY_CONFIG.DOGE_ATR_MIN) {
        //     console.log("[GrokEngine] DOGE ATR too low. Skipping trade.", snapshot.doge.atr14, "<", STRATEGY_CONFIG.DOGE_ATR_MIN);
        //     this.logStatus(snapshot, "LOW_ATR");
        //     return;
        // }

        // 5. BTC 1m Sweep-and-Reclaim Detection
        const btc = snapshot.btc;
        const btc1m = btc.ohlc;
        const doge1m = snapshot.doge.ohlc;
        this.logStatus(snapshot, "ACTIVE");

        // Update sweep state
        if (this.hasLiquiditySweepLong(snapshot)) {
            btc.sweepOccurred = true;
            btc.sweepPrice = btc.price; // Store where sweep happened
        }
        if (this.hasLiquiditySweepShort(snapshot)) {
            btc.shortSweepOccurred = true;
            btc.shortSweepPrice = btc.price;
        }

        // Reclaim: Price back above last candle's low + High Volume
        // Note: The original logic for reclaim was "btc.price > btc.lastLow".
        // With the new sweep logic (swing low), a reclaim would be price > swingLow.
        // However, the prompt didn't explicitly change the Reclaim logic, only the Sweep logic.
        // But "true sweep" implies we are looking for the liquidity grab.
        // Let's keep the reclaim logic simple: if sweep occurred, and we are now bullish (green candle or price moving up), that's good.
        // Actually, the prompt says: "Correct → Must sweep the actual swing low... return btc.price < swingLow && btc.pricePrevious > swingLow; // true sweep"
        // This just detects the sweep event. We still need a trigger to enter.

        const btcHighVol = btc1m.volume >= this.btcVolumeMA20 * STRATEGY_CONFIG.BTC_VOLUME_MA_MULTIPLIER;

        // 3. DOGE Dead Flat Check (Last 9 candles)
        const dogeHistory = this.client.data["DOGEUSDT"].klineHistory["1m"];
        const dogeIsDeadFlat = dogeHistory.length >= 9 && !dogeHistory.slice(-9).some(k => {
            const move = Math.abs(k.close - k.open) / k.open * 100;
            return move >= STRATEGY_CONFIG.DOGE_FLAT_MAX_MOVE;
        });

        // 4. Trend Filter (1H BTC EMA21)
        const btcTrend = snapshot.btc.price > this.btc1hEMA21 ? "UP" : "DOWN";
        console.log("BTC Trend:", btcTrend);

        // 3. Evaluate LONG
        if (btcTrend === "UP") {
            const fvgLevel = this.detectFVG("BUY");
            const longChecks = {
                btcTrend: btcTrend === "UP",
                btcSweep: btc.sweepOccurred, // Just need a sweep to have happened recently? Or specifically now? Assuming state is kept.
                btcFvg: fvgLevel !== null,
                btcDelta: snapshot.btc.deltaSum3 >= STRATEGY_CONFIG.BTC_DELTA_EXPLOSION,
                lagScore: snapshot.lagScore >= STRATEGY_CONFIG.LAG_LONG_MIN,
                corrSpike: this.hasCorrSpike(snapshot),
                dogeFlat: dogeIsDeadFlat,
                funding: snapshot.doge.fundingRate <= STRATEGY_CONFIG.FUNDING_LONG_MAX,
                btcVol: btcHighVol,
                deltaConfirm: this.is3mCVDConfirming("BUY"),
                compression: this.isBTCPreCompressed()
            };
            // console.log("Long Checks:", longChecks);

            if (Object.values(longChecks).every(Boolean)) {
                // Wait for CLOSED DOGE 1m candle >= 0.31%
                if (!doge1m.isClosed) return;
                const dogeMove = (doge1m.close - doge1m.open) / doge1m.open * 100;
                if (dogeMove >= STRATEGY_CONFIG.DOGE_ENTRY_MIN_MOVE) {
                    this.triggerTrade("BUY", snapshot, fvgLevel);
                }
            }
        }

        // 4. Evaluate SHORT
        if (btcTrend === "DOWN") {
            const fvgLevel = this.detectFVG("SELL");
            const shortChecks = {
                btcTrend: btcTrend === "DOWN",
                btcSweep: btc.shortSweepOccurred,
                btcFvg: fvgLevel !== null,
                btcDelta: snapshot.btc.deltaSum3 <= -STRATEGY_CONFIG.BTC_DELTA_EXPLOSION,
                lagScore: snapshot.lagScore <= STRATEGY_CONFIG.LAG_SHORT_MAX && snapshot.lagScore > 0,
                corrSpike: this.hasCorrSpike(snapshot),
                dogePrice: (snapshot.doge.price - snapshot.doge.sessionLow) / snapshot.doge.sessionLow * 100 >= 0.26, // This seems to be a specific condition for short? "dogePrice"
                // The prompt didn't change this, but "DOGE Dead Flat" is usually for both?
                // Original code had `dogePrice: ... >= 0.26`. Let's keep it if not asked to change.
                // Wait, "Fix DOGE Dead Flat Check" implies it's used.
                // In the original code, `dogeFlat` was used in LONG, but `dogePrice` (move from low) was used in SHORT.
                // I will stick to the requested changes.
                funding: snapshot.doge.fundingRate >= STRATEGY_CONFIG.FUNDING_SHORT_MIN,
                btcVol: btcHighVol,
                deltaConfirm: this.is3mCVDConfirming("SELL"),
                compression: this.isBTCPreCompressed()
            };
            // console.log("Short Checks:", shortChecks);

            if (Object.values(shortChecks).every(Boolean)) {
                // Wait for CLOSED DOGE 1m red candle >= 0.31%
                if (!doge1m.isClosed) return;
                const dogeMove = (doge1m.open - doge1m.close) / doge1m.open * 100;
                if (dogeMove >= STRATEGY_CONFIG.DOGE_ENTRY_MIN_MOVE) {
                    this.triggerTrade("SELL", snapshot, fvgLevel);
                }
            }
        }
    }

    triggerTrade(side, snapshot, fvgLevel) {
        console.log("[GrokEngine] Triggering trade for side:", side);
        const entry = snapshot.doge.price;
        const sl = side === "BUY" ? entry * (1 - STRATEGY_CONFIG.STOP_LOSS / 100) : entry * (1 + STRATEGY_CONFIG.STOP_LOSS / 100);
        const tp1 = side === "BUY" ? entry * (1 + STRATEGY_CONFIG.TP1_PERCENT / 100) : entry * (1 - STRATEGY_CONFIG.TP1_PERCENT / 100);
        const tp2 = side === "BUY" ? entry * (1 + STRATEGY_CONFIG.TP2_PERCENT / 100) : entry * (1 - STRATEGY_CONFIG.TP2_PERCENT / 100);

        this.activeTrade = {
            side,
            entry,
            sl,
            tp1,
            tp2,
            tp1Hit: false,
            beMoved: false,
            startTime: Date.now(),
            btcEntryPrice: snapshot.btc.price,
            fvgLevel: fvgLevel,
        };

        this.tradesTakenToday++;

        // Reset sweep state after trade
        snapshot.btc.sweepOccurred = false;
        snapshot.btc.shortSweepOccurred = false;

        const order = {
            decision: side,
            reason: `Grok v4.0 ${side} Triggered: Corr Spike + Lag ${snapshot.lagScore.toFixed(2)} + BTC Delta Explosion`,
            orderType: "MARKET",
            quantity: 1000, // Placeholder, should be calculated
            leverage: 5,
            entry,
            stopLoss: sl,
            takeProfit: tp1
        };

        console.log("\n🚀 [GrokEngine] TRADE SIGNAL:");
        console.log(JSON.stringify(order, null, 2));

        // In a real runner, this would emit an event or call CoinDCX
        if (this.onSignal) this.onSignal(order);
    }

    checkExit(snapshot) {
        const trade = this.activeTrade;
        const price = snapshot.doge.price;
        const now = Date.now();

        // 1. Hard SL
        if ((trade.side === "BUY" && price <= trade.sl) || (trade.side === "SELL" && price >= trade.sl)) {
            this.exitTrade("STOP_LOSS", price);
            return;
        }

        // 2. Break-even Trigger (+0.26%) - Move SL to entry + fees
        const currentProfit = trade.side === "BUY" ? (price - trade.entry) / trade.entry * 100 : (trade.entry - price) / trade.entry * 100;
        if (!trade.beMoved && currentProfit >= STRATEGY_CONFIG.BE_TRIGGER_PERCENT) {
            const fee = STRATEGY_CONFIG.TAKER_FEE / 100;
            trade.sl = trade.side === "BUY" ? trade.entry * (1 + fee) : trade.entry * (1 - fee);
            trade.beMoved = true;
            console.log(`[GrokEngine] Profit reached +0.26%. Moving SL to Break-even + fees (${trade.sl.toFixed(5)}).`);
        }

        // 3. TP1
        if (!trade.tp1Hit) {
            if ((trade.side === "BUY" && price >= trade.tp1) || (trade.side === "SELL" && price <= trade.tp1)) {
                trade.tp1Hit = true;
                console.log(`[GrokEngine] TP1 HIT! Closing ${STRATEGY_CONFIG.TP1_RATIO * 100}%`);
            }
        } else {
            // 4. TP2
            if ((trade.side === "BUY" && price >= trade.tp2) || (trade.side === "SELL" && price <= trade.tp2)) {
                this.exitTrade("TAKE_PROFIT_2", price);
                return;
            }
        }

        // 5. DOGE Catch-up Exit (≥ 79% of BTC's move)
        const btcMove = (snapshot.btc.price - trade.btcEntryPrice) / trade.btcEntryPrice * 100;
        const dogeMove = (price - trade.entry) / trade.entry * 100;
        if (trade.side === "BUY" && btcMove > 0 && dogeMove >= btcMove * STRATEGY_CONFIG.DOGE_CATCHUP_RATIO) {
            this.exitTrade("DOGE_CATCHUP", price);
            return;
        }

        // 6. Time Stop (9m 30s)
        if (now - trade.startTime >= STRATEGY_CONFIG.TIME_STOP_MS) {
            this.exitTrade("TIME_STOP", price);
            return;
        }

        // 7. BTC Delta Flip
        const btcDeltaFlip = trade.side === "BUY" ? snapshot.btc.deltaSum3 <= -STRATEGY_CONFIG.BTC_DELTA_EXIT_FLIP : snapshot.btc.deltaSum3 >= STRATEGY_CONFIG.BTC_DELTA_EXIT_FLIP;
        if (btcDeltaFlip) {
            this.exitTrade("BTC_DELTA_FLIP", price);
            return;
        }

        // 8. FVG Break Exit
        if (trade.fvgLevel) {
            const fvgBroken = trade.side === "BUY" ? snapshot.btc.price < trade.fvgLevel : snapshot.btc.price > trade.fvgLevel;
            if (fvgBroken) {
                this.exitTrade("FVG_BREAK", price);
                return;
            }
        }
    }

    getFVGLevel(symbol, side) {
        // Deprecated, using detectFVG
        return this.detectFVG(side);
    }

    exitTrade(reason, price) {
        console.log(`[GrokEngine] EXIT: ${reason} at ${price}`);

        if (this.onSignal) {
            this.onSignal({
                decision: this.activeTrade.side === "BUY" ? "SELL" : "BUY", // Opposite to close
                reason: `EXIT: ${reason}`,
                orderType: "MARKET",
                price: price,
                isExit: true
            });
        }

        this.activeTrade = null;
    }

    logStatus(snapshot, state) {
        const now = Date.now();

        // Always update current status for UI, even if console log is throttled
        const btcPrice = snapshot.btc.price.toFixed(1);
        const dogePrice = snapshot.doge.price.toFixed(5);
        const corr = snapshot.correlation.toFixed(4);
        const lag = snapshot.lagScore.toFixed(2);
        const trades = this.tradesTakenToday;

        this.currentStatus = `State: ${state} | BTC: $${btcPrice} | DOGE: $${dogePrice} | Corr: ${corr} | Lag: ${lag}`;

        if (now - this.lastStatusLog < 30000) return; // Log every 30s

        console.log(`[Status] ${new Date().toLocaleTimeString()} | ${this.currentStatus}`);
        this.lastStatusLog = now;
    }
}

// Test runner
if (import.meta.url === `file://${process.argv[1]}`) {
    const engine = new GrokStrategyEngine();
    engine.start();
}
