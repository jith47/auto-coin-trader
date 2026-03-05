import { StrategyService } from './strategy_service.js';
import { D1Database } from './db_d1.js';


// SHA-256 hash helper
async function sha256(text) {
    const data = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Validate auth token
async function isAuthed(request, env) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
    const token = authHeader.slice(7);
    const expected = await sha256(env.DASHBOARD_PASSWORD + '_scalper_salt');
    return token === expected;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // Login endpoint — no auth required
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

        // All /api/* routes require auth
        if (url.pathname.startsWith('/api/')) {
            if (!await isAuthed(request, env)) {
                return Response.json({ error: 'Unauthorized' }, { status: 401 });
            }

            const db = new D1Database(env.DB);

            if (url.pathname === '/api/status') {
                const activeTrade = await db.getActiveTrade();
                const stats = await db.getStats();
                const todayCount = await db.getTodayTradeCount();
                const todayLosses = await db.getTodayLossCount();
                return Response.json({
                    status: activeTrade ? 'IN_TRADE' : 'SCANNING',
                    activeTrade, stats,
                    todayTrades: todayCount, todayLosses,
                    timestamp: new Date().toISOString(),
                });
            }

            if (url.pathname === '/api/trades') {
                const trades = await db.getRecentTrades(50);
                return Response.json(trades);
            }

            if (url.pathname === '/api/run') {
                const service = new StrategyService(env);
                const result = await service.run(db);
                return Response.json(result);
            }

            if (url.pathname === '/api/debug') {
                return Response.json({
                    hasAssets: !!env.ASSETS,
                    pathname: url.pathname,
                    envKeys: Object.keys(env)
                });
            }

            return Response.json({ error: 'Not found' }, { status: 404 });
        }

        // Dashboard (static assets)
        if (env.ASSETS) {
            // Explicitly serve index.html for root or empty path
            if (url.pathname === '/' || url.pathname === '') {
                const indexRequest = new Request(new URL('/index.html', request.url), request);
                return env.ASSETS.fetch(indexRequest);
            }
            return env.ASSETS.fetch(request);
        }

        return new Response('Assets binding not found', { status: 500 });
    },

    async scheduled(event, env, ctx) {
        console.log('[Worker] Cron triggered');
        const db = new D1Database(env.DB);
        const service = new StrategyService(env);
        const result = await service.run(db);
        console.log('[Worker] Result:', JSON.stringify(result));
    },
};
