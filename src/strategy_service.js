/**
 * OI FLOW RIDER v2.0 — Accumulation/Distribution Lifecycle Strategy
 *
 * Tracks BTC & ETH simultaneously. Detects:
 *   Phase 1 (Accumulation): OI rising + price compressed + high absorption
 *   Phase 2 (Markup/Markdown): Enters at the transition — OI accelerates or ATR breaks out
 *   Phase 3 (Distribution): OI decelerating + volume without OI growth → exit
 *
 * Every tick logs all signal values for calibration data.
 */

import { placeOrder, closePartialPosition } from './coindcx.js';
import {
    fetchAllAssetsData, ASSETS,
    computeATR, computeATRAtOffset, linearRegressionSlope,
    sumVolume, priceChange,
} from './binance.js';

// ─── Configuration ───────────────────────────────────────────────

const CONFIG = {
    // CoinDCX pairs for each symbol
    PAIRS: {
        BTCUSDT: 'B-BTC_USDT',
        ETHUSDT: 'B-ETH_USDT',
    },

    // Position Sizing (v2.0 Restored Spec)
    RISK_PER_TRADE: 0.01,       // 1% of mock balance
    MAX_LEVERAGE: 15,
    ATR_SL_MULT: 1.5,           // SL = 1.5x ATR
    SL_MIN_PCT: 0.003,          // 0.3%
    SL_MAX_PCT: 0.012,          // 1.2%
    TP_SL_RATIO: 2.5,           // TP = 2.5x SL
    USD_INR_RATE: 85,

    // Accumulation Score Thresholds
    ACC_ENTRY_THRESHOLD: 85,    // v2.1: raised from 55 for higher conviction
    ACC_MIN_DURATION_MIN: 20,    // v2.0: duration >= 7 min

    // Direction Detection
    SIGNAL_BIAS_THRESHOLD: 2,   // Need 2 of 3 signals
    TAKER_LONG: 1.03,
    TAKER_SHORT: 0.97,
    SLOPE_LONG: 0.01,           // +0.01%/candle
    SLOPE_SHORT: -0.01,         // -0.01%/candle
    TT_DELTA_LONG: 0.005,
    TT_DELTA_SHORT: -0.005,

    // Entry Transition Triggers
    OI_ACCELERATION_MULT: 2.0,  // Doubles ROC
    ATR_BREAKOUT_MULT: 1.3,     // 30% expansion

    // Distribution Exit Thresholds
    OI_DROP_EXIT_PCT: 0.3,      // 0.3% in 3 min
    OI_DECEL_MINUTES: 3,
    VOLUME_OI_DIVERGENCE: 1.5,  // Vol > 1.5x avg
    VOL_WT_OI_THRESHOLD: 0.005, // 0.5% change required (was 0.2% — too sensitive per prod analysis)
    MIN_HOLD_MINUTES: 15,       // 15-min grace period (was 5 — exits were chopping trades at 5-10min)
    TIME_STOP_MIN: 60,          // 60-min time stop (was 45 — give trades more room)

    // Anti-Trap
    RETAIL_CROWD_LIMIT: 0.65,   // v2.0: retail < 70%

    // Partial TP Settings
    PARTIAL_TP_ATR: 1.5,
    TRAILING_SL_ATR: 0.8,

    // Kill Switches
    MAX_DAILY_LOSSES: 3,
    MAX_DAILY_TRADES: 8,
    COOLDOWN_LOSS_MS: 15 * 60 * 1000,
    COOLDOWN_GATE_MS: 30 * 60 * 1000,
    MAX_DRAWDOWN_PCT: 20,
    NEAR_EXTREME_PCT: 0.005,

    // Mock Mode
    MOCK_MODE: true,
    INITIAL_INR_BALANCE: 25000,
    MOCK_FEE_PCT: 0.001,       // 0.1% per side
};

// ─── Strategy Service ────────────────────────────────────────────

export class StrategyService {
    constructor(env) {
        this.env = env;
        this.db = null;
        this.allData = null;
    }

