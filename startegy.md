# OI FLOW RIDER v2.0 — Final Spec (Authoritative)

This document reflects the authoritative logic implemented in the strategy engine for the v2.0 "Institutional Flow" restoration.

---

## CORE PHILOSOPHY

Follow institutional money flow. Institutional accumulation/distribution is visible in Open Interest (OI) before Price Action. Detect accumulation (Phase 1) before the breakout starts. Enter at the transition (Phase 1→2). Exit proactively when distribution (Phase 3) begins.

**Assets:** BTC and ETH.
**Mock Capital:** ₹25,000 baseline.
**Risk Management:** 1% per trade of total balance. Max 15x leverage.

---

## D1 SCHEMA (5 Authoritative Tables)

```sql
CREATE TABLE IF NOT EXISTS oi_snapshots (
  timestamp INTEGER,
  symbol TEXT,
  open_interest REAL,
  price REAL
);

CREATE TABLE IF NOT EXISTS tick_logs (
  timestamp INTEGER,
  symbol TEXT,
  price REAL,
  open_interest REAL,
  oi_change_1m REAL,
  oi_change_5m REAL,
  oi_change_15m REAL,
  accumulation_score REAL,
  tick_oi_consistency REAL,
  tick_oi_acceleration REAL,
  tick_absorption REAL,
  tick_compression REAL,
  direction TEXT,  -- 'LONG', 'SHORT', or 'UNCLEAR'
  taker_ratio REAL,
  top_trader_delta REAL,
  retail_long_pct REAL,
  price_slope REAL,
  funding_rate REAL,
  atr_pct REAL,
  volume_ratio REAL,
  phase TEXT,
  minutes_accumulating INTEGER,
  cross_asset_status TEXT,
  trade_action TEXT,
  block_reason TEXT,
  would_exhaustion_block INTEGER,
  would_vol_regime_block INTEGER,
  would_oi_stagnation_block INTEGER,
  would_strict_cross_asset_block INTEGER,
  would_score_60_block INTEGER,
  would_duration_10_block INTEGER
);

CREATE TABLE IF NOT EXISTS signal_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER,
  symbol TEXT,
  direction TEXT,
  accumulation_score REAL,
  minutes_accumulating INTEGER,
  cross_asset_status TEXT,
  entry_price REAL,
  hypothetical_tp REAL,
  hypothetical_sl REAL,
  price_after_15m REAL,
  price_after_30m REAL,
  price_after_45m REAL,
  outcome TEXT,
  filters_that_would_have_blocked TEXT
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  symbol TEXT,
  direction TEXT,
  entry_price REAL,
  exit_price REAL,
  entry_time INTEGER,
  exit_time INTEGER,
  quantity REAL,
  leverage REAL,
  sl_price REAL,
  tp_price REAL,
  pnl_inr REAL,
  exit_reason TEXT,
  acc_score_at_entry REAL,
  acc_duration_at_entry INTEGER,
  oi_at_entry REAL,
  oi_at_exit REAL,
  cross_asset_status_at_entry TEXT,
  direction_signals_at_entry TEXT,
  partial_tp_hit INTEGER DEFAULT 0,
  hold_time_minutes REAL,
  status TEXT DEFAULT 'OPEN',
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY,
  trades_taken INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  total_pnl_inr REAL DEFAULT 0,
  peak_balance REAL DEFAULT 0,
  mock_balance REAL DEFAULT 0
);
```

---

## DATA SOURCES (12 Parallel Calls)

Fetched every 1 min for both BTCUSDT and ETHUSDT:

- **Open Interest:** `/fapi/v1/openInterest?symbol={symbol}` (Real-time snapshots).
- **Global L/S Ratio:** `/futures/data/globalLongShortAccountRatio?symbol={symbol}&period=5m&limit=3`
- **Top Trader L/S Ratio:** `/futures/data/topLongShortPositionRatio?symbol={symbol}&period=5m&limit=3`
- **Taker Buy/Sell Ratio:** `/futures/data/takerlongshortRatio?symbol={symbol}&period=5m&limit=3`
- **Funding Rate:** `/fapi/v1/premiumIndex?symbol={symbol}`
- **5m Klines (30):** For current ATR.
- **5m Klines (60):** For ATR 1hr ago (compression).
- **1m Klines (20):** For absorption, momentum, linear regression.
- **24h Ticker:** For kill switch extremes.

---

## SCORE SYSTEM — 4x25 WEIGHTED (PHASE 1)

| # | Component | Max Score | Logic / Requirement |
|---|-----------|-----------|--------------------|
| 1 | **OI Consistency** | 25 | ≥ 67% (10/15) of 1-min snapshots must show positive OI growth. |
| 2 | **OI Acceleration** | 25 | Recent ROC (last 8m) > Older ROC (prior 7m) + 1.2x surge. |
| 3 | **Absorption Ratio** | 25 | Continuous OI-based scoring. $score = min((relative - 1.0) \times 25, 25)$. |
| 4 | **Price Compression**| 25 | Current ATR (5m) < Older ATR (1hr ago) × 0.83. |

### Absorption Detail:
- **Flat Market (<0.05% move):** Score = 25 if Vol > 1.5x avg.
- **Normal Market:** Uses OI-based ratio $oi\_change\_15m / abs(price\_change\_15m)$ relative to baseline 1.0.

---

## DIRECTION DETECTION THRESHOLDS

Need 2 of 3 signals in same direction for confirmation:

