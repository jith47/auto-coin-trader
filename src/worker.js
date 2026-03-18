import { StrategyService, CONFIG } from './strategy_service.js';
import { D1Database } from './db_d1.js';

// SHA-256 hash helper
async function sha256(text) {
    const data = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Validate auth token
async function isAuthed(request, env) {
    if (!env.DASHBOARD_PASSWORD) return true; // no password = no auth
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
    const token = authHeader.slice(7);
    const expected = await sha256(env.DASHBOARD_PASSWORD + '_scalper_salt');
    return token === expected;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // Login endpoint
        if (url.pathname === '/api/login' && request.method === 'POST') {
            try {
                const { password } = await request.json();
                if (password === env.DASHBOARD_PASSWORD) {
                    const token = await sha256(env.DASHBOARD_PASSWORD + '_scalper_salt');
                    return Response.json({ success: true, token });
                }
                return Response.json({ success: false, error: 'Wrong password' }, { status: 401 });
            } catch {
                return Response.json({ success: false, error: 'Invalid request' }, { status: 400 });
            }
        }

        // API routes (auth required if password is set)
        if (url.pathname.startsWith('/api/')) {
            if (!await isAuthed(request, env)) {
                return Response.json({ error: 'Unauthorized' }, { status: 401 });
            }

            const db = new D1Database(env.DB);

            if (url.pathname === '/api/status') {
                const activeTrade = await db.getActiveTrade();
                const stats = await db.getStats();
                return Response.json({
                    status: activeTrade ? 'IN_TRADE' : 'SCANNING',
                    symbol: CONFIG.SYMBOL,
                    interval: CONFIG.INTERVAL,
                    activeTrade,
                    stats,
                    config: {
                        fastEma: CONFIG.FAST_EMA,
                        slowEma: CONFIG.SLOW_EMA,
                        trendEma: CONFIG.TREND_EMA,
                        rsiLen: CONFIG.RSI_LEN,
                        atrLen: CONFIG.ATR_LEN,
                        stopAtr: CONFIG.STOP_ATR,
                        targetAtr: CONFIG.TARGET_ATR,
                        trailAtr: CONFIG.TRAIL_ATR,
                        maxBars: CONFIG.MAX_BARS_IN_TRADE,
                    },
                    timestamp: new Date().toISOString(),
                });
            }

            if (url.pathname === '/api/trades') {
                const limit = parseInt(url.searchParams.get('limit') || '50');
                const trades = await db.getRecentTrades(limit);
                return Response.json(trades);
            }

            if (url.pathname === '/api/run') {
                const service = new StrategyService(env);
                const result = await service.run(db);
                return Response.json(result);
            }

            return Response.json({ error: 'Not found' }, { status: 404 });
        }

        // Dashboard (static assets)
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response('Not Found', { status: 404 });
    },

    async scheduled(event, env, ctx) {
        console.log('[Worker] Cron triggered');
        const db = new D1Database(env.DB);
        const service = new StrategyService(env);
        const result = await service.run(db);
        console.log('[Worker] Result:', JSON.stringify(result));
    },
};