    async run(db) {
        this.db = db;
        try {
            console.log('[v2.0] Fetching multi-asset data...');
            this.allData = await fetchAllAssetsData();

            const contexts = {};
            for (const symbol of ASSETS) {
                contexts[symbol] = await this.preprocessAsset(symbol, this.allData[symbol]);
            }

            const crossAssetStatus = this.evaluateCrossAssetGate(contexts);
            console.log(`[GATE] Status: ${crossAssetStatus} | BTC:${contexts.BTCUSDT?.dirSignals.direction || 'none'} ETH:${contexts.ETHUSDT?.dirSignals.direction || 'none'}`);

            for (const symbol of ASSETS) {
                if (contexts[symbol]) contexts[symbol].crossAssetStatus = crossAssetStatus;
                await this.executeAssetLogic(symbol, contexts[symbol]);
            }

            await this.db.cleanupOldOISnapshots();
            await this.db.cleanupOldTicks();
            await this.handleSignalMode(contexts, crossAssetStatus);
            await this.syncDailyStats();

            return { success: true };
        } catch (err) {
            console.error('[CRITICAL ERROR] Loop failed:', err.stack);
            return { success: false, error: err.message };
        }
    }

    async preprocessAsset(symbol, data) {
        if (!data || !data.ticker24h) return null;
        const currentPrice = parseFloat(data.ticker24h.lastPrice);
        if (!currentPrice || currentPrice <= 0 || isNaN(currentPrice)) return null;
        const openInterest = parseFloat(data.openInterest.openInterest);

        // PERSIST SNAPSHOT FOR LOOKBACK
        if (!isNaN(currentPrice) && !isNaN(openInterest)) {
            await this.db.saveOISnapshot(Date.now(), symbol, openInterest, currentPrice);
        }

        const oiAnalysis = await this.analyzeOI(symbol, data.openInterest);
        const { atrPct } = computeATR(data.klines5m);
        const dirSignals = this.detectDirection(data);
        const accScore = await this.calculateAccumulationScore(symbol, data, currentPrice, oiAnalysis);

        return { currentPrice, data, oiAnalysis, atrPct, dirSignals, accScore };
    }

    evaluateCrossAssetGate(contexts) {
        const btc = contexts.BTCUSDT;
        const eth = contexts.ETHUSDT;
        if (!btc || !eth) return 'BOTH_QUIET';

        const btcDir = btc.accScore.total >= 40 ? btc.dirSignals.direction : null;
        const ethDir = eth.accScore.total >= 40 ? eth.dirSignals.direction : null;

        if (!btcDir && !ethDir) return 'BOTH_QUIET';
        if (btcDir && ethDir && btcDir !== ethDir) return 'CONFLICT';
        if (btcDir && ethDir && btcDir === ethDir && btc.accScore.total >= 50 && eth.accScore.total >= 50) return 'CONFIRMED';
        if (btc.accScore.total >= 55 && eth.accScore.total < 40) return 'ONE_LEADING';
        if (eth.accScore.total >= 55 && btc.accScore.total < 40) return 'ONE_LEADING';

        return 'BOTH_QUIET';
    }

