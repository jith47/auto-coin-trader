/**
 * Grok Strategy Engine v5.1
 * 
 * FIXES:
 * - Session filter logic corrected
 * - connect() properly awaited
 * - New candle detection for REST polling
 * - Null safety with optional chaining
 */

import DeltaDataClient from "./binance_delta_client.js";

const STRATEGY_CONFIG = {
    CORR_MIN: 0.75,
    LAG_MIN_BTC_MOVE: 0.25,
    LAG_SCORE_MIN: 2.5,
    LAG_DOGE_MAX_RATIO: 0.40,
    DELTA_LONG_PERCENTILE: 92,
    DELTA_SHORT_PERCENTILE: 8,
    BTC_DELTA_EXIT_FLIP: 500000,
    BTC_VOLUME_MA_MULTIPLIER: 2.5,
    SWING_LOOKBACK: 20,
    SWEEP_MIN_DEPTH: 0.05,
    DOGE_FLAT_MAX_MOVE: 0.25,
    DOGE_FLAT_LOOKBACK: 6,
    DOGE_ENTRY_MIN_MOVE: 0.25,
    DOGE_ATR_MIN_PERCENT: 0.08,
    FUNDING_LONG_MAX: 0.05,
    FUNDING_SHORT_MIN: -0.03,
    ENTRY_BODY_RATIO: 0.60,
    FVG_MIN_GAP_PERCENT: 0.04,
    TP1_PERCENT: 0.50,
    TP1_RATIO: 0.70,
    TP2_PERCENT: 1.20,
    STOP_LOSS: 0.35,
    BE_TRIGGER_PERCENT: 0.40,
    BE_OFFSET_PERCENT: 0.05,
    DOGE_CATCHUP_RATIO: 0.75,
    CATCHUP_MIN_PROFIT: 0.15,
    CATCHUP_MIN_BTC_MOVE: 0.20,
    TIME_STOP_MS: 12 * 60 * 1000,
    TIME_STOP_MIN_PROFIT: 0.25,
    SESSION_PAUSE_RANGES: [],
    SESSION_FIRST_5_MIN: false,
    MAX_TRADES_PER_DAY: 4,
    MAX_DAILY_LOSS_PERCENT: 2.5,
    MAX_DAILY_PROFIT_PERCENT: 5.0,
    MAX_CONSECUTIVE_LOSSES: 3,
    CONSECUTIVE_LOSS_PAUSE_MS: 2 * 60 * 60 * 1000,
    RISK_PER_TRADE_PERCENT: 1.0,
    MAX_LEVERAGE: 5,
    MAX_POSITION_USD: 2000,
    EVAL_INTERVAL_MS: 8000,
};

export class GrokStrategyEngine {
    constructor() {
        this.client = new DeltaDataClient(["BTCUSDT", "DOGEUSDT"]);
        this.activeTrade = null;
        this.btc1hEMA21 = null;
        this.btcVolumeMA20 = 0;
        this.lastStatusLog = 0;
        this.lastEvalTime = 0;

        this.tradesTakenToday = 0;
        this.lastTradeResetDate = new Date().getUTCDate();
        this.dailyPnL = 0;
        this.consecutiveLosses = 0;
        this.pauseUntil = 0;
        this.tradingPaused = false;
        this.accountBalance = 1000;
        this.currentStatus = "INITIALIZING";

        console.log("[GrokEngine] v5.1 Initialized");
    }

    async start() {
        console.log("[GrokEngine] Starting...");

        try {
            await this.initHistoricalData();
        } catch (err) {
            console.error("[GrokEngine] Init error:", err.message);
        }

        this.client.onData = (snapshot) => {
            const now = Date.now();
            if (now - this.lastEvalTime >= STRATEGY_CONFIG.EVAL_INTERVAL_MS) {
                this.lastEvalTime = now;
                try {
                    this.evaluate(snapshot);
                } catch (err) {
                    console.error("[GrokEngine] Evaluate error:", err);
                }
            }
        };

        // ✅ Await connect
        await this.client.connect();
        console.log("[GrokEngine] ✅ Started");
    }

