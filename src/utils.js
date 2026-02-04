import { GoogleGenerativeAI } from "@google/generative-ai";
import { getOrders, getTradeHistory, getOpenPositions } from "./coindcx.js";

export async function callGemini(env, promptParts, modelName = "gemini-3-flash-preview") {
    const keys = [
        env.GEMINI_API_KEY,
        env.GEMINI_API_KEY_2,
        env.GEMINI_API_KEY_3,
        env.GEMINI_API_KEY_4,
        env.GEMINI_API_KEY_5
    ].filter(k => k);
    if (keys.length === 0) throw new Error("No GEMINI_API_KEY found");

    // Randomize keys order to distribute load
    for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
    }

    let lastError;
    for (const key of keys) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ model: modelName });
            console.log(`Calling Gemini with key ending in ...${key.slice(-4)}`);
            const result = await model.generateContent(promptParts);
            return result;
        } catch (e) {
            console.error(`Gemini call failed with key ...${key.slice(-4)}:`, e.message);
            if (e.message.includes("429") || e.status === 429 || e.message.includes("Quota exceeded")) {
                console.log("Rate limit hit, trying next key if available...");
                lastError = e;
                continue;
            }
            throw e;
        }
    }
    throw lastError;
}

export function logDelta(value) {
    if (value > 0) return `+${value.toFixed(2)}`;
    return value.toFixed(2);
}