    async executeAssetLogic(symbol, context) {
        if (!context) return;
        const tickData = {
            symbol,
            price: context.currentPrice,
            openInterest: context.data.openInterest.openInterest,
            oi_change_1m: context.oiAnalysis?.change1m || 0,
            oi_change_5m: context.oiAnalysis?.change5m || 0,
            oi_change_15m: context.oiAnalysis?.change15m || 0,
            accumulationScore: context.accScore.total,
            tick_oi_consistency: context.accScore.oiConsistency || 0,
            tick_oi_acceleration: context.accScore.oiAcceleration || 0,
            tick_absorption: context.accScore.absorptionRatio || 0,
            tick_compression: context.accScore.priceCompression || 0,
            taker_ratio: context.data.takerBuySellRatio?.buySellRatio || 1,
            top_trader_delta: context.dirSignals.signals.topTraderDelta || 0,
            retail_long_pct: context.data.globalLSRatio?.longAccount || 0.5,
            price_slope: context.dirSignals.signals.slope || 0,
            funding_rate: context.data.funding?.fundingRate || 0,
            atr_pct: context.atrPct,
            volume_ratio: sumVolume(context.data.klines1m, 15) / (sumVolume(context.data.klines1m, 60) / 4 || 1),
            phase: context.accScore.total >= 50 ? 'ACCUMULATION' : 'MARKUP_DOWN',
            direction: context.dirSignals.direction || 'UNCLEAR',
            minutesAccumulating: await this.getSustainedDuration(symbol),
            cross_asset_status: context.crossAssetStatus,
        };

        const btcTrade = await this.db.getActiveTrade('BTCUSDT');
        const ethTrade = await this.db.getActiveTrade('ETHUSDT');
        const anyActiveTrade = btcTrade || ethTrade;

        const tr = tickData.taker_ratio;
        tickData.would_exhaustion_block = (tr > 1.25 || tr < 0.75) ? 1 : 0;
        tickData.would_vol_regime_block = (tickData.atr_pct < 0.15) ? 1 : 0;
        tickData.would_oi_stagnation_block = Math.abs(context.oiAnalysis.change15m) < 0.3 ? 1 : 0;
        tickData.would_strict_cross_asset_block = context.crossAssetStatus !== 'CONFIRMED' ? 1 : 0;
        tickData.would_score_60_block = context.accScore.total < 60 ? 1 : 0;
        tickData.would_duration_10_block = tickData.minutesAccumulating < 10 ? 1 : 0;

        const activeTrade = symbol === 'BTCUSDT' ? btcTrade : ethTrade;
        if (activeTrade) {
            const result = await this.manageTrade(activeTrade, context.data, context.currentPrice, context.oiAnalysis, context.accScore, context.crossAssetStatus);
            tickData.tradeAction = result.action;
            tickData.blockReason = result.reason;
        } else {
            if (anyActiveTrade) {
                tickData.tradeAction = 'NO_SIGNAL';
                tickData.blockReason = 'GLOBAL_POS_ACTIVE';
            } else {
                const signal = await this.evaluateEntry(symbol, context, tickData);
                tickData.tradeAction = signal.action;
                tickData.blockReason = signal.reason;
            }
        }
        await this.db.logTick(tickData);
    }

    async analyzeOI(symbol, currentOI) {
        if (!currentOI) return null;
        const snapshots = await this.db.getOISnapshots(symbol, 60);

        const change1m = snapshots.length >= 1 ? (currentOI.openInterest - snapshots[0].open_interest) / snapshots[0].open_interest * 100 : 0;
        const change5m = snapshots.length >= 5 ? (currentOI.openInterest - snapshots[4].open_interest) / snapshots[4].open_interest * 100 : 0;
        const change15m = snapshots.length >= 15 ? (currentOI.openInterest - snapshots[14].open_interest) / snapshots[14].open_interest * 100 : 0;

        const recentROC = snapshots.length >= 5 ? (currentOI.openInterest - snapshots[4].open_interest) / 5 : 0;
        const olderROC = snapshots.length >= 15 ? (snapshots[4].open_interest - snapshots[14].open_interest) / 10 : 0;

        return { currentOI: currentOI.openInterest, change1m, change5m, change15m, recentROC, olderROC, snapshots };
    }