    async initHistoricalData() {
        try {
            const res = await fetch("https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=100");
            const klines = await res.json();
            if (Array.isArray(klines)) {
                const closes = klines.map(k => parseFloat(k[4]));
                this.btc1hEMA21 = this.calculateEMA(closes, 21);
                console.log(`[GrokEngine] EMA21: ${this.btc1hEMA21.toFixed(2)}`);
            }

            const res1m = await fetch("https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=21");
            const klines1m = await res1m.json();
            if (Array.isArray(klines1m)) {
                const volumes = klines1m.slice(0, 20).map(k => parseFloat(k[5]));
                this.btcVolumeMA20 = volumes.reduce((a, b) => a + b, 0) / 20;
                console.log(`[GrokEngine] Vol MA20: ${this.btcVolumeMA20.toFixed(2)}`);
            }
        } catch (e) {
            console.error("[GrokEngine] Historical data error:", e.message);
            this.btc1hEMA21 = 100000;
            this.btcVolumeMA20 = 1000;
        }
    }

    calculateEMA(data, period) {
        if (!data || data.length === 0) return 0;
        const k = 2 / (period + 1);
        let ema = data[0];
        for (let i = 1; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
        }
        return ema;
    }

    // ✅ FIXED: Session Filter
    checkSessionFilters() {
        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcMin = now.getUTCMinutes();
        const currentMinutes = utcHour * 60 + utcMin;

        const timeToMinutes = (str) => {
            const [h, m] = str.split(':').map(Number);
            return h * 60 + m;
        };

        for (const range of STRATEGY_CONFIG.SESSION_PAUSE_RANGES) {
            const start = timeToMinutes(range.start);
            const end = timeToMinutes(range.end);

            if (start <= end) {
                // Same day range
                if (currentMinutes >= start && currentMinutes <= end) {
                    return false;
                }
            } else {
                // Overnight range (e.g., 21:00 to 00:30)
                if (currentMinutes >= start || currentMinutes <= end) {
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
            this.tradesTakenToday = 0;
            this.dailyPnL = 0;
            this.consecutiveLosses = 0;
            this.lastTradeResetDate = today;
            this.tradingPaused = false;
            this.pauseUntil = 0;
        }

        if (this.tradingPaused && this.pauseUntil > 0 && Date.now() > this.pauseUntil) {
            this.tradingPaused = false;
            this.consecutiveLosses = 0;
        }

        if (this.tradingPaused) return false;
        if (this.dailyPnL <= -STRATEGY_CONFIG.MAX_DAILY_LOSS_PERCENT) return false;
        if (this.dailyPnL >= STRATEGY_CONFIG.MAX_DAILY_PROFIT_PERCENT) return false;
        if (this.tradesTakenToday >= STRATEGY_CONFIG.MAX_TRADES_PER_DAY) return false;

        return true;
    }

    hasValidCorrelation(snapshot) {
        const c = snapshot.correlation;
        return typeof c === 'number' && !isNaN(c) && c >= STRATEGY_CONFIG.CORR_MIN;
    }

    checkLagScoreLong(snapshot) {
        const { btcMove4m, dogeMove4m, lagScore } = snapshot;
        if (lagScore === null) return false;
        if (btcMove4m < STRATEGY_CONFIG.LAG_MIN_BTC_MOVE) return false;
        if (dogeMove4m <= 0) return false;
        if (dogeMove4m >= btcMove4m * STRATEGY_CONFIG.LAG_DOGE_MAX_RATIO) return false;
        return lagScore >= STRATEGY_CONFIG.LAG_SCORE_MIN;
    }

    checkLagScoreShort(snapshot) {
        const { btcMove4m, dogeMove4m, lagScore } = snapshot;
        if (lagScore === null) return false;
        if (btcMove4m > -STRATEGY_CONFIG.LAG_MIN_BTC_MOVE) return false;
        if (dogeMove4m >= 0) return false;
        if (Math.abs(dogeMove4m) >= Math.abs(btcMove4m) * STRATEGY_CONFIG.LAG_DOGE_MAX_RATIO) return false;
        return Math.abs(lagScore) >= STRATEGY_CONFIG.LAG_SCORE_MIN;
    }

    hasLiquiditySweepLong() {
        const klines = this.client.data["BTCUSDT"]?.klineHistory?.["1m"];
        if (!klines || klines.length < 21) return false;

        const hist = klines.slice(-21, -1);
        const swingLow = Math.min(...hist.map(k => k.low));
        const curr = klines[klines.length - 1];
        const prev = klines[klines.length - 2];

        const swept = curr.low < swingLow || prev.low < swingLow;
        if (!swept) return false;

        const sweepCandle = curr.low < swingLow ? curr : prev;
        const depth = ((swingLow - sweepCandle.low) / swingLow) * 100;
        if (depth < STRATEGY_CONFIG.SWEEP_MIN_DEPTH) return false;
        if (curr.close <= swingLow) return false;
        if (curr.volume < this.btcVolumeMA20 * STRATEGY_CONFIG.BTC_VOLUME_MA_MULTIPLIER) return false;

        return true;
    }

    hasLiquiditySweepShort() {
        const klines = this.client.data["BTCUSDT"]?.klineHistory?.["1m"];
        if (!klines || klines.length < 21) return false;

        const hist = klines.slice(-21, -1);
        const swingHigh = Math.max(...hist.map(k => k.high));
        const curr = klines[klines.length - 1];
        const prev = klines[klines.length - 2];

        const swept = curr.high > swingHigh || prev.high > swingHigh;
        if (!swept) return false;

        const sweepCandle = curr.high > swingHigh ? curr : prev;
        const depth = ((sweepCandle.high - swingHigh) / swingHigh) * 100;
        if (depth < STRATEGY_CONFIG.SWEEP_MIN_DEPTH) return false;
        if (curr.close >= swingHigh) return false;
        if (curr.volume < this.btcVolumeMA20 * STRATEGY_CONFIG.BTC_VOLUME_MA_MULTIPLIER) return false;

        return true;
    }

    detectFVG(side) {
        const klines = this.client.data["BTCUSDT"]?.klineHistory?.["1m"];
        if (!klines || klines.length < 3) return null;

        const c1 = klines[klines.length - 3];
        const c3 = klines[klines.length - 1];

        if (side === "BUY" && c1.high < c3.low) {
            const gap = ((c3.low - c1.high) / c3.close) * 100;
            if (gap >= STRATEGY_CONFIG.FVG_MIN_GAP_PERCENT) {
                return { low: c1.high, high: c3.low };
            }
        }
        if (side === "SELL" && c1.low > c3.high) {
            const gap = ((c1.low - c3.high) / c3.close) * 100;
            if (gap >= STRATEGY_CONFIG.FVG_MIN_GAP_PERCENT) {
                return { low: c3.high, high: c1.low };
            }
        }
        return null;
    }

    isDogeFlat() {
        const klines = this.client.data["DOGEUSDT"]?.klineHistory?.["1m"];
        if (!klines || klines.length < STRATEGY_CONFIG.DOGE_FLAT_LOOKBACK) return false;

        return !klines.slice(-STRATEGY_CONFIG.DOGE_FLAT_LOOKBACK).some(k => {
            return (Math.abs(k.close - k.open) / k.open * 100) >= STRATEGY_CONFIG.DOGE_FLAT_MAX_MOVE;
        });
    }

    calculatePositionSize(entry, sl) {
        const risk = this.accountBalance * (STRATEGY_CONFIG.RISK_PER_TRADE_PERCENT / 100);
        const slDist = Math.abs(entry - sl) / entry * 100;
        if (slDist === 0) return 0;
        const posValue = risk / (slDist / 100);
        const levValue = Math.min(posValue * STRATEGY_CONFIG.MAX_LEVERAGE, STRATEGY_CONFIG.MAX_POSITION_USD);
        return Math.floor(levValue / entry);
    }

    evaluate(snapshot) {

        if (!this.checkSessionFilters()) {
            if (this.currentStatus !== "SESSION_PAUSED") {
                console.log("[GrokEngine] ⏸️ Session filter active. Pausing evaluation.");
            }
            this.currentStatus = "SESSION_PAUSED";
            this.logStatus(snapshot, "PAUSED (SESSION)");
            return;
        }
        if (!this.checkDailyLimits()) {
            if (this.currentStatus !== "LIMIT_PAUSED") {
                console.log("[GrokEngine] 🛑 Daily limits reached. Pausing evaluation.");
            }
            this.currentStatus = "LIMIT_PAUSED";
            this.logStatus(snapshot, "PAUSED (LIMITS)");
            return;
        }
        if (this.activeTrade) {
            this.logStatus(snapshot, "IN_TRADE");
            this.checkExit(snapshot);
            return;
        }
        if ((snapshot.doge?.atrPercent || 0) < STRATEGY_CONFIG.DOGE_ATR_MIN_PERCENT) {
            this.logStatus(snapshot, "LOW_ATR");
            return;
        }
        const btcPrice = snapshot.btc?.price || 0;
        if (!btcPrice || !this.btc1hEMA21) return;
        console.log("[EVALUATE] btc ok");

        const trend = btcPrice > this.btc1hEMA21 ? "UP" : "DOWN";
        console.log("[EVALUATE] trend ok");
        const flat = this.isDogeFlat();
        const corrOk = this.hasValidCorrelation(snapshot);

        // LONG
        if (trend === "UP") {
            const fvg = this.detectFVG("BUY");
            const checks = {
                sweep: this.hasLiquiditySweepLong(),
                fvg: fvg !== null,
                delta: (snapshot.btc?.deltaPercentile || 50) >= STRATEGY_CONFIG.DELTA_LONG_PERCENTILE,
                lag: this.checkLagScoreLong(snapshot),
                corr: corrOk,
                flat: flat,
                funding: (snapshot.doge?.fundingRate || 0) <= STRATEGY_CONFIG.FUNDING_LONG_MAX,
            };

            console.log("[LONG]", checks);

            if (Object.values(checks).every(Boolean)) {
                if (!this.client.hasNewCandleClosed("DOGEUSDT")) return;
                const candle = this.client.getLastClosedCandle("DOGEUSDT");
                if (!candle) return;

                const body = (candle.close - candle.open) / candle.open * 100;
                const range = candle.high - candle.low;
                const ratio = range > 0 ? Math.abs(candle.close - candle.open) / range : 0;

                if (body >= STRATEGY_CONFIG.DOGE_ENTRY_MIN_MOVE &&
                    candle.close > candle.open &&
                    ratio >= STRATEGY_CONFIG.ENTRY_BODY_RATIO) {
                    this.triggerTrade("BUY", snapshot, fvg);
                }
            }
        }

        // SHORT
        if (trend === "DOWN") {
            const fvg = this.detectFVG("SELL");
            const checks = {
                sweep: this.hasLiquiditySweepShort(),
                fvg: fvg !== null,
                delta: (snapshot.btc?.deltaPercentile || 50) <= STRATEGY_CONFIG.DELTA_SHORT_PERCENTILE,
                lag: this.checkLagScoreShort(snapshot),
                corr: corrOk,
                flat: flat,
                funding: (snapshot.doge?.fundingRate || 0) >= STRATEGY_CONFIG.FUNDING_SHORT_MIN,
            };

            console.log("[SHORT]", checks);

            if (Object.values(checks).every(Boolean)) {
                if (!this.client.hasNewCandleClosed("DOGEUSDT")) return;
                const candle = this.client.getLastClosedCandle("DOGEUSDT");
                if (!candle) return;

                const body = (candle.open - candle.close) / candle.open * 100;
                const range = candle.high - candle.low;
                const ratio = range > 0 ? Math.abs(candle.open - candle.close) / range : 0;

                if (body >= STRATEGY_CONFIG.DOGE_ENTRY_MIN_MOVE &&
                    candle.close < candle.open &&
                    ratio >= STRATEGY_CONFIG.ENTRY_BODY_RATIO) {
                    this.triggerTrade("SELL", snapshot, fvg);
                }
            }
        }
    }

    triggerTrade(side, snapshot, fvg) {
        const entry = snapshot.doge.price;
        const slPct = STRATEGY_CONFIG.STOP_LOSS / 100;
        const sl = side === "BUY" ? entry * (1 - slPct) : entry * (1 + slPct);
        const tp1 = side === "BUY" ? entry * (1 + STRATEGY_CONFIG.TP1_PERCENT / 100) : entry * (1 - STRATEGY_CONFIG.TP1_PERCENT / 100);
        const tp2 = side === "BUY" ? entry * (1 + STRATEGY_CONFIG.TP2_PERCENT / 100) : entry * (1 - STRATEGY_CONFIG.TP2_PERCENT / 100);
        const qty = this.calculatePositionSize(entry, sl);

        if (qty <= 0) return;

        this.activeTrade = { side, entry, sl, tp1, tp2, tp1Hit: false, beMoved: false, startTime: Date.now(), btcEntryPrice: snapshot.btc.price, fvgLevel: fvg, quantity: qty };
        this.tradesTakenToday++;

        console.log(`\n🚀 ${side} @ ${entry.toFixed(5)} | SL: ${sl.toFixed(5)} | TP1: ${tp1.toFixed(5)}`);

        if (this.onSignal) {
            this.onSignal({ decision: side, entry, stopLoss: sl, takeProfit: tp1, quantity: qty, leverage: STRATEGY_CONFIG.MAX_LEVERAGE });
        }
    }

    checkExit(snapshot) {
        const t = this.activeTrade;
        const price = snapshot.doge?.price;
        if (!t || !price) return;

        const pnl = t.side === "BUY" ? (price - t.entry) / t.entry * 100 : (t.entry - price) / t.entry * 100;
        const time = Date.now() - t.startTime;

        if ((t.side === "BUY" && price <= t.sl) || (t.side === "SELL" && price >= t.sl)) {
            return this.exitTrade("STOP_LOSS", price, pnl);
        }
        if (t.tp1Hit && ((t.side === "BUY" && price >= t.tp2) || (t.side === "SELL" && price <= t.tp2))) {
            return this.exitTrade("TP2", price, pnl);
        }
        if (!t.tp1Hit && ((t.side === "BUY" && price >= t.tp1) || (t.side === "SELL" && price <= t.tp1))) {
            t.tp1Hit = true;
            t.sl = t.side === "BUY" ? t.entry * (1 + STRATEGY_CONFIG.BE_OFFSET_PERCENT / 100) : t.entry * (1 - STRATEGY_CONFIG.BE_OFFSET_PERCENT / 100);
            console.log(`[TP1] SL → ${t.sl.toFixed(5)}`);
        }
        if (pnl > 0 && ((t.side === "BUY" && (snapshot.btc?.deltaSum3 || 0) <= -STRATEGY_CONFIG.BTC_DELTA_EXIT_FLIP) ||
            (t.side === "SELL" && (snapshot.btc?.deltaSum3 || 0) >= STRATEGY_CONFIG.BTC_DELTA_EXIT_FLIP))) {
            return this.exitTrade("DELTA_FLIP", price, pnl);
        }
        if (pnl >= STRATEGY_CONFIG.CATCHUP_MIN_PROFIT) {
            const btcMove = (snapshot.btc.price - t.btcEntryPrice) / t.btcEntryPrice * 100;
            const dogeMove = t.side === "BUY" ? (price - t.entry) / t.entry * 100 : (t.entry - price) / t.entry * 100;
            if ((t.side === "BUY" && btcMove >= STRATEGY_CONFIG.CATCHUP_MIN_BTC_MOVE && dogeMove >= btcMove * STRATEGY_CONFIG.DOGE_CATCHUP_RATIO) ||
                (t.side === "SELL" && btcMove <= -STRATEGY_CONFIG.CATCHUP_MIN_BTC_MOVE && dogeMove >= Math.abs(btcMove) * STRATEGY_CONFIG.DOGE_CATCHUP_RATIO)) {
                return this.exitTrade("CATCHUP", price, pnl);
            }
        }
        if (time >= STRATEGY_CONFIG.TIME_STOP_MS && pnl < STRATEGY_CONFIG.TIME_STOP_MIN_PROFIT) {
            return this.exitTrade("TIME_STOP", price, pnl);
        }
        if (!t.beMoved && pnl >= STRATEGY_CONFIG.BE_TRIGGER_PERCENT) {
            t.sl = t.side === "BUY" ? t.entry * (1 + STRATEGY_CONFIG.BE_OFFSET_PERCENT / 100) : t.entry * (1 - STRATEGY_CONFIG.BE_OFFSET_PERCENT / 100);
            t.beMoved = true;
        }
    }

    exitTrade(reason, price, pnl) {
        console.log(`[EXIT] ${reason} @ ${price.toFixed(5)} (${pnl.toFixed(2)}%)`);
        this.dailyPnL += pnl;
        if (pnl < 0) {
            this.consecutiveLosses++;
            if (this.consecutiveLosses >= STRATEGY_CONFIG.MAX_CONSECUTIVE_LOSSES) {
                this.tradingPaused = true;
                this.pauseUntil = Date.now() + STRATEGY_CONFIG.CONSECUTIVE_LOSS_PAUSE_MS;
            }
        } else {
            this.consecutiveLosses = 0;
        }
        if (this.onSignal) {
            this.onSignal({ decision: this.activeTrade.side === "BUY" ? "SELL" : "BUY", reason, price, pnlPercent: pnl, isExit: true });
        }
        this.activeTrade = null;
    }

    logStatus(snapshot, state) {
        const now = Date.now();
        if (now - this.lastStatusLog < 30000) return;
        const lagDisplay = snapshot.lagScore !== null ? snapshot.lagScore.toFixed(2) : `N/A (${snapshot.lagReason || 'NO_DATA'})`;
        console.log(`[${state}] BTC: $${snapshot.btc?.price?.toFixed(0)} | DOGE: $${snapshot.doge?.price?.toFixed(5)} | Corr: ${snapshot.correlation?.toFixed(3)} | Lag: ${lagDisplay}`);
        this.lastStatusLog = now;
    }
}

export default GrokStrategyEngine;