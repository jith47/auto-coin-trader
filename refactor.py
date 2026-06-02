import sys
import re

file_path = "/home/digitalmesh/projects/Jithin/personal/ai/cf-playwright/playwright-worker-strategy-coded-greed/src/coindcx.js"
with open(file_path, "r") as f:
    content = f.read()

# Add fetchWithFallback
fetch_fallback_code = """function generateSignature(payload, secret) {
    if (!secret) {
        throw new Error('CoinDCX Secret Key is missing in environment (env.COINDCX_SECRET_KEY)');
    }
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function fetchWithFallback(env, endpointPath, body) {
    const baseUrls = ["https://api.coindcx.com", "https://public.coindcx.com"];
    const payload = JSON.stringify(body);
    const signature = generateSignature(payload, env.COINDCX_SECRET_KEY);

    let lastStatus = 0;
    let lastText = "";

    for (const baseUrl of baseUrls) {
        const url = baseUrl + endpointPath;
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-AUTH-APIKEY": env.COINDCX_API_KEY,
                    "X-AUTH-SIGNATURE": signature
                },
                body: payload
            });

            if (response.ok) {
                return { ok: true, data: await response.json(), url };
            } else {
                lastStatus = response.status;
                lastText = await response.text();
                console.error(`[CoinDCX] ${endpointPath} HTTP ${lastStatus} on ${baseUrl}: ${lastText.slice(0, 100)}`);
            }
        } catch (err) {
            console.error(`[CoinDCX] ${endpointPath} fetch error on ${baseUrl}: ${err.message}`);
        }
    }
    return { ok: false, status: lastStatus, text: lastText };
}"""

content = re.sub(
    r"function generateSignature.*?digest\('hex'\);\n}",
    fetch_fallback_code,
    content,
    flags=re.DOTALL
)

# replace getOpenPositions
content = re.sub(
    r"export async function getOpenPositions.*?}\s*}\s*// Normalize CoinDCX fields.*?return data\.map.*?}\)\);\n}",
    """export async function getOpenPositions(env) {
    const endpoint = "/exchange/v1/derivatives/futures/positions";
    const body = {
        "timestamp": Math.floor(Date.now()),
        "page": "1",
        "size": "50",
        "margin_currency_short_name": ["USDT", "INR"]
    };
    const res = await fetchWithFallback(env, endpoint, body);
    if (!res.ok) {
        console.error(`[CoinDCX] getOpenPositions failed on all endpoints`);
        return null;
    }
    const data = res.data;
    if (!Array.isArray(data)) {
        console.error('[CoinDCX] getOpenPositions returned non-array:', JSON.stringify(data));
        return null;
    }
    return data.map(p => ({
        ...p,
        quantity: p.active_pos !== undefined ? p.active_pos : p.quantity,
        symbol: p.pair || p.symbol
    }));
}""",
    content,
    flags=re.DOTALL
)

# replace getTradeHistory
content = re.sub(
    r"export async function getTradeHistory.*?return data;\n\s*} catch \(err\).*?return null;\n\s*}\n}",
    """export async function getTradeHistory(env) {
    const endpoint = "/exchange/v1/derivatives/futures/trades";
    const body = {
        "timestamp": Math.floor(Date.now()),
        "size": "50"
    };
    const res = await fetchWithFallback(env, endpoint, body);
    if (!res.ok) {
        console.error(`[CoinDCX] getTradeHistory failed on all endpoints`);
        return null;
    }
    return res.data;
}""",
    content,
    flags=re.DOTALL
)

with open(file_path, "w") as f:
    f.write(content)
print("coindcx.js refactored")