    async calculateAccumulationScore(symbol, data, currentPrice, oiAnalysis) {
        let score = 0;
        const snapshots = oiAnalysis?.snapshots || [];

        // 1. OI Consistency (25 pts)
        if (snapshots.length >= 16) {
            const recent15 = snapshots.slice(-16);
            let posCount = 0;
            for (let i = 1; i < recent15.length; i++) {
                if (recent15[i].open_interest > recent15[i - 1].open_interest) posCount++;
            }
            if (posCount >= 10) score += (posCount / 15) * 25;
        }

        // 2. OI Acceleration (25 pts)
        if (snapshots.length >= 16) {
            const recent8 = snapshots.slice(-9);
            const older7 = snapshots.slice(-16, -8);
            const rROC = (recent8[recent8.length - 1].open_interest - recent8[0].open_interest) / 8;
            const oROC = (older7[older7.length - 1].open_interest - older7[0].open_interest) / 7;
            if (rROC > oROC * 1.2 && rROC > 0) score += 25;
            else if (rROC > oROC * 0.8 && rROC > 0) score += 15;
        }

        // 3. Absorption Ratio (25 pts - Continuous OI-based)
        const priceChgPct = Math.abs(priceChange(data.klines1m, 15));
        const vol15 = sumVolume(data.klines1m, 15);
        const hourlyAvgVol15 = sumVolume(data.klines1m.slice(-60), 60) / 4;
        let absRatio = 0;

        if (priceChgPct < 0.05) {
            if (vol15 > hourlyAvgVol15 * 1.5) score += 25;
        } else {
            const raw = (oiAnalysis?.change15m || 0) / (priceChgPct || 0.001);
            const relative = raw / 1.0; // Spec: baseline 1.0 for OI-based
            if (relative >= 1.0) score += Math.min((relative - 1.0) * 25, 25);
            absRatio = relative;
        }

        // 4. Price Compression (25 pts)
        const currentATR = computeATR(data.klines5m);
        const olderATR = computeATRAtOffset(data.klines5m_older || data.klines5m, 12);
        const compression = olderATR.atrPct / (currentATR.atrPct || 0.001);
        if (compression >= 1.2) score += 25;
        else if (compression >= 1.1) score += 15;

        return {
            total: Math.min(score, 100),
            absorptionRatio: absRatio,
            priceCompression: compression,
            oiAcceleration: snapshots.length >= 16 ? (oiAnalysis.recentROC > oiAnalysis.olderROC * 1.2 ? 25 : (oiAnalysis.recentROC > oiAnalysis.olderROC * 0.8 ? 15 : 0)) : 0,
            oiConsistency: snapshots.length >= 16 ? score : 0
        };
    }

    detectDirection(data) {
        const votes = { long: 0, short: 0 };
        const signals = {};
        const tr = data.takerBuySellRatio?.buySellRatio || 1.0;
        signals.taker = tr;
        if (tr >= CONFIG.TAKER_LONG) votes.long++;
        if (tr <= CONFIG.TAKER_SHORT) votes.short++;

        const slope = linearRegressionSlope(data.klines1m, 15);
        signals.slope = slope;
        if (slope >= CONFIG.SLOPE_LONG) votes.long++;
        if (slope <= CONFIG.SLOPE_SHORT) votes.short++;

        if (data.topTraderLSRatio) {
            const delta = data.topTraderLSRatio.longAccount - data.topTraderLSRatio.shortAccount;
            signals.topTraderDelta = delta;
            if (delta >= CONFIG.TT_DELTA_LONG) votes.long++;
            if (delta <= CONFIG.TT_DELTA_SHORT) votes.short++;
        }

        const direction = votes.long >= CONFIG.SIGNAL_BIAS_THRESHOLD ? 'long'
            : (votes.short >= CONFIG.SIGNAL_BIAS_THRESHOLD ? 'short' : null);
        return { direction, signals, longVotes: votes.long, shortVotes: votes.short };
    }

    async getSustainedDuration(symbol) {
        const recent = await this.db.getRecentTicks(symbol, 60);
        let count = 0;
        for (const t of recent) {
            if (t.accumulation_score >= 50) count++;
            else break;
        }
        return count;
    }

