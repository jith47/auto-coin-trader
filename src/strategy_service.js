import { fetchMarketData, computeAllIndicators } from './binance.js';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration — mirrors PineScript inputs
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
    // Symbol & timeframe
    SYMBOL: 'BTCUSDT',
    INTERVAL: '5m',
    KLINE_LIMIT: 250,

    // EMA settings
    FAST_EMA: 9,
    SLOW_EMA: 21,
    TREND_EMA: 200,
    USE_TREND_200: true,

    // RSI settings
    RSI_LEN: 14,
    RSI_LONG: 50,
    RSI_SHORT: 50,

    // Volume settings
    VOL_LEN: 20,
    VOL_MULT: 1.10,

    // ATR settings
    ATR_LEN: 14,
    STOP_ATR: 1.0,
    TARGET_ATR: 1.3,
    TRAIL_ATR: 0.8,

    // Time stop
    MAX_BARS_IN_TRADE: 18,

    // Session filter (NY time: 0930-1600)
    // Default to false for 24/7 crypto, but logic is implemented
    SESSION_FILTER: false,
    TRADE_SESSION: { start: '09:30', end: '16:00', timezone: 'America/New_York' },

    // Position sizing
    QTY_PERCENT: 10,

    // Mock mode
    MOCK_MODE: true,
    INITIAL_BALANCE_USD: 100000,

    // Fee (Set to 0.0 to match original backtest)
    FEE_PCT: 0.0,
};

export { CONFIG };

// ─────────────────────────────────────────────────────────────────────────────
// Strategy Service
// ─────────────────────────────────────────────────────────────────────────────
export class StrategyService {
    constructor(env) {
        this.env = env;
        this.db = null;
        this.indicators = null;
    }

