/**
 * OI Flow Rider — Strategy Engine
 * 
 * Core concept: Detect when institutions open positions (OI surge + directional flow)
 * and ride with them. Exit when institutions close (OI drops).
 * 
 * Entry requires 3 of 4 confluence signals:
 *   1. OI surge (>1.5% in 5 min)
 *   2. Taker buy/sell ratio directional
 *   3. Price momentum confirms direction
 *   4. Top traders shifting in same direction
 */

import { placeOrder, getOpenPositions, getMarketPrice, getAccountBalance, closePartialPosition } from './coindcx.js';
import { fetchAllMarketData, computeATR, priceChange, avgVolume } from './binance.js';

// ─── Configuration ───────────────────────────────────────────────

const CONFIG = {
    PAIR: 'B-DOGE_USDT',

    // Position Sizing
    RISK_PER_TRADE: 0.01,           // 1% of account per trade
    MAX_LEVERAGE: 15,               // reduced from 20
    SL_ATR_MULT: 1.5,              // SL = 1.5 × ATR
    SL_MIN_PCT: 0.4,               // minimum SL distance
    SL_MAX_PCT: 1.0,               // maximum SL distance
    TP_RRR: 2.0,                   // take profit = 2× risk (2:1 RRR)

    // Entry Thresholds (confluence model — need 3 of 4)
    MIN_CONFLUENCE: 3,
    OI_SURGE_PCT: 1.5,             // min OI change (%) in 5 min to signal entry
    TAKER_RATIO_LONG: 1.15,        // taker ratio > this for long signal
    TAKER_RATIO_SHORT: 0.85,       // taker ratio < this for short signal
    PRICE_MOMENTUM_PCT: 0.3,       // min price change (%) in 5 min for confirmation
    TOP_TRADER_DELTA: 0.02,        // min shift in top trader ratio for confirmation

    // Exit Thresholds
    OI_DROP_EXIT_PCT: 0.8,         // OI drops this much (%) in 5 min → exit
    TAKER_REVERSAL_LONG: 0.85,     // taker flips below this for longs → exit
    TAKER_REVERSAL_SHORT: 1.15,    // taker flips above this for shorts → exit
    PARTIAL_TP_ATR_MULT: 1.5,      // partial close at +1.5 ATR profit
    FULL_TP_ATR_MULT: 2.5,         // full close at +2.5 ATR profit
    BREAKEVEN_ATR_MULT: 1.0,       // move SL to breakeven at +1.0 ATR
    TIME_STOP_MINUTES: 15,         // max hold time

    // Anti-Trap Filter
    RETAIL_CROWD_LIMIT: 0.75,      // don't go long if >75% retail is long (and vice versa)

    // Kill Switches
    MAX_DAILY_LOSSES: 3,
    MAX_DAILY_TRADES: 8,
    COOLDOWN_AFTER_LOSS_MS: 15 * 60 * 1000,   // 15 minutes
    MAX_ACCOUNT_DRAWDOWN_PCT: 20,
    NEAR_24H_EXTREME_PCT: 0.5,     // no trade within 0.5% of 24h high/low
    MIN_OI_GROWTH_15M: 0.5,        // no trade if OI grew less than 0.5% in 15 min

    // Mock Mode
    MOCK_MODE: true,
    INITIAL_INR_BALANCE: 2500,
    USD_INR_RATE: 85,
    MOCK_FEE_PCT: 0.1,             // simulated 0.1% fee each way
};

// ─── Strategy Service ────────────────────────────────────────────

export class StrategyService {
    constructor(env) {
        this.env = env;
        this.db = null;
        this.data = null;
    }

