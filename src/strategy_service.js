import { placeOrder, getOpenPositions, getMarketPrice, getAccountBalance, closePartialPosition } from './coindcx.js';
import {
    fetchAllMarketData, computeATR, getVolatilityRegime,
    computeOrderBookImbalance, computeTradeFlowImbalance,
    computeEMA, computeBeta, computeReturns,
    detectSwingPoints, detectBTCStructure,
    percentChange, computeVolumeRatio, computeSectorBias,
} from './binance.js';

const CONFIG = {
    PAIR: 'B-DOGE_USDT',
    RISK_PER_TRADE: 0.01, // 1% of account per trade
    MAX_LEVERAGE: 20,

    // ATR clamps
    SL_MIN_PCT: 0.3,
    SL_MAX_PCT: 1.2,
    TP_MIN_PCT: 0.4,
    TP_MAX_PCT: 1.8,

    // SL/TP multipliers of ATR_pct
    SL_ATR_MULT: 1.5,
    TP_ATR_MULT: 2.0,

    // Entry thresholds
    SCORE_SHORT: 55,
    SCORE_LONG: 65,
    CLARITY_SHORT: 15,
    CLARITY_LONG: 20,
    MIN_SUPPORTING_MODULES: 3,
    MIN_RRR: 1.2, // Minimum reward:risk ratio to allow entry

    // Edge Decay trailing stops (pct)
    EDGE_DECAY_TIGHT_TRAIL: 0.15,
    EDGE_DECAY_EXIT_TRAIL: 0.10,

    // Profit management
    PROFIT_BE_THRESHOLD: 1.0,     // ATR mult to move SL to breakeven
    PROFIT_TRAIL_ATR_MULT: 0.4,   // trailing distance as ATR mult
    PROFIT_PARTIAL_THRESHOLD: 1.5, // ATR mult for 60% close
    PROFIT_PARTIAL_PCT: 60,
    PROFIT_TIGHT_THRESHOLD: 2.5,  // ATR mult for tighten trail
    PROFIT_TIGHT_TRAIL_ATR: 0.25,

    // Time stops (minutes)
    TIME_STOP_SLOW: 8,
    TIME_STOP_MAX: 20,
    TIME_STOP_SLOW_PROFIT_THRESHOLD: 0.5, // ATR mult

    // Risk management
    MAX_DAILY_LOSSES: 3,
    MAX_DAILY_DRAWDOWN_PCT: 3,
    MAX_ACCOUNT_DRAWDOWN_PCT: 20,
    COOLDOWN_AFTER_LOSS_MS: 30 * 60 * 1000,
    MAX_TRADES_PER_DAY: 10,

    // Mock mode
    MOCK_MODE: true,
    INITIAL_INR_BALANCE: 2500,
    USD_INR_RATE: 85,
};

export class StrategyService {
    constructor(env) {
        this.env = env;
        this.db = null;
        this.data = null;
    }

    async run(db) {
        this.db = db;
        // TEMPORARY: One-time fix for mock balance. Remove after one run.
        if (CONFIG.MOCK_MODE) {
            const hasRestored = await this.db.getSetting('balance_restored_mar_04', 'false');
            if (hasRestored === 'false') {
                await this.fixMockBalance();
                await this.db.updateSetting('balance_restored_mar_04', 'true');
            }
        }
        console.log(`[Strategy] ── Evaluation Start (${CONFIG.MOCK_MODE ? 'MOCK' : 'REAL'} MODE) ──`);
        try {
            // 1. Fetch all market data
            this.data = await fetchAllMarketData();
            const dogePrice = this.data.doge.klines5m.length > 0
                ? this.data.doge.klines5m[this.data.doge.klines5m.length - 1].close : 0;
            const btcPrice = this.data.btc.klines5m.length > 0
                ? this.data.btc.klines5m[this.data.btc.klines5m.length - 1].close : 0;

            if (dogePrice === 0 || btcPrice === 0) {
                console.error('[Strategy] No price data available');
                return { status: 'ERROR', error: 'No price data' };
            }

            // 2. Calculate ATR (Step 0)
            const { atr, atrPct } = computeATR(this.data.doge.klines5m, 12);
            const regime = getVolatilityRegime(atrPct);
            console.log(`[Strategy] ATR: ${atr.toFixed(6)}, ATR%: ${atrPct.toFixed(4)}%, Regime: ${regime}`);

            // 3. Manage existing trade
            const activeTrade = await db.getActiveTrade();
            if (activeTrade && activeTrade.status === 'OPEN') {
                return await this.manageTrade(activeTrade, dogePrice, atrPct);
            }

            // 4. Cooldown checks
            const cooldownCheck = await this.checkCooldowns();
            if (!cooldownCheck.canTrade) {
                console.log(`[Strategy] Blocked: ${cooldownCheck.reason}`);
                return { status: 'BLOCKED', reason: cooldownCheck.reason };
            }

            // 5. Max drawdown circuit breaker
            if (CONFIG.MOCK_MODE) {
                const currentBalance = await this.db.getMockBalance();
                const drawdownPct = ((CONFIG.INITIAL_INR_BALANCE - currentBalance) / CONFIG.INITIAL_INR_BALANCE) * 100;
                if (drawdownPct >= CONFIG.MAX_ACCOUNT_DRAWDOWN_PCT) {
                    console.log(`[Strategy] CIRCUIT BREAKER: Drawdown ${drawdownPct.toFixed(1)}%`);
                    return { status: 'CIRCUIT_BREAKER', reason: `Max drawdown ${drawdownPct.toFixed(1)}%` };
                }
            }

            // 6. Run all 5 modules
            const moduleResults = this.runAllModules(dogePrice, btcPrice, atrPct);
            console.log('[Strategy] Module results:', JSON.stringify(moduleResults.summary));

            // 7. Aggregate scores
            const aggregation = this.aggregateScores(moduleResults, dogePrice);
            console.log('[Strategy] Aggregation:', JSON.stringify(aggregation));

            // 8. Check kill switches for the winning direction
            if (aggregation.direction !== 'neutral') {
                const killReason = this.checkKillSwitches(aggregation.direction, dogePrice, btcPrice, atrPct);
                if (killReason) {
                    console.log(`[Strategy] Kill switch: ${killReason}`);
                    return { status: 'KILL_SWITCH', reason: killReason };
                }
            }

            // 9. Check entry thresholds
            if (!this.meetsEntryThreshold(aggregation)) {
                console.log(`[Strategy] Below threshold: score=${aggregation.score}, clarity=${aggregation.clarity}, modules=${aggregation.supportingModules}`);
                return { status: 'NO_SIGNAL', ...aggregation };
            }

            // 10. Build and execute signal
            const signal = await this.buildSignal(aggregation, dogePrice, atrPct, moduleResults);
            if (signal.rejected) {
                console.log(`[Strategy] Trade rejected: ${signal.reason}`);
                return { status: 'RRR_REJECTED', reason: signal.reason, rrr: signal.rrr };
            }
            console.log('[Strategy] Signal:', JSON.stringify(signal, null, 2));
            return await this.executeTrade(signal);

        } catch (err) {
            console.error('[Strategy] Error:', err.message, err.stack);
            return { status: 'ERROR', error: err.message };
        }
    }

