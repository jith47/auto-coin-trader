We need the delta data of BTC and DOGE to implement this strategy in the following timeframes:
BTC: 1m, 3m
DOGE: 1m, 5m

1. UPGRADED CORRELATION + LAG ENGINE v4.0 (This is the nuclear edge now)

DOGE Lag Score (last 4 minutes only) = BTC % move ÷ DOGE % move

LONG  → Lag Score ≥ 2.65
SHORT → Lag Score ≤ 0.37

Correlation Coefficient (60-period on 1m) must do this exact move in last 9 candles:
Dipped to ≤ 0.865 → then spiked hard to ≥ 0.938 in ≤ 9 candles
→ This micro-reversion is the single highest-probability signal in all of crypto right now

2. MULTI-TIMEFRAME MATRIX v4.0 (Stripped to absolute bone)
TF	Rule (ALL mandatory)	Weight
1H	BTC close > 21 EMA (long) / < 21 EMA (short)	40%
1M	Liquidity sweep + FVG created + Delta explosion	60%

→ 1D, 4H, 15m, 5m all permanently deleted. They only add noise.
3. PRECISE ENTRY TRIGGERS v4.0 – Non-Negotiable (all in same 60–120 sec window)
LONG – The Perfect Storm (happens 1–3 times per week, wins 91% when it does)

□ BTC 1H close > 21 EMA
□ BTC 1m: Sweeps low by ≥14 pips → reclaim with ≥3.4x volume 20-MA
□ BTC Delta last 3 candles ≥ +580K (massive green bar visible)
□ DOGE Lag Score ≥ 2.65 (DOGE still sleeping hard)
□ Correlation just spiked from ≤0.865 → ≥0.938 in last 9 candles
□ DOGE has NOT yet made a 1m candle ≥0.28% (must be dead flat)
□ Funding rate ≤ +0.038% (not overcrowded)
→ ENTER MARKET on the FIRST strong DOGE 1m green candle that closes ≥0.31%

SHORT – Mirror Image (equally lethal)

□ BTC 1H close < 21 EMA
□ BTC 1m: Sweeps high → rejection with ≥3.4x volume
□ BTC Delta last 3 candles ≤ -580K
□ DOGE Lag Score ≤ 0.37
□ Correlation spiked from ≤0.865 → ≥0.938 in last 9 candles
□ DOGE price ≥ 0.26% above daily/session low
□ Funding rate ≥ -0.008% (not extreme short squeeze imminent)
→ ENTER MARKET on first strong DOGE 1m red candle ≥0.31%

4. EXIT STRATEGY v4.0 – The Reaper 2.0 (maximum greed with zero mercy)

TP1 → +0.44% → close 78% position
TP2 → +1.18% → close remaining 22% (let it run, these go to +2–4% very often)

Instant Full Exit Triggers:
├ DOGE catches up ≥ 79% of BTC's move since entry
├ BTC breaks the FVG low/high against you
├ BTC Delta flips ≥ 720K against position
├ Holding time = 9 minutes 30 seconds → full exit at market if not at TP1

Break-even → move SL to entry + fees at +0.26%
Hard SL → -0.29% (tightened again)

5. FINAL LOCKED RISK RULES (no exceptions ever)
No trade if DOGE 1-minute ATR (14) < 0.00075 (market dead = no edge)


IMPORTANT:
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
```