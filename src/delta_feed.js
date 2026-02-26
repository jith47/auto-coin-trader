/**
 * Durable Object: BinanceDeltaFeed
 * Maintains a persistent WebSocket connection to Binance futures aggTrade streams.
 * Accumulates tick-by-tick delta data for BTC and DOGE.
 * Provides a /snapshot endpoint for the cron worker to query real-time CVD.
 */
export class BinanceDeltaFeed {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.ws = null;
        this.btc = new DeltaAccumulator();
        this.doge = new DeltaAccumulator();
        this.connectedAt = null;
        this.messageCount = 0;
        this.lastError = null;
    }

    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === '/snapshot') {
            await this.ensureConnected();
            return Response.json({
                btc: this.btc.getSnapshot(),
                doge: this.doge.getSnapshot(),
                connected: this.ws !== null,
                connectedAt: this.connectedAt,
                uptimeMin: this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 60000) : 0,
                messageCount: this.messageCount,
                lastError: this.lastError,
            });
        }

        if (url.pathname === '/reset') {
            this.disconnect();
            return Response.json({ status: 'reset' });
        }

        if (url.pathname === '/health') {
            return Response.json({
                connected: this.ws !== null,
                uptimeMin: this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 60000) : 0,
                btcMinutes: this.btc.minuteCount(),
                dogeMinutes: this.doge.minuteCount(),
                messageCount: this.messageCount,
            });
        }

        return new Response('Not Found', { status: 404 });
    }

    async ensureConnected() {
        if (this.ws) return;

        try {
            // CF Workers: use fetch() with Upgrade header for outbound WebSocket
            const wsUrl = 'https://fstream.binance.com/stream?streams=btcusdt@aggTrade/dogeusdt@aggTrade';
            const resp = await fetch(wsUrl, {
                headers: { Upgrade: 'websocket' },
            });

            const ws = resp.webSocket;
            if (!ws) {
                this.lastError = 'WebSocket upgrade failed';
                console.error('[DeltaFeed]', this.lastError);
                return;
            }

            ws.accept();

            ws.addEventListener('message', (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (!msg.data || !msg.stream) return;

                    const trade = msg.data;
                    const qty = parseFloat(trade.q);
                    const isSell = trade.m; // buyer is maker = taker sold

                    if (msg.stream.includes('btcusdt')) {
                        this.btc.addTrade(qty, isSell);
                    } else if (msg.stream.includes('dogeusdt')) {
                        this.doge.addTrade(qty, isSell);
                    }

                    this.messageCount++;
                } catch (e) {
                    // Ignore parse errors on individual messages
                }
            });

            ws.addEventListener('close', (event) => {
                console.log(`[DeltaFeed] WebSocket closed: code=${event.code}`);
                this.ws = null;
                this.lastError = `WebSocket closed: code=${event.code}`;
            });

            ws.addEventListener('error', (event) => {
                console.error('[DeltaFeed] WebSocket error');
                this.ws = null;
                this.lastError = 'WebSocket error';
            });

            this.ws = ws;
            this.connectedAt = Date.now();
            this.messageCount = 0;
            this.lastError = null;
            console.log('[DeltaFeed] Connected to Binance aggTrade stream');

        } catch (err) {
            console.error('[DeltaFeed] Connection failed:', err.message);
            this.ws = null;
            this.lastError = err.message;
        }
    }

    disconnect() {
        if (this.ws) {
            try { this.ws.close(); } catch (e) { /* ignore */ }
            this.ws = null;
        }
        this.btc = new DeltaAccumulator();
        this.doge = new DeltaAccumulator();
        this.connectedAt = null;
        this.messageCount = 0;
    }
}


/**
 * Accumulates per-minute delta buckets from tick-by-tick trade data.
 * Computes CVD direction and slope over a 10-minute rolling window.
 */
class DeltaAccumulator {
    constructor() {
        this.buckets = new Map(); // minuteKey -> { buyVol, sellVol }
    }

    addTrade(qty, isSell) {
        const minuteKey = Math.floor(Date.now() / 60000);

        if (!this.buckets.has(minuteKey)) {
            this.buckets.set(minuteKey, { buyVol: 0, sellVol: 0 });
            this.prune(minuteKey);
        }

        const bucket = this.buckets.get(minuteKey);
        if (isSell) {
            bucket.sellVol += qty;
        } else {
            bucket.buyVol += qty;
        }
    }

    prune(currentKey) {
        // Keep last 15 minutes
        for (const key of this.buckets.keys()) {
            if (key < currentKey - 15) {
                this.buckets.delete(key);
            }
        }
    }

    minuteCount() {
        return this.buckets.size;
    }

    getSnapshot() {
        const currentMinute = Math.floor(Date.now() / 60000);

        // Collect last 10 minutes of data
        const deltas = [];
        for (let i = currentMinute - 9; i <= currentMinute; i++) {
            const b = this.buckets.get(i);
            deltas.push(b ? b.buyVol - b.sellVol : 0);
        }

        // Cumulative CVD
        const cvdValues = [];
        let cumulative = 0;
        for (const d of deltas) {
            cumulative += d;
            cvdValues.push(cumulative);
        }

        const minutesOfData = this.buckets.size;
        if (minutesOfData < 3) {
            return { direction: 'flat', slope: 'flat', value: cumulative, minutesOfData };
        }

        // Direction: compare last 3 vs first 3 CVD values
        const len = cvdValues.length;
        const recentAvg = (cvdValues[len - 1] + cvdValues[len - 2] + cvdValues[len - 3]) / 3;
        const earlyAvg = (cvdValues[0] + cvdValues[1] + cvdValues[2]) / 3;
        const diff = recentAvg - earlyAvg;

        // Normalize slope by average absolute delta per minute
        const totalAbsDelta = deltas.reduce((s, d) => s + Math.abs(d), 0);
        const avgAbsDelta = totalAbsDelta / deltas.length || 1;
        const normalizedSlope = Math.abs(diff) / avgAbsDelta;

        let direction = 'flat';
        if (diff > avgAbsDelta * 0.05) direction = 'rising';
        else if (diff < -avgAbsDelta * 0.05) direction = 'falling';

        let slope = 'flat';
        if (normalizedSlope >= 0.5) slope = 'steep';
        else if (normalizedSlope >= 0.15) slope = 'gradual';

        return {
            direction, slope, value: cumulative, minutesOfData,
            currentMinuteDelta: deltas[deltas.length - 1],
        };
    }
}
