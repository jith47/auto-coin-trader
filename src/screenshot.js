import { launch } from "@cloudflare/playwright";
import {
  placeOrder,
  cancelOrder,
  cancelAllOrders,
  getOpenPositions,
  getFuturesWallets,
  getOrders,
  getTradeHistory
} from './coindcx.js';
import { getLogsHTML } from './templates.js';
import {
  TRADE_INSTRUCTIONS,
  logTradeToDB,
  getLatestStrategy,
  checkTradeStatus,
  analyzePerformanceAndUpdateStrategy,
  syncTradesFromExchange
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

    // Route: /api/check-status
    if (pathname === "/api/check-status") {
      ctx.waitUntil(checkTradeStatus(env));
      return new Response(JSON.stringify({ status: "checking" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Route: /api/analyze-performance
    if (pathname === "/api/analyze-performance") {
      ctx.waitUntil(analyzePerformanceAndUpdateStrategy(env));
      return new Response(JSON.stringify({ status: "analysis_started" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Route: /api/sync-trades
    if (pathname === "/api/sync-trades") {
      try {
        const result = await syncTradesFromExchange(env);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
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
    console.log("⏰ Running scheduled trade status check...");
    ctx.waitUntil(checkTradeStatus(env));
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
    const currentStrategy = strategyText || TRADE_INSTRUCTIONS;

    const browser = await launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    // Define assets to capture with their timeframes
    const captureConfig = [
      { name: "BTC", url: "https://www.coinglass.com/tv/Binance_BTCUSDT", timeframes: ["1m", "5m", "30m", "1d"] },
      { name: "DOGE", url: "https://www.coinglass.com/tv/Binance_DOGEUSDT", timeframes: ["1m"] }
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
      const { GoogleGenerativeAI } = await import("@google/generative-ai");
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

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
          const result = await model.generateContent([dynamicInstructions, ...screenshots]);
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

          tradeResult = await placeOrder(
            env,
            "B-DOGE_USDT",
            decision,
            finalQuantity,
            leverage || 5,
            stopLoss,
            takeProfit,
            orderType,
            entry,
            marginCurrency
          );

          console.log("📦 placeOrder returned:", JSON.stringify(tradeResult, null, 2));

          const extractedOrderId = tradeResult?.id || tradeResult?.order_id || null;
          console.log("🔑 Extracted Order ID:", extractedOrderId);

          await logTradeToDB(env, {
            decision,
            reason,
            entry,
            quantity: finalQuantity,
            leverage,
            stopLoss,
            takeProfit,
            rawResponse: text,
            status: "OPEN",
            orderId: extractedOrderId
          });
        } else {
          await logTradeToDB(env, {
            decision,
            reason,
            entry: 0,
            quantity: 0,
            leverage: 0,
            stopLoss: 0,
            takeProfit: 0,
            rawResponse: text,
            status: "SKIPPED"
          });
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

export async function scheduled(event, env, ctx) {
  console.log("⏰ Scheduled task triggered...");
  ctx.waitUntil(checkTradeStatus(env));
}
