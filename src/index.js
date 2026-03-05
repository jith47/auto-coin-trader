/**
 * Micro-Scalper Entry Point
 * Wires together: CandleEngine → PatternDetector → TradeManager → UI Server
 */
import { CandleEngine } from './candle-engine.js';
import { detectPatterns } from './pattern-detector.js';
import { TradeManager } from './trade-manager.js';
import { createAppServer } from './server.js';
import { PatternHistory } from './pattern-history.js';

const PORT = process.env.PORT || 3456;
const SYMBOL = process.env.SYMBOL || 'dogeusdt';

async function main() {
    console.log('╔═══════════════════════════════════════╗');
    console.log('║    MICRO-SCALPER — Pure Candle Bot     ║');
    console.log('║    No indicators. Just candles.        ║');
    console.log('╚═══════════════════════════════════════╝');
    console.log(`Symbol: ${SYMBOL.toUpperCase()} | Port: ${PORT}`);
    console.log('');

    // Initialize components
    const { broadcast, start: startServer, stop: stopServer } = createAppServer(PORT, (send) => {
        // Send initial state to newly connected client
        send('init', {
            stats: tradeManager.getStats(),
            recentTrades: tradeManager.getRecentTrades(),
            recentPatterns: patternHistory.getRecent(),
            candles: engine.candles.slice(-60),
            currentCandle: engine.currentCandle,
        });
    });
    const engine = new CandleEngine(SYMBOL);
    const tradeManager = new TradeManager({
        initialBalance: 1000,
        positionSizePct: 0.02,
        leverage: 10,
        slPercent: 0.15,
        tpPercent: 0.20,
        maxDailyLosses: 5,
        cooldownCandles: 3,
    });

    // Track patterns for UI
    const patternHistory = new PatternHistory(100);

    // --- Event: Candle closed (decision time) ---
    engine.on('candle_closed', ({ candle, candles, high24h, low24h }) => {
        // Increment cooldown counter
        tradeManager.onCandleClosed();

        // Check if open position was hit by this candle
        const closedTrade = tradeManager.checkPosition(candle.close, candle.high, candle.low);
        if (closedTrade) {
            broadcast('trade_closed', closedTrade);
        }

        // Detect patterns
        const patterns = detectPatterns(candles);

        broadcast('analysis', {
            lastTime: Date.now(),
            candlesAnalyzed: candles.length,
            patternsFound: patterns.length,
            message: patterns.length > 0 ? `Detected ${patterns.length} patterns` : "Zero patterns found"
        });

        if (patterns.length > 0) {
            for (const pattern of patterns) {
                pattern.time = candle.time;
                pattern.timeStr = new Date(candle.time).toISOString();
                patternHistory.add(pattern);

                console.log(`[Pattern] ${pattern.type} → ${pattern.direction} @ ${pattern.price.toFixed(6)} (${pattern.confidence})`);
            }
            broadcast('patterns', patterns);

            // Try to take the highest confidence pattern
            const canTradeResult = tradeManager.canTrade();
            if (canTradeResult.ok) {
                // Prioritize high confidence, then by position in array
                const bestPattern = patterns.find(p => p.confidence === 'high') || patterns[0];
                const result = tradeManager.openTrade(bestPattern.direction, candle.close, bestPattern);
                if (result.success) {
                    broadcast('trade_opened', result.trade);
                }
            }
        }

        // Broadcast status update
        broadcast('status', tradeManager.getStats());

        // Broadcast closed candle with chart data
        broadcast('candle_closed', {
            candle,
            candles: candles.slice(-60), // Last 60 for chart
            high24h,
            low24h,
            position: tradeManager.position,
        });
    });

    // --- Event: Candle update (live tick) ---
    engine.on('candle_update', ({ candle, candles, high24h, low24h }) => {
        // Check if open position was hit by current price movement
        const closedTrade = tradeManager.checkPosition(candle.close, candle.high, candle.low);
        if (closedTrade) {
            broadcast('trade_closed', closedTrade);
            broadcast('status', tradeManager.getStats());
        }

        // Broadcast live candle update to UI
        broadcast('candle_update', {
            candle,
            high24h,
            low24h,
            position: tradeManager.position,
            currentPrice: candle.close,
            nextCandleIn: Math.max(0, Math.floor((candle.closeTime - Date.now()) / 1000))
        });
    });

    // --- Event: Connected to Binance ---
    engine.on('connected', () => {
        broadcast('status', tradeManager.getStats());
        broadcast('info', { message: 'Connected to Binance WebSocket' });
    });

    // Start everything
    await startServer();
    await engine.start();

    // Graceful shutdown
    const shutdown = async () => {
        console.log('\n[Main] Shutting down...');
        engine.stop();
        await stopServer();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('[Main] Fatal error:', err);
    process.exit(1);
});
