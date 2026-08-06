# ETH Futures Bot — Cloudflare Workers Free Plan Edition (v1)

> **Deployment target:** A Cloudflare Worker running primarily from scheduled/Cron invocations on the Workers Free plan.
>
> **Design choice:** This is a **low-frequency, closed-candle micro-trading system**, not high-frequency trading. It intentionally trades less often and delegates protection to exchange-native orders.
>
> **Status:** Research / paper mode first. No profitability is assumed.

---

## 1. Hard platform reality

The full `strategy_v2.md` design assumes event-driven trades and order-book streams. That is not appropriate for a free Cloudflare Worker Cron bot.

Cloudflare’s published Workers limits list the Free plan at **10 ms CPU time per HTTP request and per Cron Trigger**, with **50 external subrequests per invocation**, **6 simultaneous outgoing connections**, **128 MB memory**, and a limited daily request allowance. These limits mean the Worker can make a few light API calls and simple indicator calculations, but should not perform continuous L2/order-flow processing, long loops, heavy backtests, or high-frequency WebSocket scalping. Verify the current plan limits before deployment.

### What this bot is suitable for

- One-symbol ETH futures monitoring once per minute;
- A few small REST/API requests per cycle;
- Small rolling indicator calculations on 30–60 completed candles;
- One open position at a time;
- Exchange-native stop loss and take profit protection;
- Simple, auditable strategy rules;
- Paper trading, signal logging, and conservative live validation.

### What it is not suitable for

- Tick-by-tick scalping;
- “whale following” from live order-book changes;
- CVD calculated from every executed trade;
- Cross-exchange latency arbitrage;
- Market making or queue-position strategies;
- Trailing stops that depend on instant Worker reactions;
- Repeated polling every few seconds;
- Managing unprotected passive orders that may fill between Cron runs.

**Important conclusion:** On this infrastructure, trade a 5–30 minute expected move using 1-minute data as confirmation. Do not try to capture a 5–20 second move.

---

## 2. Non-negotiable safety rules

```yaml
safety:
  only_one_symbol: B-ETH_USDT
  max_open_positions: 1
  no_averaging_down: true
  no_martingale: true
  no_pending_limit_entry_without_exchange_native_protection: true
  exchange_position_is_source_of_truth: true
  block_new_trade_on_data_or_api_error: true
  block_new_trade_if_existing_open_orders_unknown: true
  use_exchange_native_stop_loss: true
  use_exchange_native_take_profit: true
  use_smallest_live_size_until_validated: true
```

### The pending-pullback rule is unsafe on a minute Cron

The original system waits up to five minutes for a pullback limit fill. On a once-per-minute Worker, that order can fill moments after a Cron run and remain unprotected until the next run.

Therefore:

1. **Disable pending limit entries** unless the exchange can attach a valid stop loss and take profit at the same time the pending order is created; or
2. Use an immediately filled entry, then synchronously confirm the position and place native protective exits before the Worker returns; or
3. Do not trade.

A missed trade is safer than an unprotected futures position.

---

## 3. Free-plan-friendly architecture

```text
Cloudflare Cron: once per minute
       │
       ▼
Fetch only the minimum current data in parallel (max 4–5 calls)
       │
       ├── ETH completed 1m candles (30–60)
       ├── BTC completed 1m candles (10–20)
       ├── ETH ticker / best bid-ask / mark price
       └── CoinDCX account: position + open orders
       │
       ▼
Validate data freshness and exchange state
       │
       ▼
Calculate lightweight indicators on closed candles only
       │
       ├── 5m ETH/BTC momentum
       ├── RSI(14)
       ├── 1m ATR / realised volatility proxy
       ├── volume ratio
       ├── local 20–30m high/low position
       └── bid-ask spread filter
       │
       ▼
Regime classification: trend / range / no-trade
       │
       ▼
One simplified strategy decision
       │
       ▼
Risk and cost gate
       │
       ▼
Place one exchange-protected trade OR do nothing
       │
       ▼
Write compact log asynchronously; never rely on log write for safety
```

