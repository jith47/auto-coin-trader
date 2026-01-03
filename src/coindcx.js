import crypto from 'node:crypto';

export async function placeOrder(env, pair, side, quantity, leverage, stopLoss, takeProfit, orderType, price, marginCurrency = "USDT") {
    const baseUrl = "https://api.coindcx.com";
    const endpoint = "/exchange/v1/derivatives/futures/orders/create";

    const timestamp = Date.now();

    const body = {
        "timestamp": timestamp,
        "order": {
            "side": side.toLowerCase(), // "buy" or "sell"
            "pair": pair, // e.g., "B-DOGE_USDT"
            "order_type": "market_order",
            "total_quantity": quantity, // e.g., 0.001
            "leverage": leverage,
            "notification": "no_notification",
            "position_margin_type": "isolated", // FIX: Must use isolated margin for INR
            "margin_currency_short_name": marginCurrency, // FIX: String, not array
            "stop_loss_price": stopLoss,
            "take_profit_price": takeProfit
        }
    };

    if (orderType === "LIMIT" && price) {
        body.order.price = price;
    }

    const payload = JSON.stringify(body);
    console.log("payload: ", payload)
    const signature = generateSignature(payload, env.COINDCX_SECRET_KEY);

    const response = await fetch(baseUrl + endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-AUTH-APIKEY": env.COINDCX_API_KEY,
            "X-AUTH-SIGNATURE": signature
        },
        body: payload
    });
    console.log("coindcx response: ", response);

    const data = await response.json();
    return data;
}

function generateSignature(payload, secret) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export async function cancelOrder(env, id) {
    const baseUrl = "https://api.coindcx.com";
    const endpoint = "/exchange/v1/derivatives/futures/orders/cancel";

    const timestamp = Math.floor(Date.now());

    const body = {
        "timestamp": timestamp,
        "id": id
    };

    const payload = JSON.stringify(body);
    const signature = await generateSignature(payload, env.COINDCX_SECRET_KEY);

    const response = await fetch(baseUrl + endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-AUTH-APIKEY": env.COINDCX_API_KEY,
            "X-AUTH-SIGNATURE": signature
        },
        body: payload
    });

    const data = await response.json();
    return data;
}

export async function cancelAllOrders(env) {
    const baseUrl = "https://api.coindcx.com";
    const endpoint = "/exchange/v1/derivatives/futures/positions/cancel_all_open_orders";

    const timestamp = Math.floor(Date.now());

    const body = {
        "timestamp": timestamp,
        "margin_currency_short_name": ["USDT"]
    };

    const payload = JSON.stringify(body);
    const signature = generateSignature(payload, env.COINDCX_SECRET_KEY);

    const response = await fetch(baseUrl + endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-AUTH-APIKEY": env.COINDCX_API_KEY,
            "X-AUTH-SIGNATURE": signature
        },
        body: payload
    });

    const data = await response.json();
    return data;
}

export async function getOpenPositions(env) {
    const baseUrl = "https://api.coindcx.com";
    const endpoint = "/exchange/v1/derivatives/futures/positions";

    const timestamp = Math.floor(Date.now());

    const body = {
        "timestamp": timestamp,
        "page": "1",
        "size": "50", // Fetch enough positions
        "margin_currency_short_name": ["USDT", "INR"]
    };

    const payload = JSON.stringify(body);
    const signature = generateSignature(payload, env.COINDCX_SECRET_KEY);

    const response = await fetch(baseUrl + endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-AUTH-APIKEY": env.COINDCX_API_KEY,
            "X-AUTH-SIGNATURE": signature
        },
        body: payload
    });

    const data = await response.json();
    return data;
}

export async function getAccountBalance(env) {
    const baseUrl = "https://api.coindcx.com";
    const endpoint = "/exchange/v1/derivatives/futures/positions/cross_margin_details";

    const timestamp = Math.floor(Date.now());

    const body = {
        "timestamp": timestamp
    };

    const payload = JSON.stringify(body);
    const signature = generateSignature(payload, env.COINDCX_SECRET_KEY);

    const response = await fetch(baseUrl + endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-AUTH-APIKEY": env.COINDCX_API_KEY,
            "X-AUTH-SIGNATURE": signature
        },
        body: payload
    });

    const data = await response.json();
    return data;
}

export async function getFuturesWallets(env) {
    const baseUrl = "https://api.coindcx.com";
    const endpoint = "/exchange/v1/derivatives/futures/wallets";

    const timestamp = Date.now();
    // For GET requests, the payload for signature is an empty string
    const payload = "";
    const signature = generateSignature(payload, env.COINDCX_SECRET_KEY);

    const response = await fetch(`${baseUrl}${endpoint}?timestamp=${timestamp}`, {
        method: "GET",
        headers: {
            "X-AUTH-APIKEY": env.COINDCX_API_KEY,
            "X-AUTH-SIGNATURE": signature
        }
    });

    const data = await response.json();
    return data;
}

export async function getWalletBalances(env) {
    const baseUrl = "https://api.coindcx.com";
    const endpoint = "/exchange/v1/users/balances";

    const timestamp = Math.floor(Date.now());

    const body = {
        "timestamp": timestamp
    };

    const payload = JSON.stringify(body);
    const signature = generateSignature(payload, env.COINDCX_SECRET_KEY);

    const response = await fetch(baseUrl + endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-AUTH-APIKEY": env.COINDCX_API_KEY,
            "X-AUTH-SIGNATURE": signature
        },
        body: payload
    });

    const data = await response.json();
    return data;
}
export async function getOrders(env, status = null) {
    const baseUrl = "https://api.coindcx.com";
    const endpoint = "/exchange/v1/derivatives/futures/orders";

    const timestamp = Math.floor(Date.now());

    const body = {
        "timestamp": timestamp,
        "page": "1",
        "size": "50"
    };

    if (status) {
        body.status = status;
    }

    const payload = JSON.stringify(body);
    const signature = generateSignature(payload, env.COINDCX_SECRET_KEY);

    const response = await fetch(baseUrl + endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-AUTH-APIKEY": env.COINDCX_API_KEY,
            "X-AUTH-SIGNATURE": signature
        },
        body: payload
    });

    const data = await response.json();
    return data;
}
export async function getTradeHistory(env) {
    const baseUrl = "https://api.coindcx.com";
    const endpoint = "/exchange/v1/derivatives/futures/trades";

    const timestamp = Math.floor(Date.now());

    const body = {
        "timestamp": timestamp,
        // "page": "1",
        "size": "10"
    };

    const payload = JSON.stringify(body);
    const signature = generateSignature(payload, env.COINDCX_SECRET_KEY);

    const response = await fetch(baseUrl + endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-AUTH-APIKEY": env.COINDCX_API_KEY,
            "X-AUTH-SIGNATURE": signature
        },
        body: payload
    });

    const data = await response.json();
    return data;
}
