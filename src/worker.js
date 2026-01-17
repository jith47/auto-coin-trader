import { GrokStrategyEngine } from "../api/grok_strategy_engine.js";
import { D1Database } from "./db_d1.js";
import { placeOrder, getOpenPositions } from "./coindcx.js";

let engine = null;
let db = null;

// Shared initialization function
async function init(env) {
    if (!db) {
        db = new D1Database(env.DB);
        await db.init();
    }

    if (!engine) {
        engine = new GrokStrategyEngine();

        engine.onSignal = async (signal) => {
            console.log(`[Worker] Signal: ${signal.decision} ${signal.entry}`);

            // Log to DB
            const dbResult = await db.logTrade(signal);
            const dbId = dbResult.meta.last_row_id;

            // Execute Trade (if live)
            if (env.COINDCX_API_KEY) {
                try {
                    if (signal.isExit) {
                        console.log(`[Worker] Handling EXIT signal: ${signal.reason}`);
                        const positions = await getOpenPositions(env);
                        const dogePos = positions.find(p => p.pair === "B-DOGE_USDT");

                        if (dogePos && parseFloat(dogePos.quantity) !== 0) {
                            const qty = Math.abs(parseFloat(dogePos.quantity));
                            console.log(`[Worker] Closing position: ${qty} DOGE`);
                            const result = await placeOrder(
                                env,
                                "B-DOGE_USDT",
                                signal.decision,
                                qty,
                                dogePos.leverage,
                                0,
                                0,
                                "MARKET"
                            );
                            console.log("[Worker] Exit Order Result:", JSON.stringify(result, null, 2));

                            // Update DB
                            if (result.orders && result.orders[0]) {
                                const activeTrade = await db.getActiveTrade();
                                if (activeTrade) {
                                    const entryPrice = parseFloat(activeTrade.price);
                                    const exitPrice = parseFloat(signal.price);
                                    let pnl = 0;
                                    if (activeTrade.decision === "BUY") {
                                        pnl = ((exitPrice - entryPrice) / entryPrice) * 100;
                                    } else {
                                        pnl = ((entryPrice - exitPrice) / entryPrice) * 100;
                                    }
                                    await db.updateTradeStatus(activeTrade.order_id, "CLOSED", exitPrice, pnl, signal.reason);
                                }
                            }
                        }
                    } else {
                        console.log("[Worker] Placing entry order...");
                        const result = await placeOrder(
                            env,
                            "B-DOGE_USDT",
                            signal.decision,
                            signal.quantity,
                            signal.leverage,
                            signal.stopLoss,
                            signal.takeProfit,
                            signal.orderType,
                            signal.entry
                        );
                        console.log("[Worker] Entry Order Result:", JSON.stringify(result, null, 2));

                        if (result.orders && result.orders[0]) {
                            const orderId = result.orders[0].id;
                            const stmt = env.DB.prepare("UPDATE trade_logs SET order_id = ? WHERE rowid = ?");
                            await stmt.bind(orderId, dbId).run();
                        }
                    }
                } catch (e) {
                    console.error("[Worker] Error handling signal:", e.message);
                }
            }
        };
    }
    return engine;
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        await init(env);

        // Start engine if not started
        ctx.waitUntil(engine.start());

        // API Routes
        if (url.pathname === "/api/status") {
            const activeTrade = await db.getActiveTrade();
            const stats = await db.getStats();
            return Response.json({
                engine: {
                    state: engine.activeTrade ? "IN_TRADE" : "SCANNING",
                    tradesToday: engine.tradesTakenToday,
                    lastStatus: engine.lastStatusLog,
                    currentStatus: engine.currentStatus
                },
                activeTrade: activeTrade,
                stats: stats
            });
        }

        if (url.pathname === "/api/trades") {
            const trades = await db.getRecentTrades(50);
            return Response.json(trades);
        }

        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response("Not Found", { status: 404 });
    },

    async scheduled(event, env, ctx) {
        console.log("[Worker] Cron Triggered. Initializing...");
        await init(env);

        console.log("[Worker] Starting Engine...");
        await engine.start();

        // Keep alive for 55 seconds to maximize coverage
        console.log("[Worker] Keeping alive for 55s...");
        await new Promise(resolve => setTimeout(resolve, 55000));
        console.log("[Worker] Cron execution finished.");
    }
};
