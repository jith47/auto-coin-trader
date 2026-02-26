import { placeOrder, getOpenPositions, getMarketPrice, getAccountBalance, closePartialPosition } from './coindcx.js';
import { fetchAllMarketData, computeIndicators, fetchDeltaFromDO } from './binance.js';
const CONFIG = {
    PAIR: 'B-DOGE_USDT',
    MARGIN_PERCENT: 70,
    LEVERAGE: 5,
    SL: {
        SWEEP_RECLAIM: 0.7,
        RELATIVE_WEAKNESS: 0.8,
        RELATIVE_STRENGTH: 0.8,
        TREND_CONTINUATION: 1.0,
    },
    SL_MIN: 0.6,
    SL_MAX: 1.2,
    MIN_RRR: 1.5,
    SCORE_THRESHOLD_PREFERRED: 70,
    SCORE_THRESHOLD_CAUTION: 85,
    KILL_CORR_BTC: 1.5,
    KILL_CORR_DOGE: 0.3,
    KILL_SESSION_EXTREME: 0.5,
    KILL_OVEREXTEND: 5.0,

    SWEEP_DOGE_PROXIMITY: 1.5,
    RW_DOGE_1H_THRESHOLD: -0.5,
    RS_DOGE_1H_THRESHOLD: 0.5,
    DIVERGE_DISTANCE_MIN: 1.0,
    TREND_BTC_1H_MIN: 1.0,
    TREND_DOGE_DIST_FROM_HIGH_MIN: 0.8,
    TREND_DOGE_DIST_FROM_LOW_MIN: 1.5,
    PREFERRED_SESSIONS: [
        { start: 5.5, end: 11 },
        { start: 13, end: 16 },
    ],
    DEAD_ZONES: [
        { start: 20, end: 23 },
    ],
    MAX_LOSSES: 3,
    COOLDOWN_AFTER_LOSS_MS: 30 * 60 * 1000,
    MAX_TRADES_PER_DAY: 6,
    MOCK_MODE: true, // Set to true for mock trading
    INITIAL_INR_BALANCE: 2500,
    USD_INR_RATE: 85, // Simple rate for conversion
    TP_PROFILES: {
        SWEEP_RECLAIM: [
            { pctOfPosition: 80, rrMultiple: 1.5 },
            { pctOfPosition: 20, rrMultiple: 2.5 },
        ],
        RELATIVE_WEAKNESS: [
            { pctOfPosition: 100, rrMultiple: 1.5 },
        ],
        RELATIVE_STRENGTH: [
            { pctOfPosition: 100, rrMultiple: 1.5 },
        ],
        TREND_CONTINUATION: [
            { pctOfPosition: 50, rrMultiple: 1.5 },
            { pctOfPosition: 30, rrMultiple: 2.0 },
            { pctOfPosition: 20, trailing: true, trailingDistance: 0.4 },
        ],
    },
};
export class StrategyService {
    constructor(env) {
        this.env = env;
        this.db = null;
        this.indicators = null;
    }
    async run(db) {
        this.db = db;
        console.log(`[Strategy] ── Evaluation Start (${CONFIG.MOCK_MODE ? 'MOCK' : 'REAL'} MODE) ──`);
        try {
            // 1. Fetch data FIRST
            const data = await fetchAllMarketData();

            // 2. Fetch real-time delta from Durable Object (falls back to REST if unavailable)
            let deltaSnapshot = null;
            if (this.env.DELTA_FEED) {
                try {
                    deltaSnapshot = await fetchDeltaFromDO(this.env);
                    console.log(`[Strategy] DO delta: connected=${deltaSnapshot.connected}, uptime=${deltaSnapshot.uptimeMin}min`);
                } catch (err) {
                    console.log('[Strategy] DO delta unavailable:', err.message);
                }
            }

            this.indicators = computeIndicators(data, CONFIG, deltaSnapshot);

            console.log('[Strategy] Indicators:', JSON.stringify({
                btcPrice: this.indicators.btc.price?.toFixed(0),
                dogePrice: this.indicators.doge.price?.toFixed(5),
                btcCvd: this.indicators.btc.cvdDirection,
                dogeCvd: this.indicators.doge.cvdDirection,
                btc1h: this.indicators.btc.change1h?.toFixed(2) + '%',
                doge1h: this.indicators.doge.change1h?.toFixed(2) + '%',
                relStrength: this.indicators.doge.relativeStrength,
                sectorBias: this.indicators.sector.bias,
                session: this.indicators.session.type,
            }));

            // 2. Manage existing trade
            const activeTrade = await db.getActiveTrade();
            if (activeTrade && activeTrade.status === 'OPEN') {
                return await this.manageTrade(activeTrade);
            }

            // 3. New trade checks
            const cooldownCheck = await this.checkCooldowns();
            if (!cooldownCheck.canTrade) {
                console.log(`[Strategy] Blocked: ${cooldownCheck.reason}`);
                return { status: 'BLOCKED', reason: cooldownCheck.reason };
            }

            // 4. Check session type
            if (this.indicators.session.type === 'DEAD_ZONE') {
                console.log('[Strategy] Dead zone session — no trading');
                return { status: 'DEAD_ZONE' };
            }

            // 5. Check kill switches first (before setup evaluation per strategy doc)
            const killSwitchLong = this.checkKillSwitches(this.indicators, 'BUY');
            const killSwitchShort = this.checkKillSwitches(this.indicators, 'SELL');
            if (killSwitchLong && killSwitchShort) {
                console.log(`[Strategy] All directions blocked: LONG=${killSwitchLong}, SHORT=${killSwitchShort}`);
                return { status: 'KILL_SWITCH', reason: `Both blocked: ${killSwitchLong}; ${killSwitchShort}` };
            }

            // 6. Identify matching setup
            const setup = this.evaluateSetups(this.indicators);
            if (!setup) {
                console.log('[Strategy] No valid setup');
                return { status: 'NO_SETUP' };
            }

            console.log(`[Strategy] Setup found: ${setup.type} ${setup.direction}`);

            // 7. Verify kill switch doesn't block the found direction
            const killSwitch = setup.direction === 'BUY' ? killSwitchLong : killSwitchShort;
            if (killSwitch) {
                console.log(`[Strategy] Kill switch triggered: ${killSwitch}`);
                return { status: 'KILL_SWITCH', reason: killSwitch };
            }

            // 8. Score and threshold check
            const score = this.scoreSignal(this.indicators, setup);
            const threshold = this.indicators.session.type === 'PREFERRED'
                ? CONFIG.SCORE_THRESHOLD_PREFERRED
                : CONFIG.SCORE_THRESHOLD_CAUTION;
            console.log(`[Strategy] Score: ${score}/${threshold}`);
            if (score < threshold) {
                return { status: 'LOW_SCORE', score, threshold };
            }

            const signal = await this.buildSignal(this.indicators, setup, score);
            console.log('[Strategy] Signal:', JSON.stringify(signal, null, 2));
            return await this.executeTrade(signal);
        } catch (err) {
            console.error('[Strategy] Error:', err.message, err.stack);
            return { status: 'ERROR', error: err.message };
        }
    }
    checkKillSwitches(ind, direction) {
        const isLong = direction === 'BUY';
        if (isLong && ind.btc.change1h > CONFIG.KILL_CORR_BTC && ind.doge.change1h < -CONFIG.KILL_CORR_DOGE) {
            return 'NO_LONG_CORR_DIVERGENCE: BTC strong but DOGE weak';
        }
        if (!isLong && ind.btc.change1h < -CONFIG.KILL_CORR_BTC && ind.doge.change1h > CONFIG.KILL_CORR_DOGE) {
            return 'NO_SHORT_CORR_DIVERGENCE: BTC weak but DOGE strong';
        }
        if (isLong && ind.doge.distFromHigh <= CONFIG.KILL_SESSION_EXTREME) {
            return 'NO_LONG_SESSION_TOP: DOGE within 0.5% of session high';
        }
        if (!isLong && ind.doge.distFromLow <= CONFIG.KILL_SESSION_EXTREME) {
            return 'NO_SHORT_SESSION_BOTTOM: DOGE within 0.5% of session low';
        }
        if (isLong && ind.doge.cvdDirection === 'falling' && ind.btc.cvdDirection === 'falling') {
            return 'NO_LONG_FALLING_CVD: Both CVDs falling';
        }
        if (!isLong && ind.doge.cvdDirection === 'rising' && ind.btc.cvdDirection === 'rising') {
            return 'NO_SHORT_RISING_CVD: Both CVDs rising';
        }
        if (isLong && ind.sector.bias === 'bearish') {
            return 'NO_LONG_BEARISH_SECTOR: Sector headwind';
        }
        if (isLong && ind.doge.dailyChange - ind.btc.dailyChange > CONFIG.KILL_OVEREXTEND) {
            return 'NO_LONG_OVEREXTENDED: DOGE daily exceeds BTC by 5%+';
        }
        return null;
    }
    evaluateSetups(ind) {
        const sweepSetup = this.checkSweepReclaim(ind);
        if (sweepSetup) return sweepSetup;
        const rwSetup = this.checkRelativeWeaknessShort(ind);
        if (rwSetup) return rwSetup;
        const rsSetup = this.checkRelativeStrengthLong(ind);
        if (rsSetup) return rsSetup;
        const trendSetup = this.checkTrendContinuation(ind);
        if (trendSetup) return trendSetup;
        return null;
    }
    checkSweepReclaim(ind) {
        // Long: BTC swept lows & reclaimed, CVD rising, DOGE near low, longs flushed, sector bullish/mixed
        if (ind.btc.structure === 'sweep_reclaim_bullish') {
            if (ind.btc.cvdDirection === 'rising' &&
                ind.doge.distFromLow <= CONFIG.SWEEP_DOGE_PROXIMITY &&
                (ind.doge.cvdDirection === 'rising' || ind.doge.cvdDirection === 'flat') &&
                ind.liquidations.recentEvent === 'longs_flushed' &&
                (ind.sector.bias === 'bullish' || ind.sector.bias === 'mixed')) {
                return { type: 'SWEEP_RECLAIM', direction: 'BUY' };
            }
        }
        // Short: BTC swept highs & rejected, CVD falling, DOGE near high, shorts squeezed
        if (ind.btc.structure === 'sweep_reclaim_bearish') {
            if (ind.btc.cvdDirection === 'falling' &&
                ind.doge.distFromHigh <= CONFIG.SWEEP_DOGE_PROXIMITY &&
                (ind.doge.cvdDirection === 'falling' || ind.doge.cvdDirection === 'flat') &&
                ind.liquidations.recentEvent === 'shorts_squeezed') {
                return { type: 'SWEEP_RECLAIM', direction: 'SELL' };
            }
        }
        return null;
    }
    checkRelativeWeaknessShort(ind) {
        if (ind.btc.change1h > 0 &&
            ind.doge.change1h < CONFIG.RW_DOGE_1H_THRESHOLD &&
            ind.doge.relativeStrength === 'weaker' &&
            ind.btc.structure === 'rejection' &&
            ind.doge.cvdDirection === 'falling' &&
            ind.doge.distFromLow > CONFIG.DIVERGE_DISTANCE_MIN) {
            return { type: 'RELATIVE_WEAKNESS', direction: 'SELL' };
        }
        return null;
    }
    checkRelativeStrengthLong(ind) {
        if (ind.btc.change1h < 0 &&
            ind.doge.change1h > CONFIG.RS_DOGE_1H_THRESHOLD &&
            ind.doge.relativeStrength === 'stronger' &&
            ind.btc.structure === 'support_holding' &&
            ind.doge.cvdDirection === 'rising' &&
            ind.doge.distFromHigh > CONFIG.DIVERGE_DISTANCE_MIN) {
            return { type: 'RELATIVE_STRENGTH', direction: 'BUY' };
        }
        return null;
    }
    checkTrendContinuation(ind) {
        // Long: BTC 1h > 1%, CVD rising+steep, DOGE aligned/stronger, CVD rising, room to run, sector bullish
        if (ind.btc.change1h > CONFIG.TREND_BTC_1H_MIN &&
            ind.btc.cvdDirection === 'rising' &&
            ind.btc.cvdSlope === 'steep' &&
            (ind.doge.relativeStrength === 'aligned' || ind.doge.relativeStrength === 'stronger') &&
            ind.doge.cvdDirection === 'rising' &&
            ind.doge.distFromHigh > CONFIG.TREND_DOGE_DIST_FROM_HIGH_MIN &&
            ind.doge.distFromLow > CONFIG.TREND_DOGE_DIST_FROM_LOW_MIN &&
            ind.sector.bias === 'bullish') {
            return { type: 'TREND_CONTINUATION', direction: 'BUY' };
        }
        // Short: BTC 1h < -1%, CVD falling+steep, DOGE aligned/weaker, CVD falling, room to run
        // Note: Strategy does not require sector bias for short trend continuation
        if (ind.btc.change1h < -CONFIG.TREND_BTC_1H_MIN &&
            ind.btc.cvdDirection === 'falling' &&
            ind.btc.cvdSlope === 'steep' &&
            (ind.doge.relativeStrength === 'aligned' || ind.doge.relativeStrength === 'weaker') &&
            ind.doge.cvdDirection === 'falling' &&
            ind.doge.distFromLow > CONFIG.TREND_DOGE_DIST_FROM_HIGH_MIN &&
            ind.doge.distFromHigh > CONFIG.TREND_DOGE_DIST_FROM_LOW_MIN) {
            return { type: 'TREND_CONTINUATION', direction: 'SELL' };
        }
        return null;
    }
    scoreSignal(ind, setup) {
        let score = 0;
        if (ind.btc.structure === 'sweep_reclaim_bullish' || ind.btc.structure === 'sweep_reclaim_bearish') {
            score += 30;
        } else if (ind.btc.structure === 'rejection' || ind.btc.structure === 'support_holding') {
            score += 20;
        } else if (ind.btc.structure === 'breakout' || ind.btc.structure === 'breakdown') {
            score += 15;
        }
        const isLong = setup.direction === 'BUY';
        if ((isLong && ind.btc.cvdDirection === 'rising') || (!isLong && ind.btc.cvdDirection === 'falling')) {
            score += 15;
        }
        if ((isLong && ind.doge.cvdDirection === 'rising') || (!isLong && ind.doge.cvdDirection === 'falling')) {
            score += 10;
        }
        if ((isLong && (ind.doge.relativeStrength === 'stronger' || ind.doge.relativeStrength === 'aligned')) ||
            (!isLong && (ind.doge.relativeStrength === 'weaker' || ind.doge.relativeStrength === 'aligned'))) {
            score += 15;
        }
        const favorableDistance = isLong ? ind.doge.distFromLow : ind.doge.distFromHigh;
        if (favorableDistance <= 1) {
            score += 15;
        } else if (favorableDistance <= 2) {
            score += 10;
        }
        if ((isLong && ind.sector.bias === 'bullish') || (!isLong && ind.sector.bias === 'bearish')) {
            score += 10;
        } else if (ind.sector.bias === 'mixed') {
            score += 5;
        }
        const liqEvent = ind.liquidations?.recentEvent || 'none';
        if ((isLong && liqEvent === 'longs_flushed') || (!isLong && liqEvent === 'shorts_squeezed')) {
            score += 5;
        }
        return score;
    }
    async buildSignal(ind, setup, score) {
        const entry = ind.doge.price;
        const slPercent = CONFIG.SL[setup.type] || 0.8;
        const clampedSL = Math.min(Math.max(slPercent, CONFIG.SL_MIN), CONFIG.SL_MAX);
        const sl = setup.direction === 'BUY'
            ? entry * (1 - clampedSL / 100)
            : entry * (1 + clampedSL / 100);
        const slDistance = Math.abs(entry - sl);
        const tpProfile = CONFIG.TP_PROFILES[setup.type] || [{ pctOfPosition: 100, rrMultiple: CONFIG.MIN_RRR }];
        const tpLevels = tpProfile.map(level => {
            if (level.trailing) {
                return { ...level, price: null };
            }
            const price = setup.direction === 'BUY'
                ? entry + (slDistance * level.rrMultiple)
                : entry - (slDistance * level.rrMultiple);
            return { ...level, price: parseFloat(price.toFixed(6)) };
        });
        const firstTpPrice = tpLevels.find(l => l.price !== null)?.price
            || parseFloat((setup.direction === 'BUY' ? entry + slDistance * CONFIG.MIN_RRR : entry - slDistance * CONFIG.MIN_RRR).toFixed(6));

        // Calculate INR exposure
        let inrBalance = CONFIG.INITIAL_INR_BALANCE;
        if (CONFIG.MOCK_MODE) {
            inrBalance = await this.db.getMockBalance();
        }
        const marginInr = inrBalance * (CONFIG.MARGIN_PERCENT / 100);

        const quantity = await this.calculateQuantity(entry, sl, inrBalance);
        return {
            decision: setup.direction,
            reason: `${setup.type} | Score:${score} | BTC:${ind.btc.structure} | CVD:${ind.btc.cvdDirection}/${ind.doge.cvdDirection} | RS:${ind.doge.relativeStrength}`,
            orderType: 'MARKET',
            quantity,
            leverage: CONFIG.LEVERAGE,
            entry,
            stopLoss: parseFloat(sl.toFixed(6)),
            takeProfit: firstTpPrice,
            tpLevels,
            setupType: setup.type,
            score,
            entryValueInr: marginInr,
        };
    }
    async calculateQuantity(entry, sl, mockInrBalance = null) {
        let balanceUsd = 100;
        if (CONFIG.MOCK_MODE && mockInrBalance) {
            balanceUsd = mockInrBalance / CONFIG.USD_INR_RATE;
        } else {
            try {
                const accountData = await getAccountBalance(this.env);
                if (accountData && Array.isArray(accountData)) {
                    const usdtWallet = accountData.find(w => (w.currency === 'USDT' || w.currency_short_name === 'USDT'));
                    if (usdtWallet) {
                        balanceUsd = parseFloat(usdtWallet.balance || usdtWallet.available_balance || 100);
                    }
                } else if (accountData && accountData.balance) {
                    balanceUsd = parseFloat(accountData.balance);
                }
            } catch (err) {
                console.error('[Strategy] Failed to fetch balance, using fallback:', err.message);
            }
        }

        console.log(`[Strategy] Account balance: ${balanceUsd.toFixed(2)} USD (Equivalent)`);

        const marginAvailable = balanceUsd * (CONFIG.MARGIN_PERCENT / 100);
        const slDistancePct = Math.abs(entry - sl) / entry;
        if (slDistancePct === 0) return 0;
        // SL-based sizing: risk amount = margin * leverage, size position so SL loss = risk
        const riskAmountUsd = marginAvailable * CONFIG.LEVERAGE;
        const positionValueUsd = riskAmountUsd / slDistancePct;
        const quantity = Math.floor(positionValueUsd / entry);
        console.log(`[Strategy] SL-based sizing: risk=$${riskAmountUsd.toFixed(2)}, slDist=${(slDistancePct * 100).toFixed(2)}%, qty=${quantity}`);
        return quantity > 0 ? quantity : 1;
    }
    async executeTrade(signal) {
        try {
            console.log(`[Strategy] Executing ${signal.decision} trade (${CONFIG.MOCK_MODE ? 'MOCK' : 'REAL'})...`);

            let result;
            if (CONFIG.MOCK_MODE) {
                result = {
                    mock: true,
                    orders: [{ id: `MOCK_${Date.now()}` }],
                    status: 'success'
                };
                console.log('[Strategy] Mock trade simulated.');
            } else {
                result = await placeOrder(
                    this.env, CONFIG.PAIR, signal.decision, signal.quantity,
                    signal.leverage, signal.stopLoss, signal.takeProfit,
                    signal.orderType, signal.entry
                );
                console.log('[Strategy] Order result:', JSON.stringify(result, null, 2));
            }

            const dbResult = await this.db.logTrade(signal);
            const dbId = dbResult?.meta?.last_row_id;
            if (result.orders && result.orders[0] && dbId) {
                const orderId = result.orders[0].id;
                await this.db.db.prepare('UPDATE trade_logs SET order_id = ? WHERE rowid = ?')
                    .bind(orderId, dbId).run();
            }
            return { status: 'TRADE_PLACED', signal, result };
        } catch (err) {
            console.error('[Strategy] Trade execution error:', err.message);
            await this.db.logTrade({ ...signal, status: 'FAILED', error: err.message });
            return { status: 'TRADE_FAILED', error: err.message };
        }
    }
    async manageTrade(activeTrade) {
        console.log(`[Strategy] Managing active trade: ${activeTrade.decision} ${activeTrade.asset}`);
        try {
            const positions = await getOpenPositions(this.env);
            const dogePos = positions?.find?.(p => p.pair === CONFIG.PAIR);
            if (!dogePos || parseFloat(dogePos.quantity || 0) === 0) {
                console.log('[Strategy] Position closed on exchange');
                const currentPrice = await getMarketPrice(CONFIG.PAIR);
                let pnl = 0;
                if (currentPrice && activeTrade.price) {
                    const entryPrice = parseFloat(activeTrade.price);
                    if (activeTrade.decision === 'BUY') {
                        pnl = ((currentPrice - entryPrice) / entryPrice) * 100;
                    } else {
                        pnl = ((entryPrice - currentPrice) / entryPrice) * 100;
                    }
                }
                await this.db.updateTradeStatus(
                    activeTrade.order_id, 'CLOSED', currentPrice, pnl,
                    'EXCHANGE_CLOSED (SL/TP/MANUAL)'
                );
                return { status: 'TRADE_CLOSED', reason: 'EXCHANGE_CLOSED', pnl };
            }
            const currentQty = parseFloat(dogePos.quantity);
            const currentPrice = this.indicators.doge.price; // Use fresh indicator price

            const tpLevels = activeTrade.tp_levels ? JSON.parse(activeTrade.tp_levels) : null;
            if (tpLevels && tpLevels.length > 0) {
                const entryPrice = parseFloat(activeTrade.price);
                const isLong = activeTrade.decision === 'BUY';
                const tpHit = await this.checkAndExecutePartialTP(
                    tpLevels, currentPrice, currentQty, entryPrice, isLong, activeTrade
                );
                if (tpHit) return tpHit;
            }

            // SL Check for Mock Mode (since exchange SL isn't there)
            if (activeTrade.order_id.startsWith('MOCK_')) {
                const isLong = activeTrade.decision === 'BUY';
                const slPrice = parseFloat(activeTrade.stop_loss);
                const slHit = isLong ? currentPrice <= slPrice : currentPrice >= slPrice;
                if (slHit) {
                    console.log(`[Strategy] MOCK SL hit at ${currentPrice} (SL: ${slPrice})`);
                    const pnl = ((slPrice - activeTrade.price) / activeTrade.price) * 100 * (isLong ? 1 : -1);
                    const entryValueInr = parseFloat(activeTrade.entry_value_inr || 0);
                    const pnlInr = entryValueInr * (pnl / 100);
                    const exitValueInr = entryValueInr + pnlInr;

                    const currentBalance = await this.db.getMockBalance();
                    await this.db.updateMockBalance(currentBalance + pnlInr);

                    await this.db.updateTradeStatus(
                        activeTrade.order_id, 'CLOSED', slPrice, pnl,
                        'MOCK_SL_HIT', exitValueInr, pnlInr
                    );
                    return { status: 'TRADE_CLOSED', reason: 'MOCK_SL_HIT', pnl };
                }
            }

            console.log(`[Strategy] Position still open: qty=${currentQty} price=${currentPrice}`);
            return { status: 'IN_TRADE', position: dogePos };
        } catch (err) {
            console.error('[Strategy] Trade management error:', err.message);
            return { status: 'MANAGE_ERROR', error: err.message };
        }
    }
    async checkAndExecutePartialTP(tpLevels, currentPrice, totalQty, entryPrice, isLong, activeTrade) {
        for (let i = 0; i < tpLevels.length; i++) {
            const level = tpLevels[i];
            if (level.executed) continue;

            if (level.trailing) {
                const peak = level.peakPrice || currentPrice;
                const newPeak = isLong ? Math.max(peak, currentPrice) : Math.min(peak, currentPrice);
                level.peakPrice = newPeak;
                const trailDist = level.trailingDistance / 100;
                const trailTrigger = isLong
                    ? newPeak * (1 - trailDist)
                    : newPeak * (1 + trailDist);
                const trailingTriggered = isLong ? currentPrice <= trailTrigger : currentPrice >= trailTrigger;
                if (trailingTriggered && newPeak !== currentPrice) {
                    const closeQty = Math.floor(totalQty * (level.pctOfPosition / 100));
                    if (closeQty > 0) {
                        const pnl = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
                        console.log(`[Strategy] Trailing stop hit at ${currentPrice}, closing ${closeQty}, PnL: ${pnl.toFixed(2)}%`);

                        if (activeTrade.order_id.startsWith('MOCK_')) {
                            const entryValueInr = parseFloat(activeTrade.entry_value_inr || 0);
                            const pnlInr = (entryValueInr * (level.pctOfPosition / 100)) * (pnl / 100);
                            const currentBalance = await this.db.getMockBalance();
                            await this.db.updateMockBalance(currentBalance + pnlInr);
                            // We don't close the whole trade yet because other parts might be open
                        } else {
                            const closeSide = isLong ? 'SELL' : 'BUY';
                            try {
                                await closePartialPosition(this.env, CONFIG.PAIR, closeSide, closeQty, CONFIG.LEVERAGE);
                            } catch (err) {
                                console.error('[Strategy] Trailing close failed:', err.message);
                            }
                        }
                        level.executed = true;
                    }
                }
                await this.db.updateTPLevels(activeTrade.order_id, tpLevels);
                // If this was the last level, close the trade in DB
                if (i === tpLevels.length - 1 && level.executed) {
                    await this.closeTradeInDb(activeTrade, currentPrice, 'TRAILING_STOP');
                }
                continue;
            }

            const tpReached = isLong ? currentPrice >= level.price : currentPrice <= level.price;
            if (tpReached) {
                const closeQty = Math.floor(totalQty * (level.pctOfPosition / 100));
                const pnl = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);

                if (closeQty > 0) {
                    console.log(`[Strategy] TP${i + 1} hit at ${currentPrice} (target: ${level.price}), closing ${closeQty} (${level.pctOfPosition}%)`);

                    if (activeTrade.order_id.startsWith('MOCK_')) {
                        const entryValueInr = parseFloat(activeTrade.entry_value_inr || 0);
                        const pnlInr = (entryValueInr * (level.pctOfPosition / 100)) * (pnl / 100);
                        const currentBalance = await this.db.getMockBalance();
                        await this.db.updateMockBalance(currentBalance + pnlInr);
                    } else {
                        const closeSide = isLong ? 'SELL' : 'BUY';
                        try {
                            await closePartialPosition(this.env, CONFIG.PAIR, closeSide, closeQty, CONFIG.LEVERAGE);
                        } catch (err) {
                            console.error('[Strategy] Partial TP close failed:', err.message);
                        }
                    }
                    level.executed = true;
                    await this.db.updateTPLevels(activeTrade.order_id, tpLevels);
                }

                // If last TP level, close trade
                if (i === tpLevels.length - 1) {
                    await this.closeTradeInDb(activeTrade, currentPrice, 'TP_FINAL');
                    return { status: 'TRADE_CLOSED', reason: 'TP_FINAL', pnl };
                }

                return { status: 'PARTIAL_TP', level: i + 1, price: currentPrice, closedQty: closeQty };
            }
        }
        return null;
    }

    async closeTradeInDb(activeTrade, currentPrice, reason) {
        const isLong = activeTrade.decision === 'BUY';
        const pnl = ((currentPrice - activeTrade.price) / activeTrade.price) * 100 * (isLong ? 1 : -1);

        let exitValueInr = null;
        let pnlInr = null;

        if (activeTrade.order_id.startsWith('MOCK_')) {
            const entryValueInr = parseFloat(activeTrade.entry_value_inr || 0);
            pnlInr = entryValueInr * (pnl / 100);
            exitValueInr = entryValueInr + pnlInr;
            // Balance already updated incrementally for partial TPs
        }

        await this.db.updateTradeStatus(
            activeTrade.order_id, 'CLOSED', currentPrice, pnl,
            reason, exitValueInr, pnlInr
        );
    }
    async checkCooldowns() {
        const todayTradeCount = await this.db.getTodayTradeCount();
        if (todayTradeCount >= CONFIG.MAX_TRADES_PER_DAY) {
            return { canTrade: false, reason: `Daily trade limit (${todayTradeCount}/${CONFIG.MAX_TRADES_PER_DAY})` };
        }
        const todayLossCount = await this.db.getTodayLossCount();
        if (todayLossCount >= CONFIG.MAX_LOSSES) {
            return { canTrade: false, reason: `Daily loss limit (${todayLossCount}/${CONFIG.MAX_LOSSES})` };
        }
        const lastLossTime = await this.db.getLastLossTime();
        if (lastLossTime) {
            const elapsed = Date.now() - lastLossTime;
            if (elapsed < CONFIG.COOLDOWN_AFTER_LOSS_MS) {
                const remaining = Math.ceil((CONFIG.COOLDOWN_AFTER_LOSS_MS - elapsed) / 60000);
                return { canTrade: false, reason: `Loss cooldown (${remaining}min remaining)` };
            }
        }
        return { canTrade: true };
    }
}
