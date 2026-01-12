import { launch } from "@cloudflare/playwright";
import {
  placeOrder,
  cancelOrder,
  cancelAllOrders,
  getOpenPositions,
  getFuturesWallets,
  getMarketPrice
} from './coindcx.js';
import { getLogsHTML } from './templates.js';
import {
  logTradeToDB,
  getLatestStrategy,
  checkTradeStatus,
  analyzePerformanceAndUpdateStrategy,
  syncTradesFromExchange,
  callGemini
} from './utils.js';


export default {
  async fetch(request, env, ctx) {
    const { pathname, searchParams } = new URL(request.url);
    const analyze = searchParams.get("analyze"); // Flag to trigger full AI analysis
    const trade = searchParams.get("trade"); // Flag to execute trade
    const cancelOrderId = searchParams.get("cancel_order"); // ID to cancel
    const cancelAll = searchParams.get("cancel_all"); // Flag to cancel all

    // Route: /api/logs
    if (pathname === "/api/logs") {
      if (!env.DB) return new Response("Database not bound", { status: 500 });
      try {
        const { results } = await env.DB.prepare("SELECT * FROM trade_logs ORDER BY timestamp DESC LIMIT 100").all();
        return new Response(JSON.stringify(results), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // Route: /api/stats
    if (pathname === "/api/stats") {
      if (!env.DB) return new Response("Database not bound", { status: 500 });
      try {
        const query = `
          SELECT 
            COUNT(*) as total_trades,
            SUM(CASE WHEN decision = 'BUY' THEN 1 ELSE 0 END) as buys,
            SUM(CASE WHEN decision = 'SELL' THEN 1 ELSE 0 END) as sells,
            SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) as closed_trades,
            SUM(CASE WHEN status = 'CLOSED' AND pnl > 0 THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN status = 'CLOSED' THEN pnl ELSE 0 END) as total_pnl,
            SUM(
              CASE WHEN status = 'CLOSED' AND price > 0 AND quantity > 0 AND leverage > 0 THEN
                (pnl / (price * quantity / leverage)) * 100
              ELSE 0 END
            ) as total_roi
          FROM trade_logs
        `;
        const { results } = await env.DB.prepare(query).all();
        const stats = results[0];

        // Calculate derived stats
        stats.win_rate = stats.closed_trades > 0 ? ((stats.wins / stats.closed_trades) * 100).toFixed(1) : 0;
        stats.avg_pnl = stats.closed_trades > 0 ? (stats.total_pnl / stats.closed_trades).toFixed(2) : 0;
        stats.total_pnl = (stats.total_pnl || 0).toFixed(2);
        stats.total_roi = (stats.total_roi || 0).toFixed(2);

        return new Response(JSON.stringify(stats), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // Route: /api/check-status
    if (pathname === "/api/check-status") {
      console.log("🔍 [API] Manual status check triggered.");
      ctx.waitUntil((async () => {
        try {
          const closedIds = await checkTradeStatus(env);
          if (closedIds && closedIds.length > 0) {
            console.log(`🎯 [API] Detected ${closedIds.length} closed trade(s). Triggering analysis...`);
            await runPostTradeAnalysis(env, closedIds);
          } else {
            console.log("ℹ️ [API] No new closures detected.");
          }
        } catch (err) {
          console.error("❌ [API] Error in status check:", err);
        }
      })());
      return new Response(JSON.stringify({ status: "checking" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Route: /api/analyze-performance (GET or POST)
    if (pathname === "/api/analyze-performance") {
      let customInput = "";
      if (request.method === "POST") {
        try {
          const body = await request.json();
          customInput = body.customInput || "";
        } catch (e) { }
      }
      ctx.waitUntil(analyzePerformanceAndUpdateStrategy(env, customInput));
      return new Response(JSON.stringify({ status: "analysis_started" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Route: /api/sync-trades
    if (pathname === "/api/sync-trades") {
      try {
        const result = await syncTradesFromExchange(env);

        // Trigger analysis for any closed trades found during sync
        if (result.closedTradeIds && result.closedTradeIds.length > 0) {
          ctx.waitUntil(runPostTradeAnalysis(env, result.closedTradeIds));
        }

        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // Route: /api/download-strategy
    if (pathname === "/api/download-strategy") {
      try {
        const { getLatestStrategy } = await import('./utils.js');
        const strategy = await getLatestStrategy(env);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        return new Response(strategy, {
          headers: {
            "Content-Type": "text/markdown",
            "Content-Disposition": `attachment; filename="strategy_${timestamp}.md"`
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // Route: /api/save-strategy (POST - Save edited strategy)
    if (pathname === "/api/save-strategy" && request.method === "POST") {
      try {
        const strategyText = await request.text();
        if (!strategyText || strategyText.trim().length === 0) {
          return new Response(JSON.stringify({ error: "Strategy cannot be empty" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Check if strategy_config table exists and has rows
        const { results: existingConfig } = await env.DB.prepare("SELECT id, version FROM strategy_config ORDER BY version DESC LIMIT 1").all();

        if (existingConfig.length > 0) {
          // Insert new version instead of updating
          const newVersion = (existingConfig[0].version || 0) + 1;
          await env.DB.prepare("INSERT INTO strategy_config (strategy_text, version) VALUES (?, ?)")
            .bind(strategyText, newVersion).run();
        } else {
          await env.DB.prepare("INSERT INTO strategy_config (strategy_text, version) VALUES (?, 1)")
            .bind(strategyText).run();
        }

        return new Response(JSON.stringify({ success: true, message: "Strategy saved" }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // Route: /api/restore-strategy (POST)
    if (pathname === "/api/restore-strategy" && request.method === "POST") {
      try {
        // Get the second latest version
        const { results: versions } = await env.DB.prepare("SELECT strategy_text, version FROM strategy_config ORDER BY version DESC LIMIT 2").all();

        if (versions.length < 2) {
          return new Response(JSON.stringify({ error: "No previous strategy version found to restore." }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        const previousStrategy = versions[1]; // Index 1 is the second latest
        const newVersion = versions[0].version + 1;

        await env.DB.prepare("INSERT INTO strategy_config (strategy_text, version) VALUES (?, ?)")
          .bind(previousStrategy.strategy_text, newVersion).run();

        return new Response(JSON.stringify({ success: true, message: "Restored previous strategy version " + previousStrategy.version }), {
          headers: { "Content-Type": "application/json" }
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // Route: /api/repair
    if (pathname === "/api/repair") {
      const { repairTradeLogs } = await import('./utils.js');
      try {
        const result = await repairTradeLogs(env);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // Route: /api/clear-logs
    if (pathname === "/api/clear-logs") {
      try {
        await env.DB.prepare("DELETE FROM trade_logs").run();
        // Reset auto-increment if sqlite
        try {
          await env.DB.prepare("DELETE FROM sqlite_sequence WHERE name='trade_logs'").run();
        } catch (e) {
          // ignore if sequence doesn't exist or other error
        }
        return new Response(JSON.stringify({ success: true, message: "Logs cleared" }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // Route: /api/force-scheduler (Manually trigger the event-driven scheduler)
    if (pathname === "/api/force-scheduler") {
      console.log(">>> START_SCHEDULER <<<");
      return new Response(JSON.stringify({ success: true, message: "Scheduler signal emitted." }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Route: /api/force-migrate (Temporary fix for missing column)
    if (pathname === "/api/force-migrate") {
      try {
        // Check if close_reason exists
        try {
          await env.DB.prepare("SELECT close_reason FROM trade_logs LIMIT 1").run();
        } catch (e) {
          await env.DB.prepare("ALTER TABLE trade_logs ADD COLUMN close_reason TEXT").run();
        }

        // Check if is_analyzed exists
        try {
          await env.DB.prepare("SELECT is_analyzed FROM trade_logs LIMIT 1").run();
        } catch (e) {
          await env.DB.prepare("ALTER TABLE trade_logs ADD COLUMN is_analyzed INTEGER DEFAULT 0").run();
        }

        return new Response(JSON.stringify({ success: true, message: "Migrations checked and applied." }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // Route: /api/backup-logs (Full Dump)
    if (pathname === "/api/backup-logs") {
      if (!env.DB) return new Response("Database not bound", { status: 500 });
      try {
        const { results } = await env.DB.prepare("SELECT * FROM trade_logs ORDER BY timestamp DESC").all();
        return new Response(JSON.stringify(results, null, 2), {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="trade_logs_backup_${Date.now()}.json"`
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // Route: /api/restore-logs
    if (pathname === "/api/restore-logs" && request.method === "POST") {
      try {
        const logs = await request.json();
        if (!Array.isArray(logs)) {
          throw new Error("Invalid backup file format. Expected an array of logs.");
        }

        // 1. Clear existing logs
        await env.DB.prepare("DELETE FROM trade_logs").run();
        try {
          await env.DB.prepare("DELETE FROM sqlite_sequence WHERE name='trade_logs'").run();
        } catch (e) { }

        // 2. Insert backed up logs
        let restoredCount = 0;
        const stmt = env.DB.prepare(`
          INSERT INTO trade_logs (
            id, timestamp, decision, reason, asset, price, quantity,
            leverage, stop_loss, take_profit, raw_response, status, 
            order_id, parent_trade_id, exit_price, pnl, summary
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        // Batch insert could be better but loop is safer for D1 limits per query
        for (const log of logs) {
          await stmt.bind(
            log.id, log.timestamp, log.decision, log.reason, log.asset, log.price, log.quantity,
            log.leverage, log.stop_loss, log.take_profit, log.raw_response, log.status,
            log.order_id, log.parent_trade_id, log.exit_price, log.pnl, log.summary
          ).run();
          restoredCount++;
        }

        return new Response(JSON.stringify({ success: true, message: `Restored ${restoredCount} logs successfully.` }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        console.error("Restore failed:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // Route: /logs (UI)
    if (pathname === "/logs") {
      return new Response(getLogsHTML(), {
        headers: { "Content-Type": "text/html" }
      });
    }

    // Handle Cancellation Requests
    if (cancelOrderId) {
      if (!env.COINDCX_API_KEY) return new Response("Missing API Keys", { status: 500 });
      const result = await cancelOrder(env, cancelOrderId);
      return new Response(JSON.stringify(result, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    if (cancelAll) {
      if (!env.COINDCX_API_KEY) return new Response("Missing API Keys", { status: 500 });
      const result = await cancelAllOrders(env);
      return new Response(JSON.stringify(result, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    // For analyze/trade requests, start background processing and return immediately
    if (analyze) {
      ctx.waitUntil(runAnalysisAndTrade(env, trade));

      return new Response(JSON.stringify({
        status: "processing",
        message: "Analysis started in background",
        timestamp: new Date().toISOString()
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Simple single screenshot (non-analysis mode)
    const browser = await launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    await page.goto("https://www.coinglass.com/tv/Binance_BTCUSDT");
    try {
      await page.waitForLoadState("networkidle", { timeout: 30000 });
    } catch (e) {
      console.log("Network idle wait timed out, continuing...");
    }

    await page.waitForTimeout(4000);
    const buffer = await page.screenshot({ fullPage: true });
    await browser.close();

    return new Response(buffer, { headers: { "Content-Type": "image/png" } });
  },

  async scheduled(event, env, ctx) {
    console.log("⏰ [Scheduled Event] Triggered at", new Date().toLocaleTimeString());
    ctx.waitUntil((async () => {
      try {
        console.log("🔍 [Scheduled] Calling checkTradeStatus...");
        const closedIds = await checkTradeStatus(env);
        if (closedIds && closedIds.length > 0) {
          console.log(`🎯 [Scheduled] Detected ${closedIds.length} closed trade(s). Triggering analysis...`);
          await runPostTradeAnalysis(env, closedIds);
        } else {
          console.log("ℹ️ [Scheduled] No active trades to check or no new closures.");
        }
      } catch (err) {
        console.error("❌ [Scheduled] Error in scheduled task:", err);
      } finally {
        console.log("🏁 [Scheduled] Task completed.");
      }
    })());
  },
};

// Background processing function
async function runAnalysisAndTrade(env, trade) {
  try {
    console.log("🚀 Starting background analysis...");

    // Safety Check: Stop if there are already open positions
    if (trade && env.COINDCX_API_KEY && env.COINDCX_SECRET_KEY) {
      console.log("🛡️ Safety Check: Checking for open positions before starting...");
      try {
        const positionsData = await getOpenPositions(env);
        console.log("📊 Raw Positions Data:", JSON.stringify(positionsData));

        const positions = Array.isArray(positionsData) ? positionsData : (positionsData.positions || []);

        // Filter for truly active positions (quantity > 0)
        const activePositions = positions.filter(p => {
          // Check multiple possible field names for position size
          const qty = Math.abs(parseFloat(p.active_pos || p.quantity || p.size || p.position_size || 0));
          return qty > 0;
        });

        if (activePositions.length > 0) {
          console.log(`🛑 STOP: ${activePositions.length} active position(s) found on CoinDCX. Skipping analysis to avoid duplicate trades.`);
          return;
        }
        console.log("✅ No active positions found. Proceeding with analysis.");
      } catch (e) {
        console.error("⚠️ Safety Check Failed: Could not fetch positions. Proceeding with caution...", e);
      }
    }

    // Fetch latest strategy from DB
    const strategyText = await getLatestStrategy(env);
    const currentStrategy = strategyText

    const browser = await launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    // Define assets to capture with their timeframes
    const captureConfig = [
      { name: "BTC", url: "https://www.coinglass.com/tv/Binance_BTCUSDT", timeframes: ["1m", "3m"] },
      { name: "DOGE", url: "https://www.coinglass.com/tv/Binance_DOGEUSDT", timeframes: ["1m", "5m"] }
    ];

    const screenshots = [];

    // Capture screenshots for each asset
    for (const asset of captureConfig) {
      console.log(`Navigating to ${asset.name} chart: ${asset.url}...`);
      await page.goto(asset.url);

      try {
        await page.waitForLoadState("networkidle", { timeout: 30000 });
      } catch (e) {
        console.log("Network idle wait timed out, continuing...");
      }

      console.log(`Waiting for ${asset.name} data...`);
      await page.waitForTimeout(5000); // Wait for chart to render

      for (const tf of asset.timeframes) {
        console.log(`Switching ${asset.name} to timeframe: ${tf}`);
        await switchTimeframe(page, tf);
        console.log(`Capturing screenshot for ${asset.name} ${tf}...`);
        const buffer = await page.screenshot({ fullPage: true });
        screenshots.push({
          inlineData: {
            data: Buffer.from(buffer).toString("base64"),
            mimeType: "image/png",
          },
        });
      }
    }

    await browser.close();

    // Call Gemini
    if (!env.GEMINI_API_KEY) {
      console.error("Error: GEMINI_API_KEY not set");
      return;
    }

    try {
      // Import GoogleGenerativeAI only when needed or keep it in utils
      // But since we need it here for the main flow, let's import it at the top or use a helper
      // Actually, let's keep the import at the top of screenshot.js if we use it here.
      // Wait, I removed it from the top. Let me add it back.
      // const { GoogleGenerativeAI } = await import("@google/generative-ai");
      // const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      // const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
      // console.log("model loaded");

      // FETCH ACCOUNT DATA BEFORE AI ANALYSIS
      let positions = [];
      let futuresWallets = [];

      if (trade && env.COINDCX_API_KEY && env.COINDCX_SECRET_KEY) {
        console.log("Fetching Positions and Futures Wallets before AI analysis...");
        try {
          const [posData, walletData] = await Promise.all([
            getOpenPositions(env),
            getFuturesWallets(env)
          ]);
          positions = posData;
          futuresWallets = Array.isArray(walletData) ? walletData : [];
        } catch (e) {
          console.error("Error fetching account data:", e);
        }
      }

      // Format futures balances for the prompt
      const balanceInfo = futuresWallets
        .filter(w => (parseFloat(w.balance) + parseFloat(w.locked_balance)) > 0)
        .map(w => `${w.currency_short_name} -> Available: ${parseFloat(w.balance).toFixed(2)}, Locked: ${parseFloat(w.locked_balance).toFixed(2)}`)
        .join("\n");

      const usdtWallet = futuresWallets.find(w => w.currency_short_name === "USDT");
      const usdtLiquid = usdtWallet ? parseFloat(usdtWallet.balance) : 0;
      const inrWallet = futuresWallets.find(w => w.currency_short_name === "INR");
      const inrLiquid = inrWallet ? parseFloat(inrWallet.balance) : 0;

      let marginCurrency = "USDT";
      let availableMargin = usdtLiquid;
      if (usdtLiquid <= 0 && inrLiquid > 0) {
        marginCurrency = "INR";
        availableMargin = inrLiquid;
      }

      const dynamicInstructions = `${currentStrategy}

**CURRENT FUTURES BALANCES:**
${balanceInfo || "No balance available"}

**MARGIN CURRENCY SELECTED:** ${marginCurrency}
**AVAILABLE MARGIN:** ${availableMargin.toFixed(2)} ${marginCurrency}

**IMPORTANT NOTES ON BALANCE:**
- **Available Balance**: This is the liquid cash you can use to open NEW trades.
- **Locked Balance**: This is money already tied up in active trades. 
- **RULE**: If **Locked Balance > 0**, it means a trade is already running. You should generally **HOLD** unless you see a very strong reason to add to the position.

${marginCurrency === "INR" ? `
**CRITICAL: YOU ARE TRADING WITH INR MARGIN**
Your balance is in **INR**, but the asset (DOGE) is priced in **USDT**.
You MUST perform the following conversion to determine the correct quantity:

**STEP-BY-STEP CALCULATION (MANDATORY):**
1. **Safe Margin (INR)**: Use 85% of your **Available Balance**.
   - ${availableMargin.toFixed(2)} INR * 0.85 = **${(availableMargin * 0.85).toFixed(2)} INR**
2. **Convert to USDT**: Assume 1 USDT = 86 INR.
   - ${(availableMargin * 0.85).toFixed(2)} INR / 86 = **${((availableMargin * 0.85) / 86).toFixed(2)} USDT**
3. **Total Position Value (USDT)**: Apply 5x Leverage.
   - ${((availableMargin * 0.85) / 86).toFixed(2)} USDT * 5 = **${(((availableMargin * 0.85) / 86) * 5).toFixed(2)} USDT**
4. **Calculate Quantity (DOGE)**:
   - Quantity = Total Position Value / Current DOGE Price
   - Quantity = ${(((availableMargin * 0.85) / 86) * 5).toFixed(2)} / [Current Price]

**FINAL INSTRUCTION:**
- If you decide to BUY or SELL, **you MUST use the Quantity calculated in Step 4**.
` : `
**USDT MARGIN CALCULATION:**
- Apply 0.5% risk rule: Use ${(availableMargin * 0.005).toFixed(2)} USDT as risk amount.
`}

Please provide the final JSON decision. Ensure 'quantity' is affordable with the ${marginCurrency} balance provided.`;

      console.log("Sending data to Gemini...");

      let attempts = 0;
      const maxAttempts = 3;
      let text = "";
      let parsedDecision = null;

      while (attempts < maxAttempts) {
        try {
          const result = await callGemini(env, [dynamicInstructions, ...screenshots]);
          const response = await result.response;
          text = response.text();
          console.log(`AI Response (Attempt ${attempts + 1}):`, text);

          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsedDecision = JSON.parse(jsonMatch[0]);
            break;
          }
        } catch (e) {
          console.error(`AI Attempt ${attempts + 1} failed:`, e);
        }
        attempts++;
      }

      if (!parsedDecision) {
        console.log("Failed to get valid JSON decision from AI.");
        return;
      }

      const {
        decision,
        reason,
        quantity,
        leverage,
        stopLoss,
        takeProfit,
        orderType,
        entry,
      } = parsedDecision;

      console.log("AI Decision:", decision);

      if (trade && env.COINDCX_API_KEY && env.COINDCX_SECRET_KEY) {
        let tradeResult = null;

        if (decision === "BUY" || decision === "SELL") {
          let finalQuantity = parseFloat(quantity);
          const dogePrice = entry || 0.13;

          if (!finalQuantity || finalQuantity <= 0) {
            finalQuantity = Math.ceil(7 / dogePrice);
          }

          const currentOrderValue = finalQuantity * dogePrice;
          if (currentOrderValue < 7) {
            finalQuantity = Math.ceil(7 / dogePrice);
          }

          finalQuantity = Math.floor(finalQuantity);

          let marginCurrency = "USDT";
          const usdtWallet = futuresWallets.find(w => w.currency_short_name === "USDT");
          const usdtBalance = usdtWallet ? (parseFloat(usdtWallet.balance) + parseFloat(usdtWallet.locked_balance)) : 0;

          if (usdtBalance <= 0) {
            const inrWallet = futuresWallets.find(w => w.currency_short_name === "INR");
            const inrBalance = inrWallet ? (parseFloat(inrWallet.balance) + parseFloat(inrWallet.locked_balance)) : 0;
            if (inrBalance > 0) {
              marginCurrency = "INR";
              const usdtToInrRate = 85;
              const tradeValueUSDT = finalQuantity * dogePrice;
              const tradeValueINR = tradeValueUSDT * usdtToInrRate;
              const marginNeededINR = tradeValueINR / (leverage || 5);

              if (marginNeededINR > inrBalance * 0.75) {
                const maxMarginINR = inrBalance * 0.75;
                const maxPositionValueINR = maxMarginINR * (leverage || 5);
                const maxPositionValueUSDT = maxPositionValueINR / usdtToInrRate;
                finalQuantity = Math.floor(maxPositionValueUSDT / dogePrice);
              }
            }
          }

          finalQuantity = Math.floor(finalQuantity);

          // --- VALIDATION LOGIC START ---
          let finalStopLoss = stopLoss;
          let finalTakeProfit = takeProfit;

          try {
            console.log("🔍 Validating SL/TP against real-time market price...");
            const currentPrice = await getMarketPrice("B-DOGE_USDT");

            if (currentPrice) {
              console.log(`📊 Current Market Price: ${currentPrice}`);
              let slInvalid = false;

              if (decision === "BUY" && finalStopLoss >= currentPrice) {
                console.warn(`⚠️ Invalid SL for BUY: ${finalStopLoss} >= ${currentPrice}`);
                slInvalid = true;
              } else if (decision === "SELL" && finalStopLoss <= currentPrice) {
                console.warn(`⚠️ Invalid SL for SELL: ${finalStopLoss} <= ${currentPrice}`);
                slInvalid = true;
              }

              if (slInvalid) {
                console.log("🔄 Adjusting SL/TP to maintain risk management...");

                // Calculate original R:R if possible, else default to 1:2
                let riskRewardRatio = 2;
                if (entry && stopLoss && takeProfit) {
                  const risk = Math.abs(entry - stopLoss);
                  const reward = Math.abs(takeProfit - entry);
                  if (risk > 0) riskRewardRatio = reward / risk;
                }

                // Set SL to 0.5% risk
                const riskPercent = 0.005; // 0.5%
                const riskAmount = currentPrice * riskPercent;

                if (decision === "BUY") {
                  finalStopLoss = parseFloat((currentPrice - riskAmount).toFixed(5));
                  const rewardAmount = riskAmount * riskRewardRatio;
                  finalTakeProfit = parseFloat((currentPrice + rewardAmount).toFixed(5));
                } else {
                  finalStopLoss = parseFloat((currentPrice + riskAmount).toFixed(5));
                  const rewardAmount = riskAmount * riskRewardRatio;
                  finalTakeProfit = parseFloat((currentPrice - rewardAmount).toFixed(5));
                }

                console.log(`✅ Adjusted SL: ${finalStopLoss}, TP: ${finalTakeProfit} (Risk: 0.5%, R:R: 1:${riskRewardRatio.toFixed(1)})`);
              } else {
                console.log("✅ SL/TP are valid.");
              }
            } else {
              console.warn("⚠️ Could not fetch market price for validation. Proceeding with AI values.");
            }
          } catch (e) {
            console.error("❌ Error during SL/TP validation:", e);
          }
          // --- VALIDATION LOGIC END ---

          tradeResult = await placeOrder(
            env,
            "B-DOGE_USDT",
            decision,
            finalQuantity,
            leverage || 5,
            finalStopLoss,
            finalTakeProfit,
            orderType,
            entry,
            marginCurrency
          );

          console.log("📦 placeOrder returned:", JSON.stringify(tradeResult, null, 2));

          // Robust Order ID Extraction
          let extractedOrderId = null;
          if (tradeResult) {
            // Handle array response (most common from CoinDCX)
            if (Array.isArray(tradeResult) && tradeResult.length > 0) {
              extractedOrderId = tradeResult[0].id || tradeResult[0].order_id;
            } else if (tradeResult.id) {
              extractedOrderId = tradeResult.id;
            } else if (tradeResult.order_id) {
              extractedOrderId = tradeResult.order_id;
            } else if (tradeResult.orders && Array.isArray(tradeResult.orders) && tradeResult.orders.length > 0) {
              extractedOrderId = tradeResult.orders[0].id || tradeResult.orders[0].order_id;
            } else if (tradeResult.data && (tradeResult.data.id || tradeResult.data.order_id)) {
              extractedOrderId = tradeResult.data.id || tradeResult.data.order_id;
            }
          }

          console.log("🔑 Extracted Order ID:", extractedOrderId);
          await logTradeToDB(env, {
            decision,
            reason,
            entry,
            quantity: finalQuantity,
            leverage,
            stopLoss: finalStopLoss,
            takeProfit: finalTakeProfit,
            rawResponse: text,
            status: "OPEN",
            orderId: extractedOrderId
          });

          // Signal to start the scheduler
          console.log(">>> START_SCHEDULER <<<");
        } else {
          // await logTradeToDB(env, {
          //   decision,
          //   reason,
          //   entry: 0,
          //   quantity: 0,
          //   leverage: 0,
          //   stopLoss: 0,
          //   takeProfit: 0,
          //   rawResponse: text,
          //   status: "SKIPPED"
          // });
        }
      }
    } catch (error) {
      console.error("Error in AI analysis:", error);
    }
  } catch (error) {
    console.error("Error in background analysis:", error);
  }
}

async function switchTimeframe(page, timeframe) {
  try {
    const timeframeMap = {
      "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
      "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "8h": "8H",
      "12h": "12H", "1d": "1D", "3d": "3D", "1w": "1W", "1M": "1M"
    };

    const targetText = timeframeMap[timeframe] || timeframe;
    const frames = page.frames();

    for (const frame of frames) {
      const frameBtn = frame.locator(`button:has-text("${targetText}")`).first();
      if (await frameBtn.count() > 0) {
        await frameBtn.click();
        await page.waitForTimeout(5000);
        return;
      }
    }
  } catch (e) {
    console.error(`Error switching timeframe to ${timeframe}: ${e.message}`);
  }
}

async function runPostTradeAnalysis(env, closedTradeIds) {
  try {
    console.log(`📊 Starting immediate post-trade analysis for trades: ${closedTradeIds.join(", ")}`);

    if (!env.GEMINI_API_KEY) {
      console.error("❌ Missing GEMINI_API_KEY. Cannot run post-trade analysis.");
      return;
    }

    // Filter trades that actually need analysis (LOSSES)
    const tradesToAnalyze = [];
    for (const tradeId of closedTradeIds) {
      const { results } = await env.DB.prepare("SELECT * FROM trade_logs WHERE id = ?").bind(tradeId).all();
      if (results.length > 0) {
        const trade = results[0];
        if (trade.pnl <= 0) {
          tradesToAnalyze.push(trade);
        } else {
          console.log(`✅ Trade #${tradeId} was a WIN (PnL: ${trade.pnl.toFixed(2)}). Skipping detailed analysis.`);
          await env.DB.prepare("UPDATE trade_logs SET close_reason = 'WIN', summary = 'Trade closed with profit.' WHERE id = ?").bind(tradeId).run();
        }
      }
    }

    if (tradesToAnalyze.length === 0) {
      console.log("ℹ️ No losing trades to analyze. Skipping browser launch.");
      return;
    }

    console.log(`📸 Launching browser to analyze ${tradesToAnalyze.length} losing trade(s)...`);
    const browser = await launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    // Capture IMMEDIATE screenshots of BTC and DOGE for delta context
    const captureConfig = [
      { name: "BTC", url: "https://www.coinglass.com/tv/Binance_BTCUSDT", timeframes: ["1m"] },
      { name: "DOGE", url: "https://www.coinglass.com/tv/Binance_DOGEUSDT", timeframes: ["1m"] }
    ];

    const screenshots = [];
    for (const asset of captureConfig) {
      console.log(`📸 Capturing immediate delta for ${asset.name}...`);
      await page.goto(asset.url);
      await page.waitForTimeout(5000); // Wait for chart to render
      const buffer = await page.screenshot({ fullPage: true });
      screenshots.push({
        inlineData: {
          data: Buffer.from(buffer).toString("base64"),
          mimeType: "image/png",
        },
      });
    }
    await browser.close();

    // const { GoogleGenerativeAI } = await import("@google/generative-ai");
    // const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    // const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
    // console.log("model loaded");

    for (const trade of tradesToAnalyze) {
      const tradeId = trade.id;
      const analysisPrompt = `
Analyze the outcome of this trade based on the provided screenshots and consolidated trade data.
The screenshots were captured IMMEDIATELY after the trade was closed to provide the exact market context (Delta/CVD).

TRADE DATA:
- Decision: ${trade.decision}
- Entry Price: ${trade.price}
- Exit Price: ${trade.exit_price}
- PnL: ${trade.pnl}
- Reason for Entry: ${trade.reason}
- Status: ${trade.status}

INSTRUCTIONS:
1. Explain why the trade was a WIN or LOSS.
2. Analyze the BTC/DOGE Delta and CVD data from the screenshots at the time of exit.
3. Determine the specific trigger that caused the exit (e.g., Stop Loss hit, Take Profit hit, Delta flip, Momentum faded, Manual close).
4. Provide a detailed analysis (3-5 sentences) explaining the market conditions that led to this outcome.
5. Output ONLY the analysis text. No JSON, no formatting.
`;

      const result = await callGemini(env, [analysisPrompt, ...screenshots]);
      const closeReason = (await result.response).text().trim();

      await env.DB.prepare("UPDATE trade_logs SET close_reason = ?, summary = ? WHERE id = ?").bind(closeReason, closeReason, tradeId).run();
      console.log(`✅ Immediate analysis saved for trade #${tradeId}`);
    }

    // Re-trigger market analysis for next trade opportunity
    console.log("🔄 Trade closed. Triggering new market analysis for next opportunity...");
    await runAnalysisAndTrade(env, true);
  } catch (e) {
    console.error("❌ Error in post-trade analysis:", e);
  }
}