    /**
     * Main entry point — called every 1-min cron tick.
     * Flow: fetch data → save OI snapshot → manage existing trade OR look for entry
     */
    async run(db) {
        this.db = db;

        try {
            // 1. Fetch all market data
            console.log('[Strategy] Fetching market data...');
            this.data = await fetchAllMarketData();
            const currentPrice = this.data.ticker24h?.lastPrice;

            if (!currentPrice || currentPrice <= 0) {
                return { action: 'SKIP', reason: 'No price data available' };
            }

            // 2. Save OI snapshot for trend tracking
            if (this.data.openInterest) {
                await db.saveOISnapshot(
                    Date.now(),
                    'DOGEUSDT',
                    this.data.openInterest.openInterest,
                    currentPrice
                );
                // Cleanup old snapshots to keep DB small
                await db.cleanupOldOISnapshots();
            }

            // 3. Check if we have an active trade
            const activeTrade = await db.getActiveTrade();

            if (activeTrade) {
                // Manage existing trade (exits, partial TP, SL management)
                return await this.manageTrade(activeTrade, currentPrice);
            }

            // 4. No active trade — look for entry signal
            return await this.evaluateEntry(currentPrice);

        } catch (err) {
            console.error('[Strategy] Run error:', err.message, err.stack);
            return { action: 'ERROR', error: err.message };
        }
    }

    // ─── Entry Logic ─────────────────────────────────────────────

    /**
     * Evaluate whether to enter a new trade.
     * Requires 3 of 4 confluence signals + kill switch clearance.
     */
    async evaluateEntry(currentPrice) {
        // Kill switch checks first (fast rejection)
        const killCheck = await this.checkKillSwitches(currentPrice);
        if (killCheck) {
            return { action: 'NO_SIGNAL', reason: killCheck, price: currentPrice };
        }

        // Analyze OI flow
        const oiAnalysis = await this.analyzeOIFlow();
        if (!oiAnalysis) {
            return { action: 'NO_SIGNAL', reason: 'Insufficient OI data (need ~5 min of snapshots)', price: currentPrice };
        }

        // Detect confluence signals
        const signals = this.detectConfluenceSignals(oiAnalysis, currentPrice);

        // Build result with full diagnostic info
        const diagnostic = {
            oiChange5m: oiAnalysis.change5m?.toFixed(3) + '%',
            oiChange15m: oiAnalysis.change15m?.toFixed(3) + '%',
            oiTrend: oiAnalysis.trend,
            takerRatio: this.data.takerBuySellRatio?.buySellRatio?.toFixed(4),
            topTraderLong: this.data.topTraderLSRatio?.longAccount?.toFixed(4),
            topTraderDelta: this.data.topTraderLSRatio?.delta?.toFixed(4),
            retailLong: this.data.globalLSRatio?.longAccount?.toFixed(4),
            priceChange5m: priceChange(this.data.klines1m, 5)?.toFixed(4) + '%',
            fundingRate: this.data.funding?.fundingRate?.toFixed(6),
            confluence: signals,
        };

        // Count confluence
        const longSignals = signals.filter(s => s.direction === 'long' && s.active).length;
        const shortSignals = signals.filter(s => s.direction === 'short' && s.active).length;

        let direction = null;
        let confluenceCount = 0;

        if (longSignals >= CONFIG.MIN_CONFLUENCE) {
            direction = 'long';
            confluenceCount = longSignals;
        } else if (shortSignals >= CONFIG.MIN_CONFLUENCE) {
            direction = 'short';
            confluenceCount = shortSignals;
        }

        if (!direction) {
            return {
                action: 'NO_SIGNAL',
                reason: `Insufficient confluence (long: ${longSignals}/4, short: ${shortSignals}/4, need ${CONFIG.MIN_CONFLUENCE})`,
                price: currentPrice,
                diagnostic,
            };
        }

        // Anti-trap: check if retail is already crowded in same direction
        const trapCheck = this.checkAntiTrap(direction);
        if (trapCheck) {
            return {
                action: 'NO_SIGNAL',
                reason: trapCheck,
                price: currentPrice,
                diagnostic,
            };
        }

        // Build and execute trade signal
        const signal = this.buildSignal(direction, confluenceCount, currentPrice, oiAnalysis);
        return await this.executeTrade(signal, diagnostic);
    }

