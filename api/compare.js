/**
 * Grok Strategy Engine v5.0
 *
 * FIXED ISSUES:
 * - Correlation: Now uses simple minimum (0.75) instead of paradoxical dip/spike
 * - Lag Score: Added direction check for both BTC and DOGE
 * - Sweep Detection: Now checks current OR previous candle + sweep depth
 * - Time Stop: Added profit condition
 * - Config values aligned with strategy v5.0
 */

import DeltaDataClient from "./binance_delta_client.js";

const STRATEGY_CONFIG = {
    // ============ CORRELATION ============
    CORR_MIN: 0.75,                     // Simple minimum correlation
    CORR_PERIOD: 60,                    // Candles for calculation

    // ============ LAG ENGINE ============
    LAG_WINDOW_MINUTES: 4,
    LAG_MIN_BTC_MOVE: 0.25,             // Minimum BTC move %
    LAG_SCORE_MIN: 2.5,                 // Minimum lag score
    LAG_DOGE_MAX_RATIO: 0.40,           // DOGE must move < 40% of BTC

    // ============ DELTA ============
    // Option A: Percentile-based (your current approach)
    DELTA_LONG_PERCENTILE: 92,
    DELTA_SHORT_PERCENTILE: 8,
    // Option B: Raw values (alternative)
    // BTC_DELTA_MIN: 400000,
    BTC_DELTA_EXIT_FLIP: 500000,

    // ============ VOLUME ============
    BTC_VOLUME_MA_MULTIPLIER: 2.5,

    // ============ SWEEP DETECTION ============
    SWING_LOOKBACK: 20,
    SWEEP_MIN_DEPTH: 0.05,              // Minimum sweep depth %

    // ============ DOGE FILTERS ============
    DOGE_FLAT_MAX_MOVE: 0.25,           // Max body % for flat
    DOGE_FLAT_LOOKBACK: 6,              // Candles to check
    DOGE_ENTRY_MIN_MOVE: 0.25,          // Entry trigger candle body %
    DOGE_ATR_MIN_PERCENT: 0.08,         // ATR as % of price

    // ============ FUNDING ============
    FUNDING_LONG_MAX: 0.05,
    FUNDING_SHORT_MIN: -0.03,

    // ============ EXECUTION ============
    ENTRY_BODY_RATIO: 0.60,             // Optional: body/range ratio
    MAX_SPREAD_PERCENT: 0.08,

    // ============ FVG ============
    FVG_MIN_GAP_PERCENT: 0.04,

    // ============ TAKE PROFIT ============
    TP1_PERCENT: 0.50,
    TP1_RATIO: 0.70,
    TP2_PERCENT: 1.20,

    // ============ STOP LOSS ============
    STOP_LOSS: 0.35,

    // ============ BREAK-EVEN ============
    BE_TRIGGER_PERCENT: 0.40,
    BE_OFFSET_PERCENT: 0.05,

    // ============ CATCH-UP EXIT ============
    DOGE_CATCHUP_RATIO: 0.75,
    CATCHUP_MIN_PROFIT: 0.15,
    CATCHUP_MIN_BTC_MOVE: 0.20,

    // ============ TIME STOP ============
    TIME_STOP_MS: 12 * 60 * 1000,
    TIME_STOP_MIN_PROFIT: 0.25,

    // ============ SESSION FILTERS ============
    SESSION_PAUSE_RANGES: [
        { start: "21:00", end: "23:59" },
        { start: "04:00", end: "05:30" }
    ],
    SESSION_FIRST_5_MIN: true,

    // ============ DAILY LIMITS ============
    MAX_TRADES_PER_DAY: 4,
    MAX_DAILY_LOSS_PERCENT: 2.5,
    MAX_DAILY_PROFIT_PERCENT: 5.0,
    MAX_CONSECUTIVE_LOSSES: 3,
    CONSECUTIVE_LOSS_PAUSE_MS: 2 * 60 * 60 * 1000,

    // ============ POSITION SIZING ============
    RISK_PER_TRADE_PERCENT: 1.0,
    MAX_LEVERAGE: 5,
    MAX_POSITION_USD: 2000,

    // ============ ERROR HANDLING ============
    MAX_LATENCY_MS: 500,
    DATA_STALL_MS: 5000,

    // ============ TAKER FEE ============
    TAKER_FEE: 0.04,
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

        // Risk Management State
        this.dailyPnL = 0;
        this.consecutiveLosses = 0;
        this.pauseUntil = 0;
        this.tradingPaused = false;
        this.accountBalance = 1000;

        this.currentStatus = "INITIALIZING";
        this.btcPreviousPrice = 0;

        console.log("[GrokEngine] v5.0 Initialized");
    }

    async start() {
        console.log("[GrokEngine] Starting...");

        await this.initHistoricalData();

        this.lastEvalTime = 0;

        // Watchdog for data stall
        setInterval(() => {
            if (this.lastEvalTime > 0 && Date.now() - this.lastEvalTime > STRATEGY_CONFIG.DATA_STALL_MS) {
                console.warn(`[GrokEngine] WARNING: No data for ${((Date.now() - this.lastEvalTime) / 1000).toFixed(1)}s`);
            }
        }, 1000);

        this.client.onData = (snapshot) => {
            const now = Date.now();

            if (this.btcPreviousPrice === 0) {
                this.btcPreviousPrice = snapshot.btc.price;
                this.lastEvalTime = now;
                return;
            }

            if (now - this.lastEvalTime >= 8000) {
                this.lastEvalTime = now;
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
        try {
            // BTC 1H EMA21
            const res = await fetch("https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=100");
            const klines = await res.json();
            const closes = klines.map(k => parseFloat(k[4]));
            this.btc1hEMA21 = this.calculateEMA(closes, 21);
            console.log(`[GrokEngine] BTC 1H EMA21: ${this.btc1hEMA21.toFixed(2)}`);

            // BTC 1m Volume MA20
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

    // ============ FIXED: Simple Correlation Check ============
    hasValidCorrelation(snapshot) {
        const current = snapshot.correlation;
        if (typeof current !== 'number' || isNaN(current)) return false;
        return current >= STRATEGY_CONFIG.CORR_MIN;
    }

    // ============ FIXED: Lag Score with Direction Check ============
    checkLagScoreLong(snapshot) {
        const btcMove = snapshot.btcMove4m;
        const dogeMove = snapshot.dogeMove4m;
        const lagScore = snapshot.lagScore;

        if (lagScore === null || lagScore === undefined) return false;

        // BTC must be moving UP significantly
        if (btcMove < STRATEGY_CONFIG.LAG_MIN_BTC_MOVE) return false;

        // DOGE must be moving UP but less than 40% of BTC
        if (dogeMove <= 0) return false;
        if (dogeMove >= btcMove * STRATEGY_CONFIG.LAG_DOGE_MAX_RATIO) return false;

        // Lag score check
        return lagScore >= STRATEGY_CONFIG.LAG_SCORE_MIN;
    }

    checkLagScoreShort(snapshot) {
        const btcMove = snapshot.btcMove4m;
        const dogeMove = snapshot.dogeMove4m;
        const lagScore = snapshot.lagScore;

        if (lagScore === null || lagScore === undefined) return false;

        // BTC must be moving DOWN significantly
        if (btcMove > -STRATEGY_CONFIG.LAG_MIN_BTC_MOVE) return false;

        // DOGE must be moving DOWN but less than 40% of BTC's drop
        if (dogeMove >= 0) return false;
        if (Math.abs(dogeMove) >= Math.abs(btcMove) * STRATEGY_CONFIG.LAG_DOGE_MAX_RATIO) return false;

        // Lag score check (use absolute value for short)
        return Math.abs(lagScore) >= STRATEGY_CONFIG.LAG_SCORE_MIN;
    }

    // ============ FIXED: Sweep Detection with Depth Check ============
    hasLiquiditySweepLong(snapshot) {
        const klines = this.client.data["BTCUSDT"].klineHistory["1m"];
        if (klines.length < 21) return false;

        // Get swing low from previous 20 candles (excluding current)
        const historicalKlines = klines.slice(-21, -1);
        const swingLow = Math.min(...historicalKlines.map(k => k.low));

        const currentCandle = klines[klines.length - 1];
        const previousCandle = klines[klines.length - 2];

        // Check if current OR previous candle swept below swing low
        const currentSwept = currentCandle.low < swingLow;
        const previousSwept = previousCandle.low < swingLow;

        if (!currentSwept && !previousSwept) return false;

        // Determine which candle did the sweep
        const sweepCandle = currentSwept ? currentCandle : previousCandle;

        // Sweep depth check (>= 0.05%)
        const sweepDepth = ((swingLow - sweepCandle.low) / swingLow) * 100;
        if (sweepDepth < STRATEGY_CONFIG.SWEEP_MIN_DEPTH) return false;

        // Reclaim: Current candle must close above swing low
        const reclaimed = currentCandle.close > swingLow;
        if (!reclaimed) return false;

        // Volume check on current candle
        const volumeOk = currentCandle.volume >= this.btcVolumeMA20 * STRATEGY_CONFIG.BTC_VOLUME_MA_MULTIPLIER;
        if (!volumeOk) return false;

        return true;
    }

    hasLiquiditySweepShort(snapshot) {
        const klines = this.client.data["BTCUSDT"].klineHistory["1m"];
        if (klines.length < 21) return false;

        const historicalKlines = klines.slice(-21, -1);
        const swingHigh = Math.max(...historicalKlines.map(k => k.high));

        const currentCandle = klines[klines.length - 1];
        const previousCandle = klines[klines.length - 2];

        const currentSwept = currentCandle.high > swingHigh;
        const previousSwept = previousCandle.high > swingHigh;

        if (!currentSwept && !previousSwept) return false;

        const sweepCandle = currentSwept ? currentCandle : previousCandle;

        // Sweep depth check
        const sweepDepth = ((sweepCandle.high - swingHigh) / swingHigh) * 100;
        if (sweepDepth < STRATEGY_CONFIG.SWEEP_MIN_DEPTH) return false;

        // Rejection: Current candle must close below swing high
        const rejected = currentCandle.close < swingHigh;
        if (!rejected) return false;

        // Volume check
        const volumeOk = currentCandle.volume >= this.btcVolumeMA20 * STRATEGY_CONFIG.BTC_VOLUME_MA_MULTIPLIER;
        if (!volumeOk) return false;

        return true;
    }

    // ============ FVG Detection ============
    detectFVG(side) {
        const klines = this.client.data["BTCUSDT"].klineHistory["1m"];
        if (klines.length < 3) return null;

        const c1 = klines[klines.length - 3]; // Candle[-2] - oldest of 3
        const c3 = klines[klines.length - 1]; // Candle[0] - newest

        if (side === "BUY") {
            // Bullish FVG: Gap UP - c1.high < c3.low
            if (c1.high < c3.low) {
                const gapSize = ((c3.low - c1.high) / c3.close) * 100;
                if (gapSize >= STRATEGY_CONFIG.FVG_MIN_GAP_PERCENT) {
                    return { low: c1.high, high: c3.low };
                }
            }
        } else {
            // Bearish FVG: Gap DOWN - c1.low > c3.high
            if (c1.low > c3.high) {
                const gapSize = ((c1.low - c3.high) / c3.close) * 100;
                if (gapSize >= STRATEGY_CONFIG.FVG_MIN_GAP_PERCENT) {
                    return { low: c3.high, high: c1.low };
                }
            }
        }
        return null;
    }

    // ============ DOGE Flat Check ============
    isDogeFlat() {
        const dogeHistory = this.client.data["DOGEUSDT"].klineHistory["1m"];
        if (dogeHistory.length < STRATEGY_CONFIG.DOGE_FLAT_LOOKBACK) return false;

        const recentCandles = dogeHistory.slice(-STRATEGY_CONFIG.DOGE_FLAT_LOOKBACK);

        for (const k of recentCandles) {
            const bodyPercent = Math.abs(k.close - k.open) / k.open * 100;
            if (bodyPercent >= STRATEGY_CONFIG.DOGE_FLAT_MAX_MOVE) {
                return false; // Found a significant candle
            }
        }
        return true; // All candles are flat
    }

    // ============ Session & Daily Filters ============
    checkSessionFilters() {
        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcMin = now.getUTCMinutes();
        const timeString = `${String(utcHour).padStart(2, '0')}:${String(utcMin).padStart(2, '0')}`;

        for (const range of STRATEGY_CONFIG.SESSION_PAUSE_RANGES) {
            if (timeString >= range.start || timeString <= range.end) {
                // Handle wrap-around (21:00 to 23:59)
                if (range.start > range.end) {
                    if (timeString >= range.start || timeString <= range.end) {
                        return false;
                    }
                } else if (timeString >= range.start && timeString <= range.end) {
                    return false;
                }
            }
        }

        if (STRATEGY_CONFIG.SESSION_FIRST_5_MIN && utcMin < 5) {
            return false;
        }

        return true;
    }

    checkDailyLimits() {
        const today = new Date().getUTCDate();
        if (today !== this.lastTradeResetDate) {
            console.log(`[GrokEngine] New day. Resetting daily stats.`);
            this.tradesTakenToday = 0;
            this.dailyPnL = 0;
            this.consecutiveLosses = 0;
            this.lastTradeResetDate = today;
            this.tradingPaused = false;
            this.pauseUntil = 0;
        }

        // Check if pause expired
        if (this.tradingPaused && this.pauseUntil > 0 && Date.now() > this.pauseUntil) {
            this.pauseUntil = 0;
            this.tradingPaused = false;
            this.consecutiveLosses = 0;
            console.log("[GrokEngine] Resume trading after pause.");
        }

        if (this.tradingPaused) return false;

        if (this.dailyPnL <= -STRATEGY_CONFIG.MAX_DAILY_LOSS_PERCENT) {
            console.log(`[GrokEngine] Daily loss limit hit (${this.dailyPnL.toFixed(2)}%)`);
            this.tradingPaused = true;
            return false;
        }

        if (this.dailyPnL >= STRATEGY_CONFIG.MAX_DAILY_PROFIT_PERCENT) {
            console.log(`[GrokEngine] Daily profit goal hit (${this.dailyPnL.toFixed(2)}%)`);
            this.tradingPaused = true;
            return false;
        }

        if (this.tradesTakenToday >= STRATEGY_CONFIG.MAX_TRADES_PER_DAY) {
            return false;
        }

        return true;
    }

    // ============ Position Sizing ============
    calculatePositionSize(entryPrice, stopLossPrice) {
        const riskAmount = this.accountBalance * (STRATEGY_CONFIG.RISK_PER_TRADE_PERCENT / 100);
        const slDistancePercent = Math.abs(entryPrice - stopLossPrice) / entryPrice * 100;

        if (slDistancePercent === 0) return 0;

        // Position value that risks the correct amount
        const positionValue = riskAmount / (slDistancePercent / 100);

        // Apply leverage
        const leveragedValue = Math.min(
            positionValue * STRATEGY_CONFIG.MAX_LEVERAGE,
            STRATEGY_CONFIG.MAX_POSITION_USD
        );

        // Convert to quantity
        const quantity = Math.floor(leveragedValue / entryPrice);

        return quantity > 0 ? quantity : 0;
    }

    // ============ MAIN EVALUATION ============
    evaluate(snapshot) {
        // 1. Session & Daily Limits
        if (!this.checkSessionFilters()) {
            this.currentStatus = "SESSION_PAUSED";
            return;
        }
        if (!this.checkDailyLimits()) {
            this.currentStatus = "LIMIT_PAUSED";
            return;
        }

        // 2. If trade active, only check exits
        if (this.activeTrade) {
            this.checkExit(snapshot);
            return;
        }

        // 3. ATR Filter
        if (snapshot.doge.atrPercent < STRATEGY_CONFIG.DOGE_ATR_MIN_PERCENT) {
            this.logStatus(snapshot, "LOW_ATR");
            return;
        }

        this.logStatus(snapshot, "SCANNING");

        // 4. Get trend and prepare checks
        const btcTrend = snapshot.btc.price > this.btc1hEMA21 ? "UP" : "DOWN";
        const dogeFlat = this.isDogeFlat();
        const correlationOk = this.hasValidCorrelation(snapshot);

        const doge1m = snapshot.doge.ohlc;

        // ============ EVALUATE LONG ============
        if (btcTrend === "UP") {
            const fvgLevel = this.detectFVG("BUY");

            const longChecks = {
                trend: true,
                sweep: this.hasLiquiditySweepLong(snapshot),
                fvg: fvgLevel !== null,
                delta: snapshot.btc.deltaPercentile >= STRATEGY_CONFIG.DELTA_LONG_PERCENTILE,
                lagScore: this.checkLagScoreLong(snapshot),
                correlation: correlationOk,
                dogeFlat: dogeFlat,
                funding: snapshot.doge.fundingRate <= STRATEGY_CONFIG.FUNDING_LONG_MAX,
                atr: true // Already checked above
            };

            console.log("[LONG Checks]", longChecks);

            if (Object.values(longChecks).every(Boolean)) {
                if (!doge1m.isClosed) return;

                const dogeBody = (doge1m.close - doge1m.open) / doge1m.open * 100;
                const bodySize = Math.abs(doge1m.close - doge1m.open);
                const range = doge1m.high - doge1m.low;
                const bodyRatio = range > 0 ? bodySize / range : 0;
                const isGreen = doge1m.close > doge1m.open;

                if (dogeBody >= STRATEGY_CONFIG.DOGE_ENTRY_MIN_MOVE &&
                    isGreen &&
                    bodyRatio >= STRATEGY_CONFIG.ENTRY_BODY_RATIO) {
                    this.triggerTrade("BUY", snapshot, fvgLevel);
                }
            }
        }

        // ============ EVALUATE SHORT ============
        if (btcTrend === "DOWN") {
            const fvgLevel = this.detectFVG("SELL");

            const shortChecks = {
                trend: true,
                sweep: this.hasLiquiditySweepShort(snapshot),
                fvg: fvgLevel !== null,
                delta: snapshot.btc.deltaPercentile <= STRATEGY_CONFIG.DELTA_SHORT_PERCENTILE,
                lagScore: this.checkLagScoreShort(snapshot),
                correlation: correlationOk,
                dogeFlat: dogeFlat,
                funding: snapshot.doge.fundingRate >= STRATEGY_CONFIG.FUNDING_SHORT_MIN,
                atr: true
            };

            console.log("[SHORT Checks]", shortChecks);

            if (Object.values(shortChecks).every(Boolean)) {
                if (!doge1m.isClosed) return;

                const dogeBody = (doge1m.open - doge1m.close) / doge1m.open * 100;
                const bodySize = Math.abs(doge1m.open - doge1m.close);
                const range = doge1m.high - doge1m.low;
                const bodyRatio = range > 0 ? bodySize / range : 0;
                const isRed = doge1m.close < doge1m.open;

                if (dogeBody >= STRATEGY_CONFIG.DOGE_ENTRY_MIN_MOVE &&
                    isRed &&
                    bodyRatio >= STRATEGY_CONFIG.ENTRY_BODY_RATIO) {
                    this.triggerTrade("SELL", snapshot, fvgLevel);
                }
            }
        }
    }

    // ============ TRIGGER TRADE ============
    triggerTrade(side, snapshot, fvgLevel) {
        console.log(`[GrokEngine] Triggering ${side} trade`);

        const entry = snapshot.doge.price;
        const slPercent = STRATEGY_CONFIG.STOP_LOSS / 100;
        const sl = side === "BUY"
            ? entry * (1 - slPercent)
            : entry * (1 + slPercent);
        const tp1 = side === "BUY"
            ? entry * (1 + STRATEGY_CONFIG.TP1_PERCENT / 100)
            : entry * (1 - STRATEGY_CONFIG.TP1_PERCENT / 100);
        const tp2 = side === "BUY"
            ? entry * (1 + STRATEGY_CONFIG.TP2_PERCENT / 100)
            : entry * (1 - STRATEGY_CONFIG.TP2_PERCENT / 100);

        const quantity = this.calculatePositionSize(entry, sl);

        if (quantity <= 0) {
            console.log("[GrokEngine] Invalid quantity. Skipping trade.");
            return;
        }

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
            quantity: quantity
        };

        this.tradesTakenToday++;

        const order = {
            decision: side,
            reason: `Grok v5.0 ${side}: Lag=${snapshot.lagScore?.toFixed(2)}, Corr=${snapshot.correlation?.toFixed(3)}`,
            orderType: "MARKET",
            quantity: quantity,
            leverage: STRATEGY_CONFIG.MAX_LEVERAGE,
            entry: entry,
            stopLoss: sl,
            takeProfit: tp1
        };

        console.log("\n🚀 [GrokEngine] TRADE SIGNAL:");
        console.log(JSON.stringify(order, null, 2));

        if (this.onSignal) this.onSignal(order);
    }

    // ============ CHECK EXITS (With Priority Order) ============
    checkExit(snapshot) {
        const trade = this.activeTrade;
        const price = snapshot.doge.price;
        const now = Date.now();
        const holdingTime = now - trade.startTime;

        // Calculate current profit
        const currentProfit = trade.side === "BUY"
            ? (price - trade.entry) / trade.entry * 100
            : (trade.entry - price) / trade.entry * 100;

        // PRIORITY 1: Stop Loss
        if ((trade.side === "BUY" && price <= trade.sl) ||
            (trade.side === "SELL" && price >= trade.sl)) {
            this.exitTrade("STOP_LOSS", price, currentProfit);
            return;
        }

        // PRIORITY 2: Take Profit 2 (after TP1)
        if (trade.tp1Hit) {
            if ((trade.side === "BUY" && price >= trade.tp2) ||
                (trade.side === "SELL" && price <= trade.tp2)) {
                this.exitTrade("TAKE_PROFIT_2", price, currentProfit);
                return;
            }
        }

        // PRIORITY 3: Take Profit 1
        if (!trade.tp1Hit) {
            if ((trade.side === "BUY" && price >= trade.tp1) ||
                (trade.side === "SELL" && price <= trade.tp1)) {
                trade.tp1Hit = true;
                // Move SL to break-even
                trade.sl = trade.side === "BUY"
                    ? trade.entry * (1 + STRATEGY_CONFIG.BE_OFFSET_PERCENT / 100)
                    : trade.entry * (1 - STRATEGY_CONFIG.BE_OFFSET_PERCENT / 100);
                console.log(`[GrokEngine] TP1 HIT! Moving SL to BE: ${trade.sl.toFixed(5)}`);

                // Emit partial close signal if needed
                if (this.onSignal) {
                    this.onSignal({
                        decision: trade.side === "BUY" ? "SELL" : "BUY",
                        reason: "PARTIAL_EXIT: TP1",
                        orderType: "MARKET",
                        quantity: Math.floor(trade.quantity * STRATEGY_CONFIG.TP1_RATIO),
                        price: price,
                        isPartialExit: true
                    });
                }
            }
        }

        // PRIORITY 4: Delta Flip (only if in profit)
        if (currentProfit > 0) {
            const deltaFlipped = trade.side === "BUY"
                ? snapshot.btc.deltaSum3 <= -STRATEGY_CONFIG.BTC_DELTA_EXIT_FLIP
                : snapshot.btc.deltaSum3 >= STRATEGY_CONFIG.BTC_DELTA_EXIT_FLIP;
            if (deltaFlipped) {
                this.exitTrade("DELTA_FLIP", price, currentProfit);
                return;
            }
        }

        // PRIORITY 5: DOGE Catch-up (only if minimum profit reached)
        if (currentProfit >= STRATEGY_CONFIG.CATCHUP_MIN_PROFIT) {
            const btcMove = (snapshot.btc.price - trade.btcEntryPrice) / trade.btcEntryPrice * 100;

            if (trade.side === "BUY" && btcMove >= STRATEGY_CONFIG.CATCHUP_MIN_BTC_MOVE) {
                const dogeMove = (price - trade.entry) / trade.entry * 100;
                if (dogeMove >= btcMove * STRATEGY_CONFIG.DOGE_CATCHUP_RATIO) {
                    this.exitTrade("DOGE_CATCHUP", price, currentProfit);
                    return;
                }
            }

            if (trade.side === "SELL" && btcMove <= -STRATEGY_CONFIG.CATCHUP_MIN_BTC_MOVE) {
                const dogeMove = (trade.entry - price) / trade.entry * 100;
                if (dogeMove >= Math.abs(btcMove) * STRATEGY_CONFIG.DOGE_CATCHUP_RATIO) {
                    this.exitTrade("DOGE_CATCHUP", price, currentProfit);
                    return;
                }
            }
        }

        // PRIORITY 6: FVG Break (only if in profit)
        if (trade.fvgLevel && currentProfit > 0) {
            const btcClose = snapshot.btc.ohlc.close;
            const fvgBroken = trade.side === "BUY"
                ? btcClose < trade.fvgLevel.low
                : btcClose > trade.fvgLevel.high;
            if (fvgBroken) {
                this.exitTrade("FVG_BREAK", price, currentProfit);
                return;
            }
        }

        // PRIORITY 7: Time Stop (only if profit below threshold)
        if (holdingTime >= STRATEGY_CONFIG.TIME_STOP_MS) {
            if (currentProfit < STRATEGY_CONFIG.TIME_STOP_MIN_PROFIT) {
                this.exitTrade("TIME_STOP", price, currentProfit);
                return;
            }
        }

        // PRIORITY 8: Break-even adjustment
        if (!trade.beMoved && currentProfit >= STRATEGY_CONFIG.BE_TRIGGER_PERCENT) {
            trade.sl = trade.side === "BUY"
                ? trade.entry * (1 + STRATEGY_CONFIG.BE_OFFSET_PERCENT / 100)
                : trade.entry * (1 - STRATEGY_CONFIG.BE_OFFSET_PERCENT / 100);
            trade.beMoved = true;
            console.log(`[GrokEngine] Moving SL to BE: ${trade.sl.toFixed(5)}`);
        }
    }

    // ============ EXIT TRADE ============
    exitTrade(reason, price, pnlPercent) {
        console.log(`[GrokEngine] EXIT: ${reason} at ${price} (${pnlPercent?.toFixed(2)}%)`);

        // Update daily stats
        if (typeof pnlPercent === 'number') {
            this.dailyPnL += pnlPercent;

            if (pnlPercent < 0) {
                this.consecutiveLosses++;
                if (this.consecutiveLosses >= STRATEGY_CONFIG.MAX_CONSECUTIVE_LOSSES) {
                    console.log(`[GrokEngine] ${this.consecutiveLosses} consecutive losses. Pausing.`);
                    this.tradingPaused = true;
                    this.pauseUntil = Date.now() + STRATEGY_CONFIG.CONSECUTIVE_LOSS_PAUSE_MS;
                }
            } else {
                this.consecutiveLosses = 0;
            }
        }

        if (this.onSignal) {
            this.onSignal({
                decision: this.activeTrade.side === "BUY" ? "SELL" : "BUY",
                reason: `EXIT: ${reason}`,
                orderType: "MARKET",
                price: price,
                pnlPercent: pnlPercent,
                isExit: true
            });
        }

        this.activeTrade = null;
    }

    // ============ LOGGING ============
    logStatus(snapshot, state) {
        const now = Date.now();

        const btcPrice = snapshot.btc.price?.toFixed(1) || "N/A";
        const dogePrice = snapshot.doge.price?.toFixed(5) || "N/A";
        const corr = snapshot.correlation?.toFixed(4) || "N/A";
        const lag = snapshot.lagScore?.toFixed(2) || "N/A";

        this.currentStatus = `${state} | BTC: $${btcPrice} | DOGE: $${dogePrice} | Corr: ${corr} | Lag: ${lag} | Trades: ${this.tradesTakenToday}/${STRATEGY_CONFIG.MAX_TRADES_PER_DAY}`;

        if (now - this.lastStatusLog < 30000) return;

        console.log(`[Status] ${new Date().toISOString()} | ${this.currentStatus}`);
        this.lastStatusLog = now;
    }
}

// Test runner
if (import.meta.url === `file://${process.argv[1]}`) {
    const engine = new GrokStrategyEngine();
    engine.start();
}