    async evaluateEntry(symbol, context, tickData) {
        const { currentPrice, data, oiAnalysis, accScore, dirSignals, crossAssetStatus } = context;
        const kill = await this.checkKillSwitches(currentPrice, data);
        if (kill) return { action: 'NO_SIGNAL', reason: kill };

        if (accScore.total < CONFIG.ACC_ENTRY_THRESHOLD) return { action: 'NO_SIGNAL', reason: `AccScore low: ${accScore.total.toFixed(0)}` };
        const dur = await this.getSustainedDuration(symbol);
        if (dur < CONFIG.ACC_MIN_DURATION_MIN) return { action: 'NO_SIGNAL', reason: `AccDuration low: ${dur}m` };

        const cATR = computeATR(data.klines5m);
        const oATR = computeATRAtOffset(data.klines5m_older || data.klines5m, 12);
        let trigger = null;
        if (oiAnalysis.recentROC > 0 && oiAnalysis.recentROC >= oiAnalysis.olderROC * CONFIG.OI_ACCELERATION_MULT) trigger = 'OI_ACCEL';
        else if (oATR.atrPct > 0 && cATR.atrPct >= oATR.atrPct * CONFIG.ATR_BREAKOUT_MULT) trigger = 'ATR_BO';

        if (!trigger) return { action: 'NO_SIGNAL', reason: 'WAIT_TRANSITION' };
        if (!dirSignals.direction) return { action: 'NO_SIGNAL', reason: 'NO_DIR_CONFIRM' };

        const retail = data.globalLSRatio?.longAccount || 0.5;
        const bias = dirSignals.direction === 'long' ? retail : (1 - retail);
        if (bias > CONFIG.RETAIL_CROWD_LIMIT) return { action: 'NO_SIGNAL', reason: 'RETAIL_TRAP' };
        if (crossAssetStatus === 'CONFLICT') return { action: 'NO_SIGNAL', reason: 'GATE_CONFLICT' };
        if (crossAssetStatus === 'BOTH_QUIET') return { action: 'NO_SIGNAL', reason: 'GATE_QUIET' };

        return await this.executeTrade(symbol, context, dirSignals.direction, trigger);
    }

    async executeTrade(symbol, context, direction, reason) {
        const { currentPrice, atrPct, accScore, crossAssetStatus, dirSignals } = context;
        const slDistPct = Math.max(CONFIG.SL_MIN_PCT, Math.min(CONFIG.SL_MAX_PCT, atrPct * CONFIG.ATR_SL_MULT));
        const stopLoss = direction === 'long' ? currentPrice * (1 - slDistPct) : currentPrice * (1 + slDistPct);
        const tpDistPct = slDistPct * CONFIG.TP_SL_RATIO;
        const takeProfit = direction === 'long' ? currentPrice * (1 + tpDistPct) : currentPrice * (1 - tpDistPct);

        const balance = await this.db.getMockBalance();
        const risk = balance * CONFIG.RISK_PER_TRADE;
        const posValueInr = risk / slDistPct;
        const leverage = Math.min(posValueInr / balance, CONFIG.MAX_LEVERAGE);
        const quantity = posValueInr / (currentPrice * CONFIG.USD_INR_RATE);

        const orderId = `MOCK_${Date.now()}_${symbol}`;
        await this.db.logTrade({
            orderId, symbol, direction: direction.toUpperCase(), entry: currentPrice,
            quantity: parseFloat(quantity.toFixed(4)), leverage: parseFloat(leverage.toFixed(2)),
            stopLoss, takeProfit, accScoreAtEntry: accScore.total,
            accDurationAtEntry: await this.getSustainedDuration(symbol),
            oiAtEntry: context.data.openInterest.openInterest,
            crossAssetStatusAtEntry: crossAssetStatus,
            directionSignalsAtEntry: JSON.stringify(dirSignals.signals)
        });

        await this.db.updateMockBalance(balance - (posValueInr * CONFIG.MOCK_FEE_PCT));
        return { action: 'TRADE_OPENED', symbol, direction, price: currentPrice, orderId };
    }