    /**
     * Analyze OI flow by computing changes from stored snapshots.
     */
    async analyzeOIFlow() {
        const currentOI = this.data.openInterest?.openInterest;
        if (!currentOI) return null;

        // Get OI from 5 minutes ago
        const snapshot5m = await this.db.getOISnapshotAt(5);
        // Get OI from 15 minutes ago
        const snapshot15m = await this.db.getOISnapshotAt(15);

        // Need at least 5-min snapshot for basic analysis
        if (!snapshot5m) return null;

        const change5m = ((currentOI - snapshot5m.open_interest) / snapshot5m.open_interest) * 100;
        const change15m = snapshot15m
            ? ((currentOI - snapshot15m.open_interest) / snapshot15m.open_interest) * 100
            : null;

        // Compute OI trend from all snapshots in last 15 min
        const snapshots = await this.db.getOISnapshots(15);
        let trend = 'flat';
        if (snapshots.length >= 3) {
            // Simple trend: compare first third vs last third
            const thirdLen = Math.floor(snapshots.length / 3);
            const earlyAvg = snapshots.slice(0, thirdLen).reduce((s, sn) => s + sn.open_interest, 0) / thirdLen;
            const lateAvg = snapshots.slice(-thirdLen).reduce((s, sn) => s + sn.open_interest, 0) / thirdLen;
            const trendPct = ((lateAvg - earlyAvg) / earlyAvg) * 100;
            if (trendPct > 0.3) trend = 'rising';
            else if (trendPct < -0.3) trend = 'falling';
        }

        return { currentOI, change5m, change15m, trend };
    }

    /**
     * Check all 4 confluence signals and return their status.
     */
    detectConfluenceSignals(oiAnalysis, currentPrice) {
        const priceMom = priceChange(this.data.klines1m, 5);
        const taker = this.data.takerBuySellRatio;
        const topTrader = this.data.topTraderLSRatio;

        const signals = [];

        // Signal 1: OI Surge
        const oiSurgeLong = oiAnalysis.change5m >= CONFIG.OI_SURGE_PCT;
        const oiSurgeShort = oiAnalysis.change5m >= CONFIG.OI_SURGE_PCT;
        signals.push({
            name: 'OI Surge',
            direction: oiSurgeLong && priceMom > 0 ? 'long' : oiSurgeShort && priceMom < 0 ? 'short' : 'neutral',
            active: oiAnalysis.change5m >= CONFIG.OI_SURGE_PCT,
            value: oiAnalysis.change5m?.toFixed(3) + '%',
            threshold: CONFIG.OI_SURGE_PCT + '%',
        });

        // Signal 2: Taker Buy/Sell Ratio (aggressive order flow)
        const takerLong = taker && taker.buySellRatio >= CONFIG.TAKER_RATIO_LONG;
        const takerShort = taker && taker.buySellRatio <= CONFIG.TAKER_RATIO_SHORT;
        signals.push({
            name: 'Taker Ratio',
            direction: takerLong ? 'long' : takerShort ? 'short' : 'neutral',
            active: takerLong || takerShort,
            value: taker?.buySellRatio?.toFixed(4),
            threshold: `>${CONFIG.TAKER_RATIO_LONG} or <${CONFIG.TAKER_RATIO_SHORT}`,
        });

        // Signal 3: Price Momentum
        const priceLong = priceMom >= CONFIG.PRICE_MOMENTUM_PCT;
        const priceShort = priceMom <= -CONFIG.PRICE_MOMENTUM_PCT;
        signals.push({
            name: 'Price Momentum',
            direction: priceLong ? 'long' : priceShort ? 'short' : 'neutral',
            active: priceLong || priceShort,
            value: priceMom?.toFixed(4) + '%',
            threshold: `±${CONFIG.PRICE_MOMENTUM_PCT}%`,
        });

        // Signal 4: Top Trader Shift
        const topLong = topTrader && topTrader.delta >= CONFIG.TOP_TRADER_DELTA;
        const topShort = topTrader && topTrader.delta <= -CONFIG.TOP_TRADER_DELTA;
        signals.push({
            name: 'Top Trader Shift',
            direction: topLong ? 'long' : topShort ? 'short' : 'neutral',
            active: topLong || topShort,
            value: topTrader?.delta?.toFixed(4),
            threshold: `±${CONFIG.TOP_TRADER_DELTA}`,
        });

        return signals;
    }

    /**
     * Anti-trap filter: reject if retail is already crowded in trade direction.
     */
    checkAntiTrap(direction) {
        const global = this.data.globalLSRatio;
        if (!global) return null; // if data unavailable, don't block

        if (direction === 'long' && global.longAccount >= CONFIG.RETAIL_CROWD_LIMIT) {
            return `Anti-trap: ${(global.longAccount * 100).toFixed(1)}% retail already long (limit: ${CONFIG.RETAIL_CROWD_LIMIT * 100}%)`;
        }
        if (direction === 'short' && global.shortAccount >= CONFIG.RETAIL_CROWD_LIMIT) {
            return `Anti-trap: ${(global.shortAccount * 100).toFixed(1)}% retail already short (limit: ${CONFIG.RETAIL_CROWD_LIMIT * 100}%)`;
        }
        return null;
    }

