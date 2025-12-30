import { GoogleGenerativeAI } from "@google/generative-ai";
import { getOrders, getTradeHistory, getOpenPositions } from "./coindcx.js";

export const TRADE_INSTRUCTIONS = `# Improved BTC-DOGE Correlation Scalp Strategy v2.0

## Key Improvements Made:

---

## 1. ENHANCED CORRELATION FRAMEWORK

### Dynamic Correlation Check (Not Static 0.85)
\`\`\`
CORRELATION STATES:
├── HIGH (>0.90): BTC crash/pump → DOGE amplifies 2-3x → TRADE
├── MEDIUM (0.75-0.90): Normal trending → DOGE follows 1.5x → TRADE  
├── LOW (<0.75): Consolidation/DOGE-specific news → AVOID
└── NEGATIVE (<0): Divergence → REVERSAL SIGNAL (advanced)
\`\`\`

**Real-Time Check**: TradingView → Add indicator "Correlation Coefficient" → DOGEUSDT vs BTCUSDT → 60-period on 1m

---

## 2. REFINED MULTI-TIMEFRAME MATRIX

| Timeframe | BTC Analysis | Weight | Specific Criteria |
|-----------|-------------|--------|-------------------|
| **1D** | Trend Filter | 40% | Price vs 21 EMA + 50 EMA slope direction |
| **4H** | Structure | 25% | Last swing high/low + current OB location |
| **1H** | Momentum | 25% | Delta direction + CVD slope + RSI zone |
| **1M** | Trigger | 10% | Entry timing only (after higher TFs align) |

### Bias Decision Tree:
\`\`\`
IF BTC 1D > 21 EMA AND 50 EMA slope UP:
    └── Bull Bias Active
    
IF BTC 1H Delta > +300K (rolling 10-candle sum):
    └── Momentum Confirmed
    
IF BTC 1M sweeps low + reclaims:
    └── DOGE LONG TRIGGER
\`\`\`

---

## 3. PRECISE ENTRY TRIGGERS (Not Vague)

### Long Scalp Entry Checklist:
\`\`\`
□ BTC 1D: Price > 21 EMA (confirmed by 2+ daily closes)
□ BTC 4H: Higher low formed within last 8 candles
□ BTC 1H: 
   - Delta sum (10 candles) > +300K
   - CVD making higher highs
   - RSI 40-65 zone (momentum room)
□ BTC 1M:
   - Liquidity sweep below recent low (5-15 candles)
   - Immediate reclaim (within 2-3 candles)
   - Volume spike > 2x 20-period SMA
□ DOGE 1M:
   - Correlation > 0.80 (60-period)
   - DOGE has NOT yet moved (lag opportunity)
   - Enter on first green candle close after BTC reclaim
\`\`\`

### Short Scalp Entry Checklist:
\`\`\`
□ BTC 1D: Price < 21 EMA (confirmed by 2+ daily closes)
□ BTC 4H: Lower high formed within last 8 candles  
□ BTC 1H:
   - Delta sum (10 candles) < -300K
   - CVD making lower lows
   - RSI 35-60 zone
□ BTC 1M:
   - Liquidity sweep above recent high
   - Immediate rejection (within 2-3 candles)
   - Red volume spike > 2x 20-period SMA
□ DOGE 1M:
   - Correlation > 0.80
   - Enter on first red candle close after BTC rejection
\`\`\`

---

## 4. SESSION TIMING FILTER

\`\`\`
OPTIMAL WINDOWS (UTC):
├── 13:00-17:00: EU-US Overlap ⭐⭐⭐ (BEST - 70% of setups)
├── 08:00-11:00: EU Open ⭐⭐ (Good momentum)
└── 14:00-15:00: NYSE Open ⭐⭐⭐ (Highest volatility)

AVOID:
├── 21:00-01:00 UTC: Low liquidity
├── 04:00-07:00 UTC: Asia session (DOGE correlation drops)
└── First/Last 30 min of any session (noise)
\`\`\`

---

## 5. EXIT STRATEGY (The "Profit Guard")

### Take Profit (TP):
- **TP1**: 0.5% - 0.7% (Close 50% of position)
- **TP2**: 1.2% - 1.5% (Close remaining 50%)
- **Dynamic TP**: If BTC delta flips from +500K to -100K, exit all immediately.

### Stop Loss (SL):
- **Hard SL**: 0.6% below entry (No exceptions)
- **Time SL**: If trade hasn't hit TP1 within 45 minutes, exit at market.
- **Break-even SL**: Move SL to entry once TP1 is hit.

---

## 6. DYNAMIC TRADE MANAGEMENT

\`\`\`
IF position open > 20 min AND profit > 0.3%:  
    → TRAIL 0.5% (momentum fading)
    
IF BTC 1M delta FLIPS direction:
    → EXIT IMMEDIATELY (regardless of P/L)
\`\`\`

---

## 7. ADDITIONAL FILTERS (Risk Reduction)

### Funding Rate Filter:
\`\`\`
Coinglass DOGE Funding:
├── > +0.03%: Longs crowded → SHORT BIAS (or avoid longs)
├── < -0.03%: Shorts crowded → LONG BIAS (or avoid shorts)  
└── -0.01% to +0.01%: Neutral → FOLLOW BTC
\`\`\`

### Open Interest Filter:
\`\`\`
IF OI spiking + Price rising: Longs entering → CONTINUATION
IF OI spiking + Price falling: Shorts entering → CONTINUATION
IF OI dropping + Price moving: Positions closing → REVERSAL SOON
\`\`\`

### Chop Filter:
\`\`\`
IF BTC 1H ATR < 0.3%: → NO TRADE (sideways)
IF BTC in 0.5% range for 2+ hours: → WAIT FOR BREAKOUT
\`\`\`

---

## 8. IMPROVED DAILY WORKFLOW

### Pre-Session (15 min before):
\`\`\`
1. Check BTC 1D → Trend direction noted
2. Check BTC 4H → Key levels marked (OB, FVG, liquidity)  
3. Check BTC 1H → Delta/CVD direction
4. Check DOGE/BTC correlation → Must be > 0.75
5. Check funding rates → Note bias
6. Check calendar → Any Fed/macro news?
7. Set alerts on BTC key levels
\`\`\`

### During Session:
\`\`\`
1. Wait for BTC 1M setup (liquidity grab)
2. Confirm higher TF alignment
3. Check DOGE hasn't moved yet (lag opportunity)
4. Enter DOGE, set SL/TP immediately
5. Monitor BTC delta (exit trigger)
6. Journal result within 5 min of close
\`\`\`

---

## 9. ENHANCED RISK RULES

\`\`\`
HARD RULES (NO EXCEPTIONS):
├── Max 2 trades per session
├── Max 3 trades per day
├── Stop trading after 2 consecutive losses
├── Daily loss limit: 1.5% ($75)
├── Weekly loss limit: 4% ($200)
├── No trading 30 min before/after major news
└── No position held through funding (8-hour marks)

POSITION RULES:
├── Max leverage: 5x (never higher on DOGE)
├── Max position: 10% of account ($500)
└── Always use isolated margin (not cross)
\`\`\`

---

## 10. PERFORMANCE TRACKING

### Required Journal Fields:
\`\`\`
| Date | Time | Direction | BTC Bias | Entry | Exit | P/L % | R Multiple | Notes |
\`\`\`

### Weekly Review Metrics:
\`\`\`
- Win Rate Target: > 55%
- Avg R:R Target: > 1:2
- Profit Factor Target: > 1.5
- Max Drawdown Allowed: 5%
\`\`\`

---

IMPORTANT:
At the end of your analysis, you MUST provide a JSON block with the final trade decision.
The JSON block must be strictly formatted as follows:
\`\`\`json
{
  "decision": "BUY" | "SELL" | "HOLD",
  "reason": "Short summary of why",
  "orderType": "MARKET" | "LIMIT",
  "quantity": 0.001,
  "leverage": 1,
  "entry": 0.128,
  "stopLoss": 0.127,
  "takeProfit": 0.129
}
\`\`\`
If the decision is HOLD, quantity and leverage can be 0 or null.
If orderType is LIMIT, 'entry' is the limit price. If MARKET, 'entry' is current price (for reference).
Ensure 'stopLoss' and 'takeProfit' are always provided for BUY/SELL decisions.
`;

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
    if (!env.DB) return;
    try {
        // Get all OPEN or FILLED trades from DB (both need exit detection)
        const { results: activeTrades } = await env.DB.prepare(
            "SELECT * FROM trade_logs WHERE (status = 'OPEN' OR status = 'FILLED') AND order_id IS NOT NULL"
        ).all();

        if (activeTrades.length === 0) {
            console.log("No open trades to check.");
            return;
        }

        console.log(`🔍 Checking status for ${activeTrades.length} active trades...`);

        // Fetch latest orders and trade history (fills) from CoinDCX
        const [ordersData, tradesData] = await Promise.all([
            getOrders(env),
            getTradeHistory(env)
        ]);

        const orders = Array.isArray(ordersData) ? ordersData : (ordersData.orders || []);
        const fills = Array.isArray(tradesData) ? tradesData : (tradesData.trades || []);

        console.log(`📊 Fetched ${orders.length} orders and ${fills.length} fills from CoinDCX`);

        for (const trade of activeTrades) {
            console.log(`\n🔎 Checking trade ${trade.id} (${trade.decision} ${trade.asset})`);

            // Step 1: Check entry order status
            const entryOrder = orders.find(o => o.id === trade.order_id || o.order_id === trade.order_id);

            let newStatus = trade.status;
            let exitPrice = null;
            let pnl = null;

            if (entryOrder) {
                console.log(`  ✓ Entry order found: ${entryOrder.status}`);

                // Update status if entry order changed
                if (entryOrder.status === 'filled' && trade.status === 'OPEN') {
                    newStatus = 'FILLED';
                    console.log(`  ➜ Status updated: OPEN → FILLED`);
                } else if (['cancelled', 'rejected'].includes(entryOrder.status)) {
                    newStatus = entryOrder.status.toUpperCase();
                    console.log(`  ➜ Status updated: ${newStatus}`);
                }
            }

            // Step 2: Look for EXIT trades (opposite side)
            const exitSide = trade.decision === 'BUY' ? 'sell' : 'buy';

            const exitCandidates = fills.filter(fill => {
                const fillSymbol = fill.symbol || fill.market || '';
                const symbolMatch = fillSymbol === trade.asset ||
                    fillSymbol === trade.asset.replace('B-', '') ||
                    trade.asset === fillSymbol.replace('B-', '');

                const sideMatch = fill.side && fill.side.toLowerCase() === exitSide;
                const timeMatch = fill.timestamp > (trade.timestamp - 5000); // 5s buffer

                if (sideMatch && timeMatch && !symbolMatch) {
                    console.log(`  ⚠️ Symbol mismatch? Trade: ${trade.asset}, Fill: ${fillSymbol}`);
                }

                return symbolMatch && sideMatch && timeMatch;
            });

            console.log(`  📍 Found ${exitCandidates.length} potential exit trades`);

            if (exitCandidates.length > 0) {
                let totalExitQty = 0;
                let weightedPriceSum = 0;

                for (const exit of exitCandidates) {
                    const qty = parseFloat(exit.quantity || exit.size || 0);
                    const price = parseFloat(exit.price || 0);
                    totalExitQty += qty;
                    weightedPriceSum += qty * price;
                }

                const entryQty = Math.abs(trade.quantity);
                const exitQty = Math.abs(totalExitQty);

                console.log(`  📊 Entry: ${entryQty}, Exit: ${exitQty}`);

                // Relaxed quantity matching: allow 10% difference or 2 units (whichever is larger)
                const qtyDiff = Math.abs(exitQty - entryQty);
                const maxAllowedDiff = Math.max(2, entryQty * 0.1);

                if (qtyDiff <= maxAllowedDiff || exitQty >= entryQty * 0.95) {
                    exitPrice = weightedPriceSum / totalExitQty;
                    const entryPrice = trade.price;
                    if (trade.decision === 'BUY') {
                        pnl = (exitPrice - entryPrice) * entryQty;
                    } else {
                        pnl = (entryPrice - exitPrice) * entryQty;
                    }

                    newStatus = 'CLOSED';

                    console.log(`  💰 Position CLOSED!`);
                    console.log(`     PnL: ${pnl.toFixed(2)}`);

                    // Create a separate exit trade record linked to this parent if it doesn't exist
                    const exitDecision = trade.decision === 'BUY' ? 'SELL' : 'BUY';
                    const exitTimestamp = exitCandidates[0].timestamp || Date.now();
                    const exitOrderId = exitCandidates[0].order_id || exitCandidates[0].id;

                    try {
                        const { results: existingExits } = await env.DB.prepare(
                            "SELECT id FROM trade_logs WHERE parent_trade_id = ?"
                        ).bind(trade.id).all();

                        if (existingExits.length === 0) {
                            await env.DB.prepare(`
                                INSERT INTO trade_logs (
                                    timestamp, decision, reason, asset, price, quantity,
                                    leverage, stop_loss, take_profit, raw_response, status, order_id, parent_trade_id, exit_price, pnl
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            `).bind(
                                exitTimestamp,
                                exitDecision,
                                pnl >= 0 ? `Exit - WIN (Parent trade #${trade.id})` : `Exit - LOSS (Parent trade #${trade.id})`,
                                trade.asset,
                                exitPrice,
                                exitQty,
                                trade.leverage || 0,
                                trade.stop_loss || 0,
                                trade.take_profit || 0,
                                JSON.stringify(exitCandidates),
                                'CLOSED',
                                exitOrderId,
                                trade.id,
                                exitPrice,
                                pnl
                            ).run();
                        }
                    } catch (e) {
                        console.error(`  ❌ Failed to create exit record:`, e);
                    }
                }
            }

            if (newStatus !== trade.status || exitPrice !== null) {
                await env.DB.prepare(
                    "UPDATE trade_logs SET status = ?, exit_price = ?, pnl = ? WHERE id = ?"
                ).bind(newStatus, exitPrice, pnl, trade.id).run();
            }
        }
    } catch (e) {
        console.error("❌ Error checking trade status:", e);
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

            const timestamp = firstFill.timestamp || Date.now();

            let totalQty = 0;
            let weightedPriceSum = 0;
            for (const fill of orderFills) {
                const qty = parseFloat(fill.quantity || fill.size || 0);
                const price = parseFloat(fill.price || 0);
                totalQty += qty;
                weightedPriceSum += qty * price;
            }
            const avgPrice = weightedPriceSum / totalQty;

            console.log(`\n🔎 Processing synced trade: ${decision} ${asset} x ${totalQty} @ ${avgPrice.toFixed(6)} (Order: ${orderId})`);

            // Step 1: Check for same-side OPEN trade
            // Try matching with and without B- prefix
            const { results: sameSideOpen } = await env.DB.prepare(
                "SELECT * FROM trade_logs WHERE (asset = ? OR asset = ?) AND decision = ? AND status = 'OPEN' AND timestamp < ? ORDER BY timestamp DESC LIMIT 1"
            ).bind(asset, asset.replace('B-', ''), decision, timestamp + 5000).all();

            if (sameSideOpen.length > 0) {
                const openTrade = sameSideOpen[0];
                console.log(`  🏠 Matches existing OPEN trade #${openTrade.id}. Updating to FILLED.`);
                await env.DB.prepare(
                    "UPDATE trade_logs SET status = 'FILLED', order_id = ?, price = ?, quantity = ? WHERE id = ?"
                ).bind(orderId, avgPrice, totalQty, openTrade.id).run();
                newTradesAdded++;
                continue;
            }

            // Step 2: Check for exit (opposite side)
            const exitSide = decision === 'BUY' ? 'SELL' : 'BUY';
            // Robust search: fetch last 5 potential parents to find the best quantity match
            const { results: potentialParents } = await env.DB.prepare(
                "SELECT * FROM trade_logs WHERE (asset = ? OR asset = ?) AND decision = ? AND (status = 'OPEN' OR status = 'FILLED') AND timestamp < ? ORDER BY timestamp DESC LIMIT 5"
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
                    console.log(`  🔗 LINKED! Best match is Parent trade #${parent.id}.`);
                    let pnl = 0;
                    if (parent.decision === 'BUY') {
                        pnl = (avgPrice - parent.price) * totalQty;
                    } else {
                        pnl = (parent.price - avgPrice) * totalQty;
                    }

                    await env.DB.prepare(
                        "UPDATE trade_logs SET status = 'CLOSED', exit_price = ?, pnl = ? WHERE id = ?"
                    ).bind(avgPrice, pnl, parent.id).run();

                    await env.DB.prepare(`
                        INSERT INTO trade_logs (
                            timestamp, decision, reason, asset, price, quantity,
                            leverage, stop_loss, take_profit, raw_response, status, order_id, parent_trade_id, exit_price, pnl
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).bind(
                        timestamp, decision, `Exit - ${pnl >= 0 ? 'WIN' : 'LOSS'} (Synced from CoinDCX, Parent #${parent.id})`,
                        asset, avgPrice, totalQty, parent.leverage || 0, parent.stop_loss || 0, parent.take_profit || 0,
                        JSON.stringify(orderFills), 'CLOSED', orderId, parent.id, avgPrice, pnl
                    ).run();

                    newTradesAdded++;
                    continue;
                }
            }

            // Otherwise, new trade
            await env.DB.prepare(`
                INSERT INTO trade_logs (
                    timestamp, decision, reason, asset, price, quantity,
                    leverage, stop_loss, take_profit, raw_response, status, order_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
                timestamp, decision, "Trade synced from CoinDCX", asset, avgPrice, totalQty,
                0, 0, 0, JSON.stringify(orderFills), 'FILLED', orderId
            ).run();
            newTradesAdded++;
            console.log(`  ➕ Added as new FILLED trade.`);
        }

        console.log(`✅ Sync complete: ${newTradesAdded} new trades added`);
        return { newTradesAdded };
    } catch (e) {
        console.error("❌ Error syncing trades:", e);
        throw e;
    }
}

export async function analyzePerformanceAndUpdateStrategy(env) {
    if (!env.DB || !env.GEMINI_API_KEY) return;

    try {
        console.log("📊 Analyzing weekly performance...");

        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        const { results: logs } = await env.DB.prepare("SELECT * FROM trade_logs WHERE timestamp > ? ORDER BY timestamp DESC").bind(sevenDaysAgo).all();

        if (logs.length === 0) return;

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

        const currentStrategy = await getLatestStrategy(env) || TRADE_INSTRUCTIONS;
        const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

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

**TRADE RELATIONSHIPS (Entry → Exit):**
${tradeRelationships.slice(0, 15).map(rel =>
            `- [${new Date(rel.entry.timestamp).toLocaleString()}] ${rel.entry.decision} @ ${rel.entry.price} (SL: ${rel.entry.stop_loss}, TP: ${rel.entry.take_profit}) 
      → [${new Date(rel.exit.timestamp).toLocaleString()}] ${rel.exit.decision} @ ${rel.exit.price} 
      = ${rel.outcome} (${rel.pnl >= 0 ? '+' : ''}${rel.pnl.toFixed(2)})
      Reason: ${rel.entry.reason}`
        ).join('\n')}

**CURRENT STRATEGY:**
${currentStrategy}

**DETAILED TRADE LOGS (Most Recent 20):**
${JSON.stringify(recentLogs.map(l => ({
            time: new Date(l.timestamp).toLocaleString(),
            decision: l.decision,
            asset: l.asset,
            price: l.price,
            exit_price: l.exit_price,
            qty: l.quantity,
            pnl: l.pnl,
            reason: l.reason,
            status: l.status,
            sl: l.stop_loss,
            tp: l.take_profit
        })), null, 2)}

**INSTRUCTIONS:**
1. Analyze the performance summary and the detailed logs.
2. Identify patterns where the strategy succeeded or failed (e.g., too many rejections, wrong timing, correlation issues).
3. Pay close attention to the "Reason" field to understand the logic behind each trade.
4. Rewrite the strategy to address the weaknesses identified.
5. **CRITICAL**: Maintain the same structure and requirements (like the JSON output format) in the rewritten strategy.
6. **CRITICAL**: Ensure the strategy remains actionable for an AI that analyzes screenshots.
7. Output ONLY the full rewritten strategy in markdown format. Do not include any other text or explanations outside the markdown.
`;
        const result = await model.generateContent(analysisPrompt);
        const response = await result.response;
        const newStrategyText = response.text();

        if (newStrategyText && newStrategyText.length > 100) {
            await env.DB.prepare("INSERT INTO strategy_config (strategy_text, version) SELECT ?, MAX(version) + 1 FROM strategy_config")
                .bind(newStrategyText)
                .run();
        }
    } catch (e) {
        console.error("Error in performance analysis:", e);
    }
}

