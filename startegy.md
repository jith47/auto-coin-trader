## Core Principle

Trade DOGE as a derivative of BTC structure. BTC provides direction and timing signals via direct Binance API data (REST and Real-time WebSocket). DOGE provides entry confirmation through relative strength or weakness. You trade structure, not predictions. Never treat DOGE lagging BTC as a catch-up opportunity. Lag typically signals weakness, not pending movement.

## Data Sources

The strategy utilizes the following data points fetched directly from Binance:

For BTC: Current price, percentage change over 1 minute, 5 minutes, and 1 hour, daily percentage change, distance from 24-hour high as percentage, distance from 24-hour low as percentage, spot CVD direction (rising, falling, or flat), spot CVD slope (steep, gradual, or flat), price structure detected from 5-minute klines (sweep_reclaim_bullish, sweep_reclaim_bearish, rejection, support_holding, breakout, breakdown, or ranging), and key level proximity (at_resistance, at_support, or mid_range).

For DOGE: Current price, percentage change over 1 minute, 5 minutes, and 1 hour, daily percentage change, distance from 24-hour high, distance from 24-hour low, spot CVD direction, relative strength versus BTC (stronger, aligned, weaker, or decoupled), 24-hour price range as percentage (for volatility scaling), and volume ratio (recent 10-candle average vs 1-hour average).

For Sector: ETH daily percentage change, SOL daily percentage change, and overall sector bias (bullish, bearish, or mixed).

For Liquidations: Nearest liquidation cluster above current price, nearest liquidation cluster below, and recent liquidation events (longs_flushed, shorts_squeezed, or none).

## Structure Detection