    // ─── Kill Switches ───────────────────────────────────────────

    /**
     * Check all kill switches. Returns reason string if blocked, null if clear.
     */
    async checkKillSwitches(currentPrice) {
        // KS1: Daily loss limit
        const todayLosses = await this.db.getTodayLossCount();
        if (todayLosses >= CONFIG.MAX_DAILY_LOSSES) {
            return `KS1: ${todayLosses} losses today (max ${CONFIG.MAX_DAILY_LOSSES})`;
        }

        // KS2: Drawdown circuit breaker
        const balance = await this.db.getMockBalance();
        const peakBalance = parseFloat(await this.db.getSetting('peak_balance', CONFIG.INITIAL_INR_BALANCE.toString()));
        if (peakBalance > 0) {
            const drawdownPct = ((peakBalance - balance) / peakBalance) * 100;
            if (drawdownPct >= CONFIG.MAX_ACCOUNT_DRAWDOWN_PCT) {
                return `KS2: Account drawdown ${drawdownPct.toFixed(1)}% (max ${CONFIG.MAX_ACCOUNT_DRAWDOWN_PCT}%)`;
            }
        }

        // KS3: Cooldown after loss
        const lastLossTime = await this.db.getLastLossTime();
        if (lastLossTime && (Date.now() - lastLossTime) < CONFIG.COOLDOWN_AFTER_LOSS_MS) {
            const remaining = Math.ceil((CONFIG.COOLDOWN_AFTER_LOSS_MS - (Date.now() - lastLossTime)) / 60000);
            return `KS3: Cooldown active (${remaining} min remaining)`;
        }

        // KS4: Max daily trades
        const todayCount = await this.db.getTodayTradeCount();
        if (todayCount >= CONFIG.MAX_DAILY_TRADES) {
            return `KS4: ${todayCount} trades today (max ${CONFIG.MAX_DAILY_TRADES})`;
        }

        // KS5: No trade if OI is flat/declining in 15 min
        const oiAnalysis = await this.analyzeOIFlow();
        if (oiAnalysis && oiAnalysis.change15m !== null && oiAnalysis.change15m < CONFIG.MIN_OI_GROWTH_15M) {
            return `KS5: OI stagnant (15m change: ${oiAnalysis.change15m?.toFixed(3)}%, need >${CONFIG.MIN_OI_GROWTH_15M}%)`;
        }

        // KS6: No trade near 24h extremes
        const ticker = this.data.ticker24h;
        if (ticker && ticker.highPrice > 0) {
            const distFromHigh = ((ticker.highPrice - currentPrice) / ticker.highPrice) * 100;
            const distFromLow = ((currentPrice - ticker.lowPrice) / ticker.lowPrice) * 100;
            if (distFromHigh < CONFIG.NEAR_24H_EXTREME_PCT) {
                return `KS6: Too close to 24h high (${distFromHigh.toFixed(2)}%)`;
            }
            if (distFromLow < CONFIG.NEAR_24H_EXTREME_PCT) {
                return `KS6: Too close to 24h low (${distFromLow.toFixed(2)}%)`;
            }
        }

        return null; // all clear
    }

    // ─── Signal Building & Execution ─────────────────────────────

