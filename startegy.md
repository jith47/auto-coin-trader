# DOGE MICROSTRUCTURE SCALPER v1.0

---

## CORE PHILOSOPHY

Trade DOGE as a leveraged derivative of BTC. BTC tells you which direction. DOGE order flow tells you when. Five independent modules each cast a directional vote. When enough modules agree, you trade. When they stop agreeing, you exit — usually before the stop loss is hit. The short side has a structural edge over longs. Every parameter in the strategy scales automatically with volatility so the system works on quiet days and chaotic days without manual adjustment.

---

## DATA SOURCES (All from Binance REST API)

```
DOGEUSDT:
  Order book depth (top 20 levels, spot /api/v3/depth)
  5-minute klines (last 30 candles)
  1-minute klines (last 60 candles, for TFI + volume ratio)
  Funding rate (fapi.binance.com/fapi/v1/premiumIndex, fallback to neutral if geo-blocked)
  24-hour ticker stats

BTCUSDT:
  5-minute klines (last 30 candles)
  1-hour klines (last 3 candles)
  24-hour ticker stats

ETHUSDT + SOLUSDT:
  24-hour ticker stats
```

**The bot runs on a Cloudflare Worker cron (1-minute minimum interval).** Trade flow imbalance (Module 1B) is simulated using kline taker-buy-volume from REST API since CF Workers cannot hold WebSocket connections.

---

## STEP 0 — VOLATILITY REGIME

Before doing anything else, measure how volatile the market is right now. This single number scales every stop loss, take profit, and trailing distance in the entire strategy.

```
ATR = average true range of DOGE's last 12 five-minute candles
ATR_pct = (ATR / current price) × 100
```

| ATR_pct | Regime | Meaning |
|---|---|---|
| Below 0.15% | Low volatility | Tight stops, small targets, fewer signals |
| 0.15% to 0.45% | Normal volatility | Standard parameters |
| Above 0.45% | High volatility | Wide stops, large targets, be selective |

**How it scales — example:**

| Parameter | Quiet day (ATR 0.10%) | Normal day (ATR 0.30%) | Volatile day (ATR 0.60%) |
|---|---|---|---|
| Hard stop | 0.30% (clamped minimum) | 0.45% | 0.90% |
| First take profit | 0.40% (clamped minimum) | 0.60% | 1.20% |
| Trailing distance | 0.04% | 0.12% | 0.24% |

All clamps: stop loss between 0.3% and 1.2%, take profit between 0.4% and 1.8%.

---

## THE FIVE MODULES

Each module looks at one dimension of the market and produces:
- A **direction** (long, short, or neutral)
- A **point value** (higher = stronger conviction)

---

### MODULE 1 — FLOW IMBALANCE (max 25 points)

*What it measures: Is real money buying or selling DOGE right now?*

**Part A — Order Book Imbalance (max 12 points)**

Look at the DOGE order book within 0.3% of the current price in both directions.

```
bid_volume = total bid quantity within 0.3% below mid price
ask_volume = total ask quantity within 0.3% above mid price
OBI = (bid_volume − ask_volume) / (bid_volume + ask_volume)
```

OBI ranges from −1.0 (all sellers) to +1.0 (all buyers).

| OBI | Points | Direction |
|---|---|---|
| Above +0.40 | 12 | Long |
| +0.20 to +0.40 | 6 | Long |
| −0.20 to +0.20 | 0 | Neutral |
| −0.40 to −0.20 | 6 | Short |
| Below −0.40 | 12 | Short |

**Part B — Trade Flow Imbalance (max 13 points)**

Since CF Workers can't hold WebSocket connections, TFI is computed from 1-minute kline taker-buy-volume over a rolling 5-minute window.

```
buy_volume = sum of taker buy volumes over last 5 one-minute candles
sell_volume = total volume − buy_volume
TFI = (buy_volume − sell_volume) / (buy_volume + sell_volume)
TFI_slope = current TFI minus TFI from 60 seconds ago (using shifted window)
```

| TFI | Points | Direction |
|---|---|---|
| Above +0.25 | 8 | Long |
| +0.10 to +0.25 | 5 | Long |
| −0.10 to +0.10 | 0 | Neutral |
| −0.25 to −0.10 | 5 | Short |
| Below −0.25 | 8 | Short |
| TFI_slope > +0.05 in trade direction | +3 | Bonus |
| OBI and TFI agree on direction | +2 | Bonus |

