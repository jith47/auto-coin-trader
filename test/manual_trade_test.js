import { placeOrder, getAccountBalance } from "../src/coindcx.js";
import fs from 'node:fs';
import path from 'node:path';

// Mock environment for the script
const env = {
    COINDCX_API_KEY: process.env.COINDCX_API_KEY,
    COINDCX_SECRET_KEY: process.env.COINDCX_SECRET_KEY,
};

// Try to load from .dev.vars if keys are missing
if (!env.COINDCX_API_KEY || !env.COINDCX_SECRET_KEY) {
    try {
        const devVarsPath = path.join(process.cwd(), '.dev.vars');
        if (fs.existsSync(devVarsPath)) {
            const content = fs.readFileSync(devVarsPath, 'utf8');
            content.split('\n').forEach(line => {
                const [key, value] = line.split('=');
                if (key && value) {
                    const cleanKey = key.trim();
                    const cleanValue = value.trim().replace(/^["']|["']$/g, '');
                    if (cleanKey === 'COINDCX_API_KEY') env.COINDCX_API_KEY = cleanValue;
                    if (cleanKey === 'COINDCX_SECRET_KEY') env.COINDCX_SECRET_KEY = cleanValue;
                }
            });
            console.log("Loaded API keys from .dev.vars");
        }
    } catch (e) {
        console.log("Could not read .dev.vars, relying on environment variables.");
    }
}

async function getDogePrice() {
    try {
        const response = await fetch("https://api.coindcx.com/exchange/ticker");
        const tickers = await response.json();
        // Find DOGE_USDT ticker. CoinDCX tickers usually look like "DOGEUSDT" or "B-DOGE_USDT"
        // For futures, it's often "B-DOGE_USDT"
        const dogeTicker = tickers.find(t => t.market === "DOGEUSDT" || t.market === "B-DOGE_USDT");
        return dogeTicker ? parseFloat(dogeTicker.last_price) : null;
    } catch (e) {
        console.error("Error fetching price:", e);
        return null;
    }
}

async function runTest() {
    console.log("--- DOGE Manual Trade Test ---");

    if (!env.COINDCX_API_KEY || !env.COINDCX_SECRET_KEY) {
        console.error("Error: COINDCX_API_KEY or COINDCX_SECRET_KEY not set in environment or .dev.vars.");
        console.log("Please run with: COINDCX_API_KEY=your_key COINDCX_SECRET_KEY=your_secret node test/manual_trade_test.js");
        return;
    }

    // 1. Fetch Price
    console.log("Fetching current DOGE price...");
    const price = await getDogePrice();
    if (!price) {
        console.error("Failed to fetch DOGE price.");
        return;
    }
    console.log(`Current DOGE Price: ${price} USDT`);

    // 2. Fetch Balance
    console.log("Fetching account balance...");
    const balanceData = await getAccountBalance(env);
    console.log("Balance Data:", JSON.stringify(balanceData, null, 2));
    const availableBalance = parseFloat(balanceData.available_wallet_balance || 0);
    console.log(`Available Balance: ${availableBalance} USDT`);

    // 3. Place Test Trade
    const testQuantity = 10; // 10 DOGE
    console.log(`Placing test order: BUY ${testQuantity} DOGE at Market Price...`);

    // Using MARKET order for simplicity in test
    const tradeResult = await placeOrder(
        env,
        "B-DOGE_USDT",
        "BUY",
        testQuantity,
        5, // Leverage
        null, // No SL for test
        null, // No TP for test
        "MARKET",
        price
    );

    console.log("Trade Result:", JSON.stringify(tradeResult, null, 2));

    if (tradeResult.status === "success" || (tradeResult.order && tradeResult.order.id)) {
        console.log("SUCCESS: Test trade placed successfully.");
    } else {
        console.log("FAILED: Test trade failed. Check the error message above.");
    }
}

runTest().catch(console.error);
