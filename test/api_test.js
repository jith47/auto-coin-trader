import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';



const timeStamp = Math.floor(Date.now());
// 1. Configuration - Loads from .dev.vars or Environment
const env = {
    COINDCX_API_KEY: process.env.COINDCX_API_KEY,
    COINDCX_SECRET_KEY: process.env.COINDCX_SECRET_KEY,
};

// Try to load from .dev.vars if keys are missing
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
        console.log("✅ Loaded API keys from .dev.vars");
    }
} catch (e) {
    // Ignore errors reading .dev.vars
}

// 2. Signature Generation (Using Node.js crypto as requested)
function generateSignature(payload, secret) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// 3. API Functions
async function getDogePrice() {
    const response = await fetch("https://api.coindcx.com/exchange/ticker");
    const tickers = await response.json();
    const dogeTicker = tickers.find(t => t.market === "DOGEUSDT" || t.market === "B-DOGE_USDT");
    return dogeTicker ? parseFloat(dogeTicker.last_price) : null;
}

// Get USDT-INR conversion price for INR margin orders
async function getUSDTINRConversion() {
    const endpoint = "/api/v1/derivatives/futures/data/conversions";
    const body = { "timestamp": Date.now() };
    const payload = JSON.stringify(body);
    const signature = generateSignature(payload, env.COINDCX_SECRET_KEY);

    const response = await fetch("https://api.coindcx.com" + endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-AUTH-APIKEY": env.COINDCX_API_KEY,
            "X-AUTH-SIGNATURE": signature
        },
        body: payload
    });
    const data = await response.json();
    // Extract USDT conversion price from response
    return data.USDT || 85; // Fallback to 85 if not available
}

// This endpoint is for USDT cross-margin details
async function getAccountBalance() {
    const endpoint = "/exchange/v1/derivatives/futures/positions/cross_margin_details";
    const body = { "timestamp": Date.now() };
    const payload = JSON.stringify(body);
    const signature = generateSignature(payload, env.COINDCX_SECRET_KEY);

    const response = await fetch("https://api.coindcx.com" + endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-AUTH-APIKEY": env.COINDCX_API_KEY,
            "X-AUTH-SIGNATURE": signature
        },
        body: payload
    });
    return await response.json();
}

// This is the correct endpoint for ALL futures wallets (INR and USDT)
async function getFuturesWallets() {
    const timestamp = Date.now();
    const endpoint = "/exchange/v1/derivatives/futures/wallets";

    // For GET requests, the payload for signature is an empty string
    const payload = "";
    const signature = generateSignature(payload, env.COINDCX_SECRET_KEY);

    const response = await fetch(`https://api.coindcx.com${endpoint}?timestamp=${timestamp}`, {
        method: "GET",
        headers: {
            "X-AUTH-APIKEY": env.COINDCX_API_KEY,
            "X-AUTH-SIGNATURE": signature
        }
    });
    return await response.json();
}

async function getWalletBalances() {
    const endpoint = "/exchange/v1/users/balances";
    const body = { "timestamp": Date.now() };
    const payload = JSON.stringify(body);
    const signature = generateSignature(payload, env.COINDCX_SECRET_KEY);

    const response = await fetch("https://api.coindcx.com" + endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-AUTH-APIKEY": env.COINDCX_API_KEY,
            "X-AUTH-SIGNATURE": signature
        },
        body: payload
    });
    return await response.json();
}

async function getActiveInstruments(marginCurrency = "INR") {
    const endpoint = `/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=${marginCurrency}`;
    const response = await fetch(`https://api.coindcx.com${endpoint}`);
    const data = await response.json();

    // Save to file for inspection
    fs.writeFileSync('active_instruments_inr.json', JSON.stringify(data, null, 2));
    console.log("💾 Saved instruments to active_instruments_inr.json");

    return data;
}