**Conflict rule:** If OBI says long but TFI says short (or vice versa), trust TFI because executed trades are real while resting orders can be spoofed. Cap this module at 10 points when they conflict.

---

### MODULE 2 — BTC STRUCTURAL ANCHOR (max 25 points)

*What it measures: What is BTC doing and what structure has it formed?*

**Part A — BTC Trend Position (max 10 points)**

```
EMA21 = 21-period exponential moving average of BTC 5-minute closes
btc_1h_change = BTC percentage change over the last hour
```

| Condition | Points | Direction |
|---|---|---|
| BTC above EMA21 and 1H change above +0.3% | 10 | Long |
| BTC above EMA21 and 1H change between −0.3% and +0.3% | 5 | Long |
| BTC below EMA21 and 1H change below −0.3% | 10 | Short |
| BTC below EMA21 and 1H change between −0.3% and +0.3% | 5 | Short |
| BTC crossed EMA21 within last 3 five-minute candles | 0 | Neutral |

**Part B — BTC Price Structure (max 15 points)**

Look at the last 3 BTC five-minute candles and compare them to swing highs and lows identified over the last 20 candles.

A **swing high** is a candle whose high is higher than both its neighbors. A **swing low** is a candle whose low is lower than both its neighbors.

| Pattern | How to detect it | Points | Direction |
|---|---|---|---|
| Sweep-reclaim bullish | Price dipped below a swing low then closed back above it | 15 | Long |
| Sweep-reclaim bearish | Price spiked above a swing high then closed back below it | 15 | Short |
| Rejection bullish | Lower wick is more than 60% of candle range, close in top 40%, near a swing low | 10 | Long |
| Rejection bearish | Upper wick is more than 60% of candle range, close in bottom 40%, near a swing high | 10 | Short |
| Breakout | Close above highest swing high with volume above 1.5× the 20-candle average | 8 | Long |
| Breakdown | Close below lowest swing low with volume above 1.5× the 20-candle average | 8 | Short |
| Ranging | No pattern detected | 0 | Neutral |

**Invalidation rule:** A pattern detected on one candle is cancelled if the next candle closes beyond the pattern level.

**Disagreement rule:** If trend direction (Part A) and structure direction (Part B) disagree, use whichever has more points.

---

### MODULE 3 — DOGE RELATIVE PERFORMANCE (max 20 points)

*What it measures: Is DOGE doing what it should be doing relative to BTC, or is it diverging?*

```
beta = covariance(DOGE returns, BTC returns) / variance(BTC returns)
expected_doge_1h = BTC 1-hour change × beta
actual_doge_1h = DOGE 1-hour change
deviation = actual − expected
```

| Deviation | Points | Direction |
|---|---|---|
| Below −1.0% | 20 | Short |
| −1.0% to −0.5% | 12 | Short |
| −0.5% to +0.5% | 5 | Same as BTC trend direction |
| +0.5% to +1.0% | 12 | Long |
| Above +1.0% | 20 | Long |

**Conflict penalty:** If this module's direction opposes BTC trend direction from Module 2A, cap at 8 points.

---

### MODULE 4 — VOLATILITY CONTEXT (max 15 points)

```
range_ratio = current_candle_range / ATR_pct
```

