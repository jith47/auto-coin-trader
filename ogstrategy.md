# Multi-Strategy Engine Specification

This document details the multi-strategy trading engine for `B-ETH_USDT` futures. The engine evaluates **5 independent strategies** concurrently on every 1-minute tick using real-time market data from Binance & CoinDCX.

---

## 1. System Architecture

```
Cron (1-min tick) → Fetch Market Data → Compute Indicators
  │
  ├── 1. Directional Alignment
  ├── 2. RSI Mean Reversion
  ├── 3. Volume Spike Momentum
  ├── 4. BTC-ETH Divergence
  └── 5. Wick Reversal
  │
  ▼
Strategy Runner (Pick highest score ≥ 50)
  │
  ▼
Range Filter Verification (Block resistance/support extremes)
  │
  ▼
Pending Pullback System (Wait 1-5m for 0.05% pullback fill)
  │
  ▼
Trade Execution (Mock / Real)
```

---

## 2. Market Data & Shared Indicators

All strategies share a single data fetch cycle per minute:

* **Primary Instrument:** `B-ETH_USDT` (CoinDCX Futures)
* **Reference Instrument:** `B-BTC_USDT` (Binance / CoinDCX Futures)
* **Calculated Indicators:**
  * **Price Change:** 1-minute, 5-minute, and 1-hour percentage price changes for ETH and BTC.
  * **Cumulative Volume Delta (CVD):** Rolling 30-candle taker buy vs taker sell volume delta (`takerBuyVolume - takerSellVolume`). Categorized by direction (`rising`, `falling`, `flat`) and slope steepness (`steep` ≥ 0.5, `gradual` ≥ 0.15).
  * **BTC Price Structure:** Classified from 5-minute klines into `breakout`, `breakdown`, `sweep_reclaim_bullish`, `sweep_reclaim_bearish`, `rejection` (upper wick >60% & red close), `support_holding` (lower wick >60% & green close), or `ranging`.
  * **Relative Strength (RS):** `ETH 1h % Change - BTC 1h % Change`. Classified into `stronger` (>+0.3%), `weaker` (<-0.3%), `aligned` (±0.15-0.3%), or `decoupled` (>2%).
  * **Range Position:** Proximity to 24-hour High (`distFromHigh`) and 24-hour Low (`distFromLow`).
  * **RSI (14-period):** Calculated over 1m klines with trend tracking (`rising`, `falling`, `flat`).

---

## 3. Strategy Specifications

### Strategy 1: Directional Alignment (`DIRECTIONAL_ALIGNMENT`)
* **Concept:** Follows dominant order flow where CVD delta, 5-minute price momentum, and BTC trend all align in the same direction.
* **BUY Entry Gate:**
  * `ETH CVD Direction = rising`
  * `ETH 5m Change > 0%`
  * `BTC 1h Change > -0.3%`
* **SELL Entry Gate:**
  * `ETH CVD Direction = falling`
  * `ETH 5m Change < 0%`
  * `BTC 1h Change < 0.3%`
* **Base Score:** 50
* **Score Boosters:**
  * BTC Structure = `sweep_reclaim_*` (+15) or `support_holding` / `rejection` (+10)
  * ETH CVD Slope = `steep` (+10) or `gradual` (+5)
  * Relative Strength = `stronger` for BUY (+10) / `weaker` for SELL (+10)

---

### Strategy 2: RSI Mean Reversion (`RSI_MEAN_REVERSION`)
* **Concept:** Catches momentum exhaustion bounces at oversold/overbought extremes in stabilizing or sideways markets.
* **BUY Entry Gate:**
  * 14-period `RSI < 35`
  * `RSI Trend = rising` (turning up from low)
* **SELL Entry Gate:**
  * 14-period `RSI > 65`
  * `RSI Trend = falling` (turning down from high)
* **Base Score:** 55
* **Score Boosters:**
  * BTC Stability: `BTC 1h Change > -0.2%` for BUY (+10) / `BTC 1h Change < 0.2%` for SELL (+10)
  * Relative Strength: ETH not weaker for BUY (+5) / ETH not stronger for SELL (+5)
  * Extreme RSI Depth: `RSI < 25` for BUY (+5) / `RSI > 75` for SELL (+5)