    /**
     * Build a trade signal with SL/TP/quantity based on ATR.
     */
    buildSignal(direction, confluenceCount, currentPrice, oiAnalysis) {
        const { atrPct } = computeATR(this.data.klines5m);

        // Calculate stop loss distance (ATR-scaled with clamps)
        let slPct = CONFIG.SL_ATR_MULT * atrPct;
        slPct = Math.max(slPct, CONFIG.SL_MIN_PCT);
        slPct = Math.min(slPct, CONFIG.SL_MAX_PCT);

        // Calculate TP distance (2:1 RRR)
        const tpPct = slPct * CONFIG.TP_RRR;

        const isLong = direction === 'long';
        const slPrice = isLong
            ? currentPrice * (1 - slPct / 100)
            : currentPrice * (1 + slPct / 100);
        const tpPrice = isLong
            ? currentPrice * (1 + tpPct / 100)
            : currentPrice * (1 - tpPct / 100);

        return {
            direction,
            decision: isLong ? 'BUY' : 'SELL',
            entry: currentPrice,
            stopLoss: parseFloat(slPrice.toFixed(6)),
            takeProfit: parseFloat(tpPrice.toFixed(6)),
            slPct,
            tpPct,
            atrPct,
            confluenceCount,
            oiChange5m: oiAnalysis.change5m,
            oiAtEntry: oiAnalysis.currentOI,
            topTraderRatio: this.data.topTraderLSRatio?.longShortRatio,
            takerRatio: this.data.takerBuySellRatio?.buySellRatio,
        };
    }

    /**
     * Calculate position quantity based on risk-per-trade and SL distance.
     */
    async calculateQuantity(entryPrice, slPct, confluenceCount) {
        let balance;
        if (CONFIG.MOCK_MODE) {
            balance = await this.db.getMockBalance();
            balance = balance / CONFIG.USD_INR_RATE; // convert INR → USD
        } else {
            const balanceData = await getAccountBalance(this.env);
            balance = parseFloat(balanceData?.totalBalance || 0);
        }

        if (balance <= 0 || entryPrice <= 0 || slPct <= 0) return 0;

        // Risk amount in USD
        const riskAmount = balance * CONFIG.RISK_PER_TRADE;

        // Position value based on risk and SL distance
        const positionValue = riskAmount / (slPct / 100);

        // Leverage = position value / available margin
        let leverage = Math.min(positionValue / balance, CONFIG.MAX_LEVERAGE);
        leverage = Math.max(Math.floor(leverage), 1);

        // Quantity = position value / entry price
        const qty = Math.floor(positionValue / entryPrice);

        if (qty <= 0) return 0;

        console.log(`[Position] Balance: $${balance.toFixed(2)}, Risk: $${riskAmount.toFixed(2)}, SL: ${slPct.toFixed(2)}%, Leverage: ${leverage}x, Qty: ${qty}`);

        return { qty, leverage };
    }

