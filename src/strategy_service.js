import { placeOrder, getOpenPositions, getMarketPrice, getAccountBalance, closePartialPosition, getInstrumentDetails, getINRFuturesBalance, getTradeHistory } from './coindcx.js';
import { fetchAllMarketData, computeIndicators } from './binance.js';
const CONFIG = {
    PAIR: 'B-DOGE_USDT',
    MARGIN_CURRENCY: 'INR',
    MARGIN_PERCENT: 70,
    DEFAULT_LEVERAGE: 5,
    SL: {
        SWEEP_RECLAIM: 0.9,
        RELATIVE_WEAKNESS: 1.0,
        RELATIVE_STRENGTH: 1.0,
        TREND_CONTINUATION: 1.2,
        RANGE_REJECTION: 1.0, // Same as RS for Setup D
    },
    SL_MIN: 0.8,
    SL_MAX: 1.5,
    MIN_RRR: 1.5,
    SCORE_THRESHOLD: 70,
    TREND_BTC_1H_MIN: 0.7, // Lowered from 1.0 for more sensitivity
    KILL_CORR_BTC: 1.5,
    KILL_CORR_DOGE: 0.3,
    KILL_SESSION_EXTREME: 0.5,
    KILL_OVEREXTEND: 5.0,
    KILL_DAILY_EXHAUSTION: -4.0,

    SWEEP_DOGE_PROXIMITY: 1.5,
    RW_DOGE_1H_THRESHOLD: -0.1,
    RS_DOGE_1H_THRESHOLD: 0.1,
    RANGE_PROXIMITY: 1.5, // 1.5% distance for Setup D

    DIVERGE_DISTANCE_MIN: 1.0,
    TREND_DOGE_DIST_FROM_LOW_MIN: 0.8,
    TREND_DOGE_DIST_FROM_HIGH_MIN: 1.5,

    MAX_LOSSES_DAILY: 5,
    MAX_DAILY_DRAWDOWN_PCT: 2.0,
    MAX_ACCOUNT_DRAWDOWN_PCT: 30,

    COOLDOWN_AFTER_LOSS_MS: 30 * 60 * 1000,
    MAX_TRADES_PER_DAY: 10,

    NYSE_OPEN_UTC: 13.5,
    NYSE_CLOSE_UTC: 14.0,
    STOP_WIDEN_FACTOR: 1.15,

    MOCK_MODE: false, // Set to true for mock trading
    INITIAL_INR_BALANCE: 500,
    MIN_BALANCE_INR: 50, // Safety floor — don't trade below this
    USD_INR_RATE: 85, // Simple rate for conversion
    TP_PROFILES: {
        // R:R-based TP levels matching strategy doc
        SWEEP_RECLAIM: [{ pctOfPosition: 80, rrMultiple: 1.5 }, { pctOfPosition: 20, rrMultiple: 2.5 }],
        RELATIVE_WEAKNESS: [{ pctOfPosition: 50, rrMultiple: 0.8 }, { pctOfPosition: 50, rrMultiple: 1.5 }],
        RELATIVE_STRENGTH: [{ pctOfPosition: 50, rrMultiple: 0.8 }, { pctOfPosition: 50, rrMultiple: 1.5 }],
        TREND_CONTINUATION: [{ pctOfPosition: 50, rrMultiple: 1.5 }, { pctOfPosition: 30, rrMultiple: 2.0 }, { pctOfPosition: 20, trailing: true, trailingDistance: 0.4 }],
        RANGE_REJECTION: [{ pctOfPosition: 50, rrMultiple: 0.8 }, { pctOfPosition: 50, rrMultiple: 1.5 }],
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
        // TEMPORARY: One-time fix for mock balance inflation. Remove after one run.
        if (CONFIG.MOCK_MODE) {
            const hasRestored = await this.db.getSetting('balance_restored_mar_04', 'false');
            if (hasRestored === 'false') {
                await this.fixMockBalance();
                await this.db.updateSetting('balance_restored_mar_04', 'true');
            }
        }
        console.log(`[Strategy] ── Evaluation Start(${CONFIG.MOCK_MODE ? 'MOCK' : 'REAL'} MODE) ──`);
        try {
            // 1. Fetch scouting data FIRST (to have currentPrice for sync/management)
            const [data, instrumentInfo] = await Promise.all([
                fetchAllMarketData(),
                CONFIG.MOCK_MODE ? Promise.resolve(null) : getInstrumentDetails(CONFIG.PAIR),
            ]);

            // Extract current DOGE price from kline data for sync/management fallback
            const dogeKlines = data?.doge?.klines1m;
            const currentPrice = (Array.isArray(dogeKlines) && dogeKlines.length > 0)
                ? dogeKlines[dogeKlines.length - 1].close
                : 0;

            // 2. Reconciliation & Sync
            let positions = [];
            if (!CONFIG.MOCK_MODE) {
                positions = await getOpenPositions(this.env);
                console.log(`[Strategy] Sync: Fetched ${Array.isArray(positions) ? positions.length : 0} positions from exchange.`);
            }

            const activeTrade = await db.getActiveTrade();
            const reconciliation = await this.reconcileTrades(activeTrade, positions, currentPrice);

            if (reconciliation.status === 'TRADE_CLOSED') {
                console.log(`[Strategy] Trade sync completed: CLOSED. Exiting early.`);
                return reconciliation;
            }

            // 3. Manage Open Trade if exists
            if (activeTrade && reconciliation.status === 'SYNC_STILL_OPEN') {
                console.log(`[Strategy] Trade sync: STILL_OPEN. Managing trade...`);
                return await this.manageTrade(activeTrade, currentPrice);
            }

            if (reconciliation.status === 'RECOVERED') {
                console.log(`[Strategy] Trade sync: RECOVERED orphaned trade. Exiting to allow management in next cycle...`);
                return reconciliation;
            }

            // 4. Proceed to Scouting (if no active trade)
            if (instrumentInfo) {
                this.leverage = Math.min(instrumentInfo.maxLeverage, CONFIG.DEFAULT_LEVERAGE);
                this.minQuantity = instrumentInfo.minQuantity || 1;
                this.stepSize = instrumentInfo.stepSize || 1;
                this.tickSize = instrumentInfo.tickSize || 0.00001;
                console.log(`[Strategy] Instrument: maxLeverage=${instrumentInfo.maxLeverage}, using=${this.leverage}x, minQty=${this.minQuantity}, step=${this.stepSize}, tick=${this.tickSize}`);
            } else {
                this.leverage = CONFIG.DEFAULT_LEVERAGE;
                this.minQuantity = 1;
                this.stepSize = 1;
                this.tickSize = 0.00001;
                console.log(`[Strategy] Using default leverage: ${this.leverage}x`);
            }

            this.indicators = computeIndicators(data, CONFIG);

            console.log('[Strategy] Indicators:', JSON.stringify({
                btcPrice: this.indicators.btc.price?.toFixed(0),
                dogePrice: this.indicators.doge.price?.toFixed(5),
                btcCvd: this.indicators.btc.cvdDirection + '/' + this.indicators.btc.cvdSlope,
                dogeCvd: this.indicators.doge.cvdDirection + '/' + this.indicators.doge.cvdSlope,
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
                if (drawdownPct >= CONFIG.MAX_DAILY_DRAWDOWN_PCT) {
                    console.log(`[Strategy] CIRCUIT BREAKER: Mock balance ₹${currentBalance.toFixed(2)} (Drawdown ${drawdownPct.toFixed(1)}%)`);
                    return { status: 'CIRCUIT_BREAKER', reason: `Mock balance below drawdown limit (${drawdownPct.toFixed(1)}%)` };
                }
            } else {
                // Real mode: check INR balance floor
                const inrBalance = await getINRFuturesBalance(this.env);
                if (inrBalance !== null && inrBalance < CONFIG.MIN_BALANCE_INR) {
                    console.log(`[Strategy] CIRCUIT BREAKER: INR balance ₹${inrBalance.toFixed(2)} below minimum ₹${CONFIG.MIN_BALANCE_INR}`);
                    return { status: 'CIRCUIT_BREAKER', reason: `INR balance ₹${inrBalance.toFixed(2)} below minimum` };
                }
            }

            // 5. Check kill switches for both directions to log status
            const killSwitchLong = await this.checkKillSwitches(this.indicators, { direction: 'BUY' });
            const killSwitchShort = await this.checkKillSwitches(this.indicators, { direction: 'SELL' });
            if (killSwitchLong.triggered && killSwitchShort.triggered) {
                console.log(`[Strategy] All directions blocked: LONG = ${killSwitchLong.reason}, SHORT = ${killSwitchShort.reason} `);
                return { status: 'KILL_SWITCH', reason: `Both blocked: ${killSwitchLong.reason}; ${killSwitchShort.reason} ` };
            }

            // 6. Identify matching setup
            const setup = this.evaluateSetups(this.indicators);
            if (!setup) {
                // Clear structure detection time if no setup found (to reset timer)
                await this.db.updateSetting('structure_detected_at', 0);
                await this.db.updateSetting('last_detected_structure', 'none');
                console.log('[Strategy] No valid setup');
                return { status: 'NO_SETUP' };
            }

            // 6b. Fix 4: 60s Reclaim Hold for Setup A
            if (setup.type === 'SWEEP_RECLAIM') {
                const now = Date.now();
                const lastStructure = await this.db.getSetting('last_detected_structure', 'none');
                const currentStructure = `${setup.type}_${setup.direction}`;

                if (lastStructure !== currentStructure) {
                    await this.db.updateSetting('last_detected_structure', currentStructure);
                    await this.db.updateSetting('structure_detected_at', now);
                    console.log(`[Strategy] Setup A detected. Starting 60s hold timer for ${currentStructure}`);
                    return { status: 'WAITING_FOR_CONFIRMATION', reason: 'Setup A requires 60s hold', currentStructure };
                } else {
                    const detectedAt = parseInt(await this.db.getSetting('structure_detected_at', '0'));
                    const elapsed = now - detectedAt;
                    if (elapsed < 60000) {
                        const remaining = Math.ceil((60000 - elapsed) / 1000);
                        console.log(`[Strategy] Setup A detected. Hold timer: ${elapsed / 1000}s / 60s (${remaining}s remaining)`);
                        return { status: 'WAITING_FOR_CONFIRMATION', reason: 'Setup A requires 60s hold', remaining };
                    }
                    console.log(`[Strategy] Setup A 60s hold confirmed (${elapsed / 1000}s)`);
                }
            }

            console.log(`[Strategy] Setup found and confirmed: ${setup.type} ${setup.direction} `);

            // 7. Verify kill switch doesn't block the found direction
            const killSwitch = setup.direction === 'BUY' ? killSwitchLong : killSwitchShort;
            if (killSwitch.triggered) {
                console.log(`[Strategy] Kill switch triggered: ${killSwitch.reason} `);
                return { status: 'KILL_SWITCH', reason: killSwitch.reason };
            }

            // 8. Score and threshold check
            const score = this.scoreSignal(this.indicators, setup);
            const threshold = CONFIG.SCORE_THRESHOLD;
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
    async checkKillSwitches(ind, setup) {
        const isLong = setup.direction === 'BUY';

        // 1. Correlation Divergence (BTC crashing while DOGE tries to bounce)
        if (isLong && ind.btc.change1h < -CONFIG.KILL_CORR_BTC && ind.doge.change1h > CONFIG.KILL_CORR_DOGE) {
            return { triggered: true, reason: 'BTC crashing; DOGE bounce likely fake' };
        }

        // 2. Session Extreme "Hole" Filter
        if (isLong && ind.doge.distFromHigh < CONFIG.KILL_SESSION_EXTREME) {
            return { triggered: true, reason: 'DOGE at session high' };
        }
        if (!isLong && ind.doge.distFromLow < CONFIG.KILL_SESSION_EXTREME) {
            return { triggered: true, reason: 'DOGE at session low' };
        }

        // 3. Falling CVD on Longs (Standard distribution)
        if (isLong && (ind.btc.cvdDirection === 'falling' || ind.doge.cvdDirection === 'falling')) {
            return { triggered: true, reason: 'Falling CVD on LONG attempt' };
        }

        // 4. Overextension Warning (DOGE moved too far relative to BTC)
        const dailyDiff = ind.doge.dailyChange - ind.btc.dailyChange;
        if (isLong && dailyDiff > CONFIG.KILL_OVEREXTEND) {
            return { triggered: true, reason: `DOGE overextended vs BTC (+${dailyDiff.toFixed(1)}%)` };
        }

        // 5. Macro Sector Bias (Optional but protective)
        if (isLong && ind.sector.bias === 'bearish') {
            return { triggered: true, reason: 'Macro sector bias is bearish' };
        }

        // 6. Exhaustion Filter for Shorts (Fix 4)
        if (!isLong && ind.doge.dailyChange < CONFIG.KILL_DAILY_EXHAUSTION) {
            return { triggered: true, reason: `DOGE already down ${ind.doge.dailyChange}% (Exhaustion)` };
        }

        return { triggered: false };
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
        const rangeSetup = this.checkRangeRejection(ind);
        if (rangeSetup) return rangeSetup;
        return null;
    }
    checkSweepReclaim(ind) {
        // LONG — Hard gates: structure + CVD + proximity (3 gates)
        const isSweep = ind.btc.structure === 'sweep_reclaim_bullish';
        const isSupport = ind.btc.structure === 'support_holding' && ind.btc.distFromLow < 0.25;

        const longChecks = {
            btcStructure: isSweep || isSupport,
            btcCvdRising: ind.btc.cvdDirection === 'rising',
            dogeNearLow: ind.doge.distFromLow <= CONFIG.SWEEP_DOGE_PROXIMITY,
        };
        console.log('[Strategy] Setup A (BUY) checks:', JSON.stringify(longChecks));
        if (Object.values(longChecks).every(v => v)) return { type: 'SWEEP_RECLAIM', direction: 'BUY' };

        // SHORT — Hard gates: structure + CVD + proximity (3 gates)
        const isSqueeze = ind.btc.structure === 'sweep_reclaim_bearish';
        const isRejection = ind.btc.structure === 'rejection' && ind.btc.distFromHigh < 0.25;

        const shortChecks = {
            btcStructure: isSqueeze || isRejection,
            btcCvdFalling: ind.btc.cvdDirection === 'falling',
            dogeNearHigh: ind.doge.distFromHigh <= CONFIG.SWEEP_DOGE_PROXIMITY,
        };
        console.log('[Strategy] Setup A (SELL) checks:', JSON.stringify(shortChecks));
        if (Object.values(shortChecks).every(v => v)) return { type: 'SWEEP_RECLAIM', direction: 'SELL' };

        return null;
    }
    checkRelativeWeaknessShort(ind) {
        // Hard gates: divergence confirmed + structure not bullish (4 gates)
        const checks = {
            btcPositive: ind.btc.change1h > 0,
            dogeNegative: ind.doge.change1h < CONFIG.RW_DOGE_1H_THRESHOLD,
            dogeWeaker: ind.doge.relativeStrength === 'weaker',
            dogeNearHigh: ind.doge.distFromHigh < 1.5, // Positional filter: don't short the bottom
            notBtcSupport: ind.btc.structure !== 'support_holding',
            notBtcBullish: !['breakout', 'sweep_reclaim_bullish', 'support_holding'].includes(ind.btc.structure), // Don't fight the king
        };
        console.log('[Strategy] Setup B (SELL) checks:', JSON.stringify(checks));
        if (Object.values(checks).every(v => v)) return { type: 'RELATIVE_WEAKNESS', direction: 'SELL' };
        return null;
    }
    checkRelativeStrengthLong(ind) {
        // Hard gates: divergence confirmed + structure not bearish (4 gates)
        const checks = {
            btcNeutral: ind.btc.change1h < 0.25, // Relaxed from strict negative (< 0)
            dogePositive: ind.doge.change1h > CONFIG.RS_DOGE_1H_THRESHOLD,
            dogeStronger: ind.doge.relativeStrength === 'stronger',
            dogeNearLow: ind.doge.distFromLow < 1.5, // Positional filter: don't long the top
            notBtcRejection: ind.btc.structure !== 'rejection',
            notBtcBearish: !['breakdown', 'sweep_reclaim_bearish', 'rejection'].includes(ind.btc.structure), // Don't fight the king
        };
        console.log('[Strategy] Setup B (BUY) checks:', JSON.stringify(checks));
        if (Object.values(checks).every(v => v)) return { type: 'RELATIVE_STRENGTH', direction: 'BUY' };
        return null;
    }
    checkTrendContinuation(ind) {
        // LONG — Hard gates: BTC strong trend + CVD steep/gradual + DOGE stronger (4 gates)
        const longChecks = {
            btc1hStrong: ind.btc.change1h > CONFIG.TREND_BTC_1H_MIN,
            btcCvdRising: ind.btc.cvdDirection === 'rising',
            btcNotFlat: ind.btc.cvdSlope !== 'flat',
            dogeStronger: ind.doge.relativeStrength === 'stronger',
            dogeCvdRising: ind.doge.cvdDirection === 'rising',
        };
        console.log('[Strategy] Setup C (BUY) checks:', JSON.stringify(longChecks));
        if (Object.values(longChecks).every(v => v)) return { type: 'TREND_CONTINUATION', direction: 'BUY' };

        // SHORT — Hard gates: BTC strong downtrend + CVD + DOGE weaker (4 gates)
        const shortChecks = {
            btc1hWeak: ind.btc.change1h < -CONFIG.TREND_BTC_1H_MIN,
            btcCvdFalling: ind.btc.cvdDirection === 'falling',
            btcNotFlat: ind.btc.cvdSlope !== 'flat',
            dogeWeaker: ind.doge.relativeStrength === 'weaker',
            dogeCvdFalling: ind.doge.cvdDirection === 'falling',
        };
        console.log('[Strategy] Setup C (SELL) checks:', JSON.stringify(shortChecks));
        if (Object.values(shortChecks).every(v => v)) return { type: 'TREND_CONTINUATION', direction: 'SELL' };

        return null;
    }
    checkRangeRejection(ind) {
        // Setup D: DOGE trades its OWN key levels independently if BTC is neutral

        // SELL Case: DOGE at 24h High + Rejection
        const shortChecks = {
            dogeAtResistance: ind.doge.distFromHigh <= CONFIG.RANGE_PROXIMITY,
            dogeStructure: ind.doge.structure === 'rejection' || ind.doge.structure === 'sweep_reclaim_bearish',
            btcNotUltraBullish: ind.btc.change1h < 0.5, // Allow shorting range if BTC isn't vertical
        };
        console.log('[Strategy] Setup D (SELL) checks:', JSON.stringify(shortChecks));
        if (Object.values(shortChecks).every(v => v)) return { type: 'RANGE_REJECTION', direction: 'SELL' };

        // BUY Case: DOGE at 24h Low + Support Hold
        const longChecks = {
            dogeAtSupport: ind.doge.distFromLow <= CONFIG.RANGE_PROXIMITY,
            dogeStructure: ind.doge.structure === 'support_holding' || ind.doge.structure === 'sweep_reclaim_bullish',
            btcNotUltraBearish: ind.btc.change1h > -0.5, // Allow buying support if BTC isn't freefalling
        };
        console.log('[Strategy] Setup D (BUY) checks:', JSON.stringify(longChecks));
        if (Object.values(longChecks).every(v => v)) return { type: 'RANGE_REJECTION', direction: 'BUY' };

        return null;
    }
    scoreSignal(ind, setup) {
        // Max theoretical: 30+15+12+15+15+10+8+5 = 110
        // Threshold: 70 (~64% of max)
        let score = 0;
        const isLong = setup.direction === 'BUY';

        // 1. BTC Structure (30/20/15/0)
        const isSweep = ind.btc.structure === 'sweep_reclaim_bullish' || ind.btc.structure === 'sweep_reclaim_bearish';
        const isExtremeRejection = (ind.btc.structure === 'rejection' && ind.btc.distFromHigh < 0.25) ||
            (ind.btc.structure === 'support_holding' && ind.btc.distFromLow < 0.25);

        if (isSweep || isExtremeRejection) {
            score += 30; // Both sweep and extreme rejection are high conviction
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

        // Fix 4: Volatility-adaptive SL + NYSE Stop Widening
        const volatilityMultiplier = Math.max(0.8, Math.min(1.5, (ind.doge.dogeRange || 2.0) / 3.0));
        let adjustedSL = slPercent * volatilityMultiplier;

        const utcHour = ind.session.hour;
        if (utcHour >= CONFIG.NYSE_OPEN_UTC && utcHour <= CONFIG.NYSE_CLOSE_UTC) {
            console.log(`[Strategy] NYSE Open volatility detected (UTC ${utcHour.toFixed(2)}). Widening SL ${CONFIG.STOP_WIDEN_FACTOR}x`);
            adjustedSL *= CONFIG.STOP_WIDEN_FACTOR;
        }

        const clampedSL = Math.min(Math.max(adjustedSL, CONFIG.SL_MIN), CONFIG.SL_MAX);
        console.log(`[Strategy] SL logic: base=${slPercent}%, volBonus=${volatilityMultiplier.toFixed(2)}x, final=${clampedSL.toFixed(2)}%`);

        const slPrice = setup.direction === 'BUY'
            ? entry * (1 - clampedSL / 100)
            : entry * (1 + clampedSL / 100);

        const sl = this.roundToTick(slPrice, this.tickSize || 0.00001);
        const slDistance = Math.abs(entry - sl);

        // Fix 4: 50/50 TP Profiles
        const tpProfile = CONFIG.TP_PROFILES[setup.type];
        const tpLevels = tpProfile.map(level => {
            if (level.trailing) {
                return { ...level, price: null };
            }
            let price;
            if (level.fixedTpPct) {
                price = setup.direction === 'BUY'
                    ? entry * (1 + level.fixedTpPct / 100)
                    : entry * (1 - level.fixedTpPct / 100);
            } else {
                price = setup.direction === 'BUY'
                    ? entry + (slDistance * level.rrMultiple)
                    : entry - (slDistance * level.rrMultiple);
            }
            const roundedPrice = this.roundToTick(price, this.tickSize || 0.00001);
            return { ...level, price: roundedPrice };
        });

        const firstTpPrice = tpLevels.find(l => l.price !== null)?.price || entry;

        // Calculate INR exposure
        let inrBalance = CONFIG.INITIAL_INR_BALANCE;
        if (CONFIG.MOCK_MODE) {
            inrBalance = await this.db.getMockBalance();
        } else {
            const realInr = await getINRFuturesBalance(this.env);
            if (realInr !== null) {
                inrBalance = realInr;
            }
        }
        const marginInr = inrBalance * (CONFIG.MARGIN_PERCENT / 100);

        const quantity = await this.calculateQuantity(entry, sl, inrBalance);
        return {
            decision: setup.direction,
            reason: `${setup.type} | Score:${score} | BTC:${ind.btc.structure} | CVD:${ind.btc.cvdDirection}/${ind.doge.cvdDirection} | RS:${ind.doge.relativeStrength}`,
            orderType: 'MARKET',
            quantity,
            leverage: this.leverage,
            entry,
            stopLoss: sl,
            takeProfit: firstTpPrice,
            tpLevels,
            setupType: setup.type,
            score,
            entryValueInr: marginInr,
        };
    }
    roundToTick(price, tick) {
        if (!tick || tick <= 0) return parseFloat(price.toFixed(6));
        const rounded = Math.round(price / tick) * tick;
        // Clean up JS floating point noise (e.g. 0.092350000000001)
        const decimals = tick.toString().includes('.') ? tick.toString().split('.')[1].length : 0;
        return parseFloat(rounded.toFixed(decimals));
    }
    async calculateQuantity(entry, sl, mockInrBalance = null) {
        let balanceUsd = 100;
        if (CONFIG.MOCK_MODE && mockInrBalance) {
            balanceUsd = mockInrBalance / CONFIG.USD_INR_RATE;
        } else {
            // Real mode: fetch INR balance and convert to USD equivalent
            try {
                const inrBalance = await getINRFuturesBalance(this.env);
                if (inrBalance !== null) {
                    balanceUsd = inrBalance / CONFIG.USD_INR_RATE;
                } else {
                    console.error('[Strategy] Could not fetch INR balance, using fallback');
                    balanceUsd = (mockInrBalance || CONFIG.INITIAL_INR_BALANCE) / CONFIG.USD_INR_RATE;
                }
            } catch (err) {
                console.error('[Strategy] Failed to fetch balance, using fallback:', err.message);
                balanceUsd = CONFIG.INITIAL_INR_BALANCE / CONFIG.USD_INR_RATE;
            }
        }

        const leverage = this.leverage || CONFIG.DEFAULT_LEVERAGE;
        console.log(`[Strategy] Account balance: ${balanceUsd.toFixed(2)} USD (Equivalent), Leverage: ${leverage}x`);

        const marginAvailable = balanceUsd * (CONFIG.MARGIN_PERCENT / 100);

        // Position size is margin * leverage
        const positionValueUsd = marginAvailable * leverage;
        let quantity = Math.floor(positionValueUsd / entry);

        // Align to exchange step size
        const stepSize = this.stepSize || 1;
        if (stepSize > 0 && stepSize < 1) {
            // Fractional step (e.g., 0.1): round down to nearest step
            quantity = Math.floor(quantity / stepSize) * stepSize;
            quantity = parseFloat(quantity.toFixed(8));
        } else {
            quantity = Math.floor(quantity / stepSize) * stepSize;
        }

        // Enforce minimum quantity from exchange
        const minQty = this.minQuantity || 1;
        if (quantity < minQty) {
            console.log(`[Strategy] Quantity ${quantity} below exchange minimum ${minQty}, using minimum`);
            quantity = minQty;
        }

        // Sanity check for astronomical values
        if (quantity > 1e12) {
            console.error(`[Strategy] CRITICAL: Astronomical quantity detected (${quantity}). Clamping to 0 to prevent DB corruption.`);
            quantity = 0;
        }

        const slDistancePct = (Math.abs(entry - sl) / entry) * 100;
        const riskOnMarginPct = slDistancePct * leverage;

        console.log(`[Strategy] Margin-based sizing: margin=$${marginAvailable.toFixed(2)}, leverage=${leverage}x, posValue=$${positionValueUsd.toFixed(2)}, qty=${quantity}`);
        console.log(`[Strategy] Risk Profile: SL Distance=${slDistancePct.toFixed(2)}%, Risk on Margin=${riskOnMarginPct.toFixed(2)}%`);

        return quantity > 0 ? quantity : minQty;
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
                    signal.orderType, signal.entry, CONFIG.MARGIN_CURRENCY
                );
                console.log('[Strategy] Order result:', JSON.stringify(result, null, 2));
            }

            // Normalize CoinDCX response: API returns a raw array of orders, not {status, orders}
            // Mock mode returns {mock: true, status: 'success', orders: [...]}
            let orders, orderId, isSuccess;
            if (result?.mock) {
                orders = result.orders || [];
                orderId = orders[0]?.id;
                isSuccess = true;
            } else if (Array.isArray(result) && result.length > 0) {
                // CoinDCX real response: [{id: '...', status: 'initial', ...}]
                orders = result;
                orderId = result[0]?.id;
                isSuccess = !!orderId;
                console.log(`[Strategy] CoinDCX order accepted. ID: ${orderId}, Status: ${result[0]?.status}`);
            } else if (result?.message || result?.error) {
                // CoinDCX error response
                isSuccess = false;
                console.error(`[Strategy] CoinDCX rejected order: ${result.message || result.error}`);
            } else {
                isSuccess = false;
            }

            if (isSuccess && orderId) {
                // For real trades, use CoinDCX's actual margin calculation
                if (!result?.mock && Array.isArray(result)) {
                    const exchangeOrder = result[0];
                    if (exchangeOrder?.ideal_margin) {
                        const marginRate = parseFloat(exchangeOrder.settlement_currency_conversion_price || 1);
                        signal.entryValueInr = parseFloat(exchangeOrder.ideal_margin) * marginRate;
                        console.log(`[Strategy] CoinDCX Margin: ${exchangeOrder.ideal_margin} * ${marginRate} = ₹${signal.entryValueInr.toFixed(2)}`);
                    }
                    if (exchangeOrder?.settlement_currency_conversion_price) {
                        signal.usdInrRate = parseFloat(exchangeOrder.settlement_currency_conversion_price);
                        console.log(`[Strategy] CoinDCX USD/INR rate: ${signal.usdInrRate}`);
                    }
                }
                await this.db.logTrade({ ...signal, exchangeResponse: result }, orderId);
                console.log(`[Strategy] Trade executed successfully on ${result?.mock ? 'Mock' : 'Real'}. OrderID: ${orderId}`);
                return { status: 'TRADE_PLACED', signal, result };
            }

            console.error('[Strategy] Trade execution failed or returned no order ID:', JSON.stringify(result));
            await this.db.logTrade({ ...signal, status: 'FAILED', reason: 'EXCHANGE_ERROR', exchangeResponse: result });
            return { status: 'TRADE_FAILED', result };
        } catch (err) {
            console.error('[Strategy] Trade execution error:', err.message);
            await this.db.logTrade({ ...signal, status: 'FAILED', reason: `EXCEPTION: ${err.message}` });
            return { status: 'TRADE_FAILED', error: err.message };
        }
    }
    async manageTrade(activeTrade, positionsOrPrice = null) {
        console.log(`[Strategy] Managing active trade: ${activeTrade.decision} ${activeTrade.asset}`);
        const asset = (activeTrade.asset || '').toUpperCase();

        let currentPrice = null;
        let preFetchedPositions = null;

        if (Array.isArray(positionsOrPrice)) {
            preFetchedPositions = positionsOrPrice;
        } else if (typeof positionsOrPrice === 'number') {
            currentPrice = positionsOrPrice;
        }

        if (!currentPrice) {
            currentPrice = asset.includes('BTC') ? this.indicators?.btc?.price :
                asset.includes('ETH') ? this.indicators?.eth?.price :
                    asset.includes('SOL') ? this.indicators?.sol?.price :
                        this.indicators?.doge?.price;
        }

        const entryPrice = parseFloat(activeTrade.price);
        const isLong = activeTrade.decision === 'BUY';
        const isMock = CONFIG.MOCK_MODE || activeTrade.order_id?.startsWith('MOCK_');

        if (isMock) {
            return await this.manageMockTrade(activeTrade, currentPrice, entryPrice, isLong);
        }
        return await this.manageLiveTrade(activeTrade, currentPrice, entryPrice, isLong, preFetchedPositions);
    }

    async manageMockTrade(activeTrade, currentPrice, entryPrice, isLong) {
        try {
            const now = Date.now();
            const ageMs = now - activeTrade.timestamp;
            const priceChangePct = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);

            // Fix 4: 10m Time Stop
            if (ageMs > 10 * 60 * 1000 && priceChangePct < 0.3) {
                console.log(`[Strategy] Time-stop triggered: Age=${(ageMs / 60000).toFixed(1)}m, Move=${priceChangePct.toFixed(2)}% < 0.3%`);
                await this.closeTradeInDb(activeTrade, currentPrice, 'TIME_STOP');
                return { status: 'TRADE_CLOSED', reason: 'TIME_STOP', pnl: priceChangePct * parseFloat(activeTrade.leverage) };
            }

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

                const settlement = await this._settlePortion(activeTrade, slPrice, remainingFraction, isLong);

                await this.db.updateTradeStatus(
                    activeTrade.order_id || activeTrade.id, 'CLOSED', slPrice, settlement.totalPnlPct,
                    'MOCK_SL_HIT', settlement.totalExitValueInr, settlement.totalPnlInr
                );
                return { status: 'TRADE_CLOSED', reason: 'MOCK_SL_HIT', pnl: settlement.totalPnlPct, remainingFraction };
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
            console.log(`[Strategy] Mock position open: price=${currentPrice}, unrealized=${(unrealizedPct * parseFloat(activeTrade.leverage)).toFixed(2)}%, remaining=${(remainingFraction * 100).toFixed(0)}%`);
            return { status: 'IN_TRADE', currentPrice, unrealizedPct };
        } catch (err) {
            console.error('[Strategy] Mock trade management error:', err.message);
            return { status: 'MANAGE_ERROR', error: err.message };
        }
    }

    async manageLiveTrade(activeTrade, currentPrice, entryPrice, isLong, preFetchedPositions = null) {
        try {
            const positions = preFetchedPositions || await getOpenPositions(this.env);
            if (!preFetchedPositions) {
                console.log(`[Strategy] Sync: Fetched ${Array.isArray(positions) ? positions.length : 0} positions from exchange.`);
            }

            const dogePos = Array.isArray(positions)
                ? positions.find(p => (p.pair === CONFIG.PAIR || p.symbol === CONFIG.PAIR || (p.symbol && p.symbol.includes("DOGE"))) && Math.abs(parseFloat(p.quantity || 0)) > 0.001)
                : null;

            if (dogePos) {
                console.log(`[Strategy] Sync: Found active position for ${CONFIG.PAIR} with qty ${dogePos.quantity}`);
            } else {
                console.log(`[Strategy] Sync: No active position found for ${CONFIG.PAIR} on exchange.`);
                console.log('[Strategy] Position closed on exchange');

                await this.closeTradeInDb(activeTrade, currentPrice, 'EXCHANGE_CLOSED (SL/TP/MANUAL)');
                return { status: 'TRADE_CLOSED', reason: 'EXCHANGE_CLOSED' };
            }

            // Fix 4: 10m Time Stop
            const now = Date.now();
            const ageMs = now - activeTrade.timestamp;
            const priceChangePct = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
            const leverage = parseFloat(activeTrade.leverage);
            if (ageMs > 10 * 60 * 1000 && priceChangePct < 0.3) {
                console.log(`[Strategy] Time-stop triggered: Age=${(ageMs / 60000).toFixed(1)}m, Move=${priceChangePct.toFixed(2)}% < 0.3%`);
                // Close on exchange
                const closeSide = isLong ? 'SELL' : 'BUY';
                await placeOrder(this.env, CONFIG.PAIR, closeSide, parseFloat(dogePos.quantity), leverage, null, null, 'MARKET', null, CONFIG.MARGIN_CURRENCY);
                await this.db.updateTradeStatus(activeTrade.order_id, 'CLOSED', currentPrice, priceChangePct * leverage, 'TIME_STOP');
                return { status: 'TRADE_CLOSED', reason: 'TIME_STOP', pnl: priceChangePct * leverage };
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
                    const leverage = parseFloat(activeTrade.leverage);
                    if (closeQty > 0) {
                        const priceChangePct = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
                        const pnl = priceChangePct * leverage;
                        console.log(`[Strategy] Trailing stop hit at ${currentPrice}, closing ${closeQty} (${level.pctOfPosition}%), PnL: ${pnl.toFixed(2)}%`);

                        await this._settlePortion(activeTrade, currentPrice, level.pctOfPosition / 100, isLong);

                        if (!isMock) {
                            const closeSide = isLong ? 'SELL' : 'BUY';
                            try {
                                await closePartialPosition(this.env, CONFIG.PAIR, closeSide, closeQty, leverage, CONFIG.MARGIN_CURRENCY);
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
                const leverage = parseFloat(activeTrade.leverage);
                const priceChangePct = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
                const pnl = priceChangePct * leverage;

                if (closeQty > 0) {
                    console.log(`[Strategy] TP${i + 1} hit at ${currentPrice} (target: ${level.price}), closing ${closeQty} (${level.pctOfPosition}%), PnL: ${pnl.toFixed(2)}%`);

                    await this._settlePortion(activeTrade, currentPrice, level.pctOfPosition / 100, isLong);

                    if (!isMock) {
                        const closeSide = isLong ? 'SELL' : 'BUY';
                        try {
                            await closePartialPosition(this.env, CONFIG.PAIR, closeSide, closeQty, leverage, CONFIG.MARGIN_CURRENCY);
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

    async closeTradeInDb(activeTrade, currentPrice, reason, providedExitRate = null) {
        const isLong = activeTrade.decision === 'BUY';
        const isMock = CONFIG.MOCK_MODE || activeTrade.order_id?.startsWith('MOCK_');

        const tpLevels = activeTrade.tp_levels ? JSON.parse(activeTrade.tp_levels) : [];
        const executedPct = tpLevels.filter(l => l.executed).reduce((sum, l) => sum + l.pctOfPosition, 0);
        const remainingFraction = (100 - executedPct) / 100;

        const settlement = await this._settlePortion(activeTrade, currentPrice, remainingFraction, isLong, providedExitRate);

        await this.db.updateTradeStatus(
            activeTrade.order_id || activeTrade.id, 'CLOSED', currentPrice, settlement.totalPnlPct,
            reason, settlement.totalExitValueInr, settlement.totalPnlInr
        );
    }

    async _settlePortion(activeTrade, exitPriceInput, portionFractionInput, isLong, providedExitRate = null) {
        const isMock = CONFIG.MOCK_MODE || activeTrade.order_id?.startsWith('MOCK_');

        let exitPrice = parseFloat(exitPriceInput);
        let portionFraction = parseFloat(portionFractionInput);

        if (isNaN(exitPrice) || exitPrice <= 0) exitPrice = parseFloat(activeTrade.price);
        if (isNaN(portionFraction) || portionFraction <= 0) {
            // Check if we are already fully settled
            if (activeTrade.status === 'CLOSED') {
                const tpLevels = activeTrade.tp_levels ? JSON.parse(activeTrade.tp_levels) : [];
                const entryValueInr = parseFloat(activeTrade.entry_value_inr || 0);
                const totalPnlInr = tpLevels.reduce((sum, l) => sum + (l.pnlInr || 0), 0) + (activeTrade.last_portion_pnl_inr || 0);
                const totalPnlPct = (totalPnlInr / (entryValueInr || 1)) * 100;
                return { totalPnlInr, totalPnlPct, totalExitValueInr: entryValueInr + totalPnlInr };
            }
            portionFraction = 1.0; // Default to full settlement if fraction unknown
        }

        const entryPrice = parseFloat(activeTrade.price);
        const quantity = parseFloat(activeTrade.quantity);
        const entryValueInrTotal = parseFloat(activeTrade.entry_value_inr || 0);
        const leverage = parseFloat(activeTrade.leverage || 5);
        const exitRate = parseFloat(providedExitRate || activeTrade.usd_inr_rate || CONFIG.USD_INR_RATE);

        const priceChangePct = ((exitPrice - entryPrice) / (entryPrice || 1)) * 100 * (isLong ? 1 : -1);
        const pnlPct = priceChangePct * leverage;

        // Gross PnL for this portion
        const portionPnLInr = (entryValueInrTotal * portionFraction) * (pnlPct / 100);

        // Fee calculation: Taker fee on entry (already paid but tracked here) and exit
        // Entry fee was 0.1% of Notional. Exit fee is 0.1% of Notional.
        const entryRate = parseFloat(activeTrade.usd_inr_rate || CONFIG.USD_INR_RATE);
        const notionalUsdtEntry = (quantity * portionFraction) * entryPrice;
        const entryFeeInrPortion = (notionalUsdtEntry * 0.001) * entryRate;
        const exitFeeInrPortion = ((quantity * portionFraction) * exitPrice * 0.001) * exitRate;

        const finalPortionPnlInr = portionPnLInr - entryFeeInrPortion - exitFeeInrPortion;

        // Update Mock Balance ONLY in mock mode
        if (isMock) {
            const currentBalance = await this.db.getMockBalance();
            const newBalance = currentBalance + finalPortionPnlInr;
            await this.db.updateMockBalance(newBalance);
            console.log(`[Strategy] Mock Settlement (${(portionFraction * 100).toFixed(0)}%): PnL=${portionPnLInr.toFixed(2)}, Fees=${(entryFeeInrPortion + exitFeeInrPortion).toFixed(2)}, Net=${finalPortionPnlInr.toFixed(2)} INR. New Balance: ${newBalance.toFixed(2)}`);
        } else {
            console.log(`[Strategy] Real Settlement Sync (${(portionFraction * 100).toFixed(0)}%): PnL=${portionPnLInr.toFixed(2)}, Fees=${(entryFeeInrPortion + exitFeeInrPortion).toFixed(2)}, Net=${finalPortionPnlInr.toFixed(2)} INR`);
        }

        // Record this portion's PnL back into the TP levels for cumulative tracking
        const tpLevels = activeTrade.tp_levels ? JSON.parse(activeTrade.tp_levels) : [];
        let portionFound = false;
        for (let l of tpLevels) {
            if (l.executed && l.pnlInr === undefined && Math.abs(l.pctOfPosition / 100 - portionFraction) < 0.01) {
                l.pnlInr = finalPortionPnlInr;
                portionFound = true;
                break;
            }
        }
        if (!portionFound) {
            // For SL or remaining portion not in TP levels
            activeTrade.last_portion_pnl_inr = (activeTrade.last_portion_pnl_inr || 0) + finalPortionPnlInr;
        }
        activeTrade.tp_levels = JSON.stringify(tpLevels);

        // Update TP levels in DB immediately to persist the portion PnL
        await this.db.updateTPLevels(activeTrade.order_id || activeTrade.id, tpLevels);

        // Calculate cumulative totals
        const totalPnlInr = tpLevels.reduce((sum, l) => sum + (l.pnlInr || 0), 0) + (activeTrade.last_portion_pnl_inr || 0);
        const totalPnlPct = (totalPnlInr / entryValueInrTotal) * 100;

        return {
            portionPnlInr: finalPortionPnlInr,
            totalPnlInr,
            totalPnlPct,
            totalExitValueInr: entryValueInrTotal + totalPnlInr
        };
    }

    async checkCooldowns() {
        // 1. Daily Trade Count
        const todayTradeCount = await this.db.getTodayTradeCount();
        if (todayTradeCount >= CONFIG.MAX_TRADES_PER_DAY) {
            return { canTrade: false, reason: `Daily trade limit (${todayTradeCount}/${CONFIG.MAX_TRADES_PER_DAY})` };
        }

        // 2. Consecutive Loss Check (Fix 4)
        // const recentTrades = await this.db.getRecentTrades(3);
        // const consecutiveLosses = recentTrades.filter(t => t.status === 'CLOSED' && t.pnl < 0).length;
        // if (recentTrades.length === 3 && consecutiveLosses === 3) {
        //     return { canTrade: false, reason: 'Consecutive loss limit (3) reached' };
        // }

        // 3. Daily Drawdown Protection (Fix 4: 2%)
        const todayPnLInr = await this.db.getTodayPnLInr();
        const ddInr = (CONFIG.INITIAL_INR_BALANCE * CONFIG.MAX_DAILY_DRAWDOWN_PCT) / 100;
        if (todayPnLInr <= -ddInr) {
            return { canTrade: false, reason: `Daily DD limit reached: ${todayPnLInr.toFixed(2)} / -${ddInr.toFixed(2)} INR` };
        }

        // 4. Time-based Cooldown after single loss
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

    /**
     * Permanent Reconciliation Engine
     * Ensures DB and Exchange stay in sync even across errors/timeouts.
     */
    async reconcileTrades(activeTrade, positions, currentPriceFallback = null) {
        const isMock = CONFIG.MOCK_MODE;
        if (isMock) {
            // Mock mode doesn't have an exchange back-end to reconcile with
            if (activeTrade) return { status: 'SYNC_STILL_OPEN' };
            return { status: 'SCANNING' };
        }

        // If positions is null, the API failed. SKIP sync to avoid false closures.
        if (positions === null) {
            console.error(`[Strategy] RECONCILE: Exchange API failed. Skipping sync to avoid false closures.`);
            if (activeTrade) return { status: 'SYNC_STILL_OPEN' };
            return { status: 'SCANNING' };
        }

        const dogePos = Array.isArray(positions)
            ? positions.find(p => (p.pair === CONFIG.PAIR || p.symbol === CONFIG.PAIR || (p.symbol && p.symbol.includes("DOGE"))) && Math.abs(parseFloat(p.quantity || 0)) > 0.001)
            : null;

        // Case 1: Active trade in DB
        if (activeTrade && (activeTrade.status === 'OPEN' || activeTrade.status === 'FILLED')) {
            if (!dogePos) {
                // SIMPLE SYNC: Position exists in DB but GONE on exchange -> Settle from history
                console.log(`[Strategy] RECONCILE: DB trade ${activeTrade.id} (${activeTrade.order_id}) is OPEN but exchange position GONE. Settling from history...`);
                return await this.settleFromExchangeHistory(activeTrade, currentPriceFallback);
            }
            return { status: 'SYNC_STILL_OPEN' };
        }

        // Case 2: No active trade in DB, but position exists on exchange (The "Orphan" Rescue)
        if (!activeTrade && dogePos) {
            console.log(`[Strategy] RECONCILE: Found orphaned position on exchange (${dogePos.quantity} ${dogePos.pair})! Rescuing...`);
            return await this.rescueOrphanTrade(dogePos);
        }

        return { status: 'SCANNING' };
    }

    /**
     * The Definitive Sync Method
     * Looks at the real trade history to find how a trade was closed.
     */
    async settleFromExchangeHistory(activeTrade, currentPriceFallback) {
        try {
            const history = await getTradeHistory(this.env);
            if (!Array.isArray(history)) return { status: 'SCANNING' };

            // Find the most recent trade for this pair that is NOT our entry
            // Our entry order_id is activeTrade.order_id
            const pair = (activeTrade.asset || CONFIG.PAIR).toUpperCase();
            const exitTrades = history.filter(t =>
                (t.pair === pair || t.symbol === pair) &&
                t.order_id !== activeTrade.order_id
            );

            if (exitTrades.length === 0) {
                console.warn(`[Strategy] RECONCILE: No exit trades found in history for ${pair}. Falling back to estimated price.`);
                // Fallback to previous logic if history is mysteriously empty
                let currentPrice = await getMarketPrice(pair);
                if (!currentPrice || isNaN(currentPrice)) currentPrice = currentPriceFallback;
                await this.closeTradeInDb(activeTrade, currentPrice, 'EXCHANGE_CLOSED (AUTO_SYNC)');
                return { status: 'TRADE_CLOSED', reason: 'EXCH_SYNC_ESTIMATED' };
            }

            // The most recent trade is our exit (SL/TP or Manual)
            const lastExecution = exitTrades[0];
            const exitPrice = parseFloat(lastExecution.price || lastExecution.avg_price || 0);
            const conversionRate = parseFloat(lastExecution.settlement_currency_conversion_price || 1);

            console.log(`[Strategy] RECONCILE: Found exit execution at ${exitPrice} (Rate: ${conversionRate}). Updating DB...`);

            // We use the same closeTradeInDb but we pass the EXACT exit price and conversion rate from history
            await this.closeTradeInDb(activeTrade, exitPrice, `EXCHANGE_CLOSED (${lastExecution.side.toUpperCase()})`, conversionRate);

            return { status: 'TRADE_CLOSED', reason: 'EXCH_SYNC_HISTORY' };
        } catch (err) {
            console.error(`[Strategy] RECONCILE: Settle from history failed:`, err.message);
            return { status: 'SCANNING' };
        }
    }

    async rescueOrphanTrade(dogePos) {
        try {
            // Fetch trade history to find the entry details
            const history = await getTradeHistory(this.env);
            if (CONFIG.MOCK_MODE) return { status: 'SCANNING' }; // Safety

            const matches = Array.isArray(history)
                ? history.filter(t => {
                    const matchPair = (t.pair === dogePos.pair || t.symbol === dogePos.pair || t.pair === CONFIG.PAIR || t.symbol === CONFIG.PAIR);
                    const matchSide = (t.side === dogePos.side || t.order_side === dogePos.side);
                    return matchPair && matchSide;
                })
                : [];

            if (matches.length === 0) {
                console.error(`[Strategy] RECONCILE: Could not find entry details in history for orphaned trade. Positions: ${JSON.stringify(dogePos)}, HistoryCount: ${Array.isArray(history) ? history.length : 0}`);
                if (Array.isArray(history) && history.length > 0) {
                    console.log(`[Strategy] RECONCILE: Sample history item: ${JSON.stringify(history[0])}`);
                }
                return { status: 'SCANNING' };
            }

            const latestTrade = matches[0]; // Most recent execution
            const marginRate = parseFloat(latestTrade.settlement_currency_conversion_price || 1);
            const entryValueInr = parseFloat(latestTrade.ideal_margin || 0) * marginRate;

            const recoveredTrade = {
                decision: latestTrade.side,
                reason: '[RECOVERED] Orphan trade fixed by reconciliation engine',
                asset: latestTrade.pair,
                entry: parseFloat(latestTrade.price),
                quantity: parseFloat(dogePos.quantity), // Use current actual qty
                leverage: parseFloat(latestTrade.leverage || 5),
                status: 'OPEN',
                orderId: latestTrade.order_id,
                entryValueInr: entryValueInr || (parseFloat(latestTrade.price) * parseFloat(dogePos.quantity) / (latestTrade.leverage || 5)) * 85,
                timestamp: new Date(latestTrade.created_at).getTime() || Date.now()
            };

            // Check if trade already exists in DB
            const existing = await this.db.getTradeByOrderId(latestTrade.order_id);
            if (!existing) {
                await this.db.logTrade(recoveredTrade, latestTrade.order_id);
                console.log(`[Strategy] RECONCILE: Successfully rescued trade ${latestTrade.order_id} at ₹${recoveredTrade.entry}`);
                return { status: 'RECOVERED', trade: recoveredTrade };
            }

            // If it exists but is not OPEN, re-open it
            if (existing.status !== 'OPEN' && existing.status !== 'FILLED') {
                console.log(`[Strategy] RECONCILE: Trade ${latestTrade.order_id} already exists in DB with status ${existing.status}. Re-opening...`);
                await this.db.updateTradeStatus(latestTrade.order_id, 'OPEN', null, null, '[RE-OPENED] Found alive on exchange after being marked CLOSED');
                return { status: 'RECOVERED', trade: recoveredTrade };
            }

            return { status: 'SYNC_STILL_OPEN' };
        } catch (err) {
            console.error(`[Strategy] RECONCILE: Rescue failed:`, err.message);
            return { status: 'SCANNING' };
        }
    }
}
