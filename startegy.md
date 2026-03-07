# OI FLOW RIDER v1.0

---

## CORE PHILOSOPHY

Follow the institutional money. When Open Interest surges (institutions opening positions), enter in the same direction. When OI drops (institutions closing), exit early. Don't predict — react to real flow data.

The strategy uses a **confluence model** — a trade only fires when 3 out of 4 independent signals agree on direction. This makes trap trades (fake OI spikes) much less likely.

---

## DATA SOURCES (Binance Futures + Spot REST API)

```
Institutional Flow (fapi.binance.com):
  Open Interest:         /fapi/v1/openInterest (real-time)
  Global L/S Ratio:      /futures/data/globalLongShortAccountRatio (5m buckets)
  Top Trader L/S Ratio:  /futures/data/topLongShortPositionRatio (5m buckets)
  Taker Buy/Sell Ratio:  /futures/data/takerlongshortRatio (5m buckets)
  Funding Rate:          /fapi/v1/premiumIndex

Price Data (data-api.binance.vision):
  5-minute klines (30 candles, for ATR)
  1-minute klines (10 candles, for price momentum)
  24-hour ticker stats
```

**Runs on CF Worker cron (1-min interval).** OI snapshots stored in D1 for trend analysis.

---

## OI TRACKING

Every cron tick:
1. Fetch current OI → store in `oi_snapshots` table
2. Compute rolling changes:

```
oi_change_5m  = (current_OI - OI_5min_ago) / OI_5min_ago × 100
oi_change_15m = (current_OI - OI_15min_ago) / OI_15min_ago × 100
oi_trend      = compare first-third vs last-third of 15min snapshots
                rising if >+0.3%, falling if <-0.3%, else flat
```

Old snapshots (>2 hours) are automatically cleaned up each tick.

---

## THE 4 CONFLUENCE SIGNALS

| # | Signal | Long Trigger | Short Trigger |
|---|--------|-------------|---------------|
| 1 | **OI Surge** | OI +1.5% in 5m AND price rising | OI +1.5% in 5m AND price falling |
| 2 | **Taker Ratio** | Buy/Sell ratio ≥ 1.15 | Buy/Sell ratio ≤ 0.85 |
| 3 | **Price Momentum** | 5m price change ≥ +0.3% | 5m price change ≤ -0.3% |
| 4 | **Top Trader Shift** | Top trader long % delta ≥ +0.02 | Top trader long % delta ≤ -0.02 |

**Entry requires 3 of 4 signals in the same direction.**

### Why each signal matters:

- **OI Surge** — Raw evidence of positions opening. Can be spoofed alone.
- **Taker Ratio** — Actual executed market orders. Hardest signal to fake.
- **Price Momentum** — Confirms which side is winning.
- **Top Trader Shift** — Smart money positioning. Harder to fake than retail.

### Anti-Trap Filter

Before entering, check the retail crowd:
- If >75% of retail accounts are already long → don't go long (crowded trade = trap)
- If >75% of retail accounts are already short → don't go short

---

## POSITION SIZING

```
ATR = average true range of DOGE 5m candles (12 periods)
SL_distance = 1.5 × ATR_pct, clamped [0.4%, 1.0%]
TP_distance = 2.0 × SL_distance (2:1 RRR)
risk_amount = account_balance × 1%
position_value = risk_amount / SL_distance
leverage = min(position_value / balance, 15×)
quantity = position_value / entry_price
```

---

## EXIT MANAGEMENT — 8 CHECKS (priority order)

| # | Check | Condition | Action |
|---|-------|-----------|--------|
| 1 | Hard Stop | Price hits SL | Exit immediately |
| 2 | Take Profit | Price hits TP | Exit immediately |
| 3 | **OI Drop** | OI falls >0.8% in 5m | Exit — institutions closing |
| 4 | **OI Trend Reversal** | OI trend = falling AND in loss | Exit — flow reversed |
| 5 | **Taker Reversal** | Taker ratio flips against position | Exit — selling pressure |
| 6 | **Top Trader Reversal** | Top traders flip against (delta > 2× threshold) | Exit — smart money leaving |
| 7 | Funding Extreme | Funding rate > 0.05% against position | Exit — carry cost |
| 8 | Time Stop | Held > 15 minutes | Exit — unconditional |

### Profit Management
- **Breakeven:** SL moves to entry at +1.0 ATR profit
- **Partial TP:** Close 50% at +1.5 ATR profit

---

## KILL SWITCHES (KS1–KS6)

```
KS1: 3 losses today → stop for the day
KS2: 20% account drawdown from peak → halt all trading
KS3: 15-minute cooldown after a loss
KS4: Max 8 trades per day
KS5: OI grew less than 0.5% in last 15 min → no trade (stagnant market)
KS6: Price within 0.5% of 24h high/low → no trade
```

---

## RISK MANAGEMENT

```
Risk per trade:         1% of account
Max leverage:           15×
Max daily drawdown:     3 losses
Max account drawdown:   20% from peak → halt
Cooldown after loss:    15 minutes
Max trades per day:     8
Max open positions:     1
```

---

## MOCK TRADING MODE

Mock mode with simulated INR balance (starting ₹2,500, USD/INR rate 85):
- No real orders sent
- Entry/exit fees simulated at 0.1%
- PnL in INR applied to mock balance
- Circuit breaker uses mock balance
- Order IDs prefixed with `MOCK_`

---

## CF WORKER IMPLEMENTATION

- **Cron:** Every 1 minute
- **OI Snapshots:** Stored in D1 `oi_snapshots` table, cleaned up after 2 hours
- **Institutional data:** 4 Binance Futures endpoints, all confirmed working
- **Trade execution:** CoinDCX API (same as before) or mock mode
- **Dashboard:** Shows real-time OI flow, trade log with OI delta per trade