Price structure is detected using BTC 5-minute klines (not 1-minute) because 1-minute candle patterns are too noisy for reliable structure detection. The last 3 five-minute candles are checked for patterns, with a 20-candle lookback window (1.7 hours) for swing reference. A structural pattern (rejection, support_holding) found on an earlier candle is still valid if subsequent candles have not contradicted it (e.g., a rejection is invalidated if the next candle closes above the rejection candle's high).

Sweep reclaim checks whether any of the last 3 candles swept a swing level and the current candle has reclaimed it.

Relative strength between DOGE and BTC uses a 0.5 percent threshold: differences below 0.5 percent are classified as 'aligned' (not enough conviction). Differences above 2 percent are 'decoupled' and trigger a kill switch.

## Valid Setup Types

Each setup uses **tiered gating**: a small number of essential conditions (hard gates) that must ALL be true, plus additional quality factors handled by the scoring system. This prevents the AND-gate problem where too many simultaneous conditions make signals impossibly rare.

Setup evaluation priority: Setup A first, then Setup B (SELL), then Setup B (BUY), then Setup C.

### Setup A — Liquidity Sweep and Reclaim (Highest Probability)

**Hard gates (must ALL be true):**

For a long entry: BTC structure shows sweep_reclaim_bullish OR (support_holding with BTC within 0.25 percent of 24h low), BTC spot CVD is rising, and DOGE is within 1.5 percent of its local low.

For a short entry: BTC structure shows sweep_reclaim_bearish OR (rejection with BTC within 0.25 percent of 24h high), BTC spot CVD is falling, and DOGE is within 1.5 percent of its local high.

**Scored boosters:** DOGE CVD alignment, sector bias, and liquidation events contribute to the signal score but do not block entry.

**60-second Reclaim Hold:** When Setup A is first detected, a 60-second hold timer starts. The setup must persist for 60 seconds before a trade is executed. This prevents trading on fleeting structural patterns.

### Setup B — Relative Weakness or Strength Divergence

**Hard gates (must ALL be true):**

For a relative weakness short (4 gates): BTC 1-hour change must be above zero percent, DOGE 1-hour change must be below negative 0.1 percent, DOGE relative strength shows weaker, and BTC structure must NOT be support_holding (shorting into a support bounce is a trap).

For a relative strength long (4 gates): BTC 1-hour change must be below zero percent, DOGE 1-hour change must be above positive 0.1 percent, DOGE relative strength shows stronger, and BTC structure must NOT be rejection (longing into a rejection is a trap).

**Scored boosters:** BTC structure (rejection OR at_resistance for shorts; support_holding OR at_support for longs), DOGE CVD alignment, and distance from extremes contribute to score.

### Setup C — Trend Continuation (Lowest Priority)

**Hard gates (must ALL be true):**

For a long entry (5 gates): BTC 1-hour change must exceed positive 1.0 percent, BTC spot CVD must be rising, BTC CVD slope must NOT be flat, DOGE relative strength must be stronger, and DOGE spot CVD must be rising.

For a short entry (5 gates): BTC 1-hour change must be below negative 1.0 percent, BTC spot CVD must be falling, BTC CVD slope must NOT be flat, DOGE relative strength must be weaker, and DOGE spot CVD must be falling.

**Scored boosters:** BTC CVD slope steepness, sector bias, and position in daily range contribute to score.

## Kill Switches

Never enter a trade if any of the following conditions are true. Kill switches are checked BEFORE setup evaluation for both directions. If both directions are blocked, no setup evaluation occurs.

1. **No long on correlation divergence:** If BTC 1-hour change is below negative 1.5 percent AND DOGE 1-hour change is above positive 0.3 percent, do not go long. BTC is crashing; DOGE bounce is likely fake.

2. **No long at 24-hour top:** If DOGE is within 0.5 percent of its 24-hour high, do not go long. This is buying exhaustion.

3. **No short at 24-hour bottom:** If DOGE is within 0.5 percent of its 24-hour low, do not go short. This is shorting the hole.

4. **No long with falling CVD:** If EITHER BTC spot CVD OR DOGE spot CVD is falling, do not go long. There is no buyer support. Note: this is an OR condition — even one falling CVD blocks longs.

5. **No long when overextended:** If DOGE daily change exceeds BTC daily change by more than 5 percent, do not go long. Mean reversion risk is elevated.

6. **No long when sector is bearish:** If sector bias is bearish, do not go long. Longs require at least mixed or bullish sector.

7. **No short when DOGE is exhausted:** If DOGE daily change is below negative 4 percent, do not go short. Selling momentum may be exhausted and a relief bounce is likely.

## Risk Management

### Position Sizing

Use 70 percent of available balance for margin. Leverage is fixed at 5x. Position size is calculated as: (margin × leverage) / entry price.

In mock mode, the initial balance is 2500 INR with a fixed USD/INR rate of 85.

### Stop Loss Placement

Base SL values: 0.9 percent for sweep and reclaim setups, 1.0 percent for relative weakness and relative strength setups, and 1.2 percent for trend continuation setups.

The base SL is scaled by a volatility multiplier derived from DOGE's 24-hour range: multiplier = clamp(dogeRange / 3.0, 0.8, 1.5). On a quiet day (range 1.5 percent), SL tightens to 80 percent of base. On a volatile day (range 8 percent), SL widens to 150 percent of base.

During NYSE open window (UTC 13:30 to 14:00), the SL is further widened by a factor of 1.15x to account for increased volatility.

Final SL is clamped between 0.8 percent and 1.5 percent regardless of calculations above.

### Take Profit Placement

All take profit levels are calculated as multiples of the SL distance (R:R-based), ensuring TP is always larger than SL.

For sweep and reclaim setups: Take 80 percent off at 1.5R and 20 percent at 2.5R.

For relative weakness and relative strength setups: Take 100 percent off at 1.5R as a quick scalp.

For trend continuation setups: Take 50 percent at 1.5R, 30 percent at 2.0R, and trail the remaining 20 percent with a 0.4 percent trailing distance.

### Break-Even Stop Loss

After any take-profit level is hit, stop loss moves to break-even (entry price) for the remaining position.

### Fees

Entry and exit fees are calculated at 0.1 percent of position value, deducted from the mock balance on each trade open and close.

## Signal Scoring

Calculate a score from 0 to 115 for each potential trade. Only execute trades with scores of 70 or higher.

1. **Structure confirmation (0-30 points):** 30 points for sweep_reclaim or extreme rejection/support_holding (within 0.25 percent of 24h high/low). 20 points for non-extreme rejection or support_holding. 15 points for breakout or breakdown. 0 for ranging.

2. **BTC CVD alignment (0-20 points):** 15 points if BTC spot CVD confirms direction (rising for longs, falling for shorts). Plus 5 bonus points if BTC CVD slope is steep.

3. **DOGE CVD alignment (0-12 points):** 12 points if DOGE spot CVD confirms trade direction.

4. **Relative strength alignment (0-15 points):** 15 points if DOGE relative strength matches direction (stronger/aligned for longs, weaker/aligned for shorts).

5. **Position in range (0-15 points):** 15 points if within 1 percent of favorable level (near low for longs, near high for shorts). 10 points if within 2 percent.

6. **Sector alignment (0-10 points):** 10 points if sector bias matches direction. 5 points if sector is mixed.

7. **Key level alignment (0-8 points):** 8 points if BTC is at a favorable key level (at_support for longs, at_resistance for shorts).

8. **Liquidation flush (0-5 points):** 5 points if recent liquidations cleared weak hands in the trade direction (longs_flushed for longs, shorts_squeezed for shorts).

9. **Volume penalty (-10 points):** If current 10-minute average volume is less than 50 percent of the 1-hour average volume, deduct 10 points. Thin markets produce unreliable patterns.

## Circuit Breakers and Cooldowns

**Max account drawdown:** If in mock mode and the account balance has dropped 30 percent or more from the initial balance (2500 INR), all trading halts. The strategy is assumed to be underperforming and needs review.

**Max daily drawdown:** If daily PnL drops below negative 2 percent of the initial balance (50 INR), trading stops for that day.

**Max trades per day:** Maximum 10 trades per day. After 10 trades, trading stops for that day.

**Loss cooldown:** After any losing trade, wait 30 minutes before the next trade. This prevents revenge trading.

**10-minute time stop:** If a trade has been open for more than 10 minutes and the price has moved less than 0.3 percent in the favorable direction, the trade is closed. This prevents capital being locked in stagnant positions.

## Trade Execution Process

The strategy runs 24/7 without session-based restrictions. The current UTC hour is logged for informational purposes only.

1. Fetch real-time market data from Binance and compute all indicators.
2. If an active trade exists, manage it (check SL, TP levels, trailing stops, time stop).
3. Check cooldowns (daily trade count, daily drawdown, loss cooldown timer).
4. Check max account drawdown circuit breaker.
5. Check all kill switches for both directions. If both blocked, abort.
6. Evaluate setups in priority order: Setup A → Setup B (SELL) → Setup B (BUY) → Setup C.
7. For Setup A, enforce 60-second reclaim hold before proceeding.
8. Verify kill switch doesn't block the matched setup's direction.
9. Calculate signal score. If below 70, abort.
10. Calculate position size based on account balance, leverage, and margin percentage.
11. Execute the trade with proper SL and TP levels.
12. Log all trade details including setup type, score, and market indicator data.
13. For mock trades, deduct entry fee from mock balance.

## Decision Framework Summary

Enter trades when a setup's hard gates are all satisfied, the signal score meets or exceeds 70, no kill switches are triggered, and all cooldown conditions are clear.

Avoid trades when DOGE is within 0.5 percent of a 24-hour extreme, when either BTC or DOGE CVD is falling (for longs), when DOGE-BTC correlation is diverging or decoupled, when sector is bearish and attempting a long, when daily drawdown limit is reached, when account drawdown exceeds 30 percent, when the signal score is below 70, or when shorting into a BTC support bounce.

Prioritize setups in this order: Sweep and Reclaim first as it provides the strongest edge, Relative Weakness Short second, Relative Strength Long third, Trend Continuation fourth. Never trade lag catch-up plays as they have negative expected value.

## Key Behavioral Rules

Be patient. Take only high-quality trades per day rather than many mediocre ones. Quality of setups matters more than quantity of trades.

Trust structure over prediction. Wait for BTC to confirm direction through price action before entering DOGE positions. Do not anticipate moves.

Respect the CVD. Spot CVD represents real money flow. If it contradicts your thesis, your thesis is wrong.

Treat lag as a warning. When DOGE fails to follow BTC, it signals weakness or distribution, not an opportunity to buy the dip.

Enforce cooldowns. After any loss, wait 30 minutes before the next trade. Revenge trading is the primary account killer.

Honor daily limits. Protect capital for better opportunities tomorrow.

## Configuration Reference

```
PAIR:                    B-DOGE_USDT
LEVERAGE:                5x
MARGIN_PERCENT:          70%
SCORE_THRESHOLD:         70

SL_BASE:
  SWEEP_RECLAIM:         0.9%
  RELATIVE_WEAKNESS:     1.0%
  RELATIVE_STRENGTH:     1.0%
  TREND_CONTINUATION:    1.2%
SL_MIN:                  0.8%
SL_MAX:                  1.5%

TP_PROFILES:
  SWEEP_RECLAIM:         80% at 1.5R, 20% at 2.5R
  RELATIVE_WEAKNESS:     100% at 1.5R
  RELATIVE_STRENGTH:     100% at 1.5R
  TREND_CONTINUATION:    50% at 1.5R, 30% at 2.0R, 20% trailing (0.4%)

KILL_SWITCHES:
  CORR_BTC_THRESHOLD:    1.5%
  CORR_DOGE_THRESHOLD:   0.3%
  SESSION_EXTREME:       0.5%
  OVEREXTEND_DIFF:       5.0%
  DAILY_EXHAUSTION:      -4.0%

SETUP_THRESHOLDS:
  SWEEP_DOGE_PROXIMITY:  1.5%
  TREND_BTC_1H_MIN:      1.0%
  RW_DOGE_1H_THRESHOLD:  -0.1%
  RS_DOGE_1H_THRESHOLD:  +0.1%

COOLDOWNS:
  AFTER_LOSS:            30 minutes
  MAX_TRADES_PER_DAY:    10
  MAX_LOSSES_DAILY:      5
  MAX_DAILY_DRAWDOWN:    2.0% of initial balance
  MAX_ACCOUNT_DRAWDOWN:  30%

NYSE_VOLATILITY:
  OPEN_UTC:              13:30
  CLOSE_UTC:             14:00
  STOP_WIDEN_FACTOR:     1.15x

MOCK_MODE:               true
INITIAL_INR_BALANCE:     2500
USD_INR_RATE:            85
```

## Known Limitations

Spot CVD is a secondary signal: DOGE trading is overwhelmingly futures-driven (perpetual volume is 5-10x spot). Spot CVD captures retail buy/sell imbalance and market maker activity, but misses leveraged positioning, funding rate pressure, and liquidation cascades. When spot CVD diverges from futures delta, futures wins. This limitation is not fixable from Cloudflare Workers without futures API access.

No historical backtesting: The strategy has not been validated against historical data. Mock trading provides forward validation but requires weeks to establish statistical significance. If historical 1-minute BTC/DOGE klines become available, the indicator and scoring logic could be backtested offline.

## IMPORTANT:
At the end of your analysis, you MUST provide a JSON block with the final trade decision.
The JSON block must be strictly formatted as follows:
```json
{
  "decision": "BUY" | "SELL" | "HOLD",
  "reason": "Short summary of why",
  "orderType": "MARKET" | "LIMIT",
  "quantity": 0.001,
  "leverage": 1,
  "entry": 0.128,
  "stopLoss": 0.127,
  "takeProfit": 0.129
}
```
If the decision is HOLD, quantity and leverage can be 0 or null.
If orderType is LIMIT, 'entry' is the limit price. If MARKET, 'entry' is current price (for reference).
Ensure 'stopLoss' and 'takeProfit' are always provided for BUY/SELL decisions.