/**
 * OI Flow Rider v2.0 — Accumulation/Distribution Lifecycle Strategy
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

    // Position Sizing
    RISK_PER_TRADE: 0.01,
    MAX_LEVERAGE: 15,
    SL_ATR_MULT: 1.5,
    SL_MIN_PCT: 0.3,
    SL_MAX_PCT: 1.2,
    TP_ATR_MULT: 2.5,          // wider TP since entering earlier

    // Accumulation Score Thresholds
    ACC_ENTRY_THRESHOLD: 50,    // lowered from 60 to be more inclusive
    ACC_MIN_DURATION_MIN: 5,     // lowered from 8 (was 10)

    // Direction Detection (need 2 of 3)
    TAKER_BIAS_LONG: 1.02,      // lowered from 1.03
    TAKER_BIAS_SHORT: 0.98,     // raised from 0.97
    TOP_TRADER_DELTA_THRESHOLD: 0.003, // lowered from 0.005

    // Entry Transition Triggers
    OI_ACCELERATION_MULT: 1.5,  // lowered from 2.0
    ATR_BREAKOUT_MULT: 1.2,     // lowered from 1.3

    // Distribution Exit Thresholds
    OI_DECEL_CONSECUTIVE: 3,    // 3 min of decelerating OI growth → exit
    OI_DROP_EXIT_PCT: 0.5,      // Loosened from 0.3% to avoid jitter
    VOLUME_OI_DIVERGENCE: 3.0,  // Increased from 1.5x to avoid normal volatility

    // Anti-Trap
    RETAIL_CROWD_LIMIT: 0.85,   // raised from 0.70 as BTC often has high retail bias

    // Kill Switches
    MAX_DAILY_LOSSES: 3,
    MAX_DAILY_TRADES: 8,
    COOLDOWN_AFTER_LOSS_MS: 15 * 60 * 1000,
    COOLDOWN_PER_SYMBOL_MS: 30 * 60 * 1000, // Cooldown after any exit to prevent over-trading
    MAX_ACCOUNT_DRAWDOWN_PCT: 20,
    NEAR_24H_EXTREME_PCT: 0.5,
    TIME_STOP_MINUTES: 45,     // longer since entering from Phase 1

    // Mock Mode
    MOCK_MODE: true,
    INITIAL_INR_BALANCE: 25000,
    USD_INR_RATE: 85,
    MOCK_FEE_PCT: 0.1,
};

// ─── Strategy Service ────────────────────────────────────────────

export class StrategyService {
    constructor(env) {
        this.env = env;
        this.db = null;
        this.allData = null;
    }

    /**
     * Main entry — called every 1-min cron tick.
     * Processes each asset, logs tick data, manages trades.
     */
    async run(db) {
        this.db = db;

        try {
            // 1. Fetch data for all assets
            console.log('[v2.0] Fetching multi-asset data...');
            this.allData = await fetchAllAssetsData();

            // 2. Process each asset: save OI, log tick, evaluate
            const results = {};
            for (const symbol of ASSETS) {
                const data = this.allData[symbol];
                if (!data || !data.ticker24h?.lastPrice) {
                    results[symbol] = { action: 'SKIP', reason: 'No price data' };
                    continue;
                }
                results[symbol] = await this.processAsset(symbol, data);
            }

            // 3. Cleanup old data
            await db.cleanupOldOISnapshots();
            await db.cleanupOldTicks();

            return results;

        } catch (err) {
            console.error('[v2.0] Run error:', err.message, err.stack);
            return { error: err.message };
        }
    }

    /**
     * Process a single asset: save snapshot → compute scores → log tick → act.
     */
    async processAsset(symbol, data) {
        const currentPrice = data.ticker24h.lastPrice;

        // Debug: log what we received
        console.log(`[Process] ${symbol} price=${currentPrice} OI=${JSON.stringify(data.openInterest)} taker=${JSON.stringify(data.takerBuySellRatio)} topTrader=${JSON.stringify(data.topTraderLSRatio)}`);

        // Save OI snapshot
        if (data.openInterest) {
            await this.db.saveOISnapshot(Date.now(), symbol, data.openInterest.openInterest, currentPrice);
            console.log(`[Process] Saved OI snapshot for ${symbol}: ${data.openInterest.openInterest}`);
        } else {
            console.error(`[Process] NO OI data for ${symbol}!`);
        }

        // Compute accumulation score components
        const oiAnalysis = await this.computeOIAnalysis(symbol, data);
        const accScore = this.computeAccumulationScore(symbol, data, oiAnalysis);
        const { atrPct } = computeATR(data.klines5m);

        // Build tick data for logging
        const tickData = {
            symbol,
            price: currentPrice,
            openInterest: data.openInterest?.openInterest || 0,
            oiChange1m: oiAnalysis?.change1m || null,
            oiChange5m: oiAnalysis?.change5m || null,
            oiChange15m: oiAnalysis?.change15m || null,
            accumulationScore: accScore?.total || 0,
            oiTrendConsistency: accScore?.oiTrendConsistency || 0,
            oiAcceleration: accScore?.oiAcceleration || 0,
            absorptionRatio: accScore?.absorptionRatio || 0,
            priceCompression: accScore?.priceCompression || 0,
            takerRatio: data.takerBuySellRatio?.buySellRatio || null,
            topTraderLong: data.topTraderLSRatio?.longAccount || null,
            topTraderDelta: data.topTraderLSRatio?.delta || null,
            retailLong: data.globalLSRatio?.longAccount || null,
            fundingRate: data.funding?.fundingRate || 0,
            atrPct,
            volume15m: sumVolume(data.klines1m, 15),
            direction: null,
            signalFired: false,
            reason: '',
        };

        // Check for active trade on this symbol
        const activeTrade = await this.db.getActiveTrade();
        if (activeTrade && (activeTrade.symbol === symbol || activeTrade.asset === CONFIG.PAIRS[symbol])) {
            const result = await this.manageTrade(activeTrade, data, currentPrice, oiAnalysis, accScore);
            tickData.reason = `MANAGING: ${result.action} — ${result.reason || ''}`;
            await this.db.logTick(tickData);
            return result;
        }

        // Check for cooldown (don't enter immediately after an exit)
        const lastTrade = await this.db.db.prepare(
            "SELECT timestamp, exit_price FROM trade_logs WHERE symbol = ? AND status = 'CLOSED' ORDER BY timestamp DESC LIMIT 1"
        ).bind(symbol).first();
        if (lastTrade) {
            const timeSinceExit = Date.now() - lastTrade.timestamp;
            if (timeSinceExit < CONFIG.COOLDOWN_PER_SYMBOL_MS) {
                const waitMin = ((CONFIG.COOLDOWN_PER_SYMBOL_MS - timeSinceExit) / 60000).toFixed(1);
                tickData.reason = `COOLDOWN: ${waitMin} min remaining for ${symbol}`;
                await this.db.logTick(tickData);
                return { action: 'SKIP', reason: `Cooldown active (${waitMin}m)`, symbol };
            }
        }

        // Skip entry evaluation if another asset already has an active trade
        if (activeTrade) {
            tickData.reason = `BLOCKED: Active trade on ${activeTrade.symbol || activeTrade.asset}`;
            await this.db.logTick(tickData);
            return { action: 'SKIP', reason: `Active trade on other asset`, symbol };
        }

        // Evaluate entry
        const entryResult = await this.evaluateEntry(symbol, data, currentPrice, oiAnalysis, accScore, tickData);
        tickData.direction = entryResult.direction || null;
        tickData.signalFired = entryResult.action === 'TRADE_OPENED';
        tickData.reason = entryResult.reason || entryResult.action;
        await this.db.logTick(tickData);

        return entryResult;
    }

    // ─── OI Analysis ─────────────────────────────────────────────

    async computeOIAnalysis(symbol, data) {
        const currentOI = data.openInterest?.openInterest;
        if (!currentOI) return null;

        const snap1m = await this.db.getOISnapshotAt(symbol, 1);
        const snap5m = await this.db.getOISnapshotAt(symbol, 5);
        const snap15m = await this.db.getOISnapshotAt(symbol, 15);

        const change1m = snap1m ? ((currentOI - snap1m.open_interest) / snap1m.open_interest) * 100 : null;
        const change5m = snap5m ? ((currentOI - snap5m.open_interest) / snap5m.open_interest) * 100 : null;
        const change15m = snap15m ? ((currentOI - snap15m.open_interest) / snap15m.open_interest) * 100 : null;

        // Get all snapshots for trend/acceleration analysis
        const snapshots = await this.db.getOISnapshots(symbol, 20);

        // OI growth rate: last 5 min vs previous 5 min
        let recentROC = null, olderROC = null;
        if (snapshots.length >= 10) {
            const mid = Math.floor(snapshots.length / 2);
            const recentHalf = snapshots.slice(mid);
            const olderHalf = snapshots.slice(0, mid);
            if (recentHalf.length >= 2 && olderHalf.length >= 2) {
                const recentFirst = recentHalf[0].open_interest;
                const recentLast = recentHalf[recentHalf.length - 1].open_interest;
                recentROC = recentFirst > 0 ? ((recentLast - recentFirst) / recentFirst) * 100 : 0;

                const olderFirst = olderHalf[0].open_interest;
                const olderLast = olderHalf[olderHalf.length - 1].open_interest;
                olderROC = olderFirst > 0 ? ((olderLast - olderFirst) / olderFirst) * 100 : 0;
            }
        }

        return { currentOI, change1m, change5m, change15m, snapshots, recentROC, olderROC };
    }

    // ─── Accumulation Score (0-100) ──────────────────────────────

    computeAccumulationScore(symbol, data, oiAnalysis) {
        if (!oiAnalysis || !oiAnalysis.snapshots || oiAnalysis.snapshots.length < 5) {
            return { total: 0, oiTrendConsistency: 0, oiAcceleration: 0, absorptionRatio: 0, priceCompression: 0 };
        }

        // 1. OI Trend Consistency (0-25)
        //    Handle stale 5m data: only count whenever the OI actually changes
        const last15 = oiAnalysis.snapshots.slice(-Math.min(15, oiAnalysis.snapshots.length));
        let positiveCount = 0;
        let changeCount = 0;
        for (let i = 1; i < last15.length; i++) {
            if (last15[i].open_interest > last15[i - 1].open_interest) {
                positiveCount++;
                changeCount++;
            } else if (last15[i].open_interest < last15[i - 1].open_interest) {
                changeCount++;
            }
        }
        const consistencyRatio = changeCount > 0 ? positiveCount / changeCount : 0;
        // If it moves, it should move UP. 
        const oiTrendConsistency = consistencyRatio >= 0.6
            ? Math.min(consistencyRatio * 25, 25)
            : 0;

        // 2. OI Acceleration (0-25)
        //    Compare recent ROC vs older ROC
        let oiAcceleration = 0;
        if (oiAnalysis.recentROC !== null && oiAnalysis.olderROC !== null) {
            if (oiAnalysis.recentROC > 0 && oiAnalysis.olderROC > 0) {
                if (oiAnalysis.recentROC > oiAnalysis.olderROC * 1.5) {
                    oiAcceleration = 25; // accelerating
                } else if (oiAnalysis.recentROC >= oiAnalysis.olderROC * 0.8) {
                    oiAcceleration = 15; // steady growth
                }
                // else decelerating → 0
            } else if (oiAnalysis.recentROC > 0) {
                oiAcceleration = 15; // growing but no prior to compare
            }
        }

        // 3. Absorption Ratio (0-25)
        //    volume_15min / abs(price_change_15min) vs 1-hour baseline
        const vol15m = sumVolume(data.klines1m, 15);
        const priceChg15m = Math.abs(priceChange(data.klines1m, 15));
        const vol60m = sumVolume(data.klines1m, Math.min(data.klines1m.length, 60));
        const priceChg60m = Math.abs(priceChange(data.klines1m, Math.min(data.klines1m.length - 1, 60)));

        let absorptionRatio = 0;
        if (priceChg15m > 0.0001 && priceChg60m > 0.0001 && vol60m > 0) { // lowered from 0.001
            const currentAbsorption = vol15m / priceChg15m;
            const baselineAbsorption = vol60m / priceChg60m;
            if (baselineAbsorption > 0) {
                const ratio = currentAbsorption / baselineAbsorption;
                // ratio > 1.2 means absorption is significantly higher than avg
                absorptionRatio = ratio > 1 ? Math.min((ratio - 1) * 20, 25) : 0;
            }
        }

        // 4. Price Compression (0-25)
        //    Current 5m ATR vs 5m ATR from 1 hour ago
        const currentATR = computeATR(data.klines5m);
        const olderATR = computeATRAtOffset(data.klines5m_older || data.klines5m, 12); // ~1hr ago

        let priceCompression = 0;
        if (olderATR.atrPct > 0 && currentATR.atrPct > 0) {
            const atrRatio = currentATR.atrPct / olderATR.atrPct;
            const oiGrowing = oiAnalysis.change15m !== null && oiAnalysis.change15m >= 0;
            if (atrRatio < 0.8 && oiGrowing) { // loosened from 0.7
                priceCompression = 25;
            } else if (atrRatio < 0.9 && oiGrowing) {
                priceCompression = 15;
            } else if (atrRatio < 1.05 && oiGrowing) { // loosened from 1.0
                priceCompression = 10;
            }
        }

        const total = oiTrendConsistency + oiAcceleration + absorptionRatio + priceCompression;
        return {
            total: Math.min(total, 100),
            oiTrendConsistency: parseFloat(oiTrendConsistency.toFixed(1)),
            oiAcceleration,
            absorptionRatio: parseFloat(absorptionRatio.toFixed(1)),
            priceCompression,
        };
    }

    // ─── Direction Detection ─────────────────────────────────────

    detectDirection(data) {
        let longVotes = 0, shortVotes = 0;
        const signals = {};

        // Signal 1: Taker Bias
        const taker = data.takerBuySellRatio;
        if (taker) {
            if (taker.buySellRatio >= CONFIG.TAKER_BIAS_LONG) { longVotes++; signals.taker = 'long'; }
            else if (taker.buySellRatio <= CONFIG.TAKER_BIAS_SHORT) { shortVotes++; signals.taker = 'short'; }
            else { signals.taker = 'neutral'; }
        }

        // Signal 2: Price Drift (linear regression of last 15 1m candles)
        const slope = linearRegressionSlope(data.klines1m, 15);
        if (slope > 0.01) { longVotes++; signals.priceDrift = 'long'; }
        else if (slope < -0.01) { shortVotes++; signals.priceDrift = 'short'; }
        else { signals.priceDrift = 'neutral'; }
        signals.priceDriftSlope = parseFloat(slope.toFixed(5));

        // Signal 3: Top Trader Shift
        const topTrader = data.topTraderLSRatio;
        if (topTrader) {
            if (topTrader.delta >= CONFIG.TOP_TRADER_DELTA_THRESHOLD) { longVotes++; signals.topTrader = 'long'; }
            else if (topTrader.delta <= -CONFIG.TOP_TRADER_DELTA_THRESHOLD) { shortVotes++; signals.topTrader = 'short'; }
            else { signals.topTrader = 'neutral'; }
        }

        let direction = null;
        if (longVotes >= 2) direction = 'long';
        else if (shortVotes >= 2) direction = 'short';

        return { direction, longVotes, shortVotes, signals };
    }

    // ─── Entry Evaluation ────────────────────────────────────────

    async evaluateEntry(symbol, data, currentPrice, oiAnalysis, accScore, tickData) {
        // Kill switches
        const killCheck = await this.checkKillSwitches(currentPrice, data);
        if (killCheck) return { action: 'NO_SIGNAL', reason: killCheck, symbol };

        // Need accumulation score ≥ threshold
        if (accScore.total < CONFIG.ACC_ENTRY_THRESHOLD) {
            return {
                action: 'NO_SIGNAL',
                reason: `Accumulation score too low: ${accScore.total.toFixed(0)}/100 (need ${CONFIG.ACC_ENTRY_THRESHOLD})`,
                symbol, accScore: accScore.total,
            };
        }

        // Check if accumulation has been sustained (≥10 min)
        const recentTicks = await this.db.getRecentTicks(symbol, 10);
        const sustainedCount = recentTicks.filter(t => (t.accumulation_score || 0) >= CONFIG.ACC_ENTRY_THRESHOLD).length;

        // Diagnostic string for transition triggers
        const rocInfo = `ROC: ${oiAnalysis?.recentROC?.toFixed(4)} vs ${oiAnalysis?.olderROC?.toFixed(4)}`;
        const currentATR = computeATR(data.klines5m);
        const olderATR = computeATRAtOffset(data.klines5m_older || data.klines5m, 12);
        const transitionStatus = (oiAnalysis?.recentROC > 0 && oiAnalysis?.recentROC >= (oiAnalysis?.olderROC || 0) * CONFIG.OI_ACCELERATION_MULT)
            ? "TRIG:OI_ACC"
            : (olderATR.atrPct > 0 && currentATR.atrPct >= olderATR.atrPct * CONFIG.ATR_BREAKOUT_MULT) ? "TRIG:ATR_BO" : "WAIT:TRIG";

        if (sustainedCount < CONFIG.ACC_MIN_DURATION_MIN) {
            return {
                action: 'NO_SIGNAL',
                reason: `Acc: ${sustainedCount}/${CONFIG.ACC_MIN_DURATION_MIN} min >${CONFIG.ACC_ENTRY_THRESHOLD} | ${transitionStatus} | ${rocInfo}`,
                symbol, accScore: accScore.total
            };
        }

        // Detect transition trigger: OI acceleration OR ATR breakout
        let transitionTriggered = false;
        let transitionReason = '';

        // Trigger 1: OI growth rate doubles (acceleration)
        if (oiAnalysis?.recentROC !== null && oiAnalysis?.olderROC !== null && oiAnalysis.olderROC > 0) {
            if (oiAnalysis.recentROC >= oiAnalysis.olderROC * CONFIG.OI_ACCELERATION_MULT) {
                transitionTriggered = true;
                transitionReason = `OI acceleration: ${oiAnalysis.recentROC.toFixed(3)}% vs ${oiAnalysis.olderROC.toFixed(3)}%`;
            }
        }

        // Trigger 2: ATR breakout from compression
        if (!transitionTriggered) {
            const currentATR = computeATR(data.klines5m);
            const olderATR = computeATRAtOffset(data.klines5m_older || data.klines5m, 12);
            if (olderATR.atrPct > 0 && currentATR.atrPct > olderATR.atrPct * CONFIG.ATR_BREAKOUT_MULT) {
                transitionTriggered = true;
                transitionReason = `ATR breakout: ${currentATR.atrPct.toFixed(3)}% vs ${olderATR.atrPct.toFixed(3)}% compressed`;
            }
        }

        if (!transitionTriggered) {
            return {
                action: 'NO_SIGNAL',
                reason: `Accumulating (${accScore.total.toFixed(0)}/100, ${sustainedCount}min) but no transition trigger yet`,
                symbol, accScore: accScore.total,
            };
        }

        // Direction: need 2 of 3 signals
        const dirResult = this.detectDirection(data);
        if (!dirResult.direction) {
            return {
                action: 'NO_SIGNAL',
                reason: `Transition triggered but no direction consensus (L:${dirResult.longVotes} S:${dirResult.shortVotes})`,
                symbol, accScore: accScore.total, direction: null,
            };
        }

        // Anti-trap: retail crowding
        const trapCheck = this.checkAntiTrap(dirResult.direction, data);
        if (trapCheck) {
            return { action: 'NO_SIGNAL', reason: trapCheck, symbol, direction: dirResult.direction };
        }

        // Build and execute trade
        const signal = this.buildSignal(symbol, dirResult.direction, currentPrice, data, accScore, oiAnalysis, dirResult, transitionReason);
        return await this.executeTrade(signal);
    }

    // ─── Kill Switches ──────────────────────────────────────────

    async checkKillSwitches(currentPrice, data) {
        const todayLosses = await this.db.getTodayLossCount();
        if (todayLosses >= CONFIG.MAX_DAILY_LOSSES)
            return `KS1: ${todayLosses} losses today (max ${CONFIG.MAX_DAILY_LOSSES})`;

        const balance = await this.db.getMockBalance();
        const peakBalance = parseFloat(await this.db.getSetting('peak_balance', CONFIG.INITIAL_INR_BALANCE.toString()));
        if (peakBalance > 0) {
            const dd = ((peakBalance - balance) / peakBalance) * 100;
            if (dd >= CONFIG.MAX_ACCOUNT_DRAWDOWN_PCT)
                return `KS2: Drawdown ${dd.toFixed(1)}% (max ${CONFIG.MAX_ACCOUNT_DRAWDOWN_PCT}%)`;
        }

        const lastLoss = await this.db.getLastLossTime();
        if (lastLoss && (Date.now() - lastLoss) < CONFIG.COOLDOWN_AFTER_LOSS_MS) {
            const remain = Math.ceil((CONFIG.COOLDOWN_AFTER_LOSS_MS - (Date.now() - lastLoss)) / 60000);
            return `KS3: Cooldown (${remain} min left)`;
        }

        const todayCount = await this.db.getTodayTradeCount();
        if (todayCount >= CONFIG.MAX_DAILY_TRADES)
            return `KS4: ${todayCount} trades today (max ${CONFIG.MAX_DAILY_TRADES})`;

        const ticker = data.ticker24h;
        if (ticker && ticker.highPrice > 0) {
            const distHigh = ((ticker.highPrice - currentPrice) / ticker.highPrice) * 100;
            const distLow = ((currentPrice - ticker.lowPrice) / ticker.lowPrice) * 100;
            if (distHigh < CONFIG.NEAR_24H_EXTREME_PCT) return `KS5: Near 24h high (${distHigh.toFixed(2)}%)`;
            if (distLow < CONFIG.NEAR_24H_EXTREME_PCT) return `KS5: Near 24h low (${distLow.toFixed(2)}%)`;
        }

        return null;
    }

    checkAntiTrap(direction, data) {
        const global = data.globalLSRatio;
        if (!global) return null;
        if (direction === 'long' && global.longAccount >= CONFIG.RETAIL_CROWD_LIMIT)
            return `Anti-trap: ${(global.longAccount * 100).toFixed(1)}% retail long (limit: ${CONFIG.RETAIL_CROWD_LIMIT * 100}%)`;
        if (direction === 'short' && global.shortAccount >= CONFIG.RETAIL_CROWD_LIMIT)
            return `Anti-trap: ${(global.shortAccount * 100).toFixed(1)}% retail short`;
        return null;
    }

    // ─── Signal Building & Execution ─────────────────────────────

    buildSignal(symbol, direction, currentPrice, data, accScore, oiAnalysis, dirResult, transitionReason) {
        const { atrPct } = computeATR(data.klines5m);
        let slPct = CONFIG.SL_ATR_MULT * atrPct;
        slPct = Math.max(slPct, CONFIG.SL_MIN_PCT);
        slPct = Math.min(slPct, CONFIG.SL_MAX_PCT);
        const tpPct = CONFIG.TP_ATR_MULT * atrPct;

        const isLong = direction === 'long';
        const slPrice = isLong ? currentPrice * (1 - slPct / 100) : currentPrice * (1 + slPct / 100);
        const tpPrice = isLong ? currentPrice * (1 + tpPct / 100) : currentPrice * (1 - tpPct / 100);

        return {
            symbol, direction,
            decision: isLong ? 'BUY' : 'SELL',
            entry: currentPrice,
            stopLoss: parseFloat(slPrice.toFixed(2)),
            takeProfit: parseFloat(tpPrice.toFixed(2)),
            slPct, tpPct, atrPct,
            accumulationScore: accScore.total,
            absorptionRatio: accScore.absorptionRatio,
            priceCompression: accScore.priceCompression,
            oiChange5m: oiAnalysis?.change5m,
            oiAtEntry: oiAnalysis?.currentOI,
            topTraderRatio: data.topTraderLSRatio?.longShortRatio,
            takerRatio: data.takerBuySellRatio?.buySellRatio,
            transitionReason,
            directionSignals: dirResult.signals,
        };
    }

    async executeTrade(signal) {
        const posInfo = await this.calculateQuantity(signal.entry, signal.slPct);
        if (!posInfo || posInfo.qty <= 0) {
            return { action: 'NO_SIGNAL', reason: 'Position size too small', symbol: signal.symbol };
        }

        const { qty, leverage } = posInfo;
        const pair = CONFIG.PAIRS[signal.symbol];
        let orderId;

        if (CONFIG.MOCK_MODE) {
            orderId = `MOCK_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const entryValueInr = qty * signal.entry * CONFIG.USD_INR_RATE;
            const fee = entryValueInr * (CONFIG.MOCK_FEE_PCT / 100);
            const bal = await this.db.getMockBalance();
            await this.db.updateMockBalance(bal - fee);
            console.log(`[Mock] ${signal.decision} ${qty} ${signal.symbol} @ ${signal.entry} | AccScore: ${signal.accumulationScore.toFixed(0)} | ${signal.transitionReason}`);
        } else {
            try {
                const side = signal.decision === 'BUY' ? 'buy' : 'sell';
                const result = await placeOrder(this.env, pair, side, qty, leverage, signal.stopLoss, signal.takeProfit);
                orderId = result?.orders?.[0]?.id || `LIVE_${Date.now()}`;
            } catch (err) {
                return { action: 'ERROR', reason: 'Order failed: ' + err.message };
            }
        }

        const entryValueInr = qty * signal.entry * CONFIG.USD_INR_RATE;
        const reason = `v2.0 Entry: AccScore ${signal.accumulationScore.toFixed(0)}/100 | ${signal.transitionReason} | Dir: ${signal.direction} (${JSON.stringify(signal.directionSignals)})`;

        // Compute how long accumulation has been building
        const recentTicks = await this.db.getRecentTicks(signal.symbol, 60);
        const accTicks = recentTicks.filter(t => (t.accumulation_score || 0) >= CONFIG.ACC_ENTRY_THRESHOLD).length;

        await this.db.logTrade({
            decision: signal.decision, reason,
            asset: pair, entry: signal.entry,
            quantity: qty, leverage,
            stopLoss: signal.stopLoss, takeProfit: signal.takeProfit,
            status: 'OPEN', orderId, entryValueInr,
            atrPct: signal.atrPct, supportingModules: 0,
            moduleStates: JSON.stringify(signal.directionSignals),
            entryTime: Date.now(),
            oiChange5m: signal.oiChange5m,
            oiAtEntry: signal.oiAtEntry,
            topTraderRatio: signal.topTraderRatio,
            takerRatio: signal.takerRatio,
            accumulationScore: signal.accumulationScore,
            accumulationDurationMin: accTicks,
            absorptionRatio: signal.absorptionRatio,
            priceCompression: signal.priceCompression,
            signalsAtEntry: JSON.stringify(signal.directionSignals),
            symbol: signal.symbol,
        });

        return {
            action: 'TRADE_OPENED', symbol: signal.symbol,
            direction: signal.direction, entry: signal.entry,
            stopLoss: signal.stopLoss, takeProfit: signal.takeProfit,
            quantity: qty, leverage, orderId,
            accumulationScore: signal.accumulationScore,
            transition: signal.transitionReason,
        };
    }

    async calculateQuantity(entryPrice, slPct) {
        let balance;
        if (CONFIG.MOCK_MODE) {
            balance = (await this.db.getMockBalance()) / CONFIG.USD_INR_RATE;
        } else {
            // TODO: fetch from CoinDCX
            balance = 100;
        }
        if (balance <= 0 || entryPrice <= 0 || slPct <= 0) return null;
        const riskAmount = balance * CONFIG.RISK_PER_TRADE;
        const positionValue = riskAmount / (slPct / 100);
        let leverage = Math.min(positionValue / balance, CONFIG.MAX_LEVERAGE);
        leverage = Math.max(Math.floor(leverage), 1);
        const qty = positionValue / entryPrice;
        // Round qty appropriately for asset
        const roundedQty = entryPrice > 100 ? parseFloat(qty.toFixed(4)) : Math.floor(qty);
        if (roundedQty <= 0) return null;
        return { qty: roundedQty, leverage };
    }

    // ─── Trade Management (Distribution Detection) ───────────────

    async manageTrade(activeTrade, data, currentPrice, oiAnalysis, accScore) {
        const entryPrice = activeTrade.price;
        const isLong = activeTrade.decision === 'BUY';
        const isMock = (activeTrade.order_id || '').startsWith('MOCK_');
        const entryTime = activeTrade.entry_time || activeTrade.timestamp;
        const holdTimeMs = Date.now() - entryTime;
        const holdTimeMin = holdTimeMs / 60000;
        const symbol = activeTrade.symbol || 'BTCUSDT';

        const priceChangePct = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
        const { atrPct } = computeATR(data.klines5m);
        const profitInATR = atrPct > 0 ? priceChangePct / atrPct : 0;

        const exitAnalytics = {
            oiAtExit: oiAnalysis?.currentOI,
            oiDeceleration: null,
            signalsAtExit: null,
        };

        console.log(`[Manage] ${symbol} | Hold: ${holdTimeMin.toFixed(1)}min | PnL: ${priceChangePct.toFixed(3)}% (${profitInATR.toFixed(2)} ATR) | Price: ${currentPrice}`);

        // ── Exit 1: Hard Stop Loss ──
        if ((isLong && currentPrice <= activeTrade.stop_loss) || (!isLong && currentPrice >= activeTrade.stop_loss)) {
            return this.exitTrade(activeTrade, currentPrice, 'Hard stop loss hit', isMock, isLong, entryPrice, holdTimeMs, exitAnalytics);
        }

        // ── Exit 2: Take Profit ──
        if ((isLong && currentPrice >= activeTrade.take_profit) || (!isLong && currentPrice <= activeTrade.take_profit)) {
            return this.exitTrade(activeTrade, currentPrice, 'Take profit hit', isMock, isLong, entryPrice, holdTimeMs, exitAnalytics);
        }

        // ── Exit 3: OI Deceleration (3 consecutive minutes) ──
        if (oiAnalysis?.snapshots?.length >= 5) {
            const recent = oiAnalysis.snapshots.slice(-4);
            let decelerating = true;
            let prevGrowth = null;
            for (let i = 1; i < recent.length; i++) {
                const growth = recent[i].open_interest - recent[i - 1].open_interest;
                if (prevGrowth !== null && growth >= prevGrowth) {
                    decelerating = false;
                    break;
                }
                prevGrowth = growth;
            }
            if (decelerating && priceChangePct > 0) {
                exitAnalytics.oiDeceleration = 'consecutive_decel';
                return this.exitTrade(activeTrade, currentPrice,
                    `Distribution: OI decelerating for ${CONFIG.OI_DECEL_CONSECUTIVE}+ min while in profit`,
                    isMock, isLong, entryPrice, holdTimeMs, exitAnalytics);
            }
        }

        // ── Exit 4: OI Drop (urgent — positions closing) ──
        if (oiAnalysis?.snapshots?.length >= 3) {
            const threeMinAgo = oiAnalysis.snapshots[oiAnalysis.snapshots.length - 3];
            const current = oiAnalysis.currentOI;
            if (threeMinAgo && current < threeMinAgo.open_interest) {
                const dropPct = ((threeMinAgo.open_interest - current) / threeMinAgo.open_interest) * 100;
                if (dropPct >= CONFIG.OI_DROP_EXIT_PCT) {
                    exitAnalytics.oiDeceleration = `drop_${dropPct.toFixed(3)}%`;
                    return this.exitTrade(activeTrade, currentPrice,
                        `Distribution: OI dropped ${dropPct.toFixed(3)}% in 3 min — active closing`,
                        isMock, isLong, entryPrice, holdTimeMs, exitAnalytics);
                }
            }
        }

        // ── Exit 5: Volume Without OI Growth (closing, not opening) ──
        if (oiAnalysis && data.klines1m?.length >= 15) {
            const recentVol = sumVolume(data.klines1m, 3);
            const avgVol = (sumVolume(data.klines1m, 15) / 15) * 3; // 3-min average normalized from 15-min baseline
            const oiFlat = oiAnalysis.change5m !== null && Math.abs(oiAnalysis.change5m) < 0.1;

            // Only exit on blow-off tops (significant volume + flat OI + in profit)
            if (avgVol > 0 && recentVol > avgVol * CONFIG.VOLUME_OI_DIVERGENCE && oiFlat && priceChangePct > 0.3) {
                return this.exitTrade(activeTrade, currentPrice,
                    `Distribution: Volume spike (${(recentVol / avgVol).toFixed(1)}×) without OI growth — positions closing`,
                    isMock, isLong, entryPrice, holdTimeMs, exitAnalytics);
            }
        }

        // ── Exit 6: Absorption Flip ──
        // Earlier: high volume + flat price. Now: price moving + low volume
        if (accScore && accScore.absorptionRatio < 5 && Math.abs(priceChangePct) > 0.5 && holdTimeMin > 5) {
            // Absorption has dropped — no one absorbing anymore
            const recentVol = sumVolume(data.klines1m, 3);
            const avgVol = sumVolume(data.klines1m, Math.min(data.klines1m.length, 10)) / 3;
            if (avgVol > 0 && recentVol < avgVol * 0.6) {
                return this.exitTrade(activeTrade, currentPrice,
                    `Absorption flip: price moving but volume dropping — momentum exhausting`,
                    isMock, isLong, entryPrice, holdTimeMs, exitAnalytics);
            }
        }

        // ── Exit 7: Time Stop ──
        if (holdTimeMin >= CONFIG.TIME_STOP_MINUTES) {
            return this.exitTrade(activeTrade, currentPrice,
                `Time stop: ${holdTimeMin.toFixed(1)} min (max ${CONFIG.TIME_STOP_MINUTES})`,
                isMock, isLong, entryPrice, holdTimeMs, exitAnalytics);
        }

        // ── Profit Management: Partial TP at +1.5 ATR ──
        const partialClosed = activeTrade.partial_closed_pct || 0;
        if (partialClosed === 0 && profitInATR >= 1.5) {
            await this.partialClose(activeTrade, currentPrice, 50, isMock, isLong, entryPrice);
            return { action: 'PARTIAL_CLOSE', reason: `50% closed at +${profitInATR.toFixed(2)} ATR`, symbol };
        }

        return {
            action: 'HOLDING', symbol,
            pnlPct: priceChangePct.toFixed(3),
            profitATR: profitInATR.toFixed(2),
            holdTimeMin: holdTimeMin.toFixed(1),
            accScore: accScore?.total?.toFixed(0),
            reason: 'Holding',
        };
    }

    async exitTrade(activeTrade, exitPrice, reason, isMock, isLong, entryPrice, holdTimeMs, exitAnalytics = {}) {
        const priceChangePct = ((exitPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
        const leverage = activeTrade.leverage || 1;
        const leveragedPnl = priceChangePct * leverage;
        const entryValueInr = activeTrade.entry_value_inr || 0;

        // FIX: pnlInr should depend on priceChangePct and entryValue (already has leverage in it)
        // OR: (entryValueInr / leverage) * (leveragedPnl / 100)
        // Corrected: Just use the leveraged PnL % on the actual capital used (entryValueInr / leverage)
        const capitalInr = entryValueInr / leverage;
        const pnlInr = capitalInr * (leveragedPnl / 100);

        const exitFee = isMock ? (entryValueInr * (CONFIG.MOCK_FEE_PCT / 100)) : 0;
        const netPnlInr = pnlInr - exitFee;
        const symbol = activeTrade.symbol || 'BTCUSDT';

        console.log(`[Exit] ${symbol} | ${reason} | PnL: ${leveragedPnl.toFixed(3)}% (₹${netPnlInr.toFixed(2)}) | Hold: ${(holdTimeMs / 60000).toFixed(1)} min`);

        if (!isMock) {
            try {
                const pair = CONFIG.PAIRS[symbol] || activeTrade.asset;
                const closeSide = isLong ? 'sell' : 'buy';
                await closePartialPosition(this.env, pair, closeSide, activeTrade.quantity, activeTrade.leverage);
            } catch (err) {
                console.error('[Exit] Close error:', err.message);
            }
        }

        if (isMock) {
            const bal = await this.db.getMockBalance();
            const partialFactor = (100 - (activeTrade.partial_closed_pct || 0)) / 100;
            const newBal = bal + (netPnlInr * partialFactor);
            await this.db.updateMockBalance(newBal);
            const peak = parseFloat(await this.db.getSetting('peak_balance', CONFIG.INITIAL_INR_BALANCE.toString()));
            if (newBal > peak) await this.db.updateSetting('peak_balance', newBal.toFixed(2));
        }

        exitAnalytics.signalsAtExit = JSON.stringify({
            taker: this.allData?.[symbol]?.takerBuySellRatio?.buySellRatio,
            topTrader: this.allData?.[symbol]?.topTraderLSRatio?.longAccount,
            retail: this.allData?.[symbol]?.globalLSRatio?.longAccount,
        });

        await this.db.updateTradeClose(
            activeTrade.order_id, 'CLOSED', exitPrice, leveragedPnl, reason,
            entryValueInr + netPnlInr, netPnlInr, Math.round(holdTimeMs / 1000),
            exitAnalytics
        );

        return {
            action: 'TRADE_CLOSED', symbol, reason,
            pnlPct: leveragedPnl.toFixed(3), pnlInr: netPnlInr.toFixed(2),
            holdTimeMin: (holdTimeMs / 60000).toFixed(1),
        };
    }

    async partialClose(activeTrade, currentPrice, closePct, isMock, isLong, entryPrice) {
        const qty = entryPrice > 100
            ? parseFloat((activeTrade.quantity * closePct / 100).toFixed(4))
            : Math.floor(activeTrade.quantity * closePct / 100);
        if (qty <= 0) return;

        const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1) * (activeTrade.leverage || 1);
        const partialPnl = (activeTrade.entry_value_inr || 0) * (closePct / 100) * (pnlPct / 100);

        if (!isMock) {
            try {
                const symbol = activeTrade.symbol || 'BTCUSDT';
                const pair = CONFIG.PAIRS[symbol] || activeTrade.asset;
                await closePartialPosition(this.env, pair, isLong ? 'sell' : 'buy', qty, activeTrade.leverage);
            } catch (err) {
                console.error('[Partial] error:', err.message);
            }
        }

        if (isMock) {
            const fee = Math.abs(partialPnl) * (CONFIG.MOCK_FEE_PCT / 100);
            const bal = await this.db.getMockBalance();
            await this.db.updateMockBalance(bal + partialPnl - fee);
        }

        await this.db.updatePartialClose(activeTrade.order_id, (activeTrade.partial_closed_pct || 0) + closePct);
    }
}