export async function repairTradeLogs(env) {
    if (!env.DB) return { error: "DB not bound" };

    try {
        console.log("🛠️ Starting trade log repair...");

        // 1. Find all FILLED trades that are not linked to a parent
        const { results: unlinkedTrades } = await env.DB.prepare(
            "SELECT * FROM trade_logs WHERE status = 'FILLED' AND parent_trade_id IS NULL ORDER BY timestamp DESC"
        ).all();

        console.log(`🔍 Found ${unlinkedTrades.length} unlinked FILLED trades to check.`);
        let repairedCount = 0;

        for (const child of unlinkedTrades) {
            const decision = child.decision;
            const asset = child.asset;
            const timestamp = child.timestamp;
            const totalQty = Math.abs(child.quantity);
            const avgPrice = child.price;

            console.log(`\n🧐 Checking child trade #${child.id}: ${decision} ${asset} x ${totalQty}`);

            // Step 2: Check if this is an exit for an existing OPEN or FILLED trade
            const exitSide = decision === 'BUY' ? 'SELL' : 'BUY';

            // Robust search: fetch last 5 potential parents
            const { results: potentialParents } = await env.DB.prepare(
                "SELECT * FROM trade_logs WHERE (asset = ? OR asset = ?) AND decision = ? AND (status = 'OPEN' OR status = 'FILLED') AND timestamp < ? AND id != ? ORDER BY timestamp DESC LIMIT 5"
            ).bind(asset, asset.replace('B-', ''), exitSide, timestamp, child.id).all();

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
                    console.log(`  🔗 REPAIRED! Linking child #${child.id} to parent #${parent.id}.`);

                    // Calculate PnL
                    let pnl = 0;
                    if (parent.decision === 'BUY') {
                        pnl = (avgPrice - parent.price) * totalQty;
                    } else {
                        pnl = (parent.price - avgPrice) * totalQty;
                    }

                    // Update parent trade
                    await env.DB.prepare(
                        "UPDATE trade_logs SET status = 'CLOSED', exit_price = ?, pnl = ? WHERE id = ?"
                    ).bind(avgPrice, pnl, parent.id).run();

                    // Update child trade to be a linked exit
                    await env.DB.prepare(`
                        UPDATE trade_logs SET 
                            status = 'CLOSED', 
                            parent_trade_id = ?, 
                            exit_price = ?, 
                            pnl = ?,
                            reason = ?
                        WHERE id = ?
                    `).bind(
                        parent.id,
                        avgPrice,
                        pnl,
                        `Exit - ${pnl >= 0 ? 'WIN' : 'LOSS'} (Repaired, Parent #${parent.id})`,
                        child.id
                    ).run();

                    repairedCount++;
                } else {
                    console.log(`  ❌ No quantity match found among potential parents.`);
                }
            } else {
                console.log(`  ❓ No potential parents found.`);
            }
        }

        console.log(`✅ Repair complete: ${repairedCount} trades linked.`);
        return { repairedCount };

    } catch (e) {
        console.error("❌ Error repairing trades:", e);
        throw e;
    }
}