    // ─── THE 5 MODULES ─────────────────────────────────────────────

    runAllModules(dogePrice, btcPrice, atrPct) {
        const m1 = this.moduleFlowImbalance(dogePrice);
        const m2 = this.moduleBTCStructure(btcPrice);
        const m3 = this.moduleDOGERelativePerf(btcPrice);
        const m4 = this.moduleVolatilityContext(atrPct);
        const m5 = this.moduleFundingRate();

        return {
            modules: [m1, m2, m3, m4, m5],
            summary: {
                m1_flow: `${m1.direction}/${m1.points}`,
                m2_btc: `${m2.direction}/${m2.points}`,
                m3_relperf: `${m3.direction}/${m3.points}`,
                m4_vol: `${m4.direction}/${m4.points}`,
                m5_funding: `${m5.direction}/${m5.points}`,
            },
        };
    }

    // MODULE 1 — Flow Imbalance (max 25)
    moduleFlowImbalance(dogePrice) {
        // Part A: Order Book Imbalance (max 12)
        const obi = computeOrderBookImbalance(this.data.doge.depth, dogePrice, 0.3);
        let obiPoints = 0, obiDir = 'neutral';
        if (obi > 0.40) { obiPoints = 12; obiDir = 'long'; }
        else if (obi > 0.20) { obiPoints = 6; obiDir = 'long'; }
        else if (obi < -0.40) { obiPoints = 12; obiDir = 'short'; }
        else if (obi < -0.20) { obiPoints = 6; obiDir = 'short'; }

        // Part B: Trade Flow Imbalance (max 13)
        const { tfi, tfiSlope } = computeTradeFlowImbalance(this.data.doge.klines1m, 5);
        let tfiPoints = 0, tfiDir = 'neutral';
        if (tfi > 0.25) { tfiPoints = 8; tfiDir = 'long'; }
        else if (tfi > 0.10) { tfiPoints = 5; tfiDir = 'long'; }
        else if (tfi < -0.25) { tfiPoints = 8; tfiDir = 'short'; }
        else if (tfi < -0.10) { tfiPoints = 5; tfiDir = 'short'; }

        // TFI slope bonus (+3)
        if (tfiDir !== 'neutral') {
            const slopeAligned = (tfiDir === 'long' && tfiSlope > 0.05) ||
                (tfiDir === 'short' && tfiSlope < -0.05);
            if (slopeAligned) tfiPoints += 3;
        }

        // OBI + TFI agreement bonus (+2)
        if (obiDir !== 'neutral' && tfiDir !== 'neutral' && obiDir === tfiDir) {
            tfiPoints += 2;
        }

        // Conflict rule: if OBI and TFI disagree, trust TFI, cap at 10
        let totalPoints = obiPoints + tfiPoints;
        let direction = 'neutral';

        if (obiDir !== 'neutral' && tfiDir !== 'neutral' && obiDir !== tfiDir) {
            // Conflict — trust TFI
            direction = tfiDir;
            totalPoints = Math.min(totalPoints, 10);
        } else if (tfiDir !== 'neutral') {
            direction = tfiDir;
        } else if (obiDir !== 'neutral') {
            direction = obiDir;
        }

        totalPoints = Math.min(totalPoints, 25);
        console.log(`[M1] Flow: OBI=${obi.toFixed(3)}(${obiDir}/${obiPoints}), TFI=${tfi.toFixed(3)}(${tfiDir}/${tfiPoints}), total=${totalPoints} ${direction}`);
        return { name: 'flow_imbalance', direction, points: totalPoints, obi, tfi };
    }