export async function logTradeToDB(env, data) {
    if (!env.DB) {
        console.error("❌ Cannot log trade: DB binding not found");
        return;
    }

    try {
        console.log("📝 Preparing to log trade:", {
            decision: data.decision,
            orderId: data.orderId,
            status: data.status,
            quantity: data.quantity
        });

        const result = await env.DB.prepare(`
      INSERT INTO trade_logs (
        timestamp, decision, reason, asset, price, quantity, 
        leverage, stop_loss, take_profit, raw_response, status, order_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
            Date.now(),
            data.decision,
            data.reason,
            "B-DOGE_USDT",
            data.entry || 0,
            data.quantity || 0,
            data.leverage || 0,
            data.stopLoss || 0,
            data.takeProfit || 0,
            data.rawResponse || "",
            data.status,
            data.orderId || null
        ).run();

        console.log("✅ Successfully logged to D1:", {
            decision: data.decision,
            orderId: data.orderId,
            insertResult: result
        });
    } catch (e) {
        console.error("❌ D1 Log Error:", e);
        console.error("❌ Failed data:", {
            decision: data.decision,
            orderId: data.orderId,
            status: data.status
        });
        // Re-throw to ensure visibility
        throw e;
    }
}

export async function getLatestStrategy(env) {
    if (!env.DB) return null;
    try {
        const { results } = await env.DB.prepare("SELECT strategy_text FROM strategy_config ORDER BY version DESC LIMIT 1").all();
        return results.length > 0 ? results[0].strategy_text : null;
    } catch (e) {
        console.error("Error fetching strategy:", e);
        return null;
    }
}

export async function checkTradeStatus(env) {
    if (!env.DB) return [];
    const closedTradeIds = [];
    try {
        // Get all OPEN or FILLED trades from DB (both need exit detection)
        const { results: activeTrades } = await env.DB.prepare(
            "SELECT * FROM trade_logs WHERE (status = 'OPEN' OR status = 'FILLED') AND parent_trade_id IS NULL AND order_id IS NOT NULL"
        ).all();

        console.log(`📊 [Status Check] Found ${activeTrades.length} active trades in DB.`);

        if (activeTrades.length === 0) {
            // Signal to stop the scheduler if no active trades
            console.log(">>> STOP_SCHEDULER <<<");
            console.log("🛑 [Status Check] No active trades. Emitted STOP signal.");
            return [];
        }

        console.log(`🔍 Checking status for ${activeTrades.length} active trade(s)...`);

        // Fetch latest orders and trade history (fills) from CoinDCX
        const [ordersData, tradesData] = await Promise.all([
            getOrders(env),
            getTradeHistory(env)
        ]);

        const orders = Array.isArray(ordersData) ? ordersData : (ordersData.orders || []);
        const fills = Array.isArray(tradesData) ? tradesData : (tradesData.trades || []);

        // Aggregate fills by order_id to handle partial fills
        const aggregatedFills = [];
        const fillsByOrderId = {};

        for (const fill of fills) {
            const orderId = fill.order_id || fill.id;
            if (!orderId) continue;
            if (!fillsByOrderId[orderId]) {
                let asset = fill.symbol || fill.market || fill.pair || 'B-DOGE_USDT';
                if (asset.includes('DOGE') && !asset.startsWith('B-')) {
                    asset = 'B-' + asset;
                }

                fillsByOrderId[orderId] = {
                    order_id: orderId,
                    symbol: asset,
                    side: fill.side ? fill.side.toLowerCase() : '',
                    timestamp: fill.timestamp,
                    quantity: 0,
                    weightedPriceSum: 0
                };
            }
            const qty = parseFloat(fill.quantity || fill.size || 0);
            const price = parseFloat(fill.price || 0);
            fillsByOrderId[orderId].quantity += qty;
            fillsByOrderId[orderId].weightedPriceSum += (qty * price);
            // Keep the latest timestamp for the order
            if (fill.timestamp > fillsByOrderId[orderId].timestamp) {
                fillsByOrderId[orderId].timestamp = fill.timestamp;
            }
        }

        for (const id in fillsByOrderId) {
            const f = fillsByOrderId[id];
            aggregatedFills.push({
                ...f,
                price: f.weightedPriceSum / f.quantity
            });
        }

        console.log(`📊 Aggregated into ${aggregatedFills.length} unique orders from fills.`);

        for (const trade of activeTrades) {
            console.log(`\n🔎 Checking trade ${trade.id} (${trade.decision} ${trade.asset})`);

            let newStatus = trade.status;
            let exitPrice = trade.exit_price;
            let pnl = trade.pnl;
            let exitTradeFound = null;

            // Step 2: Look for EXIT trades (opposite side)
            const exitSide = trade.decision === 'BUY' ? 'sell' : 'buy';
            const matchingExit = aggregatedFills.find(fill => {
                const fillSymbol = fill.symbol || '';
                const symbolMatch = fillSymbol === trade.asset ||
                    fillSymbol === trade.asset.replace('B-', '') ||
                    trade.asset === fillSymbol.replace('B-', '');

                const sideMatch = fill.side === exitSide;
                const timeMatch = fill.timestamp > trade.timestamp;
                const qtyMatch = Math.abs(fill.quantity - Math.abs(trade.quantity)) < Math.max(2, Math.abs(trade.quantity) * 0.1);

                return symbolMatch && sideMatch && timeMatch && qtyMatch;
            });

            if (matchingExit) {
                console.log(`    ✅ Found matching exit trade on exchange: ${matchingExit.order_id}`);
                newStatus = 'CLOSED';
                exitPrice = matchingExit.price;
                pnl = trade.decision === 'BUY'
                    ? (exitPrice - trade.price) * Math.abs(trade.quantity)
                    : (trade.price - exitPrice) * Math.abs(trade.quantity);
                exitTradeFound = matchingExit;
            } else {
                console.log(`    ⏳ No matching exit trade found yet. (Looking for ${exitSide} of ~${Math.abs(trade.quantity)} ${trade.asset})`);
            }

            // Update the parent record if anything changed
            if (newStatus !== trade.status || exitPrice !== trade.exit_price) {
                const closedAt = exitTradeFound ? exitTradeFound.timestamp : null;
                await env.DB.prepare(
                    "UPDATE trade_logs SET status = ?, exit_price = ?, pnl = ?, closed_at = ? WHERE id = ?"
                ).bind(newStatus, exitPrice, pnl, closedAt, trade.id).run();

                if (newStatus === 'CLOSED') {
                    closedTradeIds.push(trade.id);
                    const closedTimeStr = closedAt ? new Date(closedAt).toLocaleString() : 'unknown';
                    console.log(`  ✅ Trade #${trade.id} marked as CLOSED at ${closedTimeStr}. PnL: ${pnl.toFixed(2)}`);
                }
            }
        }

        // Final check: If all active trades were just closed, signal to stop the scheduler
        const { results: remainingTrades } = await env.DB.prepare(
            "SELECT id FROM trade_logs WHERE (status = 'OPEN' OR status = 'FILLED') AND parent_trade_id IS NULL AND order_id IS NOT NULL"
        ).all();

        if (remainingTrades.length === 0) {
            console.log(">>> STOP_SCHEDULER <<<");
        }

        return {
            closedTradeIds,
            activeTradesCount: remainingTrades.length
        };
    } catch (e) {
        console.error("❌ Error checking trade status:", e);
        return { closedTradeIds: [], activeTradesCount: 0 };
    }
}


