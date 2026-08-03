import { placeOrder, getOpenPositions, getMarketPrice, getAccountBalance, closePartialPosition, getInstrumentDetails, getINRFuturesBalance, getTradeHistory } from './coindcx.js';
import { fetchAllMarketData, computeIndicators } from './binance.js';
import { runAllStrategies } from './strategies.js';
const CONFIG = {
    PAIR: 'B-ETH_USDT',
    MARGIN_CURRENCY: 'INR',
    MARGIN_PERCENT: 70,
    DEFAULT_LEVERAGE: 2,
    SL_PCT: 0.3,
    TP_PCT: 0.5,
    MIN_ACC_SCORE: 65,
    COOLDOWN_AFTER_LOSS_MS: 2 * 60 * 60 * 1000,
    MAX_TRADES_PER_DAY: 5,
    MOCK_MODE: true,
    INITIAL_INR_BALANCE: 500,
    USD_INR_RATE: 85,
    TIME_STOP_MINUTES: 10,
    TIME_STOP_MIN_MOVE_PCT: 0.05,
    ALLOWED_STRUCTURES: null,
};
export class StrategyService {
    constructor(env) {
        this.env = env;
        this.db = null;
        this.indicators = null;
        this.mockMode = false; // Default to false for safety
    }
    async run(db) {
        this.db = db;
        const isRunning = await db.getSetting('is_running', 'true');
        if (isRunning === 'false') {
            console.log('[Strategy] Service is PAUSED/STOPPED. Exiting early.');
            return { status: 'PAUSED', message: 'Service is stopped via dashboard' };
        }

        // Always enable mock trade
        this.mockMode = true;
        await db.updateSetting('mock_mode', 'true');

        // TEMPORARY: One-time fix for mock balance inflation. Remove after one run.
        if (this.mockMode) {
            const hasRestored = await this.db.getSetting('balance_restored_mar_04', 'false');
            if (hasRestored === 'false') {
                await this.fixMockBalance();
                await this.db.updateSetting('balance_restored_mar_04', 'true');
            }
        }
        console.log(`[Strategy] ── Evaluation Start(${this.mockMode ? 'MOCK' : 'REAL'} MODE) ──`);
        try {
            // 1. Fetch scouting data FIRST (to have currentPrice for sync/management)
            const [data, instrumentInfo] = await Promise.all([
                fetchAllMarketData(),
                this.mockMode ? Promise.resolve(null) : getInstrumentDetails(CONFIG.PAIR),
            ]);

            // Extract current ETH price from kline data for sync/management fallback
            const ethKlines = data?.eth?.klines1m;
            const currentPrice = (Array.isArray(ethKlines) && ethKlines.length > 0)
                ? ethKlines[ethKlines.length - 1].close
                : 0;

            // 2. Parallel Trades Check & Management
            const parallelSetting = await db.getSetting('parallel_trades_mode', 'false');
            const isParallelMode = parallelSetting === 'true' && this.mockMode;

            if (isParallelMode) {
                const activeTrades = await db.getActiveTrades();
                console.log(`[Strategy] Parallel Mock Mode ACTIVE. Managing ${activeTrades.length} open trade(s)...`);
                let openCount = 0;
                for (const trade of activeTrades) {
                    const res = await this.manageTrade(trade, currentPrice);
                    if (res && res.status === 'IN_TRADE') {
                        openCount++;
                    }
                }
                const MAX_PARALLEL_TRADES = 5;
                if (openCount >= MAX_PARALLEL_TRADES) {
                    console.log(`[Strategy] Parallel Mock Mode: Max parallel limit reached (${openCount}/${MAX_PARALLEL_TRADES}). Skipping new entries.`);
                    return { status: 'MAX_PARALLEL_TRADES_REACHED', openCount, max: MAX_PARALLEL_TRADES };
                }
            } else {
                // Single Trade Mode (standard behavior)
                let positions = [];
                if (!this.mockMode) {
                    positions = await getOpenPositions(this.env);
                    console.log(`[Strategy] Sync: Fetched ${Array.isArray(positions) ? positions.length : 0} positions from exchange.`);
                    if (positions === null) {
                        console.error('[Strategy] RECONCILE: Positions API failed. Aborting evaluation to prevent duplicate trades.');
                        return { status: 'ERROR', message: 'Positions API failed. Aborted for safety.' };
                    }
                }

                const activeTrade = await db.getActiveTrade();
                const reconciliation = await this.reconcileTrades(activeTrade, positions, currentPrice);

                if (reconciliation.status === 'TRADE_CLOSED') {
                    console.log(`[Strategy] Trade sync completed: CLOSED. Exiting early.`);
                    return reconciliation;
                }

                if (activeTrade && reconciliation.status === 'SYNC_STILL_OPEN') {
                    console.log(`[Strategy] Trade sync: STILL_OPEN. Managing trade...`);
                    return await this.manageTrade(activeTrade, currentPrice);
                }

                if (reconciliation.status === 'RECOVERED') {
                    console.log(`[Strategy] Trade sync: RECOVERED orphaned trade. Exiting to allow management in next cycle...`);
                    return reconciliation;
                }

                if (activeTrade && reconciliation.status !== 'TRADE_CLOSED') {
                    console.warn(`[Strategy] Blocked scouting: DB trade ${activeTrade.id} is active, but reconciliation returned status: ${reconciliation.status}. Aborting cycle.`);
                    return { status: 'WAITING_FOR_SYNC', reason: 'Active trade status unresolved' };
                }
            }

            // 4. Proceed to Scouting (if no active trade)
            if (instrumentInfo) {
                this.maxLeverage = instrumentInfo.maxLeverage || 20;
                this.leverage = Math.min(this.maxLeverage, CONFIG.DEFAULT_LEVERAGE);
                this.minQuantity = instrumentInfo.minQuantity || 0.001;
                this.stepSize = instrumentInfo.stepSize || 0.001;
                this.tickSize = instrumentInfo.tickSize || 0.01;
                this.minNotional = instrumentInfo.minNotional || 0;
                console.log(`[Strategy] Instrument: maxLeverage=${instrumentInfo.maxLeverage}, using=${this.leverage}x, minQty=${this.minQuantity}, step=${this.stepSize}, tick=${this.tickSize}, minNotional=${this.minNotional}`);
            } else {
                this.maxLeverage = 20;
                this.leverage = CONFIG.DEFAULT_LEVERAGE;
                this.minQuantity = 0.001;
                this.stepSize = 0.001;
                this.tickSize = 0.01;
                this.minNotional = CONFIG.PAIR.includes('USDT') ? 24.0 : 0;
                console.log(`[Strategy] Using default leverage: ${this.leverage}x, minNotional=${this.minNotional}`);
            }

            this.indicators = computeIndicators(data, CONFIG);

            console.log('[Strategy] Indicators:', JSON.stringify({
                btcPrice: this.indicators.btc.price?.toFixed(0),
                ethPrice: this.indicators.eth.price?.toFixed(5),
                btcCvd: this.indicators.btc.cvdDirection + '/' + this.indicators.btc.cvdSlope,
                ethCvd: this.indicators.eth.cvdDirection + '/' + this.indicators.eth.cvdSlope,
                btc1h: this.indicators.btc.change1h?.toFixed(2) + '%',
                btc5m: this.indicators.btc.change5m?.toFixed(2) + '%',
                eth1h: this.indicators.eth.change1h?.toFixed(2) + '%',
                eth5m: this.indicators.eth.change5m?.toFixed(2) + '%',
                relStrength: this.indicators.eth.relativeStrength,
                btcStructure: this.indicators.btc.structure,
                btcKeyLevel: this.indicators.btc.keyLevel,
                sectorBias: this.indicators.sector.bias,
                ethRange: this.indicators.eth.ethRange?.toFixed(1) + '%',
                volRatio: this.indicators.eth.volumeRatio?.toFixed(2),
                utcHour: this.indicators.session.hour?.toFixed(1),
            }));

            // 3. New trade checks
            const cooldownCheck = await this.checkCooldowns();
            if (!cooldownCheck.canTrade) {
                console.log(`[Strategy] Blocked: ${cooldownCheck.reason} `);
                return { status: 'BLOCKED', reason: cooldownCheck.reason };
            }

            // 4. Max drawdown circuit breaker
            if (this.mockMode) {
                const currentBalance = await this.db.getMockBalance();
                const drawdownPct = ((CONFIG.INITIAL_INR_BALANCE - currentBalance) / CONFIG.INITIAL_INR_BALANCE) * 100;
                if (drawdownPct >= 2.0) {
                    console.log(`[Strategy] CIRCUIT BREAKER: Mock balance ₹${currentBalance.toFixed(2)} (Drawdown ${drawdownPct.toFixed(1)}%)`);
                    return { status: 'CIRCUIT_BREAKER', reason: `Mock balance below drawdown limit (${drawdownPct.toFixed(1)}%)` };
                }
            } else {
                // Real mode: check INR balance floor
                const inrBalance = await getINRFuturesBalance(this.env);
                if (inrBalance !== null && inrBalance < 50) {
                    console.log(`[Strategy] CIRCUIT BREAKER: INR balance ₹${inrBalance.toFixed(2)} below minimum ₹50`);
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

            // 6. Multi-Strategy Runner — evaluate all 5 strategies, pick best signal
            const setup = runAllStrategies(this.indicators, CONFIG.MIN_ACC_SCORE);
            if (!setup) {
                await this.db.updateSetting('structure_detected_at', 0);
                await this.db.updateSetting('last_detected_structure', 'none');
                console.log('[Strategy] No valid setup from any strategy');
                return { status: 'NO_SETUP' };
            }

            const score = setup.score;
            console.log(`[Strategy] Winner: ${setup.type} ${setup.direction} score=${score}`);

            // 6b. Range filter — block low-conviction entries in choppy markets
            const rangeFilterResult = this.applyRangeFilter(this.indicators, setup);
            if (rangeFilterResult.blocked) {
                console.log(`[Strategy] RANGE FILTER blocked: ${rangeFilterResult.reason}`);
                return { status: 'RANGE_FILTERED', reason: rangeFilterResult.reason };
            }

            // 7. Verify kill switch doesn't block the found direction
            const killSwitch = setup.direction === 'BUY' ? killSwitchLong : killSwitchShort;
            if (killSwitch.triggered) {
                console.log(`[Strategy] Kill switch triggered: ${killSwitch.reason} `);
                return { status: 'KILL_SWITCH', reason: killSwitch.reason };
            }

            let signal = await this.buildSignal(this.indicators, setup, score);

            console.log('[Strategy] Generated Base Signal:', JSON.stringify(signal, null, 2));
            if (!signal.quantity || signal.quantity <= 0) {
                console.warn('[Strategy] Signal generated but quantity is 0 (likely due to leverage safety limit). Refusing to trade.');
                return { status: 'LOW_BALANCE_BLOCKED', reason: 'Insufficient balance to trade safely' };
            }

            // 9. Pullback Confirmation / Pending Signal System
            const pendingRaw = await db.getSetting('pending_signal', null);
            let pendingSignal = null;
            if (pendingRaw && pendingRaw !== 'none') {
                try { pendingSignal = JSON.parse(pendingRaw); } catch (e) { }
            }

            const currentEthPrice = this.indicators.eth.price;

            if (pendingSignal && pendingSignal.decision === signal.decision) {
                const ageMs = Date.now() - pendingSignal.createdAt;
                const MAX_PENDING_AGE_MS = 5 * 60 * 1000; // 5 minutes max wait
                if (ageMs > MAX_PENDING_AGE_MS) {
                    console.log(`[Strategy] Pending signal for ${pendingSignal.decision} expired after ${(ageMs / 60000).toFixed(1)}min without pullback.`);
                    await db.updateSetting('pending_signal', 'none');
                    pendingSignal = null;
                } else {
                    // Check if price pulled back for a better entry (at least 0.05% pullback or better entry price)
                    const isBuy = pendingSignal.decision === 'BUY';
                    const initialEntry = pendingSignal.initialPrice;
                    const hasPulledBack = isBuy
                        ? (currentEthPrice <= initialEntry * 0.9995)
                        : (currentEthPrice >= initialEntry * 1.0005);

                    if (hasPulledBack) {
                        console.log(`[Strategy] PULLBACK CONFIRMED! Initial: ${initialEntry}, Current: ${currentEthPrice}. Executing pending ${pendingSignal.decision}...`);
                        await db.updateSetting('pending_signal', 'none');
                        
                        // Re-calculate entry, SL, TP at actual entry price
                        signal.entry = currentEthPrice;
                        signal.stopLoss = this.roundToTick(isBuy ? currentEthPrice * (1 - CONFIG.SL_PCT / 100) : currentEthPrice * (1 + CONFIG.SL_PCT / 100), this.tickSize || 0.01);
                        signal.takeProfit = this.roundToTick(isBuy ? currentEthPrice * (1 + CONFIG.TP_PCT / 100) : currentEthPrice * (1 - CONFIG.TP_PCT / 100), this.tickSize || 0.01);
                        signal.tpLevels = [{ pctOfPosition: 100, price: signal.takeProfit }];
                        signal.reason += ` | PULLBACK_CONFIRMED (init:${initialEntry}->exec:${currentEthPrice})`;
                        
                        return await this.executeTrade(signal);
                    } else {
                        console.log(`[Strategy] Waiting for pullback on pending ${pendingSignal.decision}. Initial: ${initialEntry}, Current: ${currentEthPrice}, Age: ${(ageMs / 1000).toFixed(0)}s`);
                        return { status: 'WAITING_FOR_PULLBACK', initialEntry, currentPrice: currentEthPrice, ageSeconds: Math.round(ageMs / 1000) };
                    }
                }
            }

            // Store new signal as PENDING to wait for pullback in subsequent ticks
            console.log(`[Strategy] New signal ${signal.decision} generated at ${currentEthPrice}. Storing as PENDING to wait for pullback...`);
            const newPending = {
                decision: signal.decision,
                initialPrice: currentEthPrice,
                createdAt: Date.now(),
                score: signal.score,
            };
            await db.updateSetting('pending_signal', JSON.stringify(newPending));
            return { status: 'PENDING_SIGNAL_CREATED', decision: signal.decision, initialPrice: currentEthPrice, message: 'Waiting up to 5 minutes for price pullback confirmation' };
        } catch (err) {
            console.error('[Strategy] Error:', err.message, err.stack);
            return { status: 'ERROR', error: err.message };
        }
    }
    checkKillSwitches(ind, setup) {
        // Simplified: no kill switches needed — directional alignment handles filtering
        return { triggered: false };
    }
    /**
     * Range Filter — prevents entries in choppy/ranging markets.
     * Derived from backtest analysis of trades #178-#188:
     *   Rule 1: BTC ranging + ETH CVD not rising → no trend confirmation
     *   Rule 2: SELL + BTC rejection + BTC CVD rising → CVD divergence (rejection likely to fail)
     *   Rule 3: BUY near 24h high / SELL near 24h low → entering at resistance/support extreme
     *
     * Verified: blocks all 3 losses (#186-#188), zero false positives on 8 wins.
     */
    applyRangeFilter(ind, setup) {
        const direction = setup.direction;
        const btcStructure = ind.btc.structure;
        const btcCvd = ind.btc.cvdDirection;
        const ethCvd = ind.eth.cvdDirection;
        const ethDistFromHigh = ind.eth.distFromHigh || 0;
        const ethDistFromLow = ind.eth.distFromLow || 0;
        const rs = ind.eth.relativeStrength;

        console.log(`[Strategy] Range Filter check: struct=${btcStructure}, btcCVD=${btcCvd}, ethCVD=${ethCvd}, RS=${rs}, distHigh=${ethDistFromHigh.toFixed(2)}%, distLow=${ethDistFromLow.toFixed(2)}%`);

        // Rule 1: BTC ranging + ETH CVD not confirming direction
        // In a ranging BTC market, only trade if ETH has independent buying/selling pressure
        if (btcStructure === 'ranging') {
            if (direction === 'BUY' && ethCvd !== 'rising') {
                return { blocked: true, reason: `BTC ranging + ETH CVD ${ethCvd} (not rising) — no trend confirmation for BUY` };
            }
            if (direction === 'SELL' && ethCvd !== 'falling') {
                return { blocked: true, reason: `BTC ranging + ETH CVD ${ethCvd} (not falling) — no trend confirmation for SELL` };
            }
        }

        // Rule 2: CVD divergence on rejection structure
        // If BTC shows "rejection" (bearish wick pattern) but BTC CVD is rising,
        // buyers are stepping in — the rejection is likely to fail. Don't short.
        // Mirror: if BTC shows "support_holding" but BTC CVD is falling, don't go long.
        if (direction === 'SELL' && btcStructure === 'rejection' && btcCvd === 'rising') {
            return { blocked: true, reason: `SELL blocked: BTC rejection + BTC CVD rising (divergence — buyers stepping in)` };
        }
        if (direction === 'BUY' && btcStructure === 'support_holding' && btcCvd === 'falling') {
            return { blocked: true, reason: `BUY blocked: BTC support_holding + BTC CVD falling (divergence — sellers stepping in)` };
        }

        // Rule 3: Position in range — don't buy at resistance, don't sell at support
        // If ETH price is within 1.5% of the 24h high, it's at resistance — bad BUY entry.
        // If ETH price is within 1.5% of the 24h low, it's at support — bad SELL entry.
        const RANGE_PROXIMITY_PCT = 1.5;
        if (direction === 'BUY' && ethDistFromHigh < RANGE_PROXIMITY_PCT && ethDistFromHigh >= 0) {
            return { blocked: true, reason: `BUY blocked: ETH only ${ethDistFromHigh.toFixed(2)}% from 24h high (at resistance)` };
        }
        if (direction === 'SELL' && ethDistFromLow < RANGE_PROXIMITY_PCT && ethDistFromLow >= 0) {
            return { blocked: true, reason: `SELL blocked: ETH only ${ethDistFromLow.toFixed(2)}% from 24h low (at support)` };
        }

        return { blocked: false };
    }
    evaluateSetups(ind) {
        console.log('[Strategy] ── Setup Evaluation ──');
        console.log('[Strategy] Market State:', JSON.stringify({
            btcStructure: ind.btc.structure,
            btcCvd: ind.btc.cvdDirection + '/' + ind.btc.cvdSlope,
            ethCvd: ind.eth.cvdDirection + '/' + ind.eth.cvdSlope,
            btc1h: ind.btc.change1h?.toFixed(2),
            eth5m: ind.eth.change5m?.toFixed(2),
            relStrength: ind.eth.relativeStrength,
        }));

        // Structure Whitelist Check (optional if CONFIG.ALLOWED_STRUCTURES is specified)
        if (Array.isArray(CONFIG.ALLOWED_STRUCTURES) && CONFIG.ALLOWED_STRUCTURES.length > 0) {
            if (!CONFIG.ALLOWED_STRUCTURES.includes(ind.btc.structure)) {
                console.log(`[Strategy] Blocked: BTC structure '${ind.btc.structure}' is not in allowed list [${CONFIG.ALLOWED_STRUCTURES.join(', ')}]`);
                return null;
            }
        }

        // LONG: ETH CVD rising + ETH 5m positive + BTC not dumping
        const isLong = ind.eth.cvdDirection === 'rising'
            && ind.eth.change5m > 0
            && ind.btc.change1h > -0.3;

        // SHORT: ETH CVD falling + ETH 5m negative + BTC not pumping
        const isShort = ind.eth.cvdDirection === 'falling'
            && ind.eth.change5m < 0
            && ind.btc.change1h < 0.3;

        if (isLong) {
            console.log('[Strategy] DIRECTIONAL_ALIGNMENT BUY triggered');
            return { type: 'DIRECTIONAL_ALIGNMENT', direction: 'BUY' };
        }
        if (isShort) {
            console.log('[Strategy] DIRECTIONAL_ALIGNMENT SELL triggered');
            return { type: 'DIRECTIONAL_ALIGNMENT', direction: 'SELL' };
        }
        return null;
    }
    scoreSignal(ind, setup) {
        let score = 50;
        const isLong = setup.direction === 'BUY';

        // BTC structure bonus
        if (ind.btc.structure === 'sweep_reclaim_bullish' || ind.btc.structure === 'sweep_reclaim_bearish') {
            score += 15;
        } else if (ind.btc.structure === 'support_holding' || ind.btc.structure === 'rejection') {
            score += 10;
        }

        // ETH CVD slope bonus
        if (ind.eth.cvdSlope === 'steep') {
            score += 10;
        } else if (ind.eth.cvdSlope === 'gradual') {
            score += 5;
        }

        // Relative strength bonus
        if ((isLong && ind.eth.relativeStrength === 'stronger') ||
            (!isLong && ind.eth.relativeStrength === 'weaker')) {
            score += 10;
        }

        console.log(`[Strategy] Score breakdown: base=50, structure=${ind.btc.structure}, cvdSlope=${ind.eth.cvdSlope}, RS=${ind.eth.relativeStrength}, total=${score}`);
        return score;
    }
    async buildSignal(ind, setup, score) {
        const entry = ind.eth.price;
        const slPercent = CONFIG.SL_PCT;
        const tpPercent = CONFIG.TP_PCT;

        const slPrice = setup.direction === 'BUY'
            ? entry * (1 - slPercent / 100)
            : entry * (1 + slPercent / 100);

        const tpPrice = setup.direction === 'BUY'
            ? entry * (1 + tpPercent / 100)
            : entry * (1 - tpPercent / 100);

        const sl = this.roundToTick(slPrice, this.tickSize || 0.01);
        const tp = this.roundToTick(tpPrice, this.tickSize || 0.01);

        let inrBalance = CONFIG.INITIAL_INR_BALANCE;
        if (this.mockMode) {
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
            asset: CONFIG.PAIR,
            reason: `${setup.type} | Score:${score} | BTC:${ind.btc.structure} | CVD:${ind.btc.cvdDirection}/${ind.eth.cvdDirection} | RS:${ind.eth.relativeStrength}`,
            orderType: 'MARKET',
            quantity,
            leverage: this.leverage,
            entry,
            stopLoss: sl,
            takeProfit: tp,
            tpLevels: [{ pctOfPosition: 100, price: tp }],
            setupType: setup.type,
            score,
            entryValueInr: marginInr,
        };
    }
    invertSignal(signal) {
        const originalDecision = signal.decision;
        const originalSl = signal.stopLoss;
        const originalTp = signal.takeProfit;
        const entry = signal.entry;

        const invertedDecision = originalDecision === 'BUY' ? 'SELL' : 'BUY';
        
        const slDist = Math.abs(entry - originalSl);
        const tpDist = Math.abs(entry - originalTp);

        const invertedSl = invertedDecision === 'BUY'
            ? entry - slDist
            : entry + slDist;

        const invertedTp = invertedDecision === 'BUY'
            ? entry + tpDist
            : entry - tpDist;

        signal.decision = invertedDecision;
        signal.stopLoss = this.roundToTick(invertedSl, this.tickSize || 0.01);
        signal.takeProfit = this.roundToTick(invertedTp, this.tickSize || 0.01);
        signal.tpLevels = [{ pctOfPosition: 100, price: signal.takeProfit }];
        signal.reason = `CONTRARIAN (${originalDecision} -> ${invertedDecision}) | ` + signal.reason;
        
        console.log(`[Strategy] Signal Inverted: ${originalDecision} -> ${invertedDecision}, Entry: ${entry}, Original SL: ${originalSl} -> Inverted SL: ${signal.stopLoss}, Original TP: ${originalTp} -> Inverted TP: ${signal.takeProfit}`);
        return signal;
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
        if (this.mockMode && mockInrBalance) {
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

        let leverage = this.leverage || CONFIG.DEFAULT_LEVERAGE;
        const maxLeverage = this.maxLeverage || 20;

        const marginAvailable = balanceUsd * (CONFIG.MARGIN_PERCENT / 100);

        // Position size is margin * leverage
        let positionValueUsd = marginAvailable * leverage;
        let quantity = positionValueUsd / entry;

        // Enforce minimum notional (minNotional) in USD
        const minNotionalUsd = this.minNotional || (CONFIG.PAIR.includes('USDT') ? 24.0 : 0);
        const currentNotionalUsd = quantity * entry;

        if (currentNotionalUsd < minNotionalUsd) {
            console.log(`[Strategy] Position value ${currentNotionalUsd.toFixed(2)} USD below min notional ${minNotionalUsd} USD. Adjusting...`);

            // Set quantity to meet min notional
            quantity = minNotionalUsd / entry;

            // Calculate new required margin
            const requiredMarginUsd = (quantity * entry) / leverage;
            if (requiredMarginUsd > marginAvailable) {
                // If required margin exceeds available, dynamically increase leverage to compensate
                const neededLeverage = (quantity * entry) / marginAvailable;
                const safetyLeverageLimit = 5; // Enforce safety threshold
                if (neededLeverage <= safetyLeverageLimit && neededLeverage <= maxLeverage) {
                    leverage = Math.ceil(neededLeverage);
                    console.log(`[Strategy] Dynamically increased leverage to ${leverage}x to meet min notional with available margin.`);
                    this.leverage = leverage; // Update class property
                    positionValueUsd = marginAvailable * leverage;
                } else {
                    // Even at max leverage, or if safety limit exceeded, we can't afford it safely
                    console.warn(`[Strategy] Refusing to trade: Needed leverage of ${neededLeverage.toFixed(1)}x exceeds safety leverage limit of ${safetyLeverageLimit}x or max leverage ${maxLeverage}x.`);
                    return 0; // Return 0 to prevent trade execution!
                }
            }
        }

        if (quantity <= 0) return 0;

        // Align to exchange step size
        const stepSize = this.stepSize || 0.001;
        if (stepSize > 0 && stepSize < 1) {
            // Round UP when adjusting for minimum notional to guarantee we exceed it
            if (currentNotionalUsd < minNotionalUsd) {
                quantity = Math.ceil(quantity / stepSize) * stepSize;
            } else {
                quantity = Math.floor(quantity / stepSize) * stepSize;
            }
            quantity = parseFloat(quantity.toFixed(8));
        } else {
            if (currentNotionalUsd < minNotionalUsd) {
                quantity = Math.ceil(quantity / stepSize) * stepSize;
            } else {
                quantity = Math.floor(quantity / stepSize) * stepSize;
            }
        }

        // Enforce minimum quantity from exchange
        const minQty = this.minQuantity || 0.001;
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
            console.log(`[Strategy] Executing ${signal.decision} trade (${this.mockMode ? 'MOCK' : 'REAL'})...`);

            let result;
            if (this.mockMode) {
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
                        this.indicators?.eth?.price;
        }

        const entryPrice = parseFloat(activeTrade.price);
        const isLong = activeTrade.decision === 'BUY';
        const isMock = this.mockMode || activeTrade.order_id?.startsWith('MOCK_');

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

            // Optimize Time Stop
            const timeStopMs = (CONFIG.TIME_STOP_MINUTES || 30) * 60 * 1000;
            const minMovePct = CONFIG.TIME_STOP_MIN_MOVE_PCT !== undefined ? CONFIG.TIME_STOP_MIN_MOVE_PCT : 0.1;
            if (ageMs > timeStopMs && priceChangePct < minMovePct) {
                console.log(`[Strategy] Time-stop triggered: Age=${(ageMs / 60000).toFixed(1)}m, Move=${priceChangePct.toFixed(2)}% < ${minMovePct}%`);
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

            const ethPos = Array.isArray(positions)
                ? positions.find(p => (p.pair === CONFIG.PAIR || p.symbol === CONFIG.PAIR || (p.symbol && p.symbol.includes("ETH"))) && Math.abs(parseFloat(p.quantity || 0)) > 0.001)
                : null;

            if (ethPos) {
                console.log(`[Strategy] Sync: Found active position for ${CONFIG.PAIR} with qty ${ethPos.quantity}`);
            } else {
                console.log(`[Strategy] Sync: No active position found for ${CONFIG.PAIR} on exchange.`);
                console.log('[Strategy] Position closed on exchange');

                await this.closeTradeInDb(activeTrade, currentPrice, 'EXCHANGE_CLOSED (SL/TP/MANUAL)');
                return { status: 'TRADE_CLOSED', reason: 'EXCHANGE_CLOSED' };
            }

            const currentQty = parseFloat(ethPos.quantity);
            const tpLevels = activeTrade.tp_levels ? JSON.parse(activeTrade.tp_levels) : [];
            if (tpLevels.length > 0) {
                const tpResult = await this.checkAndExecutePartialTP(
                    tpLevels, currentPrice, currentQty, entryPrice, isLong, activeTrade
                );
                if (tpResult) return tpResult;
            }

            console.log(`[Strategy] Position still open: qty=${currentQty} price=${currentPrice}`);
            return { status: 'IN_TRADE', position: ethPos };
        } catch (err) {
            console.error('[Strategy] Live trade management error:', err.message);
            return { status: 'MANAGE_ERROR', error: err.message };
        }
    }

    async checkAndExecutePartialTP(tpLevels, currentPrice, totalQty, entryPrice, isLong, activeTrade) {
        const isMock = this.mockMode || activeTrade.order_id?.startsWith('MOCK_');
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
                await this.db.updateTPLevels(activeTrade.id, tpLevels);
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

                if (closeQty > 1) { // Only place order if quantity > 1.0
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
                    await this.db.updateTPLevels(activeTrade.id, tpLevels);
                } else if (closeQty > 0) {
                    console.log(`[Strategy] TP${i + 1} skipped because closeQty ${closeQty} <= 1.0. Will close at next TP or SL.`);
                    // We don't mark as executed so it can try again if position grows? 
                    // Or just mark as executed to move on. Let's move on.
                    level.executed = true;
                    await this.db.updateTPLevels(activeTrade.id, tpLevels);
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
        const isMock = this.mockMode || activeTrade.order_id?.startsWith('MOCK_');

        const tpLevels = activeTrade.tp_levels ? JSON.parse(activeTrade.tp_levels) : [];
        const executedPct = tpLevels.filter(l => l.executed).reduce((sum, l) => sum + l.pctOfPosition, 0);
        const remainingFraction = (100 - executedPct) / 100;

        const settlement = await this._settlePortion(activeTrade, currentPrice, remainingFraction, isLong, providedExitRate);

        await this.db.updateTradeStatus(
            activeTrade.id, 'CLOSED', currentPrice, settlement.totalPnlPct,
            reason, settlement.totalExitValueInr, settlement.totalPnlInr
        );
    }

    async _settlePortion(activeTrade, exitPriceInput, portionFractionInput, isLong, providedExitRate = null) {
        const isMock = this.mockMode || activeTrade.order_id?.startsWith('MOCK_');

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

            if (this.mockMode) {
                const startBalance = 2500; // Starting mock balance in settings
                const mockPnlPct = ((newBalance - startBalance) / startBalance) * 100;
                if (mockPnlPct >= 100.0) {
                    console.log(`[Strategy] AUTO-SWITCH SUCCESS: Mock P&L reached ${mockPnlPct.toFixed(1)}% (Balance: ₹${newBalance.toFixed(2)}). Switching to REAL mode.`);
                    await this.db.updateSetting('mock_mode', 'false');
                    this.mockMode = false;
                }
            }
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
        await this.db.updateTPLevels(activeTrade.id, tpLevels);

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

        // 2. Consecutive Loss Circuit Breaker (2 losses in a row)
        const recentTrades = await this.db.getRecentTrades(5);
        const closedTrades = recentTrades.filter(t => t.status === 'CLOSED');
        if (closedTrades.length >= 2) {
            const lastTwoLosses = closedTrades.slice(0, 2).every(t => (t.pnl !== null ? t.pnl <= 0 : (t.pnl_inr || 0) <= 0));
            if (lastTwoLosses) {
                const mostRecentLossTime = closedTrades[0].closed_at || closedTrades[0].timestamp;
                const elapsed = Date.now() - mostRecentLossTime;
                if (elapsed < CONFIG.COOLDOWN_AFTER_LOSS_MS) {
                    const remaining = Math.ceil((CONFIG.COOLDOWN_AFTER_LOSS_MS - elapsed) / 60000);
                    return { canTrade: false, reason: `Consecutive loss breaker: 2 losses in a row (${remaining}min cooldown remaining)` };
                }
            }
        }

        // 3. Daily Drawdown Protection (10% of initial balance)
        const todayPnLInr = await this.db.getTodayPnLInr();
        const ddInr = CONFIG.INITIAL_INR_BALANCE * 0.10; // 10% = ₹50
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
        const isMock = this.mockMode;
        if (isMock) {
            // Mock mode doesn't have an exchange back-end to reconcile with
            if (activeTrade) return { status: 'SYNC_STILL_OPEN' };
            return { status: 'SCANNING' };
        }

        // If positions is null, the API failed. 
        if (positions === null) {
            console.error(`[Strategy] RECONCILE: Positions API failed. Attempting history-based sync fallback...`);
            if (activeTrade) {
                // If we have an active trade, try to see if it was closed via history
                return await this.settleFromExchangeHistory(activeTrade, currentPriceFallback);
            }
            return { status: 'SCANNING' };
        }

        const ethPos = Array.isArray(positions)
            ? positions.find(p => (p.pair === CONFIG.PAIR || p.symbol === CONFIG.PAIR || (p.symbol && p.symbol.includes("ETH"))) && Math.abs(parseFloat(p.quantity || 0)) > 0.001)
            : null;

        // Case 1: Active trade in DB
        if (activeTrade && (activeTrade.status === 'OPEN' || activeTrade.status === 'FILLED')) {
            if (!ethPos) {
                // SIMPLE SYNC: Position exists in DB but GONE on exchange -> Settle from history
                console.log(`[Strategy] RECONCILE: DB trade ${activeTrade.id} (${activeTrade.order_id}) is OPEN but exchange position GONE. Settling from history...`);
                return await this.settleFromExchangeHistory(activeTrade, currentPriceFallback);
            }
            return { status: 'SYNC_STILL_OPEN' };
        }

        // Case 2: No active trade in DB, but position exists on exchange (The "Orphan" Rescue)
        if (!activeTrade && ethPos) {
            console.log(`[Strategy] RECONCILE: Found orphaned position on exchange (${ethPos.quantity} ${ethPos.pair})! Rescuing...`);
            const rescueResult = await this.rescueOrphanTrade(ethPos);
            if (rescueResult.status === 'SCANNING') {
                // If rescue failed (history slow/missing), DON'T proceed to scouting. 
                // Return a blocking status instead.
                console.warn('[Strategy] RECONCILE: Rescue pending. Blocking scouting to avoid double positions.');
                return { status: 'WAITING_FOR_SYNC', reason: 'Orphaned position detected but not yet rescued' };
            }
            return rescueResult;
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

            // Robust Matching: Find trades for this pair that happened AFTER our entry
            // and have the OPPOSITE side (or any trade that isn't our entry)
            const pair = (activeTrade.asset || CONFIG.PAIR).toUpperCase();
            const entryTime = activeTrade.timestamp || 0;
            const entrySide = activeTrade.decision;

            const exitTrades = history.filter(t => {
                const matchPair = (t.pair === pair || t.symbol === pair);
                const isAfterEntry = new Date(t.created_at).getTime() > (entryTime + 1000); // 1s buffer
                const isOppositeSide = (t.side !== entrySide && t.order_side !== entrySide);
                const isDifferentOrder = (t.order_id !== activeTrade.order_id);

                return matchPair && (isAfterEntry || isDifferentOrder) && isOppositeSide;
            });

            // If still no opposite trades, try any trade that isn't our entry as a last resort
            let finalExitTrades = exitTrades;
            if (finalExitTrades.length === 0) {
                finalExitTrades = history.filter(t =>
                    (t.pair === pair || t.symbol === pair) &&
                    t.order_id !== activeTrade.order_id
                );
            }

            if (finalExitTrades.length === 0) {
                console.warn(`[Strategy] RECONCILE: No likely exit trades found in history for ${pair} after entry. Falling back to estimated price.`);
                // Fallback to previous logic if history is mysteriously empty or no exit found
                let currentPrice = await getMarketPrice(pair);
                if (!currentPrice || isNaN(currentPrice)) currentPrice = currentPriceFallback;
                await this.closeTradeInDb(activeTrade, currentPrice, 'EXCHANGE_CLOSED (AUTO_SYNC)');
                return { status: 'TRADE_CLOSED', reason: 'EXCH_SYNC_ESTIMATED' };
            }

            // The most recent trade is our exit (SL/TP or Manual)
            const lastExecution = finalExitTrades[0];
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

    async rescueOrphanTrade(ethPos) {
        try {
            // Fetch trade history to find the entry details
            const history = await getTradeHistory(this.env);
            if (this.mockMode) return { status: 'SCANNING' }; // Safety

            const matches = Array.isArray(history)
                ? history.filter(t => {
                    const matchPair = (t.pair === ethPos.pair || t.symbol === ethPos.pair || t.pair === CONFIG.PAIR || t.symbol === CONFIG.PAIR);
                    const matchSide = (t.side === ethPos.side || t.order_side === ethPos.side);
                    return matchPair && matchSide;
                })
                : [];

            if (matches.length === 0) {
                console.error(`[Strategy] RECONCILE: Could not find entry details in history for orphaned trade. Positions: ${JSON.stringify(ethPos)}, HistoryCount: ${Array.isArray(history) ? history.length : 0}`);
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
                quantity: parseFloat(ethPos.quantity), // Use current actual qty
                leverage: parseFloat(latestTrade.leverage || 5),
                status: 'OPEN',
                orderId: latestTrade.order_id,
                entryValueInr: entryValueInr || (parseFloat(latestTrade.price) * parseFloat(ethPos.quantity) / (latestTrade.leverage || 5)) * 85,
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
