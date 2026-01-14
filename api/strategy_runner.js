import { GrokStrategyEngine } from "./grok_strategy_engine.js";
import { placeOrder, getOpenPositions } from "../src/coindcx.js";
import { db } from "./db.js";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";

// 1. Load Environment
const env = {
    COINDCX_API_KEY: process.env.COINDCX_API_KEY,
    COINDCX_SECRET_KEY: process.env.COINDCX_SECRET_KEY,
};

if (!env.COINDCX_API_KEY || !env.COINDCX_SECRET_KEY) {
    try {
        const devVarsPath = path.join(process.cwd(), ".dev.vars");
        if (fs.existsSync(devVarsPath)) {
            const content = fs.readFileSync(devVarsPath, "utf8");
            content.split("\n").forEach((line) => {
                const [key, value] = line.split("=");
                if (key && value) {
                    const cleanKey = key.trim();
                    const cleanValue = value.trim().replace(/^["']|["']$/g, "");
                    if (cleanKey === "COINDCX_API_KEY") env.COINDCX_API_KEY = cleanValue;
                    if (cleanKey === "COINDCX_SECRET_KEY") env.COINDCX_SECRET_KEY = cleanValue;
                }
            });
            console.log("[Runner] Loaded API keys from .dev.vars");
        }
    } catch (e) {
        console.log("[Runner] Could not read .dev.vars, using process.env");
    }
}

// 2. Initialize Engine
const engine = new GrokStrategyEngine();
const isLive = process.argv.includes("--live");

console.log(`[Runner] Mode: ${isLive ? "LIVE (Trading Enabled)" : "MONITOR (Signals Only)"}`);

// 3. Status Checker Loop
let statusInterval = null;

async function checkStatus() {
    if (!isLive) return;

    try {
        const activeTrade = db.getActiveTrade();
        if (!activeTrade || !activeTrade.order_id) {
            stopStatusChecker();
            return;
        }

        const positions = await getOpenPositions(env);
        const dogePos = positions.find(p => p.pair === "B-DOGE_USDT");

        // If trade is in DB but not on exchange, it was closed (SL/TP hit)
        if (!dogePos || parseFloat(dogePos.quantity) === 0) {
            console.log(`[Status] Active trade ${activeTrade.order_id} no longer found on exchange. Marking as CLOSED.`);

            db.updateTradeStatus(activeTrade.order_id, "CLOSED", null, null, "EXCHANGE_CLOSED (SL/TP/MANUAL)");

            // Reset engine
            engine.activeTrade = null;
            stopStatusChecker();
        }
    } catch (e) {
        console.error("[Status] Error checking status:", e.message);
    }
}

function startStatusChecker() {
    if (statusInterval) return;
    console.log("[Status] Starting trade status checker...");
    statusInterval = setInterval(checkStatus, 30000);
}

function stopStatusChecker() {
    if (!statusInterval) return;
    console.log("[Status] Stopping trade status checker.");
    clearInterval(statusInterval);
    statusInterval = null;
}

// Restore active trade from DB on startup
const activeTrade = db.getActiveTrade();
if (activeTrade) {
    console.log(`[Runner] Restoring active trade from DB: ${activeTrade.decision} ${activeTrade.asset}`);
    engine.activeTrade = {
        side: activeTrade.decision,
        entry: activeTrade.price,
        quantity: activeTrade.quantity,
        sl: activeTrade.stop_loss,
        tp1: activeTrade.take_profit, // Simplified
        tp2: activeTrade.take_profit,
        startTime: activeTrade.timestamp,
        beMoved: false,
        tp1Hit: false,
        orderId: activeTrade.order_id
    };
    startStatusChecker();
}

engine.onSignal = async (signal) => {
    console.log("\n----------------------------------------");
    console.log(`[SIGNAL] ${signal.decision} DOGE at ${signal.entry}`);
    console.log(`Reason: ${signal.reason}`);
    console.log("----------------------------------------\n");

    // Log to DB
    const dbResult = db.logTrade(signal);
    const dbId = dbResult.lastInsertRowid;

    if (isLive) {
        try {
            if (signal.isExit) {
                console.log(`[Runner] Handling EXIT signal: ${signal.reason}`);
                const positions = await getOpenPositions(env);
                const dogePos = positions.find(p => p.pair === "B-DOGE_USDT");

                if (dogePos && parseFloat(dogePos.quantity) !== 0) {
                    const qty = Math.abs(parseFloat(dogePos.quantity));
                    console.log(`[Runner] Closing position: ${qty} DOGE`);
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
                    console.log("[Runner] Exit Order Result:", JSON.stringify(result, null, 2));

                    // Update DB
                    if (result.orders && result.orders[0]) {
                        db.updateTradeStatus(engine.activeTrade.orderId, "CLOSED", signal.price, null, signal.reason);
                        stopStatusChecker();
                    }
                } else {
                    console.log("[Runner] No active DOGE position found to close.");
                    stopStatusChecker();
                }
            } else {
                console.log("[Runner] Placing entry order on CoinDCX...");
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
                console.log("[Runner] Entry Order Result:", JSON.stringify(result, null, 2));

                // Update DB with order ID
                if (result.orders && result.orders[0]) {
                    const orderId = result.orders[0].id;
                    db.db.prepare("UPDATE trade_logs SET order_id = ? WHERE id = ?").run(orderId, dbId);
                    startStatusChecker();
                }
            }
        } catch (e) {
            console.error("[Runner] Error handling signal:", e.message);
        }
    }
};


import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 4. Dashboard Server
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "../public")));

app.get("/api/status", (req, res) => {
    res.json({
        engine: {
            state: engine.activeTrade ? "IN_TRADE" : "SCANNING",
            tradesToday: engine.tradesTakenToday,
            lastStatus: engine.lastStatusLog,
            currentStatus: engine.currentStatus
        },
        activeTrade: engine.activeTrade
    });
});

app.get("/api/trades", (req, res) => {
    const trades = db.getRecentTrades(50);
    res.json(trades);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Dashboard] Server running at http://localhost:${PORT}`);
});

// 5. Start Engine
engine.start().catch((err) => {
    console.error("[Runner] Failed to start engine:", err);
});

// Handle graceful shutdown
process.on("SIGINT", () => {
    console.log("\n[Runner] Shutting down...");
    process.exit(0);
});