export async function syncTradesFromExchange(env) {
    if (!env.DB || !env.COINDCX_API_KEY) return;

    try {
        console.log("🔄 Syncing trades from CoinDCX...");

        const tradesData = await getTradeHistory(env);
        const fills = Array.isArray(tradesData) ? tradesData : (tradesData.trades || []);

        if (fills.length === 0) {
            console.log("No trades found on exchange.");
            return { newTradesAdded: 0 };
        }

        const { results: existingTrades } = await env.DB.prepare(
            "SELECT order_id FROM trade_logs WHERE order_id IS NOT NULL"
        ).all();
        const existingOrderIds = new Set(existingTrades.map(t => t.order_id));

        const tradesByOrderId = {};
        for (const fill of fills) {
            const orderId = fill.order_id || fill.id;
            if (!orderId) continue;
            if (!tradesByOrderId[orderId]) tradesByOrderId[orderId] = [];
            tradesByOrderId[orderId].push(fill);
        }

        let newTradesAdded = 0;

        for (const [orderId, orderFills] of Object.entries(tradesByOrderId)) {
            if (existingOrderIds.has(orderId)) continue;

            const firstFill = orderFills[0];
            const decision = firstFill.side?.toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
            let asset = firstFill.symbol || firstFill.market || 'B-DOGE_USDT';

            // Ensure consistent asset naming (prefer B- prefix if it's DOGE)
            if (asset.includes('DOGE') && !asset.startsWith('B-')) {
                asset = 'B-' + asset;
            }

            // const timestamp = firstFill.timestamp || Date.now(); // Moved down

            let totalQty = 0;
            let weightedPriceSum = 0;
            let latestTimestamp = 0;
            for (const fill of orderFills) {
                const qty = parseFloat(fill.quantity || fill.size || 0);
                const price = parseFloat(fill.price || 0);
                totalQty += qty;
                weightedPriceSum += qty * price;
                if (fill.timestamp > latestTimestamp) latestTimestamp = fill.timestamp;
            }
            const avgPrice = weightedPriceSum / totalQty;
            const timestamp = latestTimestamp || firstFill.timestamp || Date.now();

            console.log(`\n🔎 Processing synced trade: ${decision} ${asset} x ${totalQty} @ ${avgPrice.toFixed(6)} (Order: ${orderId})`);

            // Step 1: Check if this order_id already exists in ANY status
            const { results: existingByOrderId } = await env.DB.prepare(
                "SELECT id FROM trade_logs WHERE order_id = ?"
            ).bind(orderId).all();

            if (existingByOrderId.length > 0) {
                console.log(`  ⏭️ Order ID ${orderId} already exists. Skipping.`);
                continue;
            }

            // Step 2: Check for same-side OPEN or FILLED trade to update
            // Priority A: Check for trade with SAME order_id (already done in Step 1)
            // Priority B: Check for trade with NULL order_id (orphaned bot trade)
            const { results: orphanTrade } = await env.DB.prepare(
                "SELECT * FROM trade_logs WHERE (asset = ? OR asset = ?) AND decision = ? AND (status = 'OPEN' OR status = 'FILLED') AND order_id IS NULL AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC LIMIT 1"
            ).bind(asset, asset.replace('B-', ''), decision, timestamp - 60000, timestamp + 60000).all();

            if (orphanTrade.length > 0) {
                const openTrade = orphanTrade[0];
                console.log(`  🏠 Matches existing ORPHAN trade #${openTrade.id} (No Order ID). Updating with Order ID ${orderId}.`);
                await env.DB.prepare(
                    "UPDATE trade_logs SET status = 'OPEN', order_id = ?, price = ?, quantity = ? WHERE id = ?"
                ).bind(orderId, avgPrice, totalQty, openTrade.id).run();
                newTradesAdded++;
                continue;
            }

            // Priority C: Check for trade with DIFFERENT order_id (legacy logic, maybe keep for safety but prioritize B)
            const { results: sameSideOpen } = await env.DB.prepare(
                "SELECT * FROM trade_logs WHERE (asset = ? OR asset = ?) AND decision = ? AND (status = 'OPEN' OR status = 'FILLED') AND timestamp < ? ORDER BY timestamp DESC LIMIT 1"
            ).bind(asset, asset.replace('B-', ''), decision, timestamp + 5000).all();

            if (sameSideOpen.length > 0) {
                const openTrade = sameSideOpen[0];
                // Only update if it doesn't already have a different order_id (unless we want to overwrite?)
                // Better to be safe: if it has an order_id, it might be a different trade.
                if (!openTrade.order_id) {
                    // This should have been caught by Priority B, but just in case
                    console.log(`  🏠 Matches existing OPEN trade #${openTrade.id}. Updating to OPEN.`);
                    await env.DB.prepare(
                        "UPDATE trade_logs SET status = 'OPEN', order_id = ?, price = ?, quantity = ? WHERE id = ?"
                    ).bind(orderId, avgPrice, totalQty, openTrade.id).run();
                    newTradesAdded++;
                    continue;
                }
            }

            // Step 3: Check for exit (opposite side)
            const exitSide = decision === 'BUY' ? 'SELL' : 'BUY';
            // Robust search: fetch last 5 potential parents (including CLOSED to avoid duplicates)
            const { results: potentialParents } = await env.DB.prepare(
                "SELECT * FROM trade_logs WHERE (asset = ? OR asset = ?) AND decision = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 5"
            ).bind(asset, asset.replace('B-', ''), exitSide, timestamp).all();

            if (potentialParents.length > 0) {
                console.log(`  🎯 Found ${potentialParents.length} potential parents. Checking for quantity match...`);

                let bestParent = null;
                let minDiff = Infinity;

                for (const parent of potentialParents) {
                    const qtyDiff = Math.abs(totalQty - Math.abs(parent.quantity));
                    const maxAllowedDiff = Math.max(2, Math.abs(parent.quantity) * 0.1);

                    console.log(`    - Checking Parent #${parent.id}: Qty ${Math.abs(parent.quantity)}, Diff ${qtyDiff.toFixed(2)} (Max Allowed: ${maxAllowedDiff.toFixed(2)})`);

                    if (qtyDiff <= maxAllowedDiff && qtyDiff < minDiff) {
                        minDiff = qtyDiff;
                        bestParent = parent;
                    }
                }

                if (bestParent) {
                    const parent = bestParent;

                    // If the parent is already CLOSED, check if this exit is already linked
                    if (parent.status === 'CLOSED') {
                        const { results: alreadyLinked } = await env.DB.prepare(
                            "SELECT id FROM trade_logs WHERE parent_trade_id = ? AND order_id = ?"
                        ).bind(parent.id, orderId).all();

                        if (alreadyLinked.length > 0) {
                            console.log(`  ⏭️ Exit trade already linked to Parent #${parent.id}. Skipping.`);
                            continue;
                        }
                    }

                    console.log(`  🔗 LINKED! Best match is Parent trade #${parent.id}.`);
                    let pnl = 0;
                    if (parent.decision === 'BUY') {
                        pnl = (avgPrice - parent.price) * totalQty;
                    } else {
                        pnl = (parent.price - avgPrice) * totalQty;
                    }

                    await env.DB.prepare(
                        "UPDATE trade_logs SET status = 'CLOSED', exit_price = ?, pnl = ?, closed_at = ? WHERE id = ?"
                    ).bind(avgPrice, pnl, timestamp, parent.id).run();

                    console.log(`  ✅ Synced exit updated Parent #${parent.id} (Closed at ${new Date(timestamp).toLocaleString()}). PnL: ${pnl.toFixed(2)}`);
                    // Single-row architecture: Do NOT insert a new record for the exit.
                    continue;
                }
            }

            // Otherwise, skip (Strict Sync: Do not create new trades from history)
            console.log(`  ⏭️ Trade ${orderId} does not match any existing OPEN trade. Skipping to prevent duplicates.`);
        }

        console.log(`✅ Sync complete: ${newTradesAdded} trades updated/linked.`);

        // If we found any active trades (even if not new, but just matched), we should ensure scheduler is running.
        // But syncTradesFromExchange doesn't return the total active count.
        // Let's just trigger START if we processed any trades, or maybe always trigger START on sync to be safe?
        // Better: Trigger START if we found potential parents or orphans.
        if (newTradesAdded > 0 || fills.length > 0) {
            console.log(">>> START_SCHEDULER <<<");
        }

        // Find trades that are CLOSED but missing analysis (close_reason is NULL)
        // This covers both newly closed trades and old ones that were missed.
        let closedTradeIds = [];
        try {
            const { results: unanalyzedTrades } = await env.DB.prepare(
                "SELECT id FROM trade_logs WHERE status = 'CLOSED' AND (close_reason IS NULL OR close_reason = '') ORDER BY timestamp DESC LIMIT 5"
            ).all();
            closedTradeIds = unanalyzedTrades.map(t => t.id);
        } catch (err) {
            console.warn("⚠️ Could not fetch unanalyzed trades (close_reason column might be missing):", err.message);
            // Ignore error and proceed, just won't trigger analysis this time
        }

        return { newTradesAdded, closedTradeIds };
    } catch (e) {
        console.error("❌ Error syncing trades:", e);
        throw e;
    }
}

