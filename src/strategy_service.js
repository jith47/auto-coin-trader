import { placeOrder, getOpenPositions, getMarketPrice, getAccountBalance, closePartialPosition } from './coindcx.js';
import { fetchAllMarketData, computeIndicators } from './binance.js';
const CONFIG = {
    PAIR: 'B-DOGE_USDT',
    MARGIN_PERCENT: 60,
    LEVERAGE: 5,
    SL: {
        SWEEP_RECLAIM: 0.7,
        RELATIVE_WEAKNESS: 0.8,
        RELATIVE_STRENGTH: 0.8,
        TREND_CONTINUATION: 1.0,
    },
    SL_MIN: 0.6,
    SL_MAX: 1.5,
    MIN_RRR: 1.5,
    SCORE_THRESHOLD_SHORT: 70,
    SCORE_THRESHOLD_LONG: 80,
    KILL_CORR_BTC: 1.5,
    KILL_CORR_DOGE: 0.3,
    KILL_SESSION_EXTREME: 0.5,
    KILL_OVEREXTEND: 5.0,

    SWEEP_DOGE_PROXIMITY: 1.5,
    TREND_BTC_1H_MIN: 0.5,
    RW_DOGE_1H_THRESHOLD: -0.5,
    RS_DOGE_1H_THRESHOLD: 0.5,
    DIVERGE_DISTANCE_MIN: 1.0,
    TREND_DOGE_DIST_FROM_LOW_MIN: 0.8,
    TREND_DOGE_DIST_FROM_HIGH_MIN: 1.5,
    MAX_LOSSES: 3,
    COOLDOWN_AFTER_LOSS_MS: 30 * 60 * 1000,
    MAX_TRADES_PER_DAY: 10,
    MAX_DRAWDOWN_PCT: 30,
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
        console.log(`[Strategy] ── Evaluation Start(${CONFIG.MOCK_MODE ? 'MOCK' : 'REAL'} MODE) ──`);
        try {
            // 1. Fetch data FIRST
            const data = await fetchAllMarketData();

            this.indicators = computeIndicators(data, CONFIG);

            console.log('[Strategy] Indicators:', JSON.stringify({
                btcPrice: this.indicators.btc.price?.toFixed(0),
                dogePrice: this.indicators.doge.price?.toFixed(5),
                btcCvd: this.indicators.btc.cvdDirection + '/' + this.indicators.btc.cvdSlope,
                dogeCvd: this.indicators.doge.cvdDirection + '/' + this.indicators.doge.cvdSlope,
                doge1hCvd: this.indicators.doge.cvd1hDirection,
                btc1h: this.indicators.btc.change1h?.toFixed(2) + '%',
                btc5m: this.indicators.btc.change5m?.toFixed(2) + '%',
                doge1h: this.indicators.doge.change1h?.toFixed(2) + '%',
                doge5m: this.indicators.doge.change5m?.toFixed(2) + '%',
                relStrength: this.indicators.doge.relativeStrength,
                btcStructure: this.indicators.btc.structure,
                btcKeyLevel: this.indicators.btc.keyLevel,
                sectorBias: this.indicators.sector.bias,
                dogeRange: this.indicators.doge.dogeRange?.toFixed(1) + '%',
                volRatio: this.indicators.doge.volumeRatio?.toFixed(2),
                utcHour: this.indicators.session.hour?.toFixed(1),
            }));

            // 2. Manage existing trade
            const activeTrade = await db.getActiveTrade();
            if (activeTrade && activeTrade.status === 'OPEN') {
                return await this.manageTrade(activeTrade);
            }

            // 3. New trade checks
            const cooldownCheck = await this.checkCooldowns();
            if (!cooldownCheck.canTrade) {
                console.log(`[Strategy] Blocked: ${cooldownCheck.reason} `);
                return { status: 'BLOCKED', reason: cooldownCheck.reason };
            }

            // 4. Max drawdown circuit breaker
            if (CONFIG.MOCK_MODE) {
                const currentBalance = await this.db.getMockBalance();
                const drawdownPct = ((CONFIG.INITIAL_INR_BALANCE - currentBalance) / CONFIG.INITIAL_INR_BALANCE) * 100;
                if (drawdownPct >= CONFIG.MAX_DRAWDOWN_PCT) {
                    console.log(`[Strategy] CIRCUIT BREAKER: Drawdown ${drawdownPct.toFixed(1)}% exceeds ${CONFIG.MAX_DRAWDOWN_PCT}%`);
                    return { status: 'CIRCUIT_BREAKER', reason: `Max drawdown ${drawdownPct.toFixed(1)}%` };
                }
            }

            // 5. Check kill switches first (before setup evaluation per strategy doc)
            const killSwitchLong = this.checkKillSwitches(this.indicators, 'BUY');
            const killSwitchShort = this.checkKillSwitches(this.indicators, 'SELL');
            if (killSwitchLong && killSwitchShort) {
                console.log(`[Strategy] All directions blocked: LONG = ${killSwitchLong}, SHORT = ${killSwitchShort} `);
                return { status: 'KILL_SWITCH', reason: `Both blocked: ${killSwitchLong}; ${killSwitchShort} ` };
            }

            // 6. Identify matching setup
            const setup = this.evaluateSetups(this.indicators);
            if (!setup) {
                console.log('[Strategy] No valid setup');
                return { status: 'NO_SETUP' };
            }

            console.log(`[Strategy] Setup found: ${setup.type} ${setup.direction} `);

            // 7. Verify kill switch doesn't block the found direction
            const killSwitch = setup.direction === 'BUY' ? killSwitchLong : killSwitchShort;
            if (killSwitch) {
                console.log(`[Strategy] Kill switch triggered: ${killSwitch} `);
                return { status: 'KILL_SWITCH', reason: killSwitch };
            }

            // 8. Score and threshold check
            const score = this.scoreSignal(this.indicators, setup);
            const threshold = setup.direction === 'BUY' ? CONFIG.SCORE_THRESHOLD_LONG : CONFIG.SCORE_THRESHOLD_SHORT;
            console.log(`[Strategy] Score: ${score}/${threshold} (${setup.direction})`);
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
        if (isLong && ind.sector.bias !== 'bullish') {
            return `NO_LONG_SECTOR_NOT_BULLISH: Sector is ${ind.sector.bias}, longs require bullish`;
        }
        if (isLong && ind.doge.dailyChange - ind.btc.dailyChange > CONFIG.KILL_OVEREXTEND) {
            return 'NO_LONG_OVEREXTENDED: DOGE daily exceeds BTC by 5%+';
        }
        // Change 7: BTC daily < -1.5% blocks longs (macro headwind)
        if (isLong && ind.btc.dailyChange < -1.5) {
            return `NO_LONG_BTC_MACRO_BEARISH: BTC daily ${ind.btc.dailyChange.toFixed(1)}% (below -1.5%)`;
        }
        // Change 2: 1H CVD gate — block longs when DOGE 1h CVD is falling
        if (isLong && ind.doge.cvd1hDirection === 'falling') {
            return `NO_LONG_1H_CVD_FALLING: DOGE 1h CVD is falling (1m uptick is noise)`;
        }
        // Change 4: Momentum exhaustion — block shorts when BTC dumped hard but 5m shows reversal
        if (!isLong && ind.btc.change1h < -2 && ind.btc.change5m > 0.1) {
            return `NO_SHORT_MOMENTUM_EXHAUSTED: BTC 1h=${ind.btc.change1h.toFixed(1)}% but 5m=${ind.btc.change5m.toFixed(2)}% (reversal)`;
        }
        // Decoupled: correlation assumption broken
        if (ind.doge.relativeStrength === 'decoupled') {
            return 'NO_TRADE_DECOUPLED: DOGE-BTC correlation broken (>2% divergence)';
        }
        return null;
    }
    evaluateSetups(ind) {
        console.log('[Strategy] ── Setup Evaluation ──');
        console.log('[Strategy] Market State:', JSON.stringify({
            btcStructure: ind.btc.structure,
            btcCvd: ind.btc.cvdDirection + '/' + ind.btc.cvdSlope,
            dogeCvd: ind.doge.cvdDirection + '/' + ind.doge.cvdSlope,
            relStrength: ind.doge.relativeStrength,
            dogeDistHigh: ind.doge.distFromHigh?.toFixed(2) + '%',
            dogeDistLow: ind.doge.distFromLow?.toFixed(2) + '%',
            sector: ind.sector.bias,
            liquidations: ind.liquidations.recentEvent,
        }));

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
        // LONG — Hard gates: structure + CVD + proximity (3 gates)
        // Bonus: dogeCvd, sector, liquidation → handled by scoring
        const longChecks = {
            btcStructure: ind.btc.structure === 'sweep_reclaim_bullish',
            btcCvdRising: ind.btc.cvdDirection === 'rising',
            dogeNearLow: ind.doge.distFromLow <= CONFIG.SWEEP_DOGE_PROXIMITY,
        };
        console.log('[Strategy] SWEEP_RECLAIM_LONG:', JSON.stringify(longChecks));
        if (Object.values(longChecks).every(v => v)) return { type: 'SWEEP_RECLAIM', direction: 'BUY' };

        // SHORT — Hard gates: structure + CVD + proximity (3 gates)
        const shortChecks = {
            btcStructure: ind.btc.structure === 'sweep_reclaim_bearish',
            btcCvdFalling: ind.btc.cvdDirection === 'falling',
            dogeNearHigh: ind.doge.distFromHigh <= CONFIG.SWEEP_DOGE_PROXIMITY,
        };
        console.log('[Strategy] SWEEP_RECLAIM_SHORT:', JSON.stringify(shortChecks));
        if (Object.values(shortChecks).every(v => v)) return { type: 'SWEEP_RECLAIM', direction: 'SELL' };

        return null;
    }
    checkRelativeWeaknessShort(ind) {
        // Hard gates: divergence confirmed (4 gates, incl. sector filter)
        // Change 3: Block Setup B RW short when sector bullish
        const checks = {
            btcPositive: ind.btc.change1h > 0,
            dogeNegative: ind.doge.change1h < CONFIG.RW_DOGE_1H_THRESHOLD,
            dogeWeaker: ind.doge.relativeStrength === 'weaker',
            sectorNotBullish: ind.sector.bias !== 'bullish',
        };
        console.log('[Strategy] REL_WEAKNESS_SHORT:', JSON.stringify({
            ...checks,
            btcToppyBonus: ind.btc.structure === 'rejection' || ind.btc.keyLevel === 'at_resistance',
            dogeCvdFalling: ind.doge.cvdDirection === 'falling',
        }));
        if (Object.values(checks).every(v => v)) return { type: 'RELATIVE_WEAKNESS', direction: 'SELL' };
        return null;
    }
    checkRelativeStrengthLong(ind) {
        // Hard gates: divergence confirmed (3 gates)
        // Structure/keyLevel → OR, moved partly to scoring
        // Bug fix: btcSupport check belongs here, not in checkRelativeWeaknessShort
        const checks = {
            btcNegative: ind.btc.change1h < 0,
            dogePositive: ind.doge.change1h > CONFIG.RS_DOGE_1H_THRESHOLD,
            dogeStronger: ind.doge.relativeStrength === 'stronger',
        };
        console.log('[Strategy] REL_STRENGTH_LONG:', JSON.stringify({
            ...checks,
            btcBottomyBonus: ind.btc.structure === 'support_holding' || ind.btc.keyLevel === 'at_support',
            dogeCvdRising: ind.doge.cvdDirection === 'rising',
            doge1hCvd: ind.doge.cvd1hDirection,
        }));
        if (Object.values(checks).every(v => v)) return { type: 'RELATIVE_STRENGTH', direction: 'BUY' };
        return null;
    }
    checkTrendContinuation(ind) {
        // LONG — Hard gates: BTC trending + CVD + DOGE aligned (4 gates)
        // Dropped: sector, room, steep → scoring handles quality
        const longChecks = {
            btc1hStrong: ind.btc.change1h > CONFIG.TREND_BTC_1H_MIN,
            btcCvdRising: ind.btc.cvdDirection === 'rising',
            dogeAligned: ind.doge.relativeStrength === 'aligned' || ind.doge.relativeStrength === 'stronger',
            dogeCvdRising: ind.doge.cvdDirection === 'rising',
        };
        console.log('[Strategy] TREND_LONG:', JSON.stringify({
            ...longChecks,
            steepBonus: ind.btc.cvdSlope === 'steep',
            sectorBonus: ind.sector.bias === 'bullish',
        }));
        if (Object.values(longChecks).every(v => v)) return { type: 'TREND_CONTINUATION', direction: 'BUY' };

        // SHORT — Hard gates: BTC trending down + CVD + DOGE aligned (4 gates)
        const shortChecks = {
            btc1hWeak: ind.btc.change1h < -CONFIG.TREND_BTC_1H_MIN,
            btcCvdFalling: ind.btc.cvdDirection === 'falling',
            dogeAligned: ind.doge.relativeStrength === 'aligned' || ind.doge.relativeStrength === 'weaker',
            dogeCvdFalling: ind.doge.cvdDirection === 'falling',
        };
        console.log('[Strategy] TREND_SHORT:', JSON.stringify({
            ...shortChecks,
            steepBonus: ind.btc.cvdSlope === 'steep',
            sectorBonus: ind.sector.bias === 'bearish',
        }));
        if (Object.values(shortChecks).every(v => v)) return { type: 'TREND_CONTINUATION', direction: 'SELL' };

        return null;
    }
    scoreSignal(ind, setup) {
        // Max theoretical: 30+15+12+15+15+10+8+5 = 110
        // Threshold: 70 (~64% of max)
        let score = 0;
        const isLong = setup.direction === 'BUY';

        // 1. BTC Structure (30/20/15/0)
        if (ind.btc.structure === 'sweep_reclaim_bullish' || ind.btc.structure === 'sweep_reclaim_bearish') {
            score += 30;
        } else if (ind.btc.structure === 'rejection' || ind.btc.structure === 'support_holding') {
            score += 20;
        } else if (ind.btc.structure === 'breakout' || ind.btc.structure === 'breakdown') {
            score += 15;
        }

        // 2. BTC CVD aligned with direction (15 + 5 for steep)
        if ((isLong && ind.btc.cvdDirection === 'rising') || (!isLong && ind.btc.cvdDirection === 'falling')) {
            score += 15;
            if (ind.btc.cvdSlope === 'steep') {
                score += 5;
            }
        }

        // 3. DOGE CVD aligned with direction (12) — single check, no double count
        if ((isLong && ind.doge.cvdDirection === 'rising') || (!isLong && ind.doge.cvdDirection === 'falling')) {
            score += 12;
        }

        // 4. Relative strength favorable (15)
        if ((isLong && (ind.doge.relativeStrength === 'stronger' || ind.doge.relativeStrength === 'aligned')) ||
            (!isLong && (ind.doge.relativeStrength === 'weaker' || ind.doge.relativeStrength === 'aligned'))) {
            score += 15;
        }

        // 5. Position in range — near favorable extreme (15/10)
        const favorableDistance = isLong ? ind.doge.distFromLow : ind.doge.distFromHigh;
        if (favorableDistance <= 1) {
            score += 15;
        } else if (favorableDistance <= 2) {
            score += 10;
        }

        // 6. Sector tailwind (10/5) — always scored, never hard-gated
        if ((isLong && ind.sector.bias === 'bullish') || (!isLong && ind.sector.bias === 'bearish')) {
            score += 10;
        } else if (ind.sector.bias === 'mixed') {
            score += 5;
        }

        // 7. Key level alignment (8) — bonus for being at the right level
        if ((isLong && ind.btc.keyLevel === 'at_support') || (!isLong && ind.btc.keyLevel === 'at_resistance')) {
            score += 8;
        }

        // 8. Liquidation event (5)
        const liqEvent = ind.liquidations?.recentEvent || 'none';
        if ((isLong && liqEvent === 'longs_flushed') || (!isLong && liqEvent === 'shorts_squeezed')) {
            score += 5;
        }
        // 9. Volume penalty (-10 when thin market)
        const volRatio = ind.doge.volumeRatio || 1.0;
        if (volRatio < 0.5) {
            score -= 10;
            console.log(`[Strategy] Volume penalty: -10 (ratio: ${volRatio.toFixed(2)})`);
        }

        return score;
    }
    async buildSignal(ind, setup, score) {
        const entry = ind.doge.price;
        const slPercent = CONFIG.SL[setup.type] || 0.8;
        // Volatility-adaptive SL: scale by dogeRange/3, clamped 0.8x-1.5x
        const volatilityMultiplier = Math.max(0.8, Math.min(1.5, (ind.doge.dogeRange || 2.0) / 3.0));
        const adjustedSL = slPercent * volatilityMultiplier;
        const clampedSL = Math.min(Math.max(adjustedSL, CONFIG.SL_MIN), CONFIG.SL_MAX);
        console.log(`[Strategy] SL: base=${slPercent}%, volMult=${volatilityMultiplier.toFixed(2)}x, adjusted=${adjustedSL.toFixed(2)}%, clamped=${clampedSL.toFixed(2)}%`);
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

        // Position size is margin * leverage
        const positionValueUsd = marginAvailable * CONFIG.LEVERAGE;
        const quantity = Math.floor(positionValueUsd / entry);

        const slDistancePct = (Math.abs(entry - sl) / entry) * 100;
        const riskOnMarginPct = slDistancePct * CONFIG.LEVERAGE;

        console.log(`[Strategy] Margin-based sizing: margin=$${marginAvailable.toFixed(2)}, leverage=${CONFIG.LEVERAGE}x, posValue=$${positionValueUsd.toFixed(2)}, qty=${quantity}`);
        console.log(`[Strategy] Risk Profile: SL Distance=${slDistancePct.toFixed(2)}%, Risk on Margin=${riskOnMarginPct.toFixed(2)}%`);

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

                // Deduct entry fee
                const entryValueUsdt = signal.quantity * signal.entry;
                const feeUsdt = entryValueUsdt * 0.001; // 0.1% Fee
                const feeInr = feeUsdt * CONFIG.USD_INR_RATE;
                const currentBalance = await this.db.getMockBalance();
                await this.db.updateMockBalance(currentBalance - feeInr);
                console.log(`[Strategy] Mock Entry Fee deducted: ${feeInr.toFixed(2)} INR ($${feeUsdt.toFixed(4)})`);
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
        const currentPrice = this.indicators.doge.price;
        const entryPrice = parseFloat(activeTrade.price);
        const isLong = activeTrade.decision === 'BUY';
        const isMock = CONFIG.MOCK_MODE || activeTrade.order_id?.startsWith('MOCK_');

        if (isMock) {
            return await this.manageMockTrade(activeTrade, currentPrice, entryPrice, isLong);
        }
        return await this.manageLiveTrade(activeTrade, currentPrice, entryPrice, isLong);
    }

    async manageMockTrade(activeTrade, currentPrice, entryPrice, isLong) {
        try {
            const tpLevels = activeTrade.tp_levels ? JSON.parse(activeTrade.tp_levels) : [];
            const executedPct = tpLevels.filter(l => l.executed).reduce((sum, l) => sum + l.pctOfPosition, 0);
            const remainingFraction = (100 - executedPct) / 100;
            console.log(`[Strategy] Mock trade status: remaining=${(remainingFraction * 100).toFixed(0)}%, executed=${executedPct.toFixed(0)}%`);

            if (remainingFraction <= 0) {
                console.log(`[Strategy] Cleanup: Closing fully executed trade ${activeTrade.order_id}`);
                await this.closeTradeInDb(activeTrade, currentPrice, 'TP_CLEANUP');
                return { status: 'TRADE_CLOSED', reason: 'TP_CLEANUP' };
            }

            // Determine effective SL — move to break-even after any TP hit
            let slPrice = parseFloat(activeTrade.stop_loss);
            if (executedPct > 0) {
                // Break-even SL after first TP
                slPrice = entryPrice;
                console.log(`[Strategy] SL moved to break-even: ${slPrice} (${executedPct}% already closed)`);
            }

            // 1. Check SL
            const slHit = isLong ? currentPrice <= slPrice : currentPrice >= slPrice;
            if (slHit) {
                console.log(`[Strategy] MOCK SL hit at ${currentPrice} (SL: ${slPrice}, remaining: ${(remainingFraction * 100).toFixed(0)}%)`);
                const priceChangePct = ((slPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
                const pnl = priceChangePct * CONFIG.LEVERAGE;
                const entryValueInr = parseFloat(activeTrade.entry_value_inr || 0);
                const pnlInr = (entryValueInr * remainingFraction) * (pnl / 100);

                // Deduct exit fee on remaining portion
                const exitValueUsdt = (activeTrade.quantity * remainingFraction) * slPrice;
                const exitFeeInr = (exitValueUsdt * 0.001) * CONFIG.USD_INR_RATE;
                const finalPnlInr = pnlInr - exitFeeInr;

                const currentBalance = await this.db.getMockBalance();
                await this.db.updateMockBalance(currentBalance + finalPnlInr);
                console.log(`[Strategy] Mock SL Settlement: PnL=${pnlInr.toFixed(2)}, Fee=${exitFeeInr.toFixed(2)}, Final INR=${finalPnlInr.toFixed(2)}`);

                await this.db.updateTradeStatus(
                    activeTrade.order_id, 'CLOSED', slPrice, pnl,
                    'MOCK_SL_HIT', null, finalPnlInr
                );
                return { status: 'TRADE_CLOSED', reason: 'MOCK_SL_HIT', pnl, remainingFraction };
            }

            // 2. Check TP levels
            if (tpLevels.length > 0) {
                const totalQty = parseFloat(activeTrade.quantity);
                const tpResult = await this.checkAndExecutePartialTP(
                    tpLevels, currentPrice, totalQty, entryPrice, isLong, activeTrade
                );
                if (tpResult) return tpResult;
            }

            // 3. Position still open
            const unrealizedPct = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
            console.log(`[Strategy] Mock position open: price=${currentPrice}, unrealized=${(unrealizedPct * CONFIG.LEVERAGE).toFixed(2)}%, remaining=${(remainingFraction * 100).toFixed(0)}%`);
            return { status: 'IN_TRADE', currentPrice, unrealizedPct };
        } catch (err) {
            console.error('[Strategy] Mock trade management error:', err.message);
            return { status: 'MANAGE_ERROR', error: err.message };
        }
    }

    async manageLiveTrade(activeTrade, currentPrice, entryPrice, isLong) {
        try {
            const positions = await getOpenPositions(this.env);
            const dogePos = positions?.find?.(p => p.pair === CONFIG.PAIR);

            if (!dogePos || parseFloat(dogePos.quantity || 0) === 0) {
                console.log('[Strategy] Position closed on exchange');
                const pnl = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1) * CONFIG.LEVERAGE;
                await this.db.updateTradeStatus(
                    activeTrade.order_id, 'CLOSED', currentPrice, pnl,
                    'EXCHANGE_CLOSED (SL/TP/MANUAL)'
                );
                return { status: 'TRADE_CLOSED', reason: 'EXCHANGE_CLOSED', pnl };
            }

            const currentQty = parseFloat(dogePos.quantity);
            const tpLevels = activeTrade.tp_levels ? JSON.parse(activeTrade.tp_levels) : [];
            if (tpLevels.length > 0) {
                const tpResult = await this.checkAndExecutePartialTP(
                    tpLevels, currentPrice, currentQty, entryPrice, isLong, activeTrade
                );
                if (tpResult) return tpResult;
            }

            console.log(`[Strategy] Position still open: qty=${currentQty} price=${currentPrice}`);
            return { status: 'IN_TRADE', position: dogePos };
        } catch (err) {
            console.error('[Strategy] Live trade management error:', err.message);
            return { status: 'MANAGE_ERROR', error: err.message };
        }
    }

    async checkAndExecutePartialTP(tpLevels, currentPrice, totalQty, entryPrice, isLong, activeTrade) {
        const isMock = CONFIG.MOCK_MODE || activeTrade.order_id?.startsWith('MOCK_');
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
                        const priceChangePct = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
                        const pnl = priceChangePct * CONFIG.LEVERAGE;
                        console.log(`[Strategy] Trailing stop hit at ${currentPrice}, closing ${closeQty} (${level.pctOfPosition}%), PnL: ${pnl.toFixed(2)}%`);

                        if (isMock) {
                            const entryValueInr = parseFloat(activeTrade.entry_value_inr || 0);
                            const pnlInr = (entryValueInr * (level.pctOfPosition / 100)) * (pnl / 100);
                            const currentBalance = await this.db.getMockBalance();
                            await this.db.updateMockBalance(currentBalance + pnlInr);
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
                if (i === tpLevels.length - 1 && level.executed) {
                    await this.closeTradeInDb(activeTrade, currentPrice, 'TRAILING_STOP');
                }
                continue;
            }

            const tpReached = isLong ? currentPrice >= level.price : currentPrice <= level.price;
            if (tpReached) {
                const closeQty = Math.floor(totalQty * (level.pctOfPosition / 100));
                const priceChangePct = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
                const pnl = priceChangePct * CONFIG.LEVERAGE;

                if (closeQty > 0) {
                    console.log(`[Strategy] TP${i + 1} hit at ${currentPrice} (target: ${level.price}), closing ${closeQty} (${level.pctOfPosition}%), PnL: ${pnl.toFixed(2)}%`);

                    if (isMock) {
                        const entryValueInr = parseFloat(activeTrade.entry_value_inr || 0);
                        const pnlInr = (entryValueInr * (level.pctOfPosition / 100)) * (pnl / 100);

                        // Deduct exit fee for this partial TP
                        const exitValueUsdt = (totalQty * (level.pctOfPosition / 100)) * currentPrice;
                        const exitFeeInr = (exitValueUsdt * 0.001) * CONFIG.USD_INR_RATE;
                        const finalPnlInr = pnlInr - exitFeeInr;

                        const currentBalance = await this.db.getMockBalance();
                        await this.db.updateMockBalance(currentBalance + finalPnlInr);
                        console.log(`[Strategy] Mock TP Hit: PnL=${pnlInr.toFixed(2)} INR, Fee=${exitFeeInr.toFixed(2)} INR, Net=${finalPnlInr.toFixed(2)} INR`);
                    } else {
                        const closeSide = isLong ? 'SELL' : 'BUY';
                        try {
                            await closePartialPosition(this.env, CONFIG.PAIR, closeSide, closeQty, CONFIG.LEVERAGE);
                        } catch (err) {
                            console.error('[Strategy] Partial TP close failed:', err.message);
                        }
                    }
                    level.executed = true;
                    // Sync memory to prevent stale checks in same run
                    activeTrade.tp_levels = JSON.stringify(tpLevels);
                    await this.db.updateTPLevels(activeTrade.order_id, tpLevels);
                }

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
        const entryPrice = parseFloat(activeTrade.price);
        const priceChangePct = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
        const pnl = priceChangePct * CONFIG.LEVERAGE;

        let exitValueInr = null;
        let pnlInr = null;

        if (CONFIG.MOCK_MODE || activeTrade.order_id?.startsWith('MOCK_')) {
            const entryValueInr = parseFloat(activeTrade.entry_value_inr || 0);
            const tpLevels = activeTrade.tp_levels ? JSON.parse(activeTrade.tp_levels) : [];
            const executedPct = tpLevels.filter(l => l.executed).reduce((sum, l) => sum + l.pctOfPosition, 0);
            const remainingFraction = (100 - executedPct) / 100;
            // Only apply PnL to the remaining portion (partial TPs already settled)
            pnlInr = (entryValueInr * remainingFraction) * (pnl / 100);
            exitValueInr = entryValueInr + pnlInr;
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