    // MODULE 2 — BTC Structural Anchor (max 25)
    moduleBTCStructure(btcPrice) {
        // Part A: BTC Trend Position (max 10)
        const btcCloses = this.data.btc.klines5m.map(k => k.close);
        const ema21 = computeEMA(btcCloses, 21);
        const aboveEma = btcPrice > ema21;

        // BTC 1h change from klines1h
        let btc1hChange = 0;
        if (this.data.btc.klines1h.length >= 2) {
            const oldest = this.data.btc.klines1h[0].close;
            const newest = this.data.btc.klines1h[this.data.btc.klines1h.length - 1].close;
            btc1hChange = oldest > 0 ? ((newest - oldest) / oldest) * 100 : 0;
        }

        // Check if BTC crossed EMA21 within last 3 5m candles
        let emaCrossedRecently = false;
        if (this.data.btc.klines5m.length >= 4) {
            const last4 = this.data.btc.klines5m.slice(-4);
            for (let i = 1; i < last4.length; i++) {
                const prevAbove = last4[i - 1].close > ema21;
                const currAbove = last4[i].close > ema21;
                if (prevAbove !== currAbove) { emaCrossedRecently = true; break; }
            }
        }

        let trendPoints = 0, trendDir = 'neutral';
        if (emaCrossedRecently) {
            trendPoints = 0; trendDir = 'neutral';
        } else if (aboveEma && btc1hChange > 0.3) {
            trendPoints = 10; trendDir = 'long';
        } else if (aboveEma && btc1hChange >= -0.3) {
            trendPoints = 5; trendDir = 'long';
        } else if (!aboveEma && btc1hChange < -0.3) {
            trendPoints = 10; trendDir = 'short';
        } else if (!aboveEma && btc1hChange >= -0.3) {
            trendPoints = 5; trendDir = 'short';
        }

        // Part B: BTC Price Structure (max 15)
        const swings = detectSwingPoints(this.data.btc.klines5m, 20);
        const structure = detectBTCStructure(this.data.btc.klines5m, swings);

        // Combine: use structure direction if available, else trend direction
        let direction = structure.direction !== 'neutral' ? structure.direction : trendDir;
        let totalPoints = trendPoints + structure.points;

        // If trend and structure disagree, use the stronger signal
        if (trendDir !== 'neutral' && structure.direction !== 'neutral' && trendDir !== structure.direction) {
            if (structure.points >= trendPoints) {
                direction = structure.direction;
            } else {
                direction = trendDir;
            }
        }

        totalPoints = Math.min(totalPoints, 25);
        console.log(`[M2] BTC: EMA21=${ema21.toFixed(0)}, above=${aboveEma}, 1h=${btc1hChange.toFixed(2)}%, trend=${trendDir}/${trendPoints}, struct=${structure.pattern}/${structure.direction}/${structure.points}, total=${totalPoints} ${direction}`);
        return {
            name: 'btc_structure', direction, points: totalPoints,
            ema21, aboveEma, btc1hChange, trendDir, structure,
        };
    }

    // MODULE 3 — DOGE Relative Performance (max 20)
    moduleDOGERelativePerf(btcPrice) {
        const dogeReturns = computeReturns(this.data.doge.klines5m, 12);
        const btcReturns = computeReturns(this.data.btc.klines5m, 12);
        const beta = computeBeta(dogeReturns, btcReturns);

        // BTC 1h change
        let btc1hChange = 0;
        if (this.data.btc.klines5m.length >= 13) {
            const oldest = this.data.btc.klines5m[this.data.btc.klines5m.length - 12 - 1].close;
            const newest = this.data.btc.klines5m[this.data.btc.klines5m.length - 1].close;
            btc1hChange = oldest > 0 ? ((newest - oldest) / oldest) * 100 : 0;
        }

        // DOGE 1h change (from 5m klines, ~12 candles = 60min)
        let doge1hChange = 0;
        if (this.data.doge.klines5m.length >= 13) {
            const oldest = this.data.doge.klines5m[this.data.doge.klines5m.length - 12 - 1].close;
            const newest = this.data.doge.klines5m[this.data.doge.klines5m.length - 1].close;
            doge1hChange = oldest > 0 ? ((newest - oldest) / oldest) * 100 : 0;
        }

        const expectedDoge = btc1hChange * beta;
        const deviation = doge1hChange - expectedDoge;

        let points = 0, direction = 'neutral';
        if (deviation < -1.0) { points = 20; direction = 'short'; }
        else if (deviation < -0.5) { points = 12; direction = 'short'; }
        else if (deviation > 1.0) { points = 20; direction = 'long'; }
        else if (deviation > 0.5) { points = 12; direction = 'long'; }
        else {
            // Within ±0.5% — 5 points in BTC trend direction
            points = 5;
            // Determine BTC trend from Module 2 logic (simplified)
            const btcCloses = this.data.btc.klines5m.map(k => k.close);
            const ema21 = computeEMA(btcCloses, 21);
            direction = btcPrice > ema21 ? 'long' : 'short';
        }

        // Conflict penalty: if this module opposes BTC trend, cap at 8
        const btcCloses = this.data.btc.klines5m.map(k => k.close);
        const ema21 = computeEMA(btcCloses, 21);
        const btcTrendDir = btcPrice > ema21 ? 'long' : 'short';
        if (direction !== 'neutral' && direction !== btcTrendDir && points > 8) {
            console.log(`[M3] Conflict penalty: DOGE ${direction} vs BTC trend ${btcTrendDir}, capping at 8`);
            points = 8;
        }

        points = Math.min(points, 20);
        console.log(`[M3] RelPerf: beta=${beta.toFixed(2)}, btc1h=${btc1hChange.toFixed(2)}%, doge1h=${doge1hChange.toFixed(2)}%, expected=${expectedDoge.toFixed(2)}%, deviation=${deviation.toFixed(2)}%, ${direction}/${points}`);
        return { name: 'doge_relative_perf', direction, points, beta, deviation };
    }