## 3.1 Per-cycle network budget

Keep the normal cycle within four parallel requests:

```text
1. ETH candles
2. BTC candles
3. ETH ticker or concise order-book snapshot
4. Authenticated position + open-order state
```

Only after a valid signal:

```text
5. Submit entry order
6. Confirm fill/position if needed
7. Submit/verify stop and take-profit if the venue requires separate calls
```

Never issue a large fan-out of requests. Stay well below the simultaneous outgoing connection limit. Use `Promise.all()` only for independent market/account reads; order placement and protective-exit confirmation must be carefully sequenced.

## 3.2 State storage

Use exchange account state as the authority:

```text
Truth for current position and active exits = CoinDCX position/open-order API
```

A Cloudflare KV/D1 record may store convenience state such as the last processed candle, strategy tag, and entry deadline. It must **not** be trusted as the sole source of position truth after Worker retries, deployment, delayed triggers, or errors.

Store only compact state:

```json
{
  "lastProcessedCandle": 0,
  "lastAction": "NO_TRADE",
  "tradeId": null,
  "strategy": null,
  "entryTimestamp": null,
  "timeExitAt": null,
  "dailyRiskState": {}
}
```

Use a `candleCloseTimestamp` as an idempotency key. The same candle must never be allowed to create two entries.

## 3.3 Secrets

- Put CoinDCX API credentials in Cloudflare **Secrets**, never in source code, logs, KV, screenshots, or browser-visible responses.
- Redact authorization headers, signatures, API keys, and account balances from error logs.
- Do not expose a public HTTP endpoint that can force an order without strong authentication and a separate emergency control policy.

---

## 4. Timing model

### 4.1 Use closed candles only

At each scheduled run:

```text
current_time = scheduled event time
last_closed_candle = candle whose end timestamp <= current_time
```

Never calculate RSI, wick, volume ratio, or momentum from the current still-forming candle. A candle that looks bullish at second 20 may close bearish at second 59.

### 4.2 Cron jitter protection

Cron is not an exchange matching engine. It may run after the nominal candle boundary.

```yaml
timing:
  trade_only_once_per_closed_candle: true
  max_acceptable_candle_age_seconds: "set after measuring actual Cron delay"
  stale_data_action: no_trade
  use_event_scheduled_time_for_deduplication: true
```

Log the difference between expected candle close time and actual Worker decision time. If the strategy only works at a near-zero delay, it is not suitable for this architecture.

---

# 5. Lightweight data model and indicators

## 5.1 Minimum candle data

Fetch enough **completed** 1-minute candles to calculate at least:

```text
ETH: 40–60 candles
BTC: 15–30 candles
```

Calculate with small fixed loops. Do not import a large technical-analysis library for a handful of values.

## 5.2 Features

```text
ETH_1m_return        = (eth_close[0] / eth_close[1]) - 1
ETH_5m_return        = (eth_close[0] / eth_close[5]) - 1
BTC_5m_return        = (btc_close[0] / btc_close[5]) - 1
RSI_14               = Wilder RSI on last 15+ closed ETH candles
ATR_14_1m            = simple/Wilder ATR on closed 1m candles
volume_ratio         = last completed ETH candle volume / average prior 20 volumes
range_high_20        = highest high over prior 20 completed candles
range_low_20         = lowest low over prior 20 completed candles
range_position       = (last_close - range_low_20) / (range_high_20 - range_low_20)
spread_bps           = (ask - bid) / mid × 10,000
```

### Optional snapshot-only filter

A single top-of-book or top-10 depth snapshot may be used only as a **liquidity filter**:

```text
Do not enter if spread is too wide.
Do not enter if intended size has excessive estimated book impact.
Do not treat a visible wall as a whale signal.
```

Do not compute CVD, cancellation rate, absorption, or whale identities from one snapshot per minute. That would create false precision.

---