async function placeINRTestOrder(conversionPrice) {
    const endpoint = "/exchange/v1/derivatives/futures/orders/create";
    const body = {
        "timestamp": Date.now(),
        "order": {
            "side": "buy",
            "pair": "B-DOGE_USDT",
            "order_type": "market_order",
            "total_quantity": 49, // 10 DOGE (~1.28 USDT, ~0.14 USDT margin = ~11.9 INR)
            "leverage": 9,
            "notification": "no_notification",
            "position_margin_type": "isolated",
            "margin_currency_short_name": "INR", // USING INR MARGIN
            // "settlement_currency_conversion_price": conversionPrice, // USDT-INR rate
            // "hidden": false,
            // "post_only": false
        }
    };
    const payload = JSON.stringify(body);
    console.log("📤 Sending Order Payload:", payload);
    const signature = generateSignature(payload, env.COINDCX_SECRET_KEY);

    const response = await fetch("https://api.coindcx.com" + endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-AUTH-APIKEY": env.COINDCX_API_KEY,
            "X-AUTH-SIGNATURE": signature
        },
        body: payload
    });
    const data = await response.json();
    console.log("📥 Full API Response:", JSON.stringify(data, null, 2));
    return data;
}

// 4. Main Execution
async function run() {
    console.log("🚀 Starting Self-Contained API Test...");

    if (!env.COINDCX_API_KEY || !env.COINDCX_SECRET_KEY) {
        console.error("❌ Error: API Keys missing. Set them in .dev.vars or environment.");
        return;
    }

    try {
        console.log("🔍 Fetching current DOGE price...");
        const price = await getDogePrice().catch(err => {
            console.log("⚠️ getDogePrice failed, using fallback 0.128");
            return 0.128;
        });
        console.log(`📈 Current DOGE Price: ${price} USDT`);

        console.log("🔍 Fetching USDT-INR conversion price...");
        const conversionPrice = await getUSDTINRConversion().catch(err => {
            console.error(`❌ getUSDTINRConversion failed: ${err.message}, using fallback 85`);
            return 85;
        });
        console.log(`💱 USDT-INR Conversion Price: ${conversionPrice}`);

        console.log("🔍 Fetching active INR instruments...");
        const activeInstruments = await getActiveInstruments("INR").catch(err => {
            console.error(`❌ getActiveInstruments failed: ${err.message}`);
            return [];
        });
        const isDOGEActive = activeInstruments.includes("B-DOGE_USDT");
        console.log(`📋 B-DOGE_USDT Active for INR: ${isDOGEActive ? "✅ YES" : "❌ NO"}`);
        console.log(`📋 Total Active INR Instruments: ${activeInstruments.length}`);

        console.log("🔍 Fetching account balances...");

        console.log("- Fetching Futures Wallets (INR/USDT)...");
        const futuresWallets = await getFuturesWallets().catch(err => {
            console.error(`❌ getFuturesWallets failed: ${err.message}`);
            return [];
        });
        console.log("📝 Futures Wallets Response:", JSON.stringify(futuresWallets, null, 2));

        console.log("- Fetching Cross Margin Details (USDT)...");
        const crossMargin = await getAccountBalance().catch(err => {
            console.error(`❌ getAccountBalance failed: ${err.message}`);
            return {};
        });
        console.log(`💰 USDT (Cross Margin): ${crossMargin.available_wallet_balance || 0} USDT`);

        console.log("- Fetching Spot Wallets...");
        const walletBalances = await getWalletBalances().catch(err => {
            console.error(`❌ getWalletBalances failed: ${err.message}`);
            return [];
        });

        const otherBalances = walletBalances
            .filter(b => parseFloat(b.balance) > 0 || parseFloat(b.locked_balance) > 0)
            .map(b => `${b.currency}: ${b.balance}`);

        if (otherBalances.length > 0) {
            console.log(`💰 Spot Balances: ${otherBalances.join(", ")}`);
        }

        // console.log("⚖️ Placing 10 DOGE Market Buy Order with INR Margin (minimal test)...");
        // const order = await placeINRTestOrder(conversionPrice).catch(err => {
        //     throw new Error(`placeINRTestOrder failed: ${err.message}`);
        // });
        // console.log("📝 API Response:", JSON.stringify(order, null, 2));

        // if (order.status === "success" || (order.order && order.order.id)) {
        //     console.log("✅ SUCCESS: Order placed successfully!");
        // } else {
        //     console.log("❌ FAILED: Order placement failed.");
        // }

    } catch (e) {
        console.error("💥 Execution Error Details:");
        console.error(e.stack || e.message);
    }
}

run();
