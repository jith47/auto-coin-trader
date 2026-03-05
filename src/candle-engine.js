/**
 * Candle Engine — Connects to Binance WebSocket for real-time 1m klines.
 * Maintains a rolling buffer of closed candles and emits events.
 */
import WebSocket from 'ws';
import { EventEmitter } from 'events';

const BINANCE_WS = 'wss://stream.binance.com:9443/ws';
const BINANCE_REST = 'https://data-api.binance.vision';
const MAX_CANDLES = 100;

export class CandleEngine extends EventEmitter {
    constructor(symbol = 'dogeusdt') {
        super();
        this.symbol = symbol.toLowerCase();
        this.symbolUpper = symbol.toUpperCase();
        this.candles = [];        // closed candles buffer
        this.currentCandle = null; // forming candle
        this.ws = null;
        this.reconnectTimer = null;
        this.high24h = 0;
        this.low24h = Infinity;
    }

    /**
     * Fetch historical 1m klines to pre-fill the candle buffer before WS starts.
     */
    async fetchHistoricalCandles() {
        try {
            const url = `${BINANCE_REST}/api/v3/klines?symbol=${this.symbolUpper}&interval=1m&limit=${MAX_CANDLES}`;
            const res = await fetch(url);
            if (!res.ok) {
                console.error(`[CandleEngine] Failed to fetch history: HTTP ${res.status}`);
                return;
            }
            const data = await res.json();
            this.candles = data.map(k => ({
                time: k[0],
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
                closeTime: k[6],
                isClosed: true,
            }));
            // Remove the last one if it's the currently forming candle
            if (this.candles.length > 0) {
                const last = this.candles[this.candles.length - 1];
                const now = Date.now();
                if (last.closeTime > now) {
                    this.currentCandle = this.candles.pop();
                    this.currentCandle.isClosed = false;
                }
            }
            // Compute 24h range from historical data
            const allCandles = [...this.candles];
            if (this.currentCandle) allCandles.push(this.currentCandle);
            this.high24h = Math.max(...allCandles.map(c => c.high));
            this.low24h = Math.min(...allCandles.map(c => c.low));

            console.log(`[CandleEngine] Loaded ${this.candles.length} historical candles`);
        } catch (err) {
            console.error(`[CandleEngine] History fetch error:`, err.message);
        }
    }

    /**
     * Start the WebSocket connection to Binance kline stream.
     */
    async start() {
        await this.fetchHistoricalCandles();
        this._connect();
    }

    _connect() {
        const streamUrl = `${BINANCE_WS}/${this.symbol}@kline_1m`;
        console.log(`[CandleEngine] Connecting to ${streamUrl}`);

        this.ws = new WebSocket(streamUrl);

        this.ws.on('open', () => {
            console.log(`[CandleEngine] Connected to Binance WebSocket`);
            this.emit('connected');
        });

        this.ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.e !== 'kline') return;
                this._processKline(msg.k);
            } catch (err) {
                console.error(`[CandleEngine] Parse error:`, err.message);
            }
        });

        this.ws.on('close', () => {
            console.log(`[CandleEngine] WebSocket closed, reconnecting in 3s...`);
            this._scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            console.error(`[CandleEngine] WebSocket error:`, err.message);
            this.ws.close();
        });
    }

    _processKline(k) {
        const candle = {
            time: k.t,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
            closeTime: k.T,
            isClosed: k.x,
        };

        // Update 24h tracking
        if (candle.high > this.high24h) this.high24h = candle.high;
        if (candle.low < this.low24h) this.low24h = candle.low;

        if (candle.isClosed) {
            // Candle just closed
            this.candles.push(candle);
            if (this.candles.length > MAX_CANDLES) {
                this.candles.shift();
            }
            this.currentCandle = null;
            this.emit('candle_closed', {
                candle,
                candles: [...this.candles],
                high24h: this.high24h,
                low24h: this.low24h,
            });
        } else {
            // Candle still forming — live update
            this.currentCandle = candle;
            this.emit('candle_update', {
                candle,
                candles: [...this.candles],
                high24h: this.high24h,
                low24h: this.low24h,
            });
        }
    }

    _scheduleReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this._connect();
        }, 3000);
    }

    stop() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
        }
        console.log(`[CandleEngine] Stopped`);
    }
}