export async function analyzePerformanceAndUpdateStrategy(env, customInput = "") {
    if (!env.DB || !env.GEMINI_API_KEY) return;

    try {
        console.log("📊 Analyzing new performance data...");

        // Fetch only unanalyzed trades. We still limit to last 7 days to keep context relevant, 
        // but the primary filter is is_analyzed = 0.
        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        const { results: logs } = await env.DB.prepare("SELECT * FROM trade_logs WHERE is_analyzed = 0 AND status != 'OPEN' AND timestamp > ? ORDER BY timestamp DESC").bind(sevenDaysAgo).all();

        if (logs.length === 0) {
            console.log("ℹ️ No new unanalyzed trades found for analysis.");
            return;
        }

        const totalTrades = logs.length;
        const buyTrades = logs.filter(l => l.decision === 'BUY').length;
        const sellTrades = logs.filter(l => l.decision === 'SELL').length;
        const holdTrades = logs.filter(l => l.decision === 'HOLD').length;
        const filledTrades = logs.filter(l => l.status === 'FILLED').length;
        const closedTrades = logs.filter(l => l.status === 'CLOSED').length;
        const rejectedTrades = logs.filter(l => l.status === 'REJECTED').length;
        const cancelledTrades = logs.filter(l => l.status === 'CANCELLED').length;

        const tradesWithPnL = logs.filter(l => l.pnl !== null && l.pnl !== undefined);
        const winningTrades = tradesWithPnL.filter(l => l.pnl > 0).length;
        const losingTrades = tradesWithPnL.filter(l => l.pnl < 0).length;
        const totalPnL = tradesWithPnL.reduce((sum, l) => sum + parseFloat(l.pnl || 0), 0);
        const avgPnL = tradesWithPnL.length > 0 ? (totalPnL / tradesWithPnL.length).toFixed(2) : 0;
        const winRate = tradesWithPnL.length > 0 ? ((winningTrades / tradesWithPnL.length) * 100).toFixed(2) : 0;

        const recentLogs = logs.slice(0, 20);
        const tradeRelationships = [];
        for (const log of logs) {
            if (log.parent_trade_id) {
                const parent = logs.find(l => l.id === log.parent_trade_id);
                if (parent) {
                    tradeRelationships.push({
                        entry: parent,
                        exit: log,
                        pnl: log.pnl,
                        outcome: log.pnl >= 0 ? 'WIN' : 'LOSS'
                    });
                }
            }
        }

        const currentStrategy = await getLatestStrategy(env);
        // const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
        // const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
        // console.log("model loaded");

        const analysisPrompt = `
You are an expert trading strategist. Your task is to analyze the performance of a trading bot over the last 7 days and suggest improvements to its strategy.

**PERFORMANCE SUMMARY (Last 7 Days):**
- Total Decisions: ${totalTrades}
- BUY: ${buyTrades}
- SELL: ${sellTrades}
- HOLD: ${holdTrades}
- FILLED: ${filledTrades}
- CLOSED: ${closedTrades}
- REJECTED: ${rejectedTrades}
- CANCELLED: ${cancelledTrades}
- **Trades with Exit Data: ${tradesWithPnL.length}**
- **Total PnL: ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}**
- **Average PnL: ${avgPnL}**
- **Win Rate: ${winRate}% (${winningTrades} wins / ${losingTrades} losses)**

**CURRENT STRATEGY:**
${currentStrategy}

Analyze the following trade logs and suggest improvements to the strategy.
**DETAILED TRADE LOGS (Most Recent 20):**
${JSON.stringify(recentLogs.filter(l => l.is_analyzed === 0 && l.decision != 'HOLD').map(l => ({
            time: new Date(l.timestamp).toLocaleString(),
            decision: l.decision,
            asset: l.asset,
            price: l.price,
            exit_price: l.exit_price,
            qty: l.quantity,
            pnl: l.pnl,
            reason: l.reason,
            close_reason: l.close_reason,
            status: l.status,
            sl: l.stop_loss,
            tp: l.take_profit
        })), null, 2)}

**INSTRUCTIONS:**
1. Analyze the performance summary and the detailed logs.
2. Identify patterns where the strategy succeeded or failed (e.g., too many rejections, wrong timing, correlation issues).
3. Pay close attention to the "Reason" and "close_reason" fields to understand entry and exit logic and find out where each trade lost and what won.
4. Update the strategy to address the weaknesses identified without conflicting the win reasons.
5. You can add more points if they are cruicial.
6. **CRITICAL**: Ensure the strategy remains actionable for an AI that analyzes screenshots.
7. Output ONLY the updated strategy in markdown format. Do not include any other text or explanations outside the markdown.
8. Do not include any avoid-trade-time in the strategy.
9. **CRITICAL**: The "important" section about the output format(JSON body and related info) from the current strategy should be exactly the same in the updated strategy.
${customInput ? `
**ADDITIONAL USER INSTRUCTIONS:**
${customInput}
` : ''}
**IMPORTANT:**
***Only update the necessary changes. Do not change the structure or rewrite the full strategy. If any changes are required, only update the necessary parts.***
`;
        console.log("analysisPrompt", analysisPrompt);

        const result = await callGemini(env, analysisPrompt);
        const response = await result.response;
        const newStrategyText = response.text();

        if (newStrategyText && newStrategyText.length > 100) {
            await env.DB.prepare("INSERT INTO strategy_config (strategy_text, version) SELECT ?, MAX(version) + 1 FROM strategy_config")
                .bind(newStrategyText)
                .run();

            // Mark these trades as analyzed so they aren't used again
            const logIds = logs.map(l => l.id);
            if (logIds.length > 0) {
                // SQLite doesn't support arrays in IN clause easily with bind, so we build the query
                const placeholders = logIds.map(() => "?").join(",");
                await env.DB.prepare(`UPDATE trade_logs SET is_analyzed = 1 WHERE id IN (${placeholders})`)
                    .bind(...logIds)
                    .run();
                console.log(`✅ Marked ${logIds.length} trades as analyzed.`);
            }
        }
        console.log('new strategy inserted.');
    } catch (e) {
        console.error("Error in performance analysis:", e);
    }
}