    async manageTrade(trade, data, currentPrice, oiAnalysis, accScore, crossAssetStatus) {
        const symbol = trade.symbol;
        const dir = trade.direction === 'LONG' ? 1 : -1;
        const pnlPct = (currentPrice - trade.entry_price) / trade.entry_price * dir;

        if (dir === 1 && currentPrice <= trade.sl_price) return this.closePosition(trade, currentPrice, 'STOP_LOSS');
        if (dir === -1 && currentPrice >= trade.sl_price) return this.closePosition(trade, currentPrice, 'STOP_LOSS');
        if (dir === 1 && currentPrice >= trade.tp_price) return this.closePosition(trade, currentPrice, 'TAKE_PROFIT');
        if (dir === -1 && currentPrice <= trade.tp_price) return this.closePosition(trade, currentPrice, 'TAKE_PROFIT');

        if (symbol === 'ETHUSDT') {
            const btcAnal = await this.analyzeOI('BTCUSDT', this.allData['BTCUSDT']?.openInterest);
            if (btcAnal?.change5m <= -0.5) return this.closePosition(trade, currentPrice, 'CR_ASSET_UNWIND_OI');
        } else if (symbol === 'BTCUSDT') {
            const ethK = this.allData['ETHUSDT']?.klines1m;
            const ethDrop = ethK ? (this.allData['ETHUSDT'].ticker24h.lastPrice - ethK[0].close) / ethK[0].close : 0;
            if (ethDrop < -0.01 && Math.abs(pnlPct) < 0.001) {
                const be = dir === 1 ? trade.entry_price * 1.0005 : trade.entry_price * 0.9995;
                await this.db.updateStopLoss(trade.id, be);
            }
        }

        const s3BTC = await this.db.getOISnapshotAt('BTCUSDT', 3);
        const s3ETH = await this.db.getOISnapshotAt('ETHUSDT', 3);
        if (s3BTC && s3ETH) {
            const dBTC = (s3BTC.open_interest - this.allData['BTCUSDT'].openInterest.openInterest) / s3BTC.open_interest * 100;
            const dETH = (s3ETH.open_interest - this.allData['ETHUSDT'].openInterest.openInterest) / s3ETH.open_interest * 100;
            if (dBTC >= 0.2 && dETH >= 0.2) return this.closePosition(trade, currentPrice, 'CR_ASSET_BOTH_UNWIND');
        }

        const s3 = await this.db.getOISnapshotAt(symbol, 3);
        if (s3 && (s3.open_interest - data.openInterest.openInterest) / s3.open_interest * 100 >= CONFIG.OI_DROP_EXIT_PCT)
            return this.closePosition(trade, currentPrice, 'OI_DROP_03');

        // OI_DECEL exit REMOVED — prod analysis showed it fired on 50% of trades (14/28)
        // for avg -₹1.63. OI deceleration is normal noise, not distribution.

        // NOISE-BASED EXITS (Subject to Grace Period)
        const holdTimeMinutes = (Date.now() - trade.entry_time) / 60000;
        if (holdTimeMinutes >= CONFIG.MIN_HOLD_MINUTES) {
            const vol15 = sumVolume(data.klines1m, 15);
            if (vol15 > (sumVolume(data.klines1m, 60) / 4) * CONFIG.VOLUME_OI_DIVERGENCE && Math.abs(oiAnalysis?.change5m || 0) < CONFIG.VOL_WT_OI_THRESHOLD * 100)
                return this.closePosition(trade, currentPrice, 'VOL_WT_OI');

            // ABSORPTION_FLIP: Tightened — only exit when in LOSS, volume drop > 50%, and price moved > 3%
            const vol3 = sumVolume(data.klines1m, 3);
            const s3Vol = sumVolume(data.klines1m.slice(-6, -3), 3);
            if (pnlPct < 0 && vol3 < s3Vol * 0.5 && Math.abs(priceChange(data.klines1m, 3)) > 0.03)
                return this.closePosition(trade, currentPrice, 'ABSORPTION_FLIP');
        }

        if ((Date.now() - trade.entry_time) / 60000 >= CONFIG.TIME_STOP_MIN) return this.closePosition(trade, currentPrice, 'TIME_STOP');

        if (trade.partial_tp_hit === 0 && pnlPct >= (CONFIG.PARTIAL_TP_ATR * (trade.atr_pct || 0.5) / 100)) {
            await this.db.updatePartialTP(trade.id);
            const be = dir === 1 ? trade.entry_price * 1.0005 : trade.entry_price * 0.9995;
            await this.db.updateStopLoss(trade.id, be);
        }

        return { action: 'HOLD', reason: null };
    }

    async closePosition(trade, price, reason) {
        const dir = trade.direction === 'LONG' ? 1 : -1;
        const pnl = (price - trade.entry_price) / trade.entry_price * dir;
        const balance = await this.db.getMockBalance();
        const posVal = trade.quantity * trade.entry_price * CONFIG.USD_INR_RATE;
        const fee = posVal * CONFIG.MOCK_FEE_PCT;
        const pnlInr = (pnl * posVal) - fee;
        await this.db.updateMockBalance(balance + pnlInr);
        await this.db.updateTradeClose(trade.id, price, pnlInr, reason, {
            holdTimeMinutes: (Date.now() - trade.entry_time) / 60000,
            oiAtExit: this.allData[trade.symbol]?.openInterest.openInterest
        });
        return { action: 'CLOSED', reason };
    }