    // MODULE 4 — Volatility Context (max 15)
    moduleVolatilityContext(atrPct) {
        if (!this.data.doge.klines5m.length) {
            return { name: 'volatility_context', direction: 'neutral', points: 0 };
        }

        const current = this.data.doge.klines5m[this.data.doge.klines5m.length - 1];
        const currentRange = current.high > 0 ? ((current.high - current.low) / current.close) * 100 : 0;
        const rangeRatio = atrPct > 0 ? currentRange / atrPct : 1;

        let points = 0, direction = 'neutral';

        if (rangeRatio > 2.5) {
            // Overextended candle
            const bodyPosition = (current.high - current.low) > 0
                ? (current.close - current.low) / (current.high - current.low) : 0.5;

            // Check if it broke a swing level (if so, don't fade)
            const swings = detectSwingPoints(this.data.doge.klines5m, 20);
            const highestSwing = swings.swingHighs.length > 0 ? Math.max(...swings.swingHighs.map(s => s.price)) : null;
            const lowestSwing = swings.swingLows.length > 0 ? Math.min(...swings.swingLows.map(s => s.price)) : null;
            const brokeHigh = highestSwing !== null && current.close > highestSwing;
            const brokeLow = lowestSwing !== null && current.close < lowestSwing;

            if (bodyPosition > 0.7 && !brokeHigh) {
                points = 15; direction = 'short'; // Rallied hard, failed to break out
            } else if (bodyPosition < 0.3 && !brokeLow) {
                points = 15; direction = 'long'; // Dumped hard, failed to break down
            }
            // If broke a swing level → 0 points, neutral (real breakout)
        } else if (rangeRatio >= 0.8) {
            // Normal range — 5 points in BTC trend direction
            const btcCloses = this.data.btc.klines5m.map(k => k.close);
            const ema21 = computeEMA(btcCloses, 21);
            const btcPrice = this.data.btc.klines5m[this.data.btc.klines5m.length - 1].close;
            direction = btcPrice > ema21 ? 'long' : 'short';
            points = 5;
        }
        // rangeRatio < 0.5 → 0 points (too quiet)
        // 0.5 to 0.8 → also 0 (borderline quiet)

        points = Math.min(points, 15);
        console.log(`[M4] VolCtx: range=${currentRange.toFixed(3)}%, ratio=${rangeRatio.toFixed(2)}, ${direction}/${points}`);
        return { name: 'volatility_context', direction, points, rangeRatio };
    }

    // MODULE 5 — Funding Rate Pressure (max 15)
    moduleFundingRate() {
        const rate = this.data.funding.fundingRate * 100; // convert to percentage
        let points = 0, direction = 'neutral';

        if (rate > 0.05) { points = 15; direction = 'short'; }
        else if (rate > 0.03) { points = 10; direction = 'short'; }
        else if (rate > 0.01) { points = 5; direction = 'short'; }
        else if (rate < -0.05) { points = 15; direction = 'long'; }
        else if (rate < -0.03) { points = 10; direction = 'long'; }
        else if (rate < -0.01) { points = 5; direction = 'long'; }

        console.log(`[M5] Funding: rate=${(this.data.funding.fundingRate * 100).toFixed(4)}%, ${direction}/${points}`);
        return { name: 'funding_rate', direction, points, fundingRate: this.data.funding.fundingRate };
    }

    // ─── SIGNAL AGGREGATION ────────────────────────────────────────

    aggregateScores(moduleResults, dogePrice) {
        let longScore = 0, shortScore = 0;
        let longModules = 0, shortModules = 0;

        for (const m of moduleResults.modules) {
            if (m.direction === 'long') {
                longScore += m.points;
                longModules++;
            } else if (m.direction === 'short') {
                shortScore += m.points;
                shortModules++;
            }
        }

        // Direction = whichever side has higher score
        let direction, score, clarity, supportingModules;
        if (longScore >= shortScore) {
            direction = 'long';
            score = longScore;
            clarity = longScore - shortScore;
            supportingModules = longModules;
        } else {
            direction = 'short';
            score = shortScore;
            clarity = shortScore - longScore;
            supportingModules = shortModules;
        }

        // Apply deductions
        const deductions = this.computeDeductions(direction, dogePrice);
        score = Math.max(0, score - deductions.total);

        if (score === 0) direction = 'neutral';

        return {
            direction, score, clarity, supportingModules,
            longScore, shortScore, longModules, shortModules,
            deductions: deductions.reasons,
        };
    }

    computeDeductions(direction, dogePrice) {
        let total = 0;
        const reasons = [];
        const isLong = direction === 'long';

        // Thin market: 10-min avg volume < 50% of 1h avg
        const volRatio = computeVolumeRatio(this.data.doge.klines1m);
        if (volRatio < 0.5) {
            total += 15;
            reasons.push(`thin_market(-15, volRatio=${volRatio.toFixed(2)})`);
        }

        // Sector headwind: ETH and SOL both oppose direction
        const ethChange = this.data.eth.ticker24h.priceChangePercent;
        const solChange = this.data.sol.ticker24h.priceChangePercent;
        if (isLong && ethChange < 0 && solChange < 0) {
            total += 10;
            reasons.push('sector_headwind_long(-10)');
        } else if (!isLong && ethChange > 0 && solChange > 0) {
            total += 10;
            reasons.push('sector_headwind_short(-10)');
        }

        // Near 24h extreme in trade direction
        const doge24h = this.data.doge.ticker24h;
        if (isLong && doge24h.highPrice > 0) {
            const distFromHigh = ((doge24h.highPrice - dogePrice) / dogePrice) * 100;
            if (distFromHigh <= 0.5) {
                total += 10;
                reasons.push(`near_24h_high(-10, dist=${distFromHigh.toFixed(2)}%)`);
            }
        } else if (!isLong && doge24h.lowPrice > 0) {
            const distFromLow = ((dogePrice - doge24h.lowPrice) / dogePrice) * 100;
            if (distFromLow <= 0.5) {
                total += 10;
                reasons.push(`near_24h_low(-10, dist=${distFromLow.toFixed(2)}%)`);
            }
        }

        // Daily move already > 5% in trade direction
        const dailyChange = doge24h.priceChangePercent;
        if ((isLong && dailyChange > 5) || (!isLong && dailyChange < -5)) {
            total += 10;
            reasons.push(`daily_overextended(-10, daily=${dailyChange.toFixed(1)}%)`);
        }

        return { total, reasons };
    }