export async function repairTradeLogs(env) {
    if (!env.DB) return { error: "DB not bound" };

    try {
        console.log("🛠️ Starting trade log repair...");
        let repairedCount = 0;

        // 1. Deduplicate by order_id
        console.log("🧹 Step 1: Deduplicating by order_id...");
        const { results: duplicates } = await env.DB.prepare(`
            SELECT order_id, COUNT(*) as count 
            FROM trade_logs 
            WHERE order_id IS NOT NULL AND order_id != ''
            GROUP BY order_id 
            HAVING count > 1
        `).all();

        for (const dup of duplicates) {
            const { results: entries } = await env.DB.prepare(
                "SELECT id, status, pnl, exit_price FROM trade_logs WHERE order_id = ? ORDER BY pnl DESC, exit_price DESC"
            ).bind(dup.order_id).all();

            // Keep the first one (best one), delete the rest
            const keepId = entries[0].id;
            for (let i = 1; i < entries.length; i++) {
                console.log(`  🗑️ Deleting duplicate trade #${entries[i].id} (Order ID: ${dup.order_id})`);
                await env.DB.prepare("DELETE FROM trade_logs WHERE id = ?").bind(entries[i].id).run();
                repairedCount++;
            }
        }

        // 2. Fix FILLED entries that should be OPEN or CLOSED
        console.log("🔧 Step 2: Fixing FILLED entries...");
        const { results: filledEntries } = await env.DB.prepare(
            "SELECT * FROM trade_logs WHERE status = 'FILLED' AND parent_trade_id IS NULL"
        ).all();

        for (const trade of filledEntries) {
            // Check if this trade has any children (exits)
            const { results: children } = await env.DB.prepare(
                "SELECT id FROM trade_logs WHERE parent_trade_id = ?"
            ).bind(trade.id).all();

            if (children.length > 0) {
                console.log(`  ✅ Trade #${trade.id} has children. Marking as CLOSED.`);
                await env.DB.prepare("UPDATE trade_logs SET status = 'CLOSED' WHERE id = ?").bind(trade.id).run();
                repairedCount++;
            } else {
                // No children. Is there a potential exit trade that isn't linked?
                const exitSide = trade.decision === 'BUY' ? 'SELL' : 'BUY';
                const { results: potentialExits } = await env.DB.prepare(
                    "SELECT * FROM trade_logs WHERE (asset = ? OR asset = ?) AND decision = ? AND timestamp > ? AND parent_trade_id IS NULL ORDER BY timestamp ASC LIMIT 1"
                ).bind(trade.asset, trade.asset.replace('B-', ''), exitSide, trade.timestamp).all();

                if (potentialExits.length > 0) {
                    const exit = potentialExits[0];
                    console.log(`  🔗 Linking entry #${trade.id} to exit #${exit.id}.`);

                    const pnl = trade.decision === 'BUY'
                        ? (exit.price - trade.price) * Math.abs(trade.quantity)
                        : (trade.price - exit.price) * Math.abs(trade.quantity);

                    await env.DB.prepare(
                        "UPDATE trade_logs SET status = 'CLOSED', exit_price = ?, pnl = ? WHERE id = ?"
                    ).bind(exit.price, pnl, trade.id).run();

                    await env.DB.prepare(
                        "UPDATE trade_logs SET status = 'CLOSED', parent_trade_id = ?, exit_price = ?, pnl = ?, reason = ? WHERE id = ?"
                    ).bind(trade.id, exit.price, pnl, `Exit - ${pnl >= 0 ? 'WIN' : 'LOSS'} (Repaired)`, exit.id).run();

                    repairedCount++;
                } else {
                    // No exit found. If it's older than 2 hours, it's probably a missed exit or sync error.
                    // But let's just mark it as OPEN so the status checker can try to find its exit.
                    console.log(`  🕒 Trade #${trade.id} has no exit. Marking as OPEN.`);
                    await env.DB.prepare("UPDATE trade_logs SET status = 'OPEN' WHERE id = ?").bind(trade.id).run();
                    repairedCount++;
                }
            }
        }

        console.log(`✅ Repair complete: ${repairedCount} actions taken.`);
        return { repairedCount };

    } catch (e) {
        console.error("❌ Error repairing trades:", e);
        throw e;
    }
}