# 6. Market regime classifier

Keep the first implementation simple and transparent.

```text
trend_strength = abs(ETH_5m_return) / max(ATR_14_1m, small_value)
BTC_alignment  = sign(ETH_5m_return) == sign(BTC_5m_return)
range_width    = range_high_20 - range_low_20
```

```yaml
regimes:
  TREND_UP:
    intent: "ETH and BTC upward; ETH movement large relative to recent 1m ATR"
  TREND_DOWN:
    intent: "ETH and BTC downward; ETH movement large relative to recent 1m ATR"
  RANGE:
    intent: "low trend strength; BTC near neutral; price remains inside recent range"
  NO_TRADE:
    intent: "stale data, wide spread, extreme volatility, unclear regime, API state error"
```

All numeric thresholds must be treated as research parameters. Do not choose values because they look good on one week of chart history.

---

# 7. Strategy A — Closed-candle trend continuation (default research strategy)

**Purpose:** This is the one strategy to test first. It is simpler and more compatible with a one-minute Cron than real-time whale/order-flow strategies.

## 7.1 Long candidate

A long may be considered only if all are true on closed data:

```text
1. no existing ETH position and no unresolved ETH orders;
2. data is fresh and spread is within the configured limit;
3. regime == TREND_UP;
4. ETH 5m return is positive and sufficiently large relative to ATR;
5. BTC 5m return is positive or non-opposing;
6. last ETH candle closes above its open;
7. ETH close is above a short reference level such as 5m/20m local midpoint or VWAP proxy;
8. RSI is positive but not at a historically tested exhaustion range;
9. last-candle volume ratio confirms participation, if and only if this improves test results;
10. estimated net target after actual fees and conservative slippage remains positive;
11. the trade has a valid exchange-native stop and target plan.
```

Short conditions are symmetric.

## 7.2 Entry choices to test, one at a time

```yaml
entry_variants:
  A_market:
    description: "Enter immediately after the closed-candle signal. Simplest and safest to protect."
  B_limit_at_bid_or_ask:
    description: "Only if exchange can attach native exits to a pending order, or if unfilled order is guaranteed not to create unprotected exposure."
  C_next_candle_confirmation:
    description: "Wait one additional closed candle for confirmation. Lower frequency and more latency, but may filter false signals."
```

For the initial Worker implementation, use **A_market only in paper mode**. Compare it with C before considering live usage. Do not run a five-minute pending pullback order without continuous fill monitoring.

## 7.3 Exit principles

```text
Stop: place beyond the local invalidation point, while including realistic spread/slippage.
Target: require a historical expected gross move that clears fees and projected execution cost.
Time exit: check once per minute; close only if still open after the defined expiry and no follow-through exists.
Emergency exit: use the exchange-native stop; Worker detection is a backup, not the first protection layer.
```

A single fixed `0.30% SL / 0.50% TP` is allowed only as a research baseline. Compare it with ATR/structure-based stops and targets.

---

# 8. Strategy B — Closed-candle range reclaim (secondary research strategy)

**Purpose:** Trade a failed push at a local range edge only when the broader market is not trending strongly.

Run this only after Strategy A has been separately evaluated. Do not run both live at the beginning.

## 8.1 Long candidate

```text
1. regime == RANGE;
2. BTC 5m move is neutral or not bearish;
3. ETH last completed candle touches/sweeps the recent 20m local low;
4. the same candle closes back inside the recent range and is green;
5. RSI is turning up from a low area; RSI is confirmation only, never the entire signal;
6. volume is not abnormally illiquid and the spread is acceptable;
7. a stop below the sweep has a target toward the range midpoint that clears total costs;
8. no current ETH/BTC trend-continuation signal conflicts with the reversal.
```

Short conditions are symmetric.

## 8.2 Explicit limitations

A long wick, RSI below 35, and a volume spike do **not** prove that a whale bought or that price must reverse. This strategy must earn its place through out-of-sample results.

---