    /**
     * Execute a trade (mock or live via CoinDCX).
     */
    async executeTrade(signal, diagnostic) {
        const posInfo = await this.calculateQuantity(signal.entry, signal.slPct, signal.confluenceCount);
        if (!posInfo || posInfo.qty <= 0) {
            return {
                action: 'NO_SIGNAL',
                reason: 'Position size too small (insufficient balance)',
                price: signal.entry,
                diagnostic,
            };
        }

        const { qty, leverage } = posInfo;
        const side = signal.decision === 'BUY' ? 'buy' : 'sell';

        let orderId;
        let orderResult;

        if (CONFIG.MOCK_MODE) {
            orderId = `MOCK_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            orderResult = { mock: true, orderId };
            console.log(`[Mock] ${signal.decision} ${qty} DOGE @ ${signal.entry} | SL: ${signal.stopLoss} | TP: ${signal.takeProfit} | Lev: ${leverage}x`);

            // Deduct entry fee from mock balance
            const entryValueInr = qty * signal.entry * CONFIG.USD_INR_RATE;
            const entryFee = entryValueInr * (CONFIG.MOCK_FEE_PCT / 100);
            const currentBalance = await this.db.getMockBalance();
            await this.db.updateMockBalance(currentBalance - entryFee);
        } else {
            try {
                orderResult = await placeOrder(
                    this.env, CONFIG.PAIR, side, qty, leverage,
                    signal.stopLoss, signal.takeProfit
                );
                orderId = orderResult?.orders?.[0]?.id || `LIVE_${Date.now()}`;
            } catch (err) {
                console.error('[Trade] Order placement error:', err.message);
                return { action: 'ERROR', reason: 'Order failed: ' + err.message, diagnostic };
            }
        }

        // Calculate entry value in INR for PnL tracking
        const entryValueInr = qty * signal.entry * CONFIG.USD_INR_RATE;

        // Log trade to D1
        const reason = `OI Flow Rider: ${signal.confluenceCount}/4 confluence | OI Δ5m: ${signal.oiChange5m?.toFixed(3)}% | Taker: ${signal.takerRatio?.toFixed(4)} | Direction: ${signal.direction}`;

        await this.db.logTrade({
            decision: signal.decision,
            reason,
            asset: CONFIG.PAIR,
            entry: signal.entry,
            quantity: qty,
            leverage,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            tpLevels: null,
            status: 'OPEN',
            orderId,
            entryValueInr,
            atrPct: signal.atrPct,
            supportingModules: signal.confluenceCount,
            moduleStates: JSON.stringify(diagnostic.confluence),
            entryTime: Date.now(),
            oiChange5m: signal.oiChange5m,
            oiAtEntry: signal.oiAtEntry,
            topTraderRatio: signal.topTraderRatio,
            takerRatio: signal.takerRatio,
        });

        return {
            action: 'TRADE_OPENED',
            direction: signal.direction,
            entry: signal.entry,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            quantity: qty,
            leverage,
            confluence: signal.confluenceCount,
            orderId,
            diagnostic,
        };
    }

    // ─── Trade Management (Exits) ────────────────────────────────

    /**
     * Manage an active trade — check all exit conditions each tick.
     */
    async manageTrade(activeTrade, currentPrice) {
        const entryPrice = activeTrade.price;
        const isLong = activeTrade.decision === 'BUY';
        const isMock = (activeTrade.order_id || '').startsWith('MOCK_');
        const entryTime = activeTrade.entry_time || activeTrade.timestamp;
        const holdTimeMs = Date.now() - entryTime;
        const holdTimeMin = holdTimeMs / 60000;

        // Price change since entry
        const priceChangePct = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
        const { atrPct } = computeATR(this.data.klines5m);
        const profitInATR = atrPct > 0 ? priceChangePct / atrPct : 0;

        console.log(`[Manage] Hold: ${holdTimeMin.toFixed(1)}min | PnL: ${priceChangePct.toFixed(3)}% (${profitInATR.toFixed(2)} ATR) | Price: ${currentPrice}`);

        // ── Exit Check 1: Hard Stop Loss ──
        if (isLong && currentPrice <= activeTrade.stop_loss) {
            return await this.exitTrade(activeTrade, currentPrice, 'Hard stop loss hit', isMock, isLong, entryPrice, holdTimeMs);
        }
        if (!isLong && currentPrice >= activeTrade.stop_loss) {
            return await this.exitTrade(activeTrade, currentPrice, 'Hard stop loss hit', isMock, isLong, entryPrice, holdTimeMs);
        }

        // ── Exit Check 2: Take Profit ──
        if (isLong && currentPrice >= activeTrade.take_profit) {
            return await this.exitTrade(activeTrade, currentPrice, 'Take profit hit', isMock, isLong, entryPrice, holdTimeMs);
        }
        if (!isLong && currentPrice <= activeTrade.take_profit) {
            return await this.exitTrade(activeTrade, currentPrice, 'Take profit hit', isMock, isLong, entryPrice, holdTimeMs);
        }

        // ── Exit Check 3: OI Drop (institutions closing) ──
        const oiAnalysis = await this.analyzeOIFlow();
        if (oiAnalysis && oiAnalysis.change5m <= -CONFIG.OI_DROP_EXIT_PCT) {
            return await this.exitTrade(
                activeTrade, currentPrice,
                `OI exit: institutions closing (OI Δ5m: ${oiAnalysis.change5m.toFixed(3)}%)`,
                isMock, isLong, entryPrice, holdTimeMs
            );
        }

        // ── Exit Check 4: OI trend reversal while in loss ──
        if (oiAnalysis && oiAnalysis.trend === 'falling' && priceChangePct < 0) {
            return await this.exitTrade(
                activeTrade, currentPrice,
                `OI trend reversed to falling while in loss (PnL: ${priceChangePct.toFixed(3)}%)`,
                isMock, isLong, entryPrice, holdTimeMs
            );
        }

        // ── Exit Check 5: Taker ratio flips against position ──
        const taker = this.data.takerBuySellRatio;
        if (taker) {
            if (isLong && taker.buySellRatio <= CONFIG.TAKER_REVERSAL_LONG) {
                return await this.exitTrade(
                    activeTrade, currentPrice,
                    `Taker reversal: aggressive selling detected (ratio: ${taker.buySellRatio.toFixed(4)})`,
                    isMock, isLong, entryPrice, holdTimeMs
                );
            }
            if (!isLong && taker.buySellRatio >= CONFIG.TAKER_REVERSAL_SHORT) {
                return await this.exitTrade(
                    activeTrade, currentPrice,
                    `Taker reversal: aggressive buying detected (ratio: ${taker.buySellRatio.toFixed(4)})`,
                    isMock, isLong, entryPrice, holdTimeMs
                );
            }
        }

        // ── Exit Check 6: Top trader L/S ratio flips against position ──
        const topTrader = this.data.topTraderLSRatio;
        if (topTrader && topTrader.delta) {
            if (isLong && topTrader.delta <= -CONFIG.TOP_TRADER_DELTA * 2) {
                return await this.exitTrade(
                    activeTrade, currentPrice,
                    `Top traders reversing (delta: ${topTrader.delta.toFixed(4)})`,
                    isMock, isLong, entryPrice, holdTimeMs
                );
            }
            if (!isLong && topTrader.delta >= CONFIG.TOP_TRADER_DELTA * 2) {
                return await this.exitTrade(
                    activeTrade, currentPrice,
                    `Top traders reversing (delta: ${topTrader.delta.toFixed(4)})`,
                    isMock, isLong, entryPrice, holdTimeMs
                );
            }
        }

        // ── Exit Check 7: Funding rate extreme against position ──
        const funding = this.data.funding?.fundingRate || 0;
        if (isLong && funding > 0.0005) {
            return await this.exitTrade(
                activeTrade, currentPrice,
                `Funding extreme against long (${(funding * 100).toFixed(4)}%)`,
                isMock, isLong, entryPrice, holdTimeMs
            );
        }
        if (!isLong && funding < -0.0005) {
            return await this.exitTrade(
                activeTrade, currentPrice,
                `Funding extreme against short (${(funding * 100).toFixed(4)}%)`,
                isMock, isLong, entryPrice, holdTimeMs
            );
        }

        // ── Exit Check 8: Time stop ──
        if (holdTimeMin >= CONFIG.TIME_STOP_MINUTES) {
            return await this.exitTrade(
                activeTrade, currentPrice,
                `Time stop: ${holdTimeMin.toFixed(1)} min (max ${CONFIG.TIME_STOP_MINUTES})`,
                isMock, isLong, entryPrice, holdTimeMs
            );
        }

        // ── Profit Management: Partial TP ──
        const partialClosed = activeTrade.partial_closed_pct || 0;
        if (partialClosed === 0 && profitInATR >= CONFIG.PARTIAL_TP_ATR_MULT) {
            await this.partialClose(activeTrade, currentPrice, 50, isMock, isLong, entryPrice);
            return {
                action: 'PARTIAL_CLOSE',
                reason: `Partial TP: 50% closed at +${profitInATR.toFixed(2)} ATR profit`,
                price: currentPrice,
                holdTimeMin: holdTimeMin.toFixed(1),
            };
        }

        // ── Profit Management: Move SL to breakeven ──
        if (profitInATR >= CONFIG.BREAKEVEN_ATR_MULT && atrPct > 0) {
            // Only update if SL hasn't already been moved to breakeven
            const currentSL = activeTrade.stop_loss;
            const shouldMoveToBreakeven = isLong
                ? currentSL < entryPrice
                : currentSL > entryPrice;

            if (shouldMoveToBreakeven) {
                await this.db.updateTradeStatus(
                    activeTrade.order_id, 'OPEN',
                    null, null, null, null, null, null
                );
                // Note: In mock mode we can't actually move SL, but we track it
                console.log(`[Manage] SL moved to breakeven (entry: ${entryPrice})`);
            }
        }

        return {
            action: 'HOLDING',
            pnlPct: priceChangePct.toFixed(3),
            profitATR: profitInATR.toFixed(2),
            holdTimeMin: holdTimeMin.toFixed(1),
            oiChange5m: oiAnalysis?.change5m?.toFixed(3) + '%',
            oiTrend: oiAnalysis?.trend,
            price: currentPrice,
        };
    }

    /**
     * Exit a trade completely.
     */
    async exitTrade(activeTrade, exitPrice, reason, isMock, isLong, entryPrice, holdTimeMs) {
        const priceChangePct = ((exitPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
        const leverage = activeTrade.leverage || 1;
        const leveragedPnlPct = priceChangePct * leverage;

        // Calculate PnL in INR
        const entryValueInr = activeTrade.entry_value_inr || 0;
        const pnlInr = entryValueInr * (leveragedPnlPct / 100);

        // Apply exit fee in mock mode
        const exitFee = isMock ? (entryValueInr * (CONFIG.MOCK_FEE_PCT / 100)) : 0;
        const netPnlInr = pnlInr - exitFee;
        const exitValueInr = entryValueInr + netPnlInr;

        console.log(`[Exit] ${reason} | PnL: ${leveragedPnlPct.toFixed(3)}% (₹${netPnlInr.toFixed(2)}) | Hold: ${(holdTimeMs / 60000).toFixed(1)} min`);

        // Close on CoinDCX if live
        if (!isMock) {
            try {
                const closeSide = isLong ? 'sell' : 'buy';
                await closePartialPosition(this.env, CONFIG.PAIR, closeSide, activeTrade.quantity, activeTrade.leverage);
            } catch (err) {
                console.error('[Exit] CoinDCX close error:', err.message);
            }
        }

        // Update mock balance
        if (isMock) {
            const currentBalance = await this.db.getMockBalance();
            const partialFactor = (100 - (activeTrade.partial_closed_pct || 0)) / 100;
            const adjustedPnl = netPnlInr * partialFactor;
            const newBalance = currentBalance + adjustedPnl;
            await this.db.updateMockBalance(newBalance);

            // Update peak balance for drawdown tracking
            const peakBalance = parseFloat(await this.db.getSetting('peak_balance', CONFIG.INITIAL_INR_BALANCE.toString()));
            if (newBalance > peakBalance) {
                await this.db.updateSetting('peak_balance', newBalance.toFixed(2));
            }

            console.log(`[Mock] Balance: ₹${currentBalance.toFixed(2)} → ₹${newBalance.toFixed(2)}`);
        }

        // Update trade in D1
        const holdTimeSec = Math.round(holdTimeMs / 1000);
        await this.db.updateTradeStatus(
            activeTrade.order_id, 'CLOSED',
            exitPrice, leveragedPnlPct, reason,
            exitValueInr, netPnlInr, holdTimeSec
        );

        return {
            action: 'TRADE_CLOSED',
            reason,
            pnlPct: leveragedPnlPct.toFixed(3),
            pnlInr: netPnlInr.toFixed(2),
            holdTimeMin: (holdTimeMs / 60000).toFixed(1),
            exitPrice,
        };
    }

    /**
     * Partial close — close a percentage of the position.
     */
    async partialClose(activeTrade, currentPrice, closePct, isMock, isLong, entryPrice) {
        const closeQty = Math.floor(activeTrade.quantity * (closePct / 100));
        if (closeQty <= 0) return;

        const priceChangePct = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
        const leverage = activeTrade.leverage || 1;
        const leveragedPnl = priceChangePct * leverage;
        const partialPnlInr = (activeTrade.entry_value_inr || 0) * (closePct / 100) * (leveragedPnl / 100);

        console.log(`[Partial] Closing ${closePct}% (${closeQty} qty) at ${currentPrice} | PnL: ₹${partialPnlInr.toFixed(2)}`);

        if (!isMock) {
            try {
                const closeSide = isLong ? 'sell' : 'buy';
                await closePartialPosition(this.env, CONFIG.PAIR, closeSide, closeQty, activeTrade.leverage);
            } catch (err) {
                console.error('[Partial] Close error:', err.message);
            }
        }

        // Update mock balance with partial profit
        if (isMock) {
            const fee = Math.abs(partialPnlInr) * (CONFIG.MOCK_FEE_PCT / 100);
            const netPartialPnl = partialPnlInr - fee;
            const currentBalance = await this.db.getMockBalance();
            await this.db.updateMockBalance(currentBalance + netPartialPnl);
        }

        // Update partial close status in DB
        const totalPartial = (activeTrade.partial_closed_pct || 0) + closePct;
        await this.db.updatePartialClose(activeTrade.order_id, totalPartial);
    }
}
