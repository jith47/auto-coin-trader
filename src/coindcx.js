import crypto from 'node:crypto';

function generateSignature(payload, secret) {
    if (!secret) {
        throw new Error('CoinDCX Secret Key is missing in environment (env.COINDCX_SECRET_KEY)');
    }
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function fetchWithFallback(env, endpointPath, body = {}) {
    const baseUrls = ["https://api.coindcx.com"];
    
    // Auto-inject or update timestamp to ensure signature validity
    body.timestamp = body.timestamp || Date.now();
    
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
}

export async function placeOrder(env, pair, side, quantity, leverage, stopLoss, takeProfit, orderType, price, marginCurrency = "USDT") {
    const endpoint = "/exchange/v1/derivatives/futures/orders/create";

    const body = {
        "order": {
            "side": side.toLowerCase(), // "buy" or "sell"
            "pair": pair, // e.g., "B-DOGE_USDT"
            "order_type": "market_order",
            "total_quantity": quantity, // e.g., 0.001
            "leverage": leverage,
            "notification": "no_notification",
            "position_margin_type": "isolated", // Isolated margin for safety
            "margin_currency_short_name": marginCurrency,
            "stop_loss_price": stopLoss,
            "take_profit_price": takeProfit,
            "stop_loss": stopLoss,
            "take_profit": takeProfit
        }
    };

    if (orderType === "LIMIT" && price) {
        body.order.price = price;
    }

    console.log("payload: ", JSON.stringify(body));
    const res = await fetchWithFallback(env, endpoint, body);
    console.log("coindcx response: ", JSON.stringify(res));

    if (!res.ok) {
        return { error: `HTTP ${res.status}`, message: res.text.slice(0, 100) };
    }
    return res.data;
}

export async function closePartialPosition(env, pair, side, quantity, leverage, marginCurrency = "INR") {
    const endpoint = "/exchange/v1/derivatives/futures/orders/create";
    const body = {
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
    console.log(`[CoinDCX] Partial close: ${side} ${quantity} ${pair}`);
    const res = await fetchWithFallback(env, endpoint, body);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    console.log('[CoinDCX] Partial close result:', JSON.stringify(res.data));
    return res.data;
}

export async function cancelOrder(env, id) {
    const endpoint = "/exchange/v1/derivatives/futures/orders/cancel";
    const body = {
        "id": id
    };
    const res = await fetchWithFallback(env, endpoint, body);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return res.data;
}

export async function cancelAllOrders(env) {
    const endpoint = "/exchange/v1/derivatives/futures/positions/cancel_all_open_orders";
    const body = {
        "margin_currency_short_name": ["USDT"]
    };
    const res = await fetchWithFallback(env, endpoint, body);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return res.data;
}

export async function getOpenPositions(env) {
    const endpoint = "/exchange/v1/derivatives/futures/positions";
    const body = {
        "page": "1",
        "size": "50", // Fetch enough positions
        "margin_currency_short_name": ["USDT", "INR"]
    };

    const res = await fetchWithFallback(env, endpoint, body);
    if (!res.ok) {
        console.error(`[CoinDCX] getOpenPositions failed on all endpoints.`);
        return null;
    }
    const data = res.data;

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
    const endpoint = "/exchange/v1/derivatives/futures/positions/cross_margin_details";
    const res = await fetchWithFallback(env, endpoint, {});
    if (!res.ok) return null;
    return res.data;
}

export async function getFuturesWallets(env) {
    const endpoints = [
        "https://api.coindcx.com/exchange/v1/derivatives/futures/wallets"
    ];

    for (const url of endpoints) {
        try {
            const timestamp = Date.now();
            const signature = generateSignature("", env.COINDCX_SECRET_KEY);

            const response = await fetch(`${url}?timestamp=${timestamp}`, {
                method: "GET",
                headers: {
                    "X-AUTH-APIKEY": env.COINDCX_API_KEY,
                    "X-AUTH-SIGNATURE": signature
                }
            });

            if (response.ok) {
                const data = await response.json();
                if (Array.isArray(data)) return data;
            }
        } catch (e) {
            console.warn(`[CoinDCX] Wallet fetch failed for ${url}:`, e.message);
        }
    }
    return null;
}

export async function getWalletBalances(env) {
    const endpoint = "/exchange/v1/users/balances";
    const res = await fetchWithFallback(env, endpoint, {});
    if (!res.ok) return [];
    return res.data;
}

export async function getOrders(env, status = null) {
    const endpoint = "/exchange/v1/derivatives/futures/orders";
    const body = {
        "page": "1",
        "size": "50" // Robust for reconciliation
    };

    if (status) {
        body.status = status;
    }

    const res = await fetchWithFallback(env, endpoint, body);
    if (!res.ok) return null;
    return res.data;
}

export async function getTradeHistory(env) {
    const endpoint = "/exchange/v1/derivatives/futures/trades";
    const body = {
        "size": "50"
    };
    const res = await fetchWithFallback(env, endpoint, body);
    if (!res.ok) {
        console.error(`[CoinDCX] getTradeHistory failed on all endpoints`);
        return null;
    }
    return res.data;
}

export async function getMarketPrice(pair) {
    const baseUrl = "https://public.coindcx.com";
    const endpoint = "/market_data/candlesticks";

    const to = Math.floor(Date.now() / 1000);
    const from = to - 120; // 2 minutes ago to be safe

    const url = `${baseUrl}${endpoint}?pair=${pair}&from=${from}&to=${to}&resolution=1&pcode=f`;

    try {
        const response = await fetch(url);
        const json = await response.json();

        if (json?.s === 'ok' && Array.isArray(json.data) && json.data.length > 0) {
            const latest = [...json.data].sort((a, b) => b.time - a.time)[0];
            return parseFloat(latest.close);
        }
        return null;
    } catch (e) {
        console.error("Error fetching market price:", e);
        return null;
    }
}

export async function getInstrumentDetails(pair) {
    try {
        const urls = [
            `https://api.coindcx.com/exchange/v1/derivatives/futures/data/instrument?pair=${encodeURIComponent(pair)}`,
            `https://api.coindcx.com/exchange/v1/derivatives/futures/instrument_details?pair=${encodeURIComponent(pair)}`,
            `https://api.coindcx.com/exchange/v1/markets_details`
        ];

        let data = null;
        for (const url of urls) {
            try {
                const response = await fetch(url);
                if (response.ok) {
                    try {
                        const resJson = await response.json();
                        if (Array.isArray(resJson)) {
                            data = resJson.find(i => i.pair === pair || i.symbol === pair || i.coindcx_name === pair);
                        } else if (resJson && typeof resJson === 'object') {
                            if (resJson.instrument && (resJson.instrument.pair === pair || resJson.instrument.symbol === pair)) {
                                data = resJson.instrument;
                            } else if (resJson.data && (resJson.data.pair === pair || resJson.data.symbol === pair)) {
                                data = resJson.data;
                            } else if (resJson.pair === pair || resJson.symbol === pair) {
                                data = resJson;
                            }
                        }
                        if (data) break;
                    } catch (e) {
                        console.error(`[CoinDCX] JSON parse error for ${url}`);
                    }
                }
            } catch (innerErr) {
                console.error(`[CoinDCX] Failed fetch for ${url}:`, innerErr.message);
            }
        }

        if (data) {
            const maxLev = parseInt(data.max_leverage || data.max_leverage_long || data.max_leverage_short || 20);
            
            let tickSize = parseFloat(data.tick_size || data.price_increment || data.min_price_increment || 0.00001);
            if (tickSize === 0.00001 && data.base_currency_precision !== undefined) {
                tickSize = parseFloat((1 / Math.pow(10, data.base_currency_precision)).toFixed(data.base_currency_precision));
            }
            
            let stepSize = parseFloat(data.step || data.quantity_increment || data.quantity_step || 1);
            if (stepSize === 1 && data.target_currency_precision !== undefined) {
                stepSize = parseFloat((1 / Math.pow(10, data.target_currency_precision)).toFixed(data.target_currency_precision));
            }

            return {
                maxLeverage: maxLev > 0 ? maxLev : 20,
                minQuantity: parseFloat(data.min_quantity || data.min_order_size || data.min_trade_size || 0.001),
                stepSize: stepSize,
                tickSize: tickSize,
                minNotional: parseFloat(data.min_notional || 0)
            };
        }

        console.error(`[CoinDCX] Could not find instrument details for ${pair} across all endpoints`);
        
        if (pair.includes('DOGE')) {
            console.warn('[CoinDCX] Using hardcoded defaults for DOGE');
            return {
                maxLeverage: 20,
                minQuantity: 2, 
                stepSize: 1,
                tickSize: 0.00001,
                minNotional: 0
            };
        }
        if (pair.includes('ETH')) {
            console.warn('[CoinDCX] Using hardcoded defaults for ETH');
            return {
                maxLeverage: 20,
                minQuantity: 0.001,
                stepSize: 0.001,
                tickSize: 0.01,
                minNotional: 24.0
            };
        }
        return null;
    } catch (e) {
        console.error('[CoinDCX] Error fetching instrument details:', e.message);
        return null;
    }
}

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
            console.error('[CoinDCX] INR wallet missing from futures list');
        }
        return null;
    } catch (e) {
        console.error('[CoinDCX] Error fetching INR futures balance:', e.message);
        return null;
    }
}