    async handleSignalMode(contexts, crossAssetStatus) {
        for (const symbol of ASSETS) {
            const ctx = contexts[symbol];
            if (!ctx) continue;
            const sustained = await this.getSustainedDuration(symbol);
            if (ctx.accScore.total >= 50 && sustained >= 5 && (ctx.dirSignals.longVotes >= 1 || ctx.dirSignals.shortVotes >= 1)) {
                if (!(await this.db.db.prepare("SELECT id FROM signal_log WHERE symbol = ? AND outcome IS NULL").bind(symbol).first())) {
                    const direction = ctx.dirSignals.longVotes >= 1 ? 'LONG' : 'SHORT';
                    await this.db.logSignal({
                        symbol, direction, accumulationScore: ctx.accScore.total,
                        minutesAccumulating: sustained, crossAssetStatus, entryPrice: ctx.currentPrice,
                        hypotheticalTP: direction === 'LONG' ? ctx.currentPrice * 1.015 : ctx.currentPrice * 0.985,
                        hypotheticalSL: direction === 'LONG' ? ctx.currentPrice * 0.99 : ctx.currentPrice * 1.01,
                        filtersBlocked: 'NONE'
                    });
                }
            }
        }
        const tracking = await this.db.getActiveSignals();
        for (const sig of tracking) {
            const ctx = contexts[sig.symbol];
            if (!ctx) continue;
            const age = (Date.now() - sig.timestamp) / 60000;
            if (age >= 15 && age < 16) await this.db.updateSignalOutcome(sig.id, 'price_after_15m', ctx.currentPrice);
            if (age >= 30 && age < 31) await this.db.updateSignalOutcome(sig.id, 'price_after_30m', ctx.currentPrice);
            if (age >= 45) {
                await this.db.updateSignalOutcome(sig.id, 'price_after_45m', ctx.currentPrice);
                const outcome = sig.direction === 'LONG' ? (ctx.currentPrice > sig.entry_price ? 'WIN' : 'LOSS') : (ctx.currentPrice < sig.entry_price ? 'WIN' : 'LOSS');
                await this.db.finalizeSignal(sig.id, outcome);
            }
        }
    }

    async syncDailyStats() {
        const stats = await this.db.getStats();
        const bal = await this.db.getMockBalance();
        await this.db.updateDailyStats({
            tradesTaken: await this.db.getTodayTradeCount(),
            wins: (await this.db.getTodayTradeCount()) - (await this.db.getTodayLossCount()),
            losses: await this.db.getTodayLossCount(),
            totalPnLInr: stats.totalPnL, peakBalance: bal, mockBalance: bal
        });
    }

    async checkKillSwitches(currentPrice, data) {
        const balance = await this.db.getMockBalance();
        if (await this.db.getTodayLossCount() >= CONFIG.MAX_DAILY_LOSSES) return 'KS1: MAX_LOSSES';
        if ((CONFIG.INITIAL_INR_BALANCE - balance) / CONFIG.INITIAL_INR_BALANCE * 100 >= CONFIG.MAX_DRAWDOWN_PCT) return 'KS2: DRAWDOWN';
        const lastLoss = await this.db.getLastLossTime();
        if (lastLoss && (Date.now() - lastLoss) < CONFIG.COOLDOWN_LOSS_MS) return 'KS3: COOLDOWN';
        if (await this.db.getTodayTradeCount() >= CONFIG.MAX_DAILY_TRADES) return 'KS4: MAX_TRADES';
        if (data.ticker24h?.highPrice && currentPrice >= data.ticker24h.highPrice * (1 - CONFIG.NEAR_EXTREME_PCT)) return 'KS5: NEAR_HIGH';
        if (data.ticker24h?.lowPrice && currentPrice <= data.ticker24h.lowPrice * (1 + CONFIG.NEAR_EXTREME_PCT)) return 'KS6: NEAR_LOW';
        return null;
    }
}