| Signal | Long | Short |
|---|---|---|
| **Taker Bias** | Ratio ≥ 1.03 | Ratio ≤ 0.97 |
| **Price Drift** | Slope > +0.01%/candle | Slope < -0.01%/candle |
| **Top Trader Shift** | Delta ≥ +0.005 | Delta ≤ -0.005 |

---

## CROSS-ASSET GATE

- **CONFLICT**: BTC Long vs ETH Short (or vice-versa) with both scores ≥ 40. **Enforced Block.**
- **CONFIRMED**: Both assets meeting signals in same direction.
- **ONE_LEADING**: One asset score ≥ 55 while other is < 40.
- **BOTH_QUIET**: Neither asset meeting accumulation threshold (both below 40) → No action, keep monitoring.

---

## ENTRY CONDITION — 7-GATE REQUIREMENT

1.  **Global Position Gate**: No active position on EITHER asset.
2.  **Accumulation Level**: Score ≥ 55.
3.  **Accumulation Duration**: Sustained for ≥ 7 consecutive minutes.
4.  **Transition Trigger**: OI acceleration (2xROC) OR ATR breakout (1.3x expansion).
5.  **Direction Confirmation**: 2 of 3 components (Taker, Slope, Top Trader).
6.  **Anti-Trap Filter**: Global Long/Short Retail side < 70%.
7.  **Status Check**: Cross-Asset Gate is NOT in 'CONFLICT' mode.

### LOGGED-NOT-ENFORCED FILTERS (CALIBRATION)
Computed every tick, stored in tick_logs, do NOT block trades. Activated only after data proves their value.

1.  EXHAUSTION:        would block if taker_ratio > 1.25 or < 0.75
2.  VOL REGIME:        would block if ATR < 20th percentile of last 2 hours
3.  OI STAGNATION:     would block if abs(OI change 15min) < 0.3%
4.  STRICT CROSS-ASSET: would block if status != "CONFIRMED"
5.  HIGHER THRESHOLD:  would block if accumulation_score < 60
6.  LONGER DURATION:   would block if minutes_accumulating < 10

WEEK 3-4 PROMOTION:
  For each filter, count trades it would have blocked.
  >65% of blocked were losers → ACTIVATE
  40-60% split → LEAVE OFF
  >60% of blocked were winners → DELETE

---

## EXIT LOGIC — 9 DISTRIBUTION CHECKS

| # | Exit Type | Logic | Reason |
|---|-----------|-------|--------|
| 1 | **Hard Stop** | Price hits SL (1.5x ATR) | Risk Control |
| 2 | **Take Profit** | Price hits TP (2.5x SL) | Target Reached |
| 3 | **Cross-Asset Unwind** | Other asset OI drops ≥0.5% in 5 min | Dependency |
| 4 | **Global Risk-Off** | BTC & ETH BOTH OI drop ≥0.2% in **3 min** | Market dump |
| 5 | **OI Drop** | Local asset OI drops ≥0.3% in 3 min | Distribution |
| 6 | **OI Deceleration** | 3 consecutive min of declining ROC **WHILE IN PROFIT** | Exhaustion |
| 7 | **Volume/OI Diverge**| Volume > 1.5x avg with flat OI (<0.05% change) | Churn |
| 8 | **Absorption Flip** | Volume dropping 3+ min while price moving | Momentum Crash |
| 9 | **Time Stop** | 45 minutes limit | Liquidity risk |

---

## POSITION SIZING (Restored Math)

```
ATR = average true range of 5m klines (12 periods)
ATR_pct = ATR / current_price × 100

SL_distance = 1.5 × ATR_pct, clamped [0.3%, 1.2%]
TP_distance = 2.5 × SL_distance

risk_amount = mock_balance × 0.01
position_value = risk_amount / (SL_distance / 100)
leverage = min(position_value / mock_balance, 15)
quantity = position_value / entry_price

SL_price (long) = entry × (1 - SL_distance / 100)
SL_price (short) = entry × (1 + SL_distance / 100)
TP_price (long) = entry × (1 + TP_distance / 100)
TP_price (short) = entry × (1 - TP_distance / 100)
```

---

## MOCK TRADING MODE

- **Starting Balance:** ₹25,000 baseline.
- **USD/INR Rate:** 85.
- **Fees:** 0.1% entry + 0.1% exit (simulated).
- **Execution:** Order IDs `MOCK_{timestamp}_{symbol}`.
- **Balance Update:** Net PnL (after fees) applied in INR.

---

## POSITION MANAGEMENT

- **Partial TP**: At +1.5 ATR profit: close 50%, move SL to Entry + 0.8x ATR.
- **Cross-Asset BE**: If holding BTC and ETH drops >1% while BTC is flat (<0.1% move) → move BTC stop to Entry.

---

## KILL SWITCHES (KS1-KS6)

- **KS1**: Max 3 losses per day (Global).
- **KS2**: 20% Max Drawdown from peak balance.
- **KS3**: Cooldown (15m after loss, 30m after Gate Conflict).
- **KS4**: Max 8 trades per day.
- **KS5**: Price within 0.5% of 24h High/Low.
- **KS6**: Cross-Asset Gate in CONFLICT mode.

---

## DASHBOARD ENDPOINTS

- `GET /api/status`: Current scores, positions, balance.
- `GET /api/ticks`: Historical tick/signal data.
- `GET /api/trades`: Authoritative trade history.
- `GET /api/signals`: Signal mode hypotheticals.
- `GET /api/daily`: Historical performance stats.
- `GET /api/filters`: Calibration filter analysis.