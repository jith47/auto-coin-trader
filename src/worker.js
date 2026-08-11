import { StrategyService } from './strategy_service.js';
import { D1Database } from './db_d1.js';
import { fetchAllMarketData, computeIndicators } from './binance.js';


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
                const isRunning = await db.getSetting('is_running', 'true');
                const mockMode = await db.getSetting('mock_mode', 'true');
                const parallelTradesMode = await db.getSetting('parallel_trades_mode', 'false');
                const activeTrades = await db.getActiveTrades();
                return Response.json({
                    status: activeTrades.length > 0 ? 'IN_TRADE' : 'SCANNING',
                    activeTrade: activeTrades[0] || null,
                    activeTradesCount: activeTrades.length,
                    stats,
                    todayTrades: todayCount, todayLosses,
                    timestamp: new Date().toISOString(),
                    isRunning: isRunning === 'true',
                    mockMode: mockMode === 'true',
                    parallelTradesMode: parallelTradesMode === 'true',
                });
            }

            if (url.pathname === '/api/trades') {
                const trades = await db.getRecentTrades(50);
                return Response.json(trades);
            }

            if (url.pathname === '/api/strategy-stats') {
                try {
                    const stats = await db.getStrategyStats();
                    return Response.json(stats);
                } catch (err) {
                    return Response.json({ error: err.message }, { status: 500 });
                }
            }

            if (url.pathname === '/api/run') {
                const service = new StrategyService(env);
                const result = await service.run(db);
                return Response.json(result);
            }

            if (url.pathname === '/api/settings/toggle-service' && request.method === 'POST') {
                try {
                    const isRunning = await db.getSetting('is_running', 'true');
                    const nextState = isRunning === 'true' ? 'false' : 'true';
                    await db.updateSetting('is_running', nextState);
                    return Response.json({ success: true, isRunning: nextState === 'true' });
                } catch (err) {
                    return Response.json({ error: err.message }, { status: 500 });
                }
            }

            if (url.pathname === '/api/settings/toggle-mock' && request.method === 'POST') {
                try {
                    await db.updateSetting('mock_mode', 'true');
                    return Response.json({ success: true, mockMode: true, message: 'Mock Mode strictly enforced' });
                } catch (err) {
                    return Response.json({ error: err.message }, { status: 500 });
                }
            }

            if (url.pathname === '/api/settings/toggle-parallel-trades' && request.method === 'POST') {
                try {
                    const current = await db.getSetting('parallel_trades_mode', 'false');
                    const nextState = current === 'true' ? 'false' : 'true';
                    await db.updateSetting('parallel_trades_mode', nextState);
                    return Response.json({ success: true, parallelTradesMode: nextState === 'true' });
                } catch (err) {
                    return Response.json({ error: err.message }, { status: 500 });
                }
            }

            if (url.pathname === '/api/delta') {
                try {
                    if (env.DELTA_FEED) {
                        const id = env.DELTA_FEED.idFromName('main');
                        const stub = env.DELTA_FEED.get(id);
                        const resp = await stub.fetch('http://do/health');
                        return new Response(resp.body, { headers: { 'Content-Type': 'application/json' } });
                    }
                } catch (e) {
                    console.error('Delta feed fetch error:', e.message);
                }
                return Response.json({
                    connected: false,
                    uptimeMin: 0,
                    messageCount: 0,
                    btc: { direction: 'flat', slope: 'flat', minutesOfData: 0 },
                    doge: { direction: 'flat', slope: 'flat', minutesOfData: 0 }
                });
            }

            if (url.pathname === '/api/market-data') {
                try {
                    const data = await fetchAllMarketData();
                    const indicators = computeIndicators(data, { PAIR: 'B-ETH_USDT' });
                    return Response.json({
                        indicators,
                        timestamp: new Date().toISOString(),
                    });
                } catch (err) {
                    return Response.json({ error: err.message }, { status: 500 });
                }
            }

            return Response.json({ error: 'Not found' }, { status: 404 });
        }

        // Dashboard (static assets) — no auth on HTML, auth is done client-side
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