# 9. What has been removed from the free Worker version

| Original/v2 capability | Free-Worker decision | Reason |
|---|---|---|
| Continuous WebSocket L2 processing | Remove | Not appropriate for a 10 ms Cron budget or once-per-minute schedule. |
| Tick CVD and aggressor imbalance | Remove | Requires continuous trade stream, not periodic candle fetches. |
| Whale detection from order-book behaviour | Remove | A minute snapshot cannot distinguish real liquidity from cancelled/spoofed walls. |
| Cross-exchange lead/lag scalping | Remove | Latency and scheduling jitter overwhelm the intended edge. |
| Market making | Remove | Needs fast, persistent order and inventory management. |
| Five simultaneous strategies | Remove | Correlated signals, more CPU/API calls, and unclear risk. |
| Five-minute pending pullback state | Disable by default | Can create an unprotected fill between Cron cycles. |
| Dynamic trailing stops | Avoid | Exchange-native trailing stop only if the venue supports it and it is tested; Worker-managed trailing is too slow. |
| 24h high/low hard block | Remove | It blocks valid breakouts and is not needed for a lightweight regime model. |
| Raw CVD thresholds and arbitrary score 50 | Remove | Not valid without calibrated real-time data and net-expectancy testing. |

---

# 10. Per-minute Worker algorithm

```text
scheduled(event, env, ctx):

  cycleId = determineLastClosedCandle(event.scheduledTime)

  if cycleId == persisted.lastProcessedCandle:
      return "already processed"

  [ethCandles, btcCandles, ethQuote, accountState] = await Promise.all([
      fetchEthClosedCandles(),
      fetchBtcClosedCandles(),
      fetchEthQuote(),
      fetchPositionAndOpenOrders()
  ])

  if invalidOrStale(ethCandles, btcCandles, ethQuote, accountState):
      persistCycle(cycleId, "NO_TRADE: DATA_OR_STATE_ERROR")
      return

  if accountState.hasPosition:
      verifyExchangeNativeProtection(accountState)
      manageTimeExitOnlyIfNeeded(accountState)
      persistCycle(cycleId, "POSITION_MANAGED")
      return

  if accountState.hasUnresolvedOpenOrder:
      cancelOrReconcileUsingExplicitRules(accountState)
      persistCycle(cycleId, "ORDER_RECONCILED")
      return

  features = computeSmallFixedWindowFeatures(ethCandles, btcCandles, ethQuote)
  regime = classifyRegime(features)
  signal = evaluateOneEnabledStrategy(features, regime)

  if signal == NO_TRADE or !passesCostAndRiskGate(signal):
      persistCycle(cycleId, reason)
      return

  entry = await submitEntryOrder(signal)
  position = await confirmActualPositionAndOrderState(entry)

  if position.isActive:
      exits = await createOrVerifyNativeStopAndTakeProfit(position, signal)
      if !exits.confirmed:
          executeEmergencyRiskPolicy(position)

  persistCycle(cycleId, finalState)
  ctx.waitUntil(writeCompactAuditLog(...))
```

### Critical implementation points

- Do not `return` before entry/position/protective-exit confirmation finishes.
- Do not use `waitUntil()` for critical order placement or stop placement. It is appropriate only for non-critical logging/analytics.
- If `createOrVerifyNativeStopAndTakeProfit` fails, stop new entries and follow a pre-defined emergency policy.
- Avoid loops over hundreds or thousands of candles. Use fixed arrays and simple arithmetic.
- Do not call an LLM, browser automation, large library, or complex optimiser inside the Worker.

---

# 11. Risk controls for this deployment

```yaml
risk:
  one_position_only: true
  no_trade_if_open_orders_exist: true
  no_trade_if_exchange_state_unavailable: true
  no_trade_if_stop_cannot_be_verified: true
  no_trade_if_spread_exceeds_threshold: true
  no_trade_if_quote_is_stale: true
  no_trade_if_daily_loss_limit_reached: true
  pause_after_consecutive_losses: true
  require_minimum_net_reward_to_risk_after_costs: true
  use_exchange_stop_not_worker_stop: true
  no_live_scale_up_without_paper_and_small-live_evidence: true
```