    // ─── KILL SWITCHES ─────────────────────────────────────────────

    checkKillSwitches(direction, dogePrice, btcPrice, atrPct) {
        const isLong = direction === 'long';
        const doge24h = this.data.doge.ticker24h;

        // KS1: Near extreme
        if (isLong && doge24h.highPrice > 0) {
            const dist = ((doge24h.highPrice - dogePrice) / dogePrice) * 100;
            if (dist <= 0.5) return 'KS1: No long within 0.5% of 24h high';
        }
        if (!isLong && doge24h.lowPrice > 0) {
            const dist = ((dogePrice - doge24h.lowPrice) / dogePrice) * 100;
            if (dist <= 0.5) return 'KS1: No short within 0.5% of 24h low';
        }

        // KS2: Daily exhaustion (>6% move in same direction)
        const dailyChange = doge24h.priceChangePercent;
        if (isLong && dailyChange > 6) return `KS2: Daily already +${dailyChange.toFixed(1)}%`;
        if (!isLong && dailyChange < -6) return `KS2: Daily already ${dailyChange.toFixed(1)}%`;

        // KS3: Thin market (10-min avg < 30% of 1h avg)
        const volRatio = computeVolumeRatio(this.data.doge.klines1m);
        if (volRatio < 0.3) return `KS3: Thin market (volRatio=${volRatio.toFixed(2)})`;

        // KS4: Extreme opposing funding
        const fundingPct = this.data.funding.fundingRate * 100;
        if (isLong && fundingPct > 0.05) return `KS4: No long with extreme positive funding (${fundingPct.toFixed(4)}%)`;
        if (!isLong && fundingPct < -0.05) return `KS4: No short with extreme negative funding (${fundingPct.toFixed(4)}%)`;

        // KS5: Daily loss limit (handled by checkCooldowns, but checked here too)
        // (deferred to cooldown check)

        // KS6: Chaos mode — BTC 5m ATR > 3× its 1h avg ATR
        if (this.data.btc.klines5m.length >= 13) {
            const btcATR = computeATR(this.data.btc.klines5m, 12);
            // Compare current ATR to a baseline: use the first 12 candles' ATR as a proxy for "normal"
            if (this.data.btc.klines5m.length >= 25) {
                const earlyKlines = this.data.btc.klines5m.slice(0, 13);
                const earlyATR = computeATR(earlyKlines, 12);
                if (earlyATR.atrPct > 0 && btcATR.atrPct > earlyATR.atrPct * 3) {
                    return `KS6: Chaos mode (BTC ATR ${btcATR.atrPct.toFixed(3)}% > 3x avg ${earlyATR.atrPct.toFixed(3)}%)`;
                }
            }
        }

        return null;
    }

    // ─── ENTRY THRESHOLDS ──────────────────────────────────────────

    meetsEntryThreshold(agg) {
        if (agg.direction === 'neutral') return false;
        const isLong = agg.direction === 'long';
        const scoreThreshold = isLong ? CONFIG.SCORE_LONG : CONFIG.SCORE_SHORT;
        const clarityThreshold = isLong ? CONFIG.CLARITY_LONG : CONFIG.CLARITY_SHORT;

        return agg.score >= scoreThreshold &&
            agg.clarity >= clarityThreshold &&
            agg.supportingModules >= CONFIG.MIN_SUPPORTING_MODULES;
    }

    // ─── BUILD SIGNAL ──────────────────────────────────────────────

    async buildSignal(aggregation, dogePrice, atrPct, moduleResults) {
        const isLong = aggregation.direction === 'long';
        const direction = isLong ? 'BUY' : 'SELL';

        // ATR-based SL and TP with clamps
        const rawSlPct = CONFIG.SL_ATR_MULT * atrPct;
        const slPct = Math.max(CONFIG.SL_MIN_PCT, Math.min(CONFIG.SL_MAX_PCT, rawSlPct));
        const rawTpPct = CONFIG.TP_ATR_MULT * atrPct;
        const tpPct = Math.max(CONFIG.TP_MIN_PCT, Math.min(CONFIG.TP_MAX_PCT, rawTpPct));

        // RRR gate: reject if reward:risk ratio is too low after clamping
        const rrr = tpPct / slPct;
        console.log(`[Strategy] RRR check: TP=${tpPct.toFixed(3)}% / SL=${slPct.toFixed(3)}% = ${rrr.toFixed(2)}:1 (min: ${CONFIG.MIN_RRR})`);
        if (rrr < CONFIG.MIN_RRR) {
            return { rejected: true, reason: `RRR too low: ${rrr.toFixed(2)} < ${CONFIG.MIN_RRR}`, rrr };
        }

        const sl = isLong
            ? dogePrice * (1 - slPct / 100)
            : dogePrice * (1 + slPct / 100);
        const tp = isLong
            ? dogePrice * (1 + tpPct / 100)
            : dogePrice * (1 - tpPct / 100);

        // Position sizing: 1% risk based
        const quantity = await this.calculateQuantity(dogePrice, sl, aggregation.supportingModules);

        // Module states for logging
        const moduleStates = moduleResults.modules.map(m => ({
            name: m.name, direction: m.direction, points: m.points,
        }));

        const reason = `Score:${aggregation.score} Clarity:${aggregation.clarity} Modules:${aggregation.supportingModules} | ` +
            moduleResults.modules.map(m => `${m.name.charAt(0).toUpperCase()}:${m.direction}/${m.points}`).join(' ');

        // Get INR balance for mock mode
        let entryValueInr = 0;
        if (CONFIG.MOCK_MODE) {
            const balance = await this.db.getMockBalance();
            entryValueInr = balance * CONFIG.RISK_PER_TRADE * CONFIG.MAX_LEVERAGE; // notional
        }

        return {
            decision: direction,
            reason,
            orderType: 'MARKET',
            quantity,
            leverage: Math.min(CONFIG.MAX_LEVERAGE, 20),
            entry: dogePrice,
            stopLoss: parseFloat(sl.toFixed(6)),
            takeProfit: parseFloat(tp.toFixed(6)),
            setupType: 'MICROSTRUCTURE_SCALP',
            score: aggregation.score,
            clarity: aggregation.clarity,
            supportingModules: aggregation.supportingModules,
            moduleStates: JSON.stringify(moduleStates),
            atrPct,
            entryValueInr,
            entryTime: Date.now(),
        };
    }