---

### Strategy 3: Volume Spike Momentum (`VOLUME_SPIKE`)
* **Concept:** Detects institutional/whale volume bursts and scalps in the direction of the high-volume expansion.
* **Entry Gate:**
  * Last 2 candles average volume `≥ 1.5x` 30-candle lookback average volume.
  * 100% directional consistency: Both candles green (`close > open`) for BUY, or both candles red (`close < open`) for SELL.
* **Base Score:** 55
* **Score Boosters:**
  * CVD Confirmation: `ETH CVD` matches spike direction (+10)
  * BTC Non-Opposing: `BTC 5m Change > -0.1%` for BUY (+5) / `BTC 5m Change < 0.1%` for SELL (+5)
  * High Volume Ratio: `Volume Ratio > 3.0x` (+5)

---

### Strategy 4: BTC-ETH Divergence (`BTC_ETH_DIVERGENCE`)
* **Concept:** Cross-pair lag catch-up trade. When BTC moves abruptly, ETH frequently lags by 1-5 minutes before catching up in the same direction.
* **Entry Gate:**
  * `|BTC 5m Change| > 0.15%` AND `|ETH 5m Change| < 0.08%`
  * Direction: BUY if BTC moved UP; SELL if BTC moved DOWN.
* **Base Score:** 55
* **Score Boosters:**
  * BTC CVD Confirmation: `BTC CVD` matches move direction (+10)
  * Divergence Gap: `|BTC Move| - |ETH Move| > 0.5%` (+5)
  * Relative Strength Confirmation: Lag confirmed by RS (+5)

---

### Strategy 5: Wick Reversal (`WICK_REVERSAL`)
* **Concept:** Trades rejected price levels marked by heavy candle wicks with volume confirmation.
* **BUY Entry Gate:**
  * Lower wick `> 50%` of candle range (`high - low`).
  * Green close (`close > open`).
  * Candle volume `≥ 1.2x` 30-candle average volume.
* **SELL Entry Gate:**
  * Upper wick `> 50%` of candle range (`high - low`).
  * Red close (`close < open`).
  * Candle volume `≥ 1.2x` 30-candle average volume.
* **Base Score:** 55
* **Score Boosters:**
  * Structure Support: `BTC Structure` matches reversal (+10)
  * CVD Confirmation: `ETH CVD` matches reversal direction (+5)
  * Deep Wick: Wick ratio `> 75%` (+5)

---

## 4. Multi-Strategy Runner & Execution Filters

1. **Strategy Selection:**
   * All 5 strategies evaluate in parallel every minute.
   * Signals with score `< MIN_ACC_SCORE` (50) are discarded.
   * The candidate with the **highest score** is selected for execution.

2. **Range Filter (`applyRangeFilter`):**
   * **BUY Resistance Guard:** Blocks BUY if ETH price is within `1.5%` of its 24-hour High.
   * **SELL Support Guard:** Blocks SELL if ETH price is within `1.5%` of its 24-hour Low.
   * **CVD Divergence Guard:** Blocks shorting on rejection structure if BTC CVD is rising, and blocks longing on support holding structure if BTC CVD is falling.

3. **Pending Pullback Execution System:**
   * Signals enter a `PENDING` state for up to 5 minutes instead of executing market orders immediately.
   * Execution triggers when price pulls back at least `0.05%` toward entry (providing a safer fill price).
   * If price runs away without pulling back within 5 minutes, the pending signal expires safely.

---

## 5. Risk Management & Control Settings

* **Margin Usage:** 70% of balance (Leverage: 2x)
* **Stop Loss (SL):** 0.3% from entry
* **Take Profit (TP):** 0.5% from entry
* **Time Stop:** 10 minutes (closes trade if price move < 0.05%)
* **Parallel Mock Trades Mode:** Supports up to 5 concurrent mock trades for multi-strategy evaluation.