**Overextension (range_ratio > 2.5):** 15 points in mean-reversion direction if swing level not broken. Specifically:
- Close in top 30% of range and didn't break swing high → 15 SHORT (mean revert)
- Close in bottom 30% of range and didn't break swing low → 15 LONG (mean revert)
- If a swing level was broken → 0 points (real breakout, don't fade)

**Normal range (0.8–2.5):** 5 points in BTC trend direction.
**Low range (< 0.8):** 0 points.

---

### MODULE 5 — FUNDING RATE PRESSURE (max 15 points)

| Funding Rate | Points | Direction |
|---|---|---|
| Above +0.05% | 15 | Short |
| +0.03% to +0.05% | 10 | Short |
| +0.01% to +0.03% | 5 | Short |
| −0.01% to +0.01% | 0 | Neutral |
| −0.03% to −0.01% | 5 | Long |
| −0.05% to −0.03% | 10 | Long |
| Below −0.05% | 15 | Long |

---

## SIGNAL AGGREGATION

### Score Deductions (applied before threshold check)

Before checking entry thresholds, the raw score is reduced by deductions for adverse conditions:

| Condition | Deduction |
|---|---|
| Thin market: 10-min avg volume < 50% of 1h avg | −15 |
| Sector headwind: ETH and SOL both oppose trade direction | −10 |
| Near 24h extreme: within 0.5% of 24h high (long) or low (short) | −10 |
| Daily overextension: DOGE daily change > 5% in trade direction | −10 |

### Entry Thresholds

| Direction | Score Required | Clarity Required | Modules Required |
|---|---|---|---|
| Short | 55 or higher | 15 or higher | 3 or more supporting |
| Long | 65 or higher | 20 or higher | 3 or more supporting |

### RRR Gate

After a signal passes the threshold, a **reward-to-risk ratio check** is applied:

```
RRR = TP_pct / SL_pct
```

If `RRR < 1.2`, the trade is rejected. This prevents lopsided trades that can occur when ATR clamps compress the TP while the SL stays wide (or vice versa).

---

## KILL SWITCHES (KS1–KS6)

KS1: No long within 0.5% of 24h high. No short within 0.5% of 24h low.
KS2: No trade in same direction as daily move if DOGE daily change exceeds 6%.
KS3: No trade if 10-min avg volume < 30% of 1-hour average.
KS4: No long if funding > +0.05%. No short if funding < -0.05%.
KS5: No trade if 3+ losses today.
KS6: No trade if BTC 5m ATR > 3× its 1h average ATR.

---

## POSITION SIZING

```
risk_amount = account balance × 1%
stop_distance = 1.5 × ATR_pct
base_position = risk_amount / (entry price × stop_distance)

Conviction scaling:
  3 modules → 70% of base
  4 modules → 85% of base
  5 modules → 100% of base

Max leverage: 20×
```

If effective leverage (`notional / balance`) exceeds 20×, quantity is capped to stay within the limit.

---

## EXIT MANAGEMENT — 4 LAYERS

**Layer 1 — Hard Stop:** 1.5 × ATR_pct from entry. Moves to breakeven at +1.0 ATR profit.

**Layer 2 — Edge Decay:** Re-run all 5 modules each tick with current price. Apply granular exit rules:
- **R1:** Supporting modules drop to ≤ 2 while in a loss → exit immediately (tight trail not practical with 1-min cron)
- **R2:** Supporting modules drop to 1 → if in loss, exit immediately; if in profit, continue monitoring
- **R3:** 2 or more modules actively opposing → exit immediately
- **R4:** 0 modules still supporting → exit immediately

**Layer 3 — Profit Management:**
- **Breakeven:** SL moves to entry price at +1.0 ATR profit
- **Partial TP:** Close 60% of position at +1.5 ATR profit. After partial close, SL is moved to breakeven.
- **Tight trail:** At +2.5 ATR profit (after partial), tighten trailing distance to 0.25 × ATR

**Layer 4 — Time Stop:**
- 8 min if profit < +0.5 ATR
- 20 min unconditional (any position held > 20 min is closed)

---

## RISK MANAGEMENT

```
Risk per trade:         1% of account
Max daily drawdown:     3%
Max consecutive losses: 3 → stop for the day
Loss cooldown:          30 minutes
Max account drawdown:   20% from peak → halt
Max open positions:     1
Max trades per day:     10
```

---

## MOCK TRADING MODE

The system supports a mock trading mode with simulated INR balance (starting at ₹2,500 with USD/INR rate of 85). In mock mode:

- No real orders are sent to CoinDCX
- Entry and exit fees are simulated at 0.1% of notional (USDT value × 85)
- PnL is calculated in INR and applied to the mock balance
- The circuit breaker (20% max drawdown) uses the mock balance
- Order IDs are prefixed with `MOCK_`

---

## CF WORKER IMPLEMENTATION NOTES

- **No WebSocket:** Trade flow imbalance (Module 1B) is simulated using kline taker-buy-volume from REST API.
- **Funding rate:** Fetched from `fapi.binance.com/fapi/v1/premiumIndex`. Falls back to neutral if geo-blocked.
- **Cron runs every 1 minute** (CF Worker minimum). Edge decay and exit management execute per tick.
- **Order book depth:** Uses Binance spot `/api/v3/depth` (top 20 levels).
- **Market data endpoint:** Uses `data-api.binance.vision` for spot data (klines, depth, ticker).