    async calculateQuantity(entryPrice, slPrice, supportingModules) {
        let balanceUsd = 100;
        if (CONFIG.MOCK_MODE) {
            const balanceInr = await this.db.getMockBalance();
            balanceUsd = balanceInr / CONFIG.USD_INR_RATE;
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
                console.error('[Strategy] Failed to fetch balance:', err.message);
            }
        }

        // 1% risk-based position sizing
        const riskAmount = balanceUsd * CONFIG.RISK_PER_TRADE;
        const stopDistance = Math.abs(entryPrice - slPrice) / entryPrice;
        let basePosition = stopDistance > 0 ? riskAmount / (entryPrice * stopDistance) : 0;

        // Conviction scaling
        let convictionMult = 0.70;
        if (supportingModules >= 5) convictionMult = 1.00;
        else if (supportingModules >= 4) convictionMult = 0.85;

        const quantity = Math.floor(basePosition * convictionMult);

        // Cap effective leverage
        const notional = quantity * entryPrice;
        const effectiveLeverage = balanceUsd > 0 ? notional / balanceUsd : 0;

        console.log(`[Strategy] Position sizing: balance=$${balanceUsd.toFixed(2)}, risk=$${riskAmount.toFixed(2)}, stopDist=${(stopDistance * 100).toFixed(3)}%, base=${Math.floor(basePosition)}, conviction=${convictionMult}, qty=${quantity}, effLev=${effectiveLeverage.toFixed(1)}x`);

        if (effectiveLeverage > CONFIG.MAX_LEVERAGE) {
            const cappedQty = Math.floor((balanceUsd * CONFIG.MAX_LEVERAGE) / entryPrice);
            console.log(`[Strategy] Leverage cap: ${effectiveLeverage.toFixed(1)}x > ${CONFIG.MAX_LEVERAGE}x, capping qty to ${cappedQty}`);
            return cappedQty > 0 ? cappedQty : 1;
        }