    async run(db) {
        this.db = db;
        console.log(`[Strategy] ── Evaluation Start ── ${CONFIG.SYMBOL} ${CONFIG.INTERVAL}`);

        try {
            // 1. Fetch data
            const { klines } = await fetchMarketData(CONFIG.SYMBOL, CONFIG.INTERVAL, CONFIG.KLINE_LIMIT);
            if (!klines || klines.length < CONFIG.TREND_EMA + 5) {
                return { status: 'ERROR', reason: 'Insufficient data' };
            }

            this.indicators = computeAllIndicators(klines, CONFIG);
            if (!this.indicators) return { status: 'ERROR', reason: 'Indicators failed' };

            const ind = this.indicators;
            const inSession = this.checkSession();

            // 2. Manage existing trade
            const activeTrade = await db.getActiveTrade();
            if (activeTrade && activeTrade.status === 'OPEN') {
                // If session filter is on and session ended, force close
                if (CONFIG.SESSION_FILTER && !inSession) {
                    console.log('[Strategy] Session ended. Force closing all.');
                    return await this.closeTrade(activeTrade, ind.price, 'SESSION_END');
                }
                return await this.manageTrade(activeTrade);
            }

            // 3. Check entry signals (must be in session if filter enabled)
            if (CONFIG.SESSION_FILTER && !inSession) {
                console.log('[Strategy] Outside trade session. Skipping entry check.');
                return { status: 'OUTSIDE_SESSION', time: new Date().toISOString() };
            }

            const signal = this.evaluateEntry(ind);
            if (!signal) {
                return { status: 'NO_SIGNAL', price: ind.price };
            }

            console.log(`[Strategy] ${signal.direction} Signal detected`);
            return await this.executeTrade(signal);

        } catch (err) {
            console.error('[Strategy] Error:', err.message);
            return { status: 'ERROR', error: err.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Gating
    // ─────────────────────────────────────────────────────────────────────────
    checkSession() {
        if (!CONFIG.SESSION_FILTER) return true;

        try {
            const now = new Date();
            const nyTime = new Intl.DateTimeFormat('en-US', {
                timeZone: CONFIG.TRADE_SESSION.timezone,
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }).format(now);

            const [hour, min] = nyTime.split(':').map(Number);
            const currentMins = hour * 60 + min;

            const [sH, sM] = CONFIG.TRADE_SESSION.start.split(':').map(Number);
            const [eH, eM] = CONFIG.TRADE_SESSION.end.split(':').map(Number);
            const startMins = sH * 60 + sM;
            const endMins = eH * 60 + eM;

            return currentMins >= startMins && currentMins < endMins;
        } catch (e) {
            return true; // fallback
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Evaluation logic
    // ─────────────────────────────────────────────────────────────────────────
    evaluateEntry(ind) {
        const trend200LongOK = !CONFIG.USE_TREND_200 || ind.above200;
        const longSignal = ind.trendUp && trend200LongOK && ind.pullbackLong && ind.rsiLongCross && ind.volumeOK;

        if (longSignal) return this.buildSignal('BUY', ind);

        const trend200ShortOK = !CONFIG.USE_TREND_200 || ind.below200;
        const shortSignal = ind.trendDown && trend200ShortOK && ind.pullbackShort && ind.rsiShortCross && ind.volumeOK;

        if (shortSignal) return this.buildSignal('SELL', ind);

        return null;
    }

    buildSignal(direction, ind) {
        // We log everything at entry, but SL/TP will be DYNAMIC in manageTrade
        return {
            direction,
            entry: ind.price,
            atr: ind.atr,
            reason: `EMA Scaling ${direction} | RSI:${ind.rsi?.toFixed(1)} | Vol:${ind.volumeOK ? 'OK' : 'LOW'}`,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Execution
    // ─────────────────────────────────────────────────────────────────────────
    async executeTrade(signal) {
        const balance = await this.db.getMockBalance();
        const positionValue = balance * (CONFIG.QTY_PERCENT / 100);
        const quantity = positionValue / signal.entry;

        const tradeData = {
            decision: signal.direction,
            reason: signal.reason,
            asset: CONFIG.SYMBOL,
            entry: signal.entry,
            quantity: parseFloat(quantity.toFixed(8)),
            atr: signal.atr,
            entryValueUsd: parseFloat(positionValue.toFixed(2)),
            order_id: `MOCK_${Date.now()}`,
            // Initial SL/TP (static for logging, but dynamic for management)
            stopLoss: signal.direction === 'BUY' ? signal.entry - signal.atr : signal.entry + signal.atr,
            takeProfit: signal.direction === 'BUY' ? signal.entry + signal.atr * 1.3 : signal.entry - signal.atr * 1.3,
        };

        // Fees (usually 0 per user but implemented if changed)
        const feeUsd = positionValue * (CONFIG.FEE_PCT / 100);
        await this.db.updateMockBalance(balance - feeUsd);
        await this.db.logTrade(tradeData);

        // PERSISTENCE ALIGNMENT: Use snake_case order_id matching DB schema
        // 1. Initialize bar counting (set to entry candle open time)
        await this.db.updateSetting(`last_time_${tradeData.order_id}`, this.indicators.candle.openTime);

        // 2. Initialize peak tracking (start with current candle's extremes)
        const initialPeak = signal.direction === 'BUY' ? this.indicators.candle.high : this.indicators.candle.low;
        await this.db.updateSetting(`peak_${tradeData.order_id}`, initialPeak);

        return { status: 'TRADE_PLACED', trade: tradeData };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Management (Technical Parity with Pine)
    // ─────────────────────────────────────────────────────────────────────────
    async manageTrade(activeTrade) {
        const ind = this.indicators;
        const candle = ind.candle;
        const isLong = activeTrade.decision === 'BUY';
        const entryPrice = parseFloat(activeTrade.price);
        const currentATR = ind.atr;

        // 1. DYNAMIC SL/TP (Matches Pine behavior)
        const sl = isLong ? entryPrice - currentATR * CONFIG.STOP_ATR : entryPrice + currentATR * CONFIG.STOP_ATR;
        const tp = isLong ? entryPrice + currentATR * CONFIG.TARGET_ATR : entryPrice - currentATR * CONFIG.TARGET_ATR;

        // 2. Trailing Stop Logic with Activation Threshold
        let trailStop = null;
        if (CONFIG.TRAIL_ATR > 0) {
            const peakSettingKey = `peak_${activeTrade.order_id}`;
            const peak = parseFloat(await this.db.getSetting(peakSettingKey, isLong ? candle.high : candle.low));
            const newPeak = isLong ? Math.max(peak, candle.high) : Math.min(peak, candle.low);
            if (newPeak !== peak) await this.db.updateSetting(peakSettingKey, newPeak);

            // Trailing Stop Activation: Move ATR * 0.8 in profit before trailing starts
            const activationDist = currentATR * CONFIG.TRAIL_ATR;
            const currentProfit = isLong ? newPeak - entryPrice : entryPrice - newPeak;

            if (currentProfit >= activationDist) {
                trailStop = isLong ? newPeak - activationDist : newPeak + activationDist;
            }
        }

        // 3. Collective Exit Evaluation with Technical Priority
        // If multiple levels are hit within the same candle's high/low range,
        // we prioritize the one that would logically execute first (most conservative/tightest).
        let exitTriggered = null;
        let exitPrice = 0;

        const slHit = isLong ? candle.low <= sl : candle.high >= sl;
        const tpHit = isLong ? candle.high >= tp : candle.low <= tp;
        const trailHit = trailStop !== null && (isLong ? candle.low <= trailStop : candle.high >= trailStop);

        if (slHit || tpHit || trailHit) {
            // Priority Log (Conservative Parity with Pine):
            // 1. Check SL/Trailing first (Pessimistic: assume hit first if both in range)
            // 2. Check TP last
            if (slHit) {
                exitTriggered = 'SL_HIT';
                exitPrice = sl;
            } else if (trailHit) {
                exitTriggered = 'TRAIL_STOP';
                exitPrice = trailStop;
            } else if (tpHit) {
                exitTriggered = 'TP_HIT';
                exitPrice = tp;
            }
        }

        if (exitTriggered) {
            console.log(`[Strategy] Exit triggered: ${exitTriggered} at ${exitPrice}`);
            return await this.closeTrade(activeTrade, exitPrice, exitTriggered);
        }

        // 4. Robust Bar Counting (Matches Pine's unique-timestamp increment)
        const timeKey = `last_time_${activeTrade.order_id}`; // Fixed: was orderId
        const lastTime = parseInt(await this.db.getSetting(timeKey, '0'));
        const currentTime = candle.openTime;

        if (currentTime > lastTime) {
            const bars = (await this.db.getBarsInTrade(activeTrade.order_id)) + 1;
            await this.db.updateBarsInTrade(activeTrade.order_id, bars);
            await this.db.updateSetting(timeKey, currentTime);

            if (CONFIG.MAX_BARS_IN_TRADE > 0 && bars >= CONFIG.MAX_BARS_IN_TRADE) {
                return await this.closeTrade(activeTrade, ind.price, 'TIME_STOP');
            }
            console.log(`[Strategy] Bar ${bars}/${CONFIG.MAX_BARS_IN_TRADE}`);
        }

        return { status: 'IN_TRADE', pnl: ((ind.price - entryPrice) / entryPrice * 100 * (isLong ? 1 : -1)).toFixed(3) };
    }

    async closeTrade(activeTrade, exitPrice, reason) {
        const entryPrice = parseFloat(activeTrade.price);
        const isLong = activeTrade.decision === 'BUY';
        const quantity = parseFloat(activeTrade.quantity);
        const entryVal = parseFloat(activeTrade.entry_value_usd || 0);

        const pnlPct = (exitPrice - entryPrice) / entryPrice * 100 * (isLong ? 1 : -1);
        const pnlUsd = entryVal * (pnlPct / 100);

        const feeUsd = (quantity * exitPrice) * (CONFIG.FEE_PCT / 100);
        const netPnlUsd = pnlUsd - feeUsd;

        const balance = await this.db.getMockBalance();
        await this.db.updateMockBalance(balance + netPnlUsd);

        await this.db.updateTradeStatus(activeTrade.order_id, 'CLOSED', exitPrice, pnlPct, reason, netPnlUsd);

        // Clean settings
        await this.db.deleteSetting(`peak_${activeTrade.order_id}`);
        await this.db.deleteSetting(`last_time_${activeTrade.order_id}`);
        await this.db.deleteSetting(`bars_${activeTrade.order_id}`);

        console.log(`[Strategy] Closed ${reason}: PnL=${pnlPct.toFixed(2)}%, Net=$${netPnlUsd.toFixed(2)}`);
        return { status: 'CLOSED', reason, pnl: pnlPct.toFixed(2) };
    }
}
