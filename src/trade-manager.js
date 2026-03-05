/**
 * Trade Manager — Paper trading engine for micro-scalping.
 * Tracks mock balance, positions, PnL, and trade history in INR.
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRADES_FILE = join(__dirname, '..', 'trades.json');

// Fixed rate for simulation as per user request
const USD_INR_RATE = 83.5;

export class TradeManager {
    constructor(config = {}) {
        this.initialBalance = config.initialBalance || 2500; // Starting capital in INR
        this.balance = this.initialBalance;
        this.positionSizePct = config.positionSizePct || 0.02;   // 2% of balance
        this.leverage = config.leverage || 10;
        this.slPercent = config.slPercent || 0.15;   // 0.15% stop loss
        this.tpPercent = config.tpPercent || 0.20;   // 0.20% take profit
        this.maxDailyLosses = config.maxDailyLosses || 5;
        this.cooldownCandles = config.cooldownCandles || 3;

        this.position = null;           // current open position
        this.trades = [];               // completed trades
        this.candlesSinceLastTrade = 99; // start high so first trade can fire
        this.dailyLosses = 0;
        this.dailyDate = this._todayStr();

        // Stats
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalPnl = 0;
        this.streak = 0; // positive = win streak, negative = loss streak

        // Load and migrate existing trades if needed
        this._loadTrades();
    }

    /**
     * Check if we can open a new trade.
     */
    canTrade() {
        this._checkDayReset();
        if (this.position) return { ok: false, reason: 'Position already open' };
        if (this.candlesSinceLastTrade < this.cooldownCandles) {
            return { ok: false, reason: `Cooldown: ${this.cooldownCandles - this.candlesSinceLastTrade} candles remaining` };
        }
        if (this.dailyLosses >= this.maxDailyLosses) {
            return { ok: false, reason: `Daily loss limit reached (${this.dailyLosses}/${this.maxDailyLosses})` };
        }
        if (this.balance <= 0) {
            return { ok: false, reason: 'Balance depleted' };
        }
        return { ok: true };
    }

    /**
     * Open a new paper trade.
     */
    openTrade(direction, price, pattern) {
        const check = this.canTrade();
        if (!check.ok) return { success: false, reason: check.reason };

        // INR Calculations
        const marginINR = this.balance * this.positionSizePct;
        const notionalINR = marginINR * this.leverage;

        // Convert to USD for Quantity (since DOGE trades against USDT)
        const notionalUSD = notionalINR / USD_INR_RATE;
        const quantity = notionalUSD / price;

        let sl, tp;
        if (direction === 'BUY') {
            sl = price * (1 - this.slPercent / 100);
            tp = price * (1 + this.tpPercent / 100);
        } else {
            sl = price * (1 + this.slPercent / 100);
            tp = price * (1 - this.tpPercent / 100);
        }

        this.position = {
            direction,
            entry: price,
            sl,
            tp,
            quantity,
            margin: marginINR,   // Store in INR
            notional: notionalINR, // Store in INR
            pattern: pattern.type,
            patternDesc: pattern.description,
            confidence: pattern.confidence,
            openTime: Date.now(),
            openTimeStr: new Date().toISOString(),
        };

        console.log(`[Trade] OPENED ${direction} @ ${price.toFixed(6)} | SL: ${sl.toFixed(6)} | TP: ${tp.toFixed(6)} | Pattern: ${pattern.type} (INR Notional: ₹${notionalINR.toFixed(2)})`);

        return {
            success: true,
            trade: { ...this.position },
        };
    }

    /**
     * Check if current price hits SL or TP for the open position.
     * Call this on every candle update (even partial).
     */
    checkPosition(currentPrice, highPrice, lowPrice) {
        if (!this.position) return null;

        const pos = this.position;
        let closePrice = null;
        let closeReason = null;

        if (pos.direction === 'BUY') {
            if (lowPrice <= pos.sl) {
                closePrice = pos.sl;
                closeReason = 'stop_loss';
            }
            else if (highPrice >= pos.tp) {
                closePrice = pos.tp;
                closeReason = 'take_profit';
            }
        } else {
            if (highPrice >= pos.sl) {
                closePrice = pos.sl;
                closeReason = 'stop_loss';
            }
            else if (lowPrice <= pos.tp) {
                closePrice = pos.tp;
                closeReason = 'take_profit';
            }
        }

        if (closePrice !== null) {
            return this._closeTrade(closePrice, closeReason);
        }

        return null;
    }

    _closeTrade(closePrice, reason) {
        const pos = this.position;
        let pnlUSD;

        if (pos.direction === 'BUY') {
            pnlUSD = (closePrice - pos.entry) * pos.quantity;
        } else {
            pnlUSD = (pos.entry - closePrice) * pos.quantity;
        }

        // Convert PnL to INR
        const grossPnlINR = pnlUSD * USD_INR_RATE;

        // Fee simulation: 0.04% taker fee on notional (INR)
        const feesINR = pos.notional * 0.0004 * 2;
        const netPnlINR = grossPnlINR - feesINR;

        const trade = {
            ...pos,
            exit: closePrice,
            closeTime: Date.now(),
            closeTimeStr: new Date().toISOString(),
            closeReason: reason,
            grossPnl: grossPnlINR,
            fees: feesINR,
            netPnl: netPnlINR,
            holdTimeMs: Date.now() - pos.openTime,
            result: netPnlINR > 0 ? 'WIN' : 'LOSS',
            currency: 'INR'
        };

        // Update balance and stats
        this.balance += netPnlINR;
        this.totalPnl += netPnlINR;

        if (netPnlINR > 0) {
            this.totalWins++;
            this.streak = this.streak > 0 ? this.streak + 1 : 1;
        } else {
            this.totalLosses++;
            this.dailyLosses++;
            this.streak = this.streak < 0 ? this.streak - 1 : -1;
        }

        this.trades.push(trade);
        this.position = null;
        this.candlesSinceLastTrade = 0;

        this._saveTrades();

        const emoji = netPnlINR > 0 ? '✅' : '❌';
        console.log(`[Trade] ${emoji} CLOSED ${trade.direction} @ ${closePrice.toFixed(6)} | ${reason} | PnL: ₹${netPnlINR.toFixed(2)} | Balance: ₹${this.balance.toFixed(2)}`);

        return trade;
    }

    getStats() {
        this._checkDayReset();
        const unrealizedPnlUSD = this.position ? this._calcUnrealizedPnlUSD(this.position.entry) : 0;
        const unrealizedPnlINR = unrealizedPnlUSD * USD_INR_RATE;

        return {
            balance: this.balance,
            initialBalance: this.initialBalance,
            totalPnl: this.totalPnl,
            totalPnlPercent: ((this.totalPnl / this.initialBalance) * 100),
            totalWins: this.totalWins,
            totalLosses: this.totalLosses,
            winRate: (this.totalWins + this.totalLosses) > 0
                ? ((this.totalWins / (this.totalWins + this.totalLosses)) * 100)
                : 0,
            totalTrades: this.totalWins + this.totalLosses,
            dailyLosses: this.dailyLosses,
            streak: this.streak,
            position: this.position ? { ...this.position, unrealizedPnl: unrealizedPnlINR } : null,
            cooldownRemaining: Math.max(0, this.cooldownCandles - this.candlesSinceLastTrade),
            currency: 'INR'
        };
    }

    getRecentTrades(limit = 50) {
        return this.trades.slice(-limit);
    }

    _calcUnrealizedPnlUSD(currentPrice) {
        if (!this.position) return 0;
        const pos = this.position;
        if (pos.direction === 'BUY') {
            return (currentPrice - pos.entry) * pos.quantity;
        } else {
            return (pos.entry - currentPrice) * pos.quantity;
        }
    }

    _checkDayReset() {
        const today = this._todayStr();
        if (today !== this.dailyDate) {
            this.dailyDate = today;
            this.dailyLosses = 0;
        }
    }

    _todayStr() {
        return new Date().toISOString().slice(0, 10);
    }

    _saveTrades() {
        try {
            writeFileSync(TRADES_FILE, JSON.stringify(this.trades, null, 2));
        } catch (err) {
            console.error(`[Trade] Save error:`, err.message);
        }
    }

    _loadTrades() {
        try {
            if (existsSync(TRADES_FILE)) {
                const data = readFileSync(TRADES_FILE, 'utf-8');
                const loaded = JSON.parse(data);
                if (Array.isArray(loaded)) {
                    // Recalculate if it's USD data or just load if already INR
                    if (loaded.length > 0 && loaded[0].currency !== 'INR') {
                        console.log(`[Trade] Migrating ${loaded.length} trades to INR...`);
                        this._migrateToINR(loaded);
                    } else {
                        this.trades = loaded;
                        this.totalPnl = 0;
                        this.totalWins = 0;
                        this.totalLosses = 0;
                        for (const t of this.trades) {
                            this.totalPnl += t.netPnl || 0;
                            if (t.result === 'WIN') this.totalWins++;
                            else this.totalLosses++;
                        }
                        this.balance = this.initialBalance + this.totalPnl;
                        console.log(`[Trade] Loaded ${this.trades.length} INR trades, balance: ₹${this.balance.toFixed(2)}`);
                    }
                }
            }
        } catch (err) {
            console.error(`[Trade] Load error:`, err.message);
        }
    }

    _migrateToINR(oldTrades) {
        this.trades = [];
        this.balance = 2500; // Reset to 2500 INR start
        this.totalPnl = 0;
        this.totalWins = 0;
        this.totalLosses = 0;

        for (const t of oldTrades) {
            const entryUSD = t.entry;
            const exitUSD = t.exit;
            const direction = t.direction;

            const pnlPercent = direction === 'BUY'
                ? (exitUSD - entryUSD) / entryUSD
                : (entryUSD - exitUSD) / entryUSD;

            const marginINR = this.balance * this.positionSizePct;
            const notionalINR = marginINR * this.leverage;
            const grossPnlINR = notionalINR * pnlPercent;
            const feesINR = notionalINR * 0.0004 * 2;
            const netPnlINR = grossPnlINR - feesINR;

            const newTrade = {
                ...t,
                margin: marginINR,
                notional: notionalINR,
                grossPnl: grossPnlINR,
                fees: feesINR,
                netPnl: netPnlINR,
                result: netPnlINR > 0 ? 'WIN' : 'LOSS',
                currency: 'INR'
            };

            this.balance += netPnlINR;
            this.totalPnl += netPnlINR;
            if (netPnlINR > 0) this.totalWins++; else this.totalLosses++;
            this.trades.push(newTrade);
        }

        this._saveTrades();
        console.log(`[Trade] Migration complete. New balance: ₹${this.balance.toFixed(2)}`);
    }
}
