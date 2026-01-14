# Real-Time Delta Data API Research

## Summary

**Pre-calculated CVD (Cumulative Volume Delta) is NOT available for free** from any major API provider. CoinGlass offers it, but only on paid plans ($49+/month).

However, you can **calculate CVD yourself for free** using Binance WebSocket API, which provides real-time trade data with buy/sell direction.

---

## Strategy Data Requirements

Based on your `current_strategy.md` and `grok_strategy.md`, you need:

| Data | Free Source | Method |
|------|-------------|--------|
| **CVD (Cumulative Volume Delta)** | Binance WebSocket `aggTrades` | Calculate from trade data |
| **Delta (Volume Delta)** | Binance WebSocket `aggTrades` | Calculate from trade data |
| **Funding Rate** | Binance REST API | Free endpoint |
| **Open Interest** | Binance REST API | Free endpoint |
| **Price/OHLCV** | Binance REST/WebSocket | Free endpoints |
| **24h % Change** | Binance REST API | Free endpoint |

---

## Free API Options

### 1. **Binance WebSocket API (RECOMMENDED - Completely Free)**

**Trades Data for CVD Calculation:**
```
wss://fstream.binance.com/ws/btcusdt@aggTrade   # BTC Futures
wss://fstream.binance.com/ws/dogeusdt@aggTrade  # DOGE Futures
```

**Kline/Candlestick Data:**
```
wss://fstream.binance.com/ws/btcusdt@kline_1m   # 1-minute candles
wss://fstream.binance.com/ws/dogeusdt@kline_1m
```

**Mark Price + Funding Rate:**
```
wss://fstream.binance.com/ws/btcusdt@markPrice  # Real-time
wss://fstream.binance.com/ws/dogeusdt@markPrice
```

**Ticker (24h stats including volume, price change):**
```
wss://fstream.binance.com/ws/btcusdt@ticker
wss://fstream.binance.com/ws/dogeusdt@ticker
```

### 2. **Binance REST API (Free)**

**Funding Rate History:**
```
GET https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1
```

**Open Interest:**
```
GET https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT
```

**Klines/Candlesticks:**
```
GET https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=60
```

---

## How to Calculate CVD from Trade Data

The key insight is in the `aggTrade` message's `m` field (buyer is market maker):

```javascript
// If m = true  → Seller was aggressive (SELL pressure)
// If m = false → Buyer was aggressive (BUY pressure)

// Delta = Σ(buy_volume) - Σ(sell_volume)
// CVD = Running cumulative sum of Delta
```

**aggTrade Message Format:**
```json
{
  "e": "aggTrade",      // Event type
  "s": "BTCUSDT",       // Symbol
  "p": "97500.00",      // Price
  "q": "0.50",          // Quantity
  "f": 123456789,       // First trade ID
  "l": 123456790,       // Last trade ID
  "T": 1234567890123,   // Trade time
  "m": false            // Buyer is market maker (false = aggressive buy)
}
```

---

## Correlation Calculation

For correlation between BTC and DOGE, you need to:
1. Collect synchronized price ticks for both symbols
2. Calculate rolling Pearson correlation over N periods (e.g., 60 candles)

Formula:
```
correlation = Σ((btc_i - btc_mean) * (doge_i - doge_mean)) / 
              sqrt(Σ(btc_i - btc_mean)² * Σ(doge_i - doge_mean)²)
```

---

## Lag Score Calculation

From your strategy:
```
DOGE Lag Score = BTC % move ÷ DOGE % move (over last 4 minutes)
```

This can be calculated from the 1-minute kline data:
```javascript
const btcChange = (btcCurrentPrice - btcPrice4MinAgo) / btcPrice4MinAgo * 100;
const dogeChange = (dogeCurrentPrice - dogePrice4MinAgo) / dogePrice4MinAgo * 100;
const lagScore = btcChange / dogeChange;
```

---

## Rate Limits

**Binance WebSocket:**
- No rate limits on data consumption
- Max 5 connections per IP
- Can subscribe to multiple streams in one connection

**Binance REST API:**
- 1200 requests per minute per IP (weight-based)
- Most endpoints have weight of 1-10

---

## Advantages Over Screenshot Approach

| Aspect | Screenshots | API |
|--------|-------------|-----|
| Latency | 5-30 seconds | <100ms |
| Accuracy | AI interpretation variance | Exact values |
| Reliability | Depends on UI loading | Direct data |
| Cost | Playwright resource usage | Free API |
| Automation | Complex Playwright scripting | Simple HTTP/WS |

---

## Files Created

1. `api/binance_delta_client.js` - Full implementation of Delta/CVD/Funding client
2. `api/delta_strategy_engine.js` - Strategy conditions as code (example)
3. `api/DELTA_API_RESEARCH.md` - This documentation

---

## Next Steps

1. Review the `binance_delta_client.js` implementation
2. Run it locally to see real-time data flowing
3. Adapt `delta_strategy_engine.js` to match your exact strategy rules
4. Replace screenshot-based analysis with API-based decisions