        return quantity > 0 ? quantity : 1;
    }

    // ─── TRADE EXECUTION ───────────────────────────────────────────

    async executeTrade(signal) {
        try {
            console.log(`[Strategy] Executing ${signal.decision} trade (${CONFIG.MOCK_MODE ? 'MOCK' : 'REAL'})...`);

            let result;
            if (CONFIG.MOCK_MODE) {
                result = {
                    mock: true,
                    orders: [{ id: `MOCK_${Date.now()}` }],
                    status: 'success',
                };
                // Deduct entry fee
                const entryValueUsdt = signal.quantity * signal.entry;
                const feeUsdt = entryValueUsdt * 0.001;
                const feeInr = feeUsdt * CONFIG.USD_INR_RATE;
                const currentBalance = await this.db.getMockBalance();
                await this.db.updateMockBalance(currentBalance - feeInr);
                console.log(`[Strategy] Mock entry fee: ${feeInr.toFixed(2)} INR`);
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
            return { status: 'TRADE_FAILED', error: err.message };
        }
    }

    // ─── EXIT MANAGEMENT ───────────────────────────────────────────

    async manageTrade(activeTrade, currentPrice, atrPct) {
        console.log(`[Strategy] Managing: ${activeTrade.decision} entry=${activeTrade.price}`);
        const entryPrice = parseFloat(activeTrade.price);
        const isLong = activeTrade.decision === 'BUY';
        const isMock = CONFIG.MOCK_MODE || activeTrade.order_id?.startsWith('MOCK_');
        const entryTime = activeTrade.entry_time || activeTrade.timestamp;
        const holdTimeMs = Date.now() - entryTime;
        const holdTimeMin = holdTimeMs / 60000;

        const tradeAtrPct = parseFloat(activeTrade.atr_pct || atrPct);
        const unrealizedPct = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
        const unrealizedAtrMult = tradeAtrPct > 0 ? unrealizedPct / tradeAtrPct : 0;

        const partialClosed = activeTrade.partial_closed_pct ? parseFloat(activeTrade.partial_closed_pct) : 0;

        console.log(`[Strategy] Hold: ${holdTimeMin.toFixed(1)}min, P&L: ${unrealizedPct.toFixed(3)}% (${unrealizedAtrMult.toFixed(2)} ATR), partial=${partialClosed}%`);

        // LAYER 1 — Hard Stop
        let slPrice = parseFloat(activeTrade.stop_loss);

        // Move to breakeven after reaching +1.0 ATR in profit
        if (unrealizedAtrMult >= CONFIG.PROFIT_BE_THRESHOLD && partialClosed === 0) {
            slPrice = entryPrice;
            console.log(`[Strategy] SL moved to breakeven: ${slPrice}`);
        }

        const slHit = isLong ? currentPrice <= slPrice : currentPrice >= slPrice;
        if (slHit) {
            console.log(`[Strategy] HARD STOP hit at ${currentPrice} (SL: ${slPrice})`);
            return await this.exitTrade(activeTrade, currentPrice, 'HARD_STOP', isMock, isLong, entryPrice, holdTimeMs);
        }

        // LAYER 4 — Time Stop (check before edge decay)
        if (holdTimeMin >= CONFIG.TIME_STOP_MAX) {
            console.log(`[Strategy] TIME STOP MAX: ${holdTimeMin.toFixed(1)}min`);
            return await this.exitTrade(activeTrade, currentPrice, 'TIME_STOP_20MIN', isMock, isLong, entryPrice, holdTimeMs);
        }
        if (holdTimeMin >= CONFIG.TIME_STOP_SLOW && unrealizedAtrMult < CONFIG.TIME_STOP_SLOW_PROFIT_THRESHOLD) {
            console.log(`[Strategy] TIME STOP SLOW: ${holdTimeMin.toFixed(1)}min, profit only ${unrealizedAtrMult.toFixed(2)} ATR`);
            return await this.exitTrade(activeTrade, currentPrice, 'TIME_STOP_8MIN', isMock, isLong, entryPrice, holdTimeMs);
        }

        // LAYER 2 — Edge Decay (re-run modules)
        const dogePrice = currentPrice;
        const btcPrice = this.data.btc.klines5m.length > 0
            ? this.data.btc.klines5m[this.data.btc.klines5m.length - 1].close : 0;
        const moduleResults = this.runAllModules(dogePrice, btcPrice, atrPct);
        const tradeDir = isLong ? 'long' : 'short';

        let supporting = 0, opposing = 0;
        for (const m of moduleResults.modules) {
            if (m.direction === tradeDir) supporting++;
            else if (m.direction !== 'neutral') opposing++;
        }

        console.log(`[Strategy] Edge Decay: supporting=${supporting}, opposing=${opposing}`);

        // Rule 3: 2+ modules opposing → immediate exit
        if (opposing >= 2) {
            console.log(`[Strategy] EDGE DECAY R3: ${opposing} modules opposing, EXIT`);
            return await this.exitTrade(activeTrade, currentPrice, `EDGE_DECAY_R3_${opposing}_OPPOSING`, isMock, isLong, entryPrice, holdTimeMs);
        }

        // Rule 4: 0 modules supporting → immediate exit
        if (supporting === 0) {
            console.log(`[Strategy] EDGE DECAY R4: 0 supporting modules, EXIT`);
            return await this.exitTrade(activeTrade, currentPrice, 'EDGE_DECAY_R4_NO_SUPPORT', isMock, isLong, entryPrice, holdTimeMs);
        }

        // Rule 1: supporting drops to 2 while in loss → tight trail
        if (supporting <= 2 && unrealizedPct < 0) {
            // Check if trail would trigger (simplified: if P&L worse than -tight_trail from peak)
            console.log(`[Strategy] EDGE DECAY R1: 2 supporting, in loss, activating tight trail`);
            // In a cron-based system we just exit at market since we can't truly trail between ticks
            return await this.exitTrade(activeTrade, currentPrice, 'EDGE_DECAY_R1_TIGHT_EXIT', isMock, isLong, entryPrice, holdTimeMs);
        }

        // Rule 2: supporting drops to 1
        if (supporting <= 1) {
            if (unrealizedPct < 0) {
                console.log(`[Strategy] EDGE DECAY R2: 1 supporting, in loss, EXIT`);
                return await this.exitTrade(activeTrade, currentPrice, 'EDGE_DECAY_R2_LOSS_EXIT', isMock, isLong, entryPrice, holdTimeMs);
            }
            // In profit with 1 supporting → activate 0.10% trail
            // Since we're cron-based, check if we've lost more than 0.10% from any prior tick
            console.log(`[Strategy] EDGE DECAY R2: 1 supporting, in profit, will monitor`);
        }

        // LAYER 3 — Profit Management
        if (unrealizedAtrMult >= CONFIG.PROFIT_TIGHT_THRESHOLD && partialClosed > 0) {
            // Already partial closed, tighten trail
            const tightTrail = CONFIG.PROFIT_TIGHT_TRAIL_ATR * tradeAtrPct;
            console.log(`[Strategy] Profit trail tightened to ${tightTrail.toFixed(3)}% from peak`);
        }

        if (unrealizedAtrMult >= CONFIG.PROFIT_PARTIAL_THRESHOLD && partialClosed === 0) {
            // Close 60% of position
            console.log(`[Strategy] PARTIAL TP: ${CONFIG.PROFIT_PARTIAL_PCT}% at ${unrealizedAtrMult.toFixed(2)} ATR`);
            return await this.partialClose(activeTrade, currentPrice, CONFIG.PROFIT_PARTIAL_PCT, isMock, isLong, entryPrice);
        }

        // Position still open
        console.log(`[Strategy] Position open: price=${currentPrice}, unrealized=${unrealizedPct.toFixed(3)}%, supporting=${supporting}`);
        return { status: 'IN_TRADE', currentPrice, unrealizedPct, supporting, opposing, holdTimeMin };
    }

    async exitTrade(activeTrade, exitPrice, reason, isMock, isLong, entryPrice, holdTimeMs) {
        const priceChangePct = ((exitPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
        const leverage = parseFloat(activeTrade.leverage || CONFIG.MAX_LEVERAGE);
        const pnl = priceChangePct * leverage;
        const holdTimeSec = Math.round(holdTimeMs / 1000);

        let pnlInr = null;
        if (isMock) {
            const entryValueInr = parseFloat(activeTrade.entry_value_inr || 0);
            const partialClosed = parseFloat(activeTrade.partial_closed_pct || 0);
            const remainingFraction = (100 - partialClosed) / 100;
            pnlInr = (entryValueInr * remainingFraction) * (pnl / 100);

            // Exit fee
            const exitValueUsdt = (activeTrade.quantity * remainingFraction) * exitPrice;
            const exitFeeInr = (exitValueUsdt * 0.001) * CONFIG.USD_INR_RATE;
            pnlInr -= exitFeeInr;

            const currentBalance = await this.db.getMockBalance();
            await this.db.updateMockBalance(currentBalance + pnlInr);
            console.log(`[Strategy] Mock exit: PnL=${pnl.toFixed(2)}%, PnL_INR=${pnlInr.toFixed(2)}, fee=${exitFeeInr.toFixed(2)}`);
        } else {
            try {
                const partialClosed = parseFloat(activeTrade.partial_closed_pct || 0);
                const remainingFraction = (100 - partialClosed) / 100;
                const closeQty = Math.floor(activeTrade.quantity * remainingFraction);
                const closeSide = isLong ? 'SELL' : 'BUY';
                await closePartialPosition(this.env, CONFIG.PAIR, closeSide, closeQty, leverage);
            } catch (err) {
                console.error('[Strategy] Exit execution error:', err.message);
            }
        }

        await this.db.updateTradeStatus(
            activeTrade.order_id, 'CLOSED', exitPrice, pnl,
            reason, null, pnlInr, holdTimeSec
        );
        return { status: 'TRADE_CLOSED', reason, pnl, holdTimeSec };
    }

    async partialClose(activeTrade, currentPrice, closePct, isMock, isLong, entryPrice) {
        const priceChangePct = ((currentPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
        const leverage = parseFloat(activeTrade.leverage || CONFIG.MAX_LEVERAGE);
        const pnl = priceChangePct * leverage;
        const closeQty = Math.floor(activeTrade.quantity * (closePct / 100));

        if (isMock) {
            const entryValueInr = parseFloat(activeTrade.entry_value_inr || 0);
            const pnlInr = (entryValueInr * (closePct / 100)) * (pnl / 100);
            const exitValueUsdt = closeQty * currentPrice;
            const exitFeeInr = (exitValueUsdt * 0.001) * CONFIG.USD_INR_RATE;
            const finalPnlInr = pnlInr - exitFeeInr;

            const currentBalance = await this.db.getMockBalance();
            await this.db.updateMockBalance(currentBalance + finalPnlInr);
            console.log(`[Strategy] Mock partial TP: ${closePct}%, PnL=${pnl.toFixed(2)}%, INR=${finalPnlInr.toFixed(2)}`);
        } else {
            const closeSide = isLong ? 'SELL' : 'BUY';
            try {
                await closePartialPosition(this.env, CONFIG.PAIR, closeSide, closeQty, leverage);
            } catch (err) {
                console.error('[Strategy] Partial close error:', err.message);
            }
        }

        // Update partial_closed_pct in DB
        const newPartialPct = (parseFloat(activeTrade.partial_closed_pct || 0)) + closePct;
        await this.db.updatePartialClose(activeTrade.order_id, newPartialPct);

        // Move SL to breakeven
        await this.db.db.prepare('UPDATE trade_logs SET stop_loss = ? WHERE order_id = ?')
            .bind(entryPrice, activeTrade.order_id).run();

        return { status: 'PARTIAL_TP', closePct, pnl, remainingPct: 100 - newPartialPct };
    }

    // ─── COOLDOWNS ─────────────────────────────────────────────────

    async checkCooldowns() {
        const todayTradeCount = await this.db.getTodayTradeCount();
        if (todayTradeCount >= CONFIG.MAX_TRADES_PER_DAY) {
            return { canTrade: false, reason: `Daily trade limit (${todayTradeCount}/${CONFIG.MAX_TRADES_PER_DAY})` };
        }
        const todayLossCount = await this.db.getTodayLossCount();
        if (todayLossCount >= CONFIG.MAX_DAILY_LOSSES) {
            return { canTrade: false, reason: `Daily loss limit (${todayLossCount}/${CONFIG.MAX_DAILY_LOSSES})` };
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

    async fixMockBalance() {
        console.log('[Strategy] Running one-time Balance Restoration...');
        try {
            const { results: trades } = await this.db.db.prepare("SELECT pnl_inr, entry_value_inr FROM trade_logs WHERE status = 'CLOSED'").all();
            let totalPnl = 0;
            let totalEntryFees = 0;
            for (const trade of trades) {
                totalPnl += (trade.pnl_inr || 0);
                totalEntryFees += (trade.entry_value_inr || 0) * 0.005;
            }
            const correctBalance = CONFIG.INITIAL_INR_BALANCE + totalPnl - totalEntryFees;
            await this.db.updateMockBalance(correctBalance);
            console.log(`[Strategy] Balance Restored: Total PnL=${totalPnl.toFixed(2)}, Fees=${totalEntryFees.toFixed(2)}. New Balance: ${correctBalance.toFixed(2)}`);
        } catch (err) {
            console.error('[Strategy] Balance Restoration failed:', err.message);
        }
    }
}
