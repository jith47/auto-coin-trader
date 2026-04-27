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
            "take_profit_price": takeProfit,
            // Sub-variants for compatibility with different futures API versions
            "stop_loss": stopLoss,
            "take_profit": takeProfit
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

export async function closePartialPosition(env, pair, side, quantity, leverage, marginCurrency = "INR") {
    const baseUrl = "https://api.coindcx.com";
    const endpoint = "/exchange/v1/derivatives/futures/orders/create";
    const timestamp = Date.now();
    const body = {
        "timestamp": timestamp,
        "order": {
            "side": side.toLowerCase(),
            "pair": pair,
            "order_type": "market_order",
            "total_quantity": quantity,
            "leverage": leverage,
            "notification": "no_notification",
            "position_margin_type": "isolated",
            "margin_currency_short_name": marginCurrency,
            "reduce_only": true,
        }
    };
    const payload = JSON.stringify(body);
    console.log(`[CoinDCX] Partial close: ${side} ${quantity} ${pair}`);
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
    console.log('[CoinDCX] Partial close result:', JSON.stringify(data));
    return data;
}

function generateSignature(payload, secret) {
    if (!secret) {
        throw new Error('CoinDCX Secret Key is missing in environment (env.COINDCX_SECRET_KEY)');
    }
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

    let data;
    try {
        const response = await fetch(baseUrl + endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-AUTH-APIKEY": env.COINDCX_API_KEY,
                "X-AUTH-SIGNATURE": signature
            },
            body: payload
        });

        if (!response.ok) {
            console.error(`[CoinDCX] getOpenPositions HTTP ${response.status}`);
            return null;
        }

        data = await response.json();
    } catch (err) {
        console.error(`[CoinDCX] getOpenPositions fetch/parse error: ${err.message}`);
        return null; // Return null to indicate API error, NOT an empty list
    }

    if (!Array.isArray(data)) {
        console.error('[CoinDCX] getOpenPositions returned non-array:', JSON.stringify(data));
        return null;
    }
    // Normalize CoinDCX fields to standard format
    return data.map(p => ({
        ...p,
        quantity: p.active_pos !== undefined ? p.active_pos : p.quantity,
        symbol: p.pair || p.symbol
    }));
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
        "size": "50" // Increased from 10 to be more robust for reconciliation
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
        "size": "50" // Increased from 10 to find orphaned entry trades
    };

    const payload = JSON.stringify(body);
    const signature = generateSignature(payload, env.COINDCX_SECRET_KEY);

    try {
        const response = await fetch(baseUrl + endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-AUTH-APIKEY": env.COINDCX_API_KEY,
                "X-AUTH-SIGNATURE": signature
            },
            body: payload
        });

        if (!response.ok) {
            console.error(`[CoinDCX] getTradeHistory HTTP ${response.status}`);
            return null;
        }

        const data = await response.json();
        return data;
    } catch (err) {
        console.error(`[CoinDCX] getTradeHistory fetch/parse error: ${err.message}`);
        return null;
    }
}

export async function getMarketPrice(pair) {
    // pair example: "B-DOGE_USDT"
    const baseUrl = "https://public.coindcx.com";
    const endpoint = "/market_data/candlesticks";

    // Get last 1 minute candle
    const to = Math.floor(Date.now() / 1000);
    const from = to - 120; // 2 minutes ago to be safe

    const url = `${baseUrl}${endpoint}?pair=${pair}&from=${from}&to=${to}&resolution=1&pcode=f`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (Array.isArray(data) && data.length > 0) {
            // Data is usually sorted by time desc, but let's be safe
            // Format: { open, high, low, close, volume, time }
            // We want the latest 'close'
            const latest = data[0];
            return parseFloat(latest.close);
        }
        return null;
    } catch (e) {
        console.error("Error fetching market price:", e);
        return null;
    }
}

/**
 * Fetch instrument details for a futures pair (public endpoint, no auth).
 * Returns { maxLeverage, minQuantity, stepSize } or null on error.
 */
export async function getInstrumentDetails(pair) {
    try {
        // Try the specific instrument data endpoint
        const urls = [
            `https://api.coindcx.com/exchange/v1/derivatives/futures/data/instrument?pair=${encodeURIComponent(pair)}`,
            `https://api.coindcx.com/exchange/v1/derivatives/futures/instrument_details?pair=${encodeURIComponent(pair)}`,
            `https://public.coindcx.com/market_data/market_details` // General fallback
        ];

        let data = null;
        for (const url of urls) {
            try {
                const response = await fetch(url);
                if (response.ok) {
                    const resJson = await response.json();
                    if (Array.isArray(resJson)) {
                        data = resJson.find(i => i.pair === pair || i.symbol === pair || i.coindcx_name === pair);
                    } else if (resJson && typeof resJson === 'object') {
                        data = resJson.pair === pair ? resJson : (resJson.data || resJson);
                    }
                    if (data) break;
                }
            } catch (innerErr) {
                console.error(`[CoinDCX] Failed fetch for ${url}:`, innerErr.message);
            }
        }

        if (!data) {
            // Last resort: active_instruments
            const listUrl = `https://api.coindcx.com/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=INR`;
            const listRes = await fetch(listUrl);
            if (listRes.ok) {
                const instrumentsList = await listRes.json();
                data = Array.isArray(instrumentsList) ? instrumentsList.find(i => i.pair === pair) : null;
            }
        }

        if (data) {
            return {
                maxLeverage: parseInt(data.max_leverage || data.max_leverage_long || 20),
                minQuantity: parseFloat(data.min_quantity || data.min_order_size || 1),
                stepSize: parseFloat(data.step || data.quantity_step || 1),
                tickSize: parseFloat(data.tick_size || data.min_price_increment || 0.00001),
            };
        }

        console.error(`[CoinDCX] Could not find instrument details for ${pair} across all endpoints`);
        return null;
    } catch (e) {
        console.error('[CoinDCX] Error fetching instrument details:', e.message);
        return null;
    }
}

/**
 * Fetch INR balance from the futures wallet.
 * Returns the available INR balance as a number, or null on error.
 */
export async function getINRFuturesBalance(env) {
    try {
        const wallets = await getFuturesWallets(env);
        if (Array.isArray(wallets)) {
            const inrWallet = wallets.find(w =>
                w.currency_short_name === 'INR' || w.currency === 'INR'
            );
            if (inrWallet) {
                const balance = parseFloat(inrWallet.balance || inrWallet.available_balance || 0);
                const locked = parseFloat(inrWallet.locked_balance || 0);
                return balance - locked;
            }
        }
        console.error('[CoinDCX] No INR wallet found in futures wallets:', JSON.stringify(wallets));
        return null;
    } catch (e) {
        console.error('[CoinDCX] Error fetching INR futures balance:', e.message);
        return null;
    }
}