Position size must be calculated from worst-case account loss, not from “70% margin usage.” Include:

```text
worst case loss =
  notional × (planned stop distance + expected stop slippage + entry/exit fees + spread allowance)
```

Because a Worker can be late or unavailable, use more conservative stop-slippage assumptions than a desktop/manual backtest.

---

# 12. Validation plan for this exact architecture

## Phase A — Shadow mode

For every minute, calculate and log the signal without placing orders.

Record:

```text
closed candle timestamp
Worker decision timestamp and delay
strategy / regime / signal
hypothetical entry based on realistic bid/ask
future max favourable and adverse excursion
simulated stop/target outcome
estimated fees and slippage
whether an actual live order would have been protected in time
```

## Phase B — Paper execution

Simulate the exact Worker timing and actual bid/ask prices. Do not simulate fills at candle closes unless the bid/ask data supports them.

## Phase C — Small live validation

Enable only:

```text
one symbol
one strategy
one entry method
one active position
smallest sensible risk
exchange-native exits
full logs and kill switches
```

Compare live results with shadow and paper results. If actual slippage, missed fills, Cron delay, or fee impact invalidates the expected edge, stop and revise.

---

# 13. Performance scorecard

Review weekly and by strategy/regime:

```text
signal count
trade count
win rate
average gross winner and loser
average net winner and loser after actual costs
net expectancy in bps / trade
profit factor after all costs
maximum drawdown
maximum consecutive losses
Cron decision delay distribution
actual entry/exit slippage distribution
fee distribution (maker/taker)
missed or rejected order count
unprotected-position incidents (target: zero)
API/data failures and no-trade count
```

A strategy is not successful because it has high win rate. It must have positive **net expectancy** after actual fills and account for the Worker’s timing limitations.

---

# 14. Upgrade paths

## Stay on Free Worker

Best for:

- once-per-minute closed-candle strategy;
- one symbol;
- simple indicator-based confirmation;
- exchange-native exits;
- modest research and paper trading.

## Add a Durable Object (only after confirming current plan/billing)

Potentially useful for:

- stronger serialisation of order state;
- short-lived state coordination;
- managed WebSocket sessions;
- more reliable handling of one symbol/one account.

It is still **not** a substitute for a low-latency trading server near the venue. Keep position safety dependent on exchange-native stops.

## Move the execution engine to a VPS/container

Required before attempting:

- event-driven WebSockets;
- real CVD/order-flow calculations;
- L2 liquidity/refill features;
- continuous pending-order management;
- multi-symbol operation;
- tick-level backtesting and monitoring.

A sensible architecture is: VPS/execution process for market stream and orders; Cloudflare Worker only for dashboard, configuration, alerts, and lightweight control endpoints.

---

# 15. Initial deployment checklist

Before enabling even one live order, confirm:

- [ ] The actual contract pair, tick size, size step, fee tier, funding, and stop trigger type are documented.
- [ ] The Worker uses CoinDCX account position/open orders as the source of truth.
- [ ] The same candle cannot submit twice after retries or delayed Cron invocations.
- [ ] A pending entry cannot become an unprotected position.
- [ ] Stop loss and take profit are verified on the exchange after every fill.
- [ ] All API errors cause no new entry, never a retry storm.
- [ ] Actual bid/ask and fill fees are logged.
- [ ] A daily loss limit and manual kill switch exist.
- [ ] One position only is enforced.
- [ ] Shadow and paper results are positive after estimated costs.
- [ ] Small live test results match the model before any size increase.

---

## Final rule

> On a free Cloudflare Worker, simplicity is an edge.
>
> Trade fewer, slower, fully protected setups. Do not pretend a once-per-minute scheduled function can compete at tick-level order-flow or whale-following